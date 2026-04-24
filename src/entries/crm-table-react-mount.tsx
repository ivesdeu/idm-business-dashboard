import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import '../crm-island.css';
import {
  CrmCustomersTable,
  type CrmCustomersTablePayload,
  type CrmTableFocusRequest,
} from '@/components/crm/CrmCustomersTable';
import type { CrmPillColorKey } from '@/lib/crm-customers-schema';

let root: Root | null = null;

function CrmTableHost() {
  const [payload, setPayload] = useState<CrmCustomersTablePayload | null>(null);
  const [focusRequest, setFocusRequest] = useState<CrmTableFocusRequest | null>(null);

  const onPatchField = useCallback(
    async (clientId: string, fieldKey: string, value: string, colId: string) => {
      const fn = window.bizDashCrmTablePatchField as
        | ((a: string, b: string, c: string, d: string) => Promise<boolean>)
        | undefined;
      if (!fn) return false;
      return fn(clientId, fieldKey, value, colId);
    },
    [],
  );

  const onRevertField = useCallback((clientId: string, fieldKey: string, previous: string) => {
    const fn = window.bizDashCrmTableRevertField as
      | ((a: string, b: string, c: string) => void)
      | undefined;
    if (fn) fn(clientId, fieldKey, previous);
  }, []);

  const onLeaveRow = useCallback((rowId: string) => {
    const fn = window.bizDashCrmTableOnLeaveRow as ((id: string) => void) | undefined;
    if (fn) fn(rowId);
  }, []);

  const onCrmSetOptionColor = useCallback(
    async (selectKey: string, label: string, color: CrmPillColorKey) => {
      const fn = window.bizDashCrmSetOptionColor as
        | ((a: string, b: string, c: CrmPillColorKey) => Promise<boolean>)
        | undefined;
      if (!fn) return false;
      return fn(selectKey, label, color);
    },
    [],
  );

  const onCrmRenameSelectOption = useCallback(
    async (selectKey: string, oldLabel: string, newLabel: string) => {
      const fn = window.bizDashCrmRenameSelectOption as
        | ((a: string, b: string, c: string) => Promise<{ ok: boolean; error?: string }>)
        | undefined;
      if (!fn) return { ok: false, error: 'Rename is not available.' };
      return fn(selectKey, oldLabel, newLabel);
    },
    [],
  );

  const onCrmDeleteSelectOption = useCallback(async (selectKey: string, label: string) => {
    const fn = window.bizDashCrmDeleteSelectOption as
      | ((a: string, b: string) => Promise<{ ok: boolean; error?: string }>)
      | undefined;
    if (!fn) return { ok: false, error: 'Delete is not available.' };
    return fn(selectKey, label);
  }, []);

  useEffect(() => {
    window.bizDashCrmCustomersTableApplyPayload = (p: CrmCustomersTablePayload) => {
      setPayload(p);
    };
    return () => {
      delete window.bizDashCrmCustomersTableApplyPayload;
    };
  }, []);

  useEffect(() => {
    window.bizDashCrmCustomersTableFocus = (o: CrmTableFocusRequest) => {
      setFocusRequest(o);
    };
    return () => {
      delete window.bizDashCrmCustomersTableFocus;
    };
  }, []);

  if (!payload) return null;

  return (
    <CrmCustomersTable
      rows={payload.rows}
      columnPrefs={payload.columnPrefs}
      optionColors={payload.optionColors}
      projectStatuses={payload.projectStatuses}
      focusRequest={focusRequest}
      onConsumedFocus={() => setFocusRequest(null)}
      onPatchField={onPatchField}
      onRevertField={onRevertField}
      onLeaveRow={onLeaveRow}
      onCrmSetOptionColor={onCrmSetOptionColor}
      onCrmRenameSelectOption={onCrmRenameSelectOption}
      onCrmDeleteSelectOption={onCrmDeleteSelectOption}
    />
  );
}

export function mountCrmCustomersTable() {
  const el = document.getElementById('customers-tbody');
  if (!el || root) return;
  el.innerHTML = '';
  root = createRoot(el);
  window.bizDashSyncCrmCustomersTable = () => {
    const fn = window.bizDashCrmCustomersTableBuildPayload as (() => CrmCustomersTablePayload) | undefined;
    const apply = window.bizDashCrmCustomersTableApplyPayload as
      | ((p: CrmCustomersTablePayload) => void)
      | undefined;
    if (fn && apply) apply(fn());
  };
  root.render(
    <StrictMode>
      <CrmTableHost />
    </StrictMode>,
  );
  queueMicrotask(() => {
    if (window.bizDashSyncCrmCustomersTable) window.bizDashSyncCrmCustomersTable();
  });
}
