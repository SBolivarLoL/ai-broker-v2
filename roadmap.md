# AI Broker product roadmap

Last reviewed: 2026-06-29

This document is the build map for turning AI Broker into a serious personal investing and paper-trading workstation. Alpaca supplies brokerage state, execution, and market data. Deterministic application code owns calculations and safety policy. OpenAI agents may research, explain, compare, and draft actions, but they do not bypass the order preview and approval boundary.

## Product principles

1. Paper trading remains the default and only enabled execution mode until live-trading, legal, operational, and security gates are deliberately completed.
2. Risk and accounting calculations are deterministic and testable. An LLM explains results; it does not invent them.
3. Every recommendation identifies its data timestamp, sources, assumptions, risks, and invalidation conditions.
4. Every manual or agent-drafted order has a fresh quote, portfolio-impact preview, explicit approval, idempotency key, broker status reconciliation, and decision receipt; automated paper strategy orders require explicit run-level approval plus per-decision receipts.
5. Data entitlements, asset availability, account eligibility, and jurisdiction are runtime capabilities—not assumptions.
6. Market data, news, filings, and web content are untrusted inputs to agents.
7. Strategy automation starts in shadow mode, graduates to paper-only automation only after explicit run-level approval, and remains bounded by budget, exposure, loss, stale-data, and kill-switch policy.
8. Every strategy decision is reconstructable from versioned code, input data, derived features, weights, thresholds, risk checks, and paper-fill evidence.
9. Paper results are treated as experimental evidence, not proof of live performance; strategy evaluation must model fees, spread, slippage, latency, missed fills, and liquidity limits.

## What Alpaca can power

### Account, portfolio, and ledger

| Alpaca capability | Broker feature we can build | Status / notes |
| --- | --- | --- |
| Account balances, status, equity, cash and buying power | Account overview, buying-power meter, trading-state warnings | Basic view exists |
| Open positions | Holdings, exposure, cost basis, unrealized P&L, close-position workflows | Basic view exists |
| Portfolio history | Equity curve, cashflow-adjusted P&L, drawdown, volatility, Sharpe and period comparison | Initial version exists |
| Account activities | Authoritative fill ledger, fees, dividends, interest, transfers, option events and corporate-action adjustments | FIFO ledger applies explicit split/symbol-change evidence; complex basis allocations are flagged for review |
| Account configuration | Show and safely update supported trading preferences | Defer until settings UX and audit log exist |
| Order and account update streams | Near-real-time fills, partial fills, cancellations, rejections and position refresh | Trade-update stream, reconnects, order blotter and REST recovery polling exist |

### Order management and execution

| Capability | Product feature | Required controls |
| --- | --- | --- |
| Market orders | Current paper buy/sell flow | Already guarded |
| Limit, stop and stop-limit orders | Full order ticket with price validation and preview | Validate tick sizes, session and buying power |
| Trailing stops | Dollar- or percent-based protective exits | Explain high-water mark and gap/slippage risk |
| Bracket orders | Entry with take-profit and stop-loss children | Preview every leg and reserve worst-case exposure |
| OCO and OTO orders | Linked exits or triggered child order | Reconcile nested lifecycle atomically |
| Replace and cancel | Manage working orders from an order blotter | Fresh state, idempotency and race handling |
| Fractional and notional orders | Invest by dollars or fractional quantity | Asset eligibility and precision rules |
| Time in force | DAY, GTC, IOC/FOK where supported, opening/closing auction orders | Show exact session behavior |
| Extended-hours orders | Overnight, pre-market and after-hours workflows | Limit-only rules where applicable; liquidity warning |
| Short selling and margin | Short inventory, borrow and margin-risk workflows | Disabled until dedicated policy and suitability controls |
| Bulk close/cancel | Emergency flatten and cancel-all controls | Strong confirmation, dry run, audit and kill switch |
| Options orders and exercise | Single- and multi-leg options workflows, exercise/DNE state | Separate options risk engine required |

Alpaca documents order monitoring, replacement, cancellation, advanced order classes, extended hours, and order-state streaming in its [orders documentation](https://docs.alpaca.markets/us/docs/orders-at-alpaca). Fractional behavior and permitted combinations must be checked against the current [fractional trading rules](https://docs.alpaca.markets/us/v1.1/docs/fractional-trading).

### Reference data and market operations

| Capability | Broker feature |
| --- | --- |
| Tradable asset catalog | Fuzzy company search, eligibility badges, shortable/fractionable status and asset details |
| Option contract catalog | Expiration/strike/right filters and option-chain navigation |
| Market clock and calendar | Open/closed status, next session, holiday schedule and order-timing warnings |
| Corporate-action announcements/history | Split, dividend, merger, spin-off and symbol-change calendar with portfolio impact |
| Watchlists | Server-backed custom watchlists, tags, notes and agent monitoring scopes |
| Company logos | Recognizable search, holdings and watchlist UI |

Corporate-action data can be delayed, so it should inform users without being treated as an infallible real-time trigger. See Alpaca's [corporate actions reference](https://docs.alpaca.markets/us/reference/corporateactions-1).

### Stock market data

| Data | Features we can build |
| --- | --- |
| Historical and latest bars | Candlestick charts, returns, technical indicators, volatility, beta, correlation and backtests |
| Trades and quotes | Time and sales, spread, midpoint, liquidity, slippage and execution-quality views |
| Auctions | Opening/closing auction context and imbalance research where data permits |
| Multi-symbol snapshots | Fast watchlist/portfolio refresh with latest trade, quote and daily bars |
| Exchange and condition metadata | Explain unusual trades/quotes and filter invalid prints |
| Real-time stock stream | Live quotes, bars, trades, alerts and streaming dashboards |

Snapshot contents and feed selection are described in the official [stock snapshot reference](https://docs.alpaca.markets/reference/stocksnapshotsingle). Feed coverage varies by subscription; the UI must identify IEX, SIP, delayed, overnight, or other selected feeds.

### Discovery, news, and events

| Capability | Broker feature |
| --- | --- |
| Market news REST API | Symbol news feed, portfolio news, historical event review and cited AI summaries |
| Real-time news stream | Breaking-news alerts, portfolio relevance ranking and event timelines |
| Most-active screener | Volume/trade-count leaders and unusual-attention discovery |
| Market movers | Intraday gainers/losers with liquidity and risk filters |
| Corporate actions | Ex-date/event alerts and portfolio-impact previews |
| Market calendar | Earnings/event scheduling aligned to actual sessions |

Alpaca's screeners expose [most-active stocks](https://docs.alpaca.markets/reference/mostactives-1) and [market movers](https://docs.alpaca.markets/reference/movers-1). These are discovery inputs, not recommendations.

### Options

| Capability | Broker feature |
| --- | --- |
| Contract reference data | Option-chain browser by underlying, expiration, strike and type |
| Historical/latest bars, trades and quotes | Contract charting, spread and liquidity analysis |
| Chain snapshots | Calls/puts surface, implied-volatility view and strategy discovery |
| Real-time options stream | Live chain and alerting, subject to feed entitlement |
| Order/position support | Paper options ticket, lifecycle, exercise and assignment-aware ledger |

Before options execution, build deterministic Black-Scholes/reference pricing, Greeks, max gain/loss, breakevens, probability caveats, assignment/exercise scenarios, expiry handling, liquidity gates, and portfolio-level stress tests. Options market data and order constraints are described in Alpaca's [options trading guide](https://docs.alpaca.markets/docs/options-trading) and [real-time options data guide](https://docs.alpaca.markets/us/docs/real-time-option-data).

### Crypto and other asset data

| Capability | Potential feature | Product decision |
| --- | --- | --- |
| Crypto bars, trades, quotes, order books and snapshots | 24/7 crypto terminal, liquidity/depth views, strategy features, backtests and paper-run analytics | Add asset-class-specific policy before automation |
| Crypto real-time stream | Live crypto quotes, trades, books, alerts and strategy signal evaluation | Subscription/venue aware; persist raw snapshots used by decisions |
| Crypto wallets, transfers and whitelisted addresses | Funding and custody workflows | High-risk; out of scope for personal broker MVP |
| Crypto perpetual futures data, leverage and funding APIs | Perpetuals dashboard and risk | Beta/high leverage; do not enable execution initially |
| Index values | Benchmark charts, relative performance and regime signals | Useful read-only feature |
| FX rates | Currency conversion and global exposure normalization | Useful read-only feature |
| Fixed-income quotes/prices and Treasury/corporate reference | Bond research and multi-asset allocation | Confirm account/data eligibility before promising trading |
| Tokenization endpoints | Tokenized-asset experiments | Experimental; not a core roadmap item |

Alpaca exposes real-time crypto trades, quotes, books and bars through its [crypto data stream](https://docs.alpaca.markets/docs/real-time-crypto-pricing-data). Alpaca paper trading also simulates crypto trading, but paper fills do not fully capture real-world market impact, queue position, latency slippage, price improvement, fees or liquidity differences; strategy analytics must label these limitations and run friction-adjusted estimates. Beta and funding APIs require a separate security and operational review.

### Broker API versus a personal Trading API account

Alpaca's **Trading API** connects this application to an Alpaca account. Alpaca's separate **Broker API** is for businesses operating brokerage experiences for end users and may include account opening/KYC, funding, transfers, documents, journals and multi-account operations. Those are not automatically available with this project's personal paper credentials.

If this becomes a multi-user brokerage product, create a separate program for:

- Legal/compliance ownership, licensing and disclosures.
- KYC/CIP/AML and sanctions workflows.
- Customer account onboarding and agreements.
- ACH/wire/transfer operations and fraud controls.
- Statements, confirmations, tax documents and retention.
- Best execution, surveillance, complaints and regulatory reporting.
- Tenant isolation, authorization, reconciliation and incident response.

Alpaca distinguishes the Trading, Broker, Market Data and OAuth products in its [developer overview](https://docs.alpaca.markets/docs).

## AI features powered by OpenAI agents

### Research agents

- **Portfolio analyst:** answers questions about holdings, exposure, performance and risk using deterministic tools.
- **Company analyst:** combines Alpaca price/volume data with SEC filings, fundamentals and cited research.
- **News analyst:** clusters duplicate stories, builds timelines, identifies portfolio relevance and separates facts from inference.
- **Earnings analyst:** compares reported results, guidance, estimates, price reaction and prior calls.
- **Risk officer:** reviews concentration, correlations, liquidity, scenario loss and policy breaches before a plan is shown.
- **Options analyst:** evaluates payoff, Greeks, volatility and assignment scenarios without placing trades.
- **Trade-review agent:** creates pre-trade and post-trade reviews, including thesis, invalidation, sizing and execution quality.
- **Strategy analyst:** explains deterministic crypto strategy runs, compares experiment cohorts, identifies regime dependence, and flags overfitting without changing live parameters.
- **Decision auditor:** answers "why did this strategy decide this?" from stored traces, features, weights, thresholds, risk checks, and paper-fill outcomes. Initial Strategy Lab UI exposes persisted crypto shadow runs, decision traces, features, thresholds, risk checks, data provenance and receipts.

### Agent tools to build

- `get_account`, `get_positions`, `get_orders`, `get_activities`
- `get_portfolio_performance`, `get_risk_snapshot`, `run_stress_test`
- `get_asset`, `search_assets`, `get_market_clock`
- `get_snapshot`, `get_bars`, `get_quotes`, `get_trades`
- `get_news`, `get_movers`, `get_most_actives`
- `get_corporate_actions`, `get_option_chain`
- `get_sec_filings`, `search_filing_sections`, `get_company_facts`
- `compare_companies`, `calculate_valuation`, `calculate_technicals`
- `simulate_order`, `simulate_rebalance`, `draft_order`
- `get_strategy_catalog`, `get_strategy_run`, `get_strategy_decision_trace`
- `get_crypto_bars`, `get_crypto_quotes`, `get_crypto_orderbook_snapshot`
- `calculate_crypto_features`, `backtest_strategy`, `compare_strategy_runs`
- `start_shadow_strategy_run`, `pause_strategy_run`, `review_strategy_run`, `draft_strategy_config`

Only `draft_order` may produce an order-ticket draft. Actual submission remains a separate deterministic server workflow with explicit user approval.
Strategy tools may start or pause shadow runs. Paper strategy execution requires a separate explicit run-level approval workflow, hard limits, decision receipts and paper-only broker submission.

### AI experiences

- Morning and closing portfolio briefings with citations.
- “Why did this move?” explanations using price, volume, news and events.
- Natural-language screeners that compile into visible deterministic filters.
- Bull/base/bear company memos with assumptions and valuation ranges.
- Portfolio review: winners, losers, drift, new risks and upcoming catalysts.
- Watchlist monitoring with change-only summaries to reduce noise.
- Trade journal that compares the original thesis with subsequent evidence.
- Counter-thesis agent that argues against every proposed trade.
- Post-trade execution review using quote and fill data.
- Crypto strategy lab with backtest, shadow run, paper run, cohort comparison and strategy-retirement workflows. Initial UI now supports backtests, shadow-run creation, manual and scheduled ticks, explicit paper approval, pause/kill controls, experiment review decisions and report export.
- Decision trace explorer showing raw inputs, derived features, signal weights, risk gates, final action, paper-order linkage and post-fill attribution. Initial UI now shows features, thresholds, risk checks, source/feed freshness, order outcomes, linked order payloads, attribution and raw trace JSON.
- Personalized education that explains metrics without presenting certainty.

## Crypto strategy experiment model

Goal: run bounded crypto strategies long enough to learn which ideas fit this account, risk tolerance, execution venue and time horizon, without confusing paper P&L with live edge.

### Strategy lifecycle

1. **Research specification:** define hypothesis, symbols, timeframe, features, execution style, risk limits, invalidation rule and expected failure modes.
2. **Deterministic backtest:** replay historical bars, quotes and order-book snapshots when available; include fees, spread crossing, slippage, latency and missed-fill assumptions.
3. **Walk-forward validation:** split by time and market regime; tune on one window, freeze parameters, then evaluate on unseen windows.
4. **Shadow run:** compute live signals and decisions without submitting paper orders; compare intended entries/exits with subsequent market movement and liquidity.
5. **Paper run:** after explicit run-level approval, submit paper-only crypto orders within strategy budget, max position, max loss, max turnover and stale-data limits.
6. **Review and promote/retire:** compare against BTC buy-and-hold, cash, equal-weight basket and no-trade baselines; promote only if results remain useful after friction and drawdown stress.

Current implementation checkpoint: Strategy Lab is now a working experiment surface, not just a design target. It supports one-symbol crypto bar backtests, BTC/ETH comparison backtests, a deterministic strategy plugin lifecycle, configurable fee/slippage assumptions, walk-forward windows, breakout momentum with volume confirmation, volatility filtering from realized returns, BTC/ETH relative strength, order-book liquidity scouting, shadow-run creation, manual and scheduled tick evaluation, explicit run-level paper approval, crypto-specific paper risk policy for 24/7 sessions, cash/buying-power, daily loss, drawdown, turnover and error cool-down gates, pause/kill controls, bounded strategy paper crypto market-order submission, standalone signed paper crypto market/limit/stop-limit tickets, persisted data snapshots, order-book replay assumptions for spread, latency, partial fills and missed fills, local OpenTelemetry-shaped span events, persistent strategy metrics, deterministic strategy alerts, hash-chained audit trail with retention metadata, role-aware OIDC proxy authorization, encrypted AES-GCM secret vault metadata, data licensing/subscription governance registry, bounded accession-linked SEC Risk Factors and MD&A evidence through a cached, retrying and fair-access-throttled client, production-governance packet with closed-beta safety targets and a hard live-trading blocker, measured closed-beta evidence export derived from receipts, events, decision audits and strategy reviews, persisted global operations policy for kill-switch, order, exposure and turnover caps across order-entry surfaces, schema migration metadata, serialized SQLite backup export, observability export and incident response packets, hash-chained decision audit entries for receipts and agent plans, decision receipts, trace API lookups, trace filters, order-outcome drilldowns, run dashboard metrics, post-fill attribution windows, active-run P&L/drawdown versus baselines, experiment review decisions and exportable experiment reports. It does not yet support richer automated strategy order types, automated multi-leg crypto rotation, completed external legal/compliance signoff or a completed paper beta with all measured targets passing.

### Initial strategy catalog

| Strategy | Hypothesis | Data required | Primary parameters | Evaluation focus |
| --- | --- | --- | --- | --- |
| Buy-and-hold benchmark | Passive exposure is the default hurdle to beat | Daily bars and account equity | BTC/ETH/SOL weights | Relative return, drawdown, volatility, turnover avoided |
| Time-sliced accumulation | Small scheduled buys reduce timing dependence | Latest quote, spread, cash budget | Interval, notional, max spread, max volatility | Slippage, average entry, budget discipline |
| Moving-average trend following | Crypto trends persist after enough confirmation | Bars across 1h/4h/1d windows | Fast/slow averages, confirmation bars, stop | Whipsaw rate, capture ratio, drawdown |
| Breakout momentum | New highs with volume/liquidity confirmation can continue | Bars, volume, spread, optional book depth | Lookback high, volume multiple, stop distance | False breakouts, spread cost, tail wins |
| Mean reversion | Extreme short-term moves often partially reverse | Bars, RSI/z-score/Bollinger bands, spread | Lookback, entry z-score, exit mean, stop | Loss clustering, regime failure, holding time |
| Volatility filter | Strategy risk changes by realized volatility regime | Bars and rolling return distribution | Volatility windows, risk-on/off thresholds | Drawdown reduction versus missed upside |
| BTC/ETH relative strength | Capital should favor the stronger major asset in persistent regimes | BTC/ETH bars and correlation | Relative momentum window, rebalance threshold | Turnover, concentration, benchmark edge |
| Order-book liquidity scout | Thin books and wide spreads predict poor execution | Quotes and order-book snapshots | Depth levels, imbalance, max spread bps | Execution avoidance, fill quality, data stability |

Do not start with high-frequency market making, leverage, perpetual futures, cross-exchange arbitrage, wallet movement or custody workflows. Those require execution infrastructure, fee modeling, venue-level microstructure, operational controls and security review that are outside this personal paper-trading roadmap.

### Strategy run record

Every strategy run should persist:

- `strategy_id`, `strategy_version`, git commit, config hash, parameter set, feature schema version and policy version.
- Symbol universe, data providers, entitlement state, feed, timestamps, stale-data flags, and gaps.
- Starting capital, paper account id alias, run budget, max position, max daily turnover, max drawdown, kill-switch thresholds and schedule.
- Backtest period, validation period, shadow period, paper period and market-regime labels.
- Baselines used for comparison, including BTC buy-and-hold, cash and equal-weight basket where applicable.
- Fees, spread, slippage, latency, partial-fill and missed-fill assumptions.
- Evaluation metrics: total return, annualized return, volatility, Sharpe/Sortino where meaningful, max drawdown, Calmar, win rate, profit factor, exposure time, turnover, average spread paid, fill ratio and capacity warnings.
- Human notes: hypothesis, why started, why stopped, changes made, and what would invalidate future use.

### Decision trace schema

Every strategy decision should create a durable traceable receipt:

| Field | Purpose |
| --- | --- |
| `trace_id`, `run_id`, `decision_id` | Join logs, metrics, spans, order receipts and UI drilldowns |
| `strategy_version`, `config_hash`, `policy_version` | Reproduce code path and risk policy |
| `as_of`, `symbol`, `timeframe`, `data_snapshot_ids` | Identify exact data used |
| `features` | Store derived values such as returns, moving averages, volatility, RSI, z-score, spread, depth and volume |
| `weights` | Explain how each signal contributed to the final score or allocation |
| `thresholds` | Show entry, exit, stop, stale-data and risk-gate boundaries |
| `raw_signal`, `risk_adjusted_signal`, `target_position` | Separate model output from risk-adjusted intent |
| `risk_checks` | Capture cash, concentration, drawdown, turnover, liquidity and stale-data outcomes |
| `decision` | `hold`, `enter`, `increase`, `reduce`, `exit`, `pause` or `block` with reason codes |
| `draft_order` / `paper_order_id` | Link the decision to a paper order when one exists |
| `fill_snapshot` | Record broker status, fill price, reference quote, spread and slippage estimate |
| `post_decision_outcome` | Attach later attribution windows such as 1h, 1d and 7d return after the decision |

### Observability model

- Use OpenTelemetry-compatible traces for strategy ticks, data fetches, feature calculation, risk checks, paper-order submission and reconciliation.
- Emit metrics for data latency, tick duration, decision count, block reasons, stale-data rate, order acceptance, fill ratio, realized spread cost, slippage estimate, drawdown, exposure and error budget.
- Keep structured logs for warnings and exceptions, but make decision receipts the authoritative audit artifact.
- Add a local trace/export mode first, then support OTLP export through an OpenTelemetry Collector when production hosting exists.
- Redact credentials, raw account identifiers and sensitive actor details from traces; use stable aliases and receipt IDs instead.

## Phased implementation plan

### Phase 0 — Current foundation

- [x] Connected paper account, balances, positions and open orders.
- [x] Fuzzy symbol/company search and latest prices.
- [x] Market-order preview, confirmation, idempotency and receipts.
- [x] Cash, concentration, turnover and pending-order risk controls.
- [x] Portfolio volatility, drawdown, historical VaR and stress scenarios.
- [x] Portfolio history, P&L metrics, equity curve and unrealized attribution.
- [x] Evidence-bound read-only portfolio agent.
- [x] Cited company research agent using Alpaca market data, SEC filings and XBRL facts.
- [x] Persisted agent evaluation metrics for citations, numeric grounding, tool use, latency and tokens.

### Phase 1 — Trusted portfolio record

Goal: make the broker's accounting and order state reliable enough to support deeper analysis.

- [x] Ingest paginated account activities into a normalized local ledger.
- [x] Calculate FIFO realized P&L from fills and separate fees from trading returns.
- [x] Reconcile explicit forward/reverse splits and symbol changes while preserving FIFO basis.
- [ ] Reconcile mergers, spin-offs and other actions that require broker-provided basis allocations; unresolved events are now surfaced explicitly.
- [x] Separate deposits/withdrawals from investment performance.
- [x] Add dividends, interest, fees and cashflow timeline.
- [x] Add cashflow-adjusted time-weighted and money-weighted returns with configurable benchmark attribution and coverage flags.
- [x] Maintain order state with Alpaca trade-update streaming, reconnects and periodic REST recovery polling.
- [x] Build an order blotter with nested-leg data, filters, safe replacement and cancellation.
- [x] Persist reconciled daily portfolio/risk snapshots with data-quality flags.

Exit gate: the local ledger reconciles to Alpaca balances and activities across partial fills, cancellations, dividends, fees and cash transfers.

### Phase 2 — Market workstation

Goal: make company discovery and monitoring genuinely useful.

- [x] Company detail workspace with asset eligibility, snapshot, quote/spread quality, volume context and timestamped news.
- [x] Configurable 1M/3M/1Y daily candlestick and volume periods.
- [x] Company chart benchmark overlay and relative-strength comparison with SPY, QQQ and DIA.
- [x] Watchlist CRUD backed by Alpaca watchlists, with validation, audit events and account-level persistence.
- [x] Live IEX stock quote/bar stream through a bounded server SSE bridge with reconnect and stale-data indicators.
- [x] Alpaca SIP movers and most-active discovery panels with source and freshness labels.
- [x] Portfolio/watchlist news feeds with source links, timestamps and explicit relevance scopes.
- [x] NASDAQ market clock dashboard with phase and next open/close timestamps.
- [x] Trading calendar, early closes and session-aware market-order review messaging.
- [x] Corporate-action calendar and holdings impact alerts with bounded dividend/split estimates and review warnings for complex events.
- [x] Company logos proxied from Alpaca when entitled, with a deterministic symbol placeholder otherwise, plus tradable, fractional, shortable and marginable eligibility badges.

Exit gate: every displayed market value identifies its source feed and timestamp, and stale/limited entitlements are visible.

### Phase 3 — Full paper order workstation

Goal: reach the practical order-management depth expected from a modern broker while preserving the risk boundary.

- [x] Limit, stop and stop-limit tickets.
- [x] Trailing-stop tickets with deterministic preview and the shared risk boundary.
- [x] Buy bracket/OTO and sell OCO linked-order workflows with leg validation, one signed preview and nested lifecycle reconciliation.
- [x] Fractional quantity and dollar-notional market tickets with runtime asset eligibility checks.
- [x] DAY/GTC, eligible extended-hours choices, and whole-share OPG/CLS auction tickets.
- [x] Working-order replace/cancel and snapshot-bound cancel-all emergency control.
- [x] Pre-trade IEX spread, current-volume participation and estimated spread-cost warnings.
- [x] Multi-order rebalance basket with atomic application-level risk preview, reservation and exact approval; Alpaca legs submit sequentially with partial-failure disclosure because the broker exposes no atomic basket endpoint.
- [x] Explicit paper short-selling gate with account margin enablement, marginable/easy-to-borrow asset checks, DAY market/limit-only tickets, 5% short concentration, fresh revalidation and a separate approval warning.

Exit gate: race, partial-fill, gap, nested-order, stale-price and reconnect scenarios pass an expanded safety corpus.

### Phase 4 — Research and AI edge

Goal: provide better decision preparation, not magical predictions.

- [x] SEC EDGAR ingestion for filings, company facts and XBRL fundamentals.
- [x] Retrieve bounded 10-K and 10-Q Risk Factors and MD&A sections with accession, locator, source URL, truncation and content-hash evidence.
- [x] Build comparable annual and quarterly financial trends with exact accession, form, period and filing-URL provenance for every metric.
- [x] Centralize SEC request caching, transient retries, declared user-agent identity and fair-access throttling below 10 requests per second.
- [x] Add portfolio/watchlist alerts for material 8-K filings with concise, filing-grounded relevance summaries, bounded item evidence and official accession links.
- [x] Keep the current SEC integration on official JSON and filing archive APIs; bounded section parsing does not require a Python worker.
- [x] Expand SEC EDGAR evidence with bounded filing sections, accession-linked historical financial trends and filing-grounded 8-K alerts.
- [x] Add official macro context from FRED, Treasury Fiscal Data, BLS, and BEA for rates, inflation, labor, GDP, fiscal data, and market-regime context.
- [x] Add GDELT as a secondary broad news/event source alongside Alpaca/Benzinga, with clear "media signal, not verified fact" labeling.
- [x] Add optional Finnhub integration for company news/profile/fundamental enrichment, gated behind an API key and free-tier limits.
- [x] Add OpenFIGI identity mapping to reduce ticker/security ambiguity before joining data across providers.
- [x] Define a canonical evidence format and conservative dedupe policy before adding more providers.
- [x] Complete the cited company research workspace with comparable-company and valuation tables.
- [x] Deterministic news clustering, event timelines and explicit portfolio/watchlist relevance scopes.
- [x] Sourced earnings-news, dividend and corporate-action monitoring briefs without inferred events.
- [x] Natural-language portfolio Q&A backed only by typed tools.
- [x] Bull/base/bear valuation and scenario memos.
- [x] Counter-thesis/risk-agent review before actionable suggestions.
- [x] Trade journal with thesis drift and post-trade review.
- [x] Evaluation suite for citations, numerical accuracy, tool use and abstention, with persisted production metrics.

Canonical evidence contract:

- Every record carries provider and provider source IDs, category, authority level, claim status, title, original and canonical URL, as-of/retrieval/publication timestamps, entity IDs, deterministic content hash and JSON-compatible payload.
- Official records, licensed-provider records, regulated-broker observations, licensed/public media signals and derived analysis remain visibly distinct; media signals are not promoted to verified facts.
- Deduplication merges only exact provider/source IDs, matching canonical URL plus content hash, or exact content hashes for the same entity and category. Different sections from one document remain distinct; similar headlines or fuzzy text alone never merge.

Official macro context contract:

- Treasury Debt to the Penny and public BLS CPI/unemployment data remain usable without credentials; FRED rates/yield-curve and BEA real-GDP coverage are optional, key-gated and visibly incomplete when not configured.
- Every observation retains provider, series/table identity, exact period, official source URL, retrieval time and canonical evidence hash. CPI year-over-year is a disclosed deterministic calculation from the latest and year-ago official BLS index values.

Optional Finnhub enrichment contract:

- Missing or malformed `FINNHUB_API_KEY` configuration performs no network requests and returns explicit per-endpoint coverage; credentials travel only in `X-Finnhub-Token` headers and never enter source URLs or normalized output.
- Free-tier use is limited to Company Profile 2, company news and the last four earnings surprises. Requests serialize below 60 calls per minute, retry transient failures once, cache profile/earnings/news independently and preserve successful endpoints when another is unavailable or rate limited.
- Profile identity must match the requested ticker. Ambiguous market-capitalization units, phone numbers and malformed records are omitted; earnings values are retained exactly without recalculation. Profile and earnings are licensed `provider_record` evidence, company news is article-level `media_signal` evidence, and official SEC records take precedence.

OpenFIGI identity contract:

- Use OpenFIGI API v3 and one bounded `TICKER + US + Equity` mapping job. Anonymous access works without credentials and serializes below 25 requests per minute; an optional `OPENFIGI_API_KEY` is sent only through `X-OPENFIGI-APIKEY`.
- Normalize only exact-ticker, US-equity, non-derivative results with valid 12-character FIGIs. Collapse venue rows by composite FIGI, then use the Alpaca company name to confirm multiple candidates.
- A unique match may bind canonical FIGI to market evidence. Ambiguous, no-match, rate-limited and unavailable outcomes never select a FIGI and keep cross-provider joins visibly symbol-scoped.

Comparable valuation contract:

- The user selects one to four peer tickers; the app does not infer an industry peer set from Alpaca asset metadata because that metadata has no sector/factor classification.
- Current Alpaca IEX price, directly reported annual SEC revenue/net income/diluted EPS, latest SEC stockholders' equity and latest SEC shares outstanding remain separate canonical inputs. Derived market capitalization, annual P/S, diluted P/E, P/B, revenue growth and net margin cite those inputs and disclose formulas.
- Fiscal periods are visible per cell. Missing facts, non-positive valuation denominators, mismatched annual periods and unavailable providers produce unavailable cells or partial rows; no fourth quarter, trailing period, peer median or market-cap input is synthesized.
- Provider calls use bounded timeout/retry and six-hour success caching. One provider failure cannot erase successful observations from the others, and deterministic regime labels remain descriptive context rather than forecasts or trading signals.

Portfolio Q&A contract:

- Questions are bounded to 3-500 characters and run through a dedicated read-only agent with typed portfolio, deterministic risk, price, daily-bar, licensed-news, asset/market-status and open-order tools. It has no simulation, preview, order, cancellation or credential tool.
- Every answer is a bounded list of claims, and every claim must cite evidence IDs returned during that exact run. Invented IDs, unsafe certainty language and malformed output trip the output guardrail.
- Tool results are the only permitted data source. Missing coverage is returned as an explicit limitation; question text and news are treated as untrusted data and cannot expand tool or execution authority.

Scenario valuation contract:

- Bear, base and bull cases use a fixed 12-month horizon and user-entered revenue-growth, net-margin and P/E assumptions ordered from low to high. The application does not infer assumptions, probabilities or company guidance.
- Mechanical implied prices use directly reported annual SEC revenue, latest SEC shares outstanding and the current Alpaca IEX price. Each memo cites those inputs plus separate derived scenario evidence and exposes every formula.
- Missing or non-positive revenue/shares and non-positive projected earnings stay unavailable. Outputs explicitly warn about dilution/share-class limits and remain scenarios rather than forecasts or recommendations.

Counter-thesis review contract:

- Every Guided Rebalance proposal is challenged by a second agent with an independent set of typed read-only tools. It must inspect current portfolio and deterministic risk evidence; approving a trade also requires current symbol-specific price, bars, news or asset-status evidence.
- Review output preserves the exact proposed symbol/action, cites only evidence retrieved during the review run, and states a counter-thesis plus failure condition. Invalid or ungrounded review output fails the entire plan closed.
- Buy/reduce ideas marked caution or block are downgraded to watch with zero quantity and no simulation authority. Only approved ideas expose a draft, and the stored plan can bind only an exact quantity, side and symbol on a simple DAY market ticket before fresh preview/submission checks.

Trade-journal contract:

- Journal entries can be created only from a persisted standard stock-order receipt. Symbol, side, quantity, order ID and the signed preview reference price are copied from that receipt; reviewed agent-plan thesis and invalidation text are suggestions that remain editable before creation.
- Thesis status is explicitly classified by the human reviewer as intact, drifting, invalidated or closed. A review captures a fresh Alpaca price, current position context when available, linked receipt status and price movement from the preview reference without inferring thesis validity from price alone.
- Original thesis text is immutable, closed entries are terminal, prior reviews remain visible, and entry creation plus every review append to the hash-chained decision audit log. The UI states that preview reference price is not execution fill evidence and flags incomplete order or position context.

GDELT media-signal contract:

- Company Research uses one exact company-name DOC 2.0 ArticleList query over a three-day window, bounded to 10 newest results. It does not fan out portfolio-wide queries against the rate-limited interactive API.
- Only headlines identifying the company phrase, a distinctive company token or ticker are retained; broad full-text matches with unestablished headline relevance are counted and omitted. Every retained article is separate canonical `public_web` / `media_signal` evidence with URL, domain, language, source country and publication time. Similar or repeated headlines do not verify an event and are not fuzzy-deduplicated.
- Requests are serialized at no more than one every five seconds, success-cached for 15 minutes, failure-cached for two minutes and retried once. HTTP 429 or provider failure leaves Alpaca/Benzinga evidence intact and explicitly warns that no absence of events may be inferred.
- Same-source content changes are retained as explicit revisions with both hashes; higher-authority evidence wins exact cross-provider duplicates, then the most recently retrieved record.

Exit gate: agents consistently cite retrieved evidence, abstain when data is missing and cannot create execution authority.

### Phase 5 — Advanced risk and portfolio construction

Goal: progress from descriptive risk to decision-grade portfolio construction.

- [x] Historical and parametric 95% daily VaR plus historical expected shortfall.
- [x] Factor, sector, industry and asset-class exposure.
- [x] Correlation matrix calculations and covariance-based portfolio risk contribution.
- [x] Liquidity risk using live IEX spread, average daily volume and estimated days at 10% ADV.
- [x] Scenario library: rate shock, tech crash, volatility spike and custom shocks.
- [x] SPY benchmark attribution, alpha, beta, tracking error and information ratio.
- [x] Rebalancing with taxes/fees/turnover constraints where data permits.
- [x] Mean-variance and risk-parity proposals with robust constraints.
- [ ] Policy editor for position, sector, drawdown and turnover limits.

Portfolio-exposure contract:

- Asset-class exposure uses Alpaca's position `asset_class` plus account cash. Gross and signed net exposure are measured against current account equity.
- Sector and industry exposure uses each issuer's official SEC submissions SIC code: the broad SIC division is the sector and the SEC SIC description is the industry. These labels are explicitly not presented as GICS or ICB classifications.
- Market beta is calculated against SPY from date-aligned daily returns with at least 20 observations. Momentum is the close-to-close return over 63 sessions. Volatility is the sample deviation of the latest 20 daily returns annualized with 252 sessions.
- Factor contributions use signed position market value divided by account equity. Coverage uses gross invested market value, excludes cash, and reports unavailable history rather than imputing a value. Missing SIC classifications remain visibly unclassified.

Portfolio-scenario contract:

- The rate scenario applies an explicit illustrative return shock for every broad SEC SIC division under a parallel 200-basis-point rate increase. The technology scenario applies -25% to SIC ranges 3570-3579, 3660-3679, 4810-4899 and 7370-7379, and -8% to other classified US equities.
- The volatility scenario applies a one-day three-sigma downside from each position's annualized 20-session realized volatility, capped at -35%. Missing volatility or classification leaves that position uncovered and contributing zero, with gross invested coverage reported.
- Scenario P&L uses signed current market value, so shorts respond in the opposite direction; cash remains unchanged. The output retains every position shock, rationale, estimated P&L, assumptions, resulting equity and explicit linear-model limitations.
- Custom scenarios accept 1-20 unique held symbols with shocks bounded from -100% to +100%. Unknown or duplicate symbols fail validation instead of creating synthetic exposure.

Constrained rebalance contract:

- `POST /api/portfolio/rebalance-plan` is read-only. It accepts 1-10 unique US-equity target weights whose listed weights total no more than 100%, leaves omitted positions unchanged and treats zero-weight targets as reduce-to-zero requests. It returns projected position weights, planned legs, cash impact, turnover, fee, FIFO gain/loss and tax estimates, warnings and methodology; it never submits broker orders.
- Target deltas are scaled by the remaining turnover budget using the stricter user-entered cap and persisted operations-policy cap after current rolling 24-hour filled-order turnover. Buy sizing uses current cash after the requested cash buffer and estimated fees, and never assumes sell proceeds are available before execution.
- Tax estimates use imported Alpaca FILL activities and dated FIFO open lots. The app follows IRS holding-period framing that assets held more than one year may be long-term and otherwise short-term, based on [IRS Topic 409](https://www.irs.gov/taxtopics/tc409) and [IRS Publication 550](https://www.irs.gov/publications/p550); Alpaca account activities provide transaction time, quantity, price and side evidence from [Alpaca Account Activities](https://docs.alpaca.markets/reference/getaccountactivities-1). User-entered tax rates apply only to positive lot gains.
- Explicit max-tax caps use binary-search scaling over FIFO lot consumption because gains are non-linear across lots. If imported activity history is truncated, unmatched, affected by unresolved corporate actions, or lacks enough lots for a planned sale, a max-tax request is reported as unverifiable and no basket draft is produced.
- Fractionable symbols round down to six decimals and whole-share-only symbols round down to whole shares. Legs below the requested minimum notional are omitted. A basket draft is produced only when all constraints are verifiable and there are 2-10 executable legs; the existing signed basket preview still performs fresh quote, asset, liquidity, risk and operations-policy checks before any paper order can be submitted.

Portfolio-optimizer contract:

- `GET /api/portfolio/optimizer` is read-only and uses current long US-equity holdings only. It does not infer new symbols, does not short, does not use leverage and never creates orders. Non-US-equity, non-positive and insufficient-history positions are omitted with explicit warnings.
- The optimizer returns two target-weight proposals: risk parity from inverse-volatility scores and a mean-variance tilt from shrunk expected return divided by shrunk variance. Daily returns are aligned over the shared available window; expected returns are shrunk halfway to the cross-sectional mean and off-diagonal covariance is shrunk toward zero before scoring.
- Robust constraints are user-visible: maximum target weight, maximum absolute turnover, cash reserve and minimum observation count. Weight caps are applied before turnover scaling; if the turnover budget prevents full de-risking from an over-cap current holding, the binding constraint remains visible.
- Outputs include expected annual return, annualized volatility, position-level current/target/delta weights, risk contribution, coverage and warnings. Target drafts can be loaded only into the constrained rebalance planner; basket preview and signed broker submission remain separate downstream checks.

Exit gate: calculations have fixtures, clear assumptions, confidence limits and independent reconciliation.

### Phase 6 — Options research and paper trading

Goal: add options without importing hidden leverage into the equity risk model.

- [x] Bounded option-chain, expiration and strike browser backed by Alpaca contract metadata and snapshots.
- [x] Bid/ask, spread, volume, open-interest and implied-volatility filters where available.
- [x] Alpaca Greeks with an independently tested Black-Scholes comparison and long-option expiry payoff diagrams.
- [x] Signed, fresh-validated paper tickets for long single legs and defined-risk net-debit verticals; naked option selling remains unavailable.
- [x] Signed portfolio Greeks plus delta-gamma underlying shocks, IV shocks and one-day theta estimates.
- [x] Assignment-notional, exercise-cost, expiry and options-buying-power previews plus exact-position exercise/do-not-exercise workflows.
- [x] Options activity ledger categorization plus max-loss, exercise-cost, assignment-notional and broker-order decision receipts.

Exit gate: max loss, assignment exposure and expiration behavior are known before every order.

### Phase 7 — Multi-asset and crypto data foundation

Goal: make crypto data trustworthy enough for strategy research before enabling automated paper orders.

- [x] Read-only index and FX benchmark monitor with explicit entitlement-unavailable states for this paper account.
- [ ] Fixed-income research if account and data access support it.
- [x] Read-only BTC/USD, ETH/USD and SOL/USD 24/7 quote, spread, daily-range and liquidity-risk workspace.
- [x] Add historical crypto bar retrieval for BTC/USD, ETH/USD and SOL/USD with timeframe, provider, gap and timezone metadata.
- [x] Add explicit latest crypto snapshot ingestion for quotes, trades, bars and optional order-book snapshots, bounded by symbol and retention limits.
- [x] Persist normalized crypto market-data snapshots used by strategy decisions; store source feed, venue/location, timestamp, stale flag and ingestion latency.
- [x] Add initial approved-paper crypto risk gates for budget, max position, max order, min order, max spread, stale-data blocking, approval expiry and kill switch.
- [x] Complete crypto-specific risk policy for 24/7 session handling, cash/buying-power verification, max daily loss, max drawdown, max daily turnover and cool-down after errors.
- [x] Add configurable fee and slippage assumptions to historical backtests with close-price execution and explicit result metadata.
- [x] Add spread, latency, partial-fill, missed-fill and order-book replay assumptions for paper-run analysis.
- [ ] Keep crypto transfers, perpetual leverage and tokenization disabled until separately approved.

Exit gate: crypto data can be replayed and traced from source snapshot to feature to decision with known gaps and freshness.

### Phase 8 — Crypto strategy lab and paper experiments

Goal: implement small, explainable crypto strategies that can be backtested, shadowed, paper-run and compared over time.

- [x] Create a strategy plugin interface with deterministic `prepare`, `features`, `decide`, `riskAdjust`, `orders` and `attribution` steps.
- [x] Add initial strategy catalog and config UI for buy-and-hold, cash, time-sliced accumulation, moving-average trend, breakout momentum, volatility filter and mean reversion.
- [x] Add breakout momentum implementation using persisted bar highs and volume confirmation.
- [x] Add volatility filter implementation using realized close-to-close return volatility.
- [x] Add BTC/ETH relative strength and order-book liquidity scout implementations once the needed basket and order-book replay inputs are persisted.
- [x] Build historical backtester with walk-forward splits, benchmark comparison, parameter freezing and friction-adjusted metrics.
- [x] Add explicit shadow-run creation and tick evaluation that stores data snapshots, strategy decisions, decision receipts and trace lookups without submitting orders.
- [x] Add initial Strategy Lab UI for one-symbol crypto backtests, shadow-run creation, manual ticks, run history and decision drilldowns.
- [x] Build shadow-run scheduler that evaluates live signals without placing orders and stores missed/blocked/intended actions.
- [x] Add explicit run-level approval for paper strategy automation: symbol universe, budget, max position, max order, min order, max spread, schedule, strategy version, expiry and pause/kill controls.
- [x] Add first bounded paper-only crypto market-order runner using notional buys, fractional quantity sells, GTC/IOC time-in-force, stale-data gates and approval expiry.
- [x] Add standalone paper crypto order preview UI plus broader Alpaca-supported crypto order types beyond the first market-order runner.
- [x] Link every submitted strategy paper order to a decision receipt, idempotency key, broker order status and trace order outcome.
- [x] Add post-fill attribution windows and fill-quality analysis for every strategy paper order.
- [x] Add first Strategy Lab dashboard metrics from persisted evidence: exposure, stale-data rate, block reasons, order outcomes, submitted/fill ratio and estimated fill quality.
- [x] Add active-run P&L versus baselines and drawdown once post-fill attribution and fill reconciliation exist.
- [x] Add experiment review workflow: promote, continue, pause, retire or revise, with notes explaining what changed and why.

Exit gate: at least three strategies can run in scheduled shadow mode and one can run paper-only with complete decision traces, bounded risk and baseline comparison.

### Phase 9 — Decision observability and experiment governance

Goal: make strategy behavior explainable, debuggable and auditable before any broader automation.

- [x] Add first-class `strategy_runs`, `strategy_decisions`, `strategy_data_snapshots`, `strategy_orders`, `strategy_metrics` and `strategy_notes` storage.
- [x] Add OpenTelemetry-compatible spans around market-data ingestion, feature calculation, risk policy, strategy decision, paper-order submission and reconciliation.
- [x] Add persistent metric instruments for data freshness, tick latency, decision counts, blocked decisions, stale-data rate, paper fill ratio, spread/slippage estimates, drawdown and strategy errors.
- [x] Add strategy decision trace API that reconstructs features, thresholds, risk checks and persisted market-data snapshots by `trace_id`.
- [x] Add initial decision trace explorer showing run decisions, features, thresholds, risk checks, data snapshots, stale flags and raw trace JSON.
- [x] Add trace filters by run, symbol, strategy version, decision, block reason and order outcome, with linked order drilldowns when present.
- [x] Add exportable experiment report with config, assumptions, data coverage, metrics, linked orders, notable decisions and reason-coded failures.
- [x] Add basic audit events and notes for run approvals, pauses, kill-switch activations and review decisions.
- [x] Add immutable audit trail for config changes, strategy code version changes and production-grade retention.
- [x] Add alerting for stale feeds, strategy exceptions, rejected orders, drawdown breaches, runaway turnover, repeated slippage warnings and reconciliation drift.

Exit gate: every paper strategy action can be reconstructed without external memory from stored data, traces, metrics and receipts.

### Phase 10 — Production and possible live trading

- [x] Real user authentication, authorization and encrypted secret management.
- [x] Database migrations, backups, observability export and incident response.
- [x] Broker order reconciliation polling, authenticated stream recovery, stale-state metadata and daily portfolio snapshot reconciliation.
- [x] Immutable audit trail and exportable decision receipts across manual, agent and strategy workflows.
- [x] Global kill switch, exposure caps and operational runbooks.
- [x] Data licensing and subscription review for market data, news, crypto and derived analytics.
- [x] Closed-beta paper safety targets, exit criteria and evidence checklist.
- [x] Measured closed-beta evidence report and Operations UI from local receipts, audits, events and strategy reviews.
- [x] Live-trading hard blocker requiring a separately reviewed deployment mode.
- [ ] Legal/compliance review for advice, execution, crypto-specific disclosures and automated strategy controls.
- [ ] Run closed beta with paper accounts and attach measured safety evidence.
- [ ] Live trading deployment review after paper strategy governance proves reliable.

Capability boundary verified on 24 June 2026: this paper account exposes equity, option and crypto data/trading capabilities. Index and FX endpoints are present but not entitled and are shown as unavailable; Alpaca asset metadata does not provide sector/factor classifications; fixed-income research, crypto transfers, perpetual leverage, tokenization and live trading remain gated rather than silently enabled. Crypto strategy execution is paper-only, requires explicit run-level approval and remains blocked from live trading, transfers, leverage and tokenization. Production-governance evidence now makes the legal/compliance review, paper closed-beta proof and live-deployment review separate gates instead of implicit code-complete status.

## Prioritized next build queue

1. [x] Add corporate-action holdings-impact alerts and portfolio/watchlist news feeds.
2. [x] Define the canonical strategy run, decision trace and data snapshot schema before building strategy UI.
3. [x] Add company benchmark overlays and relative-strength comparison.
4. [x] Add live quote/bar streaming with reconnect and stale-data recovery.
5. [x] Add limit/stop/trailing, linked bracket/OCO/OTO, auction and rebalance-basket paper workflows with expanded risk previews.
6. [x] Add crypto historical bars and explicit latest-snapshot ingestion with persisted snapshots and freshness metadata.
7. [x] Build deterministic backtest and walk-forward harness with buy-and-hold and cash baselines.
8. [x] Implement the first three low-complexity strategies: time-sliced accumulation, moving-average trend and mean reversion.
9. [x] Add explicit shadow-run creation/tick evaluation, decision receipts and trace API before enabling paper-order automation.
10. [x] Add initial Strategy Lab UI for backtests, shadow runs, manual ticks and trace explorer.
11. [x] Add recurring shadow-run scheduler, trace filters and order-outcome drilldowns.
12. [x] Add run-level paper strategy approval, risk caps, pause/kill controls and one bounded crypto paper-order runner.
13. [x] Add exportable strategy experiment report with config, assumptions, linked orders, metrics and reason-coded failures.
14. [x] Add Strategy Lab dashboard metrics for exposure, stale-data rate, block reasons, order outcomes, fill ratio and fill quality.
15. [x] Add post-fill attribution windows and fill-quality analysis for every strategy paper order.
16. [x] Add active-run P&L/drawdown versus baselines.
17. [x] Add experiment review workflow with continue, pause, retire, revise and promote decisions.
18. [x] Add deterministic strategy plugin lifecycle for prepare, features, decide, risk, orders and attribution.
19. [x] Add breakout momentum strategy with prior-high and volume-confirmation evidence.
20. [x] Add volatility filter strategy with realized-return volatility evidence.
21. [x] Add local OpenTelemetry-compatible strategy spans and persisted strategy metric instruments.
22. [x] Add deterministic Strategy Lab alerts for stale feeds, exceptions, rejected orders, drawdown, turnover, slippage and reconciliation drift.
23. [x] Add crypto-specific paper strategy risk policy for 24/7 sessions, cash/buying-power evidence, daily loss, drawdown, turnover and error cool-down gates.
24. [x] Add spread, latency, partial-fill, missed-fill and order-book replay assumptions for paper-run analysis.
25. [x] Add BTC/ETH relative strength and order-book liquidity scout strategy implementations.
26. [x] Add hash-chained Strategy Lab audit trail for config/status/code-version changes with retention metadata and report export.
27. [x] Add persisted global operations policy with kill switch, exposure caps, turnover caps, runbook evidence and enforcement across equity, basket, option, crypto and approved strategy paper orders.
28. [x] Add hash-chained decision audit trail for manual order receipts, strategy decision receipts and agent plans, with receipt-level and global verification endpoints.
29. [x] Add schema migration metadata, serialized SQLite backup export, bounded observability export and incident response packet endpoints.
30. [x] Add role-aware OIDC proxy authorization and encrypted AES-GCM secret vault endpoints with metadata-only reads.
31. [x] Add data licensing/subscription governance registry for Alpaca IEX/SIP, crypto data, Benzinga news and derived analytics with evidence URLs and live-promotion blockers.
32. [x] Add production-governance report with compliance review packet, paper closed-beta targets and live-trading hard gate.
33. [x] Add measured closed-beta evidence export and Operations UI with pass, fail and needs-evidence status for every safety target.
34. Run a paper closed beta until the measured evidence report is ready for exit review.
35. Complete external legal/compliance review for advice, execution, crypto disclosures and automated strategy controls.
36. Complete merger, spin-off and unit-split basis allocation when authoritative broker detail is available.
37. [x] Add bounded filing-section evidence and a shared fair-access SEC client through the official SEC APIs.
38. [x] Add accession-linked annual and quarterly financial trend tables.
39. [x] Add portfolio/watchlist alerts for material 8-K filings with filing-grounded relevance summaries.
40. Add free-source expansion roadmap: SEC EDGAR, official macro data, GDELT, optional Finnhub, and OpenFIGI. The canonical evidence/dedupe prerequisite is complete.
41. Add comparable-company valuation and counter-thesis review.
42. [x] Add factor exposure, expected shortfall and portfolio risk contribution.
43. [x] Build and validate the options research workspace before enabling defined-risk paper options execution.

## Capability and safety checklist for every new feature

- Is the endpoint available to this account and subscription?
- Is the asset tradable, fractionable, shortable or options-enabled as required?
- What is the timestamp, feed and stale-data behavior?
- Are pagination, rate limits, reconnects and retry idempotency handled?
- Can partial fills, replacements, corporate actions or cashflows invalidate the calculation?
- Is every financial number deterministic and covered by fixtures?
- Does the user see assumptions, maximum loss and failure behavior?
- Can an agent read the data without receiving credentials or unnecessary account identifiers?
- Can agent output remain advisory and pass through the same preview/approval boundary?
- Does the feature work safely when Alpaca, market data or OpenAI is unavailable?
- If this is a strategy feature, can the decision be replayed from stored snapshots without calling live APIs?
- Are strategy parameters, feature versions, risk policy versions and code versions persisted?
- Does the experiment compare against explicit baselines and out-of-sample periods?
- Are spread, fee, slippage, latency, missed-fill and liquidity assumptions visible and configurable?
- Can the strategy be stopped immediately, and does it fail closed on stale data, broker rejection or reconciliation drift?
- Do traces and metrics avoid raw credentials, account identifiers and unnecessary personal data?

## Sources and implementation reference

- [Alpaca developer overview](https://docs.alpaca.markets/docs)
- [Trading API overview](https://docs.alpaca.markets/v1.4.2/docs/trading-api)
- [Orders at Alpaca](https://docs.alpaca.markets/us/docs/orders-at-alpaca)
- [Account activities](https://docs.alpaca.markets/docs/account-activities)
- [Historical market data](https://docs.alpaca.markets/v1.3/docs/historical-api)
- [Paper trading](https://docs.alpaca.markets/us/docs/paper-trading)
- [Options trading](https://docs.alpaca.markets/docs/options-trading)
- [Real-time options data](https://docs.alpaca.markets/us/docs/real-time-option-data)
- [Real-time crypto data](https://docs.alpaca.markets/docs/real-time-crypto-pricing-data)
- [Crypto orders](https://docs.alpaca.markets/docs/crypto-orders)
- [SEC EDGAR application programming interfaces](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- [SEC developer resources and fair-access guidance](https://www.sec.gov/about/developer-resources)
- [SEC accessing EDGAR data](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data)
- [SEC Form 8-K and official item definitions](https://www.sec.gov/files/form8-k.pdf)
- [FRED API series observations](https://fred.stlouisfed.org/docs/api/fred/series_observations.html)
- [FRED API terms of use](https://fred.stlouisfed.org/docs/api/terms_of_use.html)
- [GDELT DOC 2.0 API documentation](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/)
- [GDELT API rate-limiting guidance](https://blog.gdeltproject.org/ukraine-api-rate-limiting-web-ngrams-3-0/)
- [Finnhub API documentation](https://finnhub.io/docs/api)
- [Finnhub plans and free-tier limits](https://finnhub.io/pricing)
- [Finnhub startup and enterprise licensing](https://finnhub.io/pricing-startups-and-enterprise)
- [OpenFIGI API v3 documentation and rate limits](https://www.openfigi.com/api/documentation)
- [OpenFIGI terms and public-domain dedication](https://www.openfigi.com/docs/terms-of-service)
- [U.S. Treasury Fiscal Data: Debt to the Penny](https://fiscaldata.treasury.gov/datasets/debt-to-the-penny/)
- [BLS Public Data API](https://www.bls.gov/developers/)
- [BEA API user guide](https://apps.bea.gov/api/_pdf/bea_web_service_api_user_guide.pdf)
- [SEC Regulation Best Interest small entity compliance guide](https://www.sec.gov/resources-small-businesses/small-business-compliance-guides/regulation-best-interest)
- [SEC investor alert on automated investment tools](https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-alerts/investor-56)
- [SEC crypto assets investor spotlight](https://www.investor.gov/additional-resources/spotlight/crypto-assets)
- [FINRA algorithmic trading topic](https://www.finra.org/rules-guidance/key-topics/algorithmic-trading)
- [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/concepts/semantic-conventions/)
- [OpenTelemetry traces](https://opentelemetry.io/docs/concepts/signals/traces/)
- [OpenTelemetry metrics](https://opentelemetry.io/docs/concepts/signals/metrics/)
- Installed SDK capability map: `node_modules/@alpacahq/alpaca-ts-alpha/src/capabilities.ts`

The installed SDK map is a discoverability aid, not a product guarantee. Re-check official Alpaca documentation, account capabilities, data entitlements and runtime responses before implementing or exposing each feature.
