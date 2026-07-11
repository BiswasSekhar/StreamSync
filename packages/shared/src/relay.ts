/**
 * Type defs and binary framing for the host-relay mesh.
 *
 * When two guests cannot establish a direct WebRTC connection (symmetric
 * NAT / CG-NAT), they route their peer-to-peer DataChannel traffic through
 * the host. The host runs `HostRelayCoordinator`; guests run `GuestMesh`.
 *
 * Wire format (binary, on each guest's `relayDc` to the host):
 *
 *   [1 byte  version=1]
 *   [1 byte  msg-type: 0x10=control 0x11=media]
 *   [2 bytes reserved]
 *   [16 bytes from-peerId]   ← first 16 bytes of the hex peerId
 *   [16 bytes to-peerId]
 *   [4 bytes payload length]
 *   [N bytes payload]        ← already E2E-encrypted by the sender
 */

export const RELAY_FRAME_VERSION = 1;
export const RELAY_MSG_CONTROL = 0x10;
export const RELAY_MSG_MEDIA = 0x11;

export const RELAY_PEER_ID_BYTES = 16;
export const RELAY_HEADER_BYTES =
  1 /* version */ +
  1 /* msg-type */ +
  2 /* reserved */ +
  RELAY_PEER_ID_BYTES /* from */ +
  RELAY_PEER_ID_BYTES /* to */ +
  4; /* payload length */

export type RelayMsgType = typeof RELAY_MSG_CONTROL | typeof RELAY_MSG_MEDIA;

export interface RelayFrame {
  msgType: RelayMsgType;
  from: string; // hex (length 32)
  to: string;   // hex (length 32)
  payload: Uint8Array;
}

/** Pack a guest's peerId (40-char hex from tracker) down to 16 bytes. */
export function packPeerId(peerIdHex: string): Uint8Array {
  const trimmed = peerIdHex.replace(/[^0-9a-fA-F]/g, "").slice(0, RELAY_PEER_ID_BYTES * 2);
  if (trimmed.length !== RELAY_PEER_ID_BYTES * 2) {
    throw new Error(`packPeerId: need ${RELAY_PEER_ID_BYTES * 2} hex chars, got ${trimmed.length}`);
  }
  const out = new Uint8Array(RELAY_PEER_ID_BYTES);
  for (let i = 0; i < RELAY_PEER_ID_BYTES; i++) {
    out[i] = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function unpackPeerId(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

export function encodeRelayFrame(frame: RelayFrame): ArrayBuffer {
  const fromBytes = packPeerId(frame.from);
  const toBytes = packPeerId(frame.to);
  const out = new Uint8Array(RELAY_HEADER_BYTES + frame.payload.byteLength);
  const view = new DataView(out.buffer);
  let offset = 0;
  out[offset++] = RELAY_FRAME_VERSION;
  out[offset++] = frame.msgType;
  offset += 2; // reserved
  out.set(fromBytes, offset);
  offset += RELAY_PEER_ID_BYTES;
  out.set(toBytes, offset);
  offset += RELAY_PEER_ID_BYTES;
  view.setUint32(offset, frame.payload.byteLength);
  offset += 4;
  out.set(frame.payload, offset);
  return out.buffer;
}

export function decodeRelayFrame(buffer: ArrayBuffer | Uint8Array): RelayFrame {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < RELAY_HEADER_BYTES) {
    throw new Error(`relay frame too small: ${bytes.byteLength}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== RELAY_FRAME_VERSION) {
    throw new Error(`unsupported relay frame version: ${bytes[0]}`);
  }
  const msgType = bytes[1] as RelayMsgType;
  let offset = 4; // skip version + msgType + reserved
  const from = unpackPeerId(bytes.slice(offset, offset + RELAY_PEER_ID_BYTES));
  offset += RELAY_PEER_ID_BYTES;
  const to = unpackPeerId(bytes.slice(offset, offset + RELAY_PEER_ID_BYTES));
  offset += RELAY_PEER_ID_BYTES;
  const payloadLen = view.getUint32(offset);
  offset += 4;
  if (bytes.byteLength - offset < payloadLen) {
    throw new Error(`relay frame truncated: header says ${payloadLen} payload bytes, only ${bytes.byteLength - offset} remain`);
  }
  const payload = bytes.slice(offset, offset + payloadLen);
  return { msgType, from, to, payload };
}

// ----------------------------------------------------------------------------
// Control-channel JSON messages for relay coordination (sent over controlDc,
// encrypted by SessionCipher like everything else).
// ----------------------------------------------------------------------------

export interface PeerRosterMessage {
  type: "peer-roster";
  peers: { peerId: string; displayName: string }[];
}

export interface IceProbeResultMessage {
  type: "ice-probe";
  to: string;
  attemptId: string;
  success: boolean;
}

export interface RelayCapabilityMessage {
  type: "relay-capability";
  canDirect: string[];
  needsRelay: string[];
}

export interface RelayDropMessage {
  type: "relay-drop";
  reason: "backpressure" | "cap-exceeded" | "unknown-peer";
  to?: string;
}

export type RelayControlMessage =
  | PeerRosterMessage
  | IceProbeResultMessage
  | RelayCapabilityMessage
  | RelayDropMessage;
