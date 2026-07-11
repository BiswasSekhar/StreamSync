/**
 * `SessionCipher` — AES-256-GCM envelope used to E2E-encrypt every
 * DataChannel payload. Both endpoints derive the same `CryptoKey` from the
 * share code via `deriveSessionKey()` and instantiate one cipher per channel.
 *
 * Frame layout (binary):
 *
 *   [1 byte  version=1]
 *   [4 bytes salt]            ← random per channel-open
 *   [8 bytes counter big-endian] ← monotonic per-send
 *   [N bytes ciphertext]
 *   [16 bytes auth tag]
 *
 * Nonce = `salt || counter` (12 bytes — AES-GCM standard). Re-randomizing
 * the salt on every channel open prevents nonce reuse across reconnects
 * even if the counter resets.
 *
 * Receivers track the highest counter seen per (salt, channel) and reject
 * replays.
 */

export const SESSION_CIPHER_VERSION = 1;
export const NONCE_SALT_BYTES = 4;
export const NONCE_COUNTER_BYTES = 8;
export const NONCE_BYTES = NONCE_SALT_BYTES + NONCE_COUNTER_BYTES; // 12
export const AUTH_TAG_BYTES = 16;
export const FRAME_HEADER_BYTES = 1 + NONCE_SALT_BYTES + NONCE_COUNTER_BYTES; // 13

export class SessionCipherError extends Error {}

export class SessionCipher {
  private readonly key: CryptoKey;
  private readonly salt: Uint8Array;
  private counter = 0n;

  /** Per-channel replay state. Keyed by hex(salt) since each remote
   *  may use a different salt. */
  private seenCounters = new Map<string, bigint>();

  /** Serializes sends so async encrypt completions don't reorder frames. */
  private sendQueue: Promise<unknown> = Promise.resolve();

  constructor(key: CryptoKey) {
    this.key = key;
    this.salt = new Uint8Array(NONCE_SALT_BYTES);
    crypto.getRandomValues(this.salt);
  }

  /**
   * Encrypt a plaintext frame. Returns a binary envelope ready for
   * `RTCDataChannel.send`. Sends are serialized internally — callers may
   * fire-and-forget without losing order.
   */
  encrypt(plaintext: Uint8Array | string): Promise<ArrayBuffer> {
    const bytes =
      typeof plaintext === "string"
        ? new TextEncoder().encode(plaintext)
        : plaintext;

    const ticket = this.sendQueue.then(() => this.encryptOne(bytes));
    this.sendQueue = ticket.catch(() => undefined);
    return ticket;
  }

  private async encryptOne(bytes: Uint8Array): Promise<ArrayBuffer> {
    const counter = this.counter++;
    const nonce = buildNonce(this.salt, counter);
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, tagLength: AUTH_TAG_BYTES * 8 },
      this.key,
      bytes as BufferSource,
    );

    const ctBytes = new Uint8Array(ct);
    const out = new Uint8Array(FRAME_HEADER_BYTES + ctBytes.byteLength);
    out[0] = SESSION_CIPHER_VERSION;
    out.set(this.salt, 1);
    writeUint64BE(out, 1 + NONCE_SALT_BYTES, counter);
    out.set(ctBytes, FRAME_HEADER_BYTES);
    return out.buffer;
  }

  /**
   * Decrypt an inbound envelope. Throws on version mismatch, MAC failure,
   * or replay. Returns the raw plaintext bytes.
   */
  async decrypt(envelope: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
    const buf =
      envelope instanceof Uint8Array ? envelope : new Uint8Array(envelope);
    if (buf.byteLength < FRAME_HEADER_BYTES + AUTH_TAG_BYTES) {
      throw new SessionCipherError("envelope too small");
    }
    if (buf[0] !== SESSION_CIPHER_VERSION) {
      throw new SessionCipherError(`unsupported cipher version: ${buf[0]}`);
    }
    const remoteSalt = buf.slice(1, 1 + NONCE_SALT_BYTES);
    const counter = readUint64BE(buf, 1 + NONCE_SALT_BYTES);

    const saltKey = bytesToHex(remoteSalt);
    const lastSeen = this.seenCounters.get(saltKey);
    if (lastSeen !== undefined && counter <= lastSeen) {
      throw new SessionCipherError(
        `replay: counter ${counter} <= ${lastSeen} (salt ${saltKey})`,
      );
    }

    const nonce = buildNonce(remoteSalt, counter);
    const ct = buf.slice(FRAME_HEADER_BYTES);
    let pt: ArrayBuffer;
    try {
      pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce as BufferSource, tagLength: AUTH_TAG_BYTES * 8 },
        this.key,
        ct as BufferSource,
      );
    } catch (err) {
      throw new SessionCipherError(`decrypt failed: ${(err as Error).message}`);
    }
    this.seenCounters.set(saltKey, counter);
    return new Uint8Array(pt);
  }

  /** Decrypt and decode a UTF-8 JSON frame. */
  async decryptJson<T = unknown>(envelope: ArrayBuffer | Uint8Array): Promise<T> {
    const bytes = await this.decrypt(envelope);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }
}

function buildNonce(salt: Uint8Array, counter: bigint): Uint8Array {
  const nonce = new Uint8Array(NONCE_BYTES);
  nonce.set(salt, 0);
  writeUint64BE(nonce, NONCE_SALT_BYTES, counter);
  return nonce;
}

function writeUint64BE(out: Uint8Array, offset: number, value: bigint): void {
  for (let i = 7; i >= 0; i--) {
    out[offset + i] = Number(value & 0xffn);
    value >>= 8n;
  }
}

function readUint64BE(buf: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    value = (value << 8n) | BigInt(buf[offset + i]!);
  }
  return value;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
