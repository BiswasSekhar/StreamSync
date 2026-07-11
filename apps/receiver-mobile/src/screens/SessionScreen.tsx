import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
} from "react-native";
import Video from "react-native-video";
import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  mediaDevices,
  RTCView,
} from "react-native-webrtc";
import { useTorrentWebView } from "../lib/torrentWebView";
import { MobileSyncController, SyncMessage } from "../lib/sync";
import { EXPANDED_STUN_POOL } from "@streamsync/shared";

const ICE_SERVERS = EXPANDED_STUN_POOL;

interface Props {
  route: { params: { roomUrl: string } };
  navigation: any;
}

export function SessionScreen({ route, navigation }: Props) {
  const { roomUrl } = route.params;
  const [position, setPosition] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [localStreamURL, setLocalStreamURL] = useState<string | null>(null);
  const [status, setStatus] = useState("Connecting…");

  const videoRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const syncRef = useRef(new MobileSyncController());

  const { addMagnet, streamUrl, torrentProgress, TorrentWebView } =
    useTorrentWebView();

  useEffect(() => {
    connectToRoom(roomUrl);
    return () => {
      wsRef.current?.close();
      (pcRef.current as any)?.close?.();
    };
  }, []);

  const connectToRoom = (url: string) => {
    const parsed = new URL(url);
    const roomId = parsed.searchParams.get("room");
    const wsBase = url.split("?")[0];
    const wsUrl = wsBase.replace(/^https?/, "wss").replace(/^http/, "ws");
    const wsUrlFull = wsUrl.endsWith("/") ? wsUrl + "ws" : wsUrl + "/ws";

    const ws = new WebSocket(wsUrlFull);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("Joined room, waiting for host…");
      ws.send(JSON.stringify({ type: "join", room: roomId, displayName: "Mobile Viewer" }));
    };

    ws.onmessage = async (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "offer") {
          await handleOffer(msg.sdp, msg.peerId);
        } else if (msg.type === "ice-candidate" && pcRef.current) {
          await pcRef.current.addIceCandidate(
            new RTCIceCandidate(msg.candidate)
          );
        } else if (msg.type === "room-full") {
          setStatus("Room is full");
        }
      } catch (err) {
        console.error("WS message error:", err);
      }
    };

    ws.onerror = (e) => console.error("WS error:", e);
    ws.onclose = () => setStatus("Disconnected");
  };

  const handleOffer = async (sdp: string, hostPeerId: string) => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcRef.current = pc;

    // Get local camera
    try {
      const stream = await mediaDevices.getUserMedia({
        video: { facingMode: "user", width: 640, height: 480 },
        audio: true,
      });
      stream.getTracks().forEach((track: any) => {
        pc.addTrack(track, stream);
      });
      const trackURL = stream.toURL();
      setLocalStreamURL(trackURL);
    } catch (e) {
      console.warn("No camera/mic:", e);
    }

    pc.ondatachannel = (e: any) => {
      const dc = e.channel;

      if (dc.label === "control") {
        dc.onmessage = (ev: any) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === "magnet") {
              setStatus("Buffering stream…");
              addMagnet(msg.magnet);
            }
          } catch {}
        };
      }

      if (dc.label === "sync") {
        dc.onmessage = (ev: any) => {
          try {
            const sync: SyncMessage = JSON.parse(ev.data);
            const { position: targetPos, playing, valid } = syncRef.current.computeTargetPosition(sync);
            if (!valid) return;

            setIsPlaying(playing);
            const drift = Math.abs(targetPos - position);
            if (drift > 0.5 && videoRef.current) {
              videoRef.current.seek(targetPos);
            }
          } catch {}
        };
      }
    };

    await pc.setRemoteDescription(
      new RTCSessionDescription({ type: "offer", sdp })
    );
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    wsRef.current?.send(
      JSON.stringify({ type: "answer", sdp: answer.sdp, peerId: hostPeerId })
    );

    pc.onicecandidate = (e: any) => {
      if (e.candidate) {
        wsRef.current?.send(
          JSON.stringify({
            type: "ice-candidate",
            candidate: e.candidate,
            peerId: hostPeerId,
          })
        );
      }
    };

    pc.onconnectionstatechange = () => {
      if ((pc as any).connectionState === "connected") {
        setStatus("Connected — streaming");
      }
    };
  };

  return (
    <View style={styles.container}>
      {/* Hidden torrent WebView */}
      {TorrentWebView}

      {/* Status bar */}
      <View style={styles.header}>
        <Text style={styles.headerText}>StreamSync</Text>
        <Text style={styles.statusText}>{status}</Text>
      </View>

      {/* Video */}
      <View style={styles.videoContainer}>
        {streamUrl ? (
          <Video
            ref={videoRef}
            source={{ uri: streamUrl }}
            paused={!isPlaying}
            onProgress={({ currentTime }: any) => setPosition(currentTime)}
            style={styles.video}
            resizeMode="contain"
            controls
          />
        ) : (
          <View style={styles.placeholder}>
            <Text style={styles.placeholderText}>
              {torrentProgress > 0
                ? `Buffering… ${(torrentProgress * 100).toFixed(0)}%`
                : status}
            </Text>
          </View>
        )}
      </View>

      {/* Local camera preview */}
      {localStreamURL && (
        <View style={styles.camPreview}>
          <RTCView
            streamURL={localStreamURL}
            style={styles.camView}
            mirror
            objectFit="cover"
          />
        </View>
      )}

      {/* Back button */}
      <TouchableOpacity
        style={styles.backButton}
        onPress={() => navigation.goBack()}
      >
        <Text style={styles.backButtonText}>← Leave</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f0f" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#2a2a2a",
  },
  headerText: { color: "#f0f0f0", fontSize: 16, fontWeight: "600" },
  statusText: { color: "#9ca3af", fontSize: 13 },
  videoContainer: {
    flex: 1,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
  },
  video: { width: "100%", height: "100%" },
  placeholder: {
    justifyContent: "center",
    alignItems: "center",
    padding: 40,
  },
  placeholderText: { color: "#9ca3af", fontSize: 14, textAlign: "center" },
  camPreview: {
    position: "absolute",
    bottom: 80,
    right: 16,
    width: 80,
    height: 100,
    borderRadius: 8,
    overflow: "hidden",
    borderWidth: 2,
    borderColor: "#6366f1",
  },
  camView: { width: "100%", height: "100%" },
  backButton: {
    position: "absolute",
    bottom: 20,
    left: 20,
    backgroundColor: "#1a1a1a",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  backButtonText: { color: "#9ca3af", fontSize: 14 },
});
