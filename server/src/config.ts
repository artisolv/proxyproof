import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(8787),
  DATABASE_PATH: z.string().default('./data/payeeproof.db'),
  PUBLIC_URL: z.string().default('http://localhost:8787'),
  // Secrets. Generated into the database on first boot when unset (fine for local runs).
  SERVER_SECRET: z.string().optional(),
  // Payment rail. Sandbox only by construction: see executor/paypal.ts.
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  PAYPAL_SANDBOX_RECEIVER_EMAIL: z.string().optional(),
  PAYPAL_BASE_URL: z.string().optional(), // Loopback mock only; anything else is refused.
  // AI. Optional: deterministic extraction always runs; Claude adds to it.
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default('claude-opus-5-5'),
  AI_DAILY_CALL_LIMIT: z.coerce.number().default(300),
  // Public evidence lookups (DNS, RDAP, vendor homepage). Corroboration only.
  PUBLIC_EVIDENCE: z.enum(['on', 'off']).default('on'),
  MAX_UPLOAD_BYTES: z.coerce.number().default(10 * 1024 * 1024),
  // Set to 1 only behind a proxy that overwrites X-Forwarded-For (Render does).
  TRUST_PROXY: z.string().default('0'),
  SANDBOX_PAYMENTS_PER_WORKSPACE: z.coerce.number().default(5),
  SANDBOX_PAYMENTS_PER_DAY: z.coerce.number().default(60),
  // New demo workspaces get sample requests run through the real pipeline. Off by default in tests.
  DEMO_SAMPLES: z.enum(['on', 'off']).optional(),
});

export type Config = z.infer<typeof Env>;
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  return Env.parse(cleaned);
}
