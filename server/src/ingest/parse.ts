import { normalizeInvoiceNumber, parseMoneyToMinor } from '../core/util.js';

export type FieldStatus = 'FOUND' | 'UNKNOWN' | 'CONFLICT';
export type Field<T = string> = { value: T | null; status: FieldStatus; confidence: number; source: string | null; candidates?: T[] };
export type LineItem = { description: string; quantity: string | null; unitPriceMinor: number | null; amountMinor: number };
export type Destination = { type: 'PAYPAL_EMAIL' | 'IBAN' | 'BANK_ACCOUNT' | 'OTHER'; value: string; source: string };
export type Extracted = {
  vendorName: Field; invoiceNumber: Field; invoiceDate: Field; dueDate: Field; currency: Field;
  total: Field<number>; subtotal: Field<number>; tax: Field<number>; purchaseOrder: Field;
  destinations: Destination[]; lineItems: LineItem[]; urls: string[]; emails: string[];
  textLength: number; method: string[];
};

export const unknown = <T = string>(): Field<T> => ({ value: null, status: 'UNKNOWN', confidence: 0, source: null });
const found = <T,>(value: T, source: string, confidence = 0.9): Field<T> => ({ value, status: 'FOUND', confidence, source });

const MONEY = String.raw`(?:(?:USD|EUR|GBP|INR|CAD|AUD)\s*)?[$€£₹]?\s*(-?\d[\d.,]*\d|\d)(?:\s*(?:USD|EUR|GBP|INR|CAD|AUD))?`;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const emailOf = (s: string) => s.match(EMAIL)?.[0].toLowerCase() ?? null;

function detectCurrency(text: string): Field {
  const codes = new Set([...text.matchAll(/\b(USD|EUR|GBP|INR|CAD|AUD)\b/g)].map((m) => m[1]));
  const symbols: Record<string, string> = { '$': 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR' };
  for (const [sym, code] of Object.entries(symbols)) if (text.includes(sym) && !codes.size) codes.add(code);
  if (codes.size === 1) return found([...codes][0], 'currency code or symbol', 0.95);
  if (codes.size > 1) return { value: null, status: 'CONFLICT', confidence: 0.3, source: 'currency code or symbol', candidates: [...codes] };
  return unknown();
}

/**
 * Deterministic parser for labelled invoice text. It reports what the document says and marks
 * anything absent or contradictory as UNKNOWN or CONFLICT. It never guesses a missing value.
 */
export function parseInvoiceText(text: string): Extracted {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const take = (re: RegExp) => {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (m) return { value: m[1].trim(), source: `line ${i + 1}` };
    }
    return null;
  };

  let vendorName: Field = unknown();
  const labelled = take(/^(?:vendor|supplier|from|seller|issued by|bill from)\s*[:\-]\s*(.+)$/i);
  if (labelled) vendorName = found(labelled.value, labelled.source, 0.9);
  else {
    const i = lines.findIndex((l) => !/^(tax\s+)?invoice\b|^bill\b|^page\b|^receipt\b|^date\b|@|^https?:/i.test(l) && /[a-z]{2}/i.test(l));
    if (i >= 0 && i < 6) vendorName = found(lines[i], `line ${i + 1}`, 0.6);
  }

  const num = take(/\binvoice\s*(?:number|num|no\.?|#|id)\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-\/_.]*(?: \d[A-Z0-9\-\/_.]*)?)/i) ?? take(/^inv[\s#:\-]+([A-Z0-9][A-Z0-9\-\/_.]*)/i);
  const invoiceNumber: Field = num ? found(num.value.replace(/\.$/, ''), num.source, 0.95) : unknown();
  const date = take(/\b(?:invoice\s+date|date\s+issued|issue\s+date|issued|^date)\s*[:\-]?\s*([A-Za-z0-9,\/\-. ]{6,24})$/i);
  const due = take(/\b(?:due\s+date|payment\s+due|due)\s*[:\-]?\s*([A-Za-z0-9,\/\-. ]{6,24})$/i);
  const po = take(/\b(?:purchase\s+order|p\.?o\.?)\s*(?:number|no\.?|#)?\s*[:#\-]\s*([A-Z0-9][A-Z0-9\-\/_]*)/i);

  const moneyAt = (re: RegExp): { minor: number; source: string }[] => {
    const out: { minor: number; source: string }[] = [];
    lines.forEach((l, i) => {
      const m = l.match(re);
      if (!m) return;
      const v = parseMoneyToMinor(m[1]);
      if (v !== null) out.push({ minor: v, source: `line ${i + 1}` });
    });
    return out;
  };
  const totals = [
    ...moneyAt(new RegExp(String.raw`^(?:grand\s+|invoice\s+)?total(?:\s+(?:due|amount|payable))?\s*[:\-]?\s*${MONEY}\s*$`, 'i')),
    ...moneyAt(new RegExp(String.raw`^(?:amount|balance)\s+(?:due|payable)\s*[:\-]?\s*${MONEY}\s*$`, 'i')),
    ...moneyAt(new RegExp(String.raw`^(?:pay\s+this\s+amount|total\s+to\s+pay)\s*[:\-]?\s*${MONEY}\s*$`, 'i')),
  ];
  const distinct = [...new Set(totals.map((t) => t.minor))];
  const total: Field<number> = !totals.length ? unknown<number>()
    : distinct.length === 1 ? found(distinct[0], totals[0].source, 0.95)
    : { value: null, status: 'CONFLICT', confidence: 0.2, source: totals.map((t) => t.source).join(', '), candidates: distinct };
  const sub = moneyAt(new RegExp(String.raw`^sub[\s-]?total\s*[:\-]?\s*${MONEY}\s*$`, 'i'))[0];
  const taxRow = moneyAt(new RegExp(String.raw`^(?:sales\s+tax|tax|vat|gst)(?:\s*\([^)]*\))?\s*[:\-]?\s*${MONEY}\s*$`, 'i'))[0];

  const lineItems: LineItem[] = [];
  const itemRe = new RegExp(String.raw`^(.+?)\s+(\d+(?:\.\d+)?)\s+${MONEY}\s+${MONEY}\s*$`);
  for (const l of lines) {
    if (/^(sub[\s-]?total|total|tax|vat|gst|amount|balance|description|item)\b/i.test(l)) continue;
    const m = l.match(itemRe);
    if (m) {
      const unit = parseMoneyToMinor(m[3]), amt = parseMoneyToMinor(m[4]);
      if (amt !== null) lineItems.push({ description: m[1], quantity: m[2], unitPriceMinor: unit, amountMinor: amt });
    }
  }

  const destinations: Destination[] = [];
  lines.forEach((l, i) => {
    const source = `line ${i + 1}`;
    if (/pay\s*pal/i.test(l) || /\b(?:remit|send|pay(?:ment)?)\b.*\bto\b.*@/i.test(l)) {
      const e = emailOf(l);
      if (e) destinations.push({ type: 'PAYPAL_EMAIL', value: e, source });
    }
    const iban = l.match(/\biban\s*[:\-]?\s*([A-Z]{2}\d{2}[A-Z0-9 ]{10,32})/i);
    if (iban) destinations.push({ type: 'IBAN', value: iban[1].replace(/\s+/g, '').toUpperCase(), source });
    const acct = l.match(/\b(?:account|acct)(?:\s*(?:number|no\.?|#))?\s*[:\-]\s*([0-9][0-9 \-]{5,24})/i);
    if (acct) destinations.push({ type: 'BANK_ACCOUNT', value: acct[1].replace(/[\s\-]/g, ''), source });
  });
  const seen = new Set<string>();
  const uniqueDest = destinations.filter((d) => { const k = `${d.type}:${d.value}`; if (seen.has(k)) return false; seen.add(k); return true; });

  return {
    vendorName, invoiceNumber,
    invoiceDate: date ? found(date.value, date.source, 0.85) : unknown(),
    dueDate: due ? found(due.value, due.source, 0.85) : unknown(),
    currency: detectCurrency(text), total,
    subtotal: sub ? found(sub.minor, sub.source) : unknown<number>(),
    tax: taxRow ? found(taxRow.minor, taxRow.source) : unknown<number>(),
    purchaseOrder: po ? found(po.value, po.source, 0.85) : unknown(),
    destinations: uniqueDest, lineItems,
    urls: [...new Set([...text.matchAll(/https?:\/\/[^\s<>"')]+/gi)].map((m) => m[0]))].slice(0, 25),
    emails: [...new Set([...text.matchAll(new RegExp(EMAIL.source, 'gi'))].map((m) => m[0].toLowerCase()))].slice(0, 25),
    textLength: text.length, method: ['deterministic'],
  };
}

export const semanticKey = (vendorName: string | null, number: string | null, totalMinor: number | null, currency: string | null) =>
  [vendorName?.toLowerCase().replace(/[^a-z0-9]/g, ''), number ? normalizeInvoiceNumber(number) : '', totalMinor ?? '', currency ?? ''].join('|');

/** Lines of text aimed at software rather than a person reading an invoice. A signal only, never a decision. */
const INJECTION: RegExp[] = [
  /\bignore\b.{0,40}\b(previous|prior|above|all|earlier|system)\b.{0,30}\b(instructions?|rules?|prompts?|policy|policies|checks?)\b/i,
  /\b(disregard|bypass|override|skip|disable)\b.{0,40}\b(rules?|checks?|policy|policies|verification|instructions?|controls?|guardrails?)\b/i,
  /\b(system prompt|developer message|you are (an? )?(ai|assistant|model|agent)|as an ai)\b/i,
  /\b(ai|llm|assistant|agent|model|automated (system|reviewer))\b.{0,50}\b(must|should|shall|please|will)\b.{0,40}\b(approve|pay|allow|mark|verify|release)\b/i,
  /\b(auto[- ]?approve|mark (this|the) (invoice|payment|vendor|request).{0,20}(verified|approved|safe|trusted)|approve (this|the) (invoice|payment) (immediately|automatically|without))\b/i,
  /<\/?(system|instructions?|assistant|tool_use|untrusted)[^>]*>/i,
];
const URGENCY: RegExp[] = [
  /\b(urgent(ly)?|immediately|right away|asap|within (the )?(hour|\d+ hours?)|by end of (the )?day|today only|final notice)\b/i,
  /\b(keep this (confidential|between us)|do not (call|contact|tell|discuss)|don'?t (call|contact|tell)|confidential (transaction|acquisition|matter))\b/i,
  /\b((our|my) (bank|account|banking|payment) (details?|information|info)? ?(has|have)? ?(changed|been updated)|new (bank|payment|paypal) (details?|account|address)|updated (bank|payment|remittance) (details?|information))\b/i,
];
export function scanSignals(text: string) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hit = (res: RegExp[]) => lines.filter((l) => res.some((r) => r.test(l))).map((l) => l.slice(0, 220));
  return { injection: hit(INJECTION), urgency: hit(URGENCY) };
}
