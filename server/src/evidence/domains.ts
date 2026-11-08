const CONFUSABLES: Record<string, string> = { '0': 'o', '1': 'l', '3': 'e', '5': 's', '7': 't', 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'і': 'i', 'ѕ': 's', 'ı': 'i', 'ɩ': 'l' };
export const skeleton = (s: string) => s.normalize('NFKC').toLowerCase().replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/./gu, (c) => CONFUSABLES[c] ?? c).replace(/i/g, 'l').replace(/[-_.]/g, '');

export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
export const domainOf = (email: string | null) => email?.split('@')[1]?.toLowerCase() ?? null;
export const isSameOrSubdomain = (domain: string, trusted: string) => domain === trusted || domain.endsWith(`.${trusted}`);
const registrable = (d: string) => d.split('.').slice(-2).join('.');

/** True when a domain imitates a trusted one without being it. */
export function isLookalike(domain: string, trusted: string): boolean {
  if (isSameOrSubdomain(domain, trusted)) return false;
  const a = registrable(domain).split('.')[0], b = trusted.split('.').slice(-2)[0];
  if (skeleton(a) === skeleton(b)) return true;
  if (b.length >= 5 && editDistance(a, b) <= 2) return true;
  if (b.length >= 5 && domain.split('.').some((label) => label === b)) return true; // northwind.evil.example
  return /^xn--/.test(a);
}
/** Similarity for vendor names: same skeleton or a small edit distance, but not the same normalized name. */
export function nameResembles(a: string, b: string): boolean {
  if (a === b || b.length < 6) return false;
  const x = skeleton(a), y = skeleton(b);
  return x === y || editDistance(x, y) <= 2;
}
