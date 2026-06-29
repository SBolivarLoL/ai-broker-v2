# Validation record

Validated on 22 June 2026 against the eight objectives in `Quant_Competitions_AI_Broker_Hackathon_Challenge_Description.pdf`.
Last updated on 30 June 2026 for branch consolidation and test-hardening policy.

| Objective | Evidence | Result |
| --- | --- | --- |
| 1. Connected broker | `/ready`, `/api/account`, `bun run alpaca:doctor`, `bun run smoke:read` | Alpaca paper trading and market data connected |
| 2. Market view | Live IEX stream, company/benchmark workspace, session calendar, watchlists, event clusters, option chain and multi-asset monitor | Current data, timestamps, sources and entitlement gaps are visible |
| 3. Order ticket | Signed equity, linked, auction, basket, short and defined-risk option previews; exact confirmation, idempotency and reconciliation | Supported paper workflows fail closed and remain human-approved |
| 4. AI functionality | `/api/agent/plans`; OpenAI Agents SDK structured output | Live plans return exactly three portfolio ideas |
| 5. Portfolio intelligence | Risk, snapshot, performance, ledger and option-exposure endpoints; deterministic tests | VaR/ES, risk contribution, liquidity, benchmark and option stress remain outside the model |
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

## Test policy

- Unit, regression, system, function, and API tests own backend behavior, calculations, strategy decisions, data-quality handling, and paper-order safety.
- Browser or computer-use validation is reserved for UI-specific changes: rendering, layout, accessibility, responsive behavior, and interaction wiring.
- UI changes that depend on backend logic should add or reuse non-UI tests for the logic first, then use browser validation only for the visible workflow.

## Verified invariants

- Runtime and CLI both hard-code paper mode; there is no live-trading switch.
- The model has no order, cancellation, credential, shell, CLI, or raw HTTP tool.
- Actionable agent ideas are rejected unless they cite an unexpired deterministic simulation authority matching the exact symbol, side, quantity, policy and state snapshot from that run.
- The order boundary revalidates fresh broker state at confirmation and fails closed on invalid assets, fractional eligibility, price drift, incomplete order windows, unvalued working orders, account data, signatures, expiry, quantity, projected cash, projected ownership, projected concentration, notional, or rolling turnover.
- Atomic expiring reservations include concurrent local requests and broker working orders in projected risk; accepted reservations remain active until terminal reconciliation.
- Alpaca receives the app idempotency key as `clientOrderId`.
- Production refuses readiness without managed OIDC proxy settings, rejects unverified identities and cross-origin mutations, and rate-limits agent/order routes.
- No supplied Alpaca secret is tracked by Git; `bun audit` reports no known dependency vulnerabilities.
- `bun run check` passes 216 tests across 56 files; five concurrent dashboard sweeps completed with no HTTP failures (cold 0.66s, warm 0.21–0.23s on the validation machine).

## Production boundary

This build is deliberately paper-only. For deployment, the app must sit on a private backend behind a managed OIDC identity-aware proxy that strips and overwrites `x-auth-request-email` and `x-auth-proxy-secret`. Configure `APP_ORIGIN`, `AUTHORIZED_EMAIL_DOMAIN`, and a 32+ character `AUTH_PROXY_SECRET`; `/ready` fails otherwise.
