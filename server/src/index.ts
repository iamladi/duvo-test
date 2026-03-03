import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { readdirSync } from "fs";
import { join, resolve } from "path";
import type { AgentRequest } from "shared";
import {
  createSession,
  deleteSession,
  feedFollowUp,
  getSession,
  SESSION_BASE,
  type Session,
} from "./sessions";

const app = new Hono();

const FORWARDED_TYPES = new Set([
  "system",
  "stream_event",
  "assistant",
  "result",
  "tool_progress",
  "tool_use_summary",
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
    session = createSession(body.prompt, body.systemPrompt);
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

          // Detect file persistence via SDKFilesPersistedEvent
          // type: "system", subtype: "files_persisted"
          if (
            msg.type === "system" &&
            "subtype" in msg &&
            msg.subtype === "files_persisted" &&
            "files" in msg &&
            Array.isArray(msg.files)
          ) {
            for (const file of msg.files as Array<{ filename: string }>) {
              if (file.filename) {
                await stream.writeSSE({
                  event: "file_created",
                  data: JSON.stringify({
                    type: "file_created",
                    filename: file.filename,
                    downloadUrl: `/api/files/${session.id}/${file.filename}`,
                  }),
                });
              }
            }
          }

          // Forward relevant event types to client
          if (FORWARDED_TYPES.has(msg.type)) {
            const clientMsg = { ...msg, session_id: session.id };
            await stream.writeSSE({
              event: msg.type,
              data: JSON.stringify(clientMsg),
            });
          }

          // After result: scan session directory for any created files and emit file_created
          if (msg.type === "result") {
            try {
              const files = readdirSync(session.sessionDir);
              for (const filename of files) {
                await stream.writeSSE({
                  event: "file_created",
                  data: JSON.stringify({
                    type: "file_created",
                    filename,
                    downloadUrl: `/api/files/${session.id}/${filename}`,
                  }),
                });
              }
            } catch {
              // Session dir may not exist or be empty — not an error
            }
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

app.get("/api/files/:sessionId/:filename", async (c) => {
  const { sessionId, filename } = c.req.param();

  // Path traversal prevention
  if (
    !sessionId ||
    !filename ||
    sessionId.includes("..") ||
    filename.includes("..") ||
    sessionId.includes("/") ||
    filename.includes("/")
  ) {
    return c.json({ error: "Invalid path" }, 400);
  }

  const filePath = resolve(join(SESSION_BASE, sessionId, filename));
  const expectedBase = resolve(join(SESSION_BASE, sessionId));

  if (!filePath.startsWith(expectedBase + "/") && filePath !== expectedBase) {
    return c.json({ error: "Access denied" }, 403);
  }

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return c.json({ error: "File not found" }, 404);
  }

  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const mimeTypes: Record<string, string> = {
    csv: "text/csv",
    txt: "text/plain",
    json: "application/json",
    md: "text/markdown",
  };

  return new Response(file.stream(), {
    headers: {
      "Content-Type": mimeTypes[ext] ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(file.size),
    },
  });
});

app.get("/", (c) => c.text("duvo-test server"));

export default {
  port: 3001,
  fetch: app.fetch,
  idleTimeout: 0,
};
