export interface ExistingPeerInfo {
  peerId: string;
  displayName: string;
}

export const DEFAULT_WEBTORRENT_TRACKERS = [
  "wss://tracker.webtorrent.dev",
  "wss://tracker.btorrent.xyz",
  "wss://tracker.files.fm:7073/announce",
  "wss://tracker.openwebtorrent.com",
] as const;

export interface JoinSignal {
  type: "join";
  room: string;
  displayName?: string;
}

export interface RoomJoinedSignal {
  type: "room-joined";
  peerId: string;
  existingPeers?: ExistingPeerInfo[];
}

export interface RoomFullSignal {
  type: "room-full";
}

export interface PeerJoinedSignal {
  type: "peer-joined";
  peerId: string;
  displayName: string;
}

export interface PeerLeftSignal {
  type: "peer-left";
  peerId: string;
}

export interface JoinRequestSignal {
  type: "join-request";
  displayName: string;
  peerId?: string;
  target?: string;
}

export interface JoinApprovedSignal {
  type: "join-approved";
  peerId?: string;
  target?: string;
}

export interface JoinDeniedSignal {
  type: "join-denied";
  reason?: string;
  peerId?: string;
  target?: string;
}

export interface HostEndedSignal {
  type: "host-ended";
  reason?: string;
  peerId?: string;
  target?: string;
}

export interface OfferSignal {
  type: "offer";
  sdp: string;
  peerId?: string;
  target?: string;
}

export interface AnswerSignal {
  type: "answer";
  sdp: string;
  peerId?: string;
  target?: string;
}

export interface IceCandidateSignal {
  type: "ice-candidate";
  candidate: RTCIceCandidateInit;
  peerId?: string;
  target?: string;
}

export interface IceCandidatesSignal {
  type: "ice-candidates";
  candidates: RTCIceCandidateInit[];
  peerId?: string;
  target?: string;
}

export interface ChatSignal {
  type: "chat";
  text: string;
  peerId?: string;
  target?: string;
}

export interface SyncSignal {
  type: "sync";
  position: number;
  playing: boolean;
  timestamp: number;
  sequence: number;
  peerId?: string;
  target?: string;
}

export interface PingSignal {
  type: "ping";
  timestamp: number;
}

export interface PongSignal {
  type: "pong";
  timestamp: number;
  serverTime?: number;
}

export interface LeaveSignal {
  type: "leave";
  peerId?: string;
  target?: string;
}

export type SignallingMessage =
  | JoinSignal
  | RoomJoinedSignal
  | RoomFullSignal
  | PeerJoinedSignal
  | PeerLeftSignal
  | JoinRequestSignal
  | JoinApprovedSignal
  | JoinDeniedSignal
  | HostEndedSignal
  | OfferSignal
  | AnswerSignal
  | IceCandidateSignal
  | IceCandidatesSignal
  | ChatSignal
  | SyncSignal
  | PingSignal
  | PongSignal
  | LeaveSignal;
