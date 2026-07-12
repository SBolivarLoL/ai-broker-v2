# Agent Guidance

These project-specific rules apply to AI-assisted work in `ai-broker-v2`.

Review baseline: `main` at `a10f8f6` on 2026-07-12.

## Delivery workflow

- Start each coherent feature, fix, or documentation change from a current, clean `main` branch.
- Create a branch, validate the affected behavior, commit intentionally, push, open a pull request, wait for CI, merge, then reconcile `main`, `dev`, `origin/main`, and `origin/dev`.
- Before resuming work, inspect Git status, remote branches, open pull requests, recent commits, and `docs/roadmap.md`. Current repository evidence overrides conversation memory.
- Do not mix unrelated cleanup into a feature branch or revert work that is already present.

## Documentation ownership

- `README.md` is the onboarding and command reference.
- `docs/FEATURES.md` describes behavior that exists now, including capability boundaries and known limitations.
- `docs/STRATEGY_LAB.md` is the operator guide for strategy experiments.
- `docs/VALIDATION.md` records reproducible checks and confidence gaps.
- `docs/roadmap.md` is the only future-work inventory. Do not create another later-features or future-improvements list.
- `docs/architecture/` owns repository and system-boundary documentation.
- Update all affected documents in the same change when a command, environment variable, endpoint, test count, capability, limitation, or roadmap status changes.
- Use status language precisely: `implemented` means code exists; `validated` means named evidence passed; `externally approved` requires authoritative external evidence.
- Derive counts, file sizes, migration state, provider inventory, and test evidence from the repository or a fresh command; do not carry them forward from memory.

## Repository orientation

- `backend/server.ts` owns process startup; `backend/app.ts` owns dependency-injected HTTP composition.
- `backend/features/` groups bounded contexts, `backend/integrations/` owns provider adapters, and `backend/persistence/migrations.ts` is the append-only schema registry.
- `frontend/` owns browser assets; `tests/` mirrors backend boundaries; `scripts/` contains deliberate diagnostics and smoke checks.
- Prefer bounded contexts such as `strategies/`, `orders/`, `portfolio/`, `research/`, and `operations/` over a generic catch-all `domain/` or `utils/` directory.

## Validation

- Backend calculations, strategy behavior, order safety, persistence, authorization, data normalization, and API contracts are validated through unit, regression, system, function, or direct API tests.
- Browser or computer-use validation is reserved for UI rendering, layout, accessibility, responsive behavior, and interaction wiring.
- Add a direct API test when changing route parsing, authorization, status codes, response shapes, or error handling.
- Add an append-only migration and historical upgrade/restore fixture for every schema change; never rewrite an applied migration identity or checksum.
- Keep `bun run check` green against the reviewed 95% function and 96% line mean for deterministic modules; route and runtime orchestration require direct contract tests.
- `tsconfig.json` includes `backend/`, `tests/`, and `scripts/`; keep operational scripts inside the standard strict check. Credentialed or mutating smoke execution remains deliberate and opt-in.
- Update `docs/VALIDATION.md` when the test count, coverage boundary, live-smoke status, or validation policy changes.
- Never describe coverage as application-wide when orchestration, `backend/server.ts`, or the browser client is outside the percentage gate.
- When adding a provider or persisted output, update `backend/features/operations/data-governance.ts`; every SQLite table must belong to exactly one stored-output category with retention, redistribution, and live-use decisions.

## Roadmap and external gates

- Reconcile duplicated roadmap references in the same change.
- A design, schema, checklist, or report endpoint is not proof that an operational process has happened.
- Never mark legal/compliance review, a real paper closed beta, backup restore drills, or live-trading readiness complete without the corresponding external or measured evidence.
- Live trading remains unavailable until legal/compliance review, data-entitlement review, paper-beta evidence, and a separate deployment review are complete.

## Safety bias

- Strategy and paper-order changes fail closed on stale or missing data, invalid configuration, incomplete approval, policy failure, ambiguous identity, broken audit evidence, and unsupported capability.
- Keep calculations deterministic and testable. Agents may explain and draft, but cannot create execution authority or bypass signed preview and confirmation.
- Preserve source, feed, observation time, retrieval time, assumptions, and missing-data state in derived financial output.
