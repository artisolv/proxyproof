// Registers the deployed webhook URL with the PayPal sandbox app and prints the webhook ID to put in PAYPAL_WEBHOOK_ID.
// Usage: node --env-file=.env --import tsx scripts/register-webhook.ts https://your-host/api/paypal/webhooks
const url = process.argv[2];
if (!url?.startsWith('https://')) throw new Error('Pass the public HTTPS webhook URL.');
const base = 'https://api-m.sandbox.paypal.com';
const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
const { access_token } = await (await fetch(`${base}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })).json() as any;
const events = ['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.REFUNDED', 'INVOICING.INVOICE.PAID', 'INVOICING.INVOICE.CANCELLED'];
const res = await fetch(`${base}/v1/notifications/webhooks`, { method: 'POST', headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ url, event_types: events.map((name) => ({ name })) }) });
const out: any = await res.json();
console.log(res.ok ? `Webhook ID: ${out.id}` : `Failed: ${out.name} ${out.message ?? ''}`);
