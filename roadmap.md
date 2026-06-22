# AI Broker product roadmap

Last reviewed: 2026-06-21

This document is the build map for turning AI Broker into a serious personal investing and paper-trading workstation. Alpaca supplies brokerage state, execution, and market data. Deterministic application code owns calculations and safety policy. OpenAI agents may research, explain, compare, and draft actions, but they do not bypass the order preview and approval boundary.

## Product principles

1. Paper trading remains the default and only enabled execution mode until live-trading, legal, operational, and security gates are deliberately completed.
2. Risk and accounting calculations are deterministic and testable. An LLM explains results; it does not invent them.
3. Every recommendation identifies its data timestamp, sources, assumptions, risks, and invalidation conditions.
4. Every order has a fresh quote, portfolio-impact preview, explicit approval, idempotency key, broker status reconciliation, and decision receipt.
5. Data entitlements, asset availability, account eligibility, and jurisdiction are runtime capabilities—not assumptions.
6. Market data, news, filings, and web content are untrusted inputs to agents.

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
| Crypto bars, trades, quotes, order books and snapshots | 24/7 crypto terminal, liquidity/depth views and risk analytics | Add only after asset-class-specific policy |
| Crypto real-time stream | Live crypto quotes, trades, books and alerts | Subscription/venue aware |
| Crypto wallets, transfers and whitelisted addresses | Funding and custody workflows | High-risk; out of scope for personal broker MVP |
| Crypto perpetual futures data, leverage and funding APIs | Perpetuals dashboard and risk | Beta/high leverage; do not enable execution initially |
| Index values | Benchmark charts, relative performance and regime signals | Useful read-only feature |
| FX rates | Currency conversion and global exposure normalization | Useful read-only feature |
| Fixed-income quotes/prices and Treasury/corporate reference | Bond research and multi-asset allocation | Confirm account/data eligibility before promising trading |
| Tokenization endpoints | Tokenized-asset experiments | Experimental; not a core roadmap item |

Alpaca exposes real-time crypto trades, quotes, books and bars through its [crypto data stream](https://docs.alpaca.markets/docs/real-time-crypto-pricing-data). Beta and funding APIs require a separate security and operational review.

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

Only `draft_order` may produce an order-ticket draft. Actual submission remains a separate deterministic server workflow with explicit user approval.

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
- Personalized education that explains metrics without presenting certainty.

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
- [ ] Retrieve bounded 10-K and 10-Q sections such as Risk Factors and MD&A so research cites filing content, not only filing metadata.
- [ ] Build comparable annual and quarterly financial trends with exact accession, form, period and filing-URL provenance for every metric.
- [ ] Centralize SEC request caching, retries, declared user-agent identity and fair-access rate limiting.
- [ ] Add watchlist alerts for material 8-K filings with concise, filing-grounded relevance summaries.
- [ ] Continue with the official SEC JSON and filing APIs first; evaluate `edgartools` only when robust section parsing, standardized statements, Form 4 or 13F support justifies an isolated Python worker.
- [ ] Complete the cited company research workspace with comparable-company and valuation tables. Single-company cited analysis exists.
- [x] Deterministic news clustering, event timelines and explicit portfolio/watchlist relevance scopes.
- [x] Sourced earnings-news, dividend and corporate-action monitoring briefs without inferred events.
- [ ] Natural-language portfolio Q&A backed only by typed tools.
- [ ] Bull/base/bear valuation and scenario memos.
- [ ] Counter-thesis/risk-agent review before actionable suggestions.
- [ ] Trade journal with thesis drift and post-trade review.
- [x] Evaluation suite for citations, numerical accuracy, tool use and abstention, with persisted production metrics.

Exit gate: agents consistently cite retrieved evidence, abstain when data is missing and cannot create execution authority.

### Phase 5 — Advanced risk and portfolio construction

Goal: progress from descriptive risk to decision-grade portfolio construction.

- [x] Historical and parametric 95% daily VaR plus historical expected shortfall.
- [ ] Factor, sector, industry and asset-class exposure.
- [x] Correlation matrix calculations and covariance-based portfolio risk contribution.
- [x] Liquidity risk using live IEX spread, average daily volume and estimated days at 10% ADV.
- [ ] Scenario library: rate shock, tech crash, volatility spike and custom shocks.
- [x] SPY benchmark attribution, alpha, beta, tracking error and information ratio.
- [ ] Rebalancing with taxes/fees/turnover constraints where data permits.
- [ ] Mean-variance and risk-parity proposals with robust constraints.
- [ ] Policy editor for position, sector, drawdown and turnover limits.

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

### Phase 7 — Multi-asset expansion

- [x] Read-only index and FX benchmark monitor with explicit entitlement-unavailable states for this paper account.
- [ ] Fixed-income research if account and data access support it.
- [x] Read-only BTC/USD, ETH/USD and SOL/USD 24/7 quote, spread, daily-range and liquidity-risk workspace.
- [ ] Crypto paper trading only after venue, custody, fee and liquidity review.
- [ ] Keep crypto transfers, perpetual leverage and tokenization disabled until separately approved.

### Phase 8 — Production and possible live trading

- [ ] Real user authentication, authorization and encrypted secret management.
- [ ] Database migrations, backups, observability and incident response.
- [x] Broker order reconciliation polling, authenticated stream recovery, stale-state metadata and daily portfolio snapshot reconciliation.
- [ ] Immutable audit trail and exportable decision receipts.
- [ ] Kill switch, exposure caps and operational runbooks.
- [ ] Data licensing and subscription review.
- [ ] Legal/compliance review for advice, execution and disclosures.
- [ ] Closed beta with paper accounts and measurable safety targets.
- [ ] Live trading only as a separately reviewed deployment mode.

Capability boundary verified on 22 June 2026: this paper account exposes equity, option and crypto data/trading capabilities. Index and FX endpoints are present but not entitled and are shown as unavailable; Alpaca asset metadata does not provide sector/factor classifications; fixed-income research, crypto execution, transfers, perpetual leverage, tokenization and live trading remain gated rather than silently enabled.

## Prioritized next build queue

1. [x] Add corporate-action holdings-impact alerts and portfolio/watchlist news feeds.
2. Complete merger, spin-off and unit-split basis allocation when authoritative broker detail is available.
3. [x] Add company benchmark overlays and relative-strength comparison.
4. [x] Add live quote/bar streaming with reconnect and stale-data recovery.
5. [x] Add limit/stop/trailing, linked bracket/OCO/OTO, auction and rebalance-basket paper workflows with expanded risk previews.
6. Add filing-section evidence and accession-linked historical financial trends through the official SEC APIs.
7. Add comparable-company valuation and counter-thesis review.
8. Add factor exposure, expected shortfall and portfolio risk contribution.
9. [x] Build and validate the options research workspace before enabling defined-risk paper options execution.

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

## Sources and implementation reference

- [Alpaca developer overview](https://docs.alpaca.markets/docs)
- [Trading API overview](https://docs.alpaca.markets/v1.4.2/docs/trading-api)
- [Orders at Alpaca](https://docs.alpaca.markets/us/docs/orders-at-alpaca)
- [Account activities](https://docs.alpaca.markets/docs/account-activities)
- [Historical market data](https://docs.alpaca.markets/v1.3/docs/historical-api)
- [Options trading](https://docs.alpaca.markets/docs/options-trading)
- [Real-time options data](https://docs.alpaca.markets/us/docs/real-time-option-data)
- [Real-time crypto data](https://docs.alpaca.markets/docs/real-time-crypto-pricing-data)
- Installed SDK capability map: `node_modules/@alpacahq/alpaca-ts-alpha/src/capabilities.ts`

The installed SDK map is a discoverability aid, not a product guarantee. Re-check official Alpaca documentation, account capabilities, data entitlements and runtime responses before implementing or exposing each feature.
