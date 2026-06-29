# Features and rationale
This is the challenge's central explainability file. The product is an internal-advisor prototype connected only to an Alpaca paper account.

## Objective map

| Objective | Implementation | Why it exists |
| --- | --- | --- |
| 1. Connected broker | Live equity, cash, buying power, positions, orders, health and readiness | Proves the paper account is connected and usable |
| 2. Market view | IEX live quotes/bars, company benchmarks, calendar, watchlists, clustered news, corporate actions, options chains and entitlement-aware multi-asset data | Grounds decisions in current, sourced broker data |
| 3. Order ticket | Signed equity, linked, auction, basket, explicit-short and defined-risk option previews with explicit confirmation, idempotency, lifecycle refresh and global operations policy enforcement | Makes paper orders safe and demoable |
| 4. AI functionality | OpenAI Agents SDK Guided Rebalance Agent | Produces useful portfolio-management ideas |
| 5. Portfolio intelligence | Reconciled ledger/snapshots, performance, asset/SIC/factor exposure, VaR/expected shortfall, risk contribution, liquidity, benchmark diagnostics, option Greeks/stress and deterministic what-if simulation | Keeps risk math outside the model |
| 6. Agentic AI | The agent selects among seven read-only Alpaca and risk tools, then stores a plan | Demonstrates bounded multi-tool agency without autonomous execution |
| 7. Creativity | Decision Receipt links evidence, plan, risk checks, approval, Alpaca outcome and hash-chained audit evidence | Makes every recommendation and order inspectable |
| 8. Explainability | This file, evidence IDs, strategy trace explorer, explicit guardrails and runnable checks | Shows how and why each feature works |
| 9. Crypto strategy experiments | Strategy Lab backtests plugin-backed crypto strategies including breakout momentum, volatility filtering, BTC/ETH relative strength and order-book liquidity scouting, creates shadow runs, records manual or scheduled ticks, supports explicitly approved bounded strategy paper crypto market orders with 24/7 crypto session, cash/buying-power, loss, drawdown, turnover and error-cooldown gates, provides standalone signed paper crypto market/limit/stop-limit tickets, persists strategy metrics and local OpenTelemetry-shaped spans, surfaces deterministic alerts, displays run dashboard metrics, active-run performance, post-fill attribution, order-book replay assumptions and filtered decision traces, records review decisions, stores a hash-chained audit trail, and exports experiment reports with assumptions, metrics, reviews, audit evidence and failures | Lets paper experiments run and be audited before any live-trading consideration |

## Data flow and boundaries

`Alpaca data → deterministic risk tools → agent plan → server preview → advisor confirmation → Alpaca paper order → reconciliation → Decision Receipt`

- The agent can read portfolio, risk, price, bars, news, asset/market status and simulations. Portfolio Q&A uses the read-only subset plus open-order status; every returned claim must cite an evidence ID from a typed tool call.
- Company Research includes deterministic bull/base/bear valuation memos from editable user assumptions, directly reported SEC revenue and shares outstanding, and the current Alpaca IEX price; assumptions and derived evidence remain visibly separate.
- Guided Rebalance proposals pass through an independent read-only counter-thesis agent before display. Caution or blocked trades become watch-only, while approved plan drafts bind to one exact quantity market ticket and are revalidated by the normal order boundary.
- The Advisor trade journal links immutable thesis and invalidation text to a real stock-order receipt, records human-classified thesis drift with fresh Alpaca price and position evidence, preserves prior reviews, and audits every journal transition.
- `GET /api/portfolio/exposure` combines Alpaca account cash, position asset classes and IEX daily bars with official SEC submissions SIC classifications. The Portfolio view reports gross and signed net asset-class, SIC-division and SIC-industry exposure plus position-weighted SPY beta, 63-session momentum and annualized 20-session volatility; taxonomy and historical-data coverage gaps remain explicit.
- The agent has no order, cancellation, credential, shell, CLI or raw HTTP tool.
- Alpaca news is untrusted evidence; the prompt forbids following instructions inside it.
- SEC research uses one shared server-side EDGAR client with a declared contact-bearing user agent, response caching, transient retry/backoff and serialized requests below the SEC fair-access ceiling. Latest 10-K/10-Q Risk Factors and MD&A sections are bounded and retain accession, item locator, source URL, truncation state and content hash. Comparable revenue, net income, diluted EPS, assets, liabilities and cash trends use directly reported annual and standalone-quarter observations with exact concept, unit, period, form, filed date, accession and filing URL provenance; no synthetic fourth quarter is inferred.
- `GET /api/research/sec` loads the same official filing, section and trend evidence into the Research workspace without invoking OpenAI; AI analysis remains a separate optional step.
- Company-research sources use one canonical evidence record with provider/source IDs, authority, claim status, normalized timestamps, entity identifiers, canonical URL and deterministic content hash. Exact source IDs, matching URL-plus-content, or same-entity exact content can deduplicate; distinct document sections and fuzzy headline similarity cannot. Source trust labels are visible in the research result.
- `GET /api/research/openfigi` resolves one bounded `TICKER + US + Equity` OpenFIGI v3 job without invoking OpenAI. Public anonymous mapping is serialized below 25 requests per minute; optional `OPENFIGI_API_KEY` authentication is header-only. Venue rows collapse by composite FIGI, company names confirm multi-candidate results, and distinct remaining identities return `ambiguous` without selecting a FIGI. Matched market evidence carries the canonical FIGI; every other state remains visibly symbol-scoped.
- `GET /api/research/comparables` builds a subject-plus-four-peer valuation table from current Alpaca IEX prices and directly reported SEC company facts. Users choose peers explicitly because current entitled metadata cannot justify an automatic industry set. The table shows annual revenue/growth, net margin, derived market capitalization, P/S, diluted P/E and P/B with per-cell periods; official inputs, broker prices and formulas remain separate canonical evidence. Missing, negative or mismatched inputs produce unavailable cells rather than synthetic values.
- Company Research supplements licensed Alpaca/Benzinga articles with a bounded GDELT DOC 2.0 company-name search. Only headlines that identify the company phrase, a distinctive company token or ticker are retained; omitted broad matches are counted. Each retained article is separate `public_web` / `media_signal` canonical evidence with domain, language, source country, publication time and URL; repeated coverage is never treated as event confirmation. Requests are serialized, cached and retried once, while throttling remains an explicit coverage warning and never erases licensed news.
- Optional `FINNHUB_API_KEY` configuration adds free-tier Company Profile 2, the last four provider-reported earnings surprises and a seven-day company-news window. `GET /api/research/finnhub` remains useful without OpenAI and returns an explicit `missing_key` state when unconfigured. Requests use a header so the key never enters URLs, serialize below 60 calls per minute, cache per endpoint, preserve partial results and label profile/earnings as `provider_record` while news stays a `media_signal`; SEC facts remain authoritative.
- `GET /api/research/macro` returns cached official US macro context without invoking OpenAI. Treasury Debt to the Penny and public BLS CPI/unemployment observations work without credentials; optional `FRED_API_KEY` and `BEA_USER_ID` add rates, yield-curve and quarterly real-GDP coverage. Every normalized indicator cites canonical source evidence, CPI year-over-year is visibly calculated from official index observations, provider failures remain partial and explicit, and regime labels are deterministic descriptive thresholds rather than predictions.
- Portfolio monitoring checks up to 12 held/watchlist symbols for supported 8-K items filed in the previous 14 days. Deterministic item labels and severity order drive alerts; each alert retains a bounded primary-document excerpt, content hash, accession, filed/report dates, official document/index links and explicit portfolio/watchlist scope. Item 9.01 is supporting evidence rather than a standalone alert, and no filing sentiment is inferred.
- A deterministic output guardrail rejects invented evidence IDs, certainty claims, and actionable quantities unless an opaque simulation authority exactly matches the idea's symbol, side, quantity, policy version, state snapshot and expiry.
- The server is the only order boundary. A browser confirmation alone is never sufficient.
- A persisted global operations policy can activate an app-wide kill switch and enforce order-notional, symbol-exposure, portfolio-exposure and turnover caps across equity, basket, option, crypto and approved strategy paper orders.
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
- The operations guardrail panel exposes the current global kill-switch state, caps and runbook evidence. Kill-switch activation requires a reason and is rechecked at confirmation, so old signed previews cannot bypass it.
- Receipts and agent plans append to a global hash-chained decision audit log. `GET /api/receipts/{id}/audit` returns subject evidence; `GET /api/decision-audit` verifies the global chain.
- Operations evidence endpoints expose production-readiness artifacts: `GET /api/operations/readiness`, `POST /api/operations/backup`, `GET /api/operations/observability-export`, and `GET /api/operations/incident-packet`.
- Production authorization uses the trusted OIDC proxy identity plus `viewer`, `researcher`, `trader`, `operator` and `admin` roles. Sensitive operations and secret-vault endpoints require elevated roles.
- `GET/POST/DELETE /api/operations/secrets` stores AES-256-GCM encrypted secret envelopes and exposes metadata only. `SECRET_VAULT_KEY` is required for production readiness.
- `GET /api/operations/data-governance` records the current market-data, news, crypto and derived-analytics source review with subscription status, restrictions, evidence URLs and live-promotion blockers.
- `GET /api/operations/production-governance` records the compliance review packet, paper closed-beta safety targets and live-trading hard blocker. External legal/compliance signoff and measured beta evidence remain open gates.
- The Home operations panel uses `GET /api/operations/closed-beta-evidence` to show `pass`, `fail` or `needs_evidence` for every beta safety target from persisted receipts, decision-audit verification, strategy decisions, review history, operations events and backup metadata. Missing observations never pass by absence.
- Submission requires a unique idempotency key; duplicates return the original result or a processing response.
- A lost placement response is recovered by Alpaca `clientOrderId`; a retry reservation is released only when Alpaca confirms no matching order.
- Paper trading is hard-coded. Live mode is unavailable.
- Option execution is limited to long buy-to-open single legs and net-debit verticals. Naked selling is unavailable; previews show max loss, exercise cost and short-leg assignment notional.
- Rebalance baskets are atomically previewed and reserved inside the app, then submitted sequentially because Alpaca exposes no atomic equity-basket endpoint.
- Production refuses readiness unless a managed OIDC proxy origin, email domain, 32+ character proxy secret, 32+ character secret-vault key and non-placeholder SEC contact identity are configured. Mutations are same-origin, request bodies are bounded, broker DTOs are allow-listed, browser output is escaped, and money/agent routes are rate-limited per advisor.

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
- `bun run smoke:sec` verifies declared-identity SEC submissions/archive access, bounded 10-K/10-Q section extraction, accession-linked annual/quarterly XBRL trend normalization and current 8-K item extraction without invoking OpenAI.
- `bun run smoke:macro` verifies live Treasury and BLS coverage, canonical macro evidence and citation integrity; configured FRED and BEA credentials become required live checks.
- `bun run smoke:gdelt` verifies live canonical article evidence when the public API responds, or the explicit no-false-absence fallback when GDELT returns its documented HTTP 429 throttle.
- `bun run smoke:finnhub` verifies the no-network missing-key fallback, or live free-tier profile/earnings/news evidence and trust labels when `FINNHUB_API_KEY` is configured.
- `bun run smoke:openfigi` verifies a live AAPL v3 identity mapping and canonical FIGI evidence, or the explicit rate-limit fallback that forbids an assumed join.
- `bun run smoke:comparables` verifies live AAPL/MSFT SEC inputs, Alpaca prices, derived valuation rows and all three evidence authority classes.
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
8. Open the Strategy Lab, run a crypto backtest, tick or schedule a shadow run, approve a small paper run, review dashboard metrics, active-run performance and post-fill attribution, filter decisions, inspect the trace, save an experiment review, and export the experiment report.
9. Open the Decision Receipt and this objective map.

For detailed Strategy Lab operating instructions, see `STRATEGY_LAB.md`.
