import { useSessionStore } from "../store/session";

export function PeerList() {
  const { peers } = useSessionStore();

  return (
    <div className="border-b border-[#2a2a2a] flex-shrink-0">
      <div className="px-3 py-2">
        <span className="text-xs font-medium text-[#9ca3af] uppercase tracking-wide">
          Viewers ({peers.length})
        </span>
      </div>
      {peers.length === 0 ? (
        <p className="px-3 pb-3 text-xs text-[#666]">No viewers yet</p>
      ) : (
        <div className="px-2 pb-2 space-y-0.5 max-h-40 overflow-y-auto">
          {peers.map((peer) => (
            <div
              key={peer.id}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[#1a1a1a]"
            >
              <div className="w-6 h-6 rounded-full bg-indigo-500/30 flex items-center justify-center flex-shrink-0">
                <span className="text-xs font-medium text-indigo-400">
                  {(peer.displayName || "G")[0].toUpperCase()}
                </span>
              </div>
              <span className="text-sm text-[#e0e0e0] truncate">
                {peer.displayName || "Guest"}
              </span>
              <span className="ml-auto w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
