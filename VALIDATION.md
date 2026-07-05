# Validation record

Last reviewed against `main` commit `aae2b30`: 2026-07-05.

This file records reproducible confidence evidence. It does not convert paper-only code, a report endpoint, or a checklist into production approval.

## Current automated evidence

| Check | Result on 2026-07-05 | Scope |
| --- | --- | --- |
| `bun run check` | Pass: 268 tests, 0 failures, 1,164 assertions across 62 files | Strict TypeScript for `src/` and `scripts/`, all Bun tests, and the coverage floor |
| `bun run eval` | Pass: 39 tests, 0 failures, 177 assertions across 7 files | Broker safety, order state, security, agent grounding, and research trust boundaries |
| `bun run coverage` | Pass: 96.31% functions, 96.76% lines against 95% function and 96% line thresholds | Imported deterministic and request-handler TypeScript modules |
| `bun audit` | Pass: no known vulnerabilities | Locked dependency graph at audit time |

Coverage is not application-wide. `scripts/check-coverage.ts` enforces the reviewed floor only for TypeScript modules imported by the Bun test suite. `src/app.ts` is instrumented at 43.30% of functions and 84.23% of lines; the process entry and `src/index.html` browser client remain outside Bun coverage. `tsconfig.json` includes `src/` and `scripts/`, but static checking does not execute credentialed provider or paper-order smoke behavior. Browser confidence is reported separately through UI-specific validation, and the overall percentage must not be used to claim route or browser completeness.

## Repository review evidence

| Inventory | Reviewed result |
| --- | --- |
| Documentation | Six tracked root Markdown files; no separate later-features file |
| TypeScript | 59 production modules and 62 test files |
| Concentration | `app.ts` 2,505 lines; `store.ts` 797 lines; `index.html` 255,758 bytes |
| Persistence | 13 migrations; 21 tables including migration history |
| Governance | 16 sources; 12 stored-output categories; every table assigned once |
| Git state at review | `main`, `dev`, `origin/main`, and `origin/dev` all at `aae2b30`; no open PR or stale feature branch before this increment |

## Test-layer policy

- Unit tests own deterministic calculations, schemas, policy, normalization, evidence, strategy plugins, and DTO behavior.
- Regression tests preserve specific failures such as malformed bars, missing lot basis, stale evidence, blocked strategy submissions, and post-fill accounting.
- System tests compose portfolio and strategy functions with in-memory SQLite without browser automation.
- Direct API tests own common authorization, origin, body-size, parsing, status, schema, 404 and error-sanitization contracts without starting streams or a server port. Broker-backed happy paths still need incremental route coverage.
- Browser/computer-use validation is reserved for rendering, layout, accessibility, responsive behavior, and interaction wiring. It should not be used to populate or verify backend state that can be exercised through functions or HTTP.

## Confidence by area

| Area | Current confidence | Evidence | Open gap |
| --- | --- | --- | --- |
| Risk and portfolio math | High at module level | Unit, regression, and portfolio system tests | No independent production reconciliation over a long account history |
| Order policy and signatures | High for modules and primary order routes | Direct primary order, replacement, exact/cancel-all cancellation, concurrent-capacity, and recovery-reconciliation contracts | Option-position actions, strategy paper execution, and real broker drills remain incomplete |
| Strategy decisions | High for deterministic plugin and lineage behavior | Strict configuration/default tests plus immutable backtest, linked run, dataset hash, scheduler, paper policy, observability, replay, attribution, performance, direct API, and strategy system tests | No genuine out-of-sample walk-forward scoring, versioned long-history dataset, or long paper cohort yet |
| Persistence and audit | Good for current schema | Ordered transactional migrations through 0013, legacy upgrade fixture, immutable backtest constraints, rollback/mismatch checks, serialized restore, hash-chain verification, ledger, journal, policy, and export tests | No production-sized restore timing or closed-beta operations drill |
| Provider normalization | Good with fixtures | SEC, macro, GDELT, Finnhub, OpenFIGI, market-data fallback tests | Live provider contracts are not run in CI and point-in-time datasets are not persisted |
| Data governance | Complete code inventory, external review open | Unit and direct API tests cover 16 sources, 12 output categories, all 21 SQLite tables, references, terms URLs, and fail-closed live-use decisions | Internal classifications are not legal approval; no automatic retention enforcement exists |
| Agents | Guardrails tested, runtime partially covered | Output schemas, citation/numeric checks, counter-thesis, Q&A validation | Live model/tool orchestration paths have lower coverage and require credentials |
| HTTP/API composition | Moderate | Dependency-injected `createApp`, in-memory SQLite, fake Alpaca, common contracts, strategy lineage flow, primary order routes, recovery retry, and selected concurrency tests | Stream callbacks and secondary provider mutation paths remain incomplete |
| Operational scripts | Good static confidence | Standard TypeScript/CI check plus a regression assertion that `scripts/` remains included; bounded smoke commands exist | Most provider behavior requires credentials and is not executed in CI |
| Browser UI | Targeted interaction confidence | Isolated 2026-07-05 browser check verified disabled creation, successful backtest unlock, linked shadow creation, input invalidation, layout, and a clean console | No maintained automated accessibility/responsive regression suite |
| Production operations | Code artifacts plus fixture restore proof | Readiness, backup export, incident packet, policy, auth, governance, beta report modules, and serialized restore test | No production-sized or closed-beta restore drill, deployment, real participants, or external approval |

## Reproducible local gates

```sh
bun install --frozen-lockfile
bun run check
bun run eval
bun run coverage
bun audit
```

CI uses the Node 24-based `actions/checkout@v6`, pins Bun 1.2.15, and runs install, `bun run check`, and `bun run eval` on pushes and pull requests. Because `bun run check` invokes strict TypeScript for `src/` and `scripts/` plus `bun run coverage`, the static and coverage thresholds are CI gates. Audit, live-provider smoke checks, and browser checks are not CI gates.

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
bun run eval:research
```

The full smoke suite was not rerun during this 2026-07-05 review. The isolated UI check performed one read-only Alpaca crypto backtest; this record makes no broader claim about provider availability.

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
- Failed equity placement releases the pending submission and reservation so the same idempotency key can retry; released and expired reservation rows no longer strand capacity.
- Concurrent standard equity submissions are serialized through SQLite reservation validation and cannot cross the rolling-turnover limit.
- Basket submissions reserve every leg before placement, persist complete or partial receipts, preserve HTTP 207 on replay, and do not expose raw broker failure text.
- Strategy paper orders require explicit run approval and pass strategy-specific plus global operations policy.
- Strategy parameters are canonicalized through one strict per-strategy schema before backtests or saved runs; malformed or contradictory configuration fails closed.
- Comparable strategy records require an immutable matching backtest and record exact Git/dirty state, plugin/feature/policy versions, query window, provider/feed, and normalized input hashes. Legacy or dirty records cannot be ticked or approved.
- Missing or stale strategy data cannot pass by absence.
- Decision and strategy audit verification fails when a stored hash chain is inconsistent.
- Migration identity drift stops startup, failed migration DDL and history roll back together, and serialized restores preserve both audit chains in the fixture drill.
- Every current SQLite table belongs to exactly one stored-output category; every external source is blocked or requires external review for live use.
- Production readiness rejects incomplete proxy, secret-vault, preview-secret, or SEC identity configuration.
- Plaintext vault values are not returned by vault API reads.

## Remaining release gates

The following are not validated and remain open in `roadmap.md`:

1. Direct API contracts for option-position actions, strategy paper execution, and stream callbacks.
2. A timed production-sized restore and a closed-beta operations restore drill.
3. Versioned long-history, point-in-time datasets and genuine walk-forward strategy evaluation.
4. At least 30 days of measured paper closed-beta evidence with all eight targets passing.
5. External legal/compliance and data-entitlement review.
6. Separate live deployment architecture and review. Live trading remains unavailable.

## Documentation-change validation

Documentation-only changes require:

- Internal links and referenced files exist.
- Commands match `package.json`.
- Environment variables match source reads and `.env.example`.
- Test counts and coverage claims come from a fresh run.
- Provider and table changes remain consistent with the data-governance registry.
- Implemented, validated, and externally approved states are not conflated.
- No browser validation is required unless visible UI files changed.
