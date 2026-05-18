# Changelog

All notable changes to @allstak/fastify will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.1.0-beta.4] — 2026-05-18

### Consolidation
Lands the full SDK source on the canonical AllStak repo (`redaction.ts`, `version.ts`, full `index.ts`, full test files). Prior betas were built from source files that never made it to `AllStak/allstak-fastify` on git.

### Added — Transport-level wire scrub + canonical denylist parity
- `redaction.ts` extended with 7 canonical terms: bearer, jwt, pwd, credit_card, card_number, cvv, ssn.
- `FastifyTransport.sendOnce` scrubs full payload before `JSON.stringify` — defense-in-depth. Pure, fail-open.

### Live canary E2E
- Event `2420ed8c-3c2a-4c48-85d3-7d47b9d35400` against `api.allstak.sa`. ClickHouse `leak_pos = 0` across all columns. Canary `should_not_leak_fastify` in 11 fields + 3-level-nested token — all scrubbed.

### Tests
- 16/16 vitest pass.

## [0.1.0-beta.1] - 2026-04-25

### Added
- Initial public release.
