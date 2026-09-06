# Implemented features

Last reviewed against `main` commit `5d7eb32`: 2026-07-13.

This file describes behavior implemented in the repository. Planned work belongs
in [`roadmap.md`](roadmap.md); reproducible evidence belongs in
[`VALIDATION.md`](VALIDATION.md). Repository and provider ownership are in
[`docs/architecture/README.md`](architecture/README.md) and the Alpaca API,
SDK, CLI, and MCP boundaries are in
[`docs/architecture/alpaca.md`](architecture/alpaca.md).

## Product scope

AI Broker is a single-user, paper-only investing and strategy-research
workstation. Deterministic code owns calculations, validation, and execution
policy. OpenAI agents retrieve typed evidence, explain it, and draft actions;
they cannot submit, cancel, or replace orders.

The browser exposes seven workspaces:

| Workspace | Implemented behavior |
| --- | --- |
| Home | Paper account, holdings, operations policy, kill switch, closed-beta review, and order entry. |
| Markets | Session, watchlists, movers, most-active stocks, monitored news/events, 8-K alerts, and multi-asset capability status. |
| Portfolio | Risk, performance, FIFO ledger, exposure, scenarios, optimizer proposals, constrained rebalance plans, trade journal, receipts, and order management. |
| Strategies | Crypto backtests, shadow/scheduled runs, protocol-gated paper approvals, manual tickets, traces, metrics, alerts, performance, attribution, reviews, and reports. |
| Research | Company market data, SEC, macro, OpenFIGI, GDELT, optional Finnhub, comparables, scenario valuation, and AI company research. |
| Options | Bounded chains, liquidity filters, Greeks, payoff/risk preview, long single-leg and net-debit vertical paper tickets, and position actions. |
| AI Advisor | Evidence-bound portfolio Q&A and reviewed rebalance ideas with exact simulation authority. |

The shared browser shell uses a dark operator-workstation system with a
labeled desktop rail, compact tablet rail, active-item-centered mobile
navigation, and a sticky status strip for locally evidenced data health, the
Alpaca paper environment, paper-only execution, and private-value masking. The
Overview shows equity, buying power, cash, and account status without inventing
unsupported performance claims. Its paper-beta review leads with missing
inputs, consequence, next action, status, metrics, and packet export; a native
disclosure contains target details, supporting records, the newest recorded
beta window, four drills, incidents, warnings, append-only forms, and incident
resolution. Research activation, company refresh, and AI analysis share one
loader: successful providers are cached independently, failures can be retried,
explicit refresh reloads all panels, and superseded responses cannot replace
the selected company. Chart period and benchmark changes do not invalidate
other pending research panels. Recurring account and market polling pauses
when its owner or the page is hidden. Loading, toast, and
error announcements use live regions, and confirmation dialogs manage focus,
Escape, restoration, and danger treatment. The maintained Playwright suite
checks these interactions against isolated fixtures.

## Capability map

### Broker and market state

- Alpaca paper account balances, cash, buying power, positions, open orders,
  activities, health, readiness, watchlists, asset search, market clock,
  calendar, IEX quotes/bars, company views, monitoring alerts, and entitled
  multi-asset snapshots.
- Watchlist CRUD, asset discovery, session-aware order guidance, early-close
  information, and an IEX quote/bar SSE bridge are implemented. Read-only
  crypto quotes cover BTC/USD, ETH/USD, and SOL/USD. Index and FX states are
  explicit unavailable results when the account lacks entitlement.
- Fixed-income research returns an explicit unavailable capability because this
  personal Trading API account is not a fixed-income-enabled Broker API
  partner.
- Broker and provider responses preserve source/feed, applicable observation
  or publication time, effective period, retrieval time, and server response
  time separately. Current account and position endpoints expose no event time,
  so their observation remains null. Cached retrieval is never relabeled as a
  market observation.

### Orders and receipts

- Equity and basket paper orders require an explicitly identified IEX trade observed within 60 seconds, checked again at confirmation. Missing, future-dated, or older prices block execution even outside the core market session. This intentionally limits off-hours paper ordering.

- Equity market, limit, stop, stop-limit, trailing-stop, OPG/CLS auction,
  extended-hours, fractional, dollar-notional, bracket/OTO, and OCO tickets.
- Multi-leg equity rebalance baskets use application-level atomic preview and
  reservation before sequential broker submission. Explicit paper shorts check
  margin, marginability, easy-to-borrow, DAY, quantity, concentration, and
  fresh state.
- Long buy-to-open options and defined-risk net-debit verticals are available;
  naked option selling is unavailable. Paper crypto supports market, limit, and
  stop-limit tickets, while approved strategy automation submits only bounded
  paper crypto market orders.
- Eligible working orders support safe replacement, exact cancellation, and a
  snapshot-bound cancel-all preview. REST and stream receipt times are retained;
  an older recovery snapshot cannot overwrite newer streamed order evidence.
- Interactive order workflows pass an HMAC-signed two-minute preview, exact
  confirmation, fresh broker/market revalidation, idempotency, local risk
  reservation, reconciliation, and a decision receipt. Approved strategy
  automation uses its separate pre-registered protocol and server-owned
  readiness controls before bounded paper crypto orders. Conflicts return the
  stable `{error, code, retryable, nextAction}` HTTP 409 shape. Browser recovery
  polls only an already-started idempotent request and requires a new preview
  after state drift.

### Portfolio intelligence

- Cashflow-adjusted performance, benchmark attribution, drawdown, volatility,
  Sharpe-style metrics, and persisted daily snapshots.
- FIFO accounting covers fills, fees, dividends, interest, transfers, splits,
  symbol changes, and broker corporate-action basis allocations. Unsupported
  basis changes, unmatched sells, bounded-history truncation, and missing legacy
  provenance remain unresolved rather than guessed.
- Historical and parametric 95% daily VaR, expected shortfall, covariance risk
  contribution, correlation, liquidity, SPY diagnostics, diversification,
  asset-class/SIC/factor exposure, deterministic scenarios, risk-parity and
  shrunk mean-variance proposals, and constrained rebalance planning are
  implemented.
- The portfolio surfaces show expected, received, omitted, freshness, missing,
  rejected, and conclusion-impact evidence. Stale, future, malformed,
  conflicting, unobserved, unsupported, or insufficient-history inputs fail
  closed. Current-account, provider-bar, benchmark, SEC-classification,
  activity, policy, and calculation times remain distinguishable.
- Rebalance planning applies turnover, cash-buffer, fee, FIFO-lot, tax-rate,
  maximum-tax, precision, and minimum-notional constraints. Prices older than
  seven days, more than five minutes in the future, missing an observation, or
  malformed cannot become a draft.

### Research and AI

- SEC EDGAR provides declared-identity requests, caching, retry/backoff,
  serialized fair-access requests, filing sections, company facts, trends, SIC,
  and material 8-K alerts. An optional non-future `YYYY-MM-DD` `asOf` cutoff
  excludes later filings, amendments, sections, facts, and trends while
  reporting exclusion counts. Historical SIC remains unavailable because the
  submissions payload exposes no classification history.
- Official Treasury and BLS macro data plus optional FRED and BEA data expose
  required/optional provider coverage, indicators, five regime dimensions,
  publication/effective periods, and retrieval evidence. Partial and failed
  providers remain consequential; FRED vintages remain revisions rather than
  invented consecutive observations.
- Licensed Alpaca/Benzinga articles, bounded GDELT signals, optional Finnhub,
  and OpenFIGI v3 identity mapping expose explicit partial or unavailable
  states. Media publication, earnings periods, identity retrieval, and
  provider observation remain distinct.
- Canonical evidence records provider/source identity, claim status, semantic
  times, entity identifiers, canonical URL, content hash, and JSON-compatible
  payload. Exact IDs, URL/content, or same-entity exact-content rules deduplicate
  evidence; similar headlines do not become verified facts.
- Comparable valuation v3 uses directly reported SEC metrics and either the
  latest returned Alpaca IEX price or a bounded historical daily close. It
  persists point-in-time reports for one subject and one to four peers, stores a
  SHA-256 replay manifest, and replays without provider requests. Scenario v3
  derives ordered bear/base/bull assumptions only from a verified historical
  parent; scenarios are not forecasts.
- Company research and portfolio Q&A use typed read-only tools, bounded output,
  evidence-ID validation, numeric grounding, unsafe-certainty rejection, and
  independent counter-thesis review. Saved plans retain only cited,
  allow-listed proposal and review evidence with phase ordering and hashes.
  Generated company reports persist output, evidence, identity, metrics, and a
  replay manifest; altered or legacy artifacts fail closed and replay performs
  zero provider/model requests.
- Every visible report exposes calculation-level expected/received/omitted
  coverage, semantic time, missing inputs, and conclusion impact before its
  conclusions. Retrieval-only data remains retrieval-only.

### Strategy Lab

- Twelve deterministic crypto strategies support immutable backtests, actor-
  scoped long-history datasets, rolling/anchored train-only walk-forward
  evaluation, untouched holdouts, regime slices, trade metrics, bootstrap
  uncertainty, compatible cohort comparison, shadow/scheduled runs, traces,
  alerts, attribution, friction calibration, reports, and promotion evidence.
- Volatility-targeted trend uses one-bar-lagged realized volatility and a hard
  non-levered exposure cap. Donchian ATR breakout uses completed-bar channel and
  ATR inputs, non-loosening stops, and gap-through detection. Regime-filtered
  mean reversion uses lagged trend, volatility, and dollar-volume evidence with
  close-based stop, regime, and holding exits.
- Backtest and shadow lineage records Git commit, dirty state, plugin/feature/
  policy versions, query window, provider/feed, and dataset hashes. New shadow
  runs link to one matching clean reviewed backtest; dirty or legacy evidence is
  non-comparable.
- `strategy-paper-readiness-v1` is server-owned and consumed by listings,
  lifecycle, runtime, and browser controls. Paper protocols are currently
  allowed only for `cash`, `buy-and-hold`, `moving-average-trend`,
  `volatility-filter`, and `btc-eth-relative-strength`. Cash is a no-entry
  comparator.
- Volatility-targeted trend, Donchian ATR breakout, and regime-filtered mean
  reversion require prospective shadow evidence before a separately reviewed
  experiment. Time-sliced accumulation, legacy mean reversion, breakout
  momentum, and the order-book scout fail closed because their prospective state
  or depth inputs are not equivalent to backtests. Backtest evidence alone never
  clears the paper-evidence gate.
- The browser renders strategy-specific inputs and presets, bounded aligned
  equity/drawdown charts, full-sample and out-of-sample uncertainty, decision
  counts, and explicit promotion blockers. Uncertainty is never converted into
  a ranking.

### Operations and UI

- Runtime start/stop is idempotent. Shutdown clears owned intervals, disconnects
  Alpaca streams, removes their stock subscriptions, and closes market SSE
  subscribers. `SIGINT` and `SIGTERM` also stop the HTTP listener. Work already
  in flight is not cancelled; SQLite stays open for the process lifetime so
  those jobs can settle. A narrow SDK compatibility guard contains its known
  connecting-socket race; other errors propagate normally. Jobs are not durable
  across restarts.

- Ordered transactional SQLite migrations, serialized backups, encrypted
  secret envelopes, hash-chained decision records, provider/dataset quality
  reporting, scheduled read-only reconciliation, and selective retention
  pruning are implemented. The current schema has 15 migrations and 23
  application tables including migration history; the governance registry maps
  16 sources to 12 stored-output categories.
- Reconciliation coalesces overlapping runs, compares account/position values,
  bulk and per-order reads, and bounded IEX latest versus historical minute-bar
  paths. It stores discrepancies and recovery outcomes without submitting,
  replacing, or cancelling orders. It proves endpoint reconciliation, not a
  second market-data provider or external entitlement approval.
- Closed-beta review stores append-only supporting records, drills, windows,
  incidents, and resolutions with exact audit hashes. Only passing evidence in
  the newest recorded 30-day, one-to-five-participant window counts;
  `ready_for_external_review` is the strongest local state and never external
  approval.
- `scripts/alpaca.sh` launches the installed Alpaca CLI through Bun's dotenv
  parser. Its bounded read-only surface is `doctor`, `account get`, `position
  list`, and default-open `order list`, with limited help/version output that
  does not require credentials. It strips inherited Alpaca profile/live/debug
  controls, forces paper mode, and rejects broker mutations, raw API access,
  profile commands, and unknown flags before invoking the CLI. The installed
  CLI version checked for this repository is 0.0.11; the separate
  `smoke:order` script remains opt-in for its explicit paper mutation drill.
- The browser uses a dark workstation system with labeled desktop navigation,
  compact tablet navigation, active-item-centered mobile navigation, private
  value masking, live announcements, keyboard/focus-safe confirmations,
  option-chain coverage warnings, and shared evidence panels.

## Safety and authorization

- `paper: true` is hard-coded wherever the Alpaca client is constructed. There
  is no live client or runtime switch. `LIVE_TRADING_ENABLED` and
  `LIVE_TRADING_REVIEW_ID` affect only governance reporting.
- The global kill switch blocks every order surface. Ordinary sells cannot
  exceed holdings; equity shorts require explicit opt-in and stay within the
  configured boundary. Default policy caps a ticket at the lesser of $2,500 or
  2.5% of equity, position concentration at 20%, and rolling 24-hour turnover
  at 10% of equity; persisted policy may be stricter.
- Working broker orders and local reservations consume capacity. Missing
  price/account data, stale strategy data, unsupported capability, invalid
  evidence, expired approval, malformed model output, and reconciliation
  uncertainty fail closed.
- Production authorization trusts only verified proxy identity and roles:
  `viewer`, `researcher`, `trader`, `operator`, and `admin`. Mutation bodies are
  bounded JSON objects, origins are checked, malformed path encoding fails
  before feature routing, broker DTOs are allow-listed, output is escaped, and
  sensitive routes are rate limited.
- The encrypted vault exposes metadata only and is not the runtime provider-key
  source. Governance and closed-beta reports are internal evidence and do not
  grant legal approval, data entitlement, or live-trading authority.

## Data-quality contract

Every displayed or derived market value identifies source/feed and freshness.
Official records, broker observations, licensed-provider records, media signals,
and derived analysis remain distinct. Missing values remain missing; financial
periods, units, accessions, and formulas stay attached to derived valuation
output. SEC SIC is labeled SEC SIC, never GICS or ICB. Stored provider output is
internal-only by policy, and derived output inherits every upstream restriction.
Paper fills and backtests are experimental evidence and do not model all live
fees, queue position, price improvement, latency, market impact, or venue
behavior.

## Current limitations

- Direct provider backtests and the Strategy Lab UI remain bounded to 90 days;
  longer stored-dataset backtests require API ingestion and are not exposed as
  a browser workflow.
- No credentialed strategy paper order was submitted during the 2026-07-13
  review; the mutating broker smoke remains explicit and opt-in.
- Time-sliced accumulation, legacy mean reversion, legacy breakout momentum,
  and the order-book scout retain the prospective/backtest mismatches above.
  The first three need run-relative or reconstructed state; the scout needs
  historical depth/replay or a fail-closed shadow-only classification.
- Volatility-targeted trend uses per-bar, non-annualized volatility. A target
  calibrated for `1Day` is not interchangeable with `1Hour` or `15Min`.
  Comparison requires identical timeframes, while parameter selection remains
  the operator's responsibility.
- Walk-forward selection uses a fixed train-return objective; alternative
  objectives and protection against post-period human selection remain open.
- Stored datasets are reproducible but one provider is not independent
  corroboration; a content hash does not prove completeness, point-in-time
  correctness, or absence of upstream revisions.
- Provider health is local event evidence. Providers without recent matching
  observations are `unobserved`, and no report proves entitlement, terms
  approval, or live API availability.
- Time-bearing response contracts use the explicit observation/publication/
  effective/retrieval/server-response taxonomy. Compatibility aliases such as
  `asOf`, `timestamp`, and `quoteAt` do not override those meanings.
- The backend remains a modular monolith. `backend/persistence/store.ts` and
  some route modules remain large; split them only where ownership or a test
  boundary is clear.
- Strict TypeScript covers backend, tests, scripts, and Playwright configuration.
  The 95% function and 96% line gate covers deterministic modules only;
  orchestration, providers/models, process startup, and browser behavior are
  validated separately.
- Option chains cap the rendered list at 120 contracts and show displayed
  versus available counts, quote/IV/Greek coverage, and partial-data warnings.
- Operational scripts are type-checked, while credentialed provider and
  paper-order smoke behavior runs only when deliberately invoked.
- SQLite, caches, streams, rate limiting, and schedulers are single-process;
  scheduler work is not durable across restarts.
- Ordered migrations, rollback/upgrade fixtures, serialized backup restore,
  and activity provenance are tested. No production-sized restore or closed-
  beta operations drill has been completed.
- Closed-beta references are operator-supplied. The application validates
  shape, time scope, audit linkage, and measured evidence but does not fetch or
  authenticate external artifacts. No real participant cohort or required
  operations drill has been completed.
- The governance registry is an internal decision record, not legal approval.
  Alpaca, Finnhub, GDELT, Treasury, FRED, BEA, SEC, BLS, OpenFIGI, and OpenAI
  terms require external entitlement review.
- Automatic retention is selective. Orders, decisions, audits, backtests,
  datasets, notes, receipts, plans, activities, snapshots, and non-research
  operations events remain outside automatic deletion unless policy changes.
- Production hosting, real users, external compliance review, a measured paper
  beta, and live deployment review remain incomplete.

These limitations are prioritized in [`roadmap.md`](roadmap.md); no UI panel or
report endpoint should be inferred to complete an external gate.
