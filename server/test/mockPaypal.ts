import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Loopback stand-in for the PayPal sandbox, used only by tests. Records every call it receives. */
export async function startMockPayPal() {
  const calls: { method: string; path: string; body: string; headers: any }[] = [];
  const state = { payoutItemStatus: 'SUCCESS', failPayout: null as null | number, verify: 'SUCCESS' };
  const batches = new Map<string, string>();
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ method: req.method!, path: req.url!, body, headers: req.headers });
      const send = (status: number, json: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (req.url === '/v1/oauth2/token') return send(200, { access_token: 'mock-token', expires_in: 3600 });
      if (req.url === '/v1/payments/payouts' && req.method === 'POST') {
        if (state.failPayout) return send(state.failPayout, { name: state.failPayout >= 500 ? 'INTERNAL_SERVER_ERROR' : 'INSUFFICIENT_FUNDS', message: 'mock failure' });
        const sender = JSON.parse(body).sender_batch_header.sender_batch_id;
        const id = `MOCKBATCH${batches.size + 1}`;
        batches.set(id, sender);
        return send(201, { batch_header: { payout_batch_id: id, batch_status: 'PENDING' } });
      }
      const m = req.url!.match(/^\/v1\/payments\/payouts\/(\w+)$/);
      if (m) return send(200, { batch_header: { payout_batch_id: m[1], batch_status: 'SUCCESS' }, items: [{ payout_item_id: `ITEM-${m[1]}`, transaction_status: state.payoutItemStatus }] });
      if (req.url === '/v1/notifications/verify-webhook-signature') return send(200, { verification_status: JSON.parse(body).transmission_sig === 'valid-signature' ? state.verify : 'FAILURE' });
      if (req.url === '/v2/checkout/orders' && req.method === 'POST') return send(201, { id: 'MOCKORDER1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=MOCKORDER1' }] });
      if (req.url === '/v2/checkout/orders/MOCKORDER1/capture') return send(201, { id: 'MOCKORDER1', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP1', status: 'COMPLETED' }] } }] });
      if (req.url === '/v2/checkout/orders/MOCKORDER1') return send(200, { id: 'MOCKORDER1', status: calls.some((c) => c.path.endsWith('/capture')) ? 'COMPLETED' : 'APPROVED', purchase_units: [{ payments: calls.some((c) => c.path.endsWith('/capture')) ? { captures: [{ id: 'CAP1', status: 'COMPLETED' }] } : {} }] });
      send(404, { name: 'NOT_FOUND' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, calls, state, payoutCalls: () => calls.filter((c) => c.path === '/v1/payments/payouts' && c.method === 'POST'), close: () => new Promise((r) => server.close(r)) };
}
