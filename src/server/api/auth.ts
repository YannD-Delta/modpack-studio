import crypto from 'node:crypto';

/**
 * Current scrypt cost (OWASP-listed trade: N=2^15, r=8, p=3, 32 MiB). It is written into every hash string,
 * so raising it later never breaks an older hash; an older hash is upgraded after the next successful login.
 */
export const PASSWORD_COST = { N: 2 ** 15, r: 8, p: 3 } as const;
const KEYLEN = 32;
/** Memory ceiling given to scrypt: above Node's 32 MiB default, which N=2^15, r=8 needs and N=2^17, r=8 (128 MiB) exceeds. */
const MAXMEM = 256 * 1024 * 1024;
/** Bounds accepted from a stored hash string; anything outside is treated as a malformed hash. */
const MAX_N = 2 ** 17;
const MAX_R = 16;
const MAX_P = 16;

export type ScryptCost = { N: number; r: number; p: number };

export function hashPassword(password: string, cost: ScryptCost = PASSWORD_COST): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, KEYLEN, { ...cost, maxmem: MAXMEM });
  return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

const intIn = (text: string | undefined, min: number, max: number): number | null => {
  if (!text || !/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
};

/** Parses a stored hash, or null when it is not a well-formed scrypt string with a 32-byte key. */
function parseHash(stored: string): { cost: ScryptCost; salt: Buffer; key: Buffer } | null {
  const [scheme, n, r, p, salt, hash, ...rest] = stored.split('$');
  if (scheme !== 'scrypt' || rest.length > 0) return null;
  const N = intIn(n, 2, MAX_N);
  const R = intIn(r, 1, MAX_R);
  const P = intIn(p, 1, MAX_P);
  if (N === null || R === null || P === null || (N & (N - 1)) !== 0) return null;
  const saltBytes = Buffer.from(salt ?? '', 'base64');
  const key = Buffer.from(hash ?? '', 'base64');
  if (saltBytes.length < 8 || key.length !== KEYLEN) return null;
  return { cost: { N, r: R, p: P }, salt: saltBytes, key };
}

/** Never throws and never accepts on a malformed stored string. */
export function verifyPassword(password: string, stored: string): boolean {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  try {
    const actual = crypto.scryptSync(password, parsed.salt, KEYLEN, { ...parsed.cost, maxmem: MAXMEM });
    return crypto.timingSafeEqual(actual, parsed.key);
  } catch {
    return false;
  }
}

/** True when a valid hash was made with a lower cost than the current one. */
export function needsRehash(stored: string): boolean {
  const parsed = parseHash(stored);
  return !!parsed && (parsed.cost.N < PASSWORD_COST.N || parsed.cost.r < PASSWORD_COST.r || parsed.cost.p < PASSWORD_COST.p);
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** In-memory sessions: a restart logs everyone out, which is fine for a single-user LAN tool. */
export class SessionStore {
  private readonly sessions = new Map<string, number>();

  create(): string {
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.set(token, Date.now() + SESSION_TTL_MS);
    return token;
  }

  isValid(token: string | undefined): boolean {
    if (!token) return false;
    const expires = this.sessions.get(token);
    if (!expires) return false;
    if (expires < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  destroy(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }
}
