import { simpleParser } from 'mailparser';
import { sha256 } from '../core/util.js';

export class RejectedFile extends Error {}
export type Kind = 'PDF' | 'IMAGE' | 'EMAIL' | 'TEXT';

/** Trusts file contents, never the name or claimed type. */
export function sniff(bytes: Uint8Array, filename: string): { kind: Kind; mime: string } {
  const b = Buffer.from(bytes.subarray(0, 12));
  if (b.subarray(0, 5).toString() === '%PDF-') return { kind: 'PDF', mime: 'application/pdf' };
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'IMAGE', mime: 'image/png' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'IMAGE', mime: 'image/jpeg' };
  const head = Buffer.from(bytes.subarray(0, 4096));
  if (head.includes(0)) throw new RejectedFile('This file type is not supported. Upload a PDF, PNG, JPG, or .eml file.');
  const text = head.toString('utf8');
  if (/\.eml$/i.test(filename) || /^(received|from|subject|return-path|delivered-to|mime-version|date|to|message-id|dkim-signature|authentication-results):/im.test(text.split(/\r?\n\r?\n/)[0] ?? ''))
    return { kind: 'EMAIL', mime: 'message/rfc822' };
  if (/\.txt$/i.test(filename)) return { kind: 'TEXT', mime: 'text/plain' };
  throw new RejectedFile('This file type is not supported. Upload a PDF, PNG, JPG, or .eml file.');
}

const MAX_PDF_PAGES = 20;
const MAX_TEXT = 200_000;
const withTimeout = <T,>(p: Promise<T>, ms: number, label: string) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new RejectedFile(`${label} took too long and was stopped.`)), ms))]);

export async function pdfToText(bytes: Uint8Array): Promise<{ text: string; pages: number; tinyTextLines: string[] }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, stopAtErrors: true, verbosity: 0 } as any);
  const doc = await withTimeout(task.promise, 15_000, 'PDF parsing').catch((e: any) => {
    task.destroy();
    if (e?.name === 'PasswordException') throw new RejectedFile('This PDF is password protected. Upload an unlocked copy.');
    if (e instanceof RejectedFile) throw e;
    throw new RejectedFile('This PDF is damaged or could not be read.');
  });
  if (doc.numPages > MAX_PDF_PAGES) { await task.destroy(); throw new RejectedFile(`This PDF has ${doc.numPages} pages. The limit is ${MAX_PDF_PAGES}.`); }
  const out: string[] = [], tiny: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const rows = new Map<number, { x: number; s: string; h: number }[]>();
    for (const item of content.items as any[]) {
      if (!item.str?.trim()) continue;
      const y = Math.round(item.transform[5] / 3) * 3;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y)!.push({ x: item.transform[4], s: item.str, h: Math.abs(item.transform[3]) });
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      const cells = rows.get(y)!.sort((a, b) => a.x - b.x);
      const line = cells.map((c) => c.s.trim()).join(' ');
      out.push(line);
      if (cells.every((c) => c.h > 0 && c.h < 3)) tiny.push(line.slice(0, 220));
    }
    out.push('');
    if (out.join('\n').length > MAX_TEXT) break;
  }
  const pages = doc.numPages;
  await task.destroy();
  return { text: out.join('\n').slice(0, MAX_TEXT), pages, tinyTextLines: tiny };
}

export type ParsedEmail = {
  from: string | null; fromName: string | null; replyTo: string | null; returnPath: string | null; to: string | null; subject: string | null; date: string | null;
  text: string; authenticationResults: { spf: string | null; dkim: string | null; dmarc: string | null; present: boolean };
  attachments: { filename: string; bytes: Uint8Array }[];
};
export async function parseEml(bytes: Uint8Array): Promise<ParsedEmail> {
  const mail: any = await (simpleParser as any)(Buffer.from(bytes), { skipImageLinks: true, maxHtmlLengthToParse: 1_000_000 } as any);
  const addr = (a: any) => (Array.isArray(a) ? a[0] : a)?.value?.[0] ?? null;
  const ar = [mail.headers.get('authentication-results')].flat().map(String).join(' ');
  const verdict = (k: string) => ar.match(new RegExp(`\\b${k}=(\\w+)`, 'i'))?.[1]?.toLowerCase() ?? null;
  return {
    from: addr(mail.from)?.address?.toLowerCase() ?? null, fromName: addr(mail.from)?.name || null,
    replyTo: addr(mail.replyTo)?.address?.toLowerCase() ?? null,
    returnPath: String(mail.headers.get('return-path') ?? '').match(/[^<\s]+@[^>\s]+/)?.[0]?.toLowerCase() ?? null,
    to: addr(mail.to)?.address?.toLowerCase() ?? null, subject: mail.subject ?? null, date: mail.date?.toISOString() ?? null,
    text: (mail.text ?? '').slice(0, MAX_TEXT),
    authenticationResults: { spf: verdict('spf'), dkim: verdict('dkim'), dmarc: verdict('dmarc'), present: Boolean(ar) },
    attachments: (mail.attachments ?? []).slice(0, 5).map((a: any) => ({ filename: a.filename ?? 'attachment', bytes: new Uint8Array(a.content) })),
  };
}

let ocrWorker: Promise<any> | null = null;
/** Local OCR with bundled language data: no network, no upload to a third party. */
export async function ocrImage(bytes: Uint8Array): Promise<{ text: string; confidence: number }> {
  if (!ocrWorker) {
    ocrWorker = (async () => {
      const { createWorker } = await import('tesseract.js');
      const { createRequire } = await import('node:module');
      const { dirname } = await import('node:path');
      const req = createRequire(import.meta.url);
      const langPath = dirname(req.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'));
      return createWorker('eng', 1, { langPath, cacheMethod: 'none', gzip: true, logger: () => {}, errorHandler: () => {} });
    })();
  }
  const worker = await ocrWorker;
  const { data } = await withTimeout(worker.recognize(Buffer.from(bytes)), 60_000, 'Reading the image') as any;
  return { text: data.text as string, confidence: (data.confidence as number) / 100 };
}
export async function closeOcr() { if (ocrWorker) { const w = await ocrWorker; ocrWorker = null; await w.terminate(); } }
export const fileHash = sha256;
