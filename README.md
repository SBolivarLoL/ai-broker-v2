# AI Broker

AI Broker is a paper-only personal investing workstation built with Bun, TypeScript, Alpaca, SQLite, and the OpenAI Agents SDK. It combines portfolio analytics, research, guarded paper-order workflows, and a crypto Strategy Lab for backtests, shadow runs, and bounded paper experiments.

Live trading is intentionally unavailable. Every broker client is constructed with `paper: true`.

Code baseline reviewed: `main` at `777b003` on 2026-07-12.

## Quick start

Requirements: [Bun 1.2.15](https://bun.sh/) and an Alpaca paper account. Coverage metrics are runtime-sensitive, so local and CI checks use the pinned version.

## Project layout

- `frontend/` contains browser assets.
- `backend/features/` contains domain behavior.
- `backend/integrations/` contains provider adapters.
- `backend/persistence/` contains SQLite storage.
- `tests/` mirrors the backend boundaries.
- `scripts/` contains smoke checks and diagnostics.
- `docs/architecture/` explains dependency direction and placement rules.

```sh
bun install
cp .env.example .env
# Add Alpaca paper credentials, a real SEC contact identity, and a 32+ character PREVIEW_SECRET.
bun start
```

Open `http://localhost:3000`. Set `PORT` to use another port.

The minimum local configuration is:

```dotenv
APCA_API_KEY_ID=your-paper-key
APCA_API_SECRET_KEY=your-paper-secret
PREVIEW_SECRET=replace-with-at-least-32-random-characters
SEC_USER_AGENT=ai-broker-v2 your-monitored-email@example.com
```

`OPENAI_API_KEY` is optional. Without it, deterministic broker, portfolio, market, research-source, and Strategy Lab features still work; AI Advisor and generated company analysis return an explicit unavailable response.

Optional provider keys are `FRED_API_KEY`, `BEA_USER_ID`, `FINNHUB_API_KEY`, and `OPENFIGI_API_KEY`. Production proxy settings, scheduler controls, model selection, portfolio benchmark, and deployed-build identity are documented in [`.env.example`](.env.example). Local secrets and SQLite files are ignored by Git.

## What is included

- Alpaca paper account, positions, orders, activities, watchlists, asset search, market clock, calendar, IEX market data, single-symbol quotes, market monitoring, company-market snapshots, market workspace DTOs, and entitled multi-asset market snapshots. Account/position state, account-activity roots/rows, managed orders and nested legs, order-list recovery state, cancel-all previews, watchlists and their asset entries, cached asset-search results, market-workspace aggregates, company metadata/quote/session/stats/benchmark/bar/news children, and the other migrated provider DTOs expose explicit observation/retrieval/server-response provenance. Watchlist observation uses the provider update time while asset-master, account, and position observations remain null because those endpoints do not provide an event timestamp.
- Signed equity, linked, basket, short, option, and crypto paper-order previews with fresh-state confirmation, idempotency, receipts, and global operations policy.
- Portfolio performance, FIFO ledger, risk, exposure, scenarios, optimizer proposals, and constrained rebalance planning. Account-activity root, row, FIFO-summary, and quality DTOs distinguish trade execution observation, provider record creation/publication, non-trade occurrence-or-settlement effective dates, durable broker-read retrieval, cache reuse, and per-response server time; pre-0015 rows retain explicit provenance gaps until the broker returns them again. Portfolio-optimizer root, proposal, weight, coverage, input, and quality DTOs distinguish current-account retrieval, IEX daily-bar observations/effective windows/retrieval, and response time. Optimizer histories must have enough fresh observations; malformed, conflicting, stale, future-dated, ineligible, and omitted inputs remain visible with their effect on proposals. Portfolio-performance root, summary, daily point, benchmark, attribution, and quality DTOs distinguish portfolio-history observations/retrieval, current-position retrieval, benchmark-bar observations/retrieval, and server response; an unqueried benchmark exposes null retrieval. Portfolio-risk root, current-state inputs, position histories, IEX quotes, SPY benchmark, advanced analytics, liquidity, allocation, stress, and quality DTOs distinguish provider observation/effective windows from staged retrieval and response time, identify the actual historical-bar fallback feed, and report missing inputs explicitly. Portfolio-exposure root, asset-class/SIC/factor aggregates, positions, provider inputs, sources, cache state, and quality DTOs preserve current-state, IEX-bar, SEC-classification, retrieval, effective-window, and response semantics while surfacing failed, unqueried, malformed, unsupported, and omitted inputs. Portfolio-scenario root, scenario, position, input, and quality DTOs retain that exposure evidence, refresh only response time, report expected/received/omitted modeling coverage and conclusion impact, and exclude stale, future-dated, or missing volatility history from the volatility shock. Constrained-rebalance root, summary, scale, tax, leg, projected-position, input, and quality DTOs distinguish broker/account/activity/policy retrieval, IEX latest-trade observation, calculation, and response time; stale, future-dated, unobserved, or malformed prices fail closed, and incomplete turnover/tax evidence remains visible. Current and historical portfolio-snapshot DTOs preserve their original broker-read capture time across local persistence, refresh delivery time, separate order-stream observation from REST recovery retrieval, and expose legacy or malformed persisted provenance instead of inventing it.
- SEC filings and company facts, official US macro context, Alpaca/Benzinga news, GDELT signals, optional Finnhub enrichment, and OpenFIGI identity checks with canonical source/time provenance. SEC classification, recent-filing, filing-evidence/section, company-facts result, and material-alert DTOs preserve applicable filing-date publication, report-date effective-period, provider-retrieval, and server-response time; malformed or misaligned filing rows are omitted before URL/time construction. `GET /api/research/sec?symbol=AAPL&asOf=2025-06-30` applies an end-of-day SEC filing-date cutoff before selecting facts or trends and removes later filings, amendments, and sections while reporting exact exclusion counts. Dates must be real, non-future `YYYY-MM-DD` values. Historical SIC remains unavailable because current submissions expose no classification history. Treasury/BLS/FRED/BEA macro root, provider-coverage, indicator, and canonical-evidence DTOs distinguish Treasury publication dates, FRED observation dates, BLS monthly and BEA quarterly effective periods, provider retrieval, and server-response time. A partial BLS response retains usable requested series with `partial` coverage, invalid Treasury rows cannot discard independent valid rows, and FRED vintage revisions are grouped by observation date; unqueried or failed macro providers expose null retrieval. GDELT, Finnhub, and OpenFIGI provider DTOs preserve their applicable taxonomy; their canonical sources set provider observation explicitly unavailable instead of inheriting publication, effective, or retrieval time. Every canonical-evidence constructor must now declare observation, publication, effective-period, retrieval, and server-response semantics explicitly at compile time and runtime; omitted fields fail closed. Cached SEC/macro/GDELT/Finnhub/OpenFIGI data retains its provider retrieval time while refreshing per-response server time, and unqueried optional-provider states expose retrieval as unavailable. The five visible SEC, macro, GDELT, Finnhub, and OpenFIGI reports each expose expected/received/omitted evidence, semantic-time freshness, missing inputs, and conclusion impact.
- Evidence-bound portfolio Q&A, company research, comparable valuations, valuation scenarios, counter-thesis review, and trade journal. Portfolio-question v2 and portfolio-plan v2 responses expose phase-labeled typed-tool evidence records, normalized observation/publication/effective/retrieval/response time, grounded claim/idea/review coverage, and exact local simulation-authority coverage; retrieval-only provider records stay partial with explicit impact on time-sensitive interpretation. Saved portfolio-plan v2 payloads also retain only the exact cited, allow-listed proposal and independent-review tool snapshots in deterministic phase/evidence order, with per-snapshot and replay-manifest SHA-256 hashes; duplicate evidence IDs fail closed, and simulation snapshots include the authority state used by the guardrail. Company-research v2 responses persist the exact generated output and canonical source set in a hashed replay manifest plus normalized time and visible expected/received/omitted coverage for five tools, required and supplemental evidence categories, cited claims, numeric grounding, and source-time records. `POST /api/research/runs/{runId}/replay` verifies the manifest, unique source identities, every source payload hash, frozen run/symbol identity, and original deterministic metrics, then recomputes grounding and coverage with zero provider or model requests; legacy or altered artifacts fail closed. Comparable and scenario v3 contracts distinguish SEC filing publication/effective periods, provider retrieval, market observation, local calculation, and response time. Historical comparable runs use only the final eligible IEX daily close and SEC facts filed by the requested day. Historical scenario runs inherit that exact parent evidence, persist the original ordered assumptions and memo, and recompute with zero provider requests after parent, source, manifest, and deterministic-output verification. Historical prices are exposed as `referencePrice`, never mislabeled current; historical SIC remains explicitly unavailable.
- Immutable crypto backtests linked to shadow and scheduled runs, versioned long-history bar datasets, train-only rolling/anchored walk-forward evaluation with untouched holdouts, regime slices, trade metrics, uncertainty ranges, compatible cohort comparison, pre-registered bounded paper experiments, exact dataset/code provenance, trace reconstruction, alerts, attribution, friction calibration, promotion evidence gates, and reports. The comparison workspace renders bounded, timestamp-aligned equity-return and drawdown charts, full-sample and out-of-sample uncertainty evidence, decision counts, and explicit promotion blockers without converting uncertainty into a ranking. Strategy dashboard v2 roots expose visible expected/received/omitted coverage and normalized market-observation, local-retrieval, and response time for lineage, decisions, traces, per-symbol snapshots, freshness, and applicable paper execution evidence.
- SQLite persistence with ordered transactional migrations, hash-chained decision records, serialized backups, encrypted secret envelopes, readiness exports, paper-beta evidence reporting, a source/output governance registry, local provider/dataset quality reporting, durable scheduled reconciliation evidence, and selective transactional retention pruning. Recorded/redacted provider fixtures cover every external governance source and exercise malformed payloads, partial responses, throttling, revisions, and timestamp edges without committing credentials, private account state, or licensed article/market values. Retention bounds raw strategy snapshots, aged order-book depth, repeated metrics, local spans, and research/provider evidence while preserving decision references, active-run latest snapshots, latest metric samples, replay parents, and both audit chains. Every reconciliation run cross-checks account and position values, bulk and per-order broker reads, and bounded IEX latest versus historical minute-bar endpoints for current position/open-order symbols. It records discrepancies and recovery outcomes without creating broker authority; the two bar paths are endpoint-independent, not a second market-data provider.
- A dark operator-workstation browser shell with a persistent desktop rail, compact tablet rail, horizontally discoverable mobile navigation, global data-health/environment/execution status, private-value masking, accessible confirmation dialogs, strategy-specific experiment controls, explicit option-chain coverage warnings, and calculation-level evidence panels for every research report, Advisor Q&A/rebalance reports, strategy runs, valuations, the account-activity ledger, portfolio risk, exposure, snapshots, performance, scenarios, optimization, and constrained rebalancing.

The application currently runs as one Bun process with a local SQLite database at `data/app.db`. Strategy, reconciliation, and retention schedulers are in-process, so the server must remain running for scheduled work.

## Architecture at a glance

- `backend/server.ts` starts the Bun process; `backend/app.ts` composes the dependency-injected HTTP application.
- `backend/features/` groups product behavior and route handlers by bounded context.
- `backend/integrations/`, `backend/persistence/`, and `backend/shared/` isolate provider, storage, and cross-cutting code.
- `frontend/` separates the browser shell, styles, shared utilities, and workspace scripts.
- `tests/` mirrors the backend boundaries; `scripts/` contains deliberate diagnostics and smoke checks.

Feature routes are independently owned, persistence uses ordered migrations, and the browser is split into nine shell/style/script assets instead of one inline client. The current repository inventory is recorded in [`docs/VALIDATION.md`](docs/VALIDATION.md).

## Quality snapshot

| Boundary              | Reviewed state                                                                                                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automated checks      | The standard and focused safety suites pass; strict TypeScript covers `backend/`, `tests/`, and `scripts/`                                                                                                                                                     |
| Instrumented coverage | The reviewed deterministic-module mean passes the 95% function and 96% line floors                                                                                                                                                                             |
| API composition       | Primary orders, mutations, option actions, strategy paper execution, recovery, and runtime trade updates are directly covered; concurrent capacity is transactional                                                                                            |
| Data quality          | Provider health, strategy dataset quality, canonical time provenance, scheduled reconciliation, provider contracts, and selective bounded retention/pruning are implemented; external entitlement review remains separate |
| Browser               | Targeted all-workspace dark-workstation, desktop/tablet/mobile, Strategy Lab, option coverage, privacy, and modal keyboard validation exists; no maintained browser regression suite                                                                           |
| Persistence           | Transactional migrations through 0015 and a serialized fixture restore pass, including versioned strategy datasets and account-activity time provenance                                                                                                         |
| Production            | Paper-only; legal, entitlement, closed-beta, restore-drill, and live-deployment gates remain open                                                                                                                                                              |

See [`docs/VALIDATION.md`](docs/VALIDATION.md) for evidence and scope. Coverage is not application-wide: orchestration, the browser, and the process entry are outside the percentage gate, and credentialed smoke behavior is not exercised in CI.

## Commands

```sh
bun run check             # strict TypeScript, all tests, and the deterministic coverage floor
bun run eval              # focused broker safety and agent trust-boundary suite
bun run eval:research     # credentialed live research evaluation
bun run coverage          # 95% function / 96% line coverage gate
bun audit                 # dependency vulnerability audit
bun run alpaca:doctor     # independent Alpaca paper/API diagnostic
bun run smoke:read        # live read-only account, position, and open-order checks
bun run smoke:sec         # live SEC extraction and provenance check
bun run smoke:macro       # live official macro-provider check
bun run smoke:gdelt       # live GDELT signal/fallback check
bun run smoke:finnhub     # missing-key or configured Finnhub check
bun run smoke:openfigi    # live OpenFIGI identity/fallback check
bun run smoke:comparables # live Alpaca plus SEC valuation check
```

Run or inspect the bounded read-only reconciliation locally with:

```sh
curl -X POST http://localhost:3000/api/operations/reconciliation
curl http://localhost:3000/api/operations/reconciliation
```

The POST route is admin-only under production proxy authorization. The GET
route is available to operators and admins. `RECONCILIATION_DISABLED=1`
disables only its recurring timer; `RECONCILIATION_POLL_MS` defaults to 900000
milliseconds and values below 60000 are ignored.

Preview or run selective retention pruning locally with:

```sh
curl http://localhost:3000/api/operations/retention
curl -X POST http://localhost:3000/api/operations/retention
```

The GET route is operator/admin readable and reports policy, cutoffs, eligible
counts, lineage protections, and durable run evidence. The POST route is
admin-only. `RETENTION_DISABLED=1` disables only the daily timer;
`RETENTION_POLL_MS` defaults to 86400000 and values below one hour are ignored.
The individual day/hour windows and bounded batch size are documented in
[`.env.example`](.env.example).

`SEC_SYMBOL` overrides the default `AAPL` SEC smoke symbol.
`RESEARCH_EVAL_SYMBOLS` overrides the default `AAPL,MSFT,NVDA` live research
evaluation set.

Create and provider/model-free replay a generated company-research report with:

```sh
curl -X POST http://localhost:3000/api/research/runs \
  -H 'content-type: application/json' \
  -d '{"symbol":"AAPL"}'
curl -X POST http://localhost:3000/api/research/runs/<run-id>/replay
```

Creation requires `OPENAI_API_KEY`; replay reads only the persisted generated
output and canonical sources. A legacy run without a replay manifest or any
integrity, identity, source-hash, or deterministic-metric mismatch returns 409.

Create and replay a persisted point-in-time comparable valuation with:

```sh
curl -X POST http://localhost:3000/api/research/valuation-runs \
  -H 'content-type: application/json' \
  -d '{"symbol":"AAPL","peers":["MSFT"],"asOf":"2025-05-15"}'
curl -X POST http://localhost:3000/api/research/valuation-runs/<run-id>/replay
curl -X POST http://localhost:3000/api/research/valuation-runs/<run-id>/scenarios \
  -H 'content-type: application/json' \
  -d '{"scenarios":{"bear":{"revenueGrowthPercent":-10,"netMarginPercent":8,"priceToEarnings":8},"base":{"revenueGrowthPercent":0,"netMarginPercent":10,"priceToEarnings":10},"bull":{"revenueGrowthPercent":10,"netMarginPercent":12,"priceToEarnings":12}}}'
curl -X POST http://localhost:3000/api/research/scenario-runs/<scenario-run-id>/replay
```

The valuation creation route accepts one subject, one to four distinct peers,
and a real, non-future `YYYY-MM-DD` cutoff. Scenario assumptions must remain
ordered from bear through bull. Both replay routes read stored canonical
artifacts and do not call Alpaca or SEC again.

The mutating smoke test is opt-in and paper-only. It creates an unreachable limit order and cancels the exact returned order ID:

```sh
SMOKE_ORDER=paper-confirm bun run smoke:order
SMOKE_ORDER=paper-confirm SMOKE_SIDE=sell SMOKE_SYMBOL=<owned-symbol> bun run smoke:order
```

## Documentation

- [`docs/FEATURES.md`](docs/FEATURES.md): implemented capabilities, architecture, safety, data contracts, and known limitations.
- [`docs/STRATEGY_LAB.md`](docs/STRATEGY_LAB.md): strategy catalog, experiment workflow, controls, API examples, and interpretation guidance.
- [`docs/VALIDATION.md`](docs/VALIDATION.md): reproducible evidence, current test results, coverage boundary, and remaining confidence gaps.
- [`docs/roadmap.md`](docs/roadmap.md): prioritized future work, data-quality plan, strategy research plan, and external gates.
- [`docs/architecture/README.md`](docs/architecture/README.md): repository boundaries and dependency direction.
- [`AGENTS.md`](AGENTS.md): project-specific contribution and validation rules for AI-assisted work.

## Production boundary

Setting `NODE_ENV=development` (or `test`) grants the demo actor all roles; any other value, including unset, uses the strict production path. Production expects a managed OIDC identity-aware proxy, same-origin requests, role headers, a 32+ character proxy secret, a 32+ character secret-vault key, and a non-placeholder SEC contact identity. See `.env.example` and [`docs/FEATURES.md`](docs/FEATURES.md) for the full boundary.

Source checkouts resolve the running Git commit automatically. Packaged deployments without `.git` metadata must set `APP_GIT_COMMIT` to the full build commit; builds marked dirty are retained for audit but cannot seed comparable strategy runs.

This software is an experimental paper-trading tool, not legal, tax, or investment advice. Paper results do not establish live performance or fill quality.
