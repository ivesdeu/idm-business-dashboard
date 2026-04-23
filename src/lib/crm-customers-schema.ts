/** Shared CRM customers table schema (legacy JS + React island). */

export type CrmPillColorKey =
  | 'gray'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink';

export type CrmFieldKind =
  | 'title'
  | 'text'
  | 'select'
  | 'status'
  | 'priority'
  | 'number'
  | 'date'
  | 'checkbox'
  | 'multi_select'
  | 'readonly';

export type CrmColumnDef = {
  id: string;
  label: string;
  index: number;
  fieldKind: CrmFieldKind;
  /** Legacy name; maps to fieldKind when present */
  cellType?: string;
  fieldKey: string | null;
  editable: boolean;
  locked?: boolean;
  /** When true, column is off until the user enables it in Columns (reduces default table width). */
  defaultHidden?: boolean;
  selectKey?: string;
};

export const CRM_PREF_CHANNEL_OPTS = ['Email', 'Phone', 'Slack', 'In-person', 'Text', 'Other'] as const;

export const CRM_COMM_STYLE_OPTS = ['Concise', 'Detailed', 'Formal', 'Casual', 'Direct'] as const;

export const CRM_PRIORITY_OPTS = ['Low', 'Medium', 'High'] as const;

const STATUS_BASE = ['Lead', 'Active', 'Inactive', 'Churned'] as const;

export function crmStatusSelectOptionsFromProjects(projectStatuses: string[]): string[] {
  const seen: Record<string, true> = {};
  const out: string[] = [];
  for (const s of STATUS_BASE) {
    if (s && !seen[s]) {
      seen[s] = true;
      out.push(s);
    }
  }
  for (const s of projectStatuses || []) {
    if (s && !seen[s]) {
      seen[s] = true;
      out.push(s);
    }
  }
  return out;
}

export function selectOptionsForColumn(def: CrmColumnDef, projectStatuses: string[]): string[] {
  if (!def.selectKey) return [];
  if (def.selectKey === 'preferred') return [...CRM_PREF_CHANNEL_OPTS];
  if (def.selectKey === 'style') return [...CRM_COMM_STYLE_OPTS];
  if (def.selectKey === 'status') return crmStatusSelectOptionsFromProjects(projectStatuses);
  if (def.selectKey === 'priority') return [...CRM_PRIORITY_OPTS];
  return [];
}

/** When no color stored in dashboard_settings.crmOptionColors */
export function defaultPillColorForOption(selectKey: string, label: string): CrmPillColorKey {
  const t = String(label || '').trim().toLowerCase();
  if (selectKey === 'priority') {
    if (t === 'high') return 'red';
    if (t === 'medium') return 'orange';
    if (t === 'low') return 'green';
    return 'gray';
  }
  if (selectKey === 'status') {
    if (/\b(done|closed|won|complete)\b/.test(t) || t === 'inactive') return 'green';
    if (/\b(progress|active|working)\b/.test(t)) return 'blue';
    if (/\b(block|churn|lost|cancel)\b/.test(t)) return 'red';
    if (/\b(not\s*started|lead|draft|new)\b/.test(t)) return 'gray';
    return 'blue';
  }
  if (selectKey === 'preferred') {
    if (t.includes('slack')) return 'purple';
    if (t.includes('email')) return 'blue';
    if (t.includes('phone') || t.includes('text')) return 'green';
    return 'gray';
  }
  if (selectKey === 'style') {
    if (t.includes('formal')) return 'purple';
    if (t.includes('casual')) return 'yellow';
    return 'gray';
  }
  return 'gray';
}

function fk(
  id: string,
  label: string,
  index: number,
  fieldKind: CrmFieldKind,
  fieldKey: string | null,
  editable: boolean,
  extra: Partial<CrmColumnDef> = {},
): CrmColumnDef {
  const cellType: string =
    fieldKind === 'title'
      ? 'title'
      : fieldKind === 'readonly'
        ? 'readonly'
        : fieldKind === 'text'
          ? 'text'
          : fieldKind === 'select' || fieldKind === 'status' || fieldKind === 'priority'
            ? 'select'
            : fieldKind === 'number'
              ? 'number'
              : fieldKind === 'date'
                ? 'date'
                : fieldKind === 'checkbox'
                  ? 'checkbox'
                  : 'text';
  return Object.assign(
    {
      id,
      label,
      index,
      fieldKind,
      cellType,
      fieldKey,
      editable,
    },
    extra,
  ) as CrmColumnDef;
}

export const CUSTOMERS_COLUMN_DEFS: CrmColumnDef[] = [
  fk('company', 'Company', 1, 'title', 'companyName', true),
  fk('contact', 'Contact', 2, 'text', 'contactName', true),
  fk('email', 'Email', 3, 'text', 'email', true),
  fk('phone', 'Phone', 4, 'text', 'phone', true, { defaultHidden: true }),
  fk('preferred', 'Preferred', 5, 'select', 'preferredChannel', true, { selectKey: 'preferred', defaultHidden: true }),
  fk('style', 'Style', 6, 'select', 'communicationStyle', true, { selectKey: 'style', defaultHidden: true }),
  fk('status', 'Status', 7, 'status', 'status', true, { selectKey: 'status' }),
  fk('priority', 'Priority', 8, 'priority', 'priority', true, { selectKey: 'priority', defaultHidden: true }),
  fk('projects', 'Projects', 9, 'readonly', null, false, { defaultHidden: true }),
  fk('revenue', 'Revenue', 10, 'readonly', null, false),
  fk('allocated', 'Allocated cost', 11, 'readonly', null, false),
  fk('profit', 'Profit', 12, 'readonly', null, false),
  fk('margin', 'Margin', 13, 'readonly', null, false),
  fk('roi', 'ROI', 14, 'readonly', null, false),
  fk('updated', 'Updated', 15, 'readonly', 'updatedAt', false, { defaultHidden: true }),
  fk('actions', 'Actions', 16, 'readonly', null, false, { locked: true }),
];

export type CrmOptionColors = Partial<Record<string, Record<string, CrmPillColorKey>>>;
