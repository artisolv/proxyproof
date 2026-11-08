// An external AI agent integrating with PayeeProof. The agent holds its own Ed25519 key; the server only ever sees the public half.
// Usage: npx tsx scripts/agent-client.ts [base_url]   (defaults to http://localhost:8787)
// It opens a demo workspace as the owner, registers this agent's public key, receives a scoped authorization,
// then submits signed payment requests: one legitimate, one over its limit, and one replayed.
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';

const base = process.argv[2] ?? 'http://localhost:8787';
const canonicalize = (v: any): string => v === null || v === undefined ? 'null' : Array.isArray(v) ? `[${v.map(canonicalize).join(',')}]`
  : typeof v === 'object' ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(',')}}` : JSON.stringify(v);

// 1. The owner sets things up through the normal app API.
const start = await fetch(`${base}/api/demo/start`, { method: 'POST', headers: { 'x-payeeproof': '1' } });
const cookie = start.headers.get('set-cookie')!.split(';')[0];
const { workspaceId } = await start.json() as any;
const owner = (path: string, body?: unknown) => fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { cookie, 'x-payeeproof': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json()) as Promise<any>;
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const agent = await owner('/api/agents', { name: 'External AP agent', simulated: false, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) });
const northwind = (await owner('/api/vendors')).vendors.find((v: any) => v.name.startsWith('Northwind'));
const grant = await owner(`/api/agents/${agent.id}/authorizations`, { vendorIds: [northwind.id], categories: ['hosting'], currencies: ['USD'], perTxMaxMinor: 200000, dailyBudgetMinor: 500000, monthlyBudgetMinor: 2000000, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
console.log(`Workspace ${workspaceId}: registered agent ${agent.id}, authorization v${grant.version}`);

// 2. The agent signs and submits. It never touches PayPal or any credential.
async function submit(label: string, payment: any, nonce = randomBytes(16).toString('base64url')) {
  const envelope: any = { agent_id: agent.id, authorization: grant.token, nonce, timestamp: new Date().toISOString(), payment };
  envelope.signature = sign(null, Buffer.from(canonicalize(envelope)), privateKey).toString('base64url');
  const res = await fetch(`${base}/api/agent/${workspaceId}/payment-requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ envelope }) });
  const out: any = await res.json();
  console.log(`${label}: ${out.decision} ${out.reasons?.map((r: any) => r.code).join(', ') || '(no rule fired)'}  executable_by_agent=${out.executable_by_agent}`);
  return nonce;
}
const pay = { vendor_id: northwind.id, amount_minor: 129600, currency: 'USD', category: 'hosting', purpose: 'November hosting' };
const nonce = await submit('Legitimate request', pay);
await submit('Over its per-payment limit', { ...pay, amount_minor: 450000 });
await submit('Replayed message', pay, nonce);
await submit('Unapproved category', { ...pay, category: 'travel' });
