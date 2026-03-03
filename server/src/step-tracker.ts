import type {
	StepId,
	TurnId,
	StepType,
	SSEEvent,
	StepStartEvent,
} from "shared";

/**
 * Converts raw SDK messages into structured step events.
 * One instance per active session/streaming request.
 */
export class StepTracker {
	private currentTurnId: TurnId = "";
	private stepCounter = 0;
	private activeSteps = new Map<number, StepId>();

	process(sdkMessage: Record<string, unknown>): SSEEvent[] {
		const events: SSEEvent[] = [];

		// Always emit the raw SDK event
		events.push({
			event: "sdk",
			data: {
				type: sdkMessage.type as string,
				serverTimestamp: Date.now(),
				payload: sdkMessage,
			},
		});

		switch (sdkMessage.type) {
			case "system":
				if (sdkMessage.subtype === "init") {
					events.push({
						event: "session:init",
						data: {
							sessionId: sdkMessage.session_id as string,
							model: sdkMessage.model as string,
							tools: (sdkMessage.tools as string[]) ?? [],
							timestamp: Date.now(),
						},
					});
				}
				break;

			case "stream_event":
				events.push(
					...this.processStreamEvent(
						sdkMessage.event as Record<string, unknown>,
					),
				);
				break;

			case "assistant":
				events.push({
					event: "turn:complete",
					data: {
						turnId: this.currentTurnId,
						stopReason:
							((sdkMessage.message as Record<string, unknown>)
								?.stop_reason as string) ?? "unknown",
						timestamp: Date.now(),
					},
				});
				break;

			case "user":
				events.push(...this.processToolResults(sdkMessage));
				break;

			case "result":
				events.push({
					event: "result",
					data: {
						subtype: sdkMessage.subtype as
							| "success"
							| "error_max_turns"
							| "error_during_execution"
							| "error_max_budget_usd",
						result: sdkMessage.result as string | undefined,
						totalCostUsd: sdkMessage.total_cost_usd as number,
						durationMs: sdkMessage.duration_ms as number,
						numTurns: sdkMessage.num_turns as number,
						usage: {
							inputTokens: (sdkMessage.usage as Record<string, number>)
								.input_tokens,
							outputTokens: (sdkMessage.usage as Record<string, number>)
								.output_tokens,
							cacheCreationInputTokens: (
								sdkMessage.usage as Record<string, number>
							).cache_creation_input_tokens,
							cacheReadInputTokens: (
								sdkMessage.usage as Record<string, number>
							).cache_read_input_tokens,
						},
					},
				});
				events.push({ event: "done", data: "[DONE]" });
				break;
		}

		return events;
	}

	private processStreamEvent(
		event: Record<string, unknown>,
	): SSEEvent[] {
		const events: SSEEvent[] = [];

		switch (event.type) {
			case "message_start": {
				this.currentTurnId = `turn_${Date.now()}`;
				events.push({
					event: "turn:start",
					data: { turnId: this.currentTurnId, timestamp: Date.now() },
				});
				break;
			}

			case "content_block_start": {
				const stepId: StepId = `step_${++this.stepCounter}`;
				const index = event.index as number;
				this.activeSteps.set(index, stepId);
				const block = event.content_block as Record<string, unknown>;

				const stepData: StepStartEvent["data"] = {
					stepId,
					turnId: this.currentTurnId,
					type: this.blockTypeToStepType(block.type as string),
					blockIndex: index,
					timestamp: Date.now(),
				};

				if (block.type === "tool_use") {
					stepData.toolName = block.name as string;
					stepData.toolCallId = block.id as string;
				}

				events.push({ event: "step:start", data: stepData });
				break;
			}

			case "content_block_delta": {
				const index = event.index as number;
				const stepId = this.activeSteps.get(index);
				if (!stepId) break;

				const delta = event.delta as Record<string, unknown>;
				let deltaText = "";
				let deltaType: "text" | "thinking" | "input_json" = "text";

				if (delta.type === "text_delta") {
					deltaText = delta.text as string;
					deltaType = "text";
				} else if (delta.type === "thinking_delta") {
					deltaText = delta.thinking as string;
					deltaType = "thinking";
				} else if (delta.type === "input_json_delta") {
					deltaText = delta.partial_json as string;
					deltaType = "input_json";
				}

				events.push({
					event: "step:delta",
					data: { stepId, delta: deltaText, deltaType, timestamp: Date.now() },
				});
				break;
			}

			case "content_block_stop": {
				const index = event.index as number;
				const stepId = this.activeSteps.get(index);
				if (!stepId) break;
				this.activeSteps.delete(index);

				events.push({
					event: "step:complete",
					data: { stepId, timestamp: Date.now() },
				});
				break;
			}
		}

		return events;
	}

	private blockTypeToStepType(blockType: string): StepType {
		switch (blockType) {
			case "thinking":
				return "thinking";
			case "tool_use":
				return "tool_use";
			case "text":
			default:
				return "text";
		}
	}

	private processToolResults(
		userMessage: Record<string, unknown>,
	): SSEEvent[] {
		const events: SSEEvent[] = [];
		const message = userMessage.message as Record<string, unknown> | undefined;
		const content = (message?.content as Array<Record<string, unknown>>) ?? [];

		for (const block of content) {
			if (block.type === "tool_result") {
				const stepId: StepId = `step_${++this.stepCounter}`;
				events.push({
					event: "step:start",
					data: {
						stepId,
						turnId: this.currentTurnId,
						type: "tool_result",
						blockIndex: -1,
						toolCallId: block.tool_use_id as string,
						timestamp: Date.now(),
					},
				});
				events.push({
					event: "step:complete",
					data: { stepId, timestamp: Date.now() },
				});
			}
		}

		return events;
	}
}
