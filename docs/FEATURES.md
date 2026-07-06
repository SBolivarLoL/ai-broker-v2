# Implemented features

Last reviewed against `main` commit `4ee0978`: 2026-07-07.

This file describes what exists in the repository now. Planned work belongs only in `roadmap.md`; reproducible confidence evidence belongs in `VALIDATION.md`.

## Product scope

AI Broker is a single-user, paper-only investing and strategy-research workstation connected to a personal Alpaca Trading API account. Deterministic code owns calculations, validation, and execution policy. OpenAI agents may retrieve typed evidence, explain it, and draft an action, but cannot submit, cancel, or replace an order.

The browser exposes seven workspaces:

| Workspace  | Current capability                                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home       | Paper account, holdings, operations policy, kill switch, closed-beta evidence, and order entry                                                                   |
| Markets    | Market session, watchlists, movers, most active stocks, monitored news/events, 8-K alerts, and multi-asset capability status                                     |
| Portfolio  | Risk, performance, FIFO ledger, exposure, scenarios, optimizer proposals, constrained rebalance plans, trade journal, receipts, and order management             |
| Strategies | Crypto backtests, shadow/scheduled runs, protocol-gated paper approvals, manual crypto tickets, traces, metrics, alerts, performance, attribution, reviews, and reports |
| Research   | Company market data, SEC evidence, macro context, OpenFIGI, GDELT, optional Finnhub, comparables, scenario valuation, and AI company research                    |
| Options    | Bounded option chains, liquidity filters, Greeks, payoff/risk preview, long single-leg and net-debit vertical paper tickets, and position actions                |
| AI Advisor | Evidence-bound portfolio Q&A and reviewed rebalance ideas with exact simulation authority                                                                        |

## Capability map

### Broker and market state

- Alpaca paper account balances, cash, buying power, positions, open orders, activities, account health, and readiness.
- Alpaca watchlist create, rename, symbol add/remove, and delete workflows.
- NASDAQ clock/calendar, early-close information, session-aware order guidance, SIP discovery panels where entitled, and an IEX quote/bar SSE bridge.
- Company price, bid/ask spread, volume, daily bars, SPY/QQQ/DIA comparison, source timestamps, news, eligibility badges, and logo fallback.
- Read-only crypto quotes for BTC/USD, ETH/USD, and SOL/USD. Index and FX states remain explicitly unavailable when the account lacks entitlement.
- Fixed-income research returns an explicit unavailable capability record because this personal Trading API account is not a fixed-income-enabled Broker API partner.

### Orders and receipts

- Equity market, limit, stop, stop-limit, trailing-stop, OPG/CLS auction, extended-hours eligible, fractional, and dollar-notional tickets.
- Buy bracket/OTO and sell OCO linked orders.
- Multi-leg equity rebalance baskets with application-level atomic preview/reservation and sequential broker submission.
- Explicit paper short workflow with margin, marginability, easy-to-borrow, DAY, quantity, concentration, and fresh-state checks.
- Long buy-to-open options and defined-risk net-debit verticals. Naked option selling is unavailable.
- Standalone paper crypto market, limit, and stop-limit tickets. Approved strategy automation submits only bounded paper crypto market orders.
- Safe replacement, exact cancellation, and snapshot-bound cancel-all preview for eligible working orders.
- HMAC-signed two-minute previews, exact confirmation, fresh broker/market revalidation, idempotency keys, local risk reservations, broker reconciliation, and decision receipts.

### Portfolio intelligence

- Cashflow-adjusted performance, benchmark attribution, drawdown, volatility, Sharpe-style summary metrics, and persisted daily snapshots.
- FIFO activity ledger for fills, fees, dividends, interest, transfers, splits, symbol changes, and broker-provided corporate-action basis allocations. Unsupported basis changes remain unresolved rather than guessed.
- Historical and parametric 95% daily VaR, historical expected shortfall, covariance risk contribution, correlation, liquidity, and SPY benchmark diagnostics.
- Gross and signed asset-class, SEC SIC division/industry, beta, momentum, and realized-volatility exposure with explicit coverage gaps.
- Deterministic rate, technology, volatility, and user-entered held-symbol scenarios.
- Read-only risk-parity and shrunk mean-variance proposals. Targets flow into a constrained rebalance planner before the normal basket preview.
- Rebalance planning with turnover, cash buffer, fee, imported FIFO lot, tax-rate, maximum-tax, precision, and minimum-notional constraints.
- Persisted operations policy for kill switch, order notional, symbol notional, position exposure, sector exposure, drawdown, and turnover.

### Research and AI

- Shared SEC EDGAR client with declared identity, caching, retry/backoff, serialized fair-access requests, filing sections, company facts, financial trends, SIC classification, and material 8-K alerts.
- Canonical evidence records carrying provider/source identity, authority, claim status, timestamps, entity identifiers, canonical URL, content hash, and JSON-compatible payload.
- Conservative evidence deduplication: exact provider IDs, URL plus content, or same-entity exact content only. Similar headlines do not become verified facts.
- Official macro context from public Treasury and BLS data, with optional FRED and BEA coverage.
- Licensed Alpaca/Benzinga articles, bounded GDELT public-web media signals, optional Finnhub enrichment, and OpenFIGI v3 identity mapping with explicit partial/unavailable states.
- Comparable valuation tables from current Alpaca price plus directly reported SEC revenue, net income, diluted EPS, equity, and shares. Missing or invalid inputs remain unavailable.
- User-authored bull/base/bear assumptions converted into deterministic 12-month valuation scenarios. They are scenarios, not forecasts.
- Company research and portfolio Q&A agents with typed read-only tools, bounded outputs, evidence-ID validation, numeric grounding checks, and unsafe-certainty rejection.
- Independent counter-thesis review before actionable advisor ideas; unapproved ideas become watch-only.
- Receipt-linked trade journal with immutable thesis text, human-classified thesis drift, fresh market/position context, and audit history.

### Strategy Lab

- Nine deterministic plugin strategies: cash, buy-and-hold, time-sliced accumulation, moving-average trend, mean reversion, breakout momentum, volatility filter, BTC/ETH relative strength, and order-book liquidity scout. One strict schema supplies canonical defaults and rejects unknown, non-finite, contradictory, or out-of-range parameters before execution or persistence. Relative strength derives the opposite BTC/ETH peer from the ordered symbol pair rather than accepting a second peer override.
- Immutable bar-close backtests with cash and buy-and-hold baselines, fees, slippage, drawdown, exposure, turnover, exact normalized dataset hashes, and legacy train/test boundary segmentation.
- Backtest results include deterministic trade metrics: material simulated order count, position episodes, closed round trips, average holding bars/days, gross and net return, downside deviation, Sortino, Calmar, profit factor, hit rate, average win/loss, turnover, exposure, and capacity warnings for high turnover, high trade frequency, or high exposure.
- Backtest results and walk-forward out-of-sample aggregates include deterministic moving-block-bootstrap uncertainty evidence for total return and max drawdown. The range uses 5th/50th/95th percentiles over 500 resamples, preserves short-run return clustering through contiguous blocks, reports `insufficient_data` below 20 scored return observations, and is explicitly marked `not_rankable`.
- Backtest cohorts can be compared through a deterministic compatibility report. It requires 2-20 immutable backtests and flags mismatched period, symbols, timeframe, dataset hash, initial cash, fee/slippage/execution model, baseline set, code identity, provider, or feed before any operator treats the metrics as comparable.
- Genuine rolling or anchored walk-forward evaluation over a caller-declared set of 1-20 canonical parameter candidates. Each fold ranks candidates only on its training bars, freezes the winner, warms indicators without scoring train execution, evaluates only the untouched test bars, and reports candidate scores, exact boundaries, out-of-sample results/aggregates, and leakage checks. Optional final holdouts are excluded from all fold selection and then scored once with parameters selected from pre-holdout history; optional caller-declared regime slices summarize validation and holdout observations separately. Work is bounded to 100 folds and 2,000,000 evaluated bars; multi-symbol histories must be timestamp-synchronized.
- Actor-scoped immutable crypto-bar datasets covering up to 3,650 days and 500,000 estimated bars. Ingestion uses bounded 90-day provider chunks and records UTC normalization, provider/feed, gaps, rejected bars, duplicate/conflicting bars, additions, corrections, removals, observed bounds, correction lineage, and a deterministic content hash. Exact repeats reuse the existing version.
- Backtests can consume one stored dataset without another provider read. Direct provider backtests and prospective shadow ticks retain the 1-90 day live-query bound.
- Every new shadow run links to one matching reviewed backtest. Backtests, runs, snapshots, and decisions record Git commit, dirty state, plugin/feature/policy versions, query window, provider/feed, and content hashes; dirty or legacy records are non-comparable, and a changed commit or definition requires a new reviewed backtest.
- Shadow-run persistence, manual ticks, in-process recurring scheduler, current crypto snapshots/order books, stale-data blocking, decision traces, receipts, and filters.
- Explicit run-level paper approval with symbol universe, budget, position/order bounds, spread, loss, drawdown, turnover, error cooldown, expiry, and GTC/IOC controls. Paper approval requires a pre-registered experiment protocol with hypothesis, frozen parameters, start/stop dates, minimum observations, maximum budget, invalidation criteria, and review cadence. New protocol registrations append versioned history instead of overwriting prior versions, and paper orders are blocked outside the approved protocol window.
- Paper strategy market-order submission, reconciliation, active performance, 1h/1d/7d post-fill attribution, order-book replay assumptions, paper-friction calibration, deterministic alerts, experiment review history, and promotion evidence gates. Promotion requires `pass` evidence for paper status, a 30-day paper window, enough decisions, and at least 20 fills; otherwise review returns `needs_evidence` and leaves the run in paper mode.
- SQLite-backed strategy runs, snapshots, decisions, orders, metrics, notes, local OpenTelemetry-shaped spans, hash-chained audit entries, JSON experiment reports, and ordered transactional schema migrations.

See `STRATEGY_LAB.md` for the operating guide and interpretation rules.

## Runtime and operations

- `GET /health` reports process liveness. `GET /ready` additionally requires preview signing, production security configuration when applicable, a valid SEC identity, and a reachable Alpaca paper account.
- Startup resolves an exact 40-character Git commit and working-tree state. Packaged deployments without `.git` metadata must provide `APP_GIT_COMMIT`; `APP_GIT_DIRTY=1` keeps results auditable but non-comparable.
- One process owns HTTP, SQLite, Alpaca streams, recovery polling, portfolio snapshots, SSE heartbeats, and the strategy scheduler. Runtime jobs are idempotent where implemented but not durable across restarts.
- The schema has 14 ordered migrations and 23 application tables including migration history. Serialized backup export includes a SHA-256 digest; fixture restore, versioned dataset recovery, and both audit chains are tested.
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
- Mutation bodies are bounded, mutation origins are checked, broker DTOs are allow-listed, output is escaped, and sensitive routes are rate limited.
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
- The backend is a modular monolith, but `backend/persistence/store.ts` still composes several repository families and some feature route modules remain large. Split them only where an ownership or test boundary is clear.
- The standard check includes direct request-boundary contracts and enforces strict TypeScript for `backend/`, `tests/`, and `scripts/`. The coverage gate requires a 95% function and 96% line mean across deterministic modules; route, provider/model orchestration, process startup, and browser code are validated separately and are not included in that percentage. Current counts and results live in `VALIDATION.md`.
- Operational scripts are type-checked in CI, but credentialed provider and paper-order smoke behavior is exercised only when those commands are run deliberately.
- SQLite, rate limiting, caches, market streams, and the scheduler are single-process. Scheduler work is not durable across restarts.
- Ordered migrations, rollback/upgrade fixtures, and serialized backup restore with audit verification are tested. No restore has been timed against a production-sized database or performed as a closed-beta operations drill.
- The governance registry is an internal decision record, not legal approval. Alpaca, Finnhub, GDELT, Treasury, FRED, BEA, SEC, BLS, OpenFIGI, and OpenAI terms still require an external entitlement review for the intended deployment.
- Retention decisions are recorded, but no automatic pruning or deletion job exists; strategy snapshots, evidence, spans, and audit records can grow without bound.
- Production hosting, real users, external compliance review, a measured paper beta, and live deployment review have not been completed.

These limitations are prioritized in `roadmap.md`; none should be inferred as complete from a UI panel or report endpoint.
