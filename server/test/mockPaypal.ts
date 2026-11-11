import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Loopback stand-in for the PayPal sandbox (Orders, Invoicing, webhook verification). Records every call. */
export async function startMockPayPal() {
  const calls: { method: string; path: string; body: string }[] = [];
  const state = { invoiceStatus: 'SENT', orderApproved: false, captured: false, verify: 'SUCCESS' };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ method: req.method!, path: req.url!, body });
      const send = (status: number, json: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
      const u = req.url!;
      if (u === '/v1/oauth2/token') return send(200, { access_token: 'mock-token', expires_in: 3600 });
      if (u === '/v2/checkout/orders' && req.method === 'POST') return send(201, { id: 'ORDER1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1' }] });
      if (u === '/v2/checkout/orders/ORDER1/capture') { state.captured = true; return send(201, { id: 'ORDER1', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP1', status: 'COMPLETED' }] } }] }); }
      if (u === '/v2/checkout/orders/ORDER1') return send(200, { id: 'ORDER1', status: state.captured ? 'COMPLETED' : state.orderApproved ? 'APPROVED' : 'PAYER_ACTION_REQUIRED', purchase_units: [{ payments: state.captured ? { captures: [{ id: 'CAP1', status: 'COMPLETED' }] } : {} }] });
      // Like PayPal: a link only, unless the caller asks for the representation.
      if (u === '/v2/invoicing/invoices' && req.method === 'POST') return send(201, req.headers.prefer === 'return=representation' ? { id: 'INV2-MOCK', status: 'DRAFT' } : { rel: 'self', href: `${url}/v2/invoicing/invoices/INV2-MOCK`, method: 'GET' });
      if (u === '/v2/invoicing/invoices/INV2-MOCK/send') return send(200, { href: 'https://www.sandbox.paypal.com/invoice/p/#INV2-MOCK', rel: 'payer-view', method: 'GET' });
      if (u === '/v2/invoicing/invoices/INV2-MOCK') return send(200, { id: 'INV2-MOCK', status: state.invoiceStatus });
      if (u === '/v1/notifications/verify-webhook-signature') return send(200, { verification_status: JSON.parse(body).transmission_sig === 'valid-signature' ? state.verify : 'FAILURE' });
      send(404, { name: 'NOT_FOUND' });
    });
  });
  let url = '';
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const railCalls = () => calls.filter((c) => c.method === 'POST' && /\/v2\/(checkout|invoicing)/.test(c.path));
  return { url, calls, state, railCalls, close: () => new Promise((r) => server.close(r)) };
}
