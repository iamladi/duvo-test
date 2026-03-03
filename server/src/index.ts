import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { readdirSync } from "fs";
import { join, resolve } from "path";
import type { AgentRequest, SSEEvent } from "shared";
import { StepTracker } from "./step-tracker";
import {
	createSession,
	deleteSession,
	feedFollowUp,
	getSession,
	SESSION_BASE,
	type Session,
} from "./sessions";

const app = new Hono();

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000];

function isTransientError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const msg = err.message.toLowerCase();
	return (
		msg.includes("internal server error") ||
		msg.includes("overloaded") ||
		msg.includes("econnreset") ||
		msg.includes("econnrefused") ||
		msg.includes("etimedout") ||
		msg.includes("fetch failed")
	);
}

function isAuthError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const msg = err.message.toLowerCase();
	return msg.includes("401") || msg.includes("403") || msg.includes("unauthorized") || msg.includes("forbidden");
}

function isRateLimitError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return err.message.toLowerCase().includes("429") || err.message.toLowerCase().includes("rate limit");
}

async function nextWithRetry(
	query: Session["query"],
): Promise<IteratorResult<unknown>> {
	let lastError: unknown;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			return await query.next();
		} catch (err) {
			lastError = err;

			if (isAuthError(err)) throw err;
			if (!isTransientError(err) && !isRateLimitError(err)) throw err;

			if (attempt < MAX_RETRIES) {
				const delay = isRateLimitError(err)
					? RETRY_DELAYS[attempt] * 2
					: RETRY_DELAYS[attempt];
				console.warn(
					`[retry] attempt ${attempt + 1}/${MAX_RETRIES}, waiting ${delay}ms:`,
					err instanceof Error ? err.message : err,
				);
				await new Promise((r) => setTimeout(r, delay));
			}
		}
	}

	throw lastError;
}

async function emitSSEEvent(
	stream: { writeSSE: (msg: { event?: string; data: string }) => Promise<void> },
	sseEvent: SSEEvent,
): Promise<void> {
	if (sseEvent.event === "done") {
		await stream.writeSSE({ data: "[DONE]" });
	} else {
		await stream.writeSSE({
			event: sseEvent.event,
			data: JSON.stringify(sseEvent.data),
		});
	}
}

app.post("/api/agent", async (c) => {
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

	if (isFollowUp) {
		feedFollowUp(session, body.prompt);
	}

	let aborted = false;
	const tracker = new StepTracker();

	return streamSSE(
		c,
		async (stream) => {
			stream.onAbort(() => {
				aborted = true;
				session.streaming = false;
			});

			try {
				while (true) {
					if (aborted) break;

					const { value: msg, done } = await nextWithRetry(session.query);
					if (done) {
						deleteSession(session.id);
						break;
					}

					const sdkMessage = msg as Record<string, unknown>;

					// Capture SDK session ID from init message
					if (
						sdkMessage.type === "system" &&
						sdkMessage.subtype === "init"
					) {
						session.sdkSessionId = sdkMessage.session_id as string;
					}

					// Detect file persistence
					if (
						sdkMessage.type === "system" &&
						sdkMessage.subtype === "files_persisted" &&
						Array.isArray(sdkMessage.files)
					) {
						for (const file of sdkMessage.files as Array<{
							filename: string;
						}>) {
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

					// Process through StepTracker for dual-layer events
					const sseEvents = tracker.process(sdkMessage);
					for (const sseEvent of sseEvents) {
						// Override session:init sessionId with the server's session ID
						// (StepTracker uses SDK session ID, clients need server ID for follow-ups)
						if (sseEvent.event === "session:init") {
							(sseEvent.data as { sessionId: string }).sessionId =
								session.id;
						}
						try {
							await emitSSEEvent(stream, sseEvent);
						} catch {
							// Stream may be closed
							break;
						}
					}

					// After result: scan session directory for created files
					if (sdkMessage.type === "result") {
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
							// Session dir may not exist
						}
						// result event already emits done via StepTracker
						break;
					}
				}
			} catch (err) {
				console.error("[POST /api/agent] error:", err);
				const message = err instanceof Error ? err.message : "Unknown error";
				const code = isAuthError(err)
					? "auth_error"
					: isRateLimitError(err)
						? "rate_limit"
						: "server_error";
				try {
					await emitSSEEvent(stream, {
						event: "error",
						data: { message, code, timestamp: Date.now() },
					});
					await emitSSEEvent(stream, { event: "done", data: "[DONE]" });
				} catch {
					// Stream may already be closed
				}
				deleteSession(session.id);
			} finally {
				session.streaming = false;
				// done is emitted by StepTracker on result, or by error handler above
				// Only emit done as fallback if we haven't already
				try {
					await stream.writeSSE({ data: "[DONE]" });
				} catch {
					// Already closed or done was already sent
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

	if (!filePath.startsWith(`${expectedBase}/`) && filePath !== expectedBase) {
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
