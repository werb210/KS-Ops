import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, encryptionKey, matchesHash, safeEqual, sha256Hex } from "../../src/lib/crypto.js";

describe("crypto", () => {
  it("round-trips a secret with AES-256-GCM and rejects tampering", () => {
    const key = encryptionKey()!;
    const enc = encryptSecret("ksops_secret", key);
    expect(enc.startsWith("v1:")).toBe(true);
    expect(enc).not.toContain("ksops_secret");
    expect(decryptSecret(enc, key)).toBe("ksops_secret");
    const buf = Buffer.from(enc.slice(3), "base64");
    buf[buf.length - 1] ^= 1;
    expect(() => decryptSecret("v1:" + buf.toString("base64"), key)).toThrow();
    expect(() => decryptSecret(enc, Buffer.alloc(32, 1))).toThrow();
  });

  it("accepts hex or base64 keys of 32 bytes only", () => {
    expect(encryptionKey("ab".repeat(32))?.length).toBe(32);
    expect(encryptionKey(Buffer.alloc(32, 7).toString("base64"))?.length).toBe(32);
    expect(encryptionKey("short")).toBeNull();
    expect(encryptionKey("")).toBeNull();
  });

  it("compares secrets against stored hashes", () => {
    const h = sha256Hex("right");
    expect(matchesHash("right", h)).toBe(true);
    expect(matchesHash("wrong", h)).toBe(false);
    expect(matchesHash("", h)).toBe(false);
    expect(matchesHash(undefined, h)).toBe(false);
    expect(matchesHash("right", null)).toBe(false);
    expect(matchesHash("right", "nothex")).toBe(false);
    expect(safeEqual("a", "a")).toBe(true);
    expect(safeEqual("a", "ab")).toBe(false);
  });
});
