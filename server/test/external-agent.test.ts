import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, jwtVerify } from 'jose';
import { createHash } from 'node:crypto';
import { setup } from './helpers.js';

/**
 * A buyer agent written only against docs/architecture/connector-api.md: it uses jose and HTTP and imports nothing from
 * ProxyProof. Canonical JSON and hashing are re-implemented here from the documentation.
 */
const canonical = (v: any): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object'
  ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('an independently developed agent on the REST API', () => {
  it('registers with its own key, waits for its organization, accepts a verified invoice and checks the receipt', async () => {
    const t = await setup();
    const call = async (path: string, body?: unknown) => {
      const r = await t.app.request(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, json: (await r.json()) as any };
    };
    const base = `/api/v1/workspaces/${t.ws}`;
    const dir = (await call(`${base}/directory`)).json;
    const northwind = dir.organizations.find((o: any) => o.name === 'Northwind Hotels');
    const harbor = dir.organizations.find((o: any) => o.name === 'Harbor & Pine Roasters');

    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const reg = await call(`${base}/agents`, { name: 'Independent buyer', side: 'BUYER', organization_did: northwind.did, public_jwk: await exportJWK(publicKey), provider: 'Custom framework' });
    expect(reg.status).toBe(201);
    expect(reg.json.state).toBe('CONNECTED');
    const did = reg.json.did as string;
    expect((await call(`${base}/agents/credential`, { agent: did })).json.authorized).toBe(false);

    // The organization approves (human delegation boundary).
    const d = await t.post(`/api/agents/${reg.json.agent_id}/delegations`, { mandate: { actions: ['purchase'], max_amount_minor: 20_000, currencies: ['USD'], categories: ['coffee'], counterparties: [harbor.did] }, valid_until: new Date(Date.now() + 86_400_000).toISOString() });
    await t.post(`/api/delegations/${d.json.id}/approve`);
    const cred = (await call(`${base}/agents/credential`, { agent: did })).json;
    expect(cred.authorized).toBe(true);

    // The seller's agent issues an invoice; this agent reads the exact terms and signs them.
    const offer = await t.offer('Harbor & Pine Sales Agent', 'Northwind Hotels', [['Ethiopia Guji, 2 lb', 1]]);
    const tx = (await call(`${base}/transactions/${offer.transaction_id}`)).json;
    expect(tx.checks.filter((c: any) => c.group === 'seller').every((c: any) => c.state === 'pass')).toBe(true);
    const ch = (await call(`${base}/challenges`, { agent: did })).json;
    const request = await new SignJWT({ kind: 'ACCEPT', nonce: ch.nonce, counterparty: tx.terms.seller, terms_hash: sha256(canonical(tx.terms)), delegation_hash: sha256(cred.credential), transaction_id: tx.transaction_id })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'agent-request+jwt', kid: did }).setIssuer(did).setAudience(ch.audience).setIssuedAt().setJti(ch.nonce).sign(privateKey);
    expect(sha256(canonical(tx.terms))).toBe(tx.terms_hash);
    const res = await call(`${base}/transactions/${tx.transaction_id}/accept`, { request, delegation: cred.credential });
    expect(res.json.decision).toBe('ALLOW');
    expect(res.json.permit.jws).toBeTruthy();

    // Verify ProxyProof's decision receipt with nothing but the published JWKS.
    const keys = (await call('/.well-known/jwks.json')).json;
    const { payload } = await jwtVerify(res.json.decision_receipt, createLocalJWKSet(keys), { typ: 'proxyproof-receipt+jwt' });
    expect(payload.decision).toBe('ALLOW');
    expect(payload.terms_hash).toBe(tx.terms_hash);
  });

  it('rejects a registration carrying a private key', async () => {
    const t = await setup();
    const dir = (await (await t.app.request(`/api/v1/workspaces/${t.ws}/directory`)).json()) as any;
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const r = await t.app.request(`/api/v1/workspaces/${t.ws}/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Leaky', side: 'BUYER', organization_did: dir.organizations[0].did, public_jwk: await exportJWK(privateKey) }) });
    expect(r.status).toBe(400);
  });
});
