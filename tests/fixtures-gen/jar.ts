import { buildZip, type RawZipEntry } from './zip.js';

export type JarSpec = {
  fileName: string;
  loader: 'neoforge' | 'forge' | 'fabric';
  mods: { modId: string; version: string; dependencySide?: 'CLIENT' | 'SERVER' | 'BOTH' }[];
  nested?: JarSpec[];
  library?: boolean;
  placeholderVersion?: boolean;
  manifestVersion?: string;
};

function tomlFor(spec: JarSpec): string {
  const lines = ['modLoader="javafml"', 'loaderVersion="[4,)"', 'license="MIT"', ''];
  for (const m of spec.mods) {
    lines.push('[[mods]]');
    lines.push(`modId = "${m.modId}"`);
    lines.push(`version = "${spec.placeholderVersion ? '${file.jarVersion}' : m.version}"`);
    lines.push('');
    if (m.dependencySide) {
      lines.push(`[[dependencies.${m.modId}]]`);
      lines.push('modId = "minecraft"');
      lines.push('type = "required"');
      lines.push('versionRange = "[1.21,)"');
      lines.push(`side = "${m.dependencySide}"`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

export async function makeJar(spec: JarSpec): Promise<Buffer> {
  const entries: RawZipEntry[] = [];
  const text = (name: string, data: string) => entries.push({ name, data: Buffer.from(data), method: 'deflate' });

  const manifest = ['Manifest-Version: 1.0'];
  if (spec.manifestVersion) manifest.push(`Implementation-Version: ${spec.manifestVersion}`);
  if (spec.library) manifest.push(`Automatic-Module-Name: ${spec.fileName.replace(/[-\d.]+\.jar$/, '').replace(/[^A-Za-z0-9.]/g, '.')}`);
  text('META-INF/MANIFEST.MF', manifest.join('\r\n') + '\r\n');

  if (!spec.library) {
    if (spec.loader === 'neoforge') text('META-INF/neoforge.mods.toml', tomlFor(spec));
    else if (spec.loader === 'forge') text('META-INF/mods.toml', tomlFor(spec));
    else {
      const m = spec.mods[0]!;
      const side = m.dependencySide === 'CLIENT' ? 'client' : m.dependencySide === 'SERVER' ? 'server' : '*';
      text('fabric.mod.json', JSON.stringify({ schemaVersion: 1, id: m.modId, version: m.version, environment: side }));
    }
  }

  if (spec.nested?.length) {
    const jars = [];
    for (const n of spec.nested) {
      const path = `META-INF/jarjar/${n.fileName}`;
      entries.push({ name: path, data: await makeJar(n), method: 'store' });
      jars.push({ identifier: { group: 'fixture', artifact: n.fileName }, version: { range: '[1,)', artifactVersion: n.mods[0]?.version ?? '0' }, path });
    }
    text('META-INF/jarjar/metadata.json', JSON.stringify({ jars }));
  }
  return buildZip(entries);
}

export async function makeZip(
  entries: Record<string, Buffer | string>,
  opts: { wrapperDir?: string } = {},
): Promise<Buffer> {
  const prefix = opts.wrapperDir ? opts.wrapperDir.replace(/\/?$/, '/') : '';
  return buildZip(
    Object.entries(entries).map(([name, data]) => ({
      name: prefix + name,
      data: Buffer.isBuffer(data) ? data : Buffer.from(data),
      method: 'deflate' as const,
    })),
  );
}
