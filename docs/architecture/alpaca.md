# Alpaca integration boundaries

AI Broker has three separate Alpaca related boundaries. Keeping them separate
prevents a diagnostic command or an external model tool from becoming an
application order authority.

## Application API and SDK

The running application uses the Alpaca TypeScript SDK through adapters under
`backend/integrations/alpaca/`. `backend/server.ts` constructs those
dependencies, while feature routes own validation, freshness checks, policy,
reservations, persistence, and audit. Broker clients are constructed with
`paper: true`; there is no live-client switch. Interactive order workflows can
submit a paper order only after their signed preview, human confirmation,
fresh broker and market revalidation, idempotency, risk reservation, and
receipt/audit path all succeed. Approved strategy automation follows its
separate pre-registered protocol and server-owned readiness controls before
submitting bounded paper crypto market orders. Agents can retrieve typed
evidence and draft an action, but they cannot call either execution path.

The SDK boundary is the source for application account, market, research, and
paper-order operations. SDK calls remain direct where an integration does not
need translation; focused adapters and feature response builders normalize
provider semantics where contracts require it. Observation, publication,
effective-period, retrieval, and server response times remain distinct, and
missing or stale evidence fails closed.

The installed `alpaca-ts-alpha` ergonomic historical-bar helpers, including
`getStockBarsFor`, already follow provider page tokens and return canonical
bar series. Application code uses those helpers directly; it does not add a
second pagination loop or an SDK-wide wrapper. Small evidence adapters remain
where a route needs source, freshness, or coverage metadata around the SDK
result.

## Diagnostic CLI

The repository's `scripts/alpaca.sh` launcher runs the installed [Alpaca CLI](https://github.com/alpacahq/cli)
through Bun's dotenv parser. The checked command surface is intentionally
small: `doctor`, `account get`, `position list`, `order list` (including the
default-open `--status open` form), and bounded help/version output. Provider
diagnostics require `APCA_API_KEY_ID` and `APCA_API_SECRET_KEY`; the launcher
maps them to the CLI's `ALPACA_API_KEY` and `ALPACA_SECRET_KEY`, strips
inherited Alpaca profile/live/debug and application secret variables, and sets
`ALPACA_LIVE_TRADE=false`.

Order submission, replacement, cancellation, position closing, raw API access,
profile commands, arbitrary flags, and unknown commands are rejected before
the CLI process starts. The CLI is therefore a read-only diagnostic aid; its
output does not create previews, approvals, receipts, or execution authority.
The installed CLI version checked for this repository is 0.0.11. The separate
`smoke:order` script is an explicit, opt-in paper mutation drill and does not
use the diagnostic wrapper.

## Optional upstream MCP server

[Alpaca's official MCP server](https://github.com/alpacahq/alpaca-mcp-server)
is a separate external integration. Its current v2 is a rewrite: v1 tool
names, parameters, and schemas are not a drop-in configuration for v2. The
server's default `ALPACA_TOOLSETS` value enables all toolsets, including
trading and other mutations. An external user who connects it to an assistant
should set an explicit data-only allow-list such as
`assets,stock-data,crypto-data,options-data,news,corporate-actions` and leave
the `trading` and watchlist mutation toolsets out until a separately reviewed
authority boundary exists.

MCP credentials use `ALPACA_API_KEY` and `ALPACA_SECRET_KEY`. Its paper switch
is `ALPACA_PAPER_TRADE=true`; this differs from the diagnostic CLI's forced
`ALPACA_LIVE_TRADE=false` and from the application's hard-coded SDK
`paper: true`. MCP is not installed or integrated in this repository. If it is
used externally, its v2 configuration must be treated as a separate client
with separately reviewed permissions; MCP tool output cannot bypass this
application's preview, policy, confirmation, freshness, reservation, and audit
pipeline.

For the upstream v2 migration details, configuration, and toolset list, see
the [official MCP server documentation](https://github.com/alpacahq/alpaca-mcp-server#upgrading-from-v1).
