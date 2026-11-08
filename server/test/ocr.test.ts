import { describe, expect, it, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { ocrImage, closeOcr } from '../src/ingest/files.js';
import { parseInvoiceText } from '../src/ingest/parse.js';

afterAll(() => closeOcr());
describe('image invoices', () => {
  it('reads a PNG invoice locally and extracts its fields', async () => {
    const { text, confidence } = await ocrImage(readFileSync('fixtures/genuine-northwind-invoice.png'));
    const e = parseInvoiceText(text);
    expect(confidence).toBeGreaterThan(0.5);
    expect(e.invoiceNumber.value).toBe('INV-3101');
    expect(e.total.value).toBe(129600);
    console.log('OCR fields:', e.vendorName.value, e.invoiceNumber.value, e.total.value, e.destinations);
  }, 90_000);
});
