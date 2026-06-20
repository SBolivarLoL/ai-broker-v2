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
