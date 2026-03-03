import { query } from "@anthropic-ai/claude-agent-sdk";
import { readdirSync } from "fs";
import type { EvaluationResult } from "shared";
import type { Session } from "./sessions";

const EVALUATION_TIMEOUT_MS = 30_000;

const JUDGE_SYSTEM_PROMPT =
	"You are a JSON-only evaluator. Respond with exactly one JSON object and no other text.";

function buildJudgePrompt(
	currentPrompt: string,
	resultText: string | undefined,
	files: string[],
	numTurns: number,
	totalCostUsd: number,
): string {
	const fileList =
		files.length > 0 ? files.map((f) => `- ${f}`).join("\n") : "(none)";

	return `You are an impartial judge evaluating whether an AI agent completed a user task.

USER TASK:
${currentPrompt}

AGENT RESULT:
${resultText ?? "(no result text — agent may have ended with an error)"}

FILES CREATED IN SESSION:
${fileList}

EFFICIENCY METRICS:
- Turns used: ${numTurns}
- Total cost: $${totalCostUsd.toFixed(6)}

Evaluate whether the agent successfully completed the user's task. Consider:
1. Did the agent's result text directly address the user's task?
2. If the task required file creation, was a relevant file created?
3. Is the result coherent and substantive (not empty or an error message)?

Respond with a JSON object only — no other text:
{
  "passed": true or false,
  "confidence": 0.0 to 1.0,
  "reasoning": "one sentence explaining your verdict"
}`;
}

export async function evaluate(
	sdkMessage: Record<string, unknown>,
	session: Session,
): Promise<EvaluationResult> {
	const errorResult: EvaluationResult = {
		passed: false,
		confidence: 0,
		reasoning: "Evaluation failed",
		evaluatedBy: "llm",
		status: "error",
	};

	try {
		const resultText = sdkMessage.result as string | undefined;
		const numTurns = (sdkMessage.num_turns as number) ?? 0;
		const totalCostUsd = (sdkMessage.total_cost_usd as number) ?? 0;

		let files: string[] = [];
		try {
			files = readdirSync(session.sessionDir);
		} catch {
			// sessionDir may not exist for short sessions
		}

		const judgePrompt = buildJudgePrompt(
			session.currentPrompt,
			resultText,
			files,
			numTurns,
			totalCostUsd,
		);

		const ac = new AbortController();
		const timeoutId = setTimeout(() => {
			console.error("[evaluator] timed out after", EVALUATION_TIMEOUT_MS, "ms");
			ac.abort();
		}, EVALUATION_TIMEOUT_MS);

		let judgeText = "";

		try {
			const q = query({
				prompt: judgePrompt,
				options: {
					model: "claude-haiku-4-5-20251001",
					maxTurns: 1,
					permissionMode: "bypassPermissions",
					allowDangerouslySkipPermissions: true,
					allowedTools: [],
					systemPrompt: JUDGE_SYSTEM_PROMPT,
					env: { ...process.env, CLAUDECODE: undefined },
					abortController: ac,
				},
			});

			for await (const msg of q) {
				const m = msg as Record<string, unknown>;
				if (m.type === "result") {
					judgeText = (m.result as string) ?? "";
					break;
				}
			}
		} finally {
			clearTimeout(timeoutId);
		}

		if (!judgeText) {
			return errorResult;
		}

		// Extract JSON from haiku response (may have surrounding text)
		const jsonMatch = judgeText.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			return errorResult;
		}

		const parsed = JSON.parse(jsonMatch[0]) as {
			passed?: boolean;
			confidence?: number;
			reasoning?: string;
		};

		return {
			passed: Boolean(parsed.passed),
			confidence:
				typeof parsed.confidence === "number"
					? Math.max(0, Math.min(1, parsed.confidence))
					: 0,
			reasoning:
				typeof parsed.reasoning === "string"
					? parsed.reasoning
					: "No reasoning provided",
			evaluatedBy: "llm",
			status: "ok",
		};
	} catch (err) {
		console.error(
			"[evaluator] evaluation failed:",
			err instanceof Error ? err.message : err,
		);
		return errorResult;
	}
}
