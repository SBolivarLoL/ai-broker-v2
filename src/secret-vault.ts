import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";

export const SecretName = z.string().trim().regex(/^[A-Z0-9_./:-]{2,120}$/i);

export const EncryptedSecret = z.object({
  algorithm: z.literal("aes-256-gcm"),
  keyDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  iv: z.string().min(16),
  tag: z.string().min(16),
  ciphertext: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type EncryptedSecret = z.infer<typeof EncryptedSecret>;

function keyMaterial(secretKey: string) {
  if (secretKey.length < 32) throw new Error("SECRET_VAULT_KEY must be at least 32 characters");
  return createHash("sha256").update(secretKey).digest();
}

function keyDigest(secretKey: string) {
  return `sha256:${createHash("sha256").update(`vault:${secretKey}`).digest("hex")}`;
}

export function encryptSecretValue(value: string, secretKey: string, now = new Date()): EncryptedSecret {
  if (!value) throw new Error("Secret value is required");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyMaterial(secretKey), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    keyDigest: keyDigest(secretKey),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    createdAt: now.toISOString(),
  };
}

export function decryptSecretValue(envelope: unknown, secretKey: string) {
  const secret = EncryptedSecret.parse(envelope);
  if (secret.keyDigest !== keyDigest(secretKey)) throw new Error("Secret vault key does not match this envelope");
  const decipher = createDecipheriv("aes-256-gcm", keyMaterial(secretKey), Buffer.from(secret.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(secret.tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

export function secretMetadata(name: string, envelope: EncryptedSecret, updatedBy?: string | null, updatedAt?: string | null) {
  return {
    name: SecretName.parse(name),
    algorithm: envelope.algorithm,
    keyDigest: envelope.keyDigest,
    ciphertextBytes: Buffer.from(envelope.ciphertext, "base64url").byteLength,
    createdAt: envelope.createdAt,
    updatedAt: updatedAt ?? envelope.createdAt,
    updatedBy: updatedBy ?? null,
  };
}
