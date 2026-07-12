# Implemented features

Last reviewed against `main` commit `4ac24df`: 2026-07-12.

This file describes what exists in the repository now. Planned work belongs only in `roadmap.md`; reproducible confidence evidence belongs in `VALIDATION.md`.

## Product scope

AI Broker is a single-user, paper-only investing and strategy-research workstation connected to a personal Alpaca Trading API account. Deterministic code owns calculations, validation, and execution policy. OpenAI agents may retrieve typed evidence, explain it, and draft an action, but cannot submit, cancel, or replace an order.

The browser exposes seven workspaces:

| Workspace  | Current capability                                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home       | Paper account, holdings, operations policy, kill switch, closed-beta evidence, and order entry                                                                          |
| Markets    | Market session, watchlists, movers, most active stocks, monitored news/events, 8-K alerts, and multi-asset capability status                                            |
| Portfolio  | Risk, performance, FIFO ledger, exposure, scenarios, optimizer proposals, constrained rebalance plans, trade journal, receipts, and order management                    |
| Strategies | Crypto backtests, shadow/scheduled runs, protocol-gated paper approvals, manual crypto tickets, traces, metrics, alerts, performance, attribution, reviews, and reports |
| Research   | Company market data, SEC evidence, macro context, OpenFIGI, GDELT, optional Finnhub, comparables, scenario valuation, and AI company research                           |
| Options    | Bounded option chains, liquidity filters, Greeks, payoff/risk preview, long single-leg and net-debit vertical paper tickets, and position actions                       |
| AI Advisor | Evidence-bound portfolio Q&A and reviewed rebalance ideas with exact simulation authority                                                                               |

The shared browser shell uses a dark operator-workstation visual system. Desktop widths expose a persistent labeled navigation rail; tablet widths collapse it to an icon rail; mobile widths use a horizontally scrollable, active-item-centered navigation strip. A sticky status strip exposes locally evidenced data health, the Alpaca paper environment, paper-only execution, and a global private-value mask. The Overview adds explicit equity, buying-power, cash, and account-status cards without inventing unsupported performance claims. Research provider reads begin only when the Research workspace is activated; recurring account and market polling pauses when its owning workspace or the page is not visible. Loading, toast, and error announcements use live regions. Confirmation dialogs trap focus, close on Escape, restore the trigger focus, and use a distinct danger treatment for destructive actions.

## Capability map

### Broker and market state

- Alpaca paper account balances, cash, buying power, positions, open orders, activities, account health, and readiness. The account aggregate, account, position, account-activity root/row, managed-order, nested-leg, order-list, and cancel-all-preview DTOs distinguish broker observation from local retrieval and server response time. Account and position observations remain explicitly null because Alpaca does not provide an event timestamp on those current-state responses; order observation uses the most recent available broker order timestamp. Trade activities use execution time as observation; non-trade activities retain provider record creation as publication and the occurrence-or-settlement date as an effective UTC day.
- Alpaca watchlist create, rename, symbol add/remove, and delete workflows. Watchlist and mutation DTOs distinguish the provider update observation from retrieval and server response; nested asset metadata keeps observation explicitly null. The market-workspace root aggregates child observation/retrieval times and records its own response time.
- NASDAQ clock/calendar, early-close information, session-aware order guidance, SIP discovery panels where entitled, and an IEX quote/bar SSE bridge.
- Company price, bid/ask spread, volume, daily bars, SPY/QQQ/DIA comparison, source timestamps, news, eligibility badges, and logo fallback. Cached asset-search root/result DTOs, the single-symbol quote route, market monitoring news/corporate-action/SEC alert DTOs, company-market root/company/quote/session/stats/benchmark/bar/news DTOs, market workspace root/watchlist/asset/discovery/calendar DTOs, equity quote/bar stream DTOs, and multi-asset index/FX/crypto DTO distinguish provider observation, publication, effective-period, retrieval, and server response time where applicable. Asset-master and quote observations remain null when Alpaca exposes no event timestamp; cached asset-search, company-market, and market-monitoring responses preserve provider retrieval while refreshing server response time.
- Read-only crypto quotes for BTC/USD, ETH/USD, and SOL/USD. Index and FX states remain explicitly unavailable when the account lacks entitlement.
- Fixed-income research returns an explicit unavailable capability record because this personal Trading API account is not a fixed-income-enabled Broker API partner.

### Orders and receipts

- Equity market, limit, stop, stop-limit, trailing-stop, OPG/CLS auction, extended-hours eligible, fractional, and dollar-notional tickets.
- Buy bracket/OTO and sell OCO linked orders.
- Multi-leg equity rebalance baskets with application-level atomic preview/reservation and sequential broker submission.
- Explicit paper short workflow with margin, marginability, easy-to-borrow, DAY, quantity, concentration, and fresh-state checks.
- Long buy-to-open options and defined-risk net-debit verticals. Naked option selling is unavailable. Option-chain and option-portfolio Greek DTOs preserve provider observation, retrieval, and server-response provenance where provider timestamps are available.
- Standalone paper crypto market, limit, and stop-limit tickets. Approved strategy automation submits only bounded paper crypto market orders.
- Safe replacement, exact cancellation, and snapshot-bound cancel-all preview for eligible working orders. The shared order tracker retains each accepted REST or stream receipt time and prevents an older recovery snapshot from overwriting a newer streamed order or its retrieval provenance.
- HMAC-signed two-minute previews, exact confirmation, fresh broker/market revalidation, idempotency keys, local risk reservations, broker reconciliation, and decision receipts.

### Portfolio intelligence

- Cashflow-adjusted performance, benchmark attribution, drawdown, volatility, Sharpe-style summary metrics, and persisted daily snapshots. Performance root, summary, daily point, benchmark, current-position attribution, and quality DTOs preserve provider observations, effective windows, separate portfolio/benchmark retrieval, and response time. Current-position observation remains null, and benchmark retrieval remains null when no portfolio points exist and no benchmark request occurs. Current/history snapshot roots plus account, position, risk, order-sync, source, and quality children preserve the original broker-read `capturedAt` as retrieval across SQLite reads and refresh only response time. Order-stream event observation remains separate from REST recovery retrieval, an unpersisted stream receipt remains null, and legacy or malformed rows expose partial provenance without requiring a schema rewrite. Performance and snapshot quality contracts expose expected, received, omitted, freshness, missing, and conclusion-impact evidence through visible browser panels.
- FIFO activity ledger for fills, fees, dividends, interest, transfers, splits, symbol changes, and broker-provided corporate-action basis allocations. Broker-read completion time is persisted with normalized activity time fields, a 30-second shared read cache preserves that retrieval time while each response receives a fresh server time, and legacy rows expose missing provenance rather than being restamped. The visible evidence panel reports bounded-history, stored-row, retrieval-time, provider-time, unmatched-sell, and unresolved-corporate-action coverage plus its effect on FIFO P&L, basis, and replay; unsupported basis changes remain unresolved rather than guessed.
- Historical and parametric 95% daily VaR, historical expected shortfall, covariance risk contribution, correlation, liquidity, and SPY benchmark diagnostics. Risk root, current account/position inputs, position-history and IEX-quote inputs, SPY benchmark, advanced analytics, liquidity, weights, diversification, stress, and quality DTOs preserve applicable bar/quote observations, historical effective windows, account versus market retrieval, and response time. Current account/position observations remain null, entitlement-aware historical reads identify their actual SIP/IEX/delayed fallback, and the visible quality panel reports expected, received, omitted, observation coverage, missing inputs, and conclusion impact without applying one false universal age cutoff across bars and quotes.
- Diversification reports both whole-account concentration, including cash, and invested-asset concentration over gross position value so a cash-heavy account does not make a concentrated invested sleeve appear diversified.
- Gross and signed asset-class, SEC SIC division/industry, beta, momentum, and realized-volatility exposure with explicit coverage gaps. Exposure root, asset-class/SIC/factor aggregates, positions, provider inputs, sources, cache metadata, and quality DTOs distinguish current Alpaca account/position retrieval, IEX bar observations/effective windows/retrieval, SEC classification retrieval, and server response time. Cache hits preserve external-evidence retrieval while refreshing current-state and response times; failed, unqueried, malformed, unsupported, and position-bound omissions remain explicit, and an irrelevant SPY benchmark is not queried for a portfolio without US-equity holdings. The visible panel exposes expected, received, omitted, observation coverage, and conclusion impact while explicitly warning that retrieval-time SEC SIC is not a point-in-time historical classification.
- Deterministic rate, technology, volatility, and user-entered held-symbol scenarios. The v2 scenario contract preserves the underlying exposure observation/effective/retrieval evidence separately from response time on roots, scenarios, and positions; identifies local calculations, Alpaca/IEX/SEC inputs, and user assumptions; and exposes expected, received, omitted, and unmodeled position evaluations with their effect on displayed losses. Volatility inputs older than seven days, more than five minutes in the future, or missing an observation time are excluded rather than treated as current.
- Read-only risk-parity and shrunk mean-variance proposals. The v2 optimizer contract preserves current-account retrieval separately from IEX daily-bar observation/effective windows, market retrieval, and response time; exposes expected, received, omitted, malformed, duplicate, conflicting, stale, future-dated, and insufficient-history evidence plus proposal impact; and excludes unusable histories from target weights. The visible warning identifies IEX as a single-exchange feed rather than consolidated SIP. Targets flow into a constrained rebalance planner before the normal basket preview.
- Rebalance planning with turnover, cash buffer, fee, imported FIFO lot, tax-rate, maximum-tax, precision, and minimum-notional constraints. The v2 planner contract preserves current account/position retrieval, rolling-order fill observations, durable activity retrieval, FIFO acquisition periods, operations-policy updates, explicit IEX latest-trade observations/retrieval, calculation time, and response time. Target trades older than seven days, more than five minutes in the future, missing an observation, or carrying malformed prices fail closed. Expected, received, omitted, rejected, freshness, tax-lot coverage, and conclusion impact are visible before a draft can flow into the separately revalidated basket preview.
- Persisted operations policy for kill switch, order notional, symbol notional, position exposure, sector exposure, drawdown, and turnover.

### Research and AI

- Shared SEC EDGAR client with declared identity, caching, retry/backoff, serialized fair-access requests, filing sections, company facts, financial trends, SIC classification, and material 8-K alerts. Classification, recent-filing, filing-evidence/section, company-facts result, and alert DTOs distinguish applicable filing-date publication, report-date effective period, provider retrieval, and server response time. Cache hits retain the original provider retrieval timestamp while each normalized response receives a fresh server timestamp.
- Canonical evidence records carrying provider/source identity, authority, claim status, observation time, publication time, effective period, retrieval time, server response time, entity identifiers, canonical URL, content hash, and JSON-compatible payload.
- Conservative evidence deduplication: exact provider IDs, URL plus content, or same-entity exact content only. Similar headlines do not become verified facts.
- Official macro context from public Treasury and BLS data, with optional FRED and BEA coverage. Root, provider-coverage, indicator, and canonical-evidence DTOs distinguish Treasury publication dates, FRED observation dates, BLS monthly and BEA quarterly effective periods, provider retrieval, and per-response server time. Raw cache hits preserve their original provider retrieval timestamps and evidence hashes; unqueried, misconfigured, or failed providers expose `retrievedAt:null` instead of inventing a successful read. Canonical evidence can retain an explicitly unavailable observation as `observedAt:null` instead of substituting an unrelated as-of time.
- Licensed Alpaca/Benzinga articles, bounded GDELT public-web media signals, optional Finnhub enrichment, and OpenFIGI v3 identity mapping with explicit partial/unavailable states. GDELT media-signal root/article DTOs, Finnhub root/endpoint/profile/earnings/news DTOs, and OpenFIGI root/selected/candidate instrument DTOs preserve applicable publication or effective-period, provider-retrieval, and server-response time. Cached provider data keeps its original retrieval time while refreshing per-response server time; unqueried Finnhub states report `retrievedAt:null` instead of inventing a provider fetch.
- Comparable valuation tables from latest returned Alpaca IEX price plus directly reported SEC revenue, net income, diluted EPS, equity, and shares. The v2 root, canonical sources, and visible quality panel distinguish SEC filing publication and input effective periods, SEC/IEX retrieval, unavailable provider price observation, response time, requested/received/omitted companies and metrics, and conclusion impact. Missing or invalid inputs remain unavailable; a price retrieval is not relabeled as a trade observation.
- User-authored bull/base/bear assumptions converted into deterministic 12-month valuation scenarios. The v2 baseline, scenario, canonical-source, and quality contract exposes SEC and price input coverage, all three assumption cases, unavailable outputs, calculation time, retrieval-only price freshness, and conclusion impact. They are scenarios, not forecasts.
- Company research and portfolio Q&A agents with typed read-only tools, bounded outputs, evidence-ID validation, numeric grounding checks, and unsafe-certainty rejection. Portfolio-question v2 responses preserve safe evidence IDs, source classes, provider times where exposed, retrieval-only gaps, grounded-claim coverage, and freshness impact. Portfolio-plan v2 applies the same contract separately to proposal and independent-review evidence, and requires exact cited local simulation authority for every actionable idea; the UI renders both coverage contracts before conclusions. Saved plan governance names Alpaca paper-account, IEX, Benzinga, OpenAI, and local-derived sources explicitly. Completed company-research v2 payloads persist their canonical evidence and normalized root time, and expose a visible quality panel for five required tool calls, four required and two supplemental evidence categories, cited claims, exactly grounded numeric metrics, semantic source-time records, missing inputs, and conclusion impact. SEC and news retrieval is never substituted for provider observation; the derived one-year market-history period remains separate from an explicitly unavailable latest-price observation.
- Independent counter-thesis review before actionable advisor ideas; unapproved ideas become watch-only.
- Receipt-linked trade journal with immutable thesis text, human-classified thesis drift, fresh market/position context, and audit history.

### Strategy Lab

- Nine deterministic plugin strategies: cash, buy-and-hold, time-sliced accumulation, moving-average trend, mean reversion, breakout momentum, volatility filter, BTC/ETH relative strength, and order-book liquidity scout. One strict schema supplies canonical defaults and rejects unknown, non-finite, contradictory, or out-of-range parameters before execution or persistence. Relative strength derives the opposite BTC/ETH peer from the ordered symbol pair rather than accepting a second peer override.
- Immutable bar-close backtests with cash and buy-and-hold baselines, fees, slippage, drawdown, exposure, turnover, exact normalized dataset hashes, and legacy train/test boundary segmentation.
- Backtest results include deterministic trade metrics: material simulated order count, position episodes, closed round trips, average holding bars/days, gross and net return, downside deviation, Sortino, Calmar, profit factor, hit rate, average win/loss, turnover, exposure, and capacity warnings for high turnover, high trade frequency, or high exposure.
- Backtest results and walk-forward out-of-sample aggregates include deterministic moving-block-bootstrap uncertainty evidence for total return and max drawdown. The range uses 5th/50th/95th percentiles over 500 resamples, preserves short-run return clustering through contiguous blocks, reports `insufficient_data` below 20 scored return observations, and is explicitly marked `not_rankable`.
- Backtest cohorts can be compared through a deterministic compatibility report. It requires 2-20 immutable backtests and flags mismatched period, symbols, timeframe, dataset hash, initial cash, fee/slippage/execution model, baseline set, code identity, provider, or feed before any operator treats the metrics as comparable.
- The browser defaults to labeled, strategy-specific numeric inputs with balanced/conservative/aggressive presets; advanced JSON remains available for inspection. Backtest results surface costs, trade/capacity evidence, bootstrap uncertainty, provenance, and comparison compatibility. Paper approval remains disabled until the selected run has a registered experiment protocol.
- Genuine rolling or anchored walk-forward evaluation over a caller-declared set of 1-20 canonical parameter candidates. Each fold ranks candidates only on its training bars, freezes the winner, warms indicators without scoring train execution, evaluates only the untouched test bars, and reports candidate scores, exact boundaries, out-of-sample results/aggregates, and leakage checks. Optional final holdouts are excluded from all fold selection and then scored once with parameters selected from pre-holdout history; optional caller-declared regime slices summarize validation and holdout observations separately. Work is bounded to 100 folds and 2,000,000 evaluated bars; multi-symbol histories must be timestamp-synchronized.
- Actor-scoped immutable crypto-bar datasets covering up to 3,650 days and 500,000 estimated bars. Ingestion uses bounded 90-day provider chunks and records UTC normalization, provider/feed, gaps, rejected bars, duplicate/conflicting bars, additions, corrections, removals, observed bounds, retrieval/server-response provenance in normalized bar DTOs, correction lineage, and a deterministic content hash. Exact repeats reuse the existing version.
- Backtests can consume one stored dataset without another provider read. Direct provider backtests and prospective shadow ticks retain the 1-90 day live-query bound.
- Every new shadow run links to one matching reviewed backtest. Backtests, runs, snapshots, and decisions record Git commit, dirty state, plugin/feature/policy versions, query window, provider/feed, and content hashes; dirty or legacy records are non-comparable, and a changed commit or definition requires a new reviewed backtest.
- Shadow-run persistence, manual ticks, in-process recurring scheduler, current crypto snapshots/order books, stale-data blocking, decision traces, receipts, and filters.
- Strategy dashboard v2 responses normalize latest persisted market observation, observation window, completed local evidence retrieval, and server response time. The visible quality panel reports expected, received, and omitted run configuration, linked backtest, clean provenance, comparability, decisions, traces, per-symbol snapshots, semantic observation times, fresh snapshots, and conditional paper approval, broker reconciliation, and fill-quality evidence with explicit conclusion impact. New runs remain `empty` until their first decision; stale or incomplete runs remain `partial`.
- Explicit run-level paper approval with symbol universe, budget, position/order bounds, spread, loss, drawdown, turnover, error cooldown, expiry, and GTC/IOC controls. Paper approval requires a pre-registered experiment protocol with hypothesis, frozen parameters, start/stop dates, minimum observations, maximum budget, invalidation criteria, and review cadence. New protocol registrations append versioned history instead of overwriting prior versions, and paper orders are blocked outside the approved protocol window.
- Paper strategy market-order submission, reconciliation, active performance, 1h/1d/7d post-fill attribution, order-book replay assumptions, paper-friction calibration, deterministic alerts, experiment review history, and promotion evidence gates. Promotion requires `pass` evidence for paper status, a 30-day paper window, enough decisions, and at least 20 fills; otherwise review returns `needs_evidence` and leaves the run in paper mode.
- SQLite-backed strategy runs, snapshots, decisions, orders, metrics, notes, local OpenTelemetry-shaped spans, hash-chained audit entries, JSON experiment reports, and ordered transactional schema migrations.

See `STRATEGY_LAB.md` for the operating guide and interpretation rules.

## Runtime and operations

- `GET /health` reports process liveness. `GET /ready` additionally requires preview signing, production security configuration when applicable, a valid SEC identity, and a reachable Alpaca paper account.
- Startup resolves an exact 40-character Git commit and working-tree state. Packaged deployments without `.git` metadata must provide `APP_GIT_COMMIT`; `APP_GIT_DIRTY=1` keeps results auditable but non-comparable.
- One process owns HTTP, SQLite, Alpaca streams, recovery polling, portfolio snapshots, SSE heartbeats, and the strategy scheduler. Runtime jobs are idempotent where implemented but not durable across restarts.
- The schema has 15 ordered migrations and 23 application tables including migration history. Migration 0015 appends account-activity observation, publication, effective-period, and retrieval fields without rewriting earlier identities. Serialized backup export includes a SHA-256 digest; legacy upgrade, activity-provenance restore, versioned dataset recovery, and both audit chains are tested.
- The source/output governance registry has 16 sources and 12 stored-output categories. It records policy decisions but does not enforce retention deletion or constitute external terms approval.
- `GET /api/operations/data-quality` reports provider health from local success, failure, stale-data, and throttling events, plus actor-scoped strategy dataset quality from immutable dataset stats: freshness, completeness, gaps, schema failures, duplicate rate, revisions, and last-success timestamps. It is operational evidence, not live provider probing or external entitlement approval.

## Safety and authorization

- `paper: true` is hard-coded where the Alpaca client is constructed. There is no live client or runtime switch.
- `LIVE_TRADING_ENABLED` and `LIVE_TRADING_REVIEW_ID` are read only by the governance report to show that live requests remain blocked; they do not construct or enable a live broker client.
- The global kill switch blocks every order surface. Reducing sells may pass exposure/turnover caps, but never bypass the kill switch.
- Ordinary sells cannot exceed holdings. New equity shorts require a separate explicit opt-in and cannot exceed the configured short boundary.
- Default equity order policy caps a ticket at the lesser of $2,500 or 2.5% of equity, resulting position concentration at 20%, and rolling 24-hour turnover at 10% of equity. Persisted operations policy can be stricter.
- Working broker orders and unexpired local reservations consume cash, inventory, concentration, and turnover capacity.
- Missing price/account data, stale strategy data, unsupported capability, invalid evidence, expired approval, malformed model output, and reconciliation uncertainty fail closed.
- Production authorization trusts only verified proxy headers and roles: `viewer`, `researcher`, `trader`, `operator`, and `admin`.
- Mutation bodies are bounded, mutation origins are checked, broker DTOs are allow-listed, output is escaped, and sensitive routes are rate limited. An empty or whitespace-only development `APP_ORIGIN` falls back to the request URL's own origin rather than disabling same-origin mutations; an explicit deployed origin remains authoritative.
- The encrypted secret vault stores AES-256-GCM envelopes and exposes metadata only. It is not wired as the runtime provider-key source.
- `/api/operations/data-governance` inventories 16 provider/derived sources and all 23 SQLite tables through 12 stored-output categories. Each entry records entitlement, terms status, retention, redistribution, and live-use decisions.
- `/api/operations/data-quality` surfaces provider and stored-dataset quality evidence from local observations so degraded, throttled, stale, unobserved, warning, and failed states are visible before relying on new decisions.

## Data flow

Manual and advisor orders follow this boundary:

```text
Alpaca state -> deterministic analysis/simulation -> signed preview
-> explicit approval -> fresh server revalidation -> Alpaca paper order
-> reconciliation -> decision receipt -> hash-chained audit evidence
```

Strategy decisions follow this boundary:

```text
Alpaca crypto bars/snapshot -> persisted snapshot -> deterministic plugin
-> strategy risk policy -> shadow decision or approved paper draft
-> global operations policy -> Alpaca paper order -> attribution/report
```

The browser is never an execution authority. A hidden or bypassed client confirmation cannot skip the server checks.

## Data-quality contract

- Every displayed or derived market value should identify feed/source and freshness. Unavailable entitlement is a first-class result.
- Official records, regulated-broker observations, licensed-provider records, media signals, and derived analysis remain visibly distinct.
- Canonical evidence, crypto Strategy Lab market DTOs, asset-search and single-symbol quote responses, market monitoring DTOs, company-market root/child DTOs, market workspace root/watchlist/asset/discovery/calendar DTOs, portfolio-performance, portfolio-risk, portfolio-exposure, and portfolio-snapshot root/child DTOs, option-chain and option-portfolio Greek DTOs, equity quote/bar stream DTOs, and the multi-asset market DTO distinguish provider observation/publication/effective time from retrieval and server response time; official macro evidence also records effective periods for record dates, months, quarters, and market-session calendars.
- Media repetition is not event confirmation. Provider failure does not mean no event occurred.
- Missing values remain missing; financial periods, units, accessions, and formulas stay attached to derived valuation output.
- SEC SIC is labeled as SEC SIC, not GICS or ICB.
- Stored provider output is internal-only by policy. Derived output inherits the restrictions of every upstream source.
- Paper fills and backtests are experimental evidence. They do not model all live fees, queue position, price improvement, latency, market impact, or venue behavior.

## Current limitations

- Direct provider backtests and the Strategy Lab UI remain bounded to 90 days. Longer stored-dataset backtests require API ingestion and are not yet exposed as a browser workflow.
- Walk-forward evaluation currently uses a fixed train-return selection objective. Alternative objectives and protection against a human choosing candidates after inspecting the period remain open.
- Stored crypto datasets make long-history inputs reproducible, but one provider is not independent corroboration and a content hash does not prove completeness, point-in-time correctness, or absence of upstream revisions.
- Provider-health status is derived from local event evidence. Providers without recent matching observations are `unobserved`, not healthy, and the report does not prove provider entitlement, external terms approval, or live API availability.
- The explicit time taxonomy is not yet present on every normalized provider DTO or browser-facing object. `asOf`, `timestamp`, and `quoteAt` remain legacy compatibility fields while call sites migrate to observation/publication/effective/retrieval/server-response fields.
- The backend is a modular monolith, but `backend/persistence/store.ts` still composes several repository families and some feature route modules remain large. Split them only where an ownership or test boundary is clear.
- The standard check includes direct request-boundary contracts and enforces strict TypeScript for `backend/`, `tests/`, and `scripts/`. The coverage gate requires a 95% function and 96% line mean across deterministic modules; route, provider/model orchestration, process startup, and browser code are validated separately and are not included in that percentage. Current counts and results live in `VALIDATION.md`.
- Option chains are capped at 120 rendered contracts and show the number displayed versus available, two-sided quote/IV/Greek coverage, and an explicit partial-data warning when model-dependent fields are absent.
- Operational scripts are type-checked in CI, but credentialed provider and paper-order smoke behavior is exercised only when those commands are run deliberately.
- SQLite, rate limiting, caches, market streams, and the scheduler are single-process. Scheduler work is not durable across restarts.
- Ordered migrations through 0015, rollback/upgrade fixtures, and serialized backup restore with activity provenance and audit verification are tested. No restore has been timed against a production-sized database or performed as a closed-beta operations drill.
- The governance registry is an internal decision record, not legal approval. Alpaca, Finnhub, GDELT, Treasury, FRED, BEA, SEC, BLS, OpenFIGI, and OpenAI terms still require an external entitlement review for the intended deployment.
- Retention decisions are recorded, but no automatic pruning or deletion job exists; strategy snapshots, evidence, spans, and audit records can grow without bound.
- Production hosting, real users, external compliance review, a measured paper beta, and live deployment review have not been completed.

These limitations are prioritized in `roadmap.md`; none should be inferred as complete from a UI panel or report endpoint.
