export type PlaidEnv = "sandbox" | "development" | "production";

type PlaidError = {
  error_type?: string;
  error_code?: string;
  error_message?: string;
  display_message?: string | null;
  request_id?: string;
};

export type PlaidResponse<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; detail?: PlaidError };

function plaidHost(env: PlaidEnv): string {
  switch (env) {
    case "sandbox":
      return "https://sandbox.plaid.com";
    case "development":
      return "https://development.plaid.com";
    case "production":
      return "https://production.plaid.com";
  }
}

function readPlaidEnv(): PlaidEnv {
  const raw = (Deno.env.get("PLAID_ENV") ?? "sandbox").trim().toLowerCase();
  if (raw === "production" || raw === "development" || raw === "sandbox") return raw;
  return "sandbox";
}

function mustEnv(name: string): string {
  const v = (Deno.env.get(name) ?? "").trim();
  if (!v) throw new Error(`Missing ${name} in Supabase Edge secrets`);
  return v;
}

function stringifyPlaidError(payload: unknown, fallback: string): string {
  const err = payload as PlaidError;
  const message = typeof err?.error_message === "string" ? err.error_message.trim() : "";
  const code = typeof err?.error_code === "string" ? err.error_code.trim() : "";
  const reqId = typeof err?.request_id === "string" ? err.request_id.trim() : "";
  const extra = [code ? `code=${code}` : "", reqId ? `request_id=${reqId}` : ""]
    .filter(Boolean)
    .join(" ");
  if (message) return extra ? `${message} (${extra})` : message;
  return fallback;
}

async function plaidFetch<T>(path: string, body: Record<string, unknown>): Promise<PlaidResponse<T>> {
  const env = readPlaidEnv();
  const host = plaidHost(env);
  const client_id = mustEnv("PLAID_CLIENT_ID");
  const secret = mustEnv("PLAID_SECRET");

  const res = await fetch(`${host}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id,
      secret,
      ...body,
    }),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: stringifyPlaidError(payload, `Plaid request failed (${res.status}).`),
      detail: payload as PlaidError,
    };
  }
  return { ok: true, data: payload as T };
}

export type PlaidInstitution = { institution_id: string; name?: string | null };

export type PlaidLinkTokenCreateResponse = {
  link_token: string;
  expiration: string;
  request_id: string;
};

export async function linkTokenCreate(params: {
  client_user_id: string;
  webhook?: string | null;
  products: string[];
  country_codes: string[];
  language?: string;
}): Promise<PlaidResponse<PlaidLinkTokenCreateResponse>> {
  return await plaidFetch("/link/token/create", {
    user: { client_user_id: params.client_user_id },
    products: params.products,
    country_codes: params.country_codes,
    language: params.language ?? "en",
    webhook: params.webhook ?? undefined,
  });
}

export type PlaidItemPublicTokenExchangeResponse = {
  access_token: string;
  item_id: string;
  request_id: string;
};

export async function itemPublicTokenExchange(params: {
  public_token: string;
}): Promise<PlaidResponse<PlaidItemPublicTokenExchangeResponse>> {
  return await plaidFetch("/item/public_token/exchange", {
    public_token: params.public_token,
  });
}

export type PlaidAccount = {
  account_id: string;
  name?: string | null;
  mask?: string | null;
  type?: string | null;
  subtype?: string | null;
  balances?: {
    current?: number | null;
    available?: number | null;
    iso_currency_code?: string | null;
  } | null;
};

export type PlaidAccountsGetResponse = {
  accounts: PlaidAccount[];
  request_id: string;
};

export async function accountsGet(params: {
  access_token: string;
}): Promise<PlaidResponse<PlaidAccountsGetResponse>> {
  return await plaidFetch("/accounts/get", {
    access_token: params.access_token,
  });
}

export type PlaidTransaction = {
  transaction_id: string;
  account_id: string;
  amount: number;
  iso_currency_code?: string | null;
  authorized_date?: string | null;
  date: string;
  name?: string | null;
  merchant_name?: string | null;
  pending?: boolean | null;
  personal_finance_category?: {
    primary?: string | null;
    detailed?: string | null;
    confidence_level?: string | null;
  } | null;
};

export type PlaidTransactionsSyncResponse = {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: Array<{ transaction_id: string }>;
  next_cursor: string;
  has_more: boolean;
  request_id: string;
};

export async function transactionsSync(params: {
  access_token: string;
  cursor?: string | null;
  count?: number;
}): Promise<PlaidResponse<PlaidTransactionsSyncResponse>> {
  return await plaidFetch("/transactions/sync", {
    access_token: params.access_token,
    cursor: params.cursor ?? undefined,
    count: params.count ?? 500,
    options: { include_personal_finance_category: true },
  });
}

export async function webhookVerificationKeyGet(params: {
  key_id: string;
}): Promise<PlaidResponse<{ key: { kty: string; use: string; kid: string; alg: string; k: string }; request_id: string }>> {
  return await plaidFetch("/webhook_verification_key/get", { key_id: params.key_id });
}

