# Strategy Lab guide

Strategy Lab is the crypto strategy research and observability workspace in AI Broker. It lets you backtest deterministic strategies, create shadow runs, manually or periodically evaluate live signals, and inspect why a strategy made a decision.

The current Strategy Lab starts in research and shadow mode. A run can submit Alpaca paper crypto market orders only after explicit run-level approval with budget, position, order-size, spread, loss, drawdown, turnover, error-cooldown, expiry and time-in-force caps. Standalone manual paper crypto tickets also support Alpaca crypto market, limit and stop-limit orders with signed preview and fresh-state confirmation.

## Start the app

```sh
bun install
cp .env.example .env
# add Alpaca paper credentials to .env
bun start
```

Open `http://localhost:3000/#strategies`.

If you are running on another port:

```sh
PORT=3017 bun --env-file=.env src/server.ts
```

Open `http://localhost:3017/#strategies`.

## Main workflow

1. Open the `Strategies` tab.
2. Choose a crypto symbol, strategy, timeframe, lookback window, and JSON parameters.
3. Click `Run backtest` to evaluate the strategy on historical Alpaca crypto bars.
4. Review return, buy-and-hold baseline, max drawdown, exposure time, turnover, and the equity curve.
5. Click `Create shadow run` to save a run configuration.
6. Select the run in `Shadow run observability`.
7. Click `Tick selected run` to evaluate the strategy against current market data, or set a schedule interval before creating the run and use `Run scheduler` to process due runs.
8. Filter recent decisions by symbol, decision, block reason or order outcome when a run has several traces.
9. Inspect the decision trace: features, thresholds, risk checks, order outcome, data provenance, and trace JSON.
10. If a run has earned paper observation, use `Approve paper run` with conservative caps.
11. Use `Standalone paper crypto order` for a manual paper crypto ticket when you want to test market, limit or stop-limit handling outside strategy automation.
12. Use `Save review` to continue, pause, retire, revise or promote the experiment with a note explaining why.
13. Use `Export report` to download a JSON experiment report after decisions accumulate.
14. Review shadow and paper strategy decisions in Portfolio -> `Decision receipts`.

## Crypto experiment controls

### Crypto symbol

Use Alpaca crypto symbols such as:

- `BTC/USD`
- `ETH/USD`
- `SOL/USD`

Most strategies create one-symbol runs. `BTC/ETH relative strength` accepts `BTC/USD,ETH/USD` or `ETH/USD,BTC/USD`; the first symbol is the traded primary and the other is the comparison peer.

### Strategy

The strategy selector chooses the deterministic strategy implementation used for backtests and shadow ticks. Current strategies run through the same plugin lifecycle: `prepare`, `features`, `decide`, `riskAdjust`, `orders` and `attribution`.

| Strategy | What it does | Typical use |
| --- | --- | --- |
| `Moving average trend` | Enters exposure when the fast moving average is above the slow moving average. Holds cash when trend confirmation is unavailable or bearish. | Tests simple trend-following behavior and whipsaw risk. |
| `Breakout momentum` | Enters exposure when price closes above a prior high and volume confirms against its recent average. Uses a stop-loss threshold to exit failed breakouts. | Tests momentum continuation, false breakouts and volume confirmation. |
| `Volatility filter` | Enters exposure only when realized close-to-close volatility is inside the configured risk band. | Tests drawdown avoidance versus missed upside during noisy regimes. |
| `BTC/ETH relative strength` | Compares the primary BTC or ETH return against the other asset over a lookback window. Enters exposure only when the primary is stronger by the configured edge. | Tests simple cross-crypto momentum without pretending the app can rotate a multi-leg live book yet. |
| `Order-book liquidity scout` | Enters exposure only when the latest decision snapshot has tight spread and enough visible bid/ask notional depth. | Tests liquidity gating from persisted order-book evidence before broader order types. |
| `Mean reversion` | Enters exposure when price is far below its rolling mean by z-score, then exits near the mean. | Tests oversold bounce behavior and regime failure. |
| `Time-sliced accumulation` | Gradually increases exposure over a configured number of slices. | Tests scheduled accumulation and timing sensitivity. |
| `Buy and hold` | Targets full exposure from the start. | Baseline for passive crypto exposure. |
| `Cash baseline` | Stays in cash. | Baseline for no-risk/no-trade comparison. |

### Timeframe

The timeframe controls the Alpaca historical bars used by the backtest and shadow tick.

- `1 hour bars`: useful for short research cycles and intraday behavior.
- `1 day bars`: useful for slower, lower-turnover strategy checks.
- `15 minute bars`: useful for more reactive tests, but turnover and noise can rise quickly.

### Lookback days

Lookback days controls how much historical data to request.

- Short windows are faster but fragile.
- Longer windows usually show more market regimes.
- Very short windows can make averages and z-scores unavailable until enough bars exist.

### Strategy parameters JSON

Parameters must be a JSON object. Invalid JSON is rejected before the request is sent.

Moving average trend example:

```json
{"fast":5,"slow":20,"exposure":1}
```

Mean reversion example:

```json
{"lookback":20,"entryZScore":-2,"exitZScore":-0.25,"exposure":1}
```

Breakout momentum example:

```json
{"lookback":20,"volumeLookback":20,"volumeMultiple":1.25,"stopLossPercent":8,"exposure":1}
```

Volatility filter example:

```json
{"lookback":20,"minVolatilityPercent":0,"maxVolatilityPercent":6,"exposure":1}
```

BTC/ETH relative strength example:

```json
{"lookback":20,"minRelativeStrengthPercent":0,"exposure":1}
```

Order-book liquidity scout example:

```json
{"maxSpreadBps":100,"minVisibleAskNotional":500,"minVisibleBidNotional":500,"maxDepthLevels":25,"exposure":1}
```

Time-sliced accumulation example:

```json
{"slices":10,"maxExposure":1}
```

Buy-and-hold and cash do not need parameters:

```json
{}
```

Parameter meanings:

| Parameter | Strategies | Meaning |
| --- | --- | --- |
| `fast` | Moving average trend | Number of bars in the fast average. |
| `slow` | Moving average trend | Number of bars in the slow average. Must be greater than `fast`; the server enforces this defensively. |
| `lookback` | Mean reversion, breakout momentum, volatility filter, BTC/ETH relative strength | Number of bars used for rolling mean/z-score, prior-high breakout confirmation, realized volatility or primary-vs-peer return comparison. |
| `volumeLookback` | Breakout momentum | Number of prior bars used to calculate average volume. |
| `volumeMultiple` | Breakout momentum | Current volume must be at least this multiple of recent average volume. |
| `stopLossPercent` | Breakout momentum | Percentage drop from breakout entry that exits the position. |
| `minVolatilityPercent` | Volatility filter | Lower realized-volatility boundary for keeping exposure. |
| `maxVolatilityPercent` | Volatility filter | Upper realized-volatility boundary for keeping exposure. |
| `minRelativeStrengthPercent` | BTC/ETH relative strength | Minimum percentage-point return edge the primary symbol needs over its BTC/ETH peer. |
| `maxSpreadBps` | Order-book liquidity scout | Maximum decision-time order-book spread. |
| `minVisibleAskNotional` | Order-book liquidity scout | Minimum visible ask-side notional needed before entering exposure. |
| `minVisibleBidNotional` | Order-book liquidity scout | Minimum visible bid-side notional needed before entering exposure. |
| `maxDepthLevels` | Order-book liquidity scout | Maximum visible book levels per side included in the scout calculation. |
| `entryZScore` | Mean reversion | Z-score threshold where the strategy enters exposure. Negative values mean price is below the rolling mean. |
| `exitZScore` | Mean reversion | Z-score threshold where the strategy exits exposure. |
| `slices` | Time-sliced accumulation | Number of bars used to ramp from zero to max exposure. |
| `exposure` | Trend, mean reversion | Target exposure when the signal is active. `1` means 100%. |
| `maxExposure` | Time-sliced accumulation | Maximum exposure after accumulation completes. |

### Schedule interval

The schedule interval field accepts minutes from `1` to `1440`.

- `0` disables recurring evaluation.
- A scheduled run remains shadow-only unless the selected run is explicitly approved for paper automation.
- Scheduled ticks use the same decision receipt and trace format as manual ticks.
- The in-process scheduler can be disabled with `STRATEGY_SCHEDULER_DISABLED=1`.

## Backtest results

Click `Run backtest` to replay the selected strategy against historical crypto bars.

The metrics mean:

| Metric | Meaning |
| --- | --- |
| Strategy return | Final strategy equity compared with initial cash. |
| Buy-and-hold baseline | Return from holding the selected crypto asset over the same period. |
| Max drawdown | Largest peak-to-trough decline in the backtest equity curve. |
| Time exposed | Share of bars where target exposure was above 1%. |
| Turnover | Total notional traded divided by initial cash. High turnover may indicate churn, fee sensitivity, or overfitting. |
| Equity curve | Strategy equity over time after modeled slippage and fees. |

Backtest assumptions currently include:

- Initial cash: `$10,000`.
- Execution at bar close.
- Default fee: `0 bps`.
- Default slippage: `5 bps`.
- No partial-fill model yet.
- No live order-book fill simulation yet.

Treat the backtest as a learning tool, not proof that the strategy will work live.

## Shadow runs

Click `Create shadow run` to persist the strategy configuration. A shadow run stores:

- Strategy ID and version.
- Config hash.
- Policy version.
- Symbols.
- Timeframe and lookback.
- Parameters.
- Notes.
- Creation/update timestamps.

Shadow runs do not trade. They are a durable experiment record that can be ticked repeatedly. A selected run can later be promoted to paper mode through the explicit approval form.

## Paper approval

The `Paper automation approval` form applies only to the selected run.

Approval fields:

- `Paper strategy budget`: total notional budget for this strategy run.
- `Maximum position notional`: largest strategy-tracked notional exposure.
- `Maximum order notional`: largest single paper market order.
- `Minimum order notional`: smallest order worth submitting.
- `Maximum spread bps`: quote spread gate. Wider spreads block the decision.
- `Maximum daily loss percent`: blocks new buy/increase orders after active-run equity loses more than this percentage of approved budget over the latest 24-hour performance window.
- `Maximum drawdown percent`: blocks new buy/increase orders when active-run drawdown exceeds this threshold.
- `Maximum daily turnover percent`: blocks additional paper orders when rolling 24-hour strategy order notional plus the draft order would exceed this percentage of budget.
- `Error cooldown minutes`: blocks new paper orders after recent broker rejection/error evidence.
- `Approval expiry hours`: automatic expiration for the approval.
- `Crypto time in force`: `GTC` or `IOC`.

After approval, manual ticks and scheduled ticks can submit bounded Alpaca paper crypto market orders. The runner treats crypto as a 24/7 session, requires fresh cash and buying-power evidence before a paper order can be submitted, and stores policy evidence in the decision trace. It currently uses notional buys and fractional-quantity sells. It stores the client order id, broker order id, order status, trace id and decision receipt.

Use `Pause run` to stop scheduled evaluation without deleting the run. Use `Kill run` to retire the run and set a kill-switch flag in the saved config.

## Standalone paper crypto order

The standalone crypto ticket is manual and paper-only. It is separate from approved strategy automation.

Supported symbols:

- `BTC/USD`
- `ETH/USD`
- `SOL/USD`

Supported order types and time-in-force:

- `Market`: buy by dollars or buy/sell by quantity.
- `Limit`: buy/sell by quantity.
- `Stop limit`: buy/sell by quantity.
- `GTC` and `IOC`.

Preview checks include:

- Fresh Alpaca crypto snapshot with non-stale quote/trade/bar evidence.
- Market-order spread availability and a default 200 bps guardrail.
- `$2,500` maximum standalone crypto order notional.
- Cash check for buys.
- Existing crypto-position quantity check for sells; standalone crypto shorting is unavailable.
- HMAC-signed preview token that expires after two minutes.

Submission revalidates account cash, positions and market data. If the crypto reference price has moved by more than 1% from the preview, the order is rejected and must be reviewed again.

## Experiment review

The `Experiment review` form applies to the selected run and records the human decision after comparing evidence, attribution and active-run performance.

Review actions:

- `Continue`: keeps a paper run in paper mode, or returns other runs to shadow mode for more evidence.
- `Pause`: moves the run to paused status.
- `Retire`: moves the run to retired status and sets the paper kill-switch flag in saved config.
- `Revise`: moves the run back to shadow status and stores optional revision notes.
- `Promote`: marks the experiment complete. This is an experiment record only; live trading is still unavailable.

Every review requires a note. The app stores the latest review in run config, appends it to `reviewHistory`, writes a strategy note, appends a hash-chained audit entry and includes review history in exported experiment reports.

## Audit trail

The selected run loads a hash-chained strategy audit trail.

The audit trail records:

- Run creation, including strategy id, strategy version, policy version and config hash.
- Config changes from approval, scheduler advancement, kill-switch activation and review decisions.
- Status changes such as pause, paper approval, retirement and review outcomes.
- Retention metadata. Entries default to seven-year retention.
- `previousHash` and `entryHash`, so exported reports can verify the chain without trusting external memory.

The app exposes the same evidence through `GET /api/strategy/runs/RUN_ID/audit` and includes the trail plus verification result in exported experiment reports.

Decision receipts and agent plans also append to a separate global decision audit chain. Use `GET /api/receipts/RECEIPT_ID/audit` for one receipt, or `GET /api/decision-audit` for global chain verification across manual orders, Strategy Lab receipts and agent plans.

## Global operations guardrails

The home workspace includes an Operations guardrails panel backed by `GET /api/operations/policy` and `POST /api/operations/kill-switch`.

The persisted policy is rechecked during preview and confirmation for equity, basket, option and standalone crypto paper orders, and before approved Strategy Lab paper ticks submit broker orders. It enforces:

- App-wide kill switch with required reason, actor and timestamp.
- Maximum order notional.
- Maximum per-symbol exposure.
- Maximum portfolio exposure percent.
- Maximum rolling turnover percent.
- Runbook evidence for blocked submissions.

De-risking sell orders that reduce existing exposure can pass the notional/exposure/turnover caps, but the global kill switch still blocks every new order submission until cleared.

## Operational readiness exports

Production-readiness evidence is available through authenticated operations endpoints:

- `GET /api/operations/readiness`: migration metadata, backup hash/size, observability counts and incident summary.
- `POST /api/operations/backup`: serialized SQLite database backup with a SHA-256 response header.
- `GET /api/operations/observability-export`: local OpenTelemetry-shaped spans, strategy metrics, recent events, operations policy and decision-audit verification.
- `GET /api/operations/incident-packet`: incident runbook plus recent error, stale-data, rejection, kill-switch and blocked-flow evidence.
- `GET/POST/DELETE /api/operations/secrets`: AES-GCM encrypted secret vault metadata and updates; plaintext values are never returned.
- `GET /api/operations/data-governance`: source registry for Alpaca market data, crypto data, Benzinga news and local derived analytics, including subscription status and live-promotion blockers.
- `GET /api/operations/production-governance`: compliance review packet, paper closed-beta safety targets, exit criteria and live-trading hard gate. This is review evidence, not legal signoff.
- `GET /api/operations/closed-beta-evidence`: measured `pass`, `fail` or `needs_evidence` status for each paper-beta safety target using the local decision audit, receipts, strategy decisions, review history, operations events and backup metadata.

Production readiness requires the managed auth proxy headers, role-aware authorization and `SECRET_VAULT_KEY`. Operations backup and secret-vault writes require the `admin` role; readiness, observability and incident exports require `operator` or `admin`.

## Experiment reports

Click `Export report` for the selected run to download a JSON report.

The report includes:

- Run config, config hash, policy version and approval assumptions.
- Data coverage: decisions, snapshots, stale snapshot count, sources and feeds.
- Metrics: decision counts, order outcomes, block reasons, submitted orders and fill ratio when available.
- Linked strategy paper orders with side, notional, quantity, time in force and reference price.
- Post-fill attribution windows and fill-quality evidence when paper orders have broker fills.
- Paper-run execution replay with spread, latency, partial-fill, missed-fill and visible order-book assumptions.
- Hash-chained audit trail with retention metadata and verification status.
- Experiment review history with action, actor, timestamp, note and optional revision summary.
- Notable decisions, especially blocks and order-linked decisions.
- Human notes recorded during approvals, pauses, kill-switch actions and experiment reviews.

## Run dashboard metrics

Selecting a run loads a dashboard summary from persisted evidence.

The dashboard shows:

- Decision count and blocked-decision rate.
- Stale-data rate from the snapshots attached to recorded traces.
- Current strategy-tracked paper exposure and budget utilization.
- Submitted paper orders, filled paper orders and fill ratio.
- Average fill slippage when a stored paper order has both reference price and fill price.
- Top block reasons.

These metrics are descriptive and evidence-bound. They do not replace the active-run performance view.

## Persistent observability metrics

Strategy ticks and explicit crypto snapshot ingestion now write rows to `strategy_metrics`.

Current metric instruments include:

- `strategy_tick_latency_ms`
- `strategy_data_latency_ms`
- `strategy_data_freshness_age_ms`
- `strategy_decision_count`
- `strategy_blocked_decision_count`
- `strategy_snapshot_count`
- `strategy_stale_snapshot_count`
- `strategy_stale_data_rate`
- `strategy_spread_bps`
- `strategy_paper_order_submitted_count`
- `strategy_paper_order_count`
- `strategy_paper_order_fill_ratio`
- `strategy_slippage_estimate_bps`
- `strategy_active_return_percent`
- `strategy_active_drawdown_percent`
- `strategy_active_pnl_usd`
- `strategy_error_count`

The server also records local `otel.span` events shaped for later OpenTelemetry export. Spans currently cover market-data fetch/ingestion, feature calculation, risk policy, decision recording, paper-order submission, order reconciliation, scheduler errors and the overall strategy tick.

## Strategy alerts

The selected run also loads deterministic alerts from persisted run evidence.

Alert categories include:

- Stale feeds from stale snapshots or `stale_data` blocks.
- Strategy exceptions from persisted `strategy_error_count` metrics.
- Rejected paper orders and broker-order rejection blocks.
- Active-run drawdown breaches.
- Runaway 24-hour paper-order turnover relative to approved budget.
- Repeated fill slippage above the configured threshold.
- Reconciliation drift when local order status is stale or disagrees with the last broker payload.

Default thresholds can be overridden under `config.alerts` on a run. Supported fields are `staleDataRate`, `drawdownPercent`, `dailyTurnoverPercent`, `slippageBps`, `repeatedSlippageCount` and `reconciliationAgeMs`.

## Active-run performance

Selecting a run loads active-run performance when the run has filled strategy paper orders and crypto bars after the first fill.

The performance view:

- Reconciles stored strategy order rows against Alpaca order state when possible.
- Builds a strategy-tracked cash, units and equity curve from filled paper orders.
- Shows current strategy P&L, return and max drawdown from that reconstructed curve.
- Compares active return against cash, buy-and-hold and equal-weight baselines.
- Adds the same evidence to exported experiment reports.

If a run has no filled paper orders, no positive budget or no market bars after the first fill, the view reports insufficient data instead of estimating performance.

## Post-fill attribution

Selecting a run also loads post-fill attribution for linked strategy paper orders.

The attribution view:

- Reconciles stored strategy order rows against Alpaca order state when possible.
- Shows fill-quality evidence from reference price, filled average price and side-aware slippage.
- Replays the decision-time visible order book under explicit spread, latency, partial-fill and missed-fill assumptions.
- Tracks 1 hour, 1 day and 7 day side-adjusted market moves after the fill.
- Labels windows as pending, missing data or not filled instead of counting them as performance.
- Adds attribution evidence to exported experiment reports.

For buys, a positive side-adjusted return means the market moved up after the fill. For sells, a positive side-adjusted return means the market moved down after the sell, which is treated as avoided exposure rather than realized profit.

### Order-book replay assumptions

The replay analysis is evidence-bound. It uses the order book saved on the strategy decision snapshot and does not call live market data.

Default assumptions:

- Market orders cross visible opposite-side book depth until requested quantity is filled or depth is exhausted.
- Default assumed submit latency is 250 ms.
- Default maximum replay latency is 5 seconds, including decision-to-submit latency, stored data latency and assumed submit latency.
- The replay spread cap uses the run paper approval `maxSpreadBps` when present, otherwise 200 bps.
- Up to 25 visible levels per side are used by default.
- `full_fill` means visible depth covered the requested quantity.
- `partial_fill` means some visible depth existed but not enough for the requested quantity.
- `missed_fill` means latency exceeded the assumption, spread exceeded the assumption, or no usable opposite-side depth was visible.
- `missing_order_book` means the decision trace did not have an order-book payload, so the app refuses to infer depth.

## Shadow run observability

The `Shadow run observability` panel lists persisted runs.

Each run shows:

- Strategy name.
- Symbol.
- Timeframe.
- Lookback days.
- Run status.
- Latest review action when present.
- Policy version.
- Created timestamp.

Click a run to select it.

### Tick selected run

Click `Tick selected run` to evaluate the selected run once.

A tick does four things:

1. Fetches recent crypto bars for the run config.
2. Fetches the latest crypto snapshot and order book when available.
3. Runs the deterministic strategy and risk policy.
4. Persists a strategy decision, linked market-data snapshot, trace ID, and decision receipt.
5. For approved paper runs only, submits a bounded paper crypto market order when the target exposure differs enough from the strategy-tracked exposure and all gates pass.

The tick result appears immediately in the trace explorer and in Portfolio → `Decision receipts`.

## Decision trace explorer

The trace explorer explains a strategy decision.

### Summary cards

| Card | Meaning |
| --- | --- |
| Decision | The final action, currently usually `enter` or `hold`. |
| Raw signal | Strategy output before additional risk adjustment. |
| Target exposure | Desired exposure after the strategy decision. |
| Data snapshots | Count of persisted market-data snapshots linked to this decision and how many were stale. |

### Recent decisions

This list shows recent decisions for the selected run. Click any decision to inspect its trace.

Each row includes:

- Symbol.
- Reason.
- Decision.
- Risk-adjusted signal.
- Target exposure.
- Trace ID prefix.

### Features

Features are derived strategy inputs.

Examples:

- `fastAverage`
- `slowAverage`
- `price`
- `mean`
- `zScore`
- `slice`
- `slices`

Features should tell you what the strategy saw when it made the decision.

### Thresholds

Thresholds are the configured boundaries used by the strategy.

Examples:

- `fast`
- `slow`
- `lookback`
- `entryZScore`
- `exitZScore`
- `exposure`

Thresholds let you compare the live decision against the saved config.

### Risk checks

Risk checks show the policy state for the decision.

Current shadow-mode checks include:

- `allowed`: whether the decision passed the current policy.
- `mode`: currently `shadow`.
- `trigger`: `manual` or `scheduler`.
- `submittedOrder`: `true` only when an approved paper run submits a bounded Alpaca paper crypto order.
- `intendedAction`: the action the strategy would have taken before risk gates.
- `reasons`: block or warning reasons when present.

Stale crypto snapshots now produce a stored `block` decision with `stale_data` in `reasons` instead of pretending the intended action passed. Approved paper runs also record approval, spread, budget, order-size, expiry and kill-switch gates.

### Order outcome

Shadow decisions normally show `none` because no crypto order is submitted. Approved paper decisions can show `drafted`, `linked`, `accepted`, `filled` or `rejected`, with broker order status and stored order payload beside the decision.

### Data provenance

Data provenance shows the exact market-data snapshot linked to the decision.

It includes:

- Symbol.
- Source, currently Alpaca crypto snapshot.
- Feed/location, currently `us`.
- Observation timestamp.
- Fresh/stale flag.

### Trace summary JSON

The JSON block is a compact, copyable summary of the trace. It includes:

- `traceId`
- `decision`
- `reason`
- `orderOutcome`
- `order`
- `features`
- `thresholds`
- `riskChecks`
- Snapshot summary with quote, trade, bar, and order-book level counts

The database stores the full snapshot payload. The UI intentionally summarizes large order books so the page stays readable.

## Decision receipts

Every strategy tick writes a decision receipt.

Open Portfolio -> `Decision receipts` to see strategy shadow and paper decisions alongside manual order and basket receipts.

A strategy receipt includes:

- Symbol.
- Run/strategy context.
- Trace ID prefix.
- Decision.
- Created timestamp.
- Whether a paper order was submitted.
- Paper order ID prefix when one exists.

Receipts are the audit trail that connect user-visible decisions back to stored traces.

## Current API endpoints

Useful endpoints for debugging:

```sh
# List runs
curl -fsS http://localhost:3000/api/strategy/runs

# Create a shadow run
curl -fsS http://localhost:3000/api/strategy/runs \
  -X POST \
  -H 'content-type: application/json' \
  -d '{"symbols":["BTC/USD"],"strategyId":"mean-reversion","timeframe":"1Hour","days":30,"params":{"lookback":20,"entryZScore":-2,"exitZScore":-0.25}}'

# Tick a run
curl -fsS http://localhost:3000/api/strategy/runs/RUN_ID/tick -X POST

# Approve a run for bounded paper automation
curl -fsS http://localhost:3000/api/strategy/runs/RUN_ID/paper-approval \
  -X POST \
  -H 'content-type: application/json' \
  -d '{"budget":250,"maxPositionNotional":250,"maxOrderNotional":50,"minOrderNotional":5,"maxSpreadBps":100,"maxDailyLossPercent":5,"maxDrawdownPercent":10,"maxDailyTurnoverPercent":50,"errorCooldownMinutes":30,"expiresHours":24,"timeInForce":"gtc"}'

# Pause or kill a run
curl -fsS http://localhost:3000/api/strategy/runs/RUN_ID/pause -X POST -H 'content-type: application/json' -d '{"reason":"review"}'
curl -fsS http://localhost:3000/api/strategy/runs/RUN_ID/kill -X POST -H 'content-type: application/json' -d '{"reason":"stop experiment"}'

# Save an experiment review
curl -fsS http://localhost:3000/api/strategy/runs/RUN_ID/review \
  -X POST \
  -H 'content-type: application/json' \
  -d '{"action":"revise","note":"Reduce exposure after drawdown review","revision":{"exposure":0.5}}'

# Preview a standalone paper crypto order
curl -fsS http://localhost:3000/api/strategy/crypto/order-preview \
  -X POST \
  -H 'content-type: application/json' \
  -d '{"symbol":"BTC/USD","side":"buy","type":"limit","amountType":"quantity","qty":0.001,"limitPrice":60000,"timeInForce":"gtc"}'

# Submit the reviewed standalone paper crypto order
curl -fsS http://localhost:3000/api/strategy/crypto/orders \
  -X POST \
  -H 'content-type: application/json' \
  -d '{"previewToken":"PREVIEW_TOKEN","idempotencyKey":"ORDER_KEY"}'

# List decisions for a run
curl -fsS http://localhost:3000/api/strategy/runs/RUN_ID/decisions

# Export an experiment report
curl -fsS http://localhost:3000/api/strategy/runs/RUN_ID/report

# Load run dashboard metrics
curl -fsS http://localhost:3000/api/strategy/runs/RUN_ID/dashboard

# Load post-fill attribution
curl -fsS http://localhost:3000/api/strategy/runs/RUN_ID/attribution

# Load active-run performance
curl -fsS http://localhost:3000/api/strategy/runs/RUN_ID/performance

# Load deterministic run alerts
curl -fsS http://localhost:3000/api/strategy/runs/RUN_ID/alerts

# Fetch a trace
curl -fsS http://localhost:3000/api/strategy/decision-traces/TRACE_ID

# Run a backtest
curl -fsS http://localhost:3000/api/strategy/backtests \
  -X POST \
  -H 'content-type: application/json' \
  -d '{"symbols":["BTC/USD"],"strategyId":"moving-average-trend","timeframe":"1Hour","days":30,"params":{"fast":5,"slow":20,"exposure":1},"initialCash":10000,"slippageBps":5}'
```

Replace `RUN_ID` and `TRACE_ID` with values from the UI or API responses.

## How to evaluate a strategy

Use this checklist when testing strategies:

1. Start with a hypothesis, not a parameter search.
2. Compare against buy-and-hold and cash.
3. Check max drawdown before total return.
4. Watch turnover; a strategy that trades constantly may be fragile.
5. Use several lookback windows and timeframes.
6. Create a shadow run only after a backtest looks worth observing.
7. Tick the shadow run over time and inspect each trace.
8. Track whether decisions remain sensible in different regimes.
9. Retire strategies that only work in one narrow historical window.
10. Do not increase budget or expiry until the run remains useful after friction, blocked-decision review and drawdown checks.

## Current limitations

- Strategy automation submits only approved Alpaca paper crypto market orders; standalone manual paper crypto tickets support market, limit and stop-limit orders. Live trading is unavailable.
- Recurring scheduling is in-process; it is not a durable distributed job runner.
- Most strategy runs are one-symbol; BTC/ETH relative strength supports the two-symbol BTC/ETH comparison basket.
- Backtests use bar-close execution and simple friction assumptions.
- Paper/live fill quality now includes visible order-book replay assumptions, but queue position, price improvement and venue-level liquidity are not fully modeled yet.
- Signal weights are stored but most current strategies do not emit non-empty weight maps.
- Full venue-level fill simulation and distributed scheduler durability remain roadmap work.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Backtest fails | Confirm Alpaca paper credentials, crypto market-data entitlement, valid symbol, valid timeframe and valid JSON parameters. |
| Shadow run creation fails | Confirm the strategy ID is supported and `symbols` contains a valid crypto pair such as `BTC/USD`. |
| Tick fails | Confirm the run is still `shadow`, crypto bars are available, and Alpaca crypto snapshots are reachable. |
| Scheduled run does not tick | Confirm the run was created with an interval above `0`, the server process is still running, and `STRATEGY_SCHEDULER_DISABLED` is not set to `1`. |
| No features appear | Some strategies or early bars may not have enough history to calculate indicators yet. Increase lookback days or use a longer history. |
| High turnover | Try slower timeframes, wider moving-average windows, or stricter entry/exit thresholds. |
| Trace JSON is compact | This is intentional. Full snapshot payloads are persisted and available through the trace API. |

## Safety boundary

Strategy Lab exists to learn. It should answer:

- What did the strategy see?
- What did it decide?
- Which parameters and thresholds mattered?
- Which data point influenced the signal?
- Was the data fresh?
- Did policy allow the action?
- Would this have been better than cash or buy-and-hold after friction?

It should not be used as proof of live edge. Paper and live crypto execution can differ materially because of fees, spread, liquidity, volatility, latency, queue position, partial fills, missed fills and venue behavior.
