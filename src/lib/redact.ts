/**
 * Secret redaction. Applied to every string leaving the process (tool results and
 * log lines), so a token or password can never reach the model or stderr even if a
 * server error message echoes it.
 */
export const REDACTED = "[REDACTED]";

/** Secrets shorter than this are not redacted: replacing 1-3 characters would mangle ordinary output. */
const MIN_SECRET_LENGTH = 4;

/** Keys whose string values are secrets (`password`, `new_password`, `raw_token`, ...). `token_uid` is an identifier, not a secret. */
const SENSITIVE_KEY = /(^|_)(pass(word|phrase)?|secret|authorization|cookies_json|cookies|token)$/i;

const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

/** Replace every occurrence of each secret (and any `Bearer <opaque>` value) in `text`. */
export function redactString(text: string, secrets: readonly string[]): string {
  let out = text;
  // Longest first so a secret that contains another is replaced whole.
  const variants = new Set<string>();
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue;
    variants.add(secret);
    // The same secret as it appears inside a JSON string literal (quotes, backslashes, ...).
    variants.add(JSON.stringify(secret).slice(1, -1));
  }
  const ordered = [...variants].sort((a, b) => b.length - a.length);
  for (const secret of ordered) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out.replace(BEARER, `$1${REDACTED}`);
}

/** Deeply redact all strings in a JSON-like value. */
export function redactValue<T>(value: T, secrets: readonly string[]): T {
  return walk(value, secrets) as T;
}

function walk(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((v) => walk(v, secrets));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, secrets);
    return out;
  }
  return value;
}

/**
 * Collect the values of sensitive-looking string arguments (`password`,
 * `new_password`, `token`, `cookies_json`, ...) so that a tool's output can be
 * scrubbed of values the caller just supplied.
 */
export function collectSecretArgs(args: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown, key: string | undefined): void => {
    if (typeof value === "string") {
      if (key !== undefined && SENSITIVE_KEY.test(key)) found.push(value);
    } else if (Array.isArray(value)) {
      for (const v of value) visit(v, key);
    } else if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) visit(v, k);
    }
  };
  visit(args, undefined);
  return found;
}

/** Replace the values of sensitive-looking keys (for diagnostics that must show argument shape). */
export function scrubSensitiveKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubSensitiveKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : scrubSensitiveKeys(v);
    }
    return out;
  }
  return value;
}
