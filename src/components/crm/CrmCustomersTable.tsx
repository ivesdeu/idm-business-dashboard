import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, MoreHorizontal, SlidersHorizontal, Trash2 } from 'lucide-react';
import {
  CUSTOMERS_COLUMN_DEFS,
  defaultPillColorForOption,
  selectOptionsForColumn,
  type CrmColumnDef,
  type CrmOptionColors,
  type CrmPillColorKey,
} from '@/lib/crm-customers-schema';

const PILL_COLOR_ROWS: { key: CrmPillColorKey; label: string }[] = [
  { key: 'gray', label: 'Default' },
  { key: 'red', label: 'Red' },
  { key: 'orange', label: 'Orange' },
  { key: 'yellow', label: 'Yellow' },
  { key: 'green', label: 'Green' },
  { key: 'blue', label: 'Blue' },
  { key: 'purple', label: 'Purple' },
  { key: 'pink', label: 'Pink' },
];

const PILL_SWATCH: Record<CrmPillColorKey, string> = {
  gray: 'bg-stone-200',
  red: 'bg-red-400',
  orange: 'bg-orange-400',
  yellow: 'bg-amber-400',
  green: 'bg-emerald-500',
  blue: 'bg-sky-500',
  purple: 'bg-violet-500',
  pink: 'bg-pink-400',
};
import { cn } from '@/lib/utils';
import { SelectPill } from './SelectPill';

export type CrmTableRowVm = {
  id: string;
  draft: boolean;
  inserted: boolean;
  retainer: boolean;
  companyName: string;
  contactName: string;
  email: string;
  phone: string;
  preferredChannel: string;
  communicationStyle: string;
  status: string;
  priority: string;
  projects: string;
  revenue: string;
  allocated: string;
  profit: string;
  profitNegative: boolean;
  margin: string;
  roi: string;
  updated: string;
};

export type CrmCustomersTablePayload = {
  rows: CrmTableRowVm[];
  columnPrefs: Record<string, boolean>;
  optionColors: CrmOptionColors;
  projectStatuses: string[];
};

export type CrmTableFocusRequest = {
  rowId: string;
  colId: string;
  activate: boolean;
};

function colVisible(def: CrmColumnDef, prefs: Record<string, boolean>) {
  if (def.locked) return true;
  return prefs[def.id] !== false;
}

function visibleEditableColIds(prefs: Record<string, boolean>) {
  return CUSTOMERS_COLUMN_DEFS.filter((c) => c.editable && !c.locked && colVisible(c, prefs)).map((c) => c.id);
}

function valueForField(row: CrmTableRowVm, fieldKey: string): string {
  const map: Record<string, string> = {
    companyName: row.companyName,
    contactName: row.contactName,
    email: row.email,
    phone: row.phone,
    preferredChannel: row.preferredChannel,
    communicationStyle: row.communicationStyle,
    status: row.status,
    priority: row.priority,
  };
  return map[fieldKey] ?? '';
}

function resolvePillColor(
  selectKey: string,
  label: string,
  optionColors: CrmOptionColors,
): CrmPillColorKey {
  const from = optionColors[selectKey]?.[label];
  if (from) return from;
  return defaultPillColorForOption(selectKey, label);
}

function isSelectLike(def: CrmColumnDef) {
  return (
    def.fieldKind === 'select' ||
    def.fieldKind === 'status' ||
    def.fieldKind === 'priority'
  );
}

/** Rough workflow buckets for Notion-style status sections (order preserved within each). */
function statusWorkflowBucket(label: string): 'todo' | 'progress' | 'complete' {
  const t = String(label || '').trim().toLowerCase();
  if (t === 'lead' || t === 'draft' || t === 'new' || t === 'not started') return 'todo';
  if (
    t === 'inactive' ||
    t === 'churned' ||
    t === 'complete' ||
    t === 'done' ||
    t === 'closed' ||
    t === 'won'
  ) {
    return 'complete';
  }
  return 'progress';
}

function groupedSelectSections(
  selectKey: string,
  orderedOpts: string[],
  filtered: string[],
): { title: string; items: string[] }[] {
  const pick = new Set(filtered);
  const itemsInOrder = orderedOpts.filter((o) => pick.has(o));
  if (!itemsInOrder.length) return [];

  if (selectKey !== 'status') {
    return [{ title: '', items: itemsInOrder }];
  }

  const todo: string[] = [];
  const progress: string[] = [];
  const complete: string[] = [];
  for (const o of itemsInOrder) {
    const b = statusWorkflowBucket(o);
    if (b === 'todo') todo.push(o);
    else if (b === 'complete') complete.push(o);
    else progress.push(o);
  }

  const out: { title: string; items: string[] }[] = [];
  if (todo.length) out.push({ title: 'To-do', items: todo });
  if (progress.length) out.push({ title: 'In progress', items: progress });
  if (complete.length) out.push({ title: 'Complete', items: complete });
  return out;
}

function isCustomersPageActive() {
  const pg = document.getElementById('page-customers');
  return pg?.classList.contains('on') ?? false;
}

type CrmPillOptionEditorPopoverProps = {
  selectKey: string;
  optionLabel: string;
  projectStatuses: string[];
  optionColors: CrmOptionColors;
  left: number;
  top: number;
  onClose: () => void;
  onSetOptionColor: (selectKey: string, label: string, color: CrmPillColorKey) => Promise<boolean>;
  onRenameOption: (selectKey: string, oldLabel: string, newLabel: string) => Promise<{ ok: boolean; error?: string }>;
  onDeleteOption: (selectKey: string, label: string) => Promise<{ ok: boolean; error?: string }>;
};

function CrmPillOptionEditorPopover({
  selectKey,
  optionLabel,
  projectStatuses,
  optionColors,
  left,
  top,
  onClose,
  onSetOptionColor,
  onRenameOption,
  onDeleteOption,
}: CrmPillOptionEditorPopoverProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const allowRenameDelete = selectKey === 'status';
  const canDelete = allowRenameDelete && projectStatuses.includes(optionLabel);
  const [draftName, setDraftName] = useState(optionLabel);
  const [activeColor, setActiveColor] = useState<CrmPillColorKey>(() =>
    resolvePillColor(selectKey, optionLabel, optionColors),
  );
  const [renameError, setRenameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraftName(optionLabel);
    setRenameError(null);
  }, [optionLabel]);

  useEffect(() => {
    setActiveColor(resolvePillColor(selectKey, optionLabel, optionColors));
  }, [optionLabel, selectKey, optionColors]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => {
    const onMd = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest?.('[data-crm-table-portal]')) return;
      if (rootRef.current?.contains(el)) return;
      onClose();
    };
    document.addEventListener('mousedown', onMd, true);
    return () => document.removeEventListener('mousedown', onMd, true);
  }, [onClose]);

  const panelW = 248;
  const placedLeft = Math.min(Math.max(8, left), window.innerWidth - panelW - 8);
  const placedTop = Math.min(Math.max(8, top), window.innerHeight - 400);

  const applyRenameIfNeeded = async () => {
    if (!allowRenameDelete) return true;
    const next = draftName.trim();
    if (!next) {
      setRenameError('Name is required.');
      return false;
    }
    if (next === optionLabel) return true;
    setBusy(true);
    setRenameError(null);
    const res = await onRenameOption(selectKey, optionLabel, next);
    setBusy(false);
    if (!res.ok) {
      setRenameError(res.error || 'Could not rename.');
      return false;
    }
    return true;
  };

  const onPickColor = async (key: CrmPillColorKey) => {
    setBusy(true);
    const ok = await onSetOptionColor(selectKey, optionLabel, key);
    setBusy(false);
    if (ok) setActiveColor(key);
  };

  const onDelete = async () => {
    if (!canDelete) return;
    if (!window.confirm(`Remove status “${optionLabel}”? Clients and projects using it will move to Lead.`)) return;
    setBusy(true);
    const res = await onDeleteOption(selectKey, optionLabel);
    setBusy(false);
    if (!res.ok) {
      window.alert(res.error || 'Could not remove.');
      return;
    }
    onClose();
  };

  return createPortal(
    <div
      ref={rootRef}
      data-crm-pill-edit-popover
      className="fixed z-[310] w-[248px] rounded-xl border border-neutral-200/80 bg-white py-2 text-neutral-800 shadow-[0_12px_48px_-10px_rgba(15,15,15,0.2),0_0_0_1px_rgba(0,0,0,0.04)]"
      style={{ left: placedLeft, top: placedTop }}
      role="dialog"
      aria-label="Edit option"
    >
      <div className="px-3 pb-2">
        <input
          type="text"
          autoFocus
          readOnly={!allowRenameDelete}
          title={!allowRenameDelete ? 'Only Status options can be renamed.' : undefined}
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && allowRenameDelete) {
              e.preventDefault();
              void (async () => {
                const ok = await applyRenameIfNeeded();
                if (ok) onClose();
              })();
            }
          }}
          className={cn(
            'box-border w-full rounded-xl border px-2.5 py-2 text-[13px] outline-none ring-sky-500/30 focus:ring-2',
            allowRenameDelete ? 'border-sky-400/80 bg-white' : 'cursor-not-allowed border-neutral-200 bg-neutral-50 text-neutral-600',
          )}
          onMouseDown={(e) => e.stopPropagation()}
        />
        {!allowRenameDelete ? (
          <p className="mt-1.5 text-[11px] leading-snug text-neutral-400">Color only for this property.</p>
        ) : null}
        {renameError ? <p className="mt-1.5 text-[11px] text-red-600">{renameError}</p> : null}
      </div>

      {allowRenameDelete ? (
        <>
          <button
            type="button"
            disabled={busy || !canDelete}
            title={!canDelete ? 'Built-in statuses cannot be deleted here.' : undefined}
            className="flex w-full items-center gap-2 border-0 bg-transparent px-3 py-2 text-left text-[13px] text-neutral-700 outline-none hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-40"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void onDelete()}
          >
            <Trash2 className="h-4 w-4 shrink-0 text-neutral-500" strokeWidth={1.75} aria-hidden />
            Delete
          </button>
          <div className="mx-3 my-2 h-px bg-neutral-100" />
        </>
      ) : null}

      <div className="px-3 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-neutral-400">Colors</div>
      <div className="max-h-[220px] overflow-y-auto px-1 pb-1">
        {PILL_COLOR_ROWS.map((row) => (
          <button
            key={`${row.key}-${row.label}`}
            type="button"
            disabled={busy}
            className="flex w-full items-center gap-2.5 rounded-xl border-0 bg-transparent px-2 py-1.5 text-left text-[13px] outline-none hover:bg-black/[0.04] disabled:opacity-50"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void onPickColor(row.key)}
          >
            <span className={cn('h-4 w-4 shrink-0 rounded-lg', PILL_SWATCH[row.key])} aria-hidden />
            <span className="min-w-0 flex-1">{row.label}</span>
            {activeColor === row.key ? (
              <Check className="h-4 w-4 shrink-0 text-neutral-800" strokeWidth={2.2} aria-hidden />
            ) : null}
          </button>
        ))}
      </div>

      {allowRenameDelete ? (
        <div className="border-t border-neutral-100 px-3 pt-2">
          <button
            type="button"
            id="crm-pill-edit-done"
            disabled={busy}
            className="w-full rounded-xl border-0 bg-neutral-900 py-2 text-[13px] font-medium text-white shadow-none outline-none hover:bg-neutral-800 disabled:opacity-50"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() =>
              void (async () => {
                const ok = await applyRenameIfNeeded();
                if (ok) onClose();
              })()
            }
          >
            Done
          </button>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

type CrmSelectPortalMenuProps = {
  left: number;
  top: number;
  columnLabel: string;
  selectKey: string;
  colId: string;
  opts: string[];
  currentValue: string;
  optionColors: CrmOptionColors;
  projectStatuses: string[];
  rowId: string;
  fieldKey: string;
  onPick: (
    clientId: string,
    fieldKey: string,
    value: string,
    colId: string,
  ) => Promise<boolean>;
  onClose: () => void;
  onPickError: () => void;
  onSetOptionColor: (selectKey: string, label: string, color: CrmPillColorKey) => Promise<boolean>;
  onRenameOption: (selectKey: string, oldLabel: string, newLabel: string) => Promise<{ ok: boolean; error?: string }>;
  onDeleteOption: (selectKey: string, label: string) => Promise<{ ok: boolean; error?: string }>;
};

function CrmSelectPortalMenu({
  left,
  top,
  columnLabel,
  selectKey,
  colId,
  opts,
  currentValue,
  optionColors,
  projectStatuses,
  rowId,
  fieldKey,
  onPick,
  onClose,
  onPickError,
  onSetOptionColor,
  onRenameOption,
  onDeleteOption,
}: CrmSelectPortalMenuProps) {
  const [q, setQ] = useState('');
  const [pillEditor, setPillEditor] = useState<{ opt: string; left: number; top: number } | null>(null);
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return opts;
    return opts.filter((o) => o.toLowerCase().includes(t));
  }, [opts, q]);

  const sections = useMemo(
    () => groupedSelectSections(selectKey, opts, filtered),
    [selectKey, opts, filtered],
  );

  const openColumnsPanel = useCallback(() => {
    document.getElementById('btn-customers-columns')?.click();
    onClose();
  }, [onClose]);

  return createPortal(
    <>
      <div
        data-crm-table-portal
        className="fixed z-[300] flex min-w-[272px] max-w-[320px] flex-col overflow-hidden rounded-xl bg-white text-neutral-800 shadow-[0_12px_48px_-10px_rgba(15,15,15,0.18),0_0_0_1px_rgba(0,0,0,0.05)]"
        style={{ left, top, maxHeight: 'min(78vh, 440px)' }}
        role="listbox"
        aria-label={columnLabel}
      >
        <div className="shrink-0 px-4 pb-1 pt-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-neutral-400">
            {columnLabel}
          </div>
        </div>
        <div className="shrink-0 px-4 pb-3">
          <input
            type="search"
            autoComplete="off"
            autoFocus
            placeholder="Search for an option"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="box-border w-full border-0 border-b border-transparent bg-transparent py-2 text-[14px] text-neutral-800 outline-none ring-0 placeholder:text-neutral-400 focus:border-neutral-200/80 focus:ring-0"
            onMouseDown={(e) => e.stopPropagation()}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-[13px] text-neutral-400">No matching options</div>
          ) : (
            sections.map((sec, si) => (
              <div
                key={sec.title || `sec-${si}`}
                className={cn(si === 0 && !sec.title && 'pt-1', si === 0 && sec.title && 'pt-0.5')}
              >
                {sec.title ? (
                  <div
                    className={cn(
                      'px-2 pb-1 text-[12px] font-medium text-neutral-500',
                      si === 0 ? 'pt-0.5' : 'pt-2',
                    )}
                  >
                    {sec.title}
                  </div>
                ) : null}
                <div className="space-y-0.5">
                  {sec.items.map((opt) => (
                    <div
                      key={opt}
                      className={cn(
                        'flex items-center gap-0.5 rounded-lg pr-1 transition-colors hover:bg-black/[0.04]',
                        String(opt) === String(currentValue) && 'bg-black/[0.04]',
                      )}
                    >
                      <button
                        type="button"
                        className="!bg-transparent flex min-w-0 flex-1 items-center rounded-lg border-0 px-2 py-2 text-left outline-none"
                        role="option"
                        aria-selected={String(opt) === String(currentValue)}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          void (async () => {
                            const ok = await onPick(rowId, fieldKey, opt, colId);
                            if (!ok) onPickError();
                            onClose();
                          })();
                        }}
                      >
                        <SelectPill label={opt} color={resolvePillColor(selectKey, opt, optionColors)} />
                      </button>
                      <button
                        type="button"
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-neutral-500 outline-none hover:bg-black/[0.06] hover:text-neutral-800"
                        aria-label={`Edit ${opt}`}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          const r = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                          const panelW = 248;
                          const gap = 8;
                          let leftPos = r.right + gap;
                          if (leftPos + panelW > window.innerWidth - 8) {
                            leftPos = Math.max(8, r.left - panelW - gap);
                          }
                          setPillEditor({
                            opt,
                            left: leftPos,
                            top: Math.max(8, r.top - 4),
                          });
                        }}
                      >
                        <MoreHorizontal className="h-4 w-4" strokeWidth={2} aria-hidden />
                      </button>
                    </div>
                  ))}
                </div>
                {si < sections.length - 1 ? <div className="mx-1 my-2 h-px bg-neutral-100" /> : null}
              </div>
            ))
          )}
        </div>

        <div className="shrink-0 border-t border-neutral-100">
          <button
            type="button"
            className="!bg-transparent flex w-full items-center gap-2 border-0 px-4 py-2.5 text-left text-[13px] text-neutral-600 outline-none transition-colors hover:!bg-black/[0.04]"
            onMouseDown={(e) => e.preventDefault()}
            onClick={openColumnsPanel}
          >
            <SlidersHorizontal className="h-4 w-4 shrink-0 text-neutral-400" strokeWidth={1.75} aria-hidden />
            Edit property
          </button>
        </div>
      </div>
      {pillEditor ? (
        <CrmPillOptionEditorPopover
          selectKey={selectKey}
          optionLabel={pillEditor.opt}
          projectStatuses={projectStatuses}
          optionColors={optionColors}
          left={pillEditor.left}
          top={pillEditor.top}
          onClose={() => setPillEditor(null)}
          onSetOptionColor={onSetOptionColor}
          onRenameOption={onRenameOption}
          onDeleteOption={onDeleteOption}
        />
      ) : null}
    </>,
    document.body,
  );
}

type CrmCustomersTableProps = CrmCustomersTablePayload & {
  focusRequest: CrmTableFocusRequest | null;
  onConsumedFocus: () => void;
  onPatchField: (
    clientId: string,
    fieldKey: string,
    value: string,
    colId: string,
  ) => Promise<boolean>;
  onRevertField: (clientId: string, fieldKey: string, previous: string) => void;
  onLeaveRow: (rowId: string) => void;
  onCrmSetOptionColor: (selectKey: string, label: string, color: CrmPillColorKey) => Promise<boolean>;
  onCrmRenameSelectOption: (
    selectKey: string,
    oldLabel: string,
    newLabel: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  onCrmDeleteSelectOption: (selectKey: string, label: string) => Promise<{ ok: boolean; error?: string }>;
};

export function CrmCustomersTable({
  rows,
  columnPrefs,
  optionColors,
  projectStatuses,
  focusRequest,
  onConsumedFocus,
  onPatchField,
  onRevertField,
  onLeaveRow,
  onCrmSetOptionColor,
  onCrmRenameSelectOption,
  onCrmDeleteSelectOption,
}: CrmCustomersTableProps) {
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [selectedColId, setSelectedColId] = useState<string | null>(null);
  const [activeCellId, setActiveCellId] = useState<string | null>(null);
  const lastClickKeyRef = useRef<string | null>(null);
  const snapshotRef = useRef<string>('');
  const anchorRef = useRef<DOMRect | null>(null);
  const portalOpenRef = useRef(false);
  const [, bump] = useState(0);
  const errFlashRef = useRef<string | null>(null);

  const openSelectPortal = useCallback((rect: DOMRect | null) => {
    anchorRef.current = rect;
    portalOpenRef.current = true;
    bump((n) => n + 1);
  }, []);

  const closePortal = useCallback(() => {
    anchorRef.current = null;
    portalOpenRef.current = false;
    bump((n) => n + 1);
  }, []);

  const clearSelection = useCallback(() => {
    setActiveCellId(null);
    setSelectedRowId(null);
    setSelectedColId(null);
    lastClickKeyRef.current = null;
    closePortal();
  }, [closePortal]);

  useLayoutEffect(() => {
    window.bizDashApplyCustomersColumnVisibility?.();
  }, [rows, columnPrefs]);

  useEffect(() => {
    if (!focusRequest) return;
    setSelectedRowId(focusRequest.rowId);
    setSelectedColId(focusRequest.colId);
    lastClickKeyRef.current = `${focusRequest.rowId}:${focusRequest.colId}`;
    if (focusRequest.activate) {
      const key = `${focusRequest.rowId}:${focusRequest.colId}`;
      setActiveCellId(key);
      const def = CUSTOMERS_COLUMN_DEFS.find((c) => c.id === focusRequest.colId);
      const row = rows.find((r) => r.id === focusRequest.rowId);
      if (def?.fieldKey && row) snapshotRef.current = valueForField(row, def.fieldKey);
    }
    onConsumedFocus();
  }, [focusRequest, onConsumedFocus, rows]);

  useEffect(() => {
    const onDocMouseDown = (ev: MouseEvent) => {
      const t = ev.target as Node;
      if (document.getElementById('customers-table')?.contains(t)) return;
      if ((ev.target as HTMLElement).closest?.('[data-crm-table-portal]')) return;
      if ((ev.target as HTMLElement).closest?.('[data-crm-pill-edit-popover]')) return;
      clearSelection();
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => document.removeEventListener('mousedown', onDocMouseDown, true);
  }, [clearSelection]);

  const flashError = useCallback((cellId: string) => {
    errFlashRef.current = cellId;
    bump((n) => n + 1);
    window.setTimeout(() => {
      errFlashRef.current = null;
      bump((n) => n + 1);
    }, 1400);
  }, []);

  const commitValue = useCallback(
    async (rowId: string, colId: string, next: string) => {
      const def = CUSTOMERS_COLUMN_DEFS.find((c) => c.id === colId);
      if (!def?.fieldKey) return;
      const ok = await onPatchField(rowId, def.fieldKey, next, colId);
      if (!ok) flashError(`${rowId}:${colId}`);
      setActiveCellId(null);
      closePortal();
    },
    [onPatchField, flashError, closePortal],
  );

  const activateEdit = useCallback(
    (rowId: string, colId: string, rect: DOMRect | null) => {
      const def = CUSTOMERS_COLUMN_DEFS.find((c) => c.id === colId);
      const row = rows.find((r) => r.id === rowId);
      if (!def?.editable || !def.fieldKey || !row) return;
      if (!isSelectLike(def)) closePortal();
      const key = `${rowId}:${colId}`;
      setActiveCellId(key);
      snapshotRef.current = valueForField(row, def.fieldKey);
      if (isSelectLike(def)) openSelectPortal(rect);
      else closePortal();
    },
    [rows, openSelectPortal, closePortal],
  );

  const moveAfterCommit = useCallback(
    (fromRowId: string, fromColId: string, deltaCol: number, deltaRow: number) => {
      const cols = visibleEditableColIds(columnPrefs);
      const ci = cols.indexOf(fromColId);
      const ri = rows.findIndex((r) => r.id === fromRowId);
      if (ci < 0 || ri < 0) return;
      const nr = Math.max(0, Math.min(rows.length - 1, ri + deltaRow));
      const nrow = rows[nr];
      if (!nrow) return;
      const ncol =
        deltaRow !== 0 && deltaCol === 0
          ? fromColId
          : cols[Math.max(0, Math.min(cols.length - 1, ci + deltaCol))];
      if (!ncol) return;
      setActiveCellId(null);
      closePortal();
      setSelectedRowId(nrow.id);
      setSelectedColId(ncol);
      lastClickKeyRef.current = `${nrow.id}:${ncol}`;
      window.requestAnimationFrame(() => {
        const td = document.querySelector<HTMLElement>(
          `tr[data-client-id="${nrow.id}"] td[data-col-id="${ncol}"]`,
        );
        activateEdit(nrow.id, ncol, td?.getBoundingClientRect() ?? null);
        const inp = td?.querySelector<HTMLInputElement>('.crm-cell-input');
        if (inp) {
          inp.focus();
          inp.select?.();
        }
      });
    },
    [columnPrefs, rows, closePortal, activateEdit],
  );

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!isCustomersPageActive()) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

      if (ev.key === 'Tab' && activeCellId && portalOpenRef.current) {
        ev.preventDefault();
        const [rowId, colId] = activeCellId.split(':');
        setActiveCellId(null);
        closePortal();
        moveAfterCommit(rowId, colId, ev.shiftKey ? -1 : 1, 0);
        return;
      }

      if (ev.key === 'Escape' && activeCellId) {
        ev.preventDefault();
        const [rowId, colId] = activeCellId.split(':');
        const def = CUSTOMERS_COLUMN_DEFS.find((c) => c.id === colId);
        if (def?.fieldKey) onRevertField(rowId, def.fieldKey, snapshotRef.current);
        setActiveCellId(null);
        closePortal();
        return;
      }

      const inputEl = (ev.target as HTMLElement)?.closest?.('.crm-cell-input') as
        | HTMLInputElement
        | null
        | undefined;
      if (inputEl && activeCellId) {
        const [rowId, colId] = activeCellId.split(':');
        if (ev.key === 'Tab') {
          ev.preventDefault();
          const raw =
            inputEl.type === 'number' ? String(inputEl.value || '') : String(inputEl.value || '').trim();
          void (async () => {
            await commitValue(rowId, colId, raw);
            moveAfterCommit(rowId, colId, ev.shiftKey ? -1 : 1, 0);
          })();
          return;
        }
        if (ev.key === 'Enter') {
          ev.preventDefault();
          const raw =
            inputEl.type === 'number' ? String(inputEl.value || '') : String(inputEl.value || '').trim();
          void (async () => {
            await commitValue(rowId, colId, raw);
            moveAfterCommit(rowId, colId, 0, 1);
          })();
          return;
        }
        return;
      }

      if (activeCellId || !selectedRowId || !selectedColId) return;
      if (ev.key.length === 1 && !ev.key.match(/\s/)) {
        const def = CUSTOMERS_COLUMN_DEFS.find((c) => c.id === selectedColId);
        if (!def?.editable || !def.fieldKey || def.fieldKind === 'checkbox') return;
        if (isSelectLike(def)) return;
        ev.preventDefault();
        activateEdit(selectedRowId, selectedColId, null);
        window.requestAnimationFrame(() => {
          const inp = document.querySelector<HTMLInputElement>(
            `tr[data-client-id="${selectedRowId}"] td[data-col-id="${selectedColId}"] input.crm-cell-input`,
          );
          if (inp) {
            inp.value = ev.key;
            inp.focus();
            inp.select();
          }
        });
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [
    activeCellId,
    selectedRowId,
    selectedColId,
    onRevertField,
    closePortal,
    commitValue,
    moveAfterCommit,
    activateEdit,
  ]);

  const onCellMouseDown = useCallback(
    (ev: React.MouseEvent, rowId: string, colId: string, def: CrmColumnDef) => {
      if ((ev.target as HTMLElement).closest('button')) return;
      const key = `${rowId}:${colId}`;
      if (
        def.editable &&
        selectedRowId === rowId &&
        selectedColId === colId &&
        lastClickKeyRef.current === key &&
        !activeCellId
      ) {
        const td = (ev.currentTarget as HTMLElement).closest('td');
        activateEdit(rowId, colId, td?.getBoundingClientRect() ?? null);
        lastClickKeyRef.current = null;
        return;
      }
      setActiveCellId(null);
      closePortal();
      setSelectedRowId(rowId);
      setSelectedColId(colId);
      lastClickKeyRef.current = key;
    },
    [selectedRowId, selectedColId, activeCellId, activateEdit, closePortal],
  );

  const selectPortal = (() => {
    if (!activeCellId || !portalOpenRef.current || !anchorRef.current) return null;
    const rect = anchorRef.current;
    const [rowId, colId] = activeCellId.split(':');
    const def = CUSTOMERS_COLUMN_DEFS.find((c) => c.id === colId);
    if (!def?.selectKey || !def.fieldKey) return null;
    const opts = selectOptionsForColumn(def, projectStatuses);
    const row = rows.find((r) => r.id === rowId);
    const cur = row ? valueForField(row, def.fieldKey) : '';
    const top = Math.min(rect.bottom + 4, window.innerHeight - 8 - 420);
    const left = Math.min(Math.max(4, rect.left), window.innerWidth - 328);
    return (
      <CrmSelectPortalMenu
        key={activeCellId}
        left={left}
        top={top}
        columnLabel={def.label}
        selectKey={def.selectKey}
        opts={opts}
        currentValue={cur}
        optionColors={optionColors}
        projectStatuses={projectStatuses}
        rowId={rowId}
        colId={colId}
        fieldKey={def.fieldKey}
        onPick={onPatchField}
        onClose={() => {
          setActiveCellId(null);
          closePortal();
        }}
        onPickError={() => flashError(activeCellId)}
        onSetOptionColor={onCrmSetOptionColor}
        onRenameOption={onCrmRenameSelectOption}
        onDeleteOption={onCrmDeleteSelectOption}
      />
    );
  })();

  return (
    <>
      {rows.map((row) => (
        <tr
          key={row.id}
          data-client-id={row.id}
          className={cn('crm-row', selectedRowId === row.id && 'bg-gray-50')}
          onBlur={(ev) => {
            const rel = ev.relatedTarget as Node | null;
            if (rel && (ev.currentTarget as HTMLElement).contains(rel)) return;
            if (rel && (rel as HTMLElement).closest?.('[data-crm-table-portal]')) return;
            if (rel && (rel as HTMLElement).closest?.('[data-crm-pill-edit-popover]')) return;
            onLeaveRow(row.id);
          }}
        >
          {CUSTOMERS_COLUMN_DEFS.map((def) => {
            const key = `${row.id}:${def.id}`;
            const isActive = activeCellId === key;
            const err = errFlashRef.current === key;
            return (
              <td
                key={def.id}
                data-client-id={row.id}
                data-col-id={def.id}
                tabIndex={-1}
                className={cn(
                  'crm-cell td-truncate px-2 py-2 align-middle text-[13px]',
                  def.id === 'company' && 'max-w-[200px]',
                  def.id === 'email' && 'max-w-[220px]',
                  def.id === 'phone' && 'max-w-[130px]',
                  isActive && 'border-2 border-blue-500',
                  err && 'border-2 border-red-500',
                )}
                onMouseDown={(e) => {
                  if (def.id === 'actions') return;
                  if (def.fieldKind === 'checkbox' && def.editable) return;
                  onCellMouseDown(e, row.id, def.id, def);
                }}
              >
                {def.id === 'actions' ? (
                  <div className="flex flex-nowrap gap-1.5">
                    <button type="button" className="btn" data-client-edit={row.id}>
                      Full record
                    </button>
                    <button type="button" className="btn text-[var(--red)]" data-client-del={row.id}>
                      Delete
                    </button>
                  </div>
                ) : !def.editable ? (
                  def.id === 'projects' ? (
                    row.projects
                  ) : def.id === 'revenue' ? (
                    row.revenue
                  ) : def.id === 'allocated' ? (
                    row.allocated
                  ) : def.id === 'profit' ? (
                    <span className={cn('tabular-nums', row.profitNegative && 'text-[var(--red)]')}>
                      {row.profit}
                    </span>
                  ) : def.id === 'margin' ? (
                    row.margin
                  ) : def.id === 'roi' ? (
                    row.roi
                  ) : def.id === 'updated' ? (
                    row.updated
                  ) : (
                    '—'
                  )
                ) : isSelectLike(def) && def.selectKey ? (
                  <div className="flex min-w-0 flex-wrap items-center gap-1">
                    {(() => {
                      const raw = def.fieldKey ? valueForField(row, def.fieldKey) : '';
                      const label = raw.trim() || '—';
                      return label !== '—' ? (
                        <SelectPill
                          label={label}
                          color={resolvePillColor(def.selectKey, label, optionColors)}
                        />
                      ) : (
                        <span className="text-[var(--text3)]">—</span>
                      );
                    })()}
                  </div>
                ) : def.fieldKind === 'number' ? (
                  isActive ? (
                    <input
                      type="number"
                      className="crm-cell-input w-full border-0 bg-transparent p-0 text-[13px] text-inherit outline-none"
                      defaultValue={def.fieldKey ? valueForField(row, def.fieldKey) : ''}
                      autoFocus
                      onBlur={(e) => void commitValue(row.id, def.id, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          if (def.fieldKey) onRevertField(row.id, def.fieldKey, snapshotRef.current);
                          setActiveCellId(null);
                          closePortal();
                        }
                      }}
                    />
                  ) : (
                    (def.fieldKey && valueForField(row, def.fieldKey)) || '—'
                  )
                ) : def.fieldKind === 'date' ? (
                  isActive ? (
                    <input
                      type="date"
                      className="crm-cell-input w-full border-0 bg-transparent p-0 text-[13px] outline-none"
                      defaultValue={def.fieldKey ? valueForField(row, def.fieldKey) : ''}
                      autoFocus
                      onBlur={(e) => void commitValue(row.id, def.id, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          if (def.fieldKey) onRevertField(row.id, def.fieldKey, snapshotRef.current);
                          setActiveCellId(null);
                        }
                      }}
                    />
                  ) : (
                    (def.fieldKey && valueForField(row, def.fieldKey)) || '—'
                  )
                ) : def.fieldKind === 'checkbox' ? (
                  <input
                    type="checkbox"
                    checked={
                      def.fieldKey
                        ? valueForField(row, def.fieldKey) === 'true' ||
                          valueForField(row, def.fieldKey) === '1'
                        : false
                    }
                    onChange={(e) =>
                      void onPatchField(
                        row.id,
                        def.fieldKey || '',
                        e.target.checked ? 'true' : 'false',
                        def.id,
                      )
                    }
                  />
                ) : isActive ? (
                  <input
                    type="text"
                    className="crm-cell-input w-full border-0 bg-transparent p-0 text-[13px] text-inherit outline-none"
                    defaultValue={def.fieldKey ? valueForField(row, def.fieldKey) : ''}
                    autoFocus
                    onBlur={(e) => void commitValue(row.id, def.id, e.target.value.trim())}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        if (def.fieldKey) onRevertField(row.id, def.fieldKey, snapshotRef.current);
                        setActiveCellId(null);
                        closePortal();
                      }
                    }}
                  />
                ) : (
                  (def.fieldKey && valueForField(row, def.fieldKey)) || '—'
                )}
              </td>
            );
          })}
        </tr>
      ))}
      {selectPortal}
    </>
  );
}
