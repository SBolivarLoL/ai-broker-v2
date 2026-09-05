import { expect, test } from "bun:test";
import { getOrderPrice, assertFreshOrderPrice, type OrderPriceEvidence } from "../../backend/features/orders/market-price";

const now = new Date("2026-09-05T14:00:00Z");
const evidence: OrderPriceEvidence = {symbol:"SPY",price:100,source:"Alpaca latest stock trade",feed:"iex",observedAt:now.toISOString(),retrievedAt:now.toISOString(),maxAgeSeconds:60};

test("order price preserves IEX provider identity and separate observation/retrieval times",async()=>{
 const observed=new Date(now.getTime()-60_000);
 const calls:unknown[]=[];
 const result=await getOrderPrice({stocks:{stockLatestTradeSingle:async(input:unknown)=>{calls.push(input);return{symbol:"SPY",trade:{p:100,t:observed}};}}} as any,"SPY",()=>now);
 expect(calls).toEqual([{symbol:"SPY",feed:"iex"}]);
 expect(result.time).toMatchObject({observationTime:observed.toISOString(),retrievalTime:now.toISOString(),publicationTime:null,effectivePeriod:null});
 expect(result.price).toBe(100);
 expect(()=>assertFreshOrderPrice(result,new Date(now.getTime()+1))).toThrow("60 seconds");
});

test("invalid clock, provenance and retrieval drift never authorize an order",()=>{
 for(const [value,at] of [
  [evidence,new Date(NaN)],
  [{...evidence,price:NaN},now],
  [{...evidence,retrievedAt:new Date(now.getTime()-1).toISOString()},now],
  [{...evidence,retrievedAt:new Date(now.getTime()+1).toISOString()},now],
 ] as const) expect(()=>assertFreshOrderPrice(value,at)).toThrow("60 seconds");
});

test("malformed trade timestamps and missing payloads fail closed; provider errors propagate",async()=>{
 for(const response of [null,{}, {symbol:"SPY",trade:{p:100,t:"invalid"}}, {symbol:"SPY",trade:{p:100,t:0}}]) {
  await expect(getOrderPrice({stocks:{stockLatestTradeSingle:async()=>response}} as any,"SPY",()=>now)).rejects.toThrow("missing or invalid");
 }
 await expect(getOrderPrice({stocks:{stockLatestTradeSingle:async()=>{throw new Error("provider unavailable");}}} as any,"SPY",()=>now)).rejects.toThrow("provider unavailable");
});
