import type { AdvisorToolModule, ToolContext } from "../../context.ts";
import { makeCompoundProposal, newProposalId } from "../shared.ts";
import { optionalString, parseIsoDate } from "../../utils.ts";

function defaultKickoffStart(): string {
  const d = new Date();
  const day = d.getUTCDay();
  const daysUntilTuesday = (2 - day + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + daysUntilTuesday);
  d.setUTCHours(10, 0, 0, 0);
  return d.toISOString();
}

export const proposeClientOnboardingTool: AdvisorToolModule = {
  name: "propose_client_onboarding",
  definition: {
    name: "propose_client_onboarding",
    description:
      "Propose client onboarding: add CRM client, schedule kickoff meeting, add welcome-packet task. Multi-step; one confirmation.",
    input_schema: {
      type: "object",
      properties: {
        company_name: { type: "string" },
        contact_name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        kickoff_start_iso: { type: "string" },
        kickoff_duration_min: { type: "number" },
        welcome_task_title: { type: "string" },
      },
      required: ["company_name"],
    },
  },
  async execute(input, ctx) {
    const companyName = optionalString(input.company_name, 200);
    if (!companyName) return { error: "company_name is required." };

    const clientId = newProposalId();
    const startIso = parseIsoDate(input.kickoff_start_iso) || defaultKickoffStart();
    const dur = typeof input.kickoff_duration_min === "number" ? input.kickoff_duration_min : 60;
    const endIso = new Date(new Date(startIso).getTime() + dur * 60_000).toISOString();
    const welcomeTitle =
      optionalString(input.welcome_task_title, 300) || `Send welcome packet to ${companyName}`;

    const steps = [
      {
        id: "create_client",
        type: "client.create",
        label: `Add client: ${companyName}`,
        payload: {
          id: clientId,
          company_name: companyName,
          contact_name: optionalString(input.contact_name, 200) || "",
          email: optionalString(input.email, 200) || null,
          phone: optionalString(input.phone, 64) || null,
          status: "Lead",
        },
      },
      {
        id: "kickoff",
        type: "appointment.create",
        label: `Kickoff meeting with ${companyName}`,
        payload: {
          title: `Kickoff with ${companyName}`,
          start_time: startIso,
          end_time: endIso,
          client_id: { ref: "step.create_client.id" },
          color: "blue",
        },
      },
      {
        id: "welcome_task",
        type: "task.create",
        label: welcomeTitle,
        payload: {
          title: welcomeTitle,
          body: "",
          due_at: endIso,
          client_id: { ref: "step.create_client.id" },
        },
      },
    ];

    const human =
      `**Onboard ${companyName}**:\n\n` +
      `1. Add client to CRM\n` +
      `2. Schedule kickoff — ${new Date(startIso).toLocaleString()}\n` +
      `3. Add task: **${welcomeTitle}**\n\n` +
      `Confirm once to run all three steps.`;

    const voice = `Onboard ${companyName}: add client, kickoff meeting, and welcome packet task. Say yes to confirm.`;

    return makeCompoundProposal("client_onboarding", steps, human, voice);
  },
};
