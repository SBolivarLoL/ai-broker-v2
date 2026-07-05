import { expect, test } from "bun:test";
import { requestJson } from "../../backend/http/http";

test("requestJson accepts bounded JSON and rejects malformed or oversized bodies", async () => {
  const valid = new Request("http://localhost/api", {
    method: "POST",
    body: JSON.stringify({ enabled: true }),
  });
  expect(await requestJson(valid)).toEqual({ enabled: true });

  const malformed = new Request("http://localhost/api", {
    method: "POST",
    body: "{",
  });
  await expect(requestJson(malformed)).rejects.toEqual(
    expect.objectContaining({
      message: "Request body must be valid JSON",
      status: 400,
    }),
  );

  const oversized = new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-length": "16385" },
  });
  await expect(requestJson(oversized)).rejects.toEqual(
    expect.objectContaining({
      message: "Request body is too large",
      status: 413,
    }),
  );
});
