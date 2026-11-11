/**
 * The only module that reads PayPal credentials. It is imported only by executor/. Nothing in trust/ or runtime/
 * can reach it; a test enforces that. It talks to the PayPal sandbox or a loopback mock, never live.
 */
import type { Config } from '../config.js';
import { minorToDecimal } from '../core/util.js';

const SANDBOX = 'https://api-m.sandbox.paypal.com';
export class ProviderError extends Error {
  constructor(message: string, public kind: 'DEFINITE' | 'AMBIGUOUS', public status?: number, public name_?: string) { super(message); }
}
export type PayPal = ReturnType<typeof createPayPal>;

// Issued only by the gate. A pass cannot be constructed elsewhere, so a rail call without one fails.
const issued = new WeakSet<object>();
export type GatePass = { readonly attemptId: string; readonly transactionId: string };
export function __issuePass(p: GatePass): GatePass { const o = Object.freeze({ ...p }); issued.add(o); return o; }
const assertPass = (p: GatePass) => { if (!p || typeof p !== 'object' || !issued.has(p)) throw new Error('Rail call refused: no gate pass.'); };

export function createPayPal(config: Config) {
  const base = config.PAYPAL_BASE_URL ?? SANDBOX;
  if (base !== SANDBOX && !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('PAYPAL_BASE_URL must be the sandbox or a loopback mock.');
  const configured = Boolean(config.PAYPAL_CLIENT_ID && config.PAYPAL_CLIENT_SECRET);
  let cached: { token: string; until: number } | null = null;

  async function token(): Promise<string> {
    if (!configured) throw new ProviderError('PayPal sandbox credentials are not configured.', 'DEFINITE');
    if (cached && cached.until > Date.now()) return cached.token;
    const res = await fetch(`${base}/v1/oauth2/token`, {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Basic ${Buffer.from(`${config.PAYPAL_CLIENT_ID}:${config.PAYPAL_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    }).catch(() => { throw new ProviderError('Could not reach PayPal.', 'AMBIGUOUS'); });
    if (!res.ok) throw new ProviderError(`PayPal refused the credentials (HTTP ${res.status}).`, 'DEFINITE', res.status);
    const j: any = await res.json();
    cached = { token: j.access_token, until: Date.now() + (j.expires_in - 60) * 1000 };
    return cached.token;
  }

  async function call(path: string, opts: { method?: string; json?: unknown; requestId?: string; rawBody?: string; prefer?: string } = {}): Promise<any> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await token()}`, Accept: 'application/json' };
    if (opts.prefer) headers.Prefer = opts.prefer;
    if (opts.json || opts.rawBody) headers['Content-Type'] = 'application/json';
    if (opts.requestId) headers['PayPal-Request-Id'] = opts.requestId;
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, { method: opts.method ?? 'GET', headers, body: opts.rawBody ?? (opts.json ? JSON.stringify(opts.json) : undefined), signal: AbortSignal.timeout(20_000) });
    } catch { throw new ProviderError('PayPal did not respond, so the outcome is unknown.', 'AMBIGUOUS'); }
    const text = await res.text();
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
    if (!res.ok) {
      const kind = res.status >= 500 || res.status === 429 ? 'AMBIGUOUS' : 'DEFINITE';
      const issue = Array.isArray(data.details) && data.details[0] ? ` (${[data.details[0].issue, data.details[0].field].filter(Boolean).join(' at ')})` : '';
      throw new ProviderError(`PayPal returned ${data.name ?? `HTTP ${res.status}`}${data.message ? `: ${data.message}` : ''}${issue}`, kind, res.status, data.name);
    }
    return data;
  }

  return {
    configured, base, webhookConfigured: Boolean(config.PAYPAL_WEBHOOK_ID),
    async health() { await token(); return true; },

    /** Checkout for a bilateral transaction ProxyProof allowed. The buyer approves on PayPal; no agent can. */
    async createOrder(pass: GatePass, p: { idempotencyKey: string; amountMinor: number; currency: string; reference: string; description: string; returnUrl: string; cancelUrl: string }) {
      assertPass(pass);
      const data = await call('/v2/checkout/orders', {
        method: 'POST', requestId: p.idempotencyKey,
        json: {
          intent: 'CAPTURE',
          purchase_units: [{ reference_id: pass.transactionId, custom_id: pass.attemptId, invoice_id: p.reference.slice(0, 127), description: p.description.slice(0, 127), amount: { currency_code: p.currency, value: minorToDecimal(p.amountMinor) } }],
          payment_source: { paypal: { experience_context: { user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', return_url: p.returnUrl, cancel_url: p.cancelUrl } } },
        },
      });
      return { orderId: data.id as string, status: data.status as string, approveUrl: data.links?.find((l: any) => ['payer-action', 'approve'].includes(l.rel))?.href as string | undefined };
    },
    async captureOrder(pass: GatePass, orderId: string, idempotencyKey: string) {
      assertPass(pass);
      const data = await call(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: 'POST', requestId: `${idempotencyKey}-capture`, rawBody: '{}' });
      const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
      return { status: data.status as string, captureId: capture?.id as string | undefined, captureStatus: capture?.status as string | undefined };
    },
    async getOrder(orderId: string) {
      const data = await call(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
      const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
      return { status: data.status as string, captureId: capture?.id as string | undefined, captureStatus: capture?.status as string | undefined };
    },

    /** PayPal's own verification endpoint. Unconfigured or failing verification means the event is rejected. */
    async verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<boolean> {
      if (!configured || !config.PAYPAL_WEBHOOK_ID) return false;
      const need = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];
      if (need.some((h) => !headers[h])) return false;
      let certHost = '';
      try { certHost = new URL(headers['paypal-cert-url']!).hostname; } catch { return false; }
      if (!/(^|\.)paypal\.com$/.test(certHost) && !base.startsWith('http://127.0.0.1')) return false;
      // The event is embedded verbatim: re-serializing would change bytes the signature covers.
      const envelope = `{"auth_algo":${JSON.stringify(headers['paypal-auth-algo'])},"cert_url":${JSON.stringify(headers['paypal-cert-url'])},"transmission_id":${JSON.stringify(headers['paypal-transmission-id'])},"transmission_sig":${JSON.stringify(headers['paypal-transmission-sig'])},"transmission_time":${JSON.stringify(headers['paypal-transmission-time'])},"webhook_id":${JSON.stringify(config.PAYPAL_WEBHOOK_ID)},"webhook_event":${rawBody}}`;
      try {
        const res = await call('/v1/notifications/verify-webhook-signature', { method: 'POST', rawBody: envelope });
        return res.verification_status === 'SUCCESS';
      } catch { return false; }
    },
  };
}
