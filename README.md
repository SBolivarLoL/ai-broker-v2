# AI Broker

Minimal Alpaca paper-trading foundation for the Quant Competitions AI Broker Hackathon.

```sh
bun install
cp .env.example .env # add Alpaca paper credentials
bun start account
bun start quote AAPL
bun start buy AAPL 1 --confirm
bun start sell AAPL 1 --confirm
```

`paper: true` is hard-coded. Live trading is intentionally unavailable.

