# Strategy Lab guide

Last reviewed against `main` commit `54b76c2`: 2026-07-07.

Strategy Lab is the crypto strategy research and observability workspace in AI Broker. It supports deterministic backtests, persisted shadow runs, manual or scheduled signal evaluation, and explicitly approved bounded Alpaca paper orders.

It is a learning system, not evidence of live trading edge. Live trading, leverage, perpetual futures, transfers, wallets, custody, and tokenized products are unavailable.

## Start

```sh
bun install
cp .env.example .env
# Add Alpaca paper credentials, PREVIEW_SECRET, and SEC_USER_AGENT.
bun start
```

Open `http://localhost:3000/#strategies`. For another port:

```sh
PORT=3017 bun --env-file=.env backend/server.ts
```

The process records its Git commit and working-tree state at startup. A dirty checkout can run and retain backtests for audit, but those artifacts cannot create comparable shadow runs. Restart after checking out another commit so the process identity matches the running code.

## Experiment lifecycle

1. State a falsifiable hypothesis and choose a baseline before changing parameters.
2. Run and persist a deterministic backtest on Alpaca crypto bars.
3. Review return, drawdown, turnover, exposure, costs, and data limitations.
4. Create a shadow run only when the test is worth observing prospectively.
5. Tick it manually or schedule in-process ticks; inspect every block and decision trace.
6. Approve a conservative paper budget only after enough shadow evidence exists.
7. Review active performance, fill quality, post-fill attribution, alerts, and baseline comparisons.
8. Continue, pause, revise, retire, or mark the experiment complete with a written note.

Do not tune repeatedly against the same period and call the final result out of sample. The walk-forward API freezes each fold's train-selected candidate before scoring its test bars and can reserve a final holdout that is not used for any fold selection, but the candidate set must still be declared before inspecting those results.

## Strategy catalog

All strategies use the plugin lifecycle `prepare`, `features`, `decide`, `riskAdjust`, `orders`, and `attribution`.

| Strategy ID                  | Behavior                                                         | Main failure mode                                     |
| ---------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------- |
| `cash`                       | Holds no crypto exposure                                         | Missed upside; baseline only                          |
| `buy-and-hold`               | Enters full exposure and holds                                   | Full market drawdown; baseline only                   |
| `time-sliced-accumulation`   | Ramps exposure over fixed slices                                 | Continues accumulating through adverse regimes        |
| `moving-average-trend`       | Holds exposure when fast average exceeds slow average            | Whipsaw in range-bound markets                        |
| `mean-reversion`             | Enters below a rolling mean and exits near it                    | Persistent trends and clustered losses                |
| `breakout-momentum`          | Requires prior-high breakout plus volume confirmation and a stop | False breakouts and gap/slippage risk                 |
| `volatility-filter`          | Holds exposure only inside a realized-volatility band            | Missed upside or unstable regime boundaries           |
| `btc-eth-relative-strength`  | Trades the primary BTC/ETH asset when it outperforms the peer    | Concentration and ranking churn                       |
| `order-book-liquidity-scout` | Requires bounded spread and visible bid/ask depth                | Snapshot depth may not represent executable liquidity |

Supported symbols are `BTC/USD`, `ETH/USD`, and `SOL/USD`. Most runs use one symbol. Relative strength accepts `BTC/USD,ETH/USD` or the reverse; the first symbol is the traded primary.

## Controls

### Timeframe and history

The Strategy Lab UI offers `15Min`, `1Hour`, and `1Day`. The API validation
boundary also accepts `1Min`, `5Min`, and `4Hour`; all six values are covered
by the strategy-data input test. The server and Strategy Lab input accept 1-90
lookback days from one tested constraint contract.

Direct provider backtests and live shadow ticks use that 1-90 day boundary.
The API can separately ingest an immutable stored dataset covering up to 3,650
days and 500,000 estimated bars. It splits the query into bounded 90-day
provider requests, then normalizes and stores the result. Stored-dataset
backtests can therefore exceed 90 days without a fresh provider call; this
workflow is not yet exposed in the Strategy Lab browser UI.

### Parameters

The UI currently accepts a JSON object. The same strict server schema applies the defaults below to backtests and saved runs. Unknown fields, strings in numeric fields, non-finite values, contradictory thresholds, and out-of-range values are rejected before a plugin is constructed.

```json
{ "fast": 5, "slow": 20, "exposure": 1 }
```

```json
{ "lookback": 20, "entryZScore": -2, "exitZScore": -0.25, "exposure": 1 }
```

```json
{
  "lookback": 20,
  "volumeLookback": 20,
  "volumeMultiple": 1.25,
  "stopLossPercent": 8,
  "exposure": 1
}
```

```json
{
  "lookback": 20,
  "minVolatilityPercent": 0,
  "maxVolatilityPercent": 6,
  "exposure": 1
}
```

```json
{ "lookback": 20, "minRelativeStrengthPercent": 0, "exposure": 1 }
```

```json
{
  "maxSpreadBps": 100,
  "minVisibleAskNotional": 500,
  "minVisibleBidNotional": 500,
  "maxDepthLevels": 25,
  "exposure": 1
}
```

```json
{ "slices": 10, "maxExposure": 1 }
```

Cash and buy-and-hold use `{}`.

| Parameter                                        | Meaning                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `fast`, `slow`                                   | Moving-average windows; slow must exceed fast                      |
| `lookback`                                       | Rolling z-score, breakout, volatility, or relative-strength window |
| `entryZScore`, `exitZScore`                      | Mean-reversion activation and exit boundaries                      |
| `volumeLookback`, `volumeMultiple`               | Breakout volume confirmation                                       |
| `stopLossPercent`                                | Breakout exit relative to recorded entry price                     |
| `minVolatilityPercent`, `maxVolatilityPercent`   | Allowed realized-volatility band                                   |
| `minRelativeStrengthPercent`                     | Minimum primary-versus-peer return edge; the peer is derived from the ordered BTC/ETH pair |
| `maxSpreadBps`                                   | Maximum order-book or paper-approval spread                        |
| `minVisibleAskNotional`, `minVisibleBidNotional` | Required visible depth                                             |
| `maxDepthLevels`                                 | Maximum order-book levels used                                     |
| `slices`, `maxExposure`                          | Accumulation schedule and final exposure                           |
| `exposure`                                       | Target exposure from 0 to 1 when the signal is active              |

### Schedule

`intervalMinutes` accepts 0 or 1-1440. Zero disables recurring ticks. The scheduler is in-process and non-durable: the server must remain running, and a restart can delay work. Set `STRATEGY_SCHEDULER_DISABLED=1` to disable it.

## Backtests

The current backtester:

- Sorts and validates returned bars.
- Executes target-exposure changes at bar close.
- Defaults to $10,000 initial cash, 0 bps fee, and 5 bps slippage.
- Returns strategy and cash/buy-and-hold baseline results.
- Reports total return, max drawdown, exposure time, turnover, modeled costs, points, features, thresholds, reasons, a `tradeMetrics` object, and an `uncertainty` object. Trade metrics cover material order count, position episodes, closed round trips, average holding bars/days, gross/net return, downside deviation, Sortino, Calmar, profit factor, hit rate, average win/loss, turnover, exposure, and capacity warnings.
- Computes deterministic moving-block-bootstrap uncertainty ranges for total return and max drawdown when at least 20 scored return observations exist. Smaller samples return `status:"insufficient_data"`. Bootstrap ranges are evidence, not rankings; each uncertainty object is marked `rankingUse:"not_rankable"`.
- Preserves legacy train/test boundary segmentation when top-level `trainSize` and `testSize` are supplied.
- Runs genuine rolling or anchored walk-forward evaluation when `walkForward` supplies `trainSize`, `testSize`, and 1-20 unique parameter candidates. Every fold scores candidates only on train bars, deterministically breaks ties by lower drawdown, lower turnover, and canonical hash, then freezes the winner for untouched test scoring.
- Accepts optional `mode` (`rolling`, default, or `anchored`), `holdoutSize`, and caller-declared `regimes`. A holdout is removed from the validation-fold universe, never participates in fold selection, and is scored once with parameters selected only from pre-holdout bars. Regime slices are reports only: validation and holdout observations are summarized separately and do not influence selection.
- Resets capital and position for each test fold while warming stateful indicators on its train history. It returns exact timestamp boundaries, canonical candidates and train scores, selected parameters/hash, full test results, compounded out-of-sample return, worst fold drawdown, costs, exposure, regime slices, final holdout evidence when requested, and explicit leakage checks.
- Rejects more than 100 folds, more than 2,000,000 evaluated bars, incomplete folds, duplicate canonical candidates, and timestamp-misaligned multi-symbol histories.
- Persists an immutable request, result, baselines, Git/plugin/feature/policy versions, exact query window, provider/feed, and normalized dataset hash.
- Can use an actor-owned stored dataset by `datasetId`; symbols and timeframe must match, and the backtest reuses its immutable hash without querying Alpaca again.
- Returns a `backtestId`; a matching clean backtest is required to create a comparable shadow run.

It does not yet:

- Provide alternative selection objectives.
- Prevent an operator from designing the candidate set after inspecting the same historical period; preregister candidates and reserve a final holdout before looking at the outcome.
- Model intrabar execution, queue position, market impact, price improvement, or a full fee schedule.
- Fetch more than 90 days in one provider request; long histories must first use the chunked dataset-ingestion API.

Treat a backtest as a screening tool. A stored hash proves which input was used, not that the input was complete or representative. A useful result earns prospective shadow observation, not a larger budget.

The selection objective is fixed: highest train total return, then lower train drawdown, lower train turnover, and candidate hash. This is reproducible, not automatically statistically sound. Test-fold results never influence selection within that fold, but repeated human edits after seeing test output still contaminate the experiment.

Walk-forward fold winners are evaluation evidence. The ordinary full-period result and any linked shadow run continue to use the top-level `params`; the API does not silently promote a fold-specific winner into execution configuration.

Backtest artifacts are immutable and actor-scoped at retrieval. Run creation checks the exact strategy definition, plugin version, feature schema, dataset hash, and Git commit against the selected backtest. A server restarted on a different commit must produce a new reviewed backtest even when the visible parameters are unchanged.

## Shadow runs and traces

Creating a run requires the `backtestId` of a matching reviewed artifact and stores that link with strategy/config/policy versions, exact Git commit, feature-schema version, query window, provider/feed, and dataset hash. A changed strategy definition requires another backtest. Legacy records and dirty working-tree artifacts remain readable but are explicitly non-comparable and cannot be ticked or approved.

Each tick:

1. Fetches recent crypto bars and the latest snapshot/order book.
2. Normalizes and hashes the bars and snapshots, then persists each snapshot with source, feed, timestamp, latency, stale state, and content hash.
3. Runs the deterministic plugin and strategy risk policy.
4. Stores the decision, exact combined input hash, trace, receipt, spans, and metrics.
5. Submits a paper market order only when the run is approved and every strategy/global gate passes.

A stale snapshot produces a stored `block` decision. Missing evidence never silently becomes approval.

The trace explorer exposes:

- Decision, reason, raw/risk-adjusted signal, and target exposure.
- Features, thresholds, weights, and risk checks.
- Data snapshot IDs, provenance, freshness, and a bounded payload summary.
- Draft/linked paper order and broker outcome when present.
- Filters by symbol, decision, strategy version, block reason, and order outcome.

The full snapshot remains in SQLite even when the browser displays a compact summary.

## Data and retention boundary

Strategy experiments persist immutable bar-dataset versions and normalized bars, backtests, configuration, crypto snapshots and order books, decisions, paper orders, metrics, notes, and hash-chained audit records across ten strategy tables. Dataset versions preserve provider, feed, UTC timezone, query bounds, observed bounds, gaps, rejected bars, duplicate and conflicting-duplicate counts, additions, corrections, removals, predecessor ID, and deterministic content hash. The governance registry classifies these records as internal, paper-only output sourced from Alpaca paper trading, Alpaca crypto data, and local derived analytics.

Retention metadata does not delete data. There is no automatic pruning job, so a long-running experiment can grow the local SQLite database until an operator removes or archives records under a reviewed policy. Inspect `/api/operations/data-governance` for the current provider and stored-output decisions; external entitlement review remains required before any different user, redistribution, or live use.

## Paper approval and execution

A selected run can receive an explicit approval containing:

- Total budget, maximum position, maximum order, and minimum order notional.
- Maximum spread, daily loss, drawdown, and daily turnover.
- Error cooldown, approval expiry, and `GTC` or `IOC` time in force.

Approved ticks use fresh account cash/buying power, 24/7 crypto session handling, strategy-tracked exposure, approval state, and global operations policy. The runner currently submits notional buys and fractional-quantity sells as Alpaca paper crypto market orders.

Use `Pause run` to stop evaluation. `Kill run` retires the run and records a kill-switch flag. Review actions are `continue`, `pause`, `retire`, `revise`, and `promote`; `promote` only completes the experiment record and never enables live trading.

### Standalone crypto ticket

The manual ticket is separate from strategy automation. It supports market, limit, and stop-limit paper orders with `GTC` or `IOC`.

Preview checks include fresh crypto market evidence, a default 200 bps spread gate for market orders, a $2,500 maximum notional, cash for buys, holdings for sells, global operations policy, and a two-minute HMAC-signed preview. Submission reloads account, positions, working orders, and market state, then atomically reserves local turnover and exposure capacity before calling Alpaca. Confirmed failure releases both the idempotency key and reservation so the same reviewed request can be retried; price movement above 1% requires a new preview. Crypto shorting is unavailable.

## Metrics, alerts, and reports

Run dashboards derive decision count, block rate, stale-data rate, exposure, budget use, order outcomes, fill ratio, estimated fill slippage, and top block reasons from persisted evidence.

Active performance reconstructs strategy cash, units, equity, return, and drawdown from filled strategy orders and subsequent bars. It reports insufficient data rather than estimating when budget, fills, or marks are missing.

Post-fill attribution reports side-aware fill slippage and 1h/1d/7d market moves. Order-book replay uses the decision-time snapshot, up to 25 visible levels, 250 ms assumed submit latency, a five-second maximum latency, and the approval spread cap or 200 bps fallback. Outcomes are `full_fill`, `partial_fill`, `missed_fill`, or `missing_order_book`; these are replay assumptions, not broker fills.

Execution replay also emits `calibration`, a deterministic friction-calibration section derived from accumulated paper receipts and order-book replay evidence. It reports sample sizes for paper orders, receipt fill slippage, explicit fees, order-book replays, spreads, and latencies; summarizes average/p50/p95/max evidence; estimates partial-fill, missed-fill, and missing-book rates; and recommends conservative `feeBps`, `slippageBps`, `maxSpreadBps`, and `assumedOrderLatencyMs`. Cost assumptions use the larger of user/default assumptions and p95 evidence, spread guardrails use the stricter user cap or calibrated spread buffer, and latency uses the larger user or observed p95 assumption. Calibration remains `insufficient_evidence` until at least 20 orders have replay evidence.

Deterministic alerts cover stale feeds, strategy errors, rejected orders, drawdown, turnover, repeated slippage, and reconciliation drift.

Experiment reports include config, assumptions, coverage, metrics, orders, attribution, execution replay, notable decisions, review history, notes, and the hash-chained strategy audit with verification status.

## API examples

These examples are for local development, where the demo actor has all roles. Production requests must pass the configured proxy identity and origin boundary.

```sh
# Ingest a versioned long-history dataset; HTTP 201 creates a version and an
# exact repeat returns HTTP 200 with reused=true.
curl -fsS http://localhost:3000/api/strategy/datasets \
  -X POST -H 'content-type: application/json' \
  -d '{"symbols":["BTC/USD"],"timeframe":"1Day","start":"2023-01-01T00:00:00.000Z","end":"2026-01-01T00:00:00.000Z"}'

# List versions or retrieve one with its normalized bars.
curl -fsS http://localhost:3000/api/strategy/datasets
curl -fsS 'http://localhost:3000/api/strategy/datasets/DATASET_ID?includeBars=1'

# Backtest the stored version without another provider read.
curl -fsS http://localhost:3000/api/strategy/backtests \
  -X POST -H 'content-type: application/json' \
  -d '{"datasetId":"DATASET_ID","strategyId":"moving-average-trend","params":{"fast":5,"slow":20,"exposure":1},"initialCash":10000,"slippageBps":5}'

# Select only on each train slice, score the frozen winner on its test slice,
# then score one untouched final holdout and summarize declared regimes.
curl -fsS http://localhost:3000/api/strategy/backtests \
  -X POST -H 'content-type: application/json' \
  -d '{"datasetId":"DATASET_ID","strategyId":"moving-average-trend","params":{"fast":5,"slow":20,"exposure":1},"walkForward":{"mode":"anchored","trainSize":365,"testSize":30,"holdoutSize":90,"regimes":[{"id":"post-halving","start":"2024-04-20T00:00:00.000Z","end":"2024-10-20T00:00:00.000Z"}],"candidates":[{"fast":5,"slow":20,"exposure":1},{"fast":10,"slow":50,"exposure":1},{"fast":20,"slow":100,"exposure":0.5}]}}'

# Run a backtest; HTTP 201 returns the immutable backtestId and provenance
curl -fsS http://localhost:3000/api/strategy/backtests \
  -X POST -H 'content-type: application/json' \
  -d '{"symbols":["BTC/USD"],"strategyId":"moving-average-trend","timeframe":"1Hour","days":30,"params":{"fast":5,"slow":20,"exposure":1},"initialCash":10000,"slippageBps":5}'

# Retrieve the artifact, list runs, then create a matching linked run
curl -fsS http://localhost:3000/api/strategy/backtests/BACKTEST_ID
curl -fsS http://localhost:3000/api/strategy/runs
curl -fsS http://localhost:3000/api/strategy/runs \
  -X POST -H 'content-type: application/json' \
  -d '{"backtestId":"BACKTEST_ID","symbols":["BTC/USD"],"strategyId":"moving-average-trend","timeframe":"1Hour","days":30,"params":{"fast":5,"slow":20,"exposure":1}}'

# Tick and approve a run
curl -fsS http://localhost:3000/api/strategy/runs/RUN_ID/tick -X POST
curl -fsS http://localhost:3000/api/strategy/runs/RUN_ID/paper-approval \
  -X POST -H 'content-type: application/json' \
  -d '{"budget":250,"maxPositionNotional":250,"maxOrderNotional":50,"minOrderNotional":5,"maxSpreadBps":100,"maxDailyLossPercent":5,"maxDrawdownPercent":10,"maxDailyTurnoverPercent":50,"errorCooldownMinutes":30,"expiresHours":24,"timeInForce":"gtc"}'

# Pause, kill, or review
curl -fsS http://localhost:3000/api/strategy/runs/RUN_ID/pause \
  -X POST -H 'content-type: application/json' -d '{"reason":"review"}'
curl -fsS http://localhost:3000/api/strategy/runs/RUN_ID/kill \
  -X POST -H 'content-type: application/json' -d '{"reason":"stop experiment"}'
curl -fsS http://localhost:3000/api/strategy/runs/RUN_ID/review \
  -X POST -H 'content-type: application/json' \
  -d '{"action":"revise","note":"Reduce exposure after drawdown review","revision":{"exposure":0.5}}'

# Inspect evidence
curl -fsS http://localhost:3000/api/strategy/runs/RUN_ID/decisions
curl -fsS http://localhost:3000/api/strategy/runs/RUN_ID/dashboard
curl -fsS http://localhost:3000/api/strategy/runs/RUN_ID/performance
curl -fsS http://localhost:3000/api/strategy/runs/RUN_ID/attribution
curl -fsS http://localhost:3000/api/strategy/runs/RUN_ID/alerts
curl -fsS http://localhost:3000/api/strategy/runs/RUN_ID/audit
curl -fsS http://localhost:3000/api/strategy/runs/RUN_ID/report
curl -fsS http://localhost:3000/api/strategy/decision-traces/TRACE_ID
```

Standalone ticket endpoints are `POST /api/strategy/crypto/order-preview` and `POST /api/strategy/crypto/orders`. The second request uses the reviewed `previewToken` and a unique `idempotencyKey`.

## Evaluation checklist

Before continuing or increasing a paper experiment:

1. Was the hypothesis written before results were seen?
2. Did the strategy beat cash and buy-and-hold after the same costs and period?
3. Is drawdown acceptable before considering return?
4. Are there enough trades/decisions, or is the result one lucky move?
5. Does performance survive slower/faster windows without selecting only the winner?
6. Was any final period untouched during tuning?
7. Are stale data, blocked decisions, missing fills, and provider gaps included?
8. Does paper fill evidence support the assumed spread/slippage?
9. Has the exact config remained unchanged during the review window?
10. Is there a clear invalidation rule and written reason to continue?

## Troubleshooting

| Problem                   | Check                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dataset ingest rejected   | Actor role, supported symbols/timeframe, UTC date range, future-date rule, 3,650-day range, 500,000-bar estimate, provider response, and valid bars |
| Backtest rejected         | Paper credentials; or actor-owned `datasetId`; symbol, timeframe, JSON, finite parameters, and the direct-query 1-90 day bound                      |
| Walk-forward rejected     | Canonical unique candidates, complete train/test fold, synchronized symbols, 20-candidate/100-fold/2,000,000-evaluated-bar limits, and no legacy-size mix |
| Run creation rejected     | Clean current commit, actor-owned `backtestId` and optional `datasetId`, exact strategy/parameters/timeframe/history match, and valid symbol set    |
| Tick blocked              | Run status, fresh bars/snapshot, approval expiry, spread, budget, loss/drawdown/turnover, cooldown, and kill switch                              |
| Scheduled tick missing    | Nonzero interval, running server process, due timestamp, and `STRATEGY_SCHEDULER_DISABLED`                                                       |
| Features unavailable      | Increase history; indicators remain null until enough valid bars exist                                                                           |
| Performance unavailable   | Filled strategy order, positive budget, and post-fill bars are all required                                                                      |
| Order-book replay missing | The decision-time snapshot did not include usable depth; the app will not infer it                                                               |

For implementation priorities and the next strategy catalog, see `roadmap.md`. For current automated evidence and its boundaries, see `VALIDATION.md`.
