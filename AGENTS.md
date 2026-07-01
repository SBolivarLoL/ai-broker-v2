# Agent Guidance

These project-specific rules apply to AI-assisted work in `ai-broker-v2`.

## Delivery workflow

- Start each coherent feature, fix, or documentation change from a current, clean `main` branch.
- Create a branch, validate the affected behavior, commit intentionally, push, open a pull request, wait for CI, merge, then reconcile `main`, `dev`, `origin/main`, and `origin/dev`.
- Before resuming work, inspect Git status, remote branches, open pull requests, recent commits, and `roadmap.md`. Current repository evidence overrides conversation memory.
- Do not mix unrelated cleanup into a feature branch or revert work that is already present.

## Documentation ownership

- `README.md` is the onboarding and command reference.
- `FEATURES.md` describes behavior that exists now, including capability boundaries and known limitations.
- `STRATEGY_LAB.md` is the operator guide for strategy experiments.
- `VALIDATION.md` records reproducible checks and confidence gaps.
- `roadmap.md` is the only future-work inventory. Do not create another later-features or future-improvements list.
- Update all affected documents in the same change when a command, environment variable, endpoint, test count, capability, limitation, or roadmap status changes.
- Use status language precisely: `implemented` means code exists; `validated` means named evidence passed; `externally approved` requires authoritative external evidence.

## Validation

- Backend calculations, strategy behavior, order safety, persistence, authorization, data normalization, and API contracts are validated through unit, regression, system, function, or direct API tests.
- Browser or computer-use validation is reserved for UI rendering, layout, accessibility, responsive behavior, and interaction wiring.
- Add a direct API test when changing route parsing, authorization, status codes, response shapes, or error handling.
- Keep `bun run check` green against the reviewed 95% function and 96% line coverage floor for imported deterministic and request-layer TypeScript.
- Update `VALIDATION.md` when the test count, coverage boundary, live-smoke status, or validation policy changes.
- Never describe coverage as application-wide when `src/server.ts` or the browser client is outside instrumentation.

## Roadmap and external gates

- Reconcile duplicated roadmap references in the same change.
- A design, schema, checklist, or report endpoint is not proof that an operational process has happened.
- Never mark legal/compliance review, a real paper closed beta, backup restore drills, or live-trading readiness complete without the corresponding external or measured evidence.
- Live trading remains unavailable until legal/compliance review, data-entitlement review, paper-beta evidence, and a separate deployment review are complete.

## Safety bias

- Strategy and paper-order changes fail closed on stale or missing data, invalid configuration, incomplete approval, policy failure, ambiguous identity, broken audit evidence, and unsupported capability.
- Keep calculations deterministic and testable. Agents may explain and draft, but cannot create execution authority or bypass signed preview and confirmation.
- Preserve source, feed, observation time, retrieval time, assumptions, and missing-data state in derived financial output.
