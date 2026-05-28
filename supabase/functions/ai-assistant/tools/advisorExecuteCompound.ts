import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { ToolContext } from "./context.ts";
import type { AdvisorExecuteResult } from "./advisorExecute.ts";
import { executeAppointmentAction } from "./writes/appointments.ts";
import { executeCalendarSyncAction } from "./writes/calendarSync.ts";
import { executeClientAction } from "./writes/clients.ts";
import { executeMeetingNoteAction } from "./writes/meetingNotes.ts";
import { executeTaskAction } from "./writes/tasks.ts";
import { executeTransactionAction } from "./writes/transactions.ts";
import {
  type CompoundStep,
  type StepOutputBag,
  newProposalId,
  resolveStepRefs,
} from "./writes/shared.ts";

export type CompoundStepResult = {
  id: string;
  label: string;
  type: string;
  status: "ok" | "error" | "skipped_due_to_error" | "not_run";
  result?: Record<string, unknown>;
  error?: string;
};

async function tryInsertWorkflowRun(
  supabase: SupabaseClient,
  orgId: string,
  userId: string,
  idempotencyKey: string,
  triggerPayload: Record<string, unknown>,
): Promise<{ runId: string | null; duplicate: boolean }> {
  const runId = newProposalId();
  const row = {
    id: runId,
    user_id: userId,
    organization_id: orgId,
    rule_id: null,
    idempotency_key: idempotencyKey,
    trigger_payload: triggerPayload,
    status: "running",
    step_results: [],
  };
  const { error } = await supabase.from("workflow_runs").insert(row);
  if (error) {
    if (String(error.message || "").toLowerCase().includes("duplicate")) {
      const { data } = await supabase
        .from("workflow_runs")
        .select("id, status, step_results, trigger_payload, error")
        .eq("organization_id", orgId)
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      if (data) {
        return { runId: String(data.id), duplicate: true };
      }
      return { runId: null, duplicate: true };
    }
    return { runId: null, duplicate: false };
  }
  return { runId, duplicate: false };
}

async function finishWorkflowRun(
  supabase: SupabaseClient,
  orgId: string,
  runId: string | null,
  status: string,
  stepResults: CompoundStepResult[],
  errorMsg?: string,
): Promise<void> {
  if (!runId) return;
  await supabase
    .from("workflow_runs")
    .update({
      status,
      error: errorMsg || null,
      step_results: stepResults,
    })
    .eq("id", runId)
    .eq("organization_id", orgId);
}

async function dispatchStep(
  step: CompoundStep,
  payload: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string; client_action?: string }> {
  const type = step.type;
  if (type === "calendar.sync") {
    return executeCalendarSyncAction(payload, ctx);
  }
  if (type.startsWith("appointment.")) {
    return executeAppointmentAction(type, payload, ctx);
  }
  if (type.startsWith("task.")) {
    return executeTaskAction(type, payload, ctx);
  }
  if (type.startsWith("client.")) {
    return executeClientAction(type, payload, ctx);
  }
  if (type.startsWith("meeting_note.")) {
    return executeMeetingNoteAction(type, payload, ctx);
  }
  if (type.startsWith("transaction.")) {
    return executeTransactionAction(type, payload, ctx);
  }
  return { ok: false, error: `Unknown step type: ${type}` };
}

function buildSummary(steps: CompoundStepResult[]): { human: string; voice: string } {
  const okCount = steps.filter((s) => s.status === "ok").length;
  const fail = steps.filter((s) => s.status === "error");
  const lines = steps.map((s) => {
    const icon = s.status === "ok" ? "✓" : s.status === "error" ? "✗" : "–";
    const detail = s.status === "error" ? ` (${s.error || "failed"})` : "";
    return `${icon} ${s.label}${detail}`;
  });
  const human =
    okCount === steps.length
      ? `All **${steps.length}** steps completed:\n\n${lines.join("\n")}`
      : `Completed **${okCount}/${steps.length}** steps:\n\n${lines.join("\n")}` +
        (fail.length ? "\n\nUse **Retry** on failed steps below." : "");
  const voice =
    okCount === steps.length
      ? `All ${steps.length} steps completed.`
      : `${okCount} of ${steps.length} steps completed.` +
        (fail.length ? ` ${fail[0].label} failed.` : "");
  return { human, voice };
}

export async function runAdvisorExecuteCompound(
  ctx: ToolContext,
  compoundType: string,
  steps: CompoundStep[],
  proposalId: string,
): Promise<
  AdvisorExecuteResult & {
    steps?: CompoundStepResult[];
    workflow_run_id?: string | null;
    client_action?: string;
  }
> {
  const { runId, duplicate } = await tryInsertWorkflowRun(ctx.supabase, ctx.orgId, ctx.userId, proposalId, {
    source: "advisor",
    compound_type: compoundType,
    steps,
  });

  if (duplicate && runId) {
    const { data: existing } = await ctx.supabase
      .from("workflow_runs")
      .select("step_results, status, error")
      .eq("id", runId)
      .eq("organization_id", ctx.orgId)
      .maybeSingle();
    const prior = (existing?.step_results as CompoundStepResult[] | undefined) || [];
    const sum = buildSummary(prior);
    return {
      ok: existing?.status === "success" || existing?.status === "partial",
      summary_human: `This action was already run.\n\n${sum.human}`,
      summary_voice: sum.voice,
      steps: prior,
      workflow_run_id: runId,
      result: { workflow_run_id: runId, idempotent_replay: true },
    };
  }

  const outputs: StepOutputBag = {};
  const stepResults: CompoundStepResult[] = [];
  let aborted = false;
  let lastClientAction: string | undefined;

  for (const step of steps) {
    if (aborted) {
      stepResults.push({
        id: step.id,
        label: step.label,
        type: step.type,
        status: "not_run",
      });
      continue;
    }

    const resolvedPayload = resolveStepRefs(step.payload, outputs) as Record<string, unknown>;
    const exec = await dispatchStep(step, resolvedPayload, ctx);

    if (exec.ok && exec.result) {
      outputs[step.id] = exec.result;
      if (exec.result.appointment_id) outputs[step.id].appointment_id = exec.result.appointment_id;
      if (exec.result.client_id) outputs[step.id].client_id = exec.result.client_id;
      if (exec.result.id && step.type.startsWith("client.")) {
        outputs[step.id].client_id = exec.result.id;
      }
      if (exec.result.id && step.type.startsWith("meeting_note.")) {
        outputs[step.id].meeting_note_id = exec.result.id;
      }
      stepResults.push({
        id: step.id,
        label: step.label,
        type: step.type,
        status: "ok",
        result: exec.result,
      });
      if (exec.client_action) lastClientAction = exec.client_action;
    } else if (step.optional) {
      stepResults.push({
        id: step.id,
        label: step.label,
        type: step.type,
        status: "skipped_due_to_error",
        error: exec.error,
      });
    } else {
      stepResults.push({
        id: step.id,
        label: step.label,
        type: step.type,
        status: "error",
        error: exec.error,
      });
      aborted = true;
    }
  }

  const okCount = stepResults.filter((s) => s.status === "ok").length;
  const hasError = stepResults.some((s) => s.status === "error");
  const runStatus = hasError ? (okCount > 0 ? "partial" : "error") : "success";
  const sum = buildSummary(stepResults);

  await finishWorkflowRun(ctx.supabase, ctx.orgId, runId, runStatus, stepResults, hasError ? sum.human : undefined);

  const mergedResult: Record<string, unknown> = {
    workflow_run_id: runId,
    compound_type: compoundType,
  };
  for (const s of stepResults) {
    if (s.status === "ok" && s.result) {
      if (s.result.appointment_id) mergedResult.appointment_id = s.result.appointment_id;
      if (s.result.client_id) mergedResult.client_id = s.result.client_id;
      if (s.result.meeting_note_id) mergedResult.meeting_note_id = s.result.meeting_note_id;
      if (s.result.id && s.type.startsWith("meeting_note.")) mergedResult.meeting_note_id = s.result.id;
    }
  }

  return {
    ok: okCount > 0 && !hasError ? true : okCount > 0,
    summary_human: sum.human,
    summary_voice: sum.voice,
    result: mergedResult,
    steps: stepResults,
    workflow_run_id: runId,
    client_action: lastClientAction,
    error: hasError ? "One or more steps failed." : undefined,
  };
}
