import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type OrgRosterEntry = {
  user_id: string;
  display_name: string;
  email: string;
};

export type LastEntities = {
  appointmentId?: string;
  clientId?: string;
  transactionId?: string;
  meetingNoteId?: string;
};

export type ToolContext = {
  supabase: SupabaseClient;
  orgId: string;
  userId: string;
  userDisplayName: string;
  userEmail: string;
  effectiveTimezone: string;
  roster: OrgRosterEntry[];
  lastEntities?: LastEntities;
  /** Forwarded user JWT for calling other edge functions (e.g. google-calendar-events). */
  authHeader?: string;
  supabaseUrl?: string;
  anonKey?: string;
};

export type AdvisorProposal = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  summary_human: string;
  summary_voice: string;
};

export type AdvisorToolModule = {
  name: string;
  definition: AnthropicToolDefinition;
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
};

/** Minimal Anthropic tool schema shape (messages API). */
export type AnthropicToolDefinition = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};
