import type { PostgrestError } from '@supabase/supabase-js';

export function isTransientFetchError (error: PostgrestError | null | undefined): boolean {
  if (!error) return false;
  const msg = String (error.message || '').toLowerCase ();
  return (
    msg.includes ('load failed') ||
    msg.includes ('failed to fetch') ||
    msg.includes ('networkerror') ||
    msg.includes ('network request failed')
  );
}

/** Retry PostgREST calls that failed at the network layer (Safari: "TypeError: Load failed"). */
export async function withTransientRetry<T> (
  run: () => Promise<{ data: T; error: PostgrestError | null }>,
  attempts = 3,
): Promise<{ data: T; error: PostgrestError | null }> {
  let result = await run ();
  for (let i = 1; i < attempts && isTransientFetchError (result.error); i += 1) {
    await new Promise ((resolve) => window.setTimeout (resolve, 200 * i));
    result = await run ();
  }
  return result;
}

export function logSchedulingFetchError (label: string, error: PostgrestError | null | undefined): void {
  if (!error) return;
  if (isTransientFetchError (error)) {
    console.warn (`${label} (network)`, error.message);
    return;
  }
  console.error (label, error);
}
