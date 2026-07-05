import { expect, test } from "bun:test";
import {
  RebalanceBasket,
  signRebalanceBasketPreview,
  simulateRebalanceBasket,
  verifyRebalanceBasketPreview,
} from "../../backend/features/orders/rebalance-basket";
import { riskSnapshot } from "../../backend/features/portfolio/risk";

const positions = [
  { symbol: "AAPL", qty: 10, marketValue: 1_000 },
  { symbol: "MSFT", qty: 5, marketValue: 500 },
];

test("validates a bounded basket with one leg per symbol", () => {
  expect(
    RebalanceBasket.parse({
      legs: [
        { symbol: " aapl ", side: "sell", qty: 1 },
        { symbol: "msft", side: "buy", qty: 2 },
      ],
    }).legs[0]?.symbol,
  ).toBe("AAPL");
  expect(
    RebalanceBasket.safeParse({
      legs: [
        { symbol: "AAPL", side: "sell", qty: 1 },
        { symbol: "AAPL", side: "buy", qty: 1 },
      ],
    }).success,
  ).toBeFalse();
  expect(
    RebalanceBasket.safeParse({
      legs: [{ symbol: "AAPL", side: "sell", qty: 1 }],
    }).success,
  ).toBeFalse();
});

test("previews every basket leg against the whole basket", () => {
  const preview = simulateRebalanceBasket({
    snapshot: riskSnapshot(10_000, 8_500, positions),
    positions,
    legs: [
      { symbol: "AAPL", side: "sell", qty: 1, price: 100 },
      { symbol: "MSFT", side: "buy", qty: 2, price: 100 },
    ],
  });
  expect(preview.allowed).toBeTrue();
  expect(preview.summary).toMatchObject({
    buyNotional: 200,
    sellNotional: 100,
    netCashChange: -100,
    resultingCash: 8_400,
  });
  expect(
    preview.legs.every((leg) => leg.simulation.turnoverPercent === 3),
  ).toBeTrue();

  const unsafe = simulateRebalanceBasket({
    snapshot: riskSnapshot(10_000, 100, positions),
    positions,
    legs: [
      { symbol: "AAPL", side: "sell", qty: 1, price: 100 },
      { symbol: "MSFT", side: "buy", qty: 2, price: 100 },
    ],
  });
  expect(unsafe.allowed).toBeFalse();
  expect(unsafe.legs[1]?.simulation.reasons).toContain("Insufficient cash");
});

test("basket preview tokens are signed and expire", () => {
  const secret = "x".repeat(32),
    expiresAt = Date.now() + 1_000;
  const token = signRebalanceBasketPreview(
    {
      legs: [
        { symbol: "AAPL", side: "sell", qty: 1, price: 100 },
        { symbol: "MSFT", side: "buy", qty: 1, price: 200 },
      ],
      timeInForce: "day",
      expiresAt,
    },
    secret,
  );
  expect(verifyRebalanceBasketPreview(token, secret).legs).toHaveLength(2);
  expect(() => verifyRebalanceBasketPreview(`${token}x`, secret)).toThrow();
  expect(() =>
    verifyRebalanceBasketPreview(token, secret, expiresAt + 1),
  ).toThrow("Basket preview expired");
});
