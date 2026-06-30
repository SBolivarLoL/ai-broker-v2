# Agent Guidance

These project-specific rules apply to AI-assisted work in `ai-broker-v2`.

## Workflow

- After every feature or fix, create a branch, validate, commit, push, open a PR, wait for CI, merge, then sync `dev` and `main`.
- Keep `main`, `dev`, `origin/main`, and `origin/dev` reconciled after roadmap work unless the user explicitly wants a branch left open.
- Before resuming a persistent `ai-broker-v2` goal, inspect current git state, open PRs, branch sync, and `roadmap.md` instead of relying on prior conversation memory.
- When the user says "continue" or "resume work" on this project, continue from current repo and remote evidence, not from stale assumptions.

## Validation

- Browser or computer-use validation is only for UI changes.
- Backend behavior, strategy logic, order safety, data handling, and API behavior should be tested through unit, regression, system, function, or direct API tests.
- Update `VALIDATION.md` whenever the test count or validation policy meaningfully changes.

## Roadmap And External Gates

- `roadmap.md` is the source of truth for long-running roadmap goals.
- Distinguish between "implemented in code", "documented capability boundary", and "externally approved" when updating roadmap status.
- If a roadmap item is duplicated in multiple sections, reconcile all references in the same change so future audits do not disagree.
- Never mark legal/compliance review, closed beta, or live-trading readiness complete unless authoritative external evidence exists.
- The external gates for this app are legal/compliance review, a real paper closed beta with measured evidence, and live-trading deployment review.

## Safety Bias

- Strategy and paper-trading changes should fail closed: stale data, missing evidence, missing approval, bad audit state, unsupported capability, and incomplete beta evidence should never pass by absence.
