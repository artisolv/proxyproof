import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const nowIso = () => new Date().toISOString();
export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`;
export const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** RFC 8785-style canonical JSON for our value types: sorted keys, no floats allowed. */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('canonical values must be safe integers');
    return String(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
  }
  throw new Error(`cannot canonicalize ${typeof value}`);
}

export const formatMinor = (minor: number, currency = 'USD') =>
  `${currency} ${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Decimal string for a provider API, built from integers. */
export function minorToDecimal(minor: number): string {
  const abs = Math.abs(minor);
  return `${minor < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
