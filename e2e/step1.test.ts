/**
 * Step 1 E2E tests — basic agent chat UI
 *
 * Requires dev servers running: bun run dev
 * Run tests: bun test e2e/step1.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  assertServersUp,
  click,
  fill,
  open,
  screenshot,
  snapshot,
  waitForSnapshot,
} from "./helpers";

const INPUT = 'input[type="text"]';

/** Wait for streaming to finish: Stop button gone means response is complete. */
async function waitForIdle(timeoutMs = 20_000): Promise<string> {
  return waitForSnapshot(
    (s) => !s.includes('"Stop"'),
    timeoutMs,
  );
}

/** Send a message and wait for the full response (streaming complete). */
async function sendAndWait(text: string, timeoutMs = 20_000): Promise<string> {
  await fill(INPUT, text);
  await click("button");
  return waitForIdle(timeoutMs);
}

beforeAll(async () => {
  await assertServersUp();
  await open();
  // Ensure we start from idle state
  await waitForIdle(5_000).catch(() => {});
});

afterAll(async () => {
  await screenshot("/tmp/duvo-e2e-final.png").catch(() => {});
});

describe("Step 1: chat UI", () => {
  test("page renders with empty state", async () => {
    await open();
    const snap = await snapshot();
    expect(snap).toContain("Send a message to start");
    expect(snap).toContain('textbox "Type a message..."');
    expect(snap).toMatch(/button "Send".*\[disabled\]/);
  });

  test("Send button enables when input has text", async () => {
    await fill(INPUT, "hello");
    const snap = await snapshot();
    expect(snap).toContain('button "Send"');
    expect(snap).not.toMatch(/button "Send".*\[disabled\]/);
    // Clear input
    await fill(INPUT, "");
  });

  test("sends a message and receives a response", async () => {
    const snap = await sendAndWait("respond with exactly the word: pong");
    // User message visible in chat
    expect(snap).toContain("respond with exactly the word: pong");
    // Assistant responded
    expect(snap.toLowerCase()).toContain("pong");
  });

  test("input is clear and re-enabled after response", async () => {
    const snap = await snapshot();
    // Input is enabled (no [disabled] on the textbox line)
    expect(snap).not.toMatch(/textbox[^\n]*\[disabled\]/);
    // Send button disabled because input is empty
    expect(snap).toMatch(/button "Send"[^\n]*\[disabled\]/);
  });

  test("shows cost and token usage after response", async () => {
    const snap = await snapshot();
    expect(snap).toMatch(/Cost: \$[\d.]+/);
    expect(snap).toMatch(/In: \d+ tokens/);
    expect(snap).toMatch(/Out: \d+ tokens/);
    expect(snap).toMatch(/Time: [\d.]+s/);
  });

  test("multi-turn: follow-up message uses same session", async () => {
    await sendAndWait("my secret number is 42, remember it");

    const snap = await sendAndWait("what is my secret number?");
    expect(snap).toContain("42");
  });

  test("abort stops streaming", async () => {
    await fill(INPUT, "count slowly from 1 to 100, one number per line");
    await click("button");

    // Wait for streaming to start (Stop button appears)
    await waitForSnapshot((s) => s.includes("Stop"), 10_000);

    // Click Stop
    await click("button");

    // Streaming should end — Stop disappears, input re-enabled
    const snap = await waitForIdle(8_000);
    expect(snap).not.toContain('"Stop"');
    expect(snap).not.toMatch(/textbox[^\n]*\[disabled\]/);
  });
});
