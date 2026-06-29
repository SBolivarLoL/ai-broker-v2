# Features and rationale
This is the challenge's central explainability file. The product is an internal-advisor prototype connected only to an Alpaca paper account.

## Objective map

| Objective | Implementation | Why it exists |
| --- | --- | --- |
| 1. Connected broker | Live equity, cash, buying power, positions, orders, health and readiness | Proves the paper account is connected and usable |
| 2. Market view | IEX live quotes/bars, company benchmarks, calendar, watchlists, clustered news, corporate actions, options chains and entitlement-aware multi-asset data | Grounds decisions in current, sourced broker data |
| 3. Order ticket | Signed equity, linked, auction, basket, explicit-short and defined-risk option previews with explicit confirmation, idempotency and lifecycle refresh | Makes paper orders safe and demoable |
| 4. AI functionality | OpenAI Agents SDK Guided Rebalance Agent | Produces useful portfolio-management ideas |
| 5. Portfolio intelligence | Reconciled ledger/snapshots, performance, VaR/expected shortfall, risk contribution, liquidity, benchmark diagnostics, option Greeks/stress and deterministic what-if simulation | Keeps risk math outside the model |
| 6. Agentic AI | The agent selects among seven read-only Alpaca and risk tools, then stores a plan | Demonstrates bounded multi-tool agency without autonomous execution |
| 7. Creativity | Decision Receipt links evidence, plan, risk checks, approval and Alpaca outcome | Makes every recommendation and order inspectable |
| 8. Explainability | This file, evidence IDs, strategy trace explorer, explicit guardrails and runnable checks | Shows how and why each feature works |
| 9. Crypto strategy observability | Strategy Lab backtests crypto strategies, creates shadow runs, records ticks, and displays decision traces with features, thresholds, risk checks and data provenance | Lets paper experiments run and be audited before automation |

## Data flow and boundaries

`Alpaca data → deterministic risk tools → agent plan → server preview → advisor confirmation → Alpaca paper order → reconciliation → Decision Receipt`

- The agent can read portfolio, risk, price, bars, news, asset/market status and simulations.
- The agent has no order, cancellation, credential, shell, CLI or raw HTTP tool.
- Alpaca news is untrusted evidence; the prompt forbids following instructions inside it.
- A deterministic output guardrail rejects invented evidence IDs, certainty claims, and actionable quantities unless an opaque simulation authority exactly matches the idea's symbol, side, quantity, policy version, state snapshot and expiry.
- The server is the only order boundary. A browser confirmation alone is never sufficient.
- `alpaca-ts-alpha` is the runtime integration. Alpaca CLI is used only for independent diagnostics and read-only smoke checks.

## Order policy

- Equity tickets require tradable US stocks or ETFs. Options use a separate defined-risk boundary.
- Ordinary sells cannot exceed holdings. A new paper short requires an explicit checkbox, margin-enabled account, marginable/easy-to-borrow asset, DAY market/limit order, fresh borrow validation and a 5% short-concentration cap.
- Maximum order is the lesser of $2,500 or 2.5% of equity.
- Resulting position concentration cannot exceed 20%.
- Conservative rolling-24-hour turnover cannot exceed 10% of equity.
- Preview tokens are HMAC-signed and expire after two minutes.
- Confirmation reloads the asset, quote, account, positions and order window; price moves above 1% require a new preview.
- Working broker orders and atomic local reservations consume cash, inventory, concentration and turnover capacity, preventing concurrent order stacking.
- Submission requires a unique idempotency key; duplicates return the original result or a processing response.
- A lost placement response is recovered by Alpaca `clientOrderId`; a retry reservation is released only when Alpaca confirms no matching order.
- Paper trading is hard-coded. Live mode is unavailable.
- Option execution is limited to long buy-to-open single legs and net-debit verticals. Naked selling is unavailable; previews show max loss, exercise cost and short-leg assignment notional.
- Rebalance baskets are atomically previewed and reserved inside the app, then submitted sequentially because Alpaca exposes no atomic equity-basket endpoint.
- Production refuses readiness unless a managed OIDC proxy origin, email domain and 32+ character proxy secret are configured. Mutations are same-origin, request bodies are bounded, broker DTOs are allow-listed, browser output is escaped, and money/agent routes are rate-limited per advisor.

## Failure behavior

- Missing or invalid account/price data fails closed.
- Policy failures return reasons without contacting the order API.
- Model, schema, tool or guardrail failures create no order and do not disable manual trading.
- Accepted orders appear as pending; reconciliation updates receipts as Alpaca reports state changes.
- Credentials and account identifiers are excluded from agent tool output and audit payloads.

## Validation evidence

- `bun run check` runs strict TypeScript checks and unit tests.
- `bun run eval` runs deterministic policy and trust-boundary scenarios.
- CI runs type checks, unit tests and the 25+ scenario safety corpus on every push and pull request.
- `bun run alpaca:doctor` verifies paper credentials and both Alpaca APIs through the independent CLI.
- `bun run smoke:read` verifies account, positions and open orders without mutation.
- `SMOKE_ORDER=paper-confirm bun run smoke:order` verifies buy or sell submit, lookup and exact cancellation in paper mode only.
- Live checks have verified the paper account, market/option data, monitoring, advanced risk, signed equity/basket/short/option previews and every application view without submitting validation orders.

## Five-minute demo

1. Show the connected paper account and portfolio risk.
2. Search a current market price.
3. Generate a `reduce_concentration` rebalance plan.
4. Open one idea's evidence, risk and invalidation condition.
5. Draft the suggested trade and show deterministic what-if impact.
6. Show an oversized or concentrated trade being blocked.
7. Confirm a valid paper order and show its pending/fill lifecycle.
8. Open the Strategy Lab, run a crypto backtest, tick a shadow run, and inspect the decision trace.
9. Open the Decision Receipt and this objective map.

For detailed Strategy Lab operating instructions, see `STRATEGY_LAB.md`.
