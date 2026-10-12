import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const normalizeUsername = (value) => value.normalize("NFKC").replace(/[A-Z]/g, (character) => character.toLowerCase());
export const normalizePhone = (value) => `+86${value.replace(/^\+?86/, "")}`;
export const hmac = (key, value) => createHmac("sha256", key).update(value).digest("base64url");
export const opaqueToken = () => randomBytes(32).toString("base64url");
export const code = () => String(randomInt(100000, 1000000));

export function encrypt(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const value = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${value.toString("base64url")}`;
}

export function decrypt(key, encrypted) {
  const [iv, tag, value] = encrypted.split(".").map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(value), decipher.final()]).toString("utf8");
}

export function safeEqual(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
