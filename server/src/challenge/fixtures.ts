import PDFDocument from 'pdfkit';

export type InvoiceSpec = {
  vendor: string; address?: string; number: string; date?: string; due?: string; currency?: string; po?: string;
  items: { description: string; qty: number; unit: string; amount: string }[];
  subtotal?: string; tax?: string; total: string; remit?: string; iban?: string; note?: string; hiddenNote?: string; logo?: boolean; loose?: boolean;
};

/** Builds a real PDF with a text layer. Scenarios upload these bytes through the same path as any judge's file. */
export function invoicePdf(s: InvoiceSpec): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 56, info: { Title: `Invoice ${s.number}`, Author: s.vendor, CreationDate: new Date('2026-11-01T00:00:00Z') } });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks)))); doc.on('error', reject);
    const gap = s.loose ? 12 : 6;
    if (s.logo) { doc.save().circle(500, 70, 18).fill('#1d4ed8').restore(); doc.save().rect(490, 66, 20, 8).fill('#ffffff').restore(); }
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#111').text(s.vendor);
    doc.font('Helvetica').fontSize(10).fillColor('#333');
    if (s.address) doc.text(s.address);
    doc.moveDown(gap / 6);
    doc.font('Helvetica-Bold').fontSize(13).text('INVOICE').font('Helvetica').fontSize(10);
    doc.text(`Invoice Number: ${s.number}`);
    doc.text(`Invoice Date: ${s.date ?? 'November 2, 2026'}`);
    doc.text(`Due Date: ${s.due ?? 'December 2, 2026'}`);
    if (s.po) doc.text(`Purchase Order: ${s.po}`);
    doc.moveDown(gap / 6);
    const startY = doc.y;
    doc.font('Helvetica-Bold').text('Description', 56, startY).text('Qty', 320, startY).text('Unit', 380, startY).text('Amount', 470, startY).font('Helvetica');
    let y = startY + gap + 10;
    for (const it of s.items) {
      doc.text(it.description, 56, y, { width: 250, lineBreak: false }).text(String(it.qty), 320, y).text(it.unit, 380, y).text(it.amount, 470, y);
      y += gap + 10;
    }
    y += 10;
    const row = (label: string, value: string) => { doc.text(`${label}: ${value}`, 56, y, { lineBreak: false }); y += gap + 10; };
    if (s.subtotal) row('Subtotal', s.subtotal);
    if (s.tax) row('Tax', s.tax);
    doc.font('Helvetica-Bold'); row('Total', `${s.total} ${s.currency ?? 'USD'}`); doc.font('Helvetica');
    y += 10;
    if (s.remit) { doc.text(`Pay by PayPal to: ${s.remit}`, 56, y, { lineBreak: false }); y += gap + 10; }
    if (s.iban) { doc.text(`IBAN: ${s.iban}`, 56, y, { lineBreak: false }); y += gap + 10; }
    if (s.note) { doc.text(s.note, 56, y, { width: 500 }); y = doc.y + 6; }
    if (s.hiddenNote) { doc.fontSize(1.5).fillColor('#ffffff').text(s.hiddenNote, 56, y, { lineBreak: false }).fontSize(10).fillColor('#333'); }
    doc.end();
  });
}

export function emailFile(p: { from: string; fromName?: string; replyTo?: string; to?: string; subject: string; body: string; auth?: string; attachment?: { filename: string; bytes: Uint8Array } }): Uint8Array {
  const boundary = 'payeeproof-fixture';
  const head = [
    `From: ${p.fromName ? `"${p.fromName}" ` : ''}<${p.from}>`, `To: ${p.to ?? 'ap@example-customer.example'}`, ...(p.replyTo ? [`Reply-To: <${p.replyTo}>`] : []),
    `Subject: ${p.subject}`, 'Date: Mon, 02 Nov 2026 09:12:00 +0000', 'Message-ID: <fixture@payeeproof.test>', 'MIME-Version: 1.0', ...(p.auth ? [`Authentication-Results: mx.example; ${p.auth}`] : []),
  ];
  if (!p.attachment) return Buffer.from([...head, 'Content-Type: text/plain; charset=utf-8', '', p.body, ''].join('\r\n'));
  const b64 = Buffer.from(p.attachment.bytes).toString('base64').replace(/(.{76})/g, '$1\r\n');
  return Buffer.from([...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', p.body, '', `--${boundary}`, `Content-Type: application/pdf; name="${p.attachment.filename}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${p.attachment.filename}"`, '', b64, `--${boundary}--`, ''].join('\r\n'));
}

export const NORTHWIND = { name: 'Northwind Cloud Hosting LLC', domain: 'northwind-cloud.example', address: '410 Harbor Way, Seattle, WA 98101' };
export const MERIDIAN = { name: 'Meridian Office Supply', domain: 'meridian-office.example', paypal: 'pay@meridian-office.example' };
export const ATLAS = { name: 'Atlas Legal Partners', domain: 'atlas-legal.example', paypal: 'ar@atlas-legal.example' };
export const ATTACKER_PAYPAL = 'northwind-billing@payments-desk.example';

export const northwindInvoice = (remit: string, over: Partial<InvoiceSpec> = {}): InvoiceSpec => ({
  vendor: NORTHWIND.name, address: NORTHWIND.address, number: 'INV-2041', po: 'PO-7781', remit,
  items: [{ description: 'Managed hosting, November', qty: 1, unit: '1,100.00', amount: '1,100.00' }, { description: 'Backup storage', qty: 1, unit: '100.00', amount: '100.00' }],
  subtotal: '1,200.00', tax: '96.00', total: '1,296.00', ...over,
});
