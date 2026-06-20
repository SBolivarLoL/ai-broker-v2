# Features and rationale
This is the challenge's central explainability file. The product is an internal-advisor prototype connected only to an Alpaca paper account.

## Objective map

| Objective | Implementation | Why it exists |
| --- | --- | --- |
| 1. Connected broker | Live equity, cash, buying power, positions, orders, health and readiness | Proves the paper account is connected and usable |
| 2. Market view | Latest Alpaca prices plus agent access to 90-day bars and news | Grounds decisions in recent broker data |
| 3. Order ticket | Buy/sell ticket, signed preview, explicit confirmation, idempotent submission and lifecycle refresh | Makes paper orders safe and demoable |
| 4. AI functionality | OpenAI Agents SDK Guided Rebalance Agent | Produces useful portfolio-management ideas |
| 5. Portfolio intelligence | Cash, P&L, weights, top exposure, HHI and deterministic what-if simulation | Keeps risk math outside the model |
| 6. Agentic AI | The agent selects among seven read-only Alpaca and risk tools, then stores a plan | Demonstrates bounded multi-tool agency without autonomous execution |
| 7. Creativity | Decision Receipt links evidence, plan, risk checks, approval and Alpaca outcome | Makes every recommendation and order inspectable |
| 8. Explainability | This file, evidence IDs, explicit guardrails and runnable checks | Shows how and why each feature works |

## Data flow and boundaries

`Alpaca data → deterministic risk tools → agent plan → server preview → advisor confirmation → Alpaca paper order → reconciliation → Decision Receipt`

- The agent can read portfolio, risk, price, bars, news, asset/market status and simulations.
- The agent has no order, cancellation, credential, shell, CLI or raw HTTP tool.
- Alpaca news is untrusted evidence; the prompt forbids following instructions inside it.
- The server is the only order boundary. A browser confirmation alone is never sufficient.
- `alpaca-ts-alpha` is the runtime integration. Alpaca CLI is used only for independent diagnostics and read-only smoke checks.

## Order policy

- US stocks and ETFs only; Alpaca must report the asset tradable.
- No shorts: sell quantity cannot exceed the owned quantity.
- Maximum order is the lesser of $2,500 or 2.5% of equity.
- Resulting position concentration cannot exceed 20%.
- Daily turnover cannot exceed 10% of equity.
- Preview tokens are HMAC-signed and expire after two minutes.
- Submission requires a unique idempotency key; duplicates return the original result or a processing response.
- Paper trading is hard-coded. Live mode is unavailable.
- Production refuses readiness unless a managed OIDC proxy origin, email domain and 32+ character proxy secret are configured. Mutations are same-origin and money/agent routes are rate-limited per advisor.

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
- `SMOKE_ORDER=paper-confirm bun run smoke:order` verifies submit, lookup and exact cancellation in paper mode only.
- Live checks have verified the paper account, current price, risk endpoint, signed preview and stored evidence-backed agent plan.

## Five-minute demo

1. Show the connected paper account and portfolio risk.
2. Search a current market price.
3. Generate a `reduce_concentration` rebalance plan.
4. Open one idea's evidence, risk and invalidation condition.
5. Draft the suggested trade and show deterministic what-if impact.
6. Show an oversized or concentrated trade being blocked.
7. Confirm a valid paper order and show its pending/fill lifecycle.
8. Open the Decision Receipt and this objective map.
