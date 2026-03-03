import { describe, expect, it } from "bun:test";
import { StepTracker } from "./step-tracker";

function findEvents(events: ReturnType<StepTracker["process"]>, eventType: string) {
	return events.filter((e) => e.event === eventType);
}

describe("StepTracker", () => {
	describe("system init", () => {
		it("emits sdk + session:init for system init message", () => {
			const tracker = new StepTracker();
			const events = tracker.process({
				type: "system",
				subtype: "init",
				session_id: "sess-123",
				model: "claude-sonnet-4-6",
				tools: ["Read", "Write"],
			});

			expect(events.length).toBe(2);
			expect(events[0].event).toBe("sdk");
			expect(events[1].event).toBe("session:init");

			const init = events[1] as { event: "session:init"; data: Record<string, unknown> };
			expect(init.data.sessionId).toBe("sess-123");
			expect(init.data.model).toBe("claude-sonnet-4-6");
			expect(init.data.tools).toEqual(["Read", "Write"]);
		});

		it("emits only sdk for non-init system messages", () => {
			const tracker = new StepTracker();
			const events = tracker.process({
				type: "system",
				subtype: "files_persisted",
				files: [],
			});

			expect(events.length).toBe(1);
			expect(events[0].event).toBe("sdk");
		});
	});

	describe("stream_event: message_start", () => {
		it("emits sdk + turn:start", () => {
			const tracker = new StepTracker();
			const events = tracker.process({
				type: "stream_event",
				event: { type: "message_start" },
			});

			expect(events.length).toBe(2);
			expect(events[0].event).toBe("sdk");
			expect(events[1].event).toBe("turn:start");

			const turnStart = events[1] as { event: "turn:start"; data: Record<string, unknown> };
			expect(turnStart.data.turnId).toMatch(/^turn_/);
		});
	});

	describe("stream_event: content_block_start (text)", () => {
		it("emits sdk + step:start with type text", () => {
			const tracker = new StepTracker();
			// Start a turn first
			tracker.process({ type: "stream_event", event: { type: "message_start" } });

			const events = tracker.process({
				type: "stream_event",
				event: {
					type: "content_block_start",
					index: 0,
					content_block: { type: "text" },
				},
			});

			expect(events.length).toBe(2);
			expect(events[1].event).toBe("step:start");

			const stepStart = events[1] as { event: "step:start"; data: Record<string, unknown> };
			expect(stepStart.data.type).toBe("text");
			expect(stepStart.data.stepId).toMatch(/^step_/);
			expect(stepStart.data.blockIndex).toBe(0);
		});
	});

	describe("stream_event: content_block_start (thinking)", () => {
		it("emits step:start with type thinking", () => {
			const tracker = new StepTracker();
			tracker.process({ type: "stream_event", event: { type: "message_start" } });

			const events = tracker.process({
				type: "stream_event",
				event: {
					type: "content_block_start",
					index: 0,
					content_block: { type: "thinking" },
				},
			});

			const stepStart = events[1] as { event: "step:start"; data: Record<string, unknown> };
			expect(stepStart.data.type).toBe("thinking");
		});
	});

	describe("stream_event: content_block_start (tool_use)", () => {
		it("emits step:start with toolName and toolCallId", () => {
			const tracker = new StepTracker();
			tracker.process({ type: "stream_event", event: { type: "message_start" } });

			const events = tracker.process({
				type: "stream_event",
				event: {
					type: "content_block_start",
					index: 1,
					content_block: { type: "tool_use", name: "Read", id: "tc_123" },
				},
			});

			const stepStart = events[1] as { event: "step:start"; data: Record<string, unknown> };
			expect(stepStart.data.type).toBe("tool_use");
			expect(stepStart.data.toolName).toBe("Read");
			expect(stepStart.data.toolCallId).toBe("tc_123");
		});
	});

	describe("stream_event: content_block_delta", () => {
		it("emits step:delta for text_delta", () => {
			const tracker = new StepTracker();
			tracker.process({ type: "stream_event", event: { type: "message_start" } });
			tracker.process({
				type: "stream_event",
				event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
			});

			const events = tracker.process({
				type: "stream_event",
				event: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "Hello" },
				},
			});

			const delta = events[1] as { event: "step:delta"; data: Record<string, unknown> };
			expect(delta.event).toBe("step:delta");
			expect(delta.data.delta).toBe("Hello");
			expect(delta.data.deltaType).toBe("text");
		});

		it("emits step:delta for thinking_delta", () => {
			const tracker = new StepTracker();
			tracker.process({ type: "stream_event", event: { type: "message_start" } });
			tracker.process({
				type: "stream_event",
				event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
			});

			const events = tracker.process({
				type: "stream_event",
				event: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "thinking_delta", thinking: "Let me think..." },
				},
			});

			const delta = events[1] as { event: "step:delta"; data: Record<string, unknown> };
			expect(delta.data.deltaType).toBe("thinking");
		});

		it("emits step:delta for input_json_delta", () => {
			const tracker = new StepTracker();
			tracker.process({ type: "stream_event", event: { type: "message_start" } });
			tracker.process({
				type: "stream_event",
				event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "Read", id: "tc_1" } },
			});

			const events = tracker.process({
				type: "stream_event",
				event: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: '{"file' },
				},
			});

			const delta = events[1] as { event: "step:delta"; data: Record<string, unknown> };
			expect(delta.data.deltaType).toBe("input_json");
			expect(delta.data.delta).toBe('{"file');
		});
	});

	describe("stream_event: content_block_stop", () => {
		it("emits step:complete", () => {
			const tracker = new StepTracker();
			tracker.process({ type: "stream_event", event: { type: "message_start" } });
			tracker.process({
				type: "stream_event",
				event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
			});

			const events = tracker.process({
				type: "stream_event",
				event: { type: "content_block_stop", index: 0 },
			});

			expect(events[1].event).toBe("step:complete");
		});
	});

	describe("assistant complete", () => {
		it("emits sdk + turn:complete", () => {
			const tracker = new StepTracker();
			tracker.process({ type: "stream_event", event: { type: "message_start" } });

			const events = tracker.process({
				type: "assistant",
				message: { stop_reason: "end_turn" },
			});

			expect(events.length).toBe(2);
			expect(events[1].event).toBe("turn:complete");

			const turnComplete = events[1] as { event: "turn:complete"; data: Record<string, unknown> };
			expect(turnComplete.data.stopReason).toBe("end_turn");
		});
	});

	describe("user tool results", () => {
		it("emits step:start + step:complete for each tool_result", () => {
			const tracker = new StepTracker();
			tracker.process({ type: "stream_event", event: { type: "message_start" } });

			const events = tracker.process({
				type: "user",
				message: {
					content: [
						{ type: "tool_result", tool_use_id: "tc_1", content: "file contents" },
						{ type: "tool_result", tool_use_id: "tc_2", content: "other result" },
					],
				},
			});

			// sdk + 2 * (step:start + step:complete) = 5
			expect(events.length).toBe(5);
			const stepStarts = findEvents(events, "step:start");
			const stepCompletes = findEvents(events, "step:complete");
			expect(stepStarts.length).toBe(2);
			expect(stepCompletes.length).toBe(2);
		});
	});

	describe("result", () => {
		it("emits sdk + result + done for success", () => {
			const tracker = new StepTracker();
			const events = tracker.process({
				type: "result",
				subtype: "success",
				result: "Done",
				total_cost_usd: 0.01,
				duration_ms: 5000,
				num_turns: 2,
				usage: {
					input_tokens: 100,
					output_tokens: 50,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
				},
			});

			expect(events.length).toBe(3);
			expect(events[0].event).toBe("sdk");
			expect(events[1].event).toBe("result");
			expect(events[2].event).toBe("done");

			const result = events[1] as unknown as { event: "result"; data: Record<string, unknown> };
			expect(result.data.subtype).toBe("success");
			expect(result.data.totalCostUsd).toBe(0.01);
		});

		it("emits result + done for error subtypes", () => {
			const tracker = new StepTracker();
			const events = tracker.process({
				type: "result",
				subtype: "error_max_turns",
				total_cost_usd: 0.02,
				duration_ms: 10000,
				num_turns: 10,
				usage: { input_tokens: 200, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			});

			const result = events[1] as unknown as { event: "result"; data: Record<string, unknown> };
			expect(result.data.subtype).toBe("error_max_turns");
			expect(events[2].event).toBe("done");
		});
	});

	describe("edge cases", () => {
		it("orphan delta (no preceding start) produces only sdk event", () => {
			const tracker = new StepTracker();
			tracker.process({ type: "stream_event", event: { type: "message_start" } });

			const events = tracker.process({
				type: "stream_event",
				event: {
					type: "content_block_delta",
					index: 99,
					delta: { type: "text_delta", text: "orphan" },
				},
			});

			// Only the sdk event, no step:delta since there's no active step for index 99
			expect(events.length).toBe(1);
			expect(events[0].event).toBe("sdk");
		});

		it("orphan stop (no preceding start) produces only sdk event", () => {
			const tracker = new StepTracker();
			tracker.process({ type: "stream_event", event: { type: "message_start" } });

			const events = tracker.process({
				type: "stream_event",
				event: { type: "content_block_stop", index: 99 },
			});

			expect(events.length).toBe(1);
			expect(events[0].event).toBe("sdk");
		});

		it("unknown block types default to text step type", () => {
			const tracker = new StepTracker();
			tracker.process({ type: "stream_event", event: { type: "message_start" } });

			const events = tracker.process({
				type: "stream_event",
				event: {
					type: "content_block_start",
					index: 0,
					content_block: { type: "unknown_type" },
				},
			});

			const stepStart = events[1] as { event: "step:start"; data: Record<string, unknown> };
			expect(stepStart.data.type).toBe("text");
		});

		it("done is always last event after result", () => {
			const tracker = new StepTracker();
			const events = tracker.process({
				type: "result",
				subtype: "success",
				result: "ok",
				total_cost_usd: 0,
				duration_ms: 0,
				num_turns: 1,
				usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			});

			expect(events[events.length - 1].event).toBe("done");
		});
	});

	describe("full multi-turn sequence", () => {
		it("produces correct event sequence for tool-use loop", () => {
			const tracker = new StepTracker();
			const allEvents: ReturnType<StepTracker["process"]> = [];

			// 1. system init
			allEvents.push(...tracker.process({
				type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-4-6", tools: ["Read"],
			}));

			// 2. message_start
			allEvents.push(...tracker.process({
				type: "stream_event", event: { type: "message_start" },
			}));

			// 3. text block start + delta + stop
			allEvents.push(...tracker.process({
				type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
			}));
			allEvents.push(...tracker.process({
				type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I'll read" } },
			}));
			allEvents.push(...tracker.process({
				type: "stream_event", event: { type: "content_block_stop", index: 0 },
			}));

			// 4. tool_use block
			allEvents.push(...tracker.process({
				type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "Read", id: "tc1" } },
			}));
			allEvents.push(...tracker.process({
				type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path":"readme.md"}' } },
			}));
			allEvents.push(...tracker.process({
				type: "stream_event", event: { type: "content_block_stop", index: 1 },
			}));

			// 5. assistant complete
			allEvents.push(...tracker.process({
				type: "assistant", message: { stop_reason: "tool_use" },
			}));

			// 6. user tool result
			allEvents.push(...tracker.process({
				type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tc1", content: "# README" }] },
			}));

			// 7. result
			allEvents.push(...tracker.process({
				type: "result", subtype: "success", result: "ok", total_cost_usd: 0.01, duration_ms: 3000, num_turns: 2,
				usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			}));

			// Verify key events in order
			const eventTypes = allEvents.map((e) => e.event);
			expect(eventTypes).toContain("session:init");
			expect(eventTypes).toContain("turn:start");
			expect(eventTypes).toContain("step:start");
			expect(eventTypes).toContain("step:delta");
			expect(eventTypes).toContain("step:complete");
			expect(eventTypes).toContain("turn:complete");
			expect(eventTypes).toContain("result");
			expect(eventTypes[eventTypes.length - 1]).toBe("done");
		});
	});
});
