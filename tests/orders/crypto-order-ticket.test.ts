import { expect, test } from "bun:test";
import {
  buildCryptoOrderPreview,
  cryptoOrderMarketFromSnapshot,
  CryptoOrderTicket,
  signCryptoOrderPreview,
  verifyCryptoOrderPreview,
} from "../../backend/features/orders/crypto-order-ticket";

test("validates supported paper crypto order ticket combinations", () => {
  expect(
    CryptoOrderTicket.parse({ symbol: "btc/usd", side: "buy", notional: "50" }),
  ).toMatchObject({
    symbol: "BTC/USD",
    type: "market",
    amountType: "notional",
    notional: 50,
    timeInForce: "gtc",
  });
  expect(
    CryptoOrderTicket.parse({
      symbol: "ETH/USD",
      side: "buy",
      type: "limit",
      amountType: "quantity",
      qty: "0.1",
      limitPrice: "3000",
      timeInForce: "ioc",
    }),
  ).toMatchObject({ type: "limit", qty: 0.1, limitPrice: 3000 });
  expect(
    CryptoOrderTicket.parse({
      symbol: "SOL/USD",
      side: "sell",
      type: "stop_limit",
      amountType: "quantity",
      qty: 2,
      stopPrice: 130,
      limitPrice: 129,
    }),
  ).toMatchObject({ type: "stop_limit" });
  expect(() =>
    CryptoOrderTicket.parse({ symbol: "DOGE/USD", side: "buy", notional: 10 }),
  ).toThrow();
  expect(() =>
    CryptoOrderTicket.parse({
      symbol: "BTC/USD",
      side: "sell",
      amountType: "notional",
      notional: 10,
    }),
  ).toThrow();
  expect(() =>
    CryptoOrderTicket.parse({
      symbol: "BTC/USD",
      side: "buy",
      type: "limit",
      amountType: "notional",
      notional: 10,
      limitPrice: 50_000,
    }),
  ).toThrow();
  expect(() =>
    CryptoOrderTicket.parse({
      symbol: "BTC/USD",
      side: "buy",
      type: "stop_limit",
      amountType: "quantity",
      qty: 0.01,
      limitPrice: 50_000,
    }),
  ).toThrow();
});

test("builds an allowed notional market buy preview with spread and quantity estimates", () => {
  const market = cryptoOrderMarketFromSnapshot({
    quote: { bid: 49_900, ask: 50_100 },
    trade: { price: 50_020 },
  });
  const result = buildCryptoOrderPreview({
    ticket: CryptoOrderTicket.parse({
      symbol: "BTC/USD",
      side: "buy",
      amountType: "notional",
      notional: 100,
    }),
    market,
    cash: 500,
    heldQty: 0,
    now: 1_000,
  });
  expect(result.allowed).toBe(true);
  if (!result.allowed) throw new Error("expected preview");
  expect(result.preview.referencePrice).toBe(50_000);
  expect(result.preview.spreadBps).toBe(40);
  expect(result.preview.estimatedQty).toBeCloseTo(0.002);
  expect(result.preview.estimatedNotional).toBe(100);
  expect(result.preview.expiresAt).toBe(121_000);
});

test("blocks risky crypto order previews before signing", () => {
  const wideMarket = cryptoOrderMarketFromSnapshot({
    quote: { bid: 90, ask: 110 },
  });
  expect(
    buildCryptoOrderPreview({
      ticket: CryptoOrderTicket.parse({
        symbol: "SOL/USD",
        side: "buy",
        amountType: "notional",
        notional: 50,
      }),
      market: wideMarket,
      cash: 500,
      heldQty: 0,
    }),
  ).toMatchObject({ allowed: false, reasons: ["spread_limit"] });

  const market = cryptoOrderMarketFromSnapshot({
    quote: { bid: 99, ask: 101 },
  });
  expect(
    buildCryptoOrderPreview({
      ticket: CryptoOrderTicket.parse({
        symbol: "SOL/USD",
        side: "buy",
        amountType: "notional",
        notional: 3_000,
      }),
      market,
      cash: 5_000,
      heldQty: 0,
    }),
  ).toMatchObject({ allowed: false, reasons: ["max_order_notional"] });

  expect(
    buildCryptoOrderPreview({
      ticket: CryptoOrderTicket.parse({
        symbol: "SOL/USD",
        side: "sell",
        amountType: "quantity",
        qty: 2,
      }),
      market,
      cash: 5_000,
      heldQty: 1,
    }),
  ).toMatchObject({ allowed: false, reasons: ["position_limit"] });
});

test("signs, verifies and expires crypto order preview tokens", () => {
  const result = buildCryptoOrderPreview({
    ticket: CryptoOrderTicket.parse({
      symbol: "ETH/USD",
      side: "buy",
      type: "limit",
      amountType: "quantity",
      qty: 0.05,
      limitPrice: 3_000,
    }),
    market: cryptoOrderMarketFromSnapshot({
      quote: { bid: 3_020, ask: 3_022 },
    }),
    cash: 1_000,
    heldQty: 0,
    now: 10,
  });
  if (!result.allowed) throw new Error("expected preview");
  const secret = "0123456789abcdef0123456789abcdef";
  const token = signCryptoOrderPreview(result.preview, secret);
  expect(verifyCryptoOrderPreview(token, secret, 20)).toMatchObject({
    symbol: "ETH/USD",
    type: "limit",
    estimatedNotional: 150,
  });
  expect(() => verifyCryptoOrderPreview(token, secret, 120_011)).toThrow(
    "Crypto order preview expired",
  );
});
