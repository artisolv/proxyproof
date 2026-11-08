export class ApiError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: { 'x-payeeproof': '1' } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.body = JSON.stringify(body); (init.headers as any)['content-type'] = 'application/json'; }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status}).`, res.status, data.code);
  return data as T;
}
export const api = {
  get: <T = any>(p: string) => request<T>('GET', p),
  post: <T = any>(p: string, b: unknown = {}) => request<T>('POST', p, b),
  put: <T = any>(p: string, b: unknown) => request<T>('PUT', p, b),
};
export const money = (minor: number | null | undefined, currency = 'USD') => minor === null || minor === undefined ? 'Unknown' : new Intl.NumberFormat('en-US', { style: 'currency', currency: /^[A-Z]{3}$/.test(currency) ? currency : 'USD' }).format(minor / 100);
export const when = (iso?: string | null) => iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
export const toMinor = (s: string) => { const m = s.replace(/[,\s$]/g, '').match(/^(\d+)(?:\.(\d{1,2}))?$/); return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null; };
