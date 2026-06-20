import { Alpaca } from "@alpacahq/alpaca-ts-alpha";

if (process.env.SMOKE_ORDER !== "paper-confirm") throw new Error("Set SMOKE_ORDER=paper-confirm to run the mutating paper smoke test");

const alpaca = new Alpaca({ paper: true, timeoutMs: 10_000 });
const clientOrderId = `smoke-${crypto.randomUUID()}`;
const order = await alpaca.trading.orders.limit({ symbol: "SPY", qty: 1, side: "buy", limitPrice: 0.01, clientOrderId });
if (!order.id) throw new Error("Alpaca accepted no order id");

try {
  const found = await alpaca.trading.orders.getOrderByClientOrderId({ clientOrderId });
  if (found.id !== order.id) throw new Error("Could not reconcile smoke order by client id");
  console.log(`paper order accepted and reconciled: ${order.id}`);
} finally {
  await alpaca.trading.orders.deleteOrderByOrderID({ orderId: order.id } as never);
  console.log(`paper order cancelled: ${order.id}`);
}
