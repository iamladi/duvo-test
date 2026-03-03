/**
 * Step 1.5 E2E tests — tool use, file output & download
 *
 * Requires dev servers running: bun run dev
 * Run tests: bun test e2e/step1.5.test.ts
 *
 * Some tests call the agent API directly (no browser needed).
 * Browser tests use agent-browser and require dev servers + Chromium.
 *
 * Expected runtimes:
 *   - Security / API tests: < 10s each
 *   - Write tool + UI: ~30s
 *   - Primary CSV demo: 60-150s (real web search)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  assertServersUp,
  click,
  fill,
  open,
  screenshot,
  waitForSnapshot,
} from "./helpers";

const INPUT = 'input[type="text"]';
const SERVER = "http://localhost:3001";

/** Wait for the Stop button to disappear (streaming complete). */
async function waitForIdle(timeoutMs = 120_000): Promise<string> {
  return waitForSnapshot((s) => !s.includes('"Stop"'), timeoutMs);
}

/** Fill input, click Send, wait for full response. */
async function sendAndWait(text: string, timeoutMs = 120_000): Promise<string> {
  await fill(INPUT, text);
  await click("button");
  return waitForIdle(timeoutMs);
}

/**
 * POST to /api/agent and consume the full SSE stream.
 * Returns all parsed JSON events.
 */
async function runAgentRequest(
  body: Record<string, unknown>,
  timeoutMs = 120_000,
): Promise<Array<Record<string, unknown>>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(`${SERVER}/api/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error("No response body");

    const events: Array<Record<string, unknown>> = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";

      for (const part of parts) {
        const dataLine = part
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice("data: ".length))
          .join("\n");

        if (!dataLine || dataLine === "[DONE]") continue;
        try {
          events.push(JSON.parse(dataLine));
        } catch {
          // ignore malformed lines
        }
      }
    }

    return events;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await assertServersUp();
});

afterAll(async () => {
  await screenshot("/tmp/duvo-e2e-step1.5-final.png").catch(() => {});
});

// ---------------------------------------------------------------------------
// Group 1: Download endpoint security — no browser, no agent call
// ---------------------------------------------------------------------------

describe("Step 1.5: download endpoint security", () => {
  // Hono normalizes percent-encoded dots at the routing layer, so path
  // traversal attempts never result in a 200 — they hit 400 or 404.

  test("blocks %2e%2e traversal in sessionId (not 200)", async () => {
    const r = await fetch(`${SERVER}/api/files/%2e%2e/passwd`);
    expect(r.status).not.toBe(200);
  });

  test("blocks %2e%2e traversal in filename (not 200)", async () => {
    const r = await fetch(
      `${SERVER}/api/files/00000000-0000-0000-0000-000000000000/%2e%2e%2fetc%2fpasswd`,
    );
    expect(r.status).not.toBe(200);
  });

  test("plain ../ traversal is blocked (not 200)", async () => {
    // HTTP clients normalize ../ before sending; Hono then returns 404.
    const r = await fetch(`${SERVER}/api/files/../../../etc/passwd`);
    expect(r.status).not.toBe(200);
  });

  test("encoded slash in filename is blocked (400 or 404)", async () => {
    // %2f decodes to /; Hono may pass it through to our handler → 400
    const r = await fetch(
      `${SERVER}/api/files/00000000-0000-0000-0000-000000000000/..%2fetc%2fpasswd`,
    );
    expect(r.status).not.toBe(200);
  });

  test("returns 404 for valid UUID session with missing file", async () => {
    const r = await fetch(
      `${SERVER}/api/files/00000000-0000-0000-0000-000000000000/missing.csv`,
    );
    expect(r.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Group 2: API contract — no browser
// ---------------------------------------------------------------------------

describe("Step 1.5: API contract", () => {
  test("POST /api/agent accepts systemPrompt field without error", async () => {
    const events = await runAgentRequest(
      {
        prompt: "say ok",
        systemPrompt:
          "You are a terse assistant. Always respond with exactly the word: ok",
      },
      60_000,
    );

    const types = events.map((e) => e.type);
    expect(types).not.toContain("error");
    expect(types).toContain("result");
  }, 60_000);

  test("file_created event emitted after Write tool creates a file", async () => {
    const events = await runAgentRequest(
      {
        prompt:
          "Use the Write tool to create a file called e2e_test.txt containing exactly: e2e ok",
      },
      90_000,
    );

    const types = events.map((e) => e.type);
    expect(types).not.toContain("error");

    const fileEvent = events.find((e) => e.type === "file_created");
    expect(fileEvent).toBeDefined();
    expect(typeof fileEvent?.filename).toBe("string");
    expect(fileEvent?.downloadUrl as string).toMatch(
      /^\/api\/files\/[^/]+\/[^/]+$/,
    );
  }, 90_000);

  test("created file is downloadable from /api/files endpoint", async () => {
    const events = await runAgentRequest(
      {
        prompt:
          "Use the Write tool to create a file called download_check.txt containing exactly: download ok",
      },
      90_000,
    );

    const fileEvent = events.find((e) => e.type === "file_created");
    expect(fileEvent).toBeDefined();

    const url = `${SERVER}${fileEvent!.downloadUrl as string}`;
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");

    const text = await res.text();
    expect(text).toContain("download ok");
  }, 90_000);
});

// ---------------------------------------------------------------------------
// Group 3: Browser UI — tool status + download button
// ---------------------------------------------------------------------------

describe("Step 1.5: browser UI", () => {
  beforeAll(async () => {
    await open();
    await waitForIdle(5_000).catch(() => {});
  });

  test("tool name appears in UI during tool execution", async () => {
    await open();
    await fill(
      INPUT,
      "Use the Write tool to create a file called ui_test.txt containing: ui ok",
    );
    await click("button");

    // content_block_start with tool_use fires as soon as the agent decides to call a tool
    // Poll fast (200ms) to catch the transient status line
    const toolSnap = await waitForSnapshot(
      (s) => s.toLowerCase().includes("using"),
      60_000,
      200,
    );
    expect(toolSnap.toLowerCase()).toMatch(/using \w+/);

    await waitForIdle(90_000);
  }, 120_000);

  test("download button appears in UI after file creation", async () => {
    await open();
    const snap = await sendAndWait(
      "Use the Write tool to create a file called ui_download.txt containing: ui download ok",
      90_000,
    );

    expect(snap.toLowerCase()).toContain("download");
    expect(snap).toContain("ui_download.txt");
  }, 120_000);

  test("primary demo: fetch AI news and save as CSV", async () => {
    await open();
    const snap = await sendAndWait(
      "Fetch the latest AI news from the web and save them into a CSV file called ai_news.csv",
      150_000,
    );

    expect(snap.toLowerCase()).toContain("download");
    expect(snap).toContain("ai_news.csv");
  }, 180_000);
});
