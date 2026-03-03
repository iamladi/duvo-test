import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type {
	AgentRequest,
	AgentViewState,
	AssistantTurn,
	AutomationSummary,
	SSEEvent,
	StateAction,
	Step,
	StepStartEvent,
	TurnPhase,
	UserTurn,
} from "shared";

const RAW_EVENT_CAP = 10_000;

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

function updateCurrentAssistantTurn(
	state: AgentViewState,
	updater: (turn: AssistantTurn) => AssistantTurn,
): AgentViewState {
	const turns = [...state.conversation.turns];
	const lastTurn = turns[turns.length - 1];
	if (!lastTurn || lastTurn.role !== "assistant") return state;
	turns[turns.length - 1] = updater(lastTurn);
	return {
		...state,
		conversation: { ...state.conversation, turns },
	};
}

function createStep(data: StepStartEvent["data"]): Step {
	const base = {
		id: data.stepId,
		status: "running" as const,
		startTime: data.timestamp,
		blockIndex: data.blockIndex,
	};

	switch (data.type) {
		case "thinking":
			return { ...base, type: "thinking", content: "" };
		case "text":
			return { ...base, type: "text", content: "" };
		case "tool_use":
			return {
				...base,
				type: "tool_use",
				toolCallId: data.toolCallId ?? "",
				toolName: data.toolName ?? "",
				inputJson: "",
			};
		case "tool_result":
			return {
				...base,
				type: "tool_result",
				toolCallId: data.toolCallId ?? "",
				toolName: data.toolName ?? "unknown",
				isError: false,
				content: "",
			};
	}
}

function appendDelta(step: Step, delta: string): Step {
	switch (step.type) {
		case "thinking":
			return { ...step, content: step.content + delta };
		case "text":
			return { ...step, content: step.content + delta };
		case "tool_use":
			return { ...step, inputJson: step.inputJson + delta };
		case "tool_result":
			return { ...step, content: step.content + delta };
	}
}

function stepTypeToPhase(type: string): TurnPhase {
	switch (type) {
		case "thinking":
			return "thinking";
		case "text":
			return "responding";
		case "tool_use":
			return "tool_calling";
		case "tool_result":
			return "tool_executing";
		default:
			return "responding";
	}
}

function sweepRunningStepsToError(steps: Step[]): Step[] {
	return steps.map((step) =>
		step.status === "running"
			? { ...step, status: "error" as const, endTime: Date.now() }
			: step,
	);
}

export function agentViewReducer(
	state: AgentViewState,
	action: StateAction,
): AgentViewState {
	switch (action.type) {
		case "SUBMIT_PROMPT": {
			const userTurn: UserTurn = {
				id: `turn_user_${Date.now()}`,
				role: "user",
				content: action.prompt,
				timestamp: Date.now(),
			};
			return {
				...state,
				automation: "initiating",
				error: null,
				lastResult: null,
				conversation: {
					...state.conversation,
					turns: [...state.conversation.turns, userTurn],
				},
			};
		}

		case "CONNECTION_OPENED":
			return {
				...state,
				connection: { isConnected: true, lastEventAt: Date.now() },
			};

		case "CONNECTION_CLOSED":
			return {
				...state,
				connection: { ...state.connection, isConnected: false },
			};

		case "USER_ABORT":
			return updateCurrentAssistantTurn(
				{
					...state,
					automation: "idle",
					connection: { ...state.connection, isConnected: false },
				},
				(turn) => ({
					...turn,
					steps: sweepRunningStepsToError(turn.steps),
					phase: "complete",
				}),
			);

		case "SESSION_INIT":
			return {
				...state,
				automation: "streaming",
				conversation: {
					...state.conversation,
					sessionId: action.sessionId,
					model: action.model,
					tools: action.tools,
				},
			};

		case "TURN_START": {
			const assistantTurn: AssistantTurn = {
				id: action.turnId,
				role: "assistant",
				steps: [],
				phase: "responding",
				timestamp: Date.now(),
			};
			return {
				...state,
				automation: "streaming",
				conversation: {
					...state.conversation,
					turns: [...state.conversation.turns, assistantTurn],
				},
			};
		}

		case "STEP_START":
			return updateCurrentAssistantTurn(state, (turn) => {
				const newStep = createStep(action.step);
				const phase = stepTypeToPhase(action.step.type);
				return { ...turn, steps: [...turn.steps, newStep], phase };
			});

		case "STEP_DELTA":
			return updateCurrentAssistantTurn(state, (turn) => ({
				...turn,
				steps: turn.steps.map((step) =>
					step.id === action.stepId
						? appendDelta(step, action.delta)
						: step,
				),
			}));

		case "STEP_COMPLETE":
			return updateCurrentAssistantTurn(state, (turn) => ({
				...turn,
				steps: turn.steps.map((step) =>
					step.id === action.stepId
						? {
								...step,
								status: "complete" as const,
								endTime: Date.now(),
								...(step.type === "tool_use" && action.parsedInput
									? { parsedInput: action.parsedInput }
									: {}),
							}
						: step,
				),
				phase:
					turn.steps.find((s) => s.id === action.stepId)?.type === "tool_use"
						? "tool_executing"
						: turn.phase,
			}));

		case "STEP_ERROR":
			return updateCurrentAssistantTurn(state, (turn) => ({
				...turn,
				steps: turn.steps.map((step) =>
					step.id === action.stepId
						? { ...step, status: "error" as const, endTime: Date.now() }
						: step,
				),
			}));

		case "TURN_COMPLETE":
			return updateCurrentAssistantTurn(state, (turn) => ({
				...turn,
				phase: "complete",
				stopReason: action.stopReason,
			}));

		case "RESULT":
			return {
				...state,
				automation:
					action.result.subtype === "success" ? "complete" : "error",
				lastResult: action.result,
				error:
					action.result.subtype !== "success"
						? { message: `Agent ended with: ${action.result.subtype}` }
						: null,
			};

		case "ERROR":
			return updateCurrentAssistantTurn(
				{
					...state,
					automation: "error",
					error: { message: action.message, code: action.code },
				},
				(turn) => ({
					...turn,
					steps: sweepRunningStepsToError(turn.steps),
				}),
			);

		case "RAW_EVENT": {
			const rawEvents =
				state.rawEvents.length >= RAW_EVENT_CAP
					? [...state.rawEvents.slice(1), action.event]
					: [...state.rawEvents, action.event];
			return {
				...state,
				rawEvents,
				connection: {
					...state.connection,
					lastEventAt: action.event.timestamp,
				},
			};
		}

		case "FILE_CREATED": {
			const exists = state.createdFiles.some(
				(f) => f.downloadUrl === action.file.downloadUrl,
			);
			if (exists) return state;
			return {
				...state,
				createdFiles: [...state.createdFiles, action.file],
			};
		}

		default:
			return state;
	}
}

export function deriveAutomationSummary(
	state: AgentViewState,
): AutomationSummary {
	const turns = state.conversation.turns;
	const lastTurn = turns[turns.length - 1];
	const assistantTurn =
		lastTurn?.role === "assistant" ? lastTurn : null;

	const steps = assistantTurn?.steps ?? [];
	const completedSteps = steps.filter((s) => s.status === "complete");
	const activeStep = steps.find((s) => s.status === "running") ?? null;

	let firstStepStart = 0;
	for (const step of steps) {
		if (step.startTime) {
			firstStepStart = step.startTime;
			break;
		}
	}

	const elapsedMs =
		firstStepStart && state.automation === "streaming"
			? Date.now() - firstStepStart
			: firstStepStart && state.lastResult
				? state.lastResult.durationMs
				: 0;

	return {
		phase: state.automation,
		turnPhase: assistantTurn?.phase ?? null,
		completedStepCount: completedSteps.length,
		activeStep,
		completedSteps: completedSteps.map((s) => ({
			id: s.id,
			type: s.type,
			description: stepDescription(s),
			durationMs: s.endTime ? s.endTime - s.startTime : 0,
		})),
		elapsedMs,
	};
}

function stepDescription(step: Step): string {
	switch (step.type) {
		case "thinking":
			return `Thinking (${step.content.length} chars)`;
		case "text":
			return `Text (${step.content.split(/\s+/).length} words)`;
		case "tool_use":
			return `Tool: ${step.toolName}`;
		case "tool_result":
			return `Result: ${step.toolName}`;
	}
}

let rawEventCounter = 0;

function handleSSEEvent(
	event: SSEEvent,
	dispatch: (action: StateAction) => void,
) {
	if (event.event === "sdk") {
		dispatch({
			type: "RAW_EVENT",
			event: {
				id: rawEventCounter++,
				timestamp: event.data.serverTimestamp,
				type: event.data.type,
				payload: event.data.payload,
			},
		});
	}

	switch (event.event) {
		case "session:init":
			dispatch({ type: "SESSION_INIT", ...event.data });
			break;
		case "turn:start":
			dispatch({ type: "TURN_START", turnId: event.data.turnId });
			break;
		case "step:start":
			dispatch({ type: "STEP_START", step: event.data });
			break;
		case "step:delta":
			dispatch({
				type: "STEP_DELTA",
				stepId: event.data.stepId,
				delta: event.data.delta,
				deltaType: event.data.deltaType,
			});
			break;
		case "step:complete":
			dispatch({
				type: "STEP_COMPLETE",
				stepId: event.data.stepId,
				parsedInput: event.data.parsedInput,
			});
			break;
		case "step:error":
			dispatch({
				type: "STEP_ERROR",
				stepId: event.data.stepId,
				error: event.data.error,
			});
			break;
		case "turn:complete":
			dispatch({
				type: "TURN_COMPLETE",
				turnId: event.data.turnId,
				stopReason: event.data.stopReason,
			});
			break;
		case "result":
			dispatch({ type: "RESULT", result: event.data });
			break;
		case "error":
			dispatch({
				type: "ERROR",
				message: event.data.message,
				code: event.data.code,
			});
			break;
	}
}

export type McpConnectionConfig = {
	enabled: boolean;
	path: string;
};

export type UseAgentViewReturn = {
	state: AgentViewState;
	summary: AutomationSummary;
	sendMessage: (prompt: string, isRetry?: boolean, mcpConnection?: McpConnectionConfig) => void;
	abort: () => void;
};

export function useAgentView(): UseAgentViewReturn {
	const [state, dispatch] = useReducer(agentViewReducer, initialState);
	const [tick, setTick] = useState(0);

	const abortControllerRef = useRef<AbortController | null>(null);
	const mountedRef = useRef(true);
	const lastPromptRef = useRef<string | null>(null);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			abortControllerRef.current?.abort();
		};
	}, []);

	// Elapsed timer: tick every second while streaming
	useEffect(() => {
		if (state.automation !== "streaming") return;
		const interval = setInterval(() => setTick((t) => t + 1), 1000);
		return () => clearInterval(interval);
	}, [state.automation]);

	const abort = useCallback(() => {
		abortControllerRef.current?.abort();
		dispatch({ type: "USER_ABORT" });
	}, []);

	const sendMessage = useCallback(
		(prompt: string, isRetry = false, mcpConnection?: McpConnectionConfig) => {
			abortControllerRef.current?.abort();

			if (!isRetry) {
				dispatch({ type: "SUBMIT_PROMPT", prompt });
			}

			lastPromptRef.current = prompt;

			const controller = new AbortController();
			abortControllerRef.current = controller;

			const body: AgentRequest = {
				prompt,
				sessionId: state.conversation.sessionId ?? undefined,
				...(mcpConnection ? { mcpConnection } : {}),
			};

			(async () => {
				try {
					const response = await fetch("/api/agent", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
						signal: controller.signal,
					});

					if (!response.ok) {
						throw new Error(
							`HTTP ${response.status}: ${response.statusText}`,
						);
					}

					if (!response.body) {
						throw new Error("Response body is null");
					}

					if (mountedRef.current) {
						dispatch({ type: "CONNECTION_OPENED" });
					}

					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let buffer = "";

					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						if (!mountedRef.current) break;

						buffer += decoder.decode(value, { stream: true });

						const parts = buffer.split("\n\n");
						buffer = parts.pop() ?? "";

						for (const part of parts) {
							if (!part.trim()) continue;

							let eventType = "";
							let dataLine = "";

							for (const line of part.split("\n")) {
								if (line.startsWith("event: ")) {
									eventType = line.slice("event: ".length).trim();
								} else if (line.startsWith("data: ")) {
									dataLine +=
										(dataLine ? "\n" : "") + line.slice("data: ".length);
								}
							}

							if (!dataLine) continue;

							// Handle [DONE] sentinel
							if (dataLine === "[DONE]") {
								if (mountedRef.current) {
									dispatch({ type: "CONNECTION_CLOSED" });
								}
								continue;
							}

							let parsed: unknown;
							try {
								parsed = JSON.parse(dataLine);
							} catch {
								console.error("Failed to parse SSE data:", dataLine);
								continue;
							}

							if (mountedRef.current) {
								// Handle file_created events (outside StepTracker protocol)
								if (eventType === "file_created") {
									const fileData = parsed as {
										filename?: string;
										downloadUrl?: string;
									};
									if (fileData.filename && fileData.downloadUrl) {
										dispatch({
											type: "FILE_CREATED",
											file: {
												filename: fileData.filename,
												downloadUrl: fileData.downloadUrl,
											},
										});
									}
									continue;
								}

								const sseEvent = {
									event: eventType,
									data: parsed,
								} as SSEEvent;
								handleSSEEvent(sseEvent, dispatch);
							}
						}
					}
				} catch (err) {
					if (err instanceof Error && err.name === "AbortError") {
						// User-initiated abort — handled by USER_ABORT action
					} else if (mountedRef.current) {
						dispatch({
							type: "ERROR",
							message:
								err instanceof Error ? err.message : "Unknown error",
						});
					}
				} finally {
					if (mountedRef.current) {
						dispatch({ type: "CONNECTION_CLOSED" });
					}
				}
			})();
		},
		[state.conversation.sessionId],
	);

	// Force re-derive summary on tick
	void tick;
	const summary = deriveAutomationSummary(state);

	return { state, summary, sendMessage, abort };
}
