import { isUtf8 } from 'node:buffer';
import yauzl from 'yauzl';

export class ZipSlipError extends Error {
  constructor(message: string) { super(message); this.name = 'ZipSlipError'; }
}
export class ZipLimitError extends Error {
  constructor(message: string) { super(message); this.name = 'ZipLimitError'; }
}
export class CaseCollisionError extends Error {
  constructor(message: string) { super(message); this.name = 'CaseCollisionError'; }
}

export type ZipLimits = {
  maxEntries: number;
  maxTotalBytes: number;
  maxEntryBytes: number;
  maxRatio: number;
  maxDepth: number;
  // 'allow' is for jars: obfuscated mods ship `a.class` and `A.class`, which only collide when extracted on Windows.
  caseCollision: 'error' | 'allow';
};

const DEFAULT_LIMITS: ZipLimits = {
  maxEntries: 20000,
  maxTotalBytes: 8 * 1024 ** 3,
  maxEntryBytes: 512 * 1024 ** 2,
  maxRatio: 200,
  maxDepth: 3,
  caseCollision: 'error',
};

/**
 * Limits for archives that are only READ in memory and never extracted (server-pack zips, the jars inside them):
 * case-colliding names and big asset counts are harmless there, and every reader (import, update pack, loader
 * detection, config scan) must accept what the others accept. Extraction-grade defaults stay for real extraction.
 */
export const READ_ONLY_ZIP_LIMITS: Partial<ZipLimits> = { caseCollision: 'allow', maxEntries: 500000, maxRatio: 1000 };

// CP437 upper half (0x80-0xFF): the legacy zip name encoding when general purpose bit 11 is not set.
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

/** Entry name: UTF-8 when flagged or valid UTF-8 (nothing that works today changes), else CP437 so legacy names stay distinct. */
export function decodeEntryName(raw: Buffer, flags: number): string {
  if ((flags & 0x800) !== 0 || isUtf8(raw)) return raw.toString('utf8');
  let out = '';
  for (const b of raw) out += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80]!;
  return out;
}

// The ratio check only applies above this size: small text files can legitimately compress very well.
const RATIO_CHECK_MIN_BYTES = 1024 * 1024;

export interface ZipHandle {
  entries(): { name: string; size: number }[];
  read(name: string): Promise<Buffer>;
  nested(name: string): Promise<ZipHandle>;
  close(): Promise<void>;
}

export function openZip(source: string | Buffer, limits: Partial<ZipLimits> = {}): Promise<ZipHandle> {
  return openAtDepth(source, { ...DEFAULT_LIMITS, ...limits }, 0);
}

function validateName(name: string): void {
  const normalized = name.replace(/\\/g, '/');
  if (/^\//.test(normalized) || /^[a-zA-Z]:/.test(normalized)) throw new ZipSlipError(`absolute entry name: ${name}`);
  if (normalized.split('/').includes('..')) throw new ZipSlipError(`parent traversal in entry name: ${name}`);
}

async function openAtDepth(source: string | Buffer, limits: ZipLimits, depth: number): Promise<ZipHandle> {
  // decodeStrings:false makes yauzl hand over raw names so that we validate them ourselves and raise our own errors.
  const opts = { lazyEntries: true, decodeStrings: false, validateEntrySizes: true, autoClose: false } as const;
  const zipfile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    const cb = (err: Error | null, z?: yauzl.ZipFile) => (err || !z ? reject(err ?? new Error('cannot open zip')) : resolve(z));
    if (typeof source === 'string') yauzl.open(source, opts, cb);
    else yauzl.fromBuffer(source, opts, cb);
  });

  const byName = new Map<string, yauzl.Entry>();
  const lowered = new Set<string>();
  let total = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      zipfile.on('error', reject);
      zipfile.on('end', resolve);
      zipfile.on('entry', (e: yauzl.Entry) => {
        try {
          const name = decodeEntryName(e.fileName as unknown as Buffer, e.generalPurposeBitFlag);
          validateName(name);
          if (byName.size + 1 > limits.maxEntries) throw new ZipLimitError(`more than ${limits.maxEntries} entries`);
          total += e.uncompressedSize;
          if (total > limits.maxTotalBytes) throw new ZipLimitError(`uncompressed size above ${limits.maxTotalBytes} bytes`);
          const key = name.toLowerCase();
          if (lowered.has(key) && limits.caseCollision === 'error') throw new CaseCollisionError(`entries differ only by case: ${name}`);
          lowered.add(key);
          byName.set(name, e);
          zipfile.readEntry();
        } catch (err) {
          reject(err);
        }
      });
      zipfile.readEntry();
    });
  } catch (err) {
    zipfile.close();
    throw err;
  }

  const read = (name: string): Promise<Buffer> => {
    const e = byName.get(name);
    if (!e) return Promise.reject(new Error(`entry not found: ${name}`));
    if (e.uncompressedSize > limits.maxEntryBytes) {
      return Promise.reject(new ZipLimitError(`entry ${name} above ${limits.maxEntryBytes} bytes`));
    }
    if (e.uncompressedSize > RATIO_CHECK_MIN_BYTES && e.uncompressedSize / Math.max(e.compressedSize, 1) > limits.maxRatio) {
      return Promise.reject(new ZipLimitError(`entry ${name} compression ratio above ${limits.maxRatio}`));
    }
    return new Promise((resolve, reject) => {
      zipfile.openReadStream(e, (err, stream) => {
        if (err || !stream) return reject(err ?? new Error('cannot read entry'));
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks)));
      });
    });
  };

  return {
    entries: () => [...byName.entries()].filter(([n]) => !n.endsWith('/')).map(([name, e]) => ({ name, size: e.uncompressedSize })),
    read,
    async nested(name: string) {
      if (depth + 1 > limits.maxDepth) throw new ZipLimitError(`zip nesting deeper than ${limits.maxDepth}`);
      return openAtDepth(await read(name), limits, depth + 1);
    },
    async close() {
      zipfile.close();
    },
  };
}
