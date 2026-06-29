import { expect, test } from "bun:test";
import { decryptSecretValue, encryptSecretValue, secretMetadata } from "./secret-vault";

const key = "abcdefghijklmnopqrstuvwxyz123456";

test("encrypts and decrypts secret values without storing plaintext", () => {
  const envelope = encryptSecretValue("alpaca-secret-value", key, new Date("2026-06-26T10:00:00.000Z"));
  expect(envelope).toMatchObject({ algorithm: "aes-256-gcm", createdAt: "2026-06-26T10:00:00.000Z" });
  expect(JSON.stringify(envelope)).not.toContain("alpaca-secret-value");
  expect(decryptSecretValue(envelope, key)).toBe("alpaca-secret-value");
  expect(() => decryptSecretValue(envelope, "wrong-secret-key-wrong-secret-key-1234")).toThrow("Secret vault key does not match");
});

test("exposes only encrypted secret metadata", () => {
  const envelope = encryptSecretValue("openai-secret-value", key, new Date("2026-06-26T10:00:00.000Z"));
  expect(secretMetadata("OPENAI_API_KEY", envelope, "admin@example.com")).toMatchObject({
    name: "OPENAI_API_KEY",
    algorithm: "aes-256-gcm",
    updatedBy: "admin@example.com",
  });
  expect(secretMetadata("OPENAI_API_KEY", envelope).ciphertextBytes).toBeGreaterThan(0);
});
