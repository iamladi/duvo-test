import { describe, expect, it, mock } from "bun:test";
import type { EvaluationResult } from "shared";
import type { Session } from "./sessions";

// ── helpers ────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: "sess-1",
		sdkSessionId: "sdk-1",
		query: {} as Session["query"],
		queue: {} as Session["queue"],
		streaming: false,
		ttlTimer: setTimeout(() => {}, 0),
		sessionDir: "/tmp/duvo-sessions/sess-1",
		originalPrompt: "List files in /tmp",
		currentPrompt: "List files in /tmp",
		...overrides,
	};
}

function makeSdkResultMessage(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		type: "result",
		subtype: "success",
		result: "I listed the files in /tmp. Found: foo.txt, bar.csv",
		num_turns: 2,
		total_cost_usd: 0.0001,
		duration_ms: 3000,
		usage: {
			input_tokens: 100,
			output_tokens: 50,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
		},
		...overrides,
	};
}

// ── mock helpers ───────────────────────────────────────────────────────────

async function* makeQueryGen(judgeJson: object | null) {
	yield { type: "system", subtype: "init" };
	yield {
		type: "result",
		result: judgeJson !== null ? JSON.stringify(judgeJson) : "",
	};
}

async function* makeQueryGenRaw(text: string) {
	yield { type: "system", subtype: "init" };
	yield { type: "result", result: text };
}

function mockQuery(gen: AsyncGenerator) {
	mock.module("@anthropic-ai/claude-agent-sdk", () => ({
		query: () => gen,
	}));
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("evaluate()", () => {
	it("returns a passing EvaluationResult on successful haiku response", async () => {
		mockQuery(makeQueryGen({ passed: true, confidence: 0.9, reasoning: "The agent completed the task." }));

		const { evaluate } = await import("./evaluator");
		const result: EvaluationResult = await evaluate(makeSdkResultMessage(), makeSession());

		expect(result.status).toBe("ok");
		expect(result.passed).toBe(true);
		expect(result.confidence).toBe(0.9);
		expect(result.reasoning).toBe("The agent completed the task.");
		expect(result.evaluatedBy).toBe("llm");
	});

	it("returns error result when result text is empty", async () => {
		mockQuery(makeQueryGen(null));

		const { evaluate } = await import("./evaluator");
		const result = await evaluate(makeSdkResultMessage(), makeSession());

		expect(result.status).toBe("error");
		expect(result.passed).toBe(false);
		expect(result.confidence).toBe(0);
	});

	it("returns error result when response is not valid JSON", async () => {
		mockQuery(makeQueryGenRaw("I cannot evaluate this."));

		const { evaluate } = await import("./evaluator");
		const result = await evaluate(makeSdkResultMessage(), makeSession());

		expect(result.status).toBe("error");
	});

	it("clamps confidence to [0, 1]", async () => {
		mockQuery(makeQueryGen({ passed: true, confidence: 1.5, reasoning: "done" }));

		const { evaluate } = await import("./evaluator");
		const result = await evaluate(makeSdkResultMessage(), makeSession());

		expect(result.confidence).toBe(1);
	});

	it("handles undefined result text gracefully (error subtype)", async () => {
		mockQuery(makeQueryGen({ passed: false, confidence: 0.3, reasoning: "No output produced." }));

		const { evaluate } = await import("./evaluator");
		const result = await evaluate(
			makeSdkResultMessage({ subtype: "error_max_turns", result: undefined }),
			makeSession(),
		);

		expect(result.status).toBe("ok");
		expect(result.passed).toBe(false);
	});

	it("returns error result when query throws", async () => {
		mock.module("@anthropic-ai/claude-agent-sdk", () => ({
			query: () => { throw new Error("spawn failed"); },
		}));

		const { evaluate } = await import("./evaluator");
		const result = await evaluate(makeSdkResultMessage(), makeSession());

		expect(result.status).toBe("error");
	});

	it("returns a failing EvaluationResult on failed task", async () => {
		mockQuery(makeQueryGen({ passed: false, confidence: 0.2, reasoning: "Task was not completed." }));

		const { evaluate } = await import("./evaluator");
		const result = await evaluate(makeSdkResultMessage(), makeSession());

		expect(result.status).toBe("ok");
		expect(result.passed).toBe(false);
	});
});
