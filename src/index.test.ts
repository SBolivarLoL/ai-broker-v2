import { expect, test } from "bun:test";
import { quantity } from "./index";

test("accepts only positive finite order quantities", () => {
  expect(quantity("1.5")).toBe(1.5);
  for (const value of ["0", "-1", "nope", "Infinity"]) expect(() => quantity(value)).toThrow();
});
