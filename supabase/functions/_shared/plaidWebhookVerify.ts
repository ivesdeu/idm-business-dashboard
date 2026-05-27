import { webhookVerificationKeyGet } from "./plaidClient.ts";

type JwkSymmetric = {
  kty: string;
  use: string;
  kid: string;
  alg: string;
  k: string;
};

type CachedKey = { key: CryptoKey; cachedAt: number };

const KEY_CACHE = new Map<string, CachedKey>();
const CACHE_TTL_MS = 10 * 60 * 1000;

function nowMs(): number {
  return Date.now();
}

function base64UrlToBytes(input: string): Uint8Array {
  const pad = "=".repeat((4 - (input.length % 4)) % 4);
  const b64 = (input + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function importHmacKey(jwk: JwkSymmetric): Promise<CryptoKey> {
  const secret = base64UrlToBytes(jwk.k);
  return await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

function parseJwtHeader(token: string): { kid: string; alg: string } | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const headerJson = new TextDecoder().decode(base64UrlToBytes(parts[0]));
    const header = JSON.parse(headerJson) as { kid?: unknown; alg?: unknown };
    const kid = typeof header.kid === "string" ? header.kid : "";
    const alg = typeof header.alg === "string" ? header.alg : "";
    if (!kid || !alg) return null;
    return { kid, alg };
  } catch {
    return null;
  }
}

async function getKeyForKid(kid: string): Promise<CryptoKey> {
  const cached = KEY_CACHE.get(kid);
  if (cached && nowMs() - cached.cachedAt < CACHE_TTL_MS) return cached.key;

  const res = await webhookVerificationKeyGet({ key_id: kid });
  if (!res.ok) {
    throw new Error(res.error || "Failed to fetch Plaid webhook verification key");
  }
  const jwk = (res.data as { key?: unknown }).key as JwkSymmetric;
  if (!jwk || typeof jwk.k !== "string" || !jwk.k) {
    throw new Error("Plaid webhook verification key response missing key");
  }
  const key = await importHmacKey(jwk);
  KEY_CACHE.set(kid, { key, cachedAt: nowMs() });
  return key;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function verifyHs256(token: string, key: CryptoKey): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const sig = base64UrlToBytes(parts[2]);
  const ok = await crypto.subtle.verify("HMAC", key, sig, signed);
  return ok;
}

/**
 * Verify Plaid webhook signature.
 *
 * Plaid sends a JWT in `Plaid-Verification` header. The JWT is signed and the key
 * can be fetched from `/webhook_verification_key/get` by `kid`.
 *
 * We verify signature only (HS256). If verification fails, throw.
 */
export async function verifyPlaidWebhookOrThrow(
  verificationHeader: string | null,
): Promise<{ kid: string }> {
  const token = (verificationHeader || "").trim();
  if (!token) throw new Error("Missing Plaid-Verification header");
  const header = parseJwtHeader(token);
  if (!header) throw new Error("Invalid Plaid-Verification JWT header");
  if (header.alg !== "HS256") throw new Error(`Unsupported Plaid webhook alg: ${header.alg}`);

  const key = await getKeyForKid(header.kid);
  const ok = await verifyHs256(token, key);
  if (!ok) throw new Error("Plaid webhook verification failed");

  // Optional: ensure JWT has three parts and isn't obviously malformed.
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed Plaid-Verification token");
  // Cheap check to prevent empty signature.
  if (bytesEqual(base64UrlToBytes(parts[2]), new Uint8Array(0))) {
    throw new Error("Malformed Plaid-Verification signature");
  }

  return { kid: header.kid };
}

