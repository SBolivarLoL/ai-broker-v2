import { Alpaca } from "@alpacahq/alpaca-ts-alpha";

export function quantity(value: string) {
  const qty = Number(value);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("Quantity must be greater than zero");
  return qty;
}

if (import.meta.main) {
  const [command, rawSymbol, rawQty, confirmation] = process.argv.slice(2);
  const symbol = rawSymbol?.toUpperCase();
  const alpaca = new Alpaca({ paper: true, timeoutMs: 10_000 });

  if (command === "account") {
    console.log(await alpaca.trading.account.getAccount());
  } else if (command === "quote" && symbol) {
    console.log({ symbol, price: await alpaca.marketData.getLatestPrice(symbol) });
  } else if ((command === "buy" || command === "sell") && symbol && rawQty) {
    if (confirmation !== "--confirm") throw new Error("Paper order not sent. Add --confirm");
    console.log(await alpaca.trading.orders.market({ symbol, qty: quantity(rawQty), side: command }));
  } else {
    console.log("Usage: bun start <account|quote SYMBOL|buy SYMBOL QTY --confirm|sell SYMBOL QTY --confirm>");
  }
}
