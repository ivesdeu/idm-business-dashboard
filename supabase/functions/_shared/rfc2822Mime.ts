/** Build RFC 2822 MIME messages for Gmail API raw send. */

export type MimeAttachment = {
  filename: string;
  mimeType: string;
  content: Uint8Array;
  contentId?: string;
  disposition?: "attachment" | "inline";
};

export type BuildMimeParams = {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  plainBody: string;
  htmlBody?: string;
  attachments?: MimeAttachment[];
  inReplyTo?: string;
  references?: string;
};

const CRLF = "\r\n";
const MAX_MESSAGE_BYTES = 20 * 1024 * 1024;

function singleLine(s: string): string {
  return s.replace(/\r?\n/g, " ").trim();
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function foldBase64(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return lines.join(CRLF);
}

function boundary(): string {
  return `bizdash_${crypto.randomUUID().replace(/-/g, "")}`;
}

function partHeaders(contentType: string, extra?: string): string {
  const lines = [`Content-Type: ${contentType}`, "Content-Transfer-Encoding: base64"];
  if (extra) lines.push(extra);
  return lines.join(CRLF);
}

function buildAlternativePart(plain: string, html: string, altBoundary: string): string {
  const plainBytes = new TextEncoder().encode(plain);
  const htmlBytes = new TextEncoder().encode(html);
  return [
    `--${altBoundary}`,
    partHeaders("text/plain; charset=UTF-8"),
    "",
    foldBase64(encodeBase64(plainBytes)),
    `--${altBoundary}`,
    partHeaders("text/html; charset=UTF-8"),
    "",
    foldBase64(encodeBase64(htmlBytes)),
    `--${altBoundary}--`,
  ].join(CRLF);
}

function buildAttachmentPart(att: MimeAttachment, mixedBoundary: string): string {
  const disp = att.disposition || (att.contentId ? "inline" : "attachment");
  const extra: string[] = [`Content-Disposition: ${disp}; filename="${att.filename.replace(/"/g, "'")}"`];
  if (att.contentId) {
    extra.push(`Content-ID: <${att.contentId}>`);
  }
  return [
    `--${mixedBoundary}`,
    partHeaders(att.mimeType || "application/octet-stream", extra.join(CRLF)),
    "",
    foldBase64(encodeBase64(att.content)),
  ].join(CRLF);
}

/** Strip script tags and on* handlers from HTML before send. */
export function sanitizeHtmlForEmail(html: string): string {
  let out = html;
  out = out.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  out = out.replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  out = out.replace(/javascript:/gi, "");
  return out;
}

export function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildMimeMessage(params: BuildMimeParams): { raw: string; byteLength: number } {
  const subj = singleLine(params.subject).slice(0, 500);
  const plain = params.plainBody || htmlToPlainText(params.htmlBody || "");
  const html = params.htmlBody
    ? sanitizeHtmlForEmail(params.htmlBody)
    : plain.replace(/\n/g, "<br>");

  const headers: string[] = [
    params.to.length ? `To: ${params.to.join(", ")}` : "",
    params.cc?.length ? `Cc: ${params.cc.join(", ")}` : "",
    params.bcc?.length ? `Bcc: ${params.bcc.join(", ")}` : "",
    `From: ${params.from}`,
    `Subject: ${subj}`,
    "MIME-Version: 1.0",
  ].filter(Boolean);

  if (params.inReplyTo) headers.push(`In-Reply-To: ${params.inReplyTo}`);
  if (params.references) headers.push(`References: ${params.references}`);

  const attachments = params.attachments || [];
  const altBoundary = boundary();
  const altPart = buildAlternativePart(plain, html, altBoundary);

  let body: string;
  if (attachments.length === 0) {
    headers.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    body = [headers.join(CRLF), "", altPart].join(CRLF);
  } else {
    const mixedBoundary = boundary();
    headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
    const parts = [
      `--${mixedBoundary}`,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      "",
      altPart,
      ...attachments.map((a) => buildAttachmentPart(a, mixedBoundary)),
      `--${mixedBoundary}--`,
    ];
    body = [headers.join(CRLF), "", parts.join(CRLF)].join(CRLF);
  }

  const byteLength = new TextEncoder().encode(body).length;
  if (byteLength > MAX_MESSAGE_BYTES) {
    throw new Error(`Message too large (${byteLength} bytes, max ${MAX_MESSAGE_BYTES})`);
  }
  return { raw: body, byteLength };
}

export function parseEmailList(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input
      .map((x) => String(x ?? "").trim())
      .filter((e) => e.length > 0);
  }
  if (typeof input === "string" && input.trim()) {
    return input.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

export function isReasonableEmail(s: string): boolean {
  const t = s.trim();
  if (t.length < 3 || t.length > 320) return false;
  return /^[^\s<>"']+@[^\s<>"']+\.[^\s<>"']+$/.test(t);
}
