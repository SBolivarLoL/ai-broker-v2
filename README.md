# AI Broker

Minimal Alpaca paper-trading foundation for the Quant Competitions AI Broker Hackathon.

```sh
bun install
cp .env.example .env # add Alpaca paper credentials
bun start # open http://localhost:3000
bun cli account
bun cli quote AAPL
bun cli buy AAPL 1 --confirm
bun cli sell AAPL 1 --confirm
```

`paper: true` is hard-coded. Live trading is intentionally unavailable.

Checks:

```sh
bun run check
bun run eval
bun run alpaca:doctor
bun run smoke:read
```

See `FEATURES.md` for the objective map, safety model, and demo script.
