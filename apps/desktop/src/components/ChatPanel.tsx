import { useState, useRef, useEffect } from "react";
import { useSessionStore } from "../store/session";

export function ChatPanel() {
  const { messages, sendChat, displayName } = useSessionStore();
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    await sendChat(text);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const formatTime = (ts: number) => {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-[#2a2a2a] flex-shrink-0">
        <span className="text-xs font-medium text-[#9ca3af] uppercase tracking-wide">Chat</span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && (
          <p className="text-xs text-[#666] text-center py-4">
            No messages yet. Say hello!
          </p>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className="space-y-0.5">
            <div className="flex items-baseline gap-2">
              <span className="text-xs font-medium text-indigo-400">
                {msg.from === displayName ? "You" : msg.from}
              </span>
              <span className="text-xs text-[#555]">{formatTime(msg.timestamp)}</span>
            </div>
            <p className="text-sm text-[#e0e0e0] break-words">{msg.text}</p>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="p-3 border-t border-[#2a2a2a] flex-shrink-0">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Message..."
            className="flex-1 text-sm"
          />
          <button onClick={handleSend} className="btn-primary px-3 py-1.5">
            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
