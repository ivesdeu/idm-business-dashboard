import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

type AdvisorTask = "daily_brief" | "followup_draft" | "variance_explain" | "weekly_recap" | "general";

type RequestBody = {
  task?: AdvisorTask;
  message?: string;
  context?: Record<string, unknown>;
  constraints?: Record<string, unknown>;
  healthCheck?: boolean;
};

type CrmProposal = {
  companyName: string;
  contactName?: string;
  email?: string;
  phone?: string;
  notes?: string;
  status?: string;
  industry?: string;
  confidence?: "high" | "low";
};

const ANTHROPIC_MODEL = "claude-opus-4-6";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function normalizeTask(task?: string): AdvisorTask {
  if (!task) return "general";
  if (task === "daily_brief" || task === "followup_draft" || task === "variance_explain" || task === "weekly_recap") return task;
  return "general";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function clampText(v: unknown, max: number) {
  const s = String(v ?? "").trim();
  return s.length > max ? s.slice(0, max) : s;
}

function parseCrmProposal(value: unknown): CrmProposal | null {
  if (!isRecord(value)) return null;
  const allowed = new Set(["companyName", "contactName", "email", "phone", "notes", "status", "industry", "confidence"]);
  const keys = Object.keys(value);
  if (keys.some((k) => !allowed.has(k))) return null;
  const companyName = clampText(value.companyName, 200);
  if (!companyName) return null;
  const out: CrmProposal = { companyName };
  const contactName = clampText(value.contactName, 200);
  const email = clampText(value.email, 320);
  const phone = clampText(value.phone, 80);
  const notes = clampText(value.notes, 4000);
  const status = clampText(value.status, 120);
  const industry = clampText(value.industry, 120);
  if (contactName) out.contactName = contactName;
  if (email) out.email = email;
  if (phone) out.phone = phone;
  if (notes) out.notes = notes;
  if (status) out.status = status;
  if (industry) out.industry = industry;
  if (value.confidence === "high" || value.confidence === "low") out.confidence = value.confidence;
  return out;
}

function buildStubPayload(task: AdvisorTask, message: string, context?: Record<string, unknown>) {
  const wantsCrm = /\b(add|create|save|insert)\b.*\b(crm|client|contact)\b|\bcrm\b.*\b(add|create|save|insert)\b/i.test(message);
  const ctxContact = isRecord(context?.contactRequest) ? context?.contactRequest : null;
  const stubProposal =
    wantsCrm && ctxContact
      ? parseCrmProposal({
          companyName: ctxContact.companyName || "New contact",
          contactName: ctxContact.contactName || "",
          email: ctxContact.email || "",
          phone: ctxContact.phone || "",
          notes: ctxContact.notes || "Added from contact request via Advisor.",
          status: "Lead",
          confidence: "high",
        })
      : null;
  switch (task) {
    case "daily_brief":
      return {
        title: "Daily action brief (stub)",
        bullets: [
          "Review top overdue invoices and schedule priority outreach.",
          "Follow up with clients lacking recent touchpoints.",
          "Check expense anomalies before end-of-day close.",
        ],
        actions: [
          { id: "review-overdue", label: "Review overdue invoices" },
          { id: "queue-followups", label: "Queue follow-ups" },
        ],
        meta: { provider: "stub", apiConnected: false },
      };
    case "followup_draft":
      return {
        title: "Follow-up draft (stub)",
        bullets: [
          "Channel: use the client's preferred communication method.",
          "Keep message concise and outcome-focused.",
        ],
        draft:
          "Hi {{client_name}}, quick check-in from our side. We are aligned on the next milestone and can move forward this week. Would {{day_option}} work for a 15-minute sync?",
        actions: [{ id: "mark-draft-used", label: "Mark draft used" }],
        meta: { provider: "stub", apiConnected: false },
      };
    case "variance_explain":
      return {
        title: "Variance explanation (stub)",
        bullets: [
          "Net profit changed month-over-month due to a shift in revenue mix and expense timing.",
          "Top deltas should be validated against software, advertising, and labor categories.",
          "Prioritize one corrective action: reduce the largest discretionary cost bucket.",
        ],
        actions: [{ id: "open-variance-report", label: "Open variance report" }],
        meta: { provider: "stub", apiConnected: false },
      };
    case "weekly_recap":
      return {
        title: "Weekly recap (stub)",
        bullets: [
          "Summarize wins, risks, and top priorities for next week.",
          "Highlight invoice collections and follow-up completion.",
          "Confirm one measurable objective for the coming week.",
        ],
        actions: [{ id: "save-recap", label: "Save recap" }],
        meta: { provider: "stub", apiConnected: false },
      };
    default:
      return {
        title: "Advisor scaffold response",
        bullets: [
          "The AI provider is not connected yet.",
          "Task routing and response contracts are active.",
          "Use a specific task for richer structured output.",
        ],
        draft: message ? `Received request: "${message.slice(0, 220)}"` : "",
        crmProposal: stubProposal,
        meta: { provider: "stub", apiConnected: false },
      };
  }
}

function taskInstruction(task: AdvisorTask) {
  switch (task) {
    case "daily_brief":
      return "Create a concise daily action brief with prioritized operational actions.";
    case "followup_draft":
      return "Create a practical client follow-up draft and supporting bullets.";
    case "variance_explain":
      return "Explain variance with likely drivers and one concrete corrective action.";
    case "weekly_recap":
      return "Generate a concise weekly recap with wins, risks, and next priorities.";
    default:
      return "Provide a concise advisor response with actionable guidance.";
  }
}

async function callAnthropic(
  anthropicApiKey: string,
  task: AdvisorTask,
  message: string,
  context: Record<string, unknown> | undefined,
  constraints: Record<string, unknown> | undefined,
) {
  const systemPrompt =
    "You are a business advisor assistant for a dashboard app. " +
    "Return ONLY valid JSON with this exact shape: " +
    '{"title":"string","bullets":["string"],"actions":[{"id":"string","label":"string"}],"draft":"string","crmProposal":{"companyName":"string","contactName":"string","email":"string","phone":"string","notes":"string","status":"string","industry":"string","confidence":"high|low"},"meta":{"provider":"anthropic","apiConnected":true}}. ' +
    "crmProposal is optional; include it only when the user asks to add/create a CRM contact or client. " +
    "Do not include markdown fences or extra text. Keep bullets <= 5.";

  const userPrompt =
    `Task: ${task}\n` +
    `Instruction: ${taskInstruction(task)}\n` +
    `User message: ${message}\n` +
    `Context JSON: ${JSON.stringify(context || {})}\n` +
    `Constraints JSON: ${JSON.stringify(constraints || {})}\n`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Anthropic error ${resp.status}: ${txt.slice(0, 500)}`);
  }

  const data = await resp.json();
  const contentArr = Array.isArray(data?.content) ? data.content : [];
  const textPart = contentArr.find((p: { type?: string }) => p && p.type === "text");
  const rawText = String(textPart?.text || "").trim();
  if (!rawText) throw new Error("Anthropic returned empty content.");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    // Defensive parse fallback for occasional wrapped responses.
    const firstBrace = rawText.indexOf("{");
    const lastBrace = rawText.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error("Anthropic response is not valid JSON.");
    }
    parsed = JSON.parse(rawText.slice(firstBrace, lastBrace + 1));
  }

  const title = String(parsed.title || "Advisor response");
  const bullets = Array.isArray(parsed.bullets)
    ? parsed.bullets.map((b) => String(b)).filter((b) => b.trim())
    : [];
  const actions = Array.isArray(parsed.actions)
    ? parsed.actions
        .map((a: Record<string, unknown>) => ({
          id: String(a?.id || ""),
          label: String(a?.label || ""),
        }))
        .filter((a) => a.id && a.label)
    : [];
  const draft = String(parsed.draft || "");
  const crmProposal = parseCrmProposal(parsed.crmProposal);

  return {
    title,
    bullets: bullets.slice(0, 5),
    actions: actions.slice(0, 4),
    draft,
    crmProposal,
    meta: { provider: "anthropic", apiConnected: true },
  };
}

async function probeAnthropic(anthropicApiKey: string) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 8,
      messages: [{ role: "user", content: "healthcheck" }],
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Anthropic probe failed ${resp.status}: ${txt.slice(0, 300)}`);
  }
  return true;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse(405, { error: "Method not allowed. Use POST." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseAnonKey) {
    return jsonResponse(500, { error: "Missing required env vars. Expected SUPABASE_URL and SUPABASE_ANON_KEY." });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse(401, { error: "Missing Authorization header." });

  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body." });
  }

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return jsonResponse(401, { error: "Invalid or expired auth token." });

  const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (body.healthCheck === true) {
    if (!anthropicApiKey) {
      return jsonResponse(200, {
        ok: true,
        health: {
          auth: true,
          apiConnected: false,
          providerReachable: false,
          provider: "anthropic",
          reason: "ANTHROPIC_API_KEY is not set.",
        },
      });
    }
    try {
      await probeAnthropic(anthropicApiKey);
      return jsonResponse(200, {
        ok: true,
        health: {
          auth: true,
          apiConnected: true,
          providerReachable: true,
          provider: "anthropic",
        },
      });
    } catch (err) {
      const details = err instanceof Error ? err.message : "Unknown provider probe error";
      return jsonResponse(200, {
        ok: true,
        health: {
          auth: true,
          apiConnected: true,
          providerReachable: false,
          provider: "anthropic",
          details,
        },
      });
    }
  }

  const task = normalizeTask(body.task);
  const message = String(body.message || "").trim();
  if (!message) return jsonResponse(400, { error: "message is required." });
  const context = body.context && typeof body.context === "object" ? body.context : {};
  const constraints = body.constraints && typeof body.constraints === "object" ? body.constraints : {};
  if (!anthropicApiKey) {
    const stub = buildStubPayload(task, message, context);
    return jsonResponse(200, stub);
  }

  try {
    const payload = await callAnthropic(anthropicApiKey, task, message, context, constraints);
    return jsonResponse(200, payload);
  } catch (err) {
    const details = err instanceof Error ? err.message : "Unknown Anthropic error";
    const fallback = buildStubPayload(task, message, context);
    return jsonResponse(200, {
      ...fallback,
      meta: {
        provider: "stub",
        apiConnected: true,
        degraded: true,
      },
      error: "Provider call failed; returned stub payload.",
      details,
    });
  }
});
