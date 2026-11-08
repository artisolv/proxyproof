import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { scanSignals } from '../ingest/parse.js';

export type PublicResult = {
  domain: string; reservedTestDomain: boolean; available: boolean; errors: string[];
  hasMx: boolean | null; hasDmarc: boolean | null; registeredAt: string | null; ageDays: number | null;
  homepage: { fetched: boolean; title: string | null; injection: string[] } | null;
};
export type PublicEvidenceProvider = (domain: string) => Promise<PublicResult>;

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 6) { const l = ip.toLowerCase(); return l === '::1' || l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('::ffff:') ; }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
const timeout = <T,>(p: Promise<T>, ms = 3500) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

/** Fetches a vendor homepage as untrusted text. Public HTTPS hosts only, no redirects, size capped. */
async function fetchHomepage(domain: string): Promise<{ fetched: boolean; title: string | null; injection: string[] }> {
  const addrs = await timeout(dns.lookup(domain, { all: true }));
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) return { fetched: false, title: null, injection: [] };
  const res = await fetch(`https://${domain}/`, { redirect: 'manual', signal: AbortSignal.timeout(4000), headers: { 'user-agent': 'PayeeProof-Evidence/1.0' } });
  if (!res.ok || !res.body) return { fetched: false, title: null, injection: [] };
  const reader = res.body.getReader();
  let html = '', size = 0;
  while (size < 256 * 1024) { const { done, value } = await reader.read(); if (done) break; size += value.length; html += Buffer.from(value).toString('utf8'); }
  await reader.cancel().catch(() => {});
  const title = html.match(/<title[^>]*>([^<]{1,160})/i)?.[1]?.trim() ?? null;
  return { fetched: true, title, injection: scanSignals(html.replace(/<[^>]+>/g, '\n')).injection };
}

export const livePublicEvidence: PublicEvidenceProvider = async (domain) => {
  const reserved = /(^|\.)(example|test|invalid|localhost)$|(^|\.)example\.(com|org|net)$/i.test(domain);
  const out: PublicResult = { domain, reservedTestDomain: reserved, available: true, errors: [], hasMx: null, hasDmarc: null, registeredAt: null, ageDays: null, homepage: null };
  if (reserved || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return out;
  await Promise.all([
    timeout(dns.resolveMx(domain)).then((r) => { out.hasMx = r.length > 0; }).catch((e) => { if (['ENODATA', 'ENOTFOUND'].includes(e.code)) out.hasMx = false; else out.errors.push('MX lookup failed'); }),
    timeout(dns.resolveTxt(`_dmarc.${domain}`)).then((r) => { out.hasDmarc = r.some((t) => t.join('').toLowerCase().startsWith('v=dmarc1')); }).catch((e) => { if (['ENODATA', 'ENOTFOUND'].includes(e.code)) out.hasDmarc = false; else out.errors.push('DMARC lookup failed'); }),
    fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { signal: AbortSignal.timeout(4000), headers: { accept: 'application/rdap+json' } }).then(async (r) => {
      if (!r.ok) { out.errors.push(`RDAP returned ${r.status}`); return; }
      const j: any = await r.json();
      const at = j.events?.find((e: any) => e.eventAction === 'registration')?.eventDate;
      if (at) { out.registeredAt = at; out.ageDays = Math.floor((Date.now() - Date.parse(at)) / 86_400_000); }
    }).catch(() => { out.errors.push('RDAP lookup failed'); }),
    fetchHomepage(domain).then((h) => { out.homepage = h; }).catch(() => { out.homepage = { fetched: false, title: null, injection: [] }; }),
  ]);
  if (out.errors.length === 3) out.available = false;
  return out;
};
export const noPublicEvidence: PublicEvidenceProvider = async (domain) => ({ domain, reservedTestDomain: false, available: false, errors: ['Public lookups are turned off'], hasMx: null, hasDmarc: null, registeredAt: null, ageDays: null, homepage: null });
