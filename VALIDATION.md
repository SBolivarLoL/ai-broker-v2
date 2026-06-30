# Validation record

Last reviewed against `main`: 2026-06-30.

This file records reproducible confidence evidence. It does not convert paper-only code, a report endpoint, or a checklist into production approval.

## Current automated evidence

| Check | Result on 2026-06-30 | Scope |
| --- | --- | --- |
| `bun run check` | Pass: 235 tests, 0 failures, 892 assertions across 58 files | Strict TypeScript plus all Bun tests |
| `bun run eval` | Pass: 39 tests, 0 failures, 175 assertions across 7 files | Broker safety, order state, security, agent grounding, and research trust boundaries |
| `bun test --coverage` | Pass: 96.62% functions, 96.98% lines | Imported deterministic TypeScript modules only |
| `bun audit` | Pass: no known vulnerabilities | Locked dependency graph at audit time |

Coverage is not application-wide. `src/server.ts` starts real process dependencies at import time and is not instrumented by the current tests; `src/index.html` is also outside Bun coverage. The high percentage must not be used to claim route or browser completeness.

## Test-layer policy

- Unit tests own deterministic calculations, schemas, policy, normalization, evidence, strategy plugins, and DTO behavior.
- Regression tests preserve specific failures such as malformed bars, missing lot basis, stale evidence, blocked strategy submissions, and post-fill accounting.
- System tests compose portfolio and strategy functions with in-memory SQLite without browser automation.
- Direct API tests should own authorization, origin checks, route parsing, status codes, response schemas, and error mapping. This layer is currently incomplete because the request handler is coupled to server startup.
- Browser/computer-use validation is reserved for rendering, layout, accessibility, responsive behavior, and interaction wiring. It should not be used to populate or verify backend state that can be exercised through functions or HTTP.

## Confidence by area

| Area | Current confidence | Evidence | Open gap |
| --- | --- | --- | --- |
| Risk and portfolio math | High at module level | Unit, regression, and portfolio system tests | No independent production reconciliation over a long account history |
| Order policy and signatures | High at module level | Preview, reservation, idempotency, replacement, cancellation, basket, option, short, and crypto tests | Route-level tests and real broker race drills are incomplete |
| Strategy decisions | High for deterministic plugin behavior | Strict configuration/default tests plus backtest, scheduler, paper policy, observability, replay, attribution, performance, and strategy system tests | No genuine out-of-sample walk-forward scoring or long paper cohort yet |
| Persistence and audit | Good for current schema | In-memory SQLite store, hash chain, ledger, journal, policy, export tests | Historical migration and backup restore fixtures are missing |
| Provider normalization | Good with fixtures | SEC, macro, GDELT, Finnhub, OpenFIGI, market-data fallback tests | Live provider contracts are not run in CI and point-in-time datasets are not persisted |
| Agents | Guardrails tested, runtime partially covered | Output schemas, citation/numeric checks, counter-thesis, Q&A validation | Live model/tool orchestration paths have lower coverage and require credentials |
| HTTP/API composition | Low to moderate | Some behavior is covered through called functions | `src/server.ts` has no side-effect-free request-handler test harness |
| Browser UI | Manual confidence only | Existing UI has been exercised during feature work | No maintained automated accessibility/responsive regression suite |
| Production operations | Code artifacts only | Readiness, backup export, incident packet, policy, auth, governance, beta report modules | No production deployment, restore drill, real participants, or external approval |

## Reproducible local gates

```sh
bun install --frozen-lockfile
bun run check
bun run eval
bun test --coverage
bun audit
```

CI currently runs install, `bun run check`, and `bun run eval` on pushes and pull requests. Coverage, audit, live-provider smoke checks, and browser checks are not CI gates.

## Credentialed smoke checks

These commands exercise real external paper/read-only integrations and should be run deliberately from a configured environment:

```sh
bun run alpaca:doctor
bun run smoke:read
bun run smoke:sec
bun run smoke:macro
bun run smoke:gdelt
bun run smoke:finnhub
bun run smoke:openfigi
bun run smoke:comparables
```

They were not rerun during the 2026-06-30 documentation audit, so this record makes no new claim about current provider availability.

The paper-order smoke test mutates only the Alpaca paper account and requires explicit opt-in:

```sh
SMOKE_ORDER=paper-confirm bun run smoke:order
SMOKE_ORDER=paper-confirm SMOKE_SIDE=sell SMOKE_SYMBOL=<owned-symbol> bun run smoke:order
```

It uses an intentionally unreachable limit, looks up the exact client order ID, cancels the returned broker order in `finally`, and fails unless cancellation reconciles. It must never target a live client.

## Verified invariants

- Alpaca clients are constructed with `paper: true`; no live client is available.
- Agents have no order submission, cancellation, credential, shell, CLI, or raw HTTP tool.
- Actionable advisor ideas require unexpired simulation authority matching symbol, side, quantity, policy, portfolio state, and the reviewed plan.
- Order confirmation reloads relevant broker and market state and rejects invalid signatures, expiry, drift, capacity, exposure, turnover, or incomplete evidence.
- Local reservations and working broker orders consume projected capacity, preventing concurrent order stacking.
- Strategy paper orders require explicit run approval and pass strategy-specific plus global operations policy.
- Strategy parameters are canonicalized through one strict per-strategy schema before backtests or saved runs; malformed or contradictory configuration fails closed.
- Missing or stale strategy data cannot pass by absence.
- Decision and strategy audit verification fails when a stored hash chain is inconsistent.
- Production readiness rejects incomplete proxy, secret-vault, preview-secret, or SEC identity configuration.
- Plaintext vault values are not returned by vault API reads.

## Remaining release gates

The following are not validated and remain open in `roadmap.md`:

1. Side-effect-free API integration coverage for the real request boundary.
2. Transactional historical migrations and a measured backup restore drill.
3. Persistent, point-in-time datasets and genuine walk-forward strategy evaluation.
4. At least 30 days of measured paper closed-beta evidence with all eight targets passing.
5. External legal/compliance and data-entitlement review.
6. Separate live deployment architecture and review. Live trading remains unavailable.

## Documentation-change validation

Documentation-only changes require:

- Internal links and referenced files exist.
- Commands match `package.json`.
- Environment variables match source reads and `.env.example`.
- Test counts and coverage claims come from a fresh run.
- Implemented, validated, and externally approved states are not conflated.
- No browser validation is required unless visible UI files changed.
