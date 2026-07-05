# AI Broker

AI Broker is a paper-only personal investing workstation built with Bun, TypeScript, Alpaca, SQLite, and the OpenAI Agents SDK. It combines portfolio analytics, research, guarded paper-order workflows, and a crypto Strategy Lab for backtests, shadow runs, and bounded paper experiments.

Live trading is intentionally unavailable. Every broker client is constructed with `paper: true`.

Code baseline reviewed: `main` at `352c26c` on 2026-07-05.

## Quick start

Requirements: [Bun 1.2.15](https://bun.sh/) and an Alpaca paper account. Coverage metrics are runtime-sensitive, so local and CI checks use the pinned version.

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

- Alpaca paper account, positions, orders, activities, watchlists, market clock, calendar, and IEX market data.
- Signed equity, linked, basket, short, option, and crypto paper-order previews with fresh-state confirmation, idempotency, receipts, and global operations policy.
- Portfolio performance, FIFO ledger, risk, exposure, scenarios, optimizer proposals, and constrained rebalance planning.
- SEC filings and company facts, official US macro context, Alpaca/Benzinga news, GDELT signals, optional Finnhub enrichment, and OpenFIGI identity checks.
- Evidence-bound portfolio Q&A, company research, valuation scenarios, counter-thesis review, and trade journal.
- Immutable crypto backtests linked to shadow and scheduled runs, bounded approved paper experiments, exact dataset/code provenance, trace reconstruction, alerts, attribution, and reports.
- SQLite persistence with ordered transactional migrations, hash-chained decision records, serialized backups, encrypted secret envelopes, readiness exports, paper-beta evidence reporting, and a source/output governance registry.

The application currently runs as one Bun process with a local SQLite database at `data/app.db`. The scheduler is in-process, so the server must remain running for scheduled strategy ticks.

## Architecture at a glance

- `src/server.ts` starts the Bun process, Alpaca streams, and scheduler.
- `src/app.ts` builds the dependency-injected request handler and API composition.
- Focused `src/*.ts` modules own deterministic domain behavior; tests remain beside them.
- `src/migrations.ts` and `src/store.ts` own the current SQLite schema and repositories.
- `src/index.html` contains the current browser application.

The reviewed tree has 59 production TypeScript modules, 62 test files, 13 migrations, and 21 SQLite tables. The main concentration points are the 2,488-line request module, 782-line store, and 255,758-byte single-file browser client. The incremental bounded-context target and move order live in `roadmap.md`; no directory move is required to contribute safely today.

## Quality snapshot

| Boundary | Reviewed state |
| --- | --- |
| Automated checks | 251 tests and 978 assertions pass; strict TypeScript covers `src/` and `scripts/` |
| Instrumented coverage | 95.60% functions and 96.60% lines across imported TypeScript |
| API composition | Common auth, parsing, error, strategy, and system contracts exist; broker-backed success and concurrency coverage remain incomplete |
| Browser | Targeted Strategy Lab interaction validation exists; no maintained accessibility/responsive regression suite |
| Persistence | Transactional migrations through 0013 and a serialized fixture restore pass |
| Production | Paper-only; legal, entitlement, closed-beta, restore-drill, and live-deployment gates remain open |

See [`VALIDATION.md`](VALIDATION.md) for evidence and scope. Aggregate coverage is not application-wide: the browser and process entry are outside it, and credentialed smoke behavior is not exercised in CI.

## Commands

```sh
bun run check             # strict TypeScript for src/scripts, all tests, and coverage floor
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

The mutating smoke test is opt-in and paper-only. It creates an unreachable limit order and cancels the exact returned order ID:

```sh
SMOKE_ORDER=paper-confirm bun run smoke:order
SMOKE_ORDER=paper-confirm SMOKE_SIDE=sell SMOKE_SYMBOL=<owned-symbol> bun run smoke:order
```

## Documentation

- [`FEATURES.md`](FEATURES.md): implemented capabilities, architecture, safety, data contracts, and known limitations.
- [`STRATEGY_LAB.md`](STRATEGY_LAB.md): strategy catalog, experiment workflow, controls, API examples, and interpretation guidance.
- [`VALIDATION.md`](VALIDATION.md): reproducible evidence, current test results, coverage boundary, and remaining confidence gaps.
- [`roadmap.md`](roadmap.md): prioritized future work, data-quality plan, strategy research plan, external gates, and repository structure proposal.
- [`AGENTS.md`](AGENTS.md): project-specific contribution and validation rules for AI-assisted work.

## Production boundary

Local development grants the demo actor all roles. Production expects a managed OIDC identity-aware proxy, same-origin requests, role headers, a 32+ character proxy secret, a 32+ character secret-vault key, and a non-placeholder SEC contact identity. See `.env.example` and `FEATURES.md` for the full boundary.

Source checkouts resolve the running Git commit automatically. Packaged deployments without `.git` metadata must set `APP_GIT_COMMIT` to the full build commit; builds marked dirty are retained for audit but cannot seed comparable strategy runs.

This software is an experimental paper-trading tool, not legal, tax, or investment advice. Paper results do not establish live performance or fill quality.
