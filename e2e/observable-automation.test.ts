/**
 * Step 3 E2E tests — observable automation view
 *
 * Requires dev servers running: bun run dev
 * Run tests: bun test e2e/observable-automation.test.ts --timeout 60000
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

async function waitForIdle(timeoutMs = 30_000): Promise<string> {
	return waitForSnapshot((s) => !s.includes('"Stop"'), timeoutMs);
}

async function sendAndWait(
	text: string,
	timeoutMs = 30_000,
): Promise<string> {
	await fill(INPUT, text);
	await click("button");
	return waitForIdle(timeoutMs);
}

beforeAll(async () => {
	await assertServersUp();
	await open();
	await waitForIdle(5_000).catch(() => {});
});

afterAll(async () => {
	await screenshot("/tmp/duvo-e2e-step3-final.png").catch(() => {});
});

describe("Step 3: observable automation view", () => {
	test("page renders with split pane layout", async () => {
		await open();
		const snap = await snapshot();
		expect(snap).toContain("Raw SDK Events");
		expect(snap).toContain("Send a message to start");
		expect(snap).toContain('textbox "Type a message..."');
	});

	test("sends a message and shows steps in structured view", async () => {
		const snap = await sendAndWait("respond with exactly: hello world");
		expect(snap).toContain("Text");
		expect(snap).toContain("hello world");
	});

	test("raw events appear in left pane", async () => {
		const snap = await snapshot();
		expect(snap).toContain("Raw SDK Events");
		// Should show event types
		expect(snap).toMatch(/system|stream_event|assistant|result/);
	});

	test("result footer shows cost and token usage", async () => {
		const snap = await snapshot();
		expect(snap).toMatch(/Cost:/);
		expect(snap).toMatch(/tokens/);
	});

	test("multi-turn: follow-up uses same session", async () => {
		await sendAndWait("my secret code is alpha-7, remember it");
		const snap = await sendAndWait("what is my secret code?");
		expect(snap.toLowerCase()).toContain("alpha-7");
	});
});
