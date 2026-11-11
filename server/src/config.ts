import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(8787),
  // A new file: the bilateral schema is not compatible with earlier ProxyProof databases.
  DATABASE_PATH: z.string().default('./data/proxyproof.db'),
  PUBLIC_URL: z.string().default('http://localhost:8787'),
  // Payment rail. Sandbox only by construction: see executor/paypal.ts.
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  // Sandbox personal account that plays the buyer: invoices are sent here and it approves checkouts.
  PAYPAL_SANDBOX_RECEIVER_EMAIL: z.string().optional(),
  // Sandbox business account email of the app's PayPal credentials, shown as the seller's verified account.
  PAYPAL_SANDBOX_MERCHANT_EMAIL: z.string().optional(),
  PAYPAL_BASE_URL: z.string().optional(), // Loopback mock only; anything else is refused.
  // Set to 1 only behind a proxy that overwrites X-Forwarded-For (Render does).
  TRUST_PROXY: z.string().default('0'),
  SANDBOX_PAYMENTS_PER_WORKSPACE: z.coerce.number().default(6),
  SANDBOX_PAYMENTS_PER_DAY: z.coerce.number().default(80),
});

export type Config = z.infer<typeof Env>;
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  return Env.parse(cleaned);
}
