import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  type DecipherGCM,
} from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import { env } from "../../config/env.js";

/**
 * Envelope encryption for backup packages (approved architecture, 2026-11-05).
 *
 * Every package gets a random 32-byte data-encryption key (DEK). The DEK is
 * itself encrypted (AES-256-GCM) with the server master key derived from
 * BACKUP_ENCRYPTION_KEY, so packages can later be re-keyed by bumping
 * BACKUP_ENCRYPTION_KEY_VERSION and rewriting headers — the payload never
 * needs re-encryption for a master-key rotation.
 *
 * .ezbackup wire format (all integers big-endian):
 *   bytes 0..8    ASCII magic "EZBACKUP1"
 *   bytes 9..12   uint32 header length (H)
 *   bytes 13..H   JSON envelope header (plaintext — needed to decrypt)
 *   next..end-16  AES-256-GCM ciphertext of gzip(tar)
 *   last 16       GCM authentication tag of the payload
 *
 * The header carries NO secrets usable without the master key: the wrapped
 * DEK alone is useless if BACKUP_ENCRYPTION_KEY is not configured.
 */

export const BACKUP_MAGIC = Buffer.from("EZBACKUP1", "ascii");
export const BACKUP_FORMAT_VERSION = 1;

export interface BackupEnvelopeHeader {
  formatVersion: number;
  alg: "AES-256-GCM";
  keyVersion: number;
  /** base64 DEK encrypted with the master key. */
  wrappedDek: string;
  /** base64 IV used for the DEK wrap. */
  wrappedIv: string;
  /** base64 auth tag of the DEK wrap. */
  wrappedTag: string;
  /** base64 IV used for the package payload. */
  payloadIv: string;
  createdAt: string;
}

export interface EncryptedPackageTail {
  header: BackupEnvelopeHeader;
  authTag: string;
}

function masterKey(): Buffer {
  const secret = env.backupEncryptionKey;
  if (!secret) {
    throw new Error(
      "BACKUP_ENCRYPTION_KEY is required to encrypt backup packages.",
    );
  }
  return createHash("sha256").update(secret).digest();
}

/** sha256 hex of the master key — lets verification detect key mismatch
 * without exposing the key (recorded in the DB row, compared on verify). */
export function masterKeyFingerprint(): string {
  return createHash("sha256").update(masterKey()).digest("hex");
}

function wrapDek(dek: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
  return {
    wrappedDek: wrapped.toString("base64"),
    wrappedIv: iv.toString("base64"),
    wrappedTag: cipher.getAuthTag().toString("base64"),
  };
}

function unwrapDek(header: BackupEnvelopeHeader): Buffer {
  if (!env.backupEncryptionKey) {
    throw new Error(
      "BACKUP_ENCRYPTION_KEY is not configured — this package cannot be decrypted.",
    );
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    masterKey(),
    Buffer.from(header.wrappedIv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(header.wrappedTag, "base64"));
  let dek: Buffer;
  try {
    dek = Buffer.concat([
      decipher.update(Buffer.from(header.wrappedDek, "base64")),
      decipher.final(),
    ]);
  } catch {
    throw new Error(
      `Backup package was encrypted with a different BACKUP_ENCRYPTION_KEY (keyVersion ${header.keyVersion}).`,
    );
  }
  if (dek.length !== 32) throw new Error("Corrupted backup package header.");
  return dek;
}

/**
 * Streaming encryptor. Feed plaintext (the gzipped tar) in; write `stream`
 * output to the package file. `finish()` returns the envelope header +
 * auth tag for the DB row. The tag is appended to the output automatically.
 */
export function createPackageEncryptor() {
  const dek = randomBytes(32);
  const payloadIv = randomBytes(12);
  const wrap = wrapDek(dek);
  const header: BackupEnvelopeHeader = {
    formatVersion: BACKUP_FORMAT_VERSION,
    alg: "AES-256-GCM",
    keyVersion: env.backupEncryptionKeyVersion,
    ...wrap,
    payloadIv: payloadIv.toString("base64"),
    createdAt: new Date().toISOString(),
  };
  const headerBuf = Buffer.from(JSON.stringify(header), "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(headerBuf.length, 0);
  const prelude = Buffer.concat([BACKUP_MAGIC, lenBuf, headerBuf]);

  const cipher = createCipheriv("aes-256-gcm", dek, payloadIv);

  let preludeWritten = false;
  const stream = new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      try {
        if (!preludeWritten) {
          preludeWritten = true;
          cb(null, Buffer.concat([prelude, cipher.update(chunk)]));
          return;
        }
        cb(null, cipher.update(chunk));
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb: TransformCallback) {
      try {
        const final = Buffer.concat([cipher.final(), cipher.getAuthTag()]);
        cb(null, final);
      } catch (err) {
        cb(err as Error);
      }
    },
  });

  return { header, prelude, stream };
}

/** Header length prefix size + magic + uint32. */
export function readEnvelopeHeader(
  input: Buffer,
): { header: BackupEnvelopeHeader; bytesConsumed: number } {
  if (input.length < BACKUP_MAGIC.length + 4) {
    throw new Error("Not an ezPos backup package (too small).");
  }
  if (!input.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) {
    throw new Error(
      "Not an ezPos backup package — invalid magic (wrong file or unencrypted copy?).",
    );
  }
  const headerLen = input.readUInt32BE(BACKUP_MAGIC.length);
  const start = BACKUP_MAGIC.length + 4;
  if (input.length < start + headerLen) {
    throw new Error("Corrupted backup package header.");
  }
  let header: BackupEnvelopeHeader;
  try {
    header = JSON.parse(
      input.subarray(start, start + headerLen).toString("utf8"),
    ) as BackupEnvelopeHeader;
  } catch {
    throw new Error("Corrupted backup package header (invalid JSON).");
  }
  if (header.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(
      `Unsupported backup format version ${header.formatVersion} (this server reads version ${BACKUP_FORMAT_VERSION}).`,
    );
  }
  if (header.alg !== "AES-256-GCM") {
    throw new Error(`Unsupported backup encryption algorithm "${header.alg}".`);
  }
  return { header, bytesConsumed: start + headerLen };
}

/**
 * Streaming decryptor: parses the prelude from the first chunk, decrypts the
 * payload while holding back the trailing 16 CIPHERTEXT bytes, and verifies
 * the GCM auth tag on finish (a tampered package fails here, loudly).
 */
export function createPackageDecryptor(): Transform {
  const TAG_LENGTH = 16;
  let decipher: DecipherGCM | null = null;
  let pending: Buffer = Buffer.alloc(0); // raw ciphertext not yet decrypted

  return new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      try {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        if (!decipher) {
          if (pending.length < BACKUP_MAGIC.length) {
            if (!BACKUP_MAGIC.equals(pending.subarray(0, Math.min(pending.length, BACKUP_MAGIC.length)))) {
              cb(new Error("Not an ezPos backup package — invalid magic."));
              return;
            }
            cb();
            return;
          }
          if (!pending.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) {
            cb(new Error("Not an ezPos backup package — invalid magic."));
            return;
          }
          if (pending.length < BACKUP_MAGIC.length + 4) {
            cb();
            return;
          }
          const headerLen = pending.readUInt32BE(BACKUP_MAGIC.length);
          const totalPrelude = BACKUP_MAGIC.length + 4 + headerLen;
          if (headerLen > 1024 * 1024 || headerLen === 0) {
            cb(new Error("Corrupted backup package header."));
            return;
          }
          if (pending.length < totalPrelude) {
            cb();
            return;
          }
          const parsed = readEnvelopeHeader(pending);
          const dek = unwrapDek(parsed.header);
          decipher = createDecipheriv(
            "aes-256-gcm",
            dek,
            Buffer.from(parsed.header.payloadIv, "base64"),
          );
          pending = Buffer.from(pending.subarray(parsed.bytesConsumed));
        }
        // Emit all but the last 16 raw ciphertext bytes (the auth tag).
        if (pending.length > TAG_LENGTH) {
          const usable = pending.subarray(0, pending.length - TAG_LENGTH);
          pending = Buffer.from(pending.subarray(usable.length));
          cb(null, decipher.update(usable));
          return;
        }
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb: TransformCallback) {
      try {
        if (!decipher) {
          cb(new Error("Not an ezPos backup package."));
          return;
        }
        if (pending.length !== TAG_LENGTH) {
          cb(new Error("Truncated backup package (missing auth tag)."));
          return;
        }
        decipher.setAuthTag(pending);
        const plain = Buffer.concat([decipher.final()]);
        cb(null, plain);
      } catch (err) {
        const message =
          err instanceof Error && /auth|Unsupported state/i.test(err.message)
            ? "Backup package integrity check FAILED — the file is corrupted or was tampered with."
            : err instanceof Error
              ? err.message
              : "Backup decryption failed.";
        cb(new Error(message));
      }
    },
  });
}
