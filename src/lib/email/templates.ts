import type { EmailTemplate } from './types';
import { getOrgId, getSupabase, isDemoUser } from './session';

export async function fetchEmailTemplates(): Promise<EmailTemplate[]> {
  const supa = getSupabase();
  const orgId = getOrgId();
  if (!supa || !orgId || isDemoUser()) return [];
  const { data, error } = await supa
    .from('app_settings')
    .select('dashboard_settings')
    .eq('organization_id', orgId)
    .maybeSingle();
  if (error || !data?.dashboard_settings) return [];
  const dash = data.dashboard_settings as { email_templates?: EmailTemplate[] };
  return Array.isArray(dash.email_templates) ? dash.email_templates : [];
}

export async function saveEmailTemplate(template: Omit<EmailTemplate, 'id' | 'updated_at'> & { id?: string }): Promise<EmailTemplate | null> {
  const supa = getSupabase();
  const orgId = getOrgId();
  if (!supa || !orgId || isDemoUser()) return null;

  const { data: row, error: fetchErr } = await supa
    .from('app_settings')
    .select('dashboard_settings, project_statuses')
    .eq('organization_id', orgId)
    .maybeSingle();
  if (fetchErr) return null;

  const dash =
    row?.dashboard_settings && typeof row.dashboard_settings === 'object'
      ? { ...(row.dashboard_settings as Record<string, unknown>) }
      : {};
  const list = Array.isArray((dash as { email_templates?: EmailTemplate[] }).email_templates)
    ? [...((dash as { email_templates: EmailTemplate[] }).email_templates)]
    : [];

  const id = template.id || `et_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  const entry: EmailTemplate = {
    id,
    name: template.name,
    subject: template.subject,
    body: template.body,
    to: template.to,
    updated_at: new Date().toISOString(),
  };
  const idx = list.findIndex((t) => t.id === id);
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  while (list.length > 50) list.shift();
  (dash as { email_templates: EmailTemplate[] }).email_templates = list;

  const { error } = await supa.from('app_settings').upsert(
    {
      organization_id: orgId,
      project_statuses: row?.project_statuses ?? [],
      dashboard_settings: dash,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id' },
  );
  if (error) return null;
  return entry;
}

export async function deleteEmailTemplate(templateId: string): Promise<boolean> {
  const supa = getSupabase();
  const orgId = getOrgId();
  if (!supa || !orgId) return false;

  const { data: row } = await supa
    .from('app_settings')
    .select('dashboard_settings, project_statuses')
    .eq('organization_id', orgId)
    .maybeSingle();
  if (!row?.dashboard_settings) return false;

  const dash = { ...(row.dashboard_settings as Record<string, unknown>) };
  const list = Array.isArray((dash as { email_templates?: EmailTemplate[] }).email_templates)
    ? (dash as { email_templates: EmailTemplate[] }).email_templates.filter((t) => t.id !== templateId)
    : [];
  (dash as { email_templates: EmailTemplate[] }).email_templates = list;

  const { error } = await supa.from('app_settings').upsert(
    {
      organization_id: orgId,
      project_statuses: row.project_statuses ?? [],
      dashboard_settings: dash,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id' },
  );
  return !error;
}
