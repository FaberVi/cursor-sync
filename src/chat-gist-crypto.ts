import { randomBytes, createDecipheriv, createCipheriv } from "node:crypto";
import { argon2id } from "hash-wasm";

export type PlaintextKind = "chat-bundle" | "chat-bundles-collection";

export const CHAT_GIST_KDF = {
  name: "argon2id" as const,
  memoryKiB: 65536,
  iterations: 3,
  parallelism: 4,
};

export class ChatGistCryptoError extends Error {
  constructor(
    message: string,
    public readonly code: "DECRYPT_FAILED" | "INVALID_ENVELOPE"
  ) {
    super(message);
    this.name = "ChatGistCryptoError";
  }
}

interface EnvelopeV1 {
  cursorSyncEncrypted: {
    formatVersion: 1;
    plaintextKind: PlaintextKind;
    kdf: {
      name: "argon2id";
      salt: string;
      memoryKiB: number;
      iterations: number;
      parallelism: number;
    };
    cipher: {
      name: "aes-256-gcm";
      iv: string;
      ciphertext: string;
      tag: string;
    };
  };
}

function b64(buf: Buffer): string {
  return buf.toString("base64");
}

function fromB64(value: string, label: string): Buffer {
  const buf = Buffer.from(value, "base64");
  if (buf.length === 0) {
    throw new ChatGistCryptoError(`Invalid base64 for ${label}.`, "INVALID_ENVELOPE");
  }
  return buf;
}

function parseEnvelope(raw: string): EnvelopeV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ChatGistCryptoError("Invalid envelope JSON.", "INVALID_ENVELOPE");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ChatGistCryptoError("Envelope must be an object.", "INVALID_ENVELOPE");
  }
  const root = parsed as Record<string, unknown>;
  const enc = root.cursorSyncEncrypted;
  if (typeof enc !== "object" || enc === null) {
    throw new ChatGistCryptoError("Missing cursorSyncEncrypted.", "INVALID_ENVELOPE");
  }
  const encrypted = enc as Record<string, unknown>;
  if (encrypted.formatVersion !== 1) {
    throw new ChatGistCryptoError(
      `Unsupported envelope formatVersion: ${String(encrypted.formatVersion)}.`,
      "INVALID_ENVELOPE"
    );
  }
  if (
    encrypted.plaintextKind !== "chat-bundle" &&
    encrypted.plaintextKind !== "chat-bundles-collection"
  ) {
    throw new ChatGistCryptoError("Invalid plaintextKind.", "INVALID_ENVELOPE");
  }
  const kdfBlock = encrypted.kdf;
  const cipherBlock = encrypted.cipher;
  if (
    typeof kdfBlock !== "object" ||
    kdfBlock === null ||
    typeof cipherBlock !== "object" ||
    cipherBlock === null
  ) {
    throw new ChatGistCryptoError("Invalid kdf or cipher block.", "INVALID_ENVELOPE");
  }
  const kdfFields = kdfBlock as Record<string, unknown>;
  const cipherFields = cipherBlock as Record<string, unknown>;
  if (kdfFields.name !== "argon2id" || cipherFields.name !== "aes-256-gcm") {
    throw new ChatGistCryptoError("Unsupported kdf or cipher name.", "INVALID_ENVELOPE");
  }
  for (const field of ["salt", "memoryKiB", "iterations", "parallelism"] as const) {
    const expected = field === "salt" ? "string" : "number";
    if (typeof kdfFields[field] !== expected) {
      throw new ChatGistCryptoError(`Missing or invalid kdf.${field}.`, "INVALID_ENVELOPE");
    }
  }
  const memoryKiB = kdfFields.memoryKiB as number;
  const iterations = kdfFields.iterations as number;
  const parallelism = kdfFields.parallelism as number;
  for (const param of [memoryKiB, iterations, parallelism]) {
    if (!Number.isFinite(param) || !Number.isInteger(param)) {
      throw new ChatGistCryptoError("KDF parameters must be finite integers.", "INVALID_ENVELOPE");
    }
  }
  if (
    memoryKiB <= 0 ||
    memoryKiB > 1048576 ||
    iterations <= 0 ||
    iterations > 100 ||
    parallelism <= 0 ||
    parallelism > 64
  ) {
    throw new ChatGistCryptoError("KDF parameters out of allowed range.", "INVALID_ENVELOPE");
  }
  for (const field of ["iv", "ciphertext", "tag"] as const) {
    if (typeof cipherFields[field] !== "string") {
      throw new ChatGistCryptoError(`Missing or invalid cipher.${field}.`, "INVALID_ENVELOPE");
    }
  }
  return parsed as EnvelopeV1;
}

async function deriveKey(
  password: string,
  salt: Buffer,
  kdf: Pick<typeof CHAT_GIST_KDF, "memoryKiB" | "iterations" | "parallelism">
): Promise<Buffer> {
  const keyBytes = await argon2id({
    password,
    salt,
    parallelism: kdf.parallelism,
    iterations: kdf.iterations,
    memorySize: kdf.memoryKiB,
    hashLength: 32,
    outputType: "binary",
  });
  return Buffer.from(keyBytes);
}

export function isEncryptedChatGistPayload(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.cursorSyncEncrypted === "object" && parsed.cursorSyncEncrypted !== null;
  } catch {
    return false;
  }
}

export async function encryptChatGistPayload(
  plaintext: string,
  password: string,
  plaintextKind: PlaintextKind
): Promise<string> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(password, salt, CHAT_GIST_KDF);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope: EnvelopeV1 = {
    cursorSyncEncrypted: {
      formatVersion: 1,
      plaintextKind,
      kdf: {
        name: "argon2id",
        salt: b64(salt),
        memoryKiB: CHAT_GIST_KDF.memoryKiB,
        iterations: CHAT_GIST_KDF.iterations,
        parallelism: CHAT_GIST_KDF.parallelism,
      },
      cipher: {
        name: "aes-256-gcm",
        iv: b64(iv),
        ciphertext: b64(ciphertext),
        tag: b64(tag),
      },
    },
  };
  return JSON.stringify(envelope, null, 2);
}

export async function decryptChatGistPayload(
  envelopeJson: string,
  password: string
): Promise<string> {
  const envelope = parseEnvelope(envelopeJson);
  const { kdf, cipher } = envelope.cursorSyncEncrypted;
  try {
    const salt = fromB64(kdf.salt, "kdf.salt");
    const iv = fromB64(cipher.iv, "cipher.iv");
    const ciphertext = fromB64(cipher.ciphertext, "cipher.ciphertext");
    const tag = fromB64(cipher.tag, "cipher.tag");
    const key = await deriveKey(password, salt, kdf);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch (err) {
    if (err instanceof ChatGistCryptoError) {
      throw err;
    }
    throw new ChatGistCryptoError(
      "Decryption failed. Check your chat encryption password.",
      "DECRYPT_FAILED"
    );
  }
}
