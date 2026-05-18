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
