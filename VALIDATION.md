# Validation record

Validated on 20 June 2026 against the eight objectives in `Quant_Competitions_AI_Broker_Hackathon_Challenge_Description.pdf`.

| Objective | Evidence | Result |
| --- | --- | --- |
| 1. Connected broker | `/ready`, `/api/account`, `bun run alpaca:doctor`, `bun run smoke:read` | Alpaca paper trading and market data connected |
| 2. Market view | `/api/quote`; agent `get_latest_price`, `get_price_history`, and news tools | Current price and recent 90-day evidence available |
| 3. Order ticket | Signed preview, explicit UI confirmation, idempotent submit, refresh/reconciliation; opt-in buy and sell smoke tests | Both paper sides accepted, found by client ID, cancelled, and reconciled |
| 4. AI functionality | `/api/agent/plans`; OpenAI Agents SDK structured output | Live plans return exactly three portfolio ideas |
| 5. Portfolio intelligence | `/api/portfolio/risk`; pure risk and what-if tests | Cash, P&L, concentration, HHI, volatility, drawdown, and policy impact |
| 6. Agentic AI | Seven bounded read-only tools, six-turn cap, stored plans | Live agent selects tools but cannot execute orders |
| 7. Creativity | Plan-linked Decision Receipt and lifecycle reconciliation | Advisor, evidence, simulation, approval key, order, and final status remain inspectable |
| 8. Explainability | `FEATURES.md` | Central rationale, boundaries, policy, failures, checks, and demo flow |

## Reproducible gates

```sh
bun install --frozen-lockfile
bun run check
bun run eval
bun audit
bun run alpaca:doctor
bun run smoke:read
SMOKE_ORDER=paper-confirm bun run smoke:order
SMOKE_ORDER=paper-confirm SMOKE_SIDE=sell SMOKE_SYMBOL=<owned-symbol> bun run smoke:order
```

The last two commands mutate only the Alpaca paper account. They use deliberately unreachable limit prices, cancel the exact returned order ID in `finally`, and fail unless cancellation reconciles.

## Verified invariants

- Runtime and CLI both hard-code paper mode; there is no live-trading switch.
- The model has no order, cancellation, credential, shell, CLI, or raw HTTP tool.
- Actionable agent ideas are rejected unless they cite a successful deterministic simulation returned during that run.
- The order boundary fails closed on invalid assets, prices, account data, signatures, expiry, quantity, cash, ownership, concentration, notional, or rolling turnover.
- Alpaca receives the app idempotency key as `clientOrderId`.
- Production refuses readiness without managed OIDC proxy settings, rejects unverified identities and cross-origin mutations, and rate-limits agent/order routes.
- No supplied Alpaca secret is tracked by Git; `bun audit` reports no known dependency vulnerabilities.

## Production boundary

This build is deliberately paper-only. For deployment, the app must sit on a private backend behind a managed OIDC identity-aware proxy that strips and overwrites `x-auth-request-email` and `x-auth-proxy-secret`. Configure `APP_ORIGIN`, `AUTHORIZED_EMAIL_DOMAIN`, and a 32+ character `AUTH_PROXY_SECRET`; `/ready` fails otherwise.
