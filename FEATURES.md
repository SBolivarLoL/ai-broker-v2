# Implemented features

Last reviewed against `main`: 2026-07-01.

This file describes what exists in the repository now. Planned work belongs only in `roadmap.md`; reproducible confidence evidence belongs in `VALIDATION.md`.

## Product scope

AI Broker is a single-user, paper-only investing and strategy-research workstation connected to a personal Alpaca Trading API account. Deterministic code owns calculations, validation, and execution policy. OpenAI agents may retrieve typed evidence, explain it, and draft an action, but cannot submit, cancel, or replace an order.

The browser exposes seven workspaces:

| Workspace | Current capability |
| --- | --- |
| Home | Paper account, holdings, operations policy, kill switch, closed-beta evidence, and order entry |
| Markets | Market session, watchlists, movers, most active stocks, monitored news/events, 8-K alerts, and multi-asset capability status |
| Portfolio | Risk, performance, FIFO ledger, exposure, scenarios, optimizer proposals, constrained rebalance plans, trade journal, receipts, and order management |
| Strategies | Crypto backtests, shadow/scheduled runs, bounded paper approvals, manual crypto tickets, traces, metrics, alerts, performance, attribution, reviews, and reports |
| Research | Company market data, SEC evidence, macro context, OpenFIGI, GDELT, optional Finnhub, comparables, scenario valuation, and AI company research |
| Options | Bounded option chains, liquidity filters, Greeks, payoff/risk preview, long single-leg and net-debit vertical paper tickets, and position actions |
| AI Advisor | Evidence-bound portfolio Q&A and reviewed rebalance ideas with exact simulation authority |

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

- Nine deterministic plugin strategies: cash, buy-and-hold, time-sliced accumulation, moving-average trend, mean reversion, breakout momentum, volatility filter, BTC/ETH relative strength, and order-book liquidity scout. One strict schema supplies canonical defaults and rejects unknown, non-finite, contradictory, or out-of-range parameters before execution or persistence.
- Bar-close backtests with cash and buy-and-hold baselines, fees, slippage, drawdown, exposure, turnover, and optional walk-forward window segmentation.
- Shadow-run persistence, manual ticks, in-process recurring scheduler, current crypto snapshots/order books, stale-data blocking, decision traces, receipts, and filters.
- Explicit run-level paper approval with symbol universe, budget, position/order bounds, spread, loss, drawdown, turnover, error cooldown, expiry, and GTC/IOC controls.
- Paper strategy market-order submission, reconciliation, active performance, 1h/1d/7d post-fill attribution, order-book replay assumptions, deterministic alerts, and experiment review history.
- SQLite-backed strategy runs, snapshots, decisions, orders, metrics, notes, local OpenTelemetry-shaped spans, hash-chained audit entries, and JSON experiment reports.

See `STRATEGY_LAB.md` for the operating guide and interpretation rules.

## Safety and authorization

- `paper: true` is hard-coded where the Alpaca client is constructed. There is no live client or runtime switch.
- The global kill switch blocks every order surface. Reducing sells may pass exposure/turnover caps, but never bypass the kill switch.
- Ordinary sells cannot exceed holdings. New equity shorts require a separate explicit opt-in and cannot exceed the configured short boundary.
- Default equity order policy caps a ticket at the lesser of $2,500 or 2.5% of equity, resulting position concentration at 20%, and rolling 24-hour turnover at 10% of equity. Persisted operations policy can be stricter.
- Working broker orders and unexpired local reservations consume cash, inventory, concentration, and turnover capacity.
- Missing price/account data, stale strategy data, unsupported capability, invalid evidence, expired approval, malformed model output, and reconciliation uncertainty fail closed.
- Production authorization trusts only verified proxy headers and roles: `viewer`, `researcher`, `trader`, `operator`, and `admin`.
- Mutation bodies are bounded, mutation origins are checked, broker DTOs are allow-listed, output is escaped, and sensitive routes are rate limited.
- The encrypted secret vault stores AES-256-GCM envelopes and exposes metadata only. It is not wired as the runtime provider-key source.

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
- Paper fills and backtests are experimental evidence. They do not model all live fees, queue position, price improvement, latency, market impact, or venue behavior.

## Current limitations

- Backtest history is currently bounded to 90 days by both the server and Strategy Lab input, which is too short to establish robustness across long market regimes.
- “Walk-forward” currently returns train/test window boundaries; it does not tune on train data and score frozen parameters out of sample.
- Backtest results are returned to the browser but are not persisted as immutable experiment records or linked to the shadow run created afterward.
- Strategy records use static version labels and config hashes but do not yet persist the exact Git commit, feature-schema version, or input dataset hash promised by a fully reproducible experiment.
- `src/app.ts` remains a 2,378-line request/composition module; `src/index.html` is a roughly 255 KB single-file client; `src/store.ts` contains schema setup and all repositories. The 22-line `src/server.ts` entry is now separate, but per-domain route and UI maintenance remain concentrated.
- The 242-test suite includes direct request-boundary contracts and enforces 95% function and 96% line coverage across imported TypeScript modules. `src/app.ts` remains at 6.08% of functions and 67.13% of lines, many broker-backed route branches remain uncovered, and the browser client is validated separately rather than included in that percentage.
- SQLite, rate limiting, caches, market streams, and the scheduler are single-process. Scheduler work is not durable across restarts.
- Schema metadata and backup export exist, but ordered migration rollback/upgrade fixtures and a measured restore drill do not.
- The data-governance registry covers major market/news/identity categories but does not yet inventory every official macro/SEC source or the OpenAI service.
- Production hosting, real users, external compliance review, a measured paper beta, and live deployment review have not been completed.

These limitations are prioritized in `roadmap.md`; none should be inferred as complete from a UI panel or report endpoint.
