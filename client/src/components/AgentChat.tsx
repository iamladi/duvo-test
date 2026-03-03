import { useEffect, useRef, useState } from "react";
import { useAgentStream } from "../hooks/useAgentStream";

export function AgentChat() {
  const { messages, isStreaming, error, usage, sendMessage, abort } = useAgentStream();
  const [input, setInput] = useState("");
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function handleSend() {
    const prompt = input.trim();
    if (!prompt || isStreaming) return;
    setLastPrompt(prompt);
    setInput("");
    sendMessage(prompt);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleRetry() {
    if (lastPrompt) {
      sendMessage(lastPrompt);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        maxWidth: "800px",
        margin: "0 auto",
        fontFamily: "sans-serif",
      }}
    >
      {/* Message list */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        {messages.length === 0 && (
          <div style={{ color: "#888", textAlign: "center", marginTop: "40px" }}>
            Send a message to start.
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "70%",
              padding: "10px 14px",
              borderRadius: "12px",
              backgroundColor: msg.role === "user" ? "#0070f3" : "#f0f0f0",
              color: msg.role === "user" ? "#fff" : "#111",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              lineHeight: "1.5",
            }}
          >
            {msg.content || (msg.role === "assistant" && isStreaming ? "..." : "")}
          </div>
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* Usage display */}
      {usage && !isStreaming && (
        <div
          style={{
            padding: "6px 16px",
            fontSize: "12px",
            color: "#888",
            borderTop: "1px solid #eee",
            display: "flex",
            gap: "16px",
          }}
        >
          <span>Cost: ${usage.totalCostUsd.toFixed(6)}</span>
          <span>In: {usage.inputTokens} tokens</span>
          <span>Out: {usage.outputTokens} tokens</span>
          <span>Time: {(usage.durationMs / 1000).toFixed(1)}s</span>
        </div>
      )}

      {/* Error display */}
      {error && (
        <div
          style={{
            padding: "10px 16px",
            backgroundColor: "#fff0f0",
            borderTop: "1px solid #ffcccc",
            color: "#cc0000",
            display: "flex",
            alignItems: "center",
            gap: "12px",
            fontSize: "14px",
          }}
        >
          <span style={{ flex: 1 }}>Error: {error}</span>
          <button
            onClick={handleRetry}
            style={{
              padding: "4px 12px",
              cursor: "pointer",
              border: "1px solid #cc0000",
              borderRadius: "6px",
              backgroundColor: "transparent",
              color: "#cc0000",
              fontSize: "13px",
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Input area */}
      <div
        style={{
          padding: "12px 16px",
          borderTop: "1px solid #ddd",
          display: "flex",
          gap: "8px",
          alignItems: "center",
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          disabled={isStreaming}
          style={{
            flex: 1,
            padding: "10px 14px",
            borderRadius: "8px",
            border: "1px solid #ccc",
            fontSize: "14px",
            outline: "none",
            backgroundColor: isStreaming ? "#f9f9f9" : "#fff",
          }}
        />

        {isStreaming ? (
          <button
            onClick={abort}
            style={{
              padding: "10px 18px",
              borderRadius: "8px",
              border: "1px solid #cc0000",
              backgroundColor: "#fff0f0",
              color: "#cc0000",
              cursor: "pointer",
              fontSize: "14px",
              whiteSpace: "nowrap",
            }}
          >
            Stop
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!input.trim()}
            style={{
              padding: "10px 18px",
              borderRadius: "8px",
              border: "none",
              backgroundColor: input.trim() ? "#0070f3" : "#ccc",
              color: "#fff",
              cursor: input.trim() ? "pointer" : "not-allowed",
              fontSize: "14px",
              whiteSpace: "nowrap",
            }}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
