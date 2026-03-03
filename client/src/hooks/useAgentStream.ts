import { useCallback, useRef, useState } from "react";
import type { AgentRequest, AgentSSEEvent } from "shared";

export type Message = {
  role: "user" | "assistant";
  content: string;
};

export type Usage = {
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
};

type UseAgentStreamReturn = {
  messages: Message[];
  isStreaming: boolean;
  error: string | null;
  usage: Usage | null;
  sendMessage: (prompt: string) => void;
  abort: () => void;
};

export function useAgentStream(): UseAgentStreamReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);

  const sessionIdRef = useRef<string | undefined>(undefined);
  const abortControllerRef = useRef<AbortController | null>(null);

  const abort = useCallback(() => {
    abortControllerRef.current?.abort();
    setIsStreaming(false);
  }, []);

  const sendMessage = useCallback((prompt: string) => {
    setError(null);
    setIsStreaming(true);

    // Add user message immediately
    setMessages((prev) => [...prev, { role: "user", content: prompt }]);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const body: AgentRequest = {
      prompt,
      sessionId: sessionIdRef.current,
    };

    (async () => {
      try {
        const response = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        if (!response.body) {
          throw new Error("Response body is null");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // Add a placeholder assistant message to stream into
        setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Split on double newline to extract complete SSE events
          const parts = buffer.split("\n\n");
          // The last part may be incomplete — keep it in the buffer
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            if (!part.trim()) continue;

            let eventType = "";
            let dataLine = "";

            for (const line of part.split("\n")) {
              if (line.startsWith("event: ")) {
                eventType = line.slice("event: ".length).trim();
              } else if (line.startsWith("data: ")) {
                dataLine = line.slice("data: ".length).trim();
              }
            }

            if (!dataLine) continue;

            // Handle [DONE] sentinel
            if (dataLine === "[DONE]") {
              setIsStreaming(false);
              continue;
            }

            let parsed: AgentSSEEvent;
            try {
              parsed = JSON.parse(dataLine) as AgentSSEEvent;
            } catch {
              continue;
            }

            // Prefer event type from the SSE event: line; fall back to parsed type
            const resolvedType = eventType || parsed.type;

            switch (resolvedType) {
              case "system": {
                const evt = parsed as Extract<AgentSSEEvent, { type: "system" }>;
                if (evt.subtype === "init") {
                  sessionIdRef.current = evt.session_id;
                }
                break;
              }

              case "stream_event": {
                const evt = parsed as Extract<AgentSSEEvent, { type: "stream_event" }>;
                if (
                  evt.event.type === "content_block_delta" &&
                  evt.event.delta?.type === "text_delta" &&
                  evt.event.delta.text
                ) {
                  const text = evt.event.delta.text;
                  setMessages((prev) => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last && last.role === "assistant") {
                      updated[updated.length - 1] = {
                        ...last,
                        content: last.content + text,
                      };
                    }
                    return updated;
                  });
                }
                break;
              }

              case "assistant": {
                const evt = parsed as Extract<AgentSSEEvent, { type: "assistant" }>;
                const textContent = evt.message.content
                  .filter((c) => c.type === "text" && c.text)
                  .map((c) => c.text ?? "")
                  .join("");
                if (textContent) {
                  setMessages((prev) => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last && last.role === "assistant") {
                      updated[updated.length - 1] = {
                        ...last,
                        content: textContent,
                      };
                    }
                    return updated;
                  });
                }
                break;
              }

              case "result": {
                const evt = parsed as Extract<AgentSSEEvent, { type: "result" }>;
                setUsage({
                  totalCostUsd: evt.total_cost_usd,
                  inputTokens: evt.usage.input_tokens,
                  outputTokens: evt.usage.output_tokens,
                  durationMs: evt.duration_ms,
                });
                setIsStreaming(false);
                break;
              }

              case "error": {
                const evt = parsed as Extract<AgentSSEEvent, { type: "error" }>;
                setError(evt.message);
                setIsStreaming(false);
                break;
              }

              default:
                break;
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          // User-initiated abort — not an error
        } else {
          setError(err instanceof Error ? err.message : "Unknown error occurred");
        }
        setIsStreaming(false);
      }
    })();
  }, []);

  return { messages, isStreaming, error, usage, sendMessage, abort };
}
