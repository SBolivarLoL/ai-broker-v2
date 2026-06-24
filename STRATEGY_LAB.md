# Strategy Lab guide

Strategy Lab is the crypto strategy research and observability workspace in AI Broker. It lets you backtest deterministic strategies, create shadow runs, manually evaluate live signals, and inspect why a strategy made a decision.

The current Strategy Lab is research and shadow-mode only. It does not submit crypto orders. A shadow tick records what the strategy would do, the data it used, and the risk checks that were applied.

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
7. Click `Tick selected run` to evaluate the strategy against current market data.
8. Inspect the decision trace: features, thresholds, risk checks, data provenance, and trace JSON.
9. Review the strategy shadow decision in Portfolio → `Decision receipts`.

## Crypto experiment controls

### Crypto symbol

Use Alpaca crypto symbols such as:

- `BTC/USD`
- `ETH/USD`
- `SOL/USD`

The current UI creates one-symbol strategy runs. Multi-symbol comparison is still roadmap work.

### Strategy

The strategy selector chooses the deterministic strategy implementation used for backtests and shadow ticks.

| Strategy | What it does | Typical use |
| --- | --- | --- |
| `Moving average trend` | Enters exposure when the fast moving average is above the slow moving average. Holds cash when trend confirmation is unavailable or bearish. | Tests simple trend-following behavior and whipsaw risk. |
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
| `lookback` | Mean reversion | Number of bars used for rolling mean and standard deviation. |
| `entryZScore` | Mean reversion | Z-score threshold where the strategy enters exposure. Negative values mean price is below the rolling mean. |
| `exitZScore` | Mean reversion | Z-score threshold where the strategy exits exposure. |
| `slices` | Time-sliced accumulation | Number of bars used to ramp from zero to max exposure. |
| `exposure` | Trend, mean reversion | Target exposure when the signal is active. `1` means 100%. |
| `maxExposure` | Time-sliced accumulation | Maximum exposure after accumulation completes. |

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

Shadow runs do not trade. They are a durable experiment record that can be ticked repeatedly.

## Shadow run observability

The `Shadow run observability` panel lists persisted runs.

Each run shows:

- Strategy name.
- Symbol.
- Timeframe.
- Lookback days.
- Run status.
- Policy version.
- Created timestamp.

Click a run to select it.

### Tick selected run

Click `Tick selected run` to evaluate the selected shadow run once.

A tick does four things:

1. Fetches recent crypto bars for the run config.
2. Fetches the latest crypto snapshot and order book when available.
3. Runs the deterministic strategy and risk policy.
4. Persists a strategy decision, linked market-data snapshot, trace ID, and decision receipt.

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
- `submittedOrder`: always `false` in the current Strategy Lab UI.
- `reasons`: block or warning reasons when present.

Future paper automation will expand this with budget, exposure, drawdown, turnover, stale-data, liquidity and kill-switch checks.

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
- `features`
- `thresholds`
- `riskChecks`
- Snapshot summary with quote, trade, bar, and order-book level counts

The database stores the full snapshot payload. The UI intentionally summarizes large order books so the page stays readable.

## Decision receipts

Every shadow tick writes a decision receipt.

Open Portfolio → `Decision receipts` to see strategy shadow decisions alongside manual order and basket receipts.

A strategy shadow receipt includes:

- Symbol.
- Run/strategy context.
- Trace ID prefix.
- Decision.
- Created timestamp.
- No submitted order.

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

# List decisions for a run
curl -fsS http://localhost:3000/api/strategy/runs/RUN_ID/decisions

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
10. Do not promote anything to paper automation until run-level approval, risk caps, pause/kill controls, and post-fill attribution exist.

## Current limitations

- The Strategy Lab does not submit orders.
- Shadow ticks are manual; recurring scheduling is still roadmap work.
- The UI supports one-symbol strategy runs today.
- Backtests use bar-close execution and simple friction assumptions.
- Paper/live fill quality, queue position, price improvement, partial fills, missed fills and venue-level liquidity are not fully modeled yet.
- Signal weights are stored but most current strategies do not emit non-empty weight maps.
- Paper automation requires additional approval, budget, risk, pause and audit controls before it should be enabled.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Backtest fails | Confirm Alpaca paper credentials, crypto market-data entitlement, valid symbol, valid timeframe and valid JSON parameters. |
| Shadow run creation fails | Confirm the strategy ID is supported and `symbols` contains a valid crypto pair such as `BTC/USD`. |
| Tick fails | Confirm the run is still `shadow`, crypto bars are available, and Alpaca crypto snapshots are reachable. |
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
