export interface ChatMessage {
  id: string;
  from: string;
  text: string;
  timestamp: number;
}

export interface VideoReadyControlMessage {
  type: "video-ready";
  fileName: string;
  mimeCodec: string;
  fileSize: number;
  durationSeconds: number;
  magnetLink?: string | null;
}

export interface SyncMessage {
  type: "sync";
  position: number;
  playing: boolean;
  timestamp: number;
  sequence: number;
}

export interface PlaybackControlMessage {
  type: "control";
  action: "play" | "pause" | "seek";
  position: number;
}

export interface SyncHeartbeatMessage {
  type: "heartbeat";
  timestamp: number;
}

export type SyncChannelMessage = SyncMessage | PlaybackControlMessage | SyncHeartbeatMessage;

export type ChunkPayloadEncoding = "raw" | "chunk-id-prefix-v1";

export interface WebRtcChunkRequestMessage {
  type: "WEBRTC_CHUNK_REQUEST";
  reqId: string;
  chunkId: number;
  range: string;
  encoding?: ChunkPayloadEncoding;
}

export interface WebRtcChunkResponseMetaMessage {
  type: "WEBRTC_CHUNK_RESPONSE";
  reqId: string;
  chunkId: number;
  size: number;
  contentRange: string;
}

export interface WebRtcChunkErrorMessage {
  type: "WEBRTC_CHUNK_ERROR";
  reqId: string;
  chunkId?: number;
  reason?: string;
}

export type MediaChannelMessage =
  | WebRtcChunkRequestMessage
  | WebRtcChunkResponseMetaMessage
  | WebRtcChunkErrorMessage;

export const CHUNK_ENVELOPE_MAGIC = 0x53534348;

export interface ChunkEnvelope {
  chunkId: number;
  payload: ArrayBuffer;
}

/**
 * Adds an 8-byte prefix so binary media chunks can be matched with metadata.
 */
export function encodeChunkEnvelope(chunkId: number, payload: ArrayBuffer): ArrayBuffer {
  const headerSize = 8;
  const wrapped = new Uint8Array(headerSize + payload.byteLength);
  const view = new DataView(wrapped.buffer);
  view.setUint32(0, CHUNK_ENVELOPE_MAGIC);
  view.setUint32(4, chunkId >>> 0);
  wrapped.set(new Uint8Array(payload), headerSize);
  return wrapped.buffer;
}

/**
 * Decodes a prefixed chunk envelope. Returns null when payload is legacy/raw.
 */
export function decodeChunkEnvelope(data: ArrayBuffer): ChunkEnvelope | null {
  if (data.byteLength < 8) return null;
  const view = new DataView(data);
  if (view.getUint32(0) !== CHUNK_ENVELOPE_MAGIC) return null;
  const chunkId = view.getUint32(4);
  return {
    chunkId,
    payload: data.slice(8),
  };
}
