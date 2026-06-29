# AI Broker

Minimal Alpaca paper-trading foundation for the Quant Competitions AI Broker Hackathon.

```sh
bun install
cp .env.example .env # add Alpaca paper credentials
bun start # open http://localhost:3000
```

`paper: true` is hard-coded. Live trading is intentionally unavailable.
Production access is expected behind a managed OIDC identity-aware proxy; see `.env.example` for its required verified-header settings.
Use the browser for previewed trades and the official Alpaca CLI through `scripts/alpaca.sh` for low-level diagnostics.

Checks:

```sh
bun run check
bun run eval
bun run alpaca:doctor
bun run smoke:read
# Explicitly opt in; creates and immediately cancels one $0.01 SPY paper limit order:
SMOKE_ORDER=paper-confirm bun run smoke:order
# To verify sell routing, choose a symbol held in the paper account:
SMOKE_ORDER=paper-confirm SMOKE_SIDE=sell SMOKE_SYMBOL=TSLA bun run smoke:order
```

See `FEATURES.md` for the objective map, safety model, and demo script.
See `STRATEGY_LAB.md` for how to run crypto strategy backtests, shadow runs, ticks, traces, and receipts.
See `VALIDATION.md` for the requirement-by-requirement completion evidence and production boundary.
See `roadmap.md` for the Alpaca capability inventory and phased product roadmap.
See `future-improvements.md` for measured, low-impact optimizations that are intentionally deferred.
