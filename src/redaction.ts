const DEFAULT_REDACTED_KEY_PATTERNS: RegExp[] = [
  /(^|\.)authorization$/i,
  /(^|\.)proxy-authorization$/i,
  /(^|\.)cookie$/i,
  /(^|\.)set-cookie$/i,
  /(^|\.)x-api-key$/i,
  /(^|\.)x-auth-token$/i,
  /(^|\.)x-access-token$/i,
  /(^|\.)x-allstak-key$/i,
  /(^|[._-])token$/i,
  /(^|[._-])api[._-]?key$/i,
  /(^|[._-])password$/i,
  /(^|[._-])passwd$/i,
  /(^|[._-])secret$/i,
  /(^|[._-])session[._-]?id$/i,
  /(^|[._-])csrf$/i,
  // Canonical denylist parity additions.
  /(^|[._-])bearer$/i,
  /(^|[._-])jwt$/i,
  /(^|[._-])pwd$/i,
  /(^|[._-])credit[._-]?card$/i,
  /(^|[._-])card[._-]?number$/i,
  /(^|[._-])cvv$/i,
  /(^|[._-])ssn$/i,
];

export const REDACTED = '[REDACTED]';

export function isSensitiveKey(key: string, extra: RegExp[] = []): boolean {
  for (const p of DEFAULT_REDACTED_KEY_PATTERNS) if (p.test(key)) return true;
  for (const p of extra) if (p.test(key)) return true;
  return false;
}

export function compileExtra(extra: (string | RegExp)[] | undefined): RegExp[] {
  if (!extra) return [];
  return extra.map((p) => (p instanceof RegExp ? p : new RegExp(escape(p), 'i')));
}

export function redactMap(
  input: Record<string, unknown> | undefined,
  extra: RegExp[] = [],
): Record<string, unknown> | undefined {
  if (!input) return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = isSensitiveKey(k, extra) ? REDACTED : redactValue(v, extra);
  }
  return out;
}

function redactValue(v: unknown, extra: RegExp[]): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) return redactMap(v as Record<string, unknown>, extra);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, extra));
  return v;
}

export function redactHeadersToString(
  headers: Record<string, string | string[] | undefined>,
  extra: RegExp[] = [],
): string {
  const keys = Object.keys(headers).sort();
  const out: string[] = [];
  for (const k of keys) {
    if (isSensitiveKey(k, extra)) {
      out.push(`${k}: ${REDACTED}`);
    } else {
      const v = headers[k];
      out.push(`${k}: ${Array.isArray(v) ? v.join(',') : v ?? ''}`);
    }
  }
  return out.join('\n');
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ───────────────────────────────────────────────────────────────────────────
// Value-pattern PII scrubbing.
//
// The key-based redaction above replaces a value when its KEY looks sensitive
// (password/token/cookie/…). This second layer scans free-text string VALUES
// for PII that leaks regardless of key name. Two tiers:
//
//   A) ALWAYS scrubbed (high-risk financial/identity), independent of any
//      opt-in: Luhn-valid credit-card numbers and hyphenated US SSNs.
//   B) Scrubbed UNLESS `sendDefaultPii` is true: email addresses and valid
//      IPv4 addresses. Default false = privacy-by-default.
//
// Conservative by design: the CC matcher requires a Luhn checksum pass so digit
// runs like order ids / timestamps are preserved, and SSN requires the literal
// hyphens so bare 9-digit numbers are left alone. All scanning is fail-open and
// length/recursion capped — a scrubber error must never drop or break an event.
// ───────────────────────────────────────────────────────────────────────────

/** Skip scanning string values longer than this (perf + ReDoS safety). */
const MAX_SCAN_LEN = 16_384;
/** Max object/array nesting walked by the deep value scrubber. */
const MAX_SCRUB_DEPTH = 12;

/**
 * Candidate run of 13-19 digits using optional single space/hyphen separators.
 * Bounded with explicit word-ish boundaries so it won't anchor mid-token. The
 * Luhn check (below) is what actually decides redaction — this only finds
 * candidates cheaply.
 */
const CC_CANDIDATE = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g;
/** US SSN: requires the two hyphens; never matches a bare 9-digit run. */
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
/** Pragmatic email matcher (local@domain.tld), case-insensitive. */
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
/** IPv4 with each octet validated to 0-255. */
const IPV4_RE =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
/**
 * Best-effort IPv6 (full or `::`-compressed). Requires the `::` compression
 * marker OR a full 8-group form, and at least two colons, so it stays
 * conservative and won't fire on stray hex:hex tokens. IPv6 scrubbing is
 * explicitly best-effort.
 */
const IPV6_RE = new RegExp(
  [
    // full 8-group form: 1:2:3:4:5:6:7:8
    '\\b(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}\\b',
    // compressed forms containing "::"
    '|(?<![:.\\w])(?:[0-9A-Fa-f]{1,4}:){1,7}:(?:[0-9A-Fa-f]{1,4})?(?::[0-9A-Fa-f]{1,4}){0,6}(?![:.\\w])',
    '|(?<![:.\\w])::(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4}(?![:.\\w])',
  ].join(''),
  'g',
);

/** Luhn checksum: true when the digit string is a valid mod-10 sequence. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0 && digits.length > 0;
}

/**
 * Scrub PII patterns out of a single string. Always redacts Luhn-valid credit
 * cards and hyphenated SSNs; redacts email + IPv4/IPv6 only when
 * `sendDefaultPii` is false. Returns the input unchanged on any error or when
 * the string is empty / oversized. Pure and fail-open.
 */
export function scrubStringValue(input: string, sendDefaultPii: boolean): string {
  if (!input || input.length > MAX_SCAN_LEN) return input;
  try {
    let out = input;
    // (A) Always-on. Credit cards gated on a real Luhn pass to avoid nuking
    // order ids / long numeric tokens.
    out = out.replace(CC_CANDIDATE, (m) => {
      const digits = m.replace(/[ -]/g, '');
      if (digits.length < 13 || digits.length > 19) return m;
      return luhnValid(digits) ? REDACTED : m;
    });
    out = out.replace(SSN_RE, REDACTED);
    // (B) PII gated by sendDefaultPii (default false = scrub).
    if (!sendDefaultPii) {
      out = out.replace(EMAIL_RE, REDACTED);
      out = out.replace(IPV4_RE, REDACTED);
      out = out.replace(IPV6_RE, REDACTED);
    }
    return out;
  } catch {
    return input;
  }
}

/**
 * Keys whose string values are intentional/structural and must NOT be value
 * scrubbed: explicitly-set user identity (explicit user data is preserved
 * even with sendDefaultPii=false), stack-frame source fields,
 * release/version/sdk identity, span/operation names, URLs/paths (covered by
 * the dedicated URL redactor), and the SDK's own correlation ids. Matched
 * case-insensitively against the leaf key only.
 */
const VALUE_SCRUB_SKIP_KEYS = new Set<string>([
  // Explicit user identity (set via setUser / request.user).
  'userid', 'useremail', 'user_id', 'user_email', 'user',
  // Stack frame / source location.
  'stacktrace', 'stack', 'filename', 'function', 'abspath', 'abs_path',
  'module', 'lineno', 'colno',
  // Release / SDK / service identity.
  'release', 'version', 'environment', 'service', 'servicename',
  'sdk.name', 'sdk.version', 'sdkname', 'sdkversion', 'platform', 'author',
  // Span / URL / path fields (own redactor / not PII free-text).
  'operation', 'description', 'path', 'httppath', 'url', 'host', 'hostname',
  'data', 'fingerprint',
  // SDK correlation ids.
  'sessionid', 'traceid', 'spanid', 'parentspanid', 'requestid',
]);

/**
 * Recursively value-scrub a JSON-ish structure in place-free fashion (returns a
 * new tree). String values get {@link scrubStringValue} unless their key is in
 * {@link VALUE_SCRUB_SKIP_KEYS}. Depth-capped and fail-open: any throw returns
 * the node untouched so a scrubber bug can never drop an event.
 */
export function scrubValuesDeep<T>(value: T, sendDefaultPii: boolean): T {
  try {
    return walkScrub(value, sendDefaultPii, 0, false) as T;
  } catch {
    return value;
  }
}

function walkScrub(value: unknown, sendDefaultPii: boolean, depth: number, skip: boolean): unknown {
  if (typeof value === 'string') {
    return skip ? value : scrubStringValue(value, sendDefaultPii);
  }
  if (depth >= MAX_SCRUB_DEPTH || value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    // An array under a skip key (e.g. stackTrace) stays untouched wholesale.
    if (skip) return value;
    return value.map((v) => walkScrub(v, sendDefaultPii, depth + 1, false));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = walkScrub(v, sendDefaultPii, depth + 1, VALUE_SCRUB_SKIP_KEYS.has(k.toLowerCase()));
  }
  return out;
}
