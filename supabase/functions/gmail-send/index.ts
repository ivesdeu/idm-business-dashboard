import { serveWithEdgeRequestLogging } from "../_shared/withEdgeRequestLogging.ts";
import { encodeBase64Url } from "https://deno.land/std@0.224.0/encoding/base64url.ts";
import { createClient } from "npm:@supabase/supabase-js@2.101.1";
import { corsHeadersFor } from "../_shared/cors.ts";
import { edgeLog } from "../_shared/edgeLog.ts";
import { resolveOrganizationId } from "../_shared/orgContext.ts";
import { getGoogleAccessTokenForUserOrg } from "../_shared/googleAccessToken.ts";
import {
  buildMimeMessage,
  htmlToPlainText,
  isReasonableEmail,
  parseEmailList,
  type MimeAttachment,
} from "../_shared/rfc2822Mime.ts";

const MAX_SUBJECT = 500;
const MAX_BODY = 256_000;
const MAX_RECIPIENTS = 50;
const MAX_ATTACHMENTS = 20;

function json(req: Request, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

function validateEmails(list: string[], label: string): string | null {
  if (list.length > MAX_RECIPIENTS) return `Too many ${label} recipients`;
  for (const e of list) {
    if (!isReasonableEmail(e)) return `Invalid ${label} address: ${e}`;
  }
  return null;
}

/** Legacy plain-text-only builder for backward compatibility. */
function buildRfc2822Plain(params: { from: string; to: string; subject: string; body: string }): string {
  const subj = params.subject.replace(/\r?\n/g, " ").trim().slice(0, MAX_SUBJECT);
  return [
    `To: ${params.to}`,
    `From: ${params.from}`,
    `Subject: ${subj}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    params.body,
  ].join("\r\n");
}

serveWithEdgeRequestLogging("gmail-send", async (req, ctx) => {
  const requestId = ctx.requestId;
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeadersFor(req) });
  }
  if (req.method !== "POST") {
    return json(req, 405, { error: "Method not allowed" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID")?.trim();
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")?.trim();
  if (!supabaseUrl || !anonKey || !serviceKey || !clientId || !clientSecret) {
    return json(req, 500, { error: "Server misconfiguration" });
  }

  const authHeader = req.headers.get("Authorization")?.trim() || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return json(req, 401, { error: "Missing Authorization" });
  }
  const jwt = authHeader.slice(7).trim();
  if (!jwt) {
    return json(req, 401, { error: "Missing Authorization" });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json(req, 400, { error: "Invalid JSON" });
  }

  const organizationIdRaw = body.organization_id != null ? String(body.organization_id).trim() : "";
  const subject = body.subject != null ? String(body.subject) : "";

  // Recipients: arrays or legacy single `to` string
  let toList = parseEmailList(body.to);
  if (!toList.length && body.to != null) {
    const single = String(body.to).trim();
    if (single) toList = [single];
  }
  const ccList = parseEmailList(body.cc);
  const bccList = parseEmailList(body.bcc);

  const htmlBody = body.html_body != null ? String(body.html_body) : "";
  const plainBody = body.body != null ? String(body.body) : (body.plain_body != null ? String(body.plain_body) : "");
  const textBody = plainBody || (htmlBody ? htmlToPlainText(htmlBody) : "");

  if (!toList.length) {
    return json(req, 400, { error: "At least one To address is required" });
  }
  const toErr = validateEmails(toList, "To");
  if (toErr) return json(req, 400, { error: toErr });
  const ccErr = validateEmails(ccList, "Cc");
  if (ccErr) return json(req, 400, { error: ccErr });
  const bccErr = validateEmails(bccList, "Bcc");
  if (bccErr) return json(req, 400, { error: bccErr });

  if (!subject.trim()) {
    return json(req, 400, { error: "Subject is required" });
  }
  if (!textBody.trim() && !htmlBody.trim()) {
    return json(req, 400, { error: "Body is required" });
  }
  if (subject.length > MAX_SUBJECT || textBody.length > MAX_BODY || htmlBody.length > MAX_BODY) {
    return json(req, 400, { error: "Subject or body too long" });
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const admin = createClient(supabaseUrl, serviceKey);

  const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !userData?.user?.id) {
    return json(req, 401, { error: userErr?.message || "Invalid session" });
  }
  const userId = userData.user.id;

  const orgId = await resolveOrganizationId(
    userClient,
    userId,
    organizationIdRaw || null,
  );
  if (!orgId) {
    edgeLog({
      fn: "gmail-send",
      level: "warn",
      action: "deny",
      requestId,
      userId,
      organizationId: organizationIdRaw || undefined,
      detail: "no organization membership for requested org",
    });
    return json(req, 403, { error: "No organization membership" });
  }

  const tokenResult = await getGoogleAccessTokenForUserOrg(
    admin,
    userId,
    orgId,
    clientId,
    clientSecret,
  );

  if (!tokenResult.ok) {
    if (tokenResult.code === "not_connected") {
      return json(req, 400, { error: "not_connected", detail: "Connect Google in Settings → Connections." });
    }
    return json(req, 502, {
      error: "token_refresh",
      detail: "Could not refresh Google access. Reconnect in Settings → Connections.",
    });
  }

  const access = tokenResult.accessToken;
  const meRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${access}` },
  });
  if (!meRes.ok) {
    return json(req, 502, { error: "userinfo", detail: "Could not resolve sender email." });
  }
  const meJson = (await meRes.json()) as { email?: string; name?: string };
  const fromEmail = meJson.email ? String(meJson.email).trim() : "";
  if (!fromEmail || !isReasonableEmail(fromEmail)) {
    return json(req, 502, { error: "userinfo", detail: "Missing sender email." });
  }

  // Load attachments from storage
  const attachmentInputs = Array.isArray(body.attachments) ? body.attachments : [];
  if (attachmentInputs.length > MAX_ATTACHMENTS) {
    return json(req, 400, { error: "Too many attachments" });
  }

  const mimeAttachments: MimeAttachment[] = [];
  for (const raw of attachmentInputs) {
    if (!raw || typeof raw !== "object") continue;
    const att = raw as Record<string, unknown>;
    const storagePath = att.storage_path != null ? String(att.storage_path).trim() : "";
    const filename = att.filename != null ? String(att.filename).trim() : "attachment";
    const mimeType = att.mime_type != null ? String(att.mime_type).trim() : "application/octet-stream";
    const contentId = att.content_id != null ? String(att.content_id).trim() : undefined;
    if (!storagePath) continue;

    // Path must be org/user scoped
    const parts = storagePath.split("/");
    if (parts[0] !== orgId || parts[1] !== userId) {
      return json(req, 403, { error: "Invalid attachment path" });
    }

    const { data: blob, error: dlErr } = await admin.storage.from("email-attachments").download(storagePath);
    if (dlErr || !blob) {
      return json(req, 400, { error: "attachment_missing", detail: filename });
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    mimeAttachments.push({
      filename,
      mimeType,
      content: bytes,
      contentId,
      disposition: contentId ? "inline" : "attachment",
    });
  }

  const inReplyTo = body.in_reply_to != null ? String(body.in_reply_to).trim() : undefined;
  const references = body.references != null ? String(body.references).trim() : undefined;
  const threadId = body.thread_id != null ? String(body.thread_id).trim() : "";

  let rfc: string;
  try {
    const useRich = htmlBody.trim().length > 0 || mimeAttachments.length > 0 || ccList.length > 0 || bccList.length > 0 || toList.length > 1;
    if (useRich) {
      const built = buildMimeMessage({
        from: fromEmail,
        to: toList,
        cc: ccList,
        bcc: bccList,
        subject,
        plainBody: textBody,
        htmlBody: htmlBody.trim() ? htmlBody : undefined,
        attachments: mimeAttachments,
        inReplyTo,
        references,
      });
      rfc = built.raw;
    } else {
      // Legacy single-recipient plain path
      rfc = buildRfc2822Plain({
        from: fromEmail,
        to: toList[0],
        subject,
        body: textBody,
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "MIME build failed";
    return json(req, 400, { error: "mime_build", detail: msg });
  }

  const raw = encodeBase64Url(new TextEncoder().encode(rfc));

  const sendPayload: Record<string, unknown> = { raw };
  if (threadId) sendPayload.threadId = threadId;

  const sendRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(sendPayload),
  });

  const sendJson = (await sendRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (!sendRes.ok) {
    const errObj = sendJson.error as { message?: string } | undefined;
    const msg = errObj?.message || JSON.stringify(sendJson).slice(0, 200);
    if (sendRes.status === 401 || sendRes.status === 403) {
      return json(req, 403, { error: "gmail_denied", detail: msg });
    }
    if (sendRes.status === 429) {
      return json(req, 429, { error: "rate_limited", detail: msg });
    }
    return json(req, 502, { error: "gmail_send_failed", detail: msg });
  }

  const id = sendJson.id != null ? String(sendJson.id) : "";
  const outThreadId = sendJson.threadId != null ? String(sendJson.threadId) : "";
  if (!id) {
    return json(req, 502, { error: "gmail_send_failed", detail: "Missing message id in response." });
  }

  return json(req, 200, { id, threadId: outThreadId });
});
