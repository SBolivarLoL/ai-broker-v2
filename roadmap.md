# AI Broker product roadmap

Last reviewed against `main`: 2026-07-01.

This is the only future-work inventory for AI Broker. It incorporates the former `LATER_FEATURES.md` and `future-improvements.md` lists. Current behavior belongs in `FEATURES.md`; completed validation evidence belongs in `VALIDATION.md`.

## Status rules

- `[x] Implemented`: code exists in the repository.
- `[ ] Planned`: implementation or measured evidence is still missing.
- `External gate`: completion requires evidence outside the codebase.
- A schema, policy, report, endpoint, or UI panel is not proof that the represented operational process occurred.

## Review baseline

The 2026-06-30 audit found a capable deterministic core and a large difference between module-level confidence and whole-application confidence.

| Area | Current state | Evidence / implication |
| --- | --- | --- |
| Repository | 57 production TypeScript modules, 60 test files, a 22-line Bun entry point, one request module, one browser HTML file, SQLite persistence | Process startup is separated; route and browser composition remain concentrated |
| Automated checks | 242 tests, 926 assertions, strict TypeScript, 39 focused safety/evaluation tests | `bun run check` and `bun run eval` pass; coverage floors are enforced in CI |
| Instrumented coverage | 95.09% functions and 96.51% lines across imported modules | Reviewed floors are 95% functions and 96% lines; browser coverage is reported separately |
| Dependency audit | No known vulnerabilities | `bun audit` passed on 2026-07-01 |
| Execution | Alpaca paper only, signed previews, fresh revalidation, idempotency, receipts, risk reservations, global policy | Strong fail-closed order boundary |
| Research data | SEC, Alpaca/IEX, Treasury, BLS, optional FRED/BEA/Finnhub, GDELT, OpenFIGI | Strong provenance model; provider health and governance inventory are incomplete |
| Strategy research | Nine deterministic plugins, 90-day bar retrieval, bar-close backtests, shadow/paper runs, traces and attribution | Useful experiment loop; not yet a rigorous out-of-sample research platform |
| Operations | OIDC proxy contract, roles, encrypted envelopes, backup/export endpoints, audit chains, beta report | Code artifacts exist; restore drills, real users, and beta evidence remain external work |
| Live trading | Unavailable by construction | Remains blocked by legal, data, beta, and deployment reviews |

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

1. [x] Extract a side-effect-free `createApp(dependencies)` request handler into `src/app.ts`; `src/server.ts` now owns only Alpaca/store construction, process handling, `Bun.serve`, runtime stream/scheduler startup, and logging.
2. [x] Add direct API contract tests for authentication/roles across operations, orders, strategy, research and portfolio routes plus mutation origin, request-size limits, malformed JSON, strategy parsing, stable response schemas, 404 behavior and sanitized 502 mapping.
3. [x] Define one validated schema and default set per strategy. Unknown, non-finite, contradictory, and out-of-range parameters now fail before backtest or run creation, and saved runs persist canonical defaults.
4. [x] Reconcile the Strategy Lab input with the server's shared 1-90 day crypto-history bound and retain a regression test that prevents the browser/server limits from drifting.
5. [ ] Replace migration metadata-only behavior with ordered, transactional migrations and upgrade fixtures from prior schema versions. Add a backup restore drill that proves a serialized database can start and preserve audit verification.
6. [x] Publish `bun run coverage` with reviewed 95% function and 96% line thresholds for imported deterministic/request code, enforce it through `bun run check` in CI, and report the uninstrumented browser client separately.
7. [ ] Persist exact Git commit, plugin version, feature-schema version, policy version, query window, provider/feed, and input dataset hashes on every backtest/run/decision that may be compared later.
8. [ ] Expand the data-governance registry to include SEC EDGAR, Treasury, BLS, FRED, BEA, OpenAI, and every stored output category, with terms, retention, redistribution, and live-use decisions.

Exit gate: a route change can be tested without a real browser or real Alpaca account, invalid strategy configuration cannot become a run, and a historical database upgrade/restore is reproducible.

## Priority 1: strategy research quality

### Experiment infrastructure

1. [ ] Ingest and persist versioned crypto bars beyond the current 90-day request window. Record gaps, duplicates, timezone, feed, corrections, and immutable dataset hashes.
2. [ ] Persist backtest experiments instead of returning browser-only results. Link each shadow run to the exact reviewed backtest, parameters, data window, costs, baselines, and code version.
3. [ ] Implement genuine walk-forward evaluation: choose or freeze parameters using train data only, run untouched test windows, aggregate out-of-sample metrics, and expose train/test boundaries and leakage checks.
4. [ ] Add rolling and anchored out-of-sample modes, a final untouched holdout period, and regime slices. Do not reuse the holdout for parameter selection.
5. [ ] Add trade-level metrics: trade count, average holding time, gross/net return, downside deviation, Sortino, Calmar, profit factor, hit rate, average win/loss, turnover, exposure, and capacity warnings.
6. [ ] Add uncertainty ranges through block bootstrap or another time-series-aware method. Show when the sample is too small; do not turn a noisy point estimate into a ranking.
7. [ ] Calibrate fees, spread, slippage, latency, missed-fill, and partial-fill assumptions from accumulated paper receipts and quote/order-book evidence, while retaining conservative user overrides.
8. [ ] Build a compare view for strategy/config cohorts with the same period, dataset, friction model, and baselines. Prevent comparisons across incompatible evidence without a warning.
9. [ ] Pre-register a paper experiment protocol: hypothesis, parameters, start/stop dates, minimum observations, maximum budget, invalidation criteria, and review cadence. Parameter changes create a new version rather than rewriting history.
10. [ ] Require a minimum 30-day paper window plus enough decisions/fills for every metric before a run can be considered for promotion. `needs_evidence` remains distinct from `pass`.

### Next strategy catalog

Implement these only after the experiment infrastructure above can compare them honestly.

| Strategy | Why it is useful | Required controls | Initial mode |
| --- | --- | --- | --- |
| Volatility-targeted trend | Tests whether smaller exposure during high realized volatility improves drawdown-adjusted trend returns | No leverage, hard exposure cap, lagged volatility, turnover limit | Backtest and shadow |
| Donchian breakout with ATR exit | Adds range-based breakout and volatility-scaled invalidation to the existing close/volume breakout | OHLC integrity, no look-ahead on channel/ATR, gap-aware stop assumption | Backtest and shadow |
| Regime-filtered mean reversion | Tests whether mean reversion behaves better when trend and volatility conditions are compatible | Explicit regime definition, minimum liquidity, stop and max holding period | Backtest and shadow |
| Cross-sectional BTC/ETH/SOL momentum | Tests relative ranking rather than one primary-versus-peer comparison | Synchronized bars, missing-symbol policy, turnover cap, multi-leg paper plan | Shadow before paper |
| Value-averaging baseline | Provides a disciplined cash-contribution comparator beyond time-sliced accumulation | Fixed budget/schedule, no performance chasing, cash shortfall behavior | Backtest and shadow |
| Low-turnover ETF trend | Extends the same research discipline to liquid US equity ETFs such as SPY/QQQ | Point-in-time sessions, IEX coverage disclosure, equity order policy | Later, shadow first |

Do not prioritize high-frequency market making, leverage, perpetual futures, cross-exchange arbitrage, wallet movement, or custody. The current data, scheduler, latency, fee model, and operational controls are not designed for them.

Exit gate: at least three frozen strategies have comparable out-of-sample and 30-day paper evidence, including costs and uncertainty, with no parameter changes hidden inside a run.

## Priority 1: data quality and lineage

1. [ ] Add a provider-health and dataset-quality service with freshness, completeness, gaps, duplicate rate, schema failures, throttling, revisions, and last-success timestamps.
2. [ ] Distinguish provider observation time, publication time, effective period, retrieval time, and server response time in every normalized DTO. Do not label retrieval time as market observation time.
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

The current co-located domain modules and tests are easy to discover. A big-bang directory move would add churn without improving behavior. Refactor incrementally at the boundaries already causing test or ownership friction.

Recommended target structure:

```text
src/
  server.ts                 # process startup only
  app.ts                    # createApp(dependencies) request handler
  routes/
    market.ts
    operations.ts
    orders.ts
    portfolio.ts
    research.ts
    strategy.ts
  domain/                   # existing deterministic modules, moved only when touched
  infrastructure/
    alpaca.ts
    providers/
    persistence/
      migrations/
      store.ts
      repositories/
  web/
    index.html
    styles.css
    app.ts
    views/
tests/
  api/
  system/
  fixtures/
docs/                       # optional after links/tooling are ready
  FEATURES.md
  STRATEGY_LAB.md
  VALIDATION.md
  roadmap.md
```

Implementation order:

1. [x] Extract `app.ts` and direct request-boundary tests without changing route behavior.
2. [ ] Split inline browser CSS and JavaScript into static files, then tighten CSP by removing `unsafe-inline` where practical.
3. [ ] Split routes by domain as each receives API tests. Keep deterministic modules and their tests together until a real ownership boundary appears.
4. [ ] Introduce migrations and repositories around SQLite only when upgrade/restore tests exist.
5. [ ] Move documentation under `docs/` only after repository links, CI checks, and contributor tooling are updated in one change.

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
- [x] Crypto strategy plugins with strict canonical configuration, bar-close backtests, shadow/scheduled runs, approved paper runner, traces, alerts, performance, attribution, reviews, and reports.
- [x] Global operations policy, OIDC proxy roles, encrypted secret envelopes, audit chains, backup/export endpoints, governance reports, and beta target definitions.

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
- [Alpaca historical market data](https://docs.alpaca.markets/v1.3/docs/historical-api)
- [Alpaca options trading](https://docs.alpaca.markets/docs/options-trading)
- [Alpaca crypto data](https://docs.alpaca.markets/docs/real-time-crypto-pricing-data)
- [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- [SEC developer and fair-access guidance](https://www.sec.gov/about/developer-resources)
- [BLS Public Data API](https://www.bls.gov/developers/)
- [FRED API](https://fred.stlouisfed.org/docs/api/fred/)
- [BEA API](https://apps.bea.gov/api/)
- [OpenFIGI API v3](https://www.openfigi.com/api/documentation)
- [FINRA algorithmic trading](https://www.finra.org/rules-guidance/key-topics/algorithmic-trading)
- [OpenTelemetry signals](https://opentelemetry.io/docs/concepts/signals/)

Official documentation, runtime entitlements, and provider responses must be rechecked before exposing a new capability. The installed SDK capability map is a discovery aid, not a product guarantee.
