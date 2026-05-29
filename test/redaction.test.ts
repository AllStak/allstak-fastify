import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  isSensitiveKey,
  redactMap,
  scrubStringValue,
  scrubValuesDeep,
} from '../src/redaction';

// A real Visa test number that passes the Luhn checksum.
const CC_VALID = '4111111111111111';
// Same length, last digit changed → fails Luhn.
const CC_INVALID = '4111111111111112';

describe('redaction — value-pattern PII scrubbing', () => {
  describe('credit cards (always scrubbed, Luhn-gated)', () => {
    it('redacts a Luhn-valid 16-digit card', () => {
      expect(scrubStringValue(`card ${CC_VALID} ok`, false)).toBe(`card ${REDACTED} ok`);
    });

    it('redacts a Luhn-valid card with space separators', () => {
      expect(scrubStringValue('pay with 4111 1111 1111 1111 now', false)).toBe(
        `pay with ${REDACTED} now`,
      );
    });

    it('redacts a Luhn-valid card with hyphen separators', () => {
      expect(scrubStringValue('4111-1111-1111-1111', false)).toBe(REDACTED);
    });

    it('PRESERVES a digit run that fails Luhn (e.g. order id / timestamp)', () => {
      const s = `order ${CC_INVALID} placed`;
      expect(scrubStringValue(s, false)).toBe(s);
    });

    it('PRESERVES a 13-19 digit numeric id that fails Luhn', () => {
      // 16-digit non-card id, Luhn-invalid → must survive untouched.
      const s = 'tracking 1234567890123456 done';
      // Only redact if it happens to pass Luhn; this one does not.
      const expectScrubbed = scrubStringValue(s, false);
      expect(expectScrubbed).toBe(s);
    });

    it('credit cards are scrubbed even when sendDefaultPii=true (always-on tier)', () => {
      expect(scrubStringValue(CC_VALID, true)).toBe(REDACTED);
    });
  });

  describe('US SSN (always scrubbed, hyphens required)', () => {
    it('redacts a hyphenated SSN', () => {
      expect(scrubStringValue('ssn 123-45-6789 here', false)).toBe(`ssn ${REDACTED} here`);
    });

    it('PRESERVES a bare 9-digit number (no hyphens)', () => {
      const s = 'id 123456789 here';
      expect(scrubStringValue(s, false)).toBe(s);
    });

    it('SSN is scrubbed even when sendDefaultPii=true (always-on tier)', () => {
      expect(scrubStringValue('123-45-6789', true)).toBe(REDACTED);
    });
  });

  describe('email + IPv4 (scrubbed unless sendDefaultPii)', () => {
    it('redacts an email when sendDefaultPii=false', () => {
      expect(scrubStringValue('reach me at jane.doe@example.com please', false)).toBe(
        `reach me at ${REDACTED} please`,
      );
    });

    it('PRESERVES an email when sendDefaultPii=true', () => {
      const s = 'reach me at jane.doe@example.com please';
      expect(scrubStringValue(s, true)).toBe(s);
    });

    it('redacts a valid IPv4 when sendDefaultPii=false', () => {
      expect(scrubStringValue('from 192.168.1.42 ok', false)).toBe(`from ${REDACTED} ok`);
    });

    it('PRESERVES an IPv4 when sendDefaultPii=true', () => {
      const s = 'from 192.168.1.42 ok';
      expect(scrubStringValue(s, true)).toBe(s);
    });

    it('does NOT treat an out-of-range octet quad as an IPv4', () => {
      const s = 'version 999.999.0.1 build';
      expect(scrubStringValue(s, false)).toBe(s);
    });

    it('redacts IPv6 when sendDefaultPii=false', () => {
      expect(scrubStringValue('peer 2001:db8::1 connected', false)).toBe(
        `peer ${REDACTED} connected`,
      );
    });
  });

  describe('scrubValuesDeep — key-aware structural scrubbing', () => {
    it('scrubs free-text string values but skips allowlisted keys', () => {
      const input = {
        message: 'contact jane@example.com from 10.0.0.5',
        userEmail: 'explicit@example.com', // explicit setUser — preserved
        release: '1.2.3@198.51.100.7', // release identity — preserved
        metadata: {
          'extra.note': 'card 4111 1111 1111 1111',
          'sdk.version': '0.0.0',
          userId: 'jane@example.com', // explicit user id — preserved verbatim
        },
        stackTrace: ['at handler (/srv/app/192.168.0.1/index.js:10:5)'],
      };
      const out = scrubValuesDeep(input, false) as typeof input;
      expect(out.message).toBe(`contact ${REDACTED} from ${REDACTED}`);
      expect(out.userEmail).toBe('explicit@example.com');
      expect(out.release).toBe('1.2.3@198.51.100.7');
      expect(out.metadata['extra.note']).toBe(`card ${REDACTED}`);
      expect(out.metadata['sdk.version']).toBe('0.0.0');
      expect(out.metadata.userId).toBe('jane@example.com');
      // Stack frame paths/ips must not be corrupted.
      expect(out.stackTrace[0]).toBe('at handler (/srv/app/192.168.0.1/index.js:10:5)');
    });

    it('when sendDefaultPii=true keeps email/IP in free text but still scrubs CC/SSN', () => {
      const input = {
        message: 'jane@example.com from 10.0.0.5 paid 4111111111111111 ssn 123-45-6789',
      };
      const out = scrubValuesDeep(input, true) as typeof input;
      expect(out.message).toBe(`jane@example.com from 10.0.0.5 paid ${REDACTED} ssn ${REDACTED}`);
    });

    it('is fail-open on a pathological input (circular ref) — returns input untouched', () => {
      const circular: Record<string, unknown> = { message: 'a@b.com' };
      circular.self = circular;
      // Depth cap + try/catch must prevent a throw; never blows the stack.
      expect(() => scrubValuesDeep(circular, false)).not.toThrow();
    });

    it('skips oversized strings gracefully (perf guard)', () => {
      const big = 'x'.repeat(20_000) + ' jane@example.com';
      // Over MAX_SCAN_LEN → returned unchanged rather than scanned.
      expect(scrubStringValue(big, false)).toBe(big);
    });
  });

  describe('key-based redaction still works (regression)', () => {
    it('isSensitiveKey still flags password/token/cookie', () => {
      expect(isSensitiveKey('password')).toBe(true);
      expect(isSensitiveKey('x-api-key')).toBe(true);
      expect(isSensitiveKey('cookie')).toBe(true);
      expect(isSensitiveKey('username')).toBe(false);
    });

    it('redactMap replaces sensitive-keyed values with [REDACTED]', () => {
      const out = redactMap({ password: 'hunter2', note: 'ok' });
      expect(out).toEqual({ password: REDACTED, note: 'ok' });
    });
  });
});
