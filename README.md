# AI Broker

AI Broker is a paper-only personal investing workstation built with Bun,
TypeScript, Alpaca, SQLite, and the OpenAI Agents SDK. It combines portfolio
analytics, research, guarded paper-order workflows, and a crypto Strategy Lab
for backtests, shadow runs, and bounded paper experiments.

Live trading is intentionally unavailable. Every broker client is constructed
with `paper: true`. The boundary between the application Alpaca client, the
diagnostic CLI, and the optional upstream MCP project is documented in
[`docs/architecture/alpaca.md`](docs/architecture/alpaca.md).

Code baseline reviewed: `main` at `a2c477c` on 2026-09-06.

## Quick start

Requirements: [Bun 1.2.15](https://bun.sh/) and an Alpaca paper account.
Coverage metrics are runtime-sensitive, so local and CI checks use the pinned
version.

The repository is organized by responsibility:

- `frontend/` contains browser assets.
- `backend/features/` contains product behavior.
- `backend/integrations/` contains provider adapters.
- `backend/persistence/` contains SQLite storage.
- `tests/` mirrors the backend boundaries.
- `scripts/` contains smoke checks and diagnostics.
- `docs/architecture/` explains dependency direction and provider boundaries.

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

`OPENAI_API_KEY` is optional. Without it, deterministic broker, portfolio,
market, research-source, and Strategy Lab features still work; AI Advisor and
generated company analysis return an explicit unavailable response.

Optional provider keys are `FRED_API_KEY`, `BEA_USER_ID`, `FINNHUB_API_KEY`,
and `OPENFIGI_API_KEY`. Production proxy settings, scheduler controls, model
selection, portfolio benchmark, and deployed-build identity are documented in
[`.env.example`](.env.example). Local secrets and SQLite files are ignored by
Git.

Strategy Lab needs Alpaca credentials for the complete real-data-to-paper path.
`SEC_USER_AGENT` is used by SEC research and readiness, not strategy
calculations. `OPENAI_API_KEY` is not used by deterministic backtests, shadow
decisions, or paper-order authorization. Automated tests use controlled
fixtures and never substitute them for an operator-created backtest or shadow
run.

## What is included

- **Account and markets:** Alpaca paper account, positions, orders, activities,
  watchlists, asset search, clock/calendar, IEX market data, company views,
  monitoring alerts, news, and entitled multi-asset snapshots. Missing
  entitlements and missing provider timestamps remain explicit, and cached
  provider retrieval is kept separate from response time.
- **Paper orders:** Equity, linked, basket, short, long-option, defined-risk
  vertical, and crypto tickets. HMAC-signed two-minute previews, fresh-state
  checks, idempotency, reservations, reconciliation, receipts, and the global
  operations policy gate every mutation. Naked option selling is unavailable.
- **Portfolio intelligence:** Performance, FIFO ledger, risk, exposure,
  scenarios, optimizer proposals, and constrained rebalance plans. Stale,
  future, malformed, conflicting, unavailable, or omitted inputs remain
  visible and cannot silently enter a decision.
- **Research and AI:** SEC facts and filings, official macro context,
  Alpaca/Benzinga news, GDELT, optional Finnhub, OpenFIGI, comparable
  valuations, valuation scenarios, company research, portfolio Q&A,
  counter-thesis review, and a receipt-linked trade journal. AI outputs are
  typed, evidence-bound, citation-checked, and unable to create execution
  authority.
- **Strategy Lab:** Twelve deterministic crypto strategies, immutable
  backtests, long-history datasets, walk-forward evaluation, holdouts, regime
  slices, uncertainty, cohort comparison, shadow/scheduled runs, protocol and
  paper-readiness gates, alerts, attribution, reports, and friction
  calibration. Four strategies fail closed at paper boundaries until their
  prospective state/depth inputs match their backtests; three newer strategies
  remain evidence-gated.
- **Operations and UI:** Ordered SQLite migrations, backups, encrypted secret
  envelopes, hash-chained audit records, provider/dataset quality reports,
  reconciliation, selective retention, closed-beta review packets, and a
  responsive dark operator workstation with accessible confirmation dialogs,
  private-value masking, and calculation-level coverage panels.

The application runs as one Bun process with a local SQLite database at
`data/app.db`. Strategy, reconciliation, and retention schedulers are
in-process, so the server must remain running for scheduled work. Detailed
capability contracts and limitations live in [`docs/FEATURES.md`](docs/FEATURES.md).

## Architecture at a glance

- `backend/server.ts` starts the Bun process; `backend/app.ts` composes the
  dependency-injected HTTP application.
- `backend/features/` groups product behavior and route handlers by bounded
  context.
- `backend/integrations/`, `backend/persistence/`, and `backend/shared/`
  isolate provider, storage, and cross-cutting code.
- `frontend/` separates the browser shell, styles, shared utilities, and
  workspace scripts.
- `tests/` mirrors backend boundaries; `scripts/` contains deliberate
  diagnostics and smoke checks.

Feature routes are independently owned, persistence uses ordered migrations,
and the browser is split into shell/style/script assets instead of one inline
client. The current repository inventory is recorded in
[`docs/VALIDATION.md`](docs/VALIDATION.md).

## Quality snapshot

| Boundary | Reviewed state |
| --- | --- |
| Automated checks | Standard and focused safety suites pass; strict TypeScript covers `backend/`, `tests/`, and `scripts/`. |
| Instrumented coverage | The reviewed deterministic-module mean passes the 95% function and 96% line floors. |
| API composition | Primary orders, mutations, option actions, strategy paper execution, recovery, and runtime trade updates are directly covered. |
| Data quality | Provider health, dataset quality, canonical time provenance, reconciliation, provider contracts, and selective retention are implemented; external entitlement review remains separate. |
| Browser | Targeted dark-workstation, responsive, Strategy Lab, option, privacy, keyboard, focus, and closed-beta interaction validation exists. |
| Production | Paper-only; legal, entitlement, closed-beta, restore-drill, and live-deployment gates remain open. |

See [`docs/VALIDATION.md`](docs/VALIDATION.md) for evidence and scope.
Coverage is not application-wide: orchestration, the browser, and process
entry are outside the percentage gate, and credentialed smoke behavior is not
exercised in CI.

Equity and basket paper orders require an explicitly identified IEX trade observed within 60 seconds, checked again at confirmation. Missing, future-dated, or older prices block execution even outside the core market session. This intentionally limits off-hours paper ordering.

## Commands

```sh
bun run check             # strict TypeScript, all tests, and the deterministic coverage floor
bun run eval              # focused broker safety and agent trust-boundary suite
bun run test:browser      # maintained Chromium keyboard/focus interaction suite
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

The Alpaca CLI commands use the Bun dotenv parser and the installed Alpaca CLI
(validated locally with version 0.0.11). The wrapper exposes only `doctor`,
`account get`, `position list`, default-open `order list`, and bounded
`help`/`version` output. It requires APCA credentials for provider diagnostics,
strips inherited CLI profile/live/debug settings, forces paper mode, and rejects
broker mutations, raw API access, profiles, and unknown flags before invoking
the CLI. The separate `smoke:order` command remains an explicit paper-only
mutation check.

Install the browser used by the maintained interaction suite once per local
machine with `bunx playwright install --only-shell chromium`. CI installs only
the required headless Chromium shell and its Linux dependencies before running
`bun run test:browser`; the suite serves committed frontend assets with
isolated API fixtures and does not read `.env`, open SQLite, or contact a
provider.

Run or inspect the bounded read-only reconciliation locally with:

```sh
curl -X POST http://localhost:3000/api/operations/reconciliation
curl http://localhost:3000/api/operations/reconciliation
```

The POST route is admin-only under production proxy authorization. The GET
route is available to operators and admins. `RECONCILIATION_DISABLED=1`
disables only its recurring timer; `RECONCILIATION_POLL_MS` defaults to 900000
milliseconds and values below 60000 are ignored.

Preview or run selective retention pruning locally with:

```sh
curl http://localhost:3000/api/operations/retention
curl -X POST http://localhost:3000/api/operations/retention
```

The GET route is operator/admin readable and reports policy, cutoffs, eligible
counts, lineage protections, and durable run evidence. The POST route is
admin-only. `RETENTION_DISABLED=1` disables only the daily timer;
`RETENTION_POLL_MS` defaults to 86400000 and values below one hour are ignored.
The individual day/hour windows and bounded batch size are documented in
[`.env.example`](.env.example).

Review and export the append-only paper closed-beta packet with:

```sh
curl http://localhost:3000/api/operations/closed-beta-review
curl -OJ http://localhost:3000/api/operations/closed-beta-review/packet
```

The first route returns target, drill, beta-window, incident, and warning
detail; the second downloads the same versioned packet with `no-store`
headers. Operators and admins may read both routes. Admins can attach an
audited supporting record, drill, beta window, or incident through
`POST /api/operations/closed-beta-review/records`, and resolve an existing
incident through
`POST /api/operations/closed-beta-review/incidents/<record-id>/resolve`.
Only records inside the newest recorded beta window count. The packet can
become `ready_for_external_review`; it cannot grant external approval or
live-trading authority.

`SEC_SYMBOL` overrides the default `AAPL` SEC smoke symbol.
`RESEARCH_EVAL_SYMBOLS` overrides the default `AAPL,MSFT,NVDA` live research
evaluation set.

Create and provider/model-free replay a generated company-research report with:

```sh
curl -X POST http://localhost:3000/api/research/runs \
  -H 'content-type: application/json' \
  -d '{"symbol":"AAPL"}'
curl -X POST http://localhost:3000/api/research/runs/<run-id>/replay
```

Creation requires `OPENAI_API_KEY`; replay reads only the persisted generated
output and canonical sources. A legacy run without a replay manifest or any
integrity, identity, source-hash, or deterministic-metric mismatch returns 409.

Create and replay a persisted point-in-time comparable valuation with:

```sh
curl -X POST http://localhost:3000/api/research/valuation-runs \
  -H 'content-type: application/json' \
  -d '{"symbol":"AAPL","peers":["MSFT"],"asOf":"2025-05-15"}'
curl -X POST http://localhost:3000/api/research/valuation-runs/<run-id>/replay
curl -X POST http://localhost:3000/api/research/valuation-runs/<run-id>/scenarios \
  -H 'content-type: application/json' \
  -d '{"scenarios":{"bear":{"revenueGrowthPercent":-10,"netMarginPercent":8,"priceToEarnings":8},"base":{"revenueGrowthPercent":0,"netMarginPercent":10,"priceToEarnings":10},"bull":{"revenueGrowthPercent":10,"netMarginPercent":12,"priceToEarnings":12}}}'
curl -X POST http://localhost:3000/api/research/scenario-runs/<scenario-run-id>/replay
```

The valuation route accepts one subject, one to four distinct peers, and a
real, non-future `YYYY-MM-DD` cutoff. Scenario assumptions remain ordered from
bear through bull. Both replay routes read stored canonical artifacts and do
not call Alpaca or SEC again.

The mutating smoke test is opt-in and paper-only. It creates an unreachable
limit order and cancels the exact returned order ID:

```sh
SMOKE_ORDER=paper-confirm bun run smoke:order
SMOKE_ORDER=paper-confirm SMOKE_SIDE=sell SMOKE_SYMBOL=<owned-symbol> bun run smoke:order
```

## Documentation

- [`docs/FEATURES.md`](docs/FEATURES.md): implemented capabilities, safety, data contracts, and known limitations.
- [`docs/STRATEGY_LAB.md`](docs/STRATEGY_LAB.md): strategy catalog, experiment workflow, controls, API examples, and interpretation guidance.
- [`docs/VALIDATION.md`](docs/VALIDATION.md): reproducible evidence, current test results, coverage boundary, and remaining confidence gaps.
- [`docs/roadmap.md`](docs/roadmap.md): prioritized future work, data-quality plan, strategy research plan, and external gates.
- [`docs/architecture/README.md`](docs/architecture/README.md): repository boundaries and dependency direction.
- [`docs/architecture/alpaca.md`](docs/architecture/alpaca.md): application API/SDK, diagnostic CLI, and optional MCP boundaries.
- [`AGENTS.md`](AGENTS.md): project-specific contribution and validation rules for AI-assisted work.

## Production boundary

Setting `NODE_ENV=development` (or `test`) grants the demo actor all roles; any
other value, including unset, uses the strict production path. Production
expects a managed OIDC identity-aware proxy, same-origin requests, role
headers, a 32+ character proxy secret, a 32+ character secret-vault key, and a
non-placeholder SEC contact identity. See `.env.example` and
[`docs/FEATURES.md`](docs/FEATURES.md) for the full boundary.

Source checkouts resolve the running Git commit automatically. Packaged
deployments without `.git` metadata must set `APP_GIT_COMMIT` to the full build
commit; builds marked dirty are retained for audit but cannot seed comparable
strategy runs.

This software is an experimental paper-trading tool, not legal, tax, or
investment advice. Paper results do not establish live performance or fill
quality.
