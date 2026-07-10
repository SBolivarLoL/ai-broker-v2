# AI Broker

AI Broker is a paper-only personal investing workstation built with Bun, TypeScript, Alpaca, SQLite, and the OpenAI Agents SDK. It combines portfolio analytics, research, guarded paper-order workflows, and a crypto Strategy Lab for backtests, shadow runs, and bounded paper experiments.

Live trading is intentionally unavailable. Every broker client is constructed with `paper: true`.

Code baseline reviewed: `main` at `07e4b30` on 2026-07-10.

## Quick start

Requirements: [Bun 1.2.15](https://bun.sh/) and an Alpaca paper account. Coverage metrics are runtime-sensitive, so local and CI checks use the pinned version.

## Project layout

- `frontend/` contains browser assets.
- `backend/features/` contains domain behavior.
- `backend/integrations/` contains provider adapters.
- `backend/persistence/` contains SQLite storage.
- `tests/` mirrors the backend boundaries.
- `scripts/` contains smoke checks and diagnostics.
- `docs/architecture/` explains dependency direction and placement rules.

```sh
bun install
cp .env.example .env
# Add Alpaca paper credentials, a real SEC contact identity, and a 32+ character PREVIEW_SECRET.
bun start
```

Open `http://localhost:3000`. Set `PORT` to use another port.

The minimum local configuration is:

```dotenv
APCA_API_KEY_ID=your-paper-key
APCA_API_SECRET_KEY=your-paper-secret
PREVIEW_SECRET=replace-with-at-least-32-random-characters
SEC_USER_AGENT=ai-broker-v2 your-monitored-email@example.com
```

`OPENAI_API_KEY` is optional. Without it, deterministic broker, portfolio, market, research-source, and Strategy Lab features still work; AI Advisor and generated company analysis return an explicit unavailable response.

Optional provider keys are `FRED_API_KEY`, `BEA_USER_ID`, `FINNHUB_API_KEY`, and `OPENFIGI_API_KEY`. Production proxy settings, scheduler controls, model selection, portfolio benchmark, and deployed-build identity are documented in [`.env.example`](.env.example). Local secrets and SQLite files are ignored by Git.

## What is included

- Alpaca paper account, positions, orders, activities, watchlists, market clock, calendar, IEX market data, single-symbol quotes, market monitoring, company-market snapshots, market workspace discovery/session DTOs, and entitled multi-asset market snapshots with explicit observation/retrieval/server-response provenance where migrated.
- Signed equity, linked, basket, short, option, and crypto paper-order previews with fresh-state confirmation, idempotency, receipts, and global operations policy.
- Portfolio performance, FIFO ledger, risk, exposure, scenarios, optimizer proposals, and constrained rebalance planning.
- SEC filings and company facts, official US macro context, Alpaca/Benzinga news, GDELT signals, optional Finnhub enrichment, and OpenFIGI identity checks with canonical source/time provenance. SEC classification, recent-filing, filing-evidence/section, company-facts result, and material-alert DTOs preserve applicable filing-date publication, report-date effective-period, provider-retrieval, and server-response time; GDELT, Finnhub, and OpenFIGI provider DTOs preserve their applicable taxonomy. Cached SEC/GDELT/Finnhub/OpenFIGI data retains its provider retrieval time while refreshing per-response server time, and unqueried optional-provider states expose retrieval as unavailable.
- Evidence-bound portfolio Q&A, company research, valuation scenarios, counter-thesis review, and trade journal.
- Immutable crypto backtests linked to shadow and scheduled runs, versioned long-history bar datasets, train-only rolling/anchored walk-forward evaluation with untouched holdouts, regime slices, trade metrics, uncertainty ranges, compatible cohort comparison, pre-registered bounded paper experiments, exact dataset/code provenance, trace reconstruction, alerts, attribution, friction calibration, promotion evidence gates, and reports.
- SQLite persistence with ordered transactional migrations, hash-chained decision records, serialized backups, encrypted secret envelopes, readiness exports, paper-beta evidence reporting, a source/output governance registry, and local provider/dataset quality reporting.
- A dark operator-workstation browser shell with a persistent desktop rail, compact tablet rail, horizontally discoverable mobile navigation, global data-health/environment/execution status, private-value masking, accessible confirmation dialogs, strategy-specific experiment controls, and explicit option-chain coverage warnings.

The application currently runs as one Bun process with a local SQLite database at `data/app.db`. The scheduler is in-process, so the server must remain running for scheduled strategy ticks.

## Architecture at a glance

- `backend/server.ts` starts the Bun process; `backend/app.ts` composes the dependency-injected HTTP application.
- `backend/features/` groups product behavior and route handlers by bounded context.
- `backend/integrations/`, `backend/persistence/`, and `backend/shared/` isolate provider, storage, and cross-cutting code.
- `frontend/` separates the browser shell, styles, shared utilities, and workspace scripts.
- `tests/` mirrors the backend boundaries; `scripts/` contains deliberate diagnostics and smoke checks.

Feature routes are independently owned, persistence uses ordered migrations, and the browser is split into nine shell/style/script assets instead of one inline client. The current repository inventory is recorded in [`docs/VALIDATION.md`](docs/VALIDATION.md).

## Quality snapshot

| Boundary              | Reviewed state                                                                                                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automated checks      | The standard and focused safety suites pass; strict TypeScript covers `backend/`, `tests/`, and `scripts/`                                                                                                                                                     |
| Instrumented coverage | The reviewed deterministic-module mean passes the 95% function and 96% line floors                                                                                                                                                                             |
| API composition       | Primary orders, mutations, option actions, strategy paper execution, recovery, and runtime trade updates are directly covered; concurrent capacity is transactional                                                                                            |
| Data quality          | Provider health, strategy dataset quality, canonical time provenance, and migrated provider DTO time provenance are reported from local events, evidence records, provider fixtures, and immutable dataset stats; external entitlement review remains separate |
| Browser               | Targeted all-workspace dark-workstation, desktop/tablet/mobile, Strategy Lab, option coverage, privacy, and modal keyboard validation exists; no maintained browser regression suite                                                                           |
| Persistence           | Transactional migrations through 0014 and a serialized fixture restore pass, including versioned strategy datasets                                                                                                                                             |
| Production            | Paper-only; legal, entitlement, closed-beta, restore-drill, and live-deployment gates remain open                                                                                                                                                              |

See [`docs/VALIDATION.md`](docs/VALIDATION.md) for evidence and scope. Coverage is not application-wide: orchestration, the browser, and the process entry are outside the percentage gate, and credentialed smoke behavior is not exercised in CI.

## Commands

```sh
bun run check             # strict TypeScript, all tests, and the deterministic coverage floor
bun run eval              # focused broker safety and agent trust-boundary suite
bun run eval:research     # credentialed live research evaluation
bun run coverage          # 95% function / 96% line coverage gate
bun audit                 # dependency vulnerability audit
bun run alpaca:doctor     # independent Alpaca paper/API diagnostic
bun run smoke:read        # live read-only account, position, and open-order checks
bun run smoke:sec         # live SEC extraction and provenance check
bun run smoke:macro       # live official macro-provider check
bun run smoke:gdelt       # live GDELT signal/fallback check
bun run smoke:finnhub     # missing-key or configured Finnhub check
bun run smoke:openfigi    # live OpenFIGI identity/fallback check
bun run smoke:comparables # live Alpaca plus SEC valuation check
```

`SEC_SYMBOL` overrides the default `AAPL` SEC smoke symbol.
`RESEARCH_EVAL_SYMBOLS` overrides the default `AAPL,MSFT,NVDA` live research
evaluation set.

The mutating smoke test is opt-in and paper-only. It creates an unreachable limit order and cancels the exact returned order ID:

```sh
SMOKE_ORDER=paper-confirm bun run smoke:order
SMOKE_ORDER=paper-confirm SMOKE_SIDE=sell SMOKE_SYMBOL=<owned-symbol> bun run smoke:order
```

## Documentation

- [`docs/FEATURES.md`](docs/FEATURES.md): implemented capabilities, architecture, safety, data contracts, and known limitations.
- [`docs/STRATEGY_LAB.md`](docs/STRATEGY_LAB.md): strategy catalog, experiment workflow, controls, API examples, and interpretation guidance.
- [`docs/VALIDATION.md`](docs/VALIDATION.md): reproducible evidence, current test results, coverage boundary, and remaining confidence gaps.
- [`docs/roadmap.md`](docs/roadmap.md): prioritized future work, data-quality plan, strategy research plan, and external gates.
- [`docs/architecture/README.md`](docs/architecture/README.md): repository boundaries and dependency direction.
- [`AGENTS.md`](AGENTS.md): project-specific contribution and validation rules for AI-assisted work.

## Production boundary

Setting `NODE_ENV=development` (or `test`) grants the demo actor all roles; any other value, including unset, uses the strict production path. Production expects a managed OIDC identity-aware proxy, same-origin requests, role headers, a 32+ character proxy secret, a 32+ character secret-vault key, and a non-placeholder SEC contact identity. See `.env.example` and [`docs/FEATURES.md`](docs/FEATURES.md) for the full boundary.

Source checkouts resolve the running Git commit automatically. Packaged deployments without `.git` metadata must set `APP_GIT_COMMIT` to the full build commit; builds marked dirty are retained for audit but cannot seed comparable strategy runs.

This software is an experimental paper-trading tool, not legal, tax, or investment advice. Paper results do not establish live performance or fill quality.
