import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentRequest } from "shared";

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export type Usage = {
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
};

export type CreatedFile = {
  filename: string;
  downloadUrl: string;
};

type UseAgentStreamReturn = {
  messages: Message[];
  isStreaming: boolean;
  error: string | null;
  usage: Usage | null;
  activeToolName: string | null;
  createdFiles: CreatedFile[];
  sendMessage: (prompt: string, isRetry?: boolean) => void;
  abort: () => void;
};

function makeMessage(role: "user" | "assistant", content: string): Message {
  return { id: crypto.randomUUID(), role, content };
}

export function useAgentStream(): UseAgentStreamReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [activeToolName, setActiveToolName] = useState<string | null>(null);
  const [createdFiles, setCreatedFiles] = useState<CreatedFile[]>([]);

  const sessionIdRef = useRef<string | undefined>(undefined);
  const abortControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortControllerRef.current?.abort();
    };
  }, []);

  const abort = useCallback(() => {
    abortControllerRef.current?.abort();
    // isStreaming will be set to false by the catch block when AbortError fires
  }, []);

  const sendMessage = useCallback(
    (prompt: string, isRetry = false) => {
      // Abort any in-flight request before starting a new one
      abortControllerRef.current?.abort();

      setError(null);
      setIsStreaming(true);
      setActiveToolName(null);

      // On retry, remove the previous failed assistant message and don't add a duplicate user message
      if (isRetry) {
        setMessages((prev) => {
          const updated = [...prev];
          // Remove trailing empty/failed assistant message if present
          const last = updated[updated.length - 1];
          if (last && last.role === "assistant") {
            updated.pop();
          }
          return updated;
        });
      } else {
        setMessages((prev) => [...prev, makeMessage("user", prompt)]);
      }

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
          if (mountedRef.current) {
            setMessages((prev) => [...prev, makeMessage("assistant", "")]);
          }

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!mountedRef.current) break;

            buffer += decoder.decode(value, { stream: true });

            const parts = buffer.split("\n\n");
            buffer = parts.pop() ?? "";

            for (const part of parts) {
              if (!part.trim()) continue;

              let eventType = "";
              let dataLine = "";

              for (const line of part.split("\n")) {
                if (line.startsWith("event: ")) {
                  eventType = line.slice("event: ".length).trim();
                } else if (line.startsWith("data: ")) {
                  // Accumulate multi-line data per SSE spec
                  dataLine += (dataLine ? "\n" : "") + line.slice("data: ".length);
                }
              }

              if (!dataLine) continue;

              // Handle [DONE] sentinel
              if (dataLine === "[DONE]") {
                if (mountedRef.current) {
                  setIsStreaming(false);
                  setActiveToolName(null);
                }
                continue;
              }

              let parsed: Record<string, unknown>;
              try {
                parsed = JSON.parse(dataLine);
              } catch {
                console.error("Failed to parse SSE data:", dataLine);
                continue;
              }

              const resolvedType = eventType || parsed.type;

              switch (resolvedType) {
                case "system": {
                  if (parsed.subtype === "init" && typeof parsed.session_id === "string") {
                    sessionIdRef.current = parsed.session_id;
                  }
                  break;
                }

                case "stream_event": {
                  const event = parsed.event as
                    | {
                        type: string;
                        content_block?: { type: string; name?: string };
                        delta?: { type: string; text?: string };
                      }
                    | undefined;

                  // Detect tool use start immediately from content_block_start
                  if (
                    event?.type === "content_block_start" &&
                    event.content_block?.type === "tool_use" &&
                    event.content_block.name
                  ) {
                    if (mountedRef.current) {
                      setActiveToolName(event.content_block.name);
                    }
                  }

                  if (
                    event?.type === "content_block_delta" &&
                    event.delta?.type === "text_delta" &&
                    event.delta.text
                  ) {
                    const text = event.delta.text;
                    if (mountedRef.current) {
                      setMessages((prev) => {
                        const updated = [...prev];
                        const last = updated[updated.length - 1];
                        if (last?.role === "assistant") {
                          updated[updated.length - 1] = {
                            ...last,
                            content: last.content + text,
                          };
                        }
                        return updated;
                      });
                    }
                  }
                  break;
                }

                case "assistant": {
                  const message = parsed.message as
                    | { content: Array<{ type: string; text?: string }> }
                    | undefined;
                  if (!message?.content) break;
                  const textContent = message.content
                    .filter((c) => c.type === "text" && c.text)
                    .map((c) => c.text ?? "")
                    .join("");
                  if (textContent && mountedRef.current) {
                    setMessages((prev) => {
                      const updated = [...prev];
                      const last = updated[updated.length - 1];
                      if (last?.role === "assistant") {
                        updated[updated.length - 1] = { ...last, content: textContent };
                      }
                      return updated;
                    });
                  }
                  break;
                }

                case "tool_progress": {
                  if (typeof parsed.tool_name === "string" && mountedRef.current) {
                    setActiveToolName(parsed.tool_name);
                  }
                  break;
                }

                case "tool_result": {
                  if (mountedRef.current) {
                    setActiveToolName(null);
                  }
                  break;
                }

                case "file_created": {
                  if (
                    typeof parsed.filename === "string" &&
                    typeof parsed.downloadUrl === "string" &&
                    mountedRef.current
                  ) {
                    const url = parsed.downloadUrl as string;
                    setCreatedFiles((prev) =>
                      prev.some((f) => f.downloadUrl === url)
                        ? prev
                        : [...prev, { filename: parsed.filename as string, downloadUrl: url }],
                    );
                  }
                  break;
                }

                case "result": {
                  const totalCost = typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : 0;
                  const usageData = parsed.usage as
                    | { input_tokens: number; output_tokens: number }
                    | undefined;
                  const durationMs = typeof parsed.duration_ms === "number" ? parsed.duration_ms : 0;
                  if (mountedRef.current) {
                    setUsage({
                      totalCostUsd: totalCost,
                      inputTokens: usageData?.input_tokens ?? 0,
                      outputTokens: usageData?.output_tokens ?? 0,
                      durationMs: durationMs,
                    });
                    setIsStreaming(false);
                    setActiveToolName(null);
                  }
                  break;
                }

                case "error": {
                  const message = typeof parsed.message === "string" ? parsed.message : "Unknown error";
                  if (mountedRef.current) {
                    setError(message);
                    setIsStreaming(false);
                    setActiveToolName(null);
                  }
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
          } else if (mountedRef.current) {
            setError(err instanceof Error ? err.message : "Unknown error");
          }
          if (mountedRef.current) {
            setIsStreaming(false);
            setActiveToolName(null);
          }
        }
      })();
    },
    [],
  );

  return { messages, isStreaming, error, usage, activeToolName, createdFiles, sendMessage, abort };
}
