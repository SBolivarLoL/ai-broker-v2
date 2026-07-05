import { Alpaca } from "@alpacahq/alpaca-ts-alpha";

if (process.env.SMOKE_ORDER !== "paper-confirm")
  throw new Error(
    "Set SMOKE_ORDER=paper-confirm to run the mutating paper smoke test",
  );

const alpaca = new Alpaca({ paper: true, timeoutMs: 10_000 });
const side = process.env.SMOKE_SIDE === "sell" ? "sell" : "buy";
const symbol = process.env.SMOKE_SYMBOL ?? (side === "sell" ? "TSLA" : "SPY");
const clientOrderId = `smoke-${crypto.randomUUID()}`;
const order = await alpaca.trading.orders.limit({
  symbol,
  qty: 1,
  side,
  limitPrice: side === "buy" ? 0.01 : 1_000_000,
  clientOrderId,
});
if (!order.id) throw new Error("Alpaca accepted no order id");

try {
  const found = await alpaca.trading.orders.getOrderByClientOrderId({
    clientOrderId,
  });
  if (found.id !== order.id)
    throw new Error("Could not reconcile smoke order by client id");
  console.log(`paper order accepted and reconciled: ${order.id}`);
} finally {
  await alpaca.trading.orders.deleteOrderByOrderID({
    orderId: order.id,
  } as never);
  let status = "";
  for (let attempt = 0; attempt < 10 && status !== "canceled"; attempt++) {
    await Bun.sleep(250);
    status =
      (await alpaca.trading.orders.getOrderByClientOrderId({ clientOrderId }))
        .status ?? "";
  }
  if (status !== "canceled")
    throw new Error(
      `Smoke order did not reconcile to canceled (status: ${status})`,
    );
  console.log(`paper order cancelled and reconciled: ${order.id}`);
}
