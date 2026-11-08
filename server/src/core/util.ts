import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const nowIso = () => new Date().toISOString();
export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`;
export const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export const hmac = (key: string, data: string) => createHmac('sha256', key).update(data).digest('hex');
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

/** Parses a printed amount into integer minor units without floating point. Returns null when ambiguous. */
export function parseMoneyToMinor(raw: string): number | null {
  const m = raw.replace(/[^\d.,-]/g, '').match(/^-?\d[\d.,]*$/);
  if (!m) return null;
  let s = m[0];
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  let decimalAt = -1;
  if (lastDot >= 0 && lastComma >= 0) decimalAt = Math.max(lastDot, lastComma);
  else if (lastDot >= 0) {
    const dots = s.match(/\./g)!.length;
    if (dots > 1) decimalAt = -1; // 1.234.567
    else if (s.length - lastDot - 1 === 3) return null; // 12.345 is ambiguous
    else decimalAt = lastDot;
  }
  else if (lastComma >= 0) decimalAt = s.length - lastComma - 1 <= 2 ? lastComma : -1;
  const intPart = (decimalAt >= 0 ? s.slice(0, decimalAt) : s).replace(/[.,]/g, '');
  const frac = decimalAt >= 0 ? s.slice(decimalAt + 1) : '';
  if (frac.length > 2 || !/^-?\d+$/.test(intPart)) return null;
  const minor = BigInt(intPart) * 100n + BigInt(frac.padEnd(2, '0') || '0') * (intPart.startsWith('-') ? -1n : 1n);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < -BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(minor);
}
export const formatMinor = (minor: number, currency = 'USD') =>
  `${currency} ${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Decimal string for a provider API, built from integers. */
export function minorToDecimal(minor: number): string {
  const abs = Math.abs(minor);
  return `${minor < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export const normalizeName = (name: string) =>
  name.toLowerCase().replace(/\b(llc|inc|ltd|limited|corp|corporation|co|gmbh|plc|pvt|private|company|the)\b\.?/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
export const normalizeInvoiceNumber = (n: string) => n.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(INVOICE|INV)(?=\d)/, 'INV');
export const destinationFingerprint = (type: string, value: string) => sha256(`${type}:${normalizeDestination(type, value)}`);
export function normalizeDestination(type: string, value: string): string {
  if (type === 'PAYPAL_EMAIL') return value.trim().toLowerCase();
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
