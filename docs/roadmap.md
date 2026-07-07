# AI Broker product roadmap

Last reviewed against `main` commit `9c7c373`: 2026-07-07.

This is the only future-work inventory for AI Broker. It incorporates the former `LATER_FEATURES.md` and `future-improvements.md` lists. Current behavior belongs in `FEATURES.md`; completed validation evidence belongs in `VALIDATION.md`.

## Status rules

- `[x] Implemented`: code exists in the repository.
- `[ ] Planned`: implementation or measured evidence is still missing.
- `External gate`: completion requires evidence outside the codebase.
- A schema, policy, report, endpoint, or UI panel is not proof that the represented operational process occurred.

## Review baseline

The 2026-07-06 audit found a capable deterministic core and a large difference between module-level confidence and whole-application confidence.

| Area                  | Current state                                                                                                                                                                                           | Evidence / implication                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository            | Feature-owned routes, split browser assets, one migration registry, and SQLite persistence; current counts live in `VALIDATION.md` | Frontend, backend, tests, scripts, docs, architecture, integrations, and persistence now have explicit homes                     |
| Automated checks      | Strict TypeScript plus standard and focused safety/evaluation suites                                                           | `bun run check` and `bun run eval` pass; current counts live in `VALIDATION.md` and CI enforces the gates    |
| Instrumented coverage | The reviewed deterministic-module boundary passes its floors                                                                  | Floors remain 95% functions and 96% lines; exact results live in `VALIDATION.md`                            |
| Dependency audit      | No known vulnerabilities                                                                                                       | `bun audit` passes; the dated result lives in `VALIDATION.md`                                               |
| Execution             | Alpaca paper only, signed previews, fresh revalidation, idempotency, receipts, risk reservations, global policy                                                                                         | Strong fail-closed order boundary                                                                                                                                         |
| Research data         | SEC, Alpaca/IEX, Treasury, BLS, optional FRED/BEA/Finnhub, GDELT, OpenFIGI, and optional OpenAI                                                                                                         | The registry covers 16 sources and all 23 SQLite tables through 12 output categories; provider health, strategy dataset quality, canonical evidence time provenance, and migrated market DTO time provenance are visible from local evidence, while full DTO migration, retention enforcement, and external entitlement review remain open |
| Strategy research     | Nine deterministic plugins, immutable linked backtests, versioned long-history crypto bars, rolling/anchored train-only walk-forward evaluation with final holdouts, regime slices, trade metrics, uncertainty ranges, compatible cohort comparison, pre-registered shadow/paper runs, traces and attribution                      | Exact lineage, per-fold leakage checks, final-holdout isolation, report-only regime summaries, deterministic trade metrics, not-rankable bootstrap uncertainty evidence, paper-friction calibration, protocol-gated approval, promotion evidence gates, and compatibility warnings are enforced; long paper evidence remains open                                  |
| Operations            | OIDC proxy contract, roles, encrypted envelopes, ordered migrations, backup/export endpoints, audit chains, beta report                                                                                 | Fixture upgrade/restore is proven; production-sized and closed-beta drills remain external work                                                                           |
| Live trading          | Unavailable by construction                                                                                                                                                                             | Remains blocked by legal, data, beta, and deployment reviews                                                                                                              |

## Product principles

1. Paper trading remains the only execution mode until every external gate is deliberately completed.
2. Deterministic code owns accounting, risk, strategy decisions, and order authorization. Agents explain and draft only.
3. Every financial output identifies source, feed, observation time, retrieval time, assumptions, and missing-data state where available.
4. Every order is previewed, explicitly approved, freshly revalidated, idempotent, reconciled, and attached to a receipt.
5. Strategy automation progresses from backtest to shadow to bounded paper approval. A profitable backtest alone earns no promotion.
6. Paper results are experiments, not proof of live edge. Evaluation includes realistic costs, baselines, unseen periods, and enough elapsed time.
7. Backend changes are tested through code/API boundaries. Browser automation is used only to validate visible UI behavior.
8. External review status is never inferred from code completeness.

## Priority 0: correctness and testable boundaries

These items should land before broadening strategy automation or adding more UI surface.

1. [x] Extract a side-effect-free `createApp(dependencies)` request handler into `backend/app.ts`; `backend/server.ts` now owns only Alpaca/store construction, process handling, `Bun.serve`, runtime stream/scheduler startup, and logging.
2. [x] Add direct API contract tests for authentication/roles across operations, orders, strategy, research and portfolio routes plus mutation origin, request-size limits, malformed JSON, strategy parsing, stable response schemas, 404 behavior and sanitized 502 mapping.
3. [x] Define one validated schema and default set per strategy. Unknown, non-finite, contradictory, and out-of-range parameters now fail before backtest or run creation, and saved runs persist canonical defaults.
4. [x] Reconcile the Strategy Lab input with the server's shared 1-90 day crypto-history bound and retain a regression test that prevents the browser/server limits from drifting.
5. [x] Replace migration metadata-only behavior with an append-only ordered registry whose DDL and history record commit in one transaction. An 0011 fixture upgrades without losing legacy ledger/snapshot rows, failed migrations roll back, and a serialized backup starts with both audit chains valid.
6. [x] Publish `bun run coverage` with reviewed 95% function and 96% line thresholds for imported deterministic/request code, enforce it through `bun run check` in CI, and report the uninstrumented browser client separately.
7. [x] Persist exact Git commit, dirty state, plugin version, feature-schema version, policy version, query window, provider/feed, and input dataset hashes on immutable backtests, linked runs, snapshots, and decisions. Legacy and dirty records are explicitly non-comparable and cannot be evaluated or approved.
8. [x] Expand the data-governance registry to include SEC EDGAR, Treasury, BLS, FRED, BEA, OpenAI, and every stored output category, with terms, retention, redistribution, and live-use decisions. The registry now covers 16 sources and all 23 SQLite tables through 12 categories; external approval and retention enforcement remain separate open work.
9. [x] Include `scripts/*.ts` in the standard strict TypeScript boundary and CI, with a regression assertion that preserves the project include. Credentialed and mutating smoke execution remains opt-in.
10. [x] Add direct API happy-path and provider-failure contracts for the highest-risk broker-backed route branches, then cover order reconciliation and concurrent reservation races without browser automation. Primary orders, mutations, option actions, strategy paper execution, recovery, terminal stream updates, and transactional capacity races now have direct contracts. Strategy broker failures persist only a stable public reason; raw diagnostics stay server-side.

Exit gate: a route change can be tested without a real browser or real Alpaca account, operational scripts share the static gate, invalid strategy configuration cannot become a run, and a historical database upgrade/restore is reproducible.

## Priority 1: strategy research quality

### Experiment infrastructure

1. [x] Ingest and persist versioned crypto bars beyond the direct 90-day request window. Bounded chunking supports up to 3,650 days and 500,000 estimated bars; immutable actor-scoped versions record provider/feed, UTC timezone, query and observed bounds, gaps, rejected bars, duplicates/conflicts, additions, corrections, removals, predecessor lineage, and deterministic dataset hashes. Stored-dataset backtests reuse the exact hash without another provider read, while live shadow ticks stay at the 90-day cap.
2. [x] Persist immutable backtest experiments with parameters, query window, costs, baselines, code/plugin/feature/policy versions, and dataset hash. Every new shadow run must link to one matching clean reviewed backtest.
3. [x] Implement genuine walk-forward evaluation. A bounded caller-declared canonical candidate set is ranked only on each rolling training slice; the winner is re-instantiated and frozen, indicators warm on train history without scored execution, and only untouched test bars contribute to fold and aggregate out-of-sample results. Exact timestamp boundaries, candidate scores/hashes, frozen parameters, capital-reset assumptions, and leakage checks are persisted. Multi-symbol histories must align exactly, with limits of 20 candidates, 100 folds, and 2,000,000 evaluated bars.
4. [x] Add rolling and anchored out-of-sample modes, a final untouched holdout period, and regime slices. Walk-forward requests now accept `mode`, optional `holdoutSize`, and optional caller-declared non-overlapping `regimes`. Rolling folds preserve fixed-size training windows, anchored folds expand from the first bar, final holdouts are removed from validation folds and candidate selection before being scored once, and regime summaries report validation and holdout observations separately without influencing selection.
5. [x] Add trade-level metrics: trade count, average holding time, gross/net return, downside deviation, Sortino, Calmar, profit factor, hit rate, average win/loss, turnover, exposure, and capacity warnings. Backtest results now include `tradeMetrics` with material simulated order count, position episodes, closed round trips, average holding bars/days, gross and net return, downside deviation, Sortino, Calmar, profit factor, hit rate, average win/loss, mirrored turnover/exposure, and high-turnover/high-frequency/high-exposure capacity warnings.
6. [x] Add uncertainty ranges through block bootstrap or another time-series-aware method. Show when the sample is too small; do not turn a noisy point estimate into a ranking. Backtest results and walk-forward out-of-sample aggregates now include a deterministic moving-block-bootstrap `uncertainty` object with 5th/50th/95th percentile total-return and max-drawdown ranges over 500 resamples. Samples with fewer than 20 scored returns report `insufficient_data`, and every uncertainty object is marked `rankingUse:"not_rankable"`.
7. [x] Calibrate fees, spread, slippage, latency, missed-fill, and partial-fill assumptions from accumulated paper receipts and quote/order-book evidence, while retaining conservative user overrides. Strategy execution replay now emits `calibration` with paper-order, receipt-slippage, explicit-fee, order-book-replay, spread, and latency sample sizes; average/p50/p95/max evidence; partial-fill, missed-fill, and missing-book rates; conservative recommended `feeBps`, `slippageBps`, `maxSpreadBps`, and `assumedOrderLatencyMs`; and explicit override policy. Calibration stays `insufficient_evidence` until at least 20 paper orders have replay evidence.
8. [x] Build a compare view for strategy/config cohorts with the same period, dataset, friction model, and baselines. Prevent comparisons across incompatible evidence without a warning. `POST /api/strategy/backtests/compare` now accepts 2-20 immutable backtest IDs and returns a deterministic comparison report with per-backtest metrics, baselines, and named compatibility checks for period/symbol/timeframe, dataset hash, initial cash, fee/slippage/execution assumptions, baseline set, code identity, provider, and feed. Mixed evidence returns `compatible:false` plus warnings instead of a silent ranking.
9. [x] Pre-register a paper experiment protocol: hypothesis, parameters, start/stop dates, minimum observations, maximum budget, invalidation criteria, and review cadence. Parameter changes create a new version rather than rewriting history. `POST /api/strategy/runs/{runId}/experiment-protocol` now appends immutable protocol versions with protocol hashes, frozen parameter hashes, dates, observation/budget/review criteria, and invalidation criteria. Paper approval fails without a protocol, rejects budgets above the protocol maximum or expiries beyond the stop date, and paper orders block outside the protocol window.
10. [x] Require a minimum 30-day paper window plus enough decisions/fills for every metric before a run can be considered for promotion. `needs_evidence` remains distinct from `pass`. Promotion review now builds `strategy-promotion-evidence-v1`; it returns `needs_evidence` without changing run status until the run is in paper mode, has at least 30 paper days, meets the larger of 30 decisions or the protocol minimum observations, and has at least 20 filled paper orders for fill-quality, attribution, and performance metrics. Passing evidence is attached to the review history before the run becomes `completed`.

### Next strategy catalog

Implement these only after the experiment infrastructure above can compare them honestly.

| Strategy                             | Why it is useful                                                                                        | Required controls                                                            | Initial mode        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------- |
| Volatility-targeted trend            | Tests whether smaller exposure during high realized volatility improves drawdown-adjusted trend returns | No leverage, hard exposure cap, lagged volatility, turnover limit            | Backtest and shadow |
| Donchian breakout with ATR exit      | Adds range-based breakout and volatility-scaled invalidation to the existing close/volume breakout      | OHLC integrity, no look-ahead on channel/ATR, gap-aware stop assumption      | Backtest and shadow |
| Regime-filtered mean reversion       | Tests whether mean reversion behaves better when trend and volatility conditions are compatible         | Explicit regime definition, minimum liquidity, stop and max holding period   | Backtest and shadow |
| Cross-sectional BTC/ETH/SOL momentum | Tests relative ranking rather than one primary-versus-peer comparison                                   | Synchronized bars, missing-symbol policy, turnover cap, multi-leg paper plan | Shadow before paper |
| Value-averaging baseline             | Provides a disciplined cash-contribution comparator beyond time-sliced accumulation                     | Fixed budget/schedule, no performance chasing, cash shortfall behavior       | Backtest and shadow |
| Low-turnover ETF trend               | Extends the same research discipline to liquid US equity ETFs such as SPY/QQQ                           | Point-in-time sessions, IEX coverage disclosure, equity order policy         | Later, shadow first |

Do not prioritize high-frequency market making, leverage, perpetual futures, cross-exchange arbitrage, wallet movement, or custody. The current data, scheduler, latency, fee model, and operational controls are not designed for them.

Exit gate: at least three frozen strategies have comparable out-of-sample and 30-day paper evidence, including costs and uncertainty, with no parameter changes hidden inside a run.

## Priority 1: data quality and lineage

1. [x] Add a provider-health and dataset-quality service with freshness, completeness, gaps, duplicate rate, schema failures, throttling, revisions, and last-success timestamps. `GET /api/operations/data-quality` now derives provider status, throttling, last-event and last-success timestamps from local events, and actor-scoped strategy dataset freshness, accepted/completeness ratio, gap count, rejected/schema-failure rate, duplicate rate, conflicting duplicates, and revision counts from immutable dataset stats. It does not claim live provider probing, retention enforcement, or external entitlement approval.
2. [ ] Distinguish provider observation time, publication time, effective period, retrieval time, and server response time in every normalized DTO. Do not label retrieval time as market observation time. Canonical evidence now carries explicit observation/publication/effective/retrieval/server-response time provenance, official macro evidence records dated/monthly/quarterly effective periods, crypto Strategy Lab bar/snapshot DTOs separate provider observation from retrieval and server response time, and company-market plus equity quote/bar stream DTOs preserve provider observation separately from retrieval/server response. Remaining normalized provider DTOs and browser-facing objects still need the same taxonomy before this item is complete.
3. [ ] Persist the canonical evidence used by important research/strategy decisions so later replays do not depend on mutable provider responses.
4. [ ] Add point-in-time controls for fundamentals and classifications used in historical analysis. A filing published after a test date must not influence that date.
5. [ ] Reconcile market bars and account/order state against independent queries on a schedule; store discrepancy events and recovery outcomes.
6. [ ] Add provider contract tests using recorded, redacted fixtures for malformed payloads, partial responses, rate limits, revisions, and timestamp edge cases.
7. [ ] Add a visible data-coverage panel for each research report, portfolio calculation, and strategy run: expected inputs, received inputs, omitted inputs, freshness, and impact on conclusions.
8. [ ] Define retention and pruning for raw strategy snapshots, large order books, spans, metrics, and provider evidence before a long beta produces unbounded local growth.
9. [ ] Add licensed GICS/ICB or factor classifications only when a timestamped source and allowed use are available. Continue labeling SEC SIC as SEC SIC.

Exit gate: a decision can be replayed from stored, time-correct inputs, and provider degradation is visible before it silently changes a result.

## Priority 2: product and UI experience

1. [ ] Replace raw strategy-parameter JSON as the default with strategy-specific inputs, numeric bounds, presets, and an advanced JSON view for inspection.
2. [ ] Add an experiment comparison workspace with aligned equity/drawdown charts, costs, out-of-sample bands, decision counts, and promotion blockers.
3. [ ] Show one consistent freshness/coverage state across workspaces instead of isolated warnings inside cards.
4. [ ] Make loading, partial-data, empty, rate-limited, stale, blocked, and retry states visually consistent and preserve successful sections when one provider fails.
5. [ ] Improve mobile navigation and dense tables without hiding risk evidence. Validate changed layouts with browser screenshots and interaction checks only after backend tests pass.
6. [ ] Add keyboard/focus regression checks for navigation, modal confirmation, error notification, table controls, and destructive operations.
7. [ ] Turn closed-beta evidence into an operator workflow: target detail, supporting records, drill timestamps, unresolved incidents, and exportable review packet.
8. [ ] Add daily/closing briefings only after users repeatedly consume the current monitoring view; every briefing must be change-only, cited, and explicitly non-exhaustive.
9. [ ] Add “why did this move?” explanations only when timestamp-aligned price/volume/event evidence can separate known facts from inference.

Exit gate: the main paper-investing and strategy-review flows are understandable without raw JSON, preserve evidence under partial failure, and work at mobile and desktop widths.

## Priority 2: maintainability and repository structure

The first structural pass is complete. The repository now uses explicit application boundaries:

```text
frontend/                       # browser shell, styles, shared and workspace scripts
backend/
  app.ts                        # dependency-injected application composition
  server.ts                     # process entry
  features/                     # market, operations, orders, portfolio, research, strategy
  integrations/                 # Alpaca and external provider adapters
  persistence/                  # migrations, audit and composed stores
  http/                         # request and authorization policy
  shared/                       # genuine cross-feature code
tests/                          # mirrors backend boundaries
scripts/                        # diagnostics, evaluations and smoke checks
docs/                           # product, validation, roadmap and architecture records
```

Remaining maintainability work:

1. [x] Separate frontend, backend, tests, scripts, documentation, and architecture records.
2. [x] Split the browser client into shared and workspace-specific assets.
3. [x] Extract application composition, feature routes, runtimes, integrations, migrations, strategy persistence, and audit hashing.
4. [ ] Split the remaining general store only when a repository family has an independent ownership or change pressure.
5. [ ] Reduce large feature route modules as their API branches receive direct contract coverage.
6. [ ] Tighten the browser CSP by removing inline style/script allowances where practical.

Avoid generic `domain/` or `utils/` buckets. A move is complete only when imports, tests, documentation, and safety behavior move together.

## Priority 3: triggered improvements

These items are deliberately deferred until their trigger occurs.

- [ ] Add a 5-15 second shared cache for portfolio risk/performance when measured warm loads or concurrent users exceed the current single-user budget. Prior measurements were roughly 0.21-0.23 seconds warm.
- [ ] Virtualize the option chain when the UI renders more than the current 120-contract cap or profiling shows material interaction delay.
- [ ] Add indexed receipt/order lookup columns before multi-account support or when JSON scans become measurable.
- [ ] Add durable distributed scheduling when more than one server process or restart-safe strategy timing is required.
- [ ] Add natural-language deterministic screeners only after the visible filter model and evidence contract exist.
- [ ] Add user profile, objectives, horizon, liquidity, and tax preferences only after privacy, suitability, and external advice-boundary review.
- [ ] Add account configuration editing only after audited settings UX and broker capability tests exist.

## External gates

These are intentionally open and cannot be completed by code changes alone.

- [ ] **Legal/compliance review:** advice and personalization boundary, order execution, crypto disclosures, automated strategy supervision, communications, retention, and marketing/performance language.
- [ ] **Paper closed beta:** run paper accounts for at least 30 days with no more than five participants; attach evidence for all eight targets from `/api/operations/closed-beta-evidence`; resolve critical/high incidents; perform backup, restore, kill-switch, and incident drills.
- [ ] **Data entitlement review:** confirm every market, options, news, crypto, macro, identity, and AI source is permitted for the intended users, storage, display, and live decision use.
- [ ] **Live deployment review:** design a separate reviewed live architecture only after the other gates pass. Do not add an environment switch to the existing paper client.

Autonomous live execution, regulated brokerage, customer onboarding, KYC/CIP/AML, custody, transfers, best execution, statements, tax documents, surveillance, complaints, and regulatory reporting are outside this personal paper application. They require a separately owned Broker API and compliance program.

## Completed foundation

The historical implementation phases are condensed here so the active roadmap stays readable.

- [x] Connected Alpaca paper account, portfolio, orders, watchlists, market clock/calendar, IEX data, streams, and entitlement-aware multi-asset states.
- [x] Signed and freshly revalidated equity, linked, basket, short, option, and crypto paper-order workflows with receipts and reconciliation.
- [x] FIFO ledger, performance, snapshots, risk, exposure, scenario, optimizer, and constrained rebalance calculations.
- [x] SEC filing/fact/trend evidence, official macro context, GDELT, optional Finnhub, OpenFIGI, comparables, valuation scenarios, and material 8-K monitoring.
- [x] Evidence-bound portfolio/company agents, counter-thesis review, and receipt-linked trade journal.
- [x] Crypto strategy plugins with strict canonical configuration, immutable backtests linked to comparable runs, exact code/data provenance, shadow/scheduled evaluation, approved paper runner, traces, alerts, performance, attribution, reviews, and reports.
- [x] Global operations policy, OIDC proxy roles, encrypted secret envelopes, audit chains, ordered migrations, fixture-level backup restore, export endpoints, governance reports, and beta target definitions.
- [x] Source/output governance registry covering SEC, Treasury, BLS, FRED, BEA, OpenAI, Alpaca, news, identity, local analytics, and every current SQLite table, plus local provider-health and dataset-quality reporting.

The former `LATER_FEATURES.md` and `future-improvements.md` inventories are fully absorbed here. Portfolio Q&A, diversification proposals, and what-if scenarios are implemented; daily briefings and evidence-based price-move explanations remain in Priority 2; scale-triggered caches, virtualization, indexing, scheduling, screeners, profiles, and account settings remain in Priority 3. No separate later-features file should be recreated.

Implemented does not imply production-approved. See `FEATURES.md` for exact limitations and `VALIDATION.md` for current evidence.

## Definition of done

Every future item must answer:

- Which account capability and data entitlement permit it?
- What are the source, feed, observation time, retrieval time, stale threshold, and missing-data behavior?
- Are inputs bounded and validated at the trust boundary?
- Are calculations deterministic, reproducible, and tested with malformed and missing data?
- Can direct API tests validate behavior without browser automation?
- Are partial fills, working orders, corporate actions, cashflows, retries, and concurrent requests handled?
- Does the user see assumptions, costs, maximum loss, uncertainty, and failure behavior?
- Can an agent use the result without credentials or execution authority?
- Can a strategy decision be replayed from persisted snapshots, versions, and policy evidence?
- Does the experiment use explicit baselines, unseen periods, realistic friction, and enough observations?
- Can the workflow be stopped immediately and audited afterward?
- Did `README.md`, `FEATURES.md`, `STRATEGY_LAB.md`, `VALIDATION.md`, and this roadmap remain consistent?

## Primary references

- [Alpaca developer overview](https://docs.alpaca.markets/docs)
- [Alpaca paper trading](https://docs.alpaca.markets/us/docs/paper-trading)
- [Alpaca orders](https://docs.alpaca.markets/us/docs/orders-at-alpaca)
- [Alpaca historical market data](https://docs.alpaca.markets/us/docs/historical-api)
- [Alpaca options trading](https://docs.alpaca.markets/docs/options-trading)
- [Alpaca crypto data](https://docs.alpaca.markets/docs/real-time-crypto-pricing-data)
- [Alpaca terms and conditions](https://files.alpaca.markets/disclosures/alpaca_terms_and_conditions.pdf)
- [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- [SEC developer and fair-access guidance](https://www.sec.gov/about/developer-resources)
- [Treasury Fiscal Data API](https://fiscaldata.treasury.gov/api-documentation/)
- [BLS Public Data API](https://www.bls.gov/developers/)
- [BLS API terms](https://www.bls.gov/developers/termsOfService.htm)
- [FRED API](https://fred.stlouisfed.org/docs/api/fred/)
- [FRED API terms](https://fred.stlouisfed.org/docs/api/terms_of_use.html)
- [BEA API](https://apps.bea.gov/api/)
- [BEA API terms](https://apps.bea.gov/API/_pdf/bea_api_tos.pdf)
- [OpenFIGI API v3](https://www.openfigi.com/api/documentation)
- [OpenFIGI terms](https://www.openfigi.com/docs/terms-of-service)
- [OpenAI API data controls](https://platform.openai.com/docs/guides/your-data)
- [OpenAI services agreement](https://openai.com/policies/services-agreement/)
- [FINRA algorithmic trading](https://www.finra.org/rules-guidance/key-topics/algorithmic-trading)
- [OpenTelemetry signals](https://opentelemetry.io/docs/concepts/signals/)

Official documentation, runtime entitlements, and provider responses must be rechecked before exposing a new capability. The installed SDK capability map is a discovery aid, not a product guarantee.
