import { describe, expect, it } from "bun:test";
import { agentViewReducer, deriveAutomationSummary } from "./useAgentView";
import type { AgentViewState } from "shared";

const initialState: AgentViewState = {
	automation: "idle",
	conversation: {
		sessionId: null,
		turns: [],
		model: null,
		tools: [],
	},
	lastResult: null,
	error: null,
	rawEvents: [],
	createdFiles: [],
	connection: {
		isConnected: false,
		lastEventAt: null,
	},
};

describe("agentViewReducer", () => {
	describe("SUBMIT_PROMPT", () => {
		it("transitions to initiating and adds user turn", () => {
			const state = agentViewReducer(initialState, {
				type: "SUBMIT_PROMPT",
				prompt: "Hello",
			});

			expect(state.automation).toBe("initiating");
			expect(state.conversation.turns.length).toBe(1);
			expect(state.conversation.turns[0].role).toBe("user");
			expect(
				state.conversation.turns[0].role === "user" &&
					state.conversation.turns[0].content,
			).toBe("Hello");
			expect(state.error).toBeNull();
			expect(state.lastResult).toBeNull();
		});
	});

	describe("CONNECTION_OPENED", () => {
		it("sets connection.isConnected to true", () => {
			const state = agentViewReducer(initialState, {
				type: "CONNECTION_OPENED",
			});
			expect(state.connection.isConnected).toBe(true);
		});
	});

	describe("CONNECTION_CLOSED", () => {
		it("sets connection.isConnected to false", () => {
			const opened = agentViewReducer(initialState, {
				type: "CONNECTION_OPENED",
			});
			const state = agentViewReducer(opened, {
				type: "CONNECTION_CLOSED",
			});
			expect(state.connection.isConnected).toBe(false);
		});
	});

	describe("SESSION_INIT", () => {
		it("transitions to streaming and sets session info", () => {
			const state = agentViewReducer(initialState, {
				type: "SESSION_INIT",
				sessionId: "sess-1",
				model: "claude-sonnet-4-6",
				tools: ["Read", "Write"],
			});

			expect(state.automation).toBe("streaming");
			expect(state.conversation.sessionId).toBe("sess-1");
			expect(state.conversation.model).toBe("claude-sonnet-4-6");
			expect(state.conversation.tools).toEqual(["Read", "Write"]);
		});
	});

	describe("TURN_START", () => {
		it("adds an assistant turn", () => {
			const state = agentViewReducer(initialState, {
				type: "TURN_START",
				turnId: "turn_1",
			});

			expect(state.automation).toBe("streaming");
			expect(state.conversation.turns.length).toBe(1);
			expect(state.conversation.turns[0].role).toBe("assistant");
		});
	});

	describe("STEP_START", () => {
		it("adds a step to the current assistant turn", () => {
			let state = agentViewReducer(initialState, {
				type: "TURN_START",
				turnId: "turn_1",
			});
			state = agentViewReducer(state, {
				type: "STEP_START",
				step: {
					stepId: "step_1",
					turnId: "turn_1",
					type: "text",
					blockIndex: 0,
					timestamp: Date.now(),
				},
			});

			const turn = state.conversation.turns[0];
			expect(turn.role).toBe("assistant");
			if (turn.role === "assistant") {
				expect(turn.steps.length).toBe(1);
				expect(turn.steps[0].id).toBe("step_1");
				expect(turn.steps[0].status).toBe("running");
				expect(turn.phase).toBe("responding");
			}
		});
	});

	describe("STEP_DELTA", () => {
		it("appends delta to the correct step", () => {
			let state = agentViewReducer(initialState, {
				type: "TURN_START",
				turnId: "turn_1",
			});
			state = agentViewReducer(state, {
				type: "STEP_START",
				step: {
					stepId: "step_1",
					turnId: "turn_1",
					type: "text",
					blockIndex: 0,
					timestamp: Date.now(),
				},
			});
			state = agentViewReducer(state, {
				type: "STEP_DELTA",
				stepId: "step_1",
				delta: "Hello ",
				deltaType: "text",
			});
			state = agentViewReducer(state, {
				type: "STEP_DELTA",
				stepId: "step_1",
				delta: "world",
				deltaType: "text",
			});

			const turn = state.conversation.turns[0];
			if (turn.role === "assistant") {
				const step = turn.steps[0];
				expect(step.type).toBe("text");
				if (step.type === "text") {
					expect(step.content).toBe("Hello world");
				}
			}
		});
	});

	describe("STEP_COMPLETE", () => {
		it("marks step as complete with endTime", () => {
			let state = agentViewReducer(initialState, {
				type: "TURN_START",
				turnId: "turn_1",
			});
			state = agentViewReducer(state, {
				type: "STEP_START",
				step: {
					stepId: "step_1",
					turnId: "turn_1",
					type: "text",
					blockIndex: 0,
					timestamp: Date.now(),
				},
			});
			state = agentViewReducer(state, {
				type: "STEP_COMPLETE",
				stepId: "step_1",
			});

			const turn = state.conversation.turns[0];
			if (turn.role === "assistant") {
				expect(turn.steps[0].status).toBe("complete");
				expect(turn.steps[0].endTime).toBeDefined();
			}
		});

		it("sets phase to tool_executing after tool_use completes", () => {
			let state = agentViewReducer(initialState, {
				type: "TURN_START",
				turnId: "turn_1",
			});
			state = agentViewReducer(state, {
				type: "STEP_START",
				step: {
					stepId: "step_1",
					turnId: "turn_1",
					type: "tool_use",
					blockIndex: 0,
					toolName: "Read",
					toolCallId: "tc_1",
					timestamp: Date.now(),
				},
			});
			state = agentViewReducer(state, {
				type: "STEP_COMPLETE",
				stepId: "step_1",
				parsedInput: { file_path: "readme.md" },
			});

			const turn = state.conversation.turns[0];
			if (turn.role === "assistant") {
				expect(turn.phase).toBe("tool_executing");
				const step = turn.steps[0];
				if (step.type === "tool_use") {
					expect(step.parsedInput).toEqual({ file_path: "readme.md" });
				}
			}
		});
	});

	describe("STEP_ERROR", () => {
		it("marks step as error", () => {
			let state = agentViewReducer(initialState, {
				type: "TURN_START",
				turnId: "turn_1",
			});
			state = agentViewReducer(state, {
				type: "STEP_START",
				step: {
					stepId: "step_1",
					turnId: "turn_1",
					type: "text",
					blockIndex: 0,
					timestamp: Date.now(),
				},
			});
			state = agentViewReducer(state, {
				type: "STEP_ERROR",
				stepId: "step_1",
				error: "Something went wrong",
			});

			const turn = state.conversation.turns[0];
			if (turn.role === "assistant") {
				expect(turn.steps[0].status).toBe("error");
				expect(turn.steps[0].endTime).toBeDefined();
			}
		});
	});

	describe("TURN_COMPLETE", () => {
		it("sets turn phase to complete", () => {
			let state = agentViewReducer(initialState, {
				type: "TURN_START",
				turnId: "turn_1",
			});
			state = agentViewReducer(state, {
				type: "TURN_COMPLETE",
				turnId: "turn_1",
				stopReason: "end_turn",
			});

			const turn = state.conversation.turns[0];
			if (turn.role === "assistant") {
				expect(turn.phase).toBe("complete");
				expect(turn.stopReason).toBe("end_turn");
			}
		});
	});

	describe("RESULT", () => {
		it("sets automation to complete for success", () => {
			const state = agentViewReducer(initialState, {
				type: "RESULT",
				result: {
					subtype: "success",
					result: "Done",
					totalCostUsd: 0.01,
					durationMs: 5000,
					numTurns: 2,
					usage: {
						inputTokens: 100,
						outputTokens: 50,
						cacheCreationInputTokens: 0,
						cacheReadInputTokens: 0,
					},
				},
			});

			expect(state.automation).toBe("complete");
			expect(state.lastResult?.subtype).toBe("success");
			expect(state.error).toBeNull();
		});

		it("sets automation to error for error subtypes", () => {
			const state = agentViewReducer(initialState, {
				type: "RESULT",
				result: {
					subtype: "error_max_turns",
					totalCostUsd: 0.02,
					durationMs: 10000,
					numTurns: 10,
					usage: {
						inputTokens: 200,
						outputTokens: 100,
						cacheCreationInputTokens: 0,
						cacheReadInputTokens: 0,
					},
				},
			});

			expect(state.automation).toBe("error");
			expect(state.error?.message).toContain("error_max_turns");
		});
	});

	describe("ERROR", () => {
		it("sets automation to error and sweeps running steps", () => {
			let state = agentViewReducer(initialState, {
				type: "TURN_START",
				turnId: "turn_1",
			});
			state = agentViewReducer(state, {
				type: "STEP_START",
				step: {
					stepId: "step_1",
					turnId: "turn_1",
					type: "text",
					blockIndex: 0,
					timestamp: Date.now(),
				},
			});
			state = agentViewReducer(state, {
				type: "ERROR",
				message: "Connection lost",
				code: "server_error",
			});

			expect(state.automation).toBe("error");
			expect(state.error?.message).toBe("Connection lost");
			expect(state.error?.code).toBe("server_error");

			const turn = state.conversation.turns[0];
			if (turn.role === "assistant") {
				expect(turn.steps[0].status).toBe("error");
				expect(turn.steps[0].endTime).toBeDefined();
			}
		});
	});

	describe("USER_ABORT", () => {
		it("sets automation to idle and sweeps running steps", () => {
			let state = agentViewReducer(initialState, {
				type: "TURN_START",
				turnId: "turn_1",
			});
			state = agentViewReducer(state, {
				type: "STEP_START",
				step: {
					stepId: "step_1",
					turnId: "turn_1",
					type: "text",
					blockIndex: 0,
					timestamp: Date.now(),
				},
			});
			state = agentViewReducer(state, { type: "USER_ABORT" });

			expect(state.automation).toBe("idle");
			expect(state.connection.isConnected).toBe(false);

			const turn = state.conversation.turns[0];
			if (turn.role === "assistant") {
				expect(turn.steps[0].status).toBe("error");
				expect(turn.phase).toBe("complete");
			}
		});
	});

	describe("RAW_EVENT", () => {
		it("appends raw events", () => {
			const state = agentViewReducer(initialState, {
				type: "RAW_EVENT",
				event: { id: 1, timestamp: Date.now(), type: "system", payload: {} },
			});

			expect(state.rawEvents.length).toBe(1);
		});

		it("enforces ring buffer cap at 10000", () => {
			let state = initialState;
			for (let i = 0; i < 10_001; i++) {
				state = agentViewReducer(state, {
					type: "RAW_EVENT",
					event: { id: i, timestamp: Date.now(), type: "test", payload: {} },
				});
			}

			expect(state.rawEvents.length).toBe(10_000);
			// First event should be id=1 (id=0 was dropped)
			expect(state.rawEvents[0].id).toBe(1);
		});
	});
});

describe("deriveAutomationSummary", () => {
	it("returns idle summary for initial state", () => {
		const summary = deriveAutomationSummary(initialState);
		expect(summary.phase).toBe("idle");
		expect(summary.turnPhase).toBeNull();
		expect(summary.completedStepCount).toBe(0);
		expect(summary.activeStep).toBeNull();
		expect(summary.elapsedMs).toBe(0);
	});

	it("returns correct summary during streaming", () => {
		const now = Date.now();
		const state: AgentViewState = {
			...initialState,
			automation: "streaming",
			conversation: {
				...initialState.conversation,
				turns: [
					{
						id: "turn_1",
						role: "assistant",
						steps: [
							{
								id: "step_1",
								type: "text",
								status: "complete",
								startTime: now - 3000,
								endTime: now - 2000,
								blockIndex: 0,
								content: "Hello world",
							},
							{
								id: "step_2",
								type: "tool_use",
								status: "running",
								startTime: now - 1000,
								blockIndex: 1,
								toolCallId: "tc_1",
								toolName: "Read",
								inputJson: "",
							},
						],
						phase: "tool_calling",
						timestamp: now - 3000,
					},
				],
			},
		};

		const summary = deriveAutomationSummary(state);
		expect(summary.phase).toBe("streaming");
		expect(summary.turnPhase).toBe("tool_calling");
		expect(summary.completedStepCount).toBe(1);
		expect(summary.activeStep?.id).toBe("step_2");
		expect(summary.elapsedMs).toBeGreaterThan(0);
	});
});
