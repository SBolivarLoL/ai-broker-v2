# Validation record

Last reviewed against `main` commit `4da4baa`: 2026-07-07.

This file records reproducible confidence evidence. It does not convert paper-only code, a report endpoint, or a checklist into production approval.

## Current automated evidence

| Check              | Result on 2026-07-07                                                              | Scope                                                                                             |
| ------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `bun run check`    | Pass: 333 tests, 0 failures, 1,504 assertions across 81 files                     | Strict TypeScript for `backend/`, `tests/`, and `scripts/`, all Bun tests, and the coverage floor |
| `bun run eval`     | Pass: 41 tests, 0 failures, 184 assertions across 7 files                         | Broker safety, order state, security, agent grounding, and research trust boundaries              |
| `bun run coverage` | Pass: 97.99% functions, 96.98% lines against 95% function and 96% line thresholds | Mean coverage across imported deterministic TypeScript modules                                    |
| `bun audit`        | Pass: no known vulnerabilities                                                    | Locked dependency graph at audit time                                                             |

Coverage is not application-wide. `scripts/check-coverage.ts` averages Bun's per-module results for deterministic modules and excludes route composition, runtime/provider/model orchestration, process startup, and the browser. Those boundaries are covered through direct contracts, targeted integration tests, or separate browser validation instead of the percentage gate. `tsconfig.json` includes `backend/`, `tests/`, and `scripts/`, but static checking does not execute credentialed provider or paper-order smoke behavior.

## Repository review evidence

| Inventory     | Reviewed result                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| Documentation | One root README and project guidance, with product and architecture records under `docs/`                        |
| TypeScript    | 92 production modules and 80 files under `tests/` plus one coverage-gate test                                      |
| Concentration | `backend/app.ts` 351 lines; `backend/persistence/store.ts` 906 lines; browser behavior split across seven assets |
| Persistence   | 14 migrations; 23 tables including migration history                                                             |
| Governance    | 16 sources; 12 stored-output categories; every table assigned once                                               |
| Git baseline  | `main`, `dev`, `origin/main`, and `origin/dev` at `4da4baa`; no open pull request at change start                |

## Test-layer policy

- Unit tests own deterministic calculations, schemas, policy, normalization, evidence, strategy plugins, and DTO behavior.
- Regression tests preserve specific failures such as malformed bars, missing lot basis, stale evidence, blocked strategy submissions, and post-fill accounting.
- System tests compose portfolio and strategy functions with in-memory SQLite without browser automation.
- Direct API tests own common authorization, origin, body-size, parsing, status, schema, 404 and error-sanitization contracts without starting streams or a server port. Broker-backed happy paths still need incremental route coverage.
- Browser/computer-use validation is reserved for rendering, layout, accessibility, responsive behavior, and interaction wiring. It should not be used to populate or verify backend state that can be exercised through functions or HTTP.

## Confidence by area

| Area                        | Current confidence                                 | Evidence                                                                                                                                                                                                                | Open gap                                                                                                |
| --------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Risk and portfolio math     | High at module level                               | Unit, regression, and portfolio system tests                                                                                                                                                                            | No independent production reconciliation over a long account history                                    |
| Order policy and signatures | High for modules and primary order routes          | Direct primary order, mutation, option action, strategy paper, concurrent-capacity, recovery, and terminal stream-update contracts                                                                                      | Credentialed real broker drills remain opt-in                                                           |
| Strategy decisions          | High for deterministic plugin and lineage behavior | Strict configuration/default tests plus immutable versioned datasets, train-only rolling/anchored walk-forward scoring, final holdout isolation, regime-slice contracts, deterministic trade metrics, moving-block-bootstrap uncertainty ranges, friction calibration, compatible cohort comparison, pre-registered paper protocols, promotion evidence gates, leakage checks, linked runs, scheduler, paper policy, observability, replay, attribution, performance, direct API, and strategy system tests | No long paper cohort yet |
| Persistence and audit       | Good for current schema                            | Ordered transactional migrations through 0014, legacy upgrade fixture, immutable dataset/backtest constraints, rollback/mismatch checks, serialized restore, hash chains, ledger, journal, policy, and export tests   | No production-sized restore timing or closed-beta operations drill                                      |
| Provider normalization      | Good with fixtures                                 | SEC, macro, GDELT, Finnhub, OpenFIGI, market-data fallback tests, canonical time-provenance tests, equity, market-workspace, and multi-asset market DTO time-provenance tests, local provider-health evidence, plus deliberate live Alpaca/SEC reads           | Live provider contracts are not run in CI, not every DTO has the explicit time taxonomy, and point-in-time fundamentals are not persisted |
| Data governance and quality | Complete code inventory, external review open      | Unit and direct API tests cover 16 sources, 12 output categories, all 23 SQLite tables, references, terms URLs, fail-closed live-use decisions, provider-health status, and actor-scoped strategy dataset quality stats | Internal classifications are not legal approval; no automatic retention enforcement exists              |
| Agents                      | Guardrails tested, runtime partially covered       | Output schemas, citation/numeric checks, counter-thesis, Q&A validation                                                                                                                                                 | Live model/tool orchestration paths have lower coverage and require credentials                         |
| HTTP/API composition        | Moderate                                           | Dependency-injected `createApp`, in-memory SQLite, fake Alpaca, common contracts, strategy lineage flow, primary order routes, recovery retry, and selected concurrency tests                                           | Stream callbacks and secondary provider mutation paths remain incomplete                                |
| Operational scripts         | Good static confidence                             | Standard TypeScript/CI check plus a regression assertion that `scripts/` remains included; bounded smoke commands exist                                                                                                 | Most provider behavior requires credentials and is not executed in CI                                   |
| Browser UI                  | Targeted interaction confidence                    | The 2026-07-05 interaction check verified Strategy Lab creation flows; the 2026-07-06 isolated smoke rendered all seven workspaces at 1280×720 and 390×844 with correct selection/hash state, no mobile horizontal overflow, honest unavailable-provider fallbacks, and a clean console | No maintained automated accessibility/responsive regression suite                                       |
| Production operations       | Code artifacts plus fixture restore proof          | Readiness, backup export, incident packet, policy, auth, governance, beta report modules, and serialized restore test                                                                                                   | No production-sized or closed-beta restore drill, deployment, real participants, or external approval   |

## Full documentation and repository audit

The 2026-07-07 review inspected the affected documentation and checked its
commands, paths, configuration names, counts, capability statements, and status
language against `4da4baa` plus fresh command output.

| File | Audit disposition |
| ---- | ----------------- |
| `AGENTS.md` | Workflow, ownership, validation, roadmap, and safety rules match the repository; review baseline refreshed |
| `README.md` | Setup, layout, commands, runtime, paper-only boundary, and production configuration match source; command-specific symbol overrides added |
| `docs/FEATURES.md` | Capability, safety, persistence, governance, and limitation claims match source and tests; relative-strength peer derivation made explicit |
| `docs/STRATEGY_LAB.md` | Strategy catalog, defaults, lifecycle, endpoints, limits, and execution assumptions match source; API/UI timeframe scope clarified |
| `docs/VALIDATION.md` | Counts, line inventory, Git state, provider checks, browser evidence, and confidence gaps refreshed from this audit |
| `docs/roadmap.md` | Completed/open status remains consistent with code and external gates; one obsolete Alpaca reference corrected |
| `docs/architecture/README.md` | Every named module exists and the documented composition, feature, integration, persistence, and safety dependency direction matches imports |

Additional mechanical checks:

- All 10 relative Markdown links resolve to tracked files or directories.
- Twenty-three unique external Markdown links were requested. Twenty-two
  resolved as written; the only failure was the obsolete Alpaca historical API
  path, which this audit replaced with the current official URL.
- All 14 `package.json` scripts are represented accurately by the command
  reference or documented as internal composition (`start`, `coverage`, and
  the checks they invoke included).
- `.env.example` covers every runtime/server setting. The remaining source-read
  variables are deliberate command flags: `SMOKE_ORDER`, `SMOKE_SIDE`,
  `SMOKE_SYMBOL`, `SEC_SYMBOL`, and `RESEARCH_EVAL_SYMBOLS`.
- Fresh inventory checks found 92 production TypeScript modules, 80 files under
  `tests/`, one coverage-gate test under `scripts/`, 14 ordered migrations, 23
  SQLite tables, 16 governance sources, and 12 stored-output categories. Every
  table is assigned exactly once.
- Strategy API examples were checked against route methods, paths, status
  codes, parsing, and the direct in-memory API contracts.
- The data-quality service and `/api/operations/data-quality` route were
  checked with unit and direct API contracts for provider health, throttling,
  last-success timestamps, and immutable dataset freshness/completeness/
  integrity/revision stats.
- Canonical evidence, official macro evidence, and crypto Strategy Lab market
  DTOs were checked for explicit observation, publication, effective-period,
  retrieval, and server-response time provenance.
- Company-market snapshot and equity quote/bar stream DTOs were checked for
  explicit provider observation, retrieval, and server-response timestamps
  while preserving legacy browser compatibility fields.
- Multi-asset index, FX, and crypto DTOs were checked for explicit provider
  observation, retrieval, and per-response server timestamps; the route cache
  preserves provider retrieval time while refreshing server response time.
- Market workspace discovery, session guidance, and calendar DTOs were checked
  for explicit provider observation, effective-session periods, retrieval time,
  and per-response server timestamps; the route cache preserves provider
  retrieval time while refreshing server response time.

## Reproducible local gates

```sh
bun install --frozen-lockfile
bun run check
bun run eval
bun run coverage
bun audit
```

CI uses the Node 24-based `actions/checkout@v6`, pins Bun 1.2.15, and runs install, `bun run check`, and `bun run eval` on pushes and pull requests. Because `bun run check` invokes strict TypeScript for `backend/`, `tests/`, and `scripts/` plus `bun run coverage`, the static and coverage thresholds are CI gates. Audit, live-provider smoke checks, and browser checks are not CI gates.

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

This checkout has local Alpaca paper, SEC identity, and OpenAI credentials.
FRED, BEA, Finnhub, and OpenFIGI keys remain unconfigured. The complete
credentialed suite was not run; no availability claim is made for optional
key-gated providers or live OpenAI orchestration in this change.

The following read-only checks were run:

- `bun run alpaca:doctor` and `bun run smoke:read` passed against the configured
  paper account and data endpoints without creating or changing orders.
- A deliberate read-only crypto history check fetched 203 daily BTC/USD bars
  across three adjacent provider chunks spanning 2025-01-01 through 2025-07-20.
- `bun run smoke:sec` passed with the configured contact identity for AAPL
  filings, bounded sections, financial trends, and material-event alerts.
- `bun run smoke:macro` passed with live Treasury and BLS observations while
  preserving explicit `missing_key` states for FRED and BEA.
- `bun run smoke:openfigi` passed anonymously and mapped AAPL to canonical FIGI
  `BBG000B9XRY4`.
- `bun run smoke:finnhub` passed its missing-key contract without making a
  provider request.
- `bun run smoke:gdelt` passed its explicit rate-limit fallback: zero articles
  were returned with `rate_limited`, and the result warned that absence of
  events must not be inferred.

The isolated server/browser smoke used invalid placeholder broker credentials
and a separate temporary SQLite database. It verified `200 /health`, fail-closed
`503 /ready`, all seven static assets, provider-unavailable UI states, desktop
and mobile workspace navigation, and a clean browser console. It makes no live
Alpaca claim and did not touch the checkout's existing `data/app.db`.

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
- Walk-forward evaluation supports rolling and anchored out-of-sample modes, rejects malformed or overlapping regime slices, keeps candidate selection train-only, excludes final holdouts from fold selection, scores holdouts once with pre-holdout-selected parameters, and reports validation and holdout regime observations separately.
- Backtests emit deterministic `tradeMetrics` covering material simulated order count, position episodes, closed round trips, average holding time, gross/net returns, downside deviation, Sortino, Calmar, profit factor, hit rate, average win/loss, turnover, exposure, and capacity warnings; the direct API contract persists the shape.
- Backtests and walk-forward out-of-sample aggregates emit deterministic moving-block-bootstrap uncertainty evidence for total return and max drawdown, fail visibly as `insufficient_data` below 20 scored returns, and mark the range `not_rankable`; unit and direct API contracts cover the shape.
- Strategy execution replay emits deterministic friction calibration from paper receipt fill quality and order-book replay evidence, including fee/slippage/spread/latency evidence, partial/missed/missing-book rates, conservative recommended assumptions, user-override policy, and `insufficient_evidence` status below 20 replayed paper orders; unit and direct API contracts cover the shape.
- Backtest cohort comparison reports metric rows only with explicit compatibility checks for period, symbols, timeframe, dataset hash, friction model, baseline set, code/provider identity, and feed; pure unit and direct API contracts cover compatible and incompatible cohorts.
- Paper strategy approval requires a pre-registered experiment protocol with versioned immutable history, frozen parameters, hypothesis, start/stop window, minimum observations, maximum budget, invalidation criteria, and review cadence. Direct API and unit contracts cover missing protocol rejection, version append behavior, budget binding, parameter drift rejection, and order blocking outside the protocol window.
- Strategy promotion review now emits deterministic `strategy-promotion-evidence-v1` with `pass` or `needs_evidence`; promotion to `completed` requires paper status, at least 30 paper days, enough recorded decisions, and at least 20 filled orders. Direct API and unit contracts cover early rejection and pass evidence attached to review history.
- BTC/ETH relative strength derives the opposite peer from the ordered symbol pair; an ambiguous `peerSymbol` override is rejected at both the schema and direct API boundaries.
- Comparable strategy records require an immutable matching backtest and record exact Git/dirty state, plugin/feature/policy versions, query window, provider/feed, and normalized input hashes. Legacy or dirty records cannot be ticked or approved.
- Missing or stale strategy data cannot pass by absence.
- Decision and strategy audit verification fails when a stored hash chain is inconsistent.
- Migration identity drift stops startup, failed migration DDL and history roll back together, and serialized restores preserve both audit chains in the fixture drill.
- Every current SQLite table belongs to exactly one stored-output category; every external source is blocked or requires external review for live use.
- Provider-health and stored-dataset quality reports expose local event and immutable dataset evidence, but do not imply entitlement approval or successful live provider probes.
- Canonical evidence, crypto Strategy Lab market DTOs, company-market snapshots, market workspace discovery/calendar DTOs, equity quote/bar stream DTOs, and multi-asset market DTOs preserve retrieval/server-response timestamps separately from provider observation timestamps; official macro evidence records effective periods for dated, monthly, quarterly, and market-session calendar observations.
- Production readiness rejects incomplete proxy, secret-vault, preview-secret, or SEC identity configuration.
- Plaintext vault values are not returned by vault API reads.

## Remaining release gates

The following are not validated and remain open in `roadmap.md`:

1. A timed production-sized restore and a closed-beta operations restore drill.
2. Point-in-time research datasets and long paper strategy evidence.
3. At least 30 days of measured paper closed-beta evidence with all eight targets passing.
4. External legal/compliance and data-entitlement review.
5. Separate live deployment architecture and review. Live trading remains unavailable.

## Documentation-change validation

Documentation-only changes require:

- Internal links and referenced files exist.
- Commands match `package.json`.
- Environment variables match source reads and `.env.example`.
- Test counts and coverage claims come from a fresh run.
- Provider and table changes remain consistent with the data-governance registry.
- Implemented, validated, and externally approved states are not conflated.
- No browser validation is required unless visible UI files changed.
