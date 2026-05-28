import type { OutboxEntry } from './types';
import { getOrgId } from './session';

function storageKey(): string {
  const org = getOrgId();
  return `bizdash:emails:outbox:${org || 'default'}`;
}

export function loadOutbox(): OutboxEntry[] {
  try {
    const raw = localStorage.getItem(storageKey());
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function saveOutbox(entries: OutboxEntry[]): void {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(entries.slice(0, 200)));
  } catch {
    /* ignore quota */
  }
}

export function appendOutbox(entry: OutboxEntry): void {
  const list = loadOutbox();
  list.unshift(entry);
  saveOutbox(list);
}
