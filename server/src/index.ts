import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AgentRequest } from "shared";
import {
  createSession,
  deleteSession,
  feedFollowUp,
  getSession,
  type Session,
} from "./sessions";

const app = new Hono();

const FORWARDED_TYPES = new Set([
  "system",
  "stream_event",
  "assistant",
  "result",
]);

app.post("/api/agent", async (c) => {
  // Parse body BEFORE entering streamSSE — body stream is consumed by the response
  const body = await c.req.json<AgentRequest>();

  if (!body.prompt?.trim()) {
    return c.json({ error: "prompt is required" }, 400);
  }

  let session: Session;
  let isFollowUp = false;

  if (body.sessionId) {
    const existing = getSession(body.sessionId);
    if (!existing) {
      return c.json({ error: "Session not found" }, 404);
    }
    if (existing.streaming) {
      return c.json({ error: "Session is currently streaming" }, 409);
    }
    session = existing;
    isFollowUp = true;
  } else {
    session = createSession(body.prompt);
  }

  session.streaming = true;

  // For follow-ups, enqueue the message into the session's queue
  if (isFollowUp) {
    feedFollowUp(session, body.prompt);
  }

  let aborted = false;

  return streamSSE(
    c,
    async (stream) => {
      stream.onAbort(() => {
        aborted = true;
        session.streaming = false;
      });

      try {
        // Use manual .next() instead of for-await to avoid closing the generator
        while (true) {
          if (aborted) break;

          const { value: msg, done } = await session.query.next();
          if (done) {
            deleteSession(session.id);
            break;
          }

          // Capture SDK session ID from init message
          if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
            session.sdkSessionId = msg.session_id;
          }

          // Forward only relevant event types to client
          if (FORWARDED_TYPES.has(msg.type)) {
            // Override session_id with our ID so client can use it for follow-ups
            const clientMsg = { ...msg, session_id: session.id };
            await stream.writeSSE({
              event: msg.type,
              data: JSON.stringify(clientMsg),
            });
          }

          // Stop iterating after result — keep query alive for follow-ups
          if (msg.type === "result") {
            break;
          }
        }
      } catch (err) {
        console.error("[POST /api/agent] error:", err);
        const message = err instanceof Error ? err.message : "Unknown error";
        try {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ type: "error", message }),
          });
        } catch {
          // Stream may already be closed
        }
        deleteSession(session.id);
      } finally {
        session.streaming = false;
        try {
          await stream.writeSSE({ data: "[DONE]" });
        } catch {
          // Stream may already be closed
        }
      }
    },
    async (err) => {
      console.error("SSE stream error:", err);
    },
  );
});

app.get("/", (c) => c.text("duvo-test server"));

export default {
  port: 3001,
  fetch: app.fetch,
  idleTimeout: 0,
};
