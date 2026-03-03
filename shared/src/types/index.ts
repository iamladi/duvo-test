// ============================================================
// Request Types
// ============================================================

export type AgentRequest = {
	prompt: string;
	sessionId?: string;
	systemPrompt?: string;
};

// ============================================================
// Core Identity
// ============================================================

export type StepId = string;
export type TurnId = string;
export type SessionId = string;

// ============================================================
// Step Model
// ============================================================

export type StepStatus = "pending" | "running" | "complete" | "error";

export type StepType = "thinking" | "text" | "tool_use" | "tool_result";

export interface StepBase {
	id: StepId;
	type: StepType;
	status: StepStatus;
	startTime: number;
	endTime?: number;
	blockIndex: number;
}

export interface ThinkingStep extends StepBase {
	type: "thinking";
	content: string;
}

export interface TextStep extends StepBase {
	type: "text";
	content: string;
}

export interface ToolUseStep extends StepBase {
	type: "tool_use";
	toolCallId: string;
	toolName: string;
	inputJson: string;
	parsedInput?: Record<string, unknown>;
}

export interface ToolResultStep extends StepBase {
	type: "tool_result";
	toolCallId: string;
	toolName: string;
	isError: boolean;
	content: string;
}

export type Step = ThinkingStep | TextStep | ToolUseStep | ToolResultStep;

// ============================================================
// Turn Model
// ============================================================

export type TurnPhase =
	| "thinking"
	| "responding"
	| "tool_calling"
	| "tool_executing"
	| "complete";

export interface UserTurn {
	id: TurnId;
	role: "user";
	content: string;
	timestamp: number;
}

export interface AssistantTurn {
	id: TurnId;
	role: "assistant";
	steps: Step[];
	phase: TurnPhase;
	stopReason?: string;
	timestamp: number;
}

export type Turn = UserTurn | AssistantTurn;

// ============================================================
// Conversation (Session) Model
// ============================================================

export interface Conversation {
	sessionId: SessionId | null;
	turns: Turn[];
	model: string | null;
	tools: string[];
}

// ============================================================
// Result / Usage Model
// ============================================================

export interface UsageInfo {
	inputTokens: number;
	outputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
}

export interface TurnResult {
	subtype:
		| "success"
		| "error_max_turns"
		| "error_during_execution"
		| "error_max_budget_usd";
	result?: string;
	totalCostUsd: number;
	durationMs: number;
	numTurns: number;
	usage: UsageInfo;
}

// ============================================================
// Automation State
// ============================================================

export type AutomationState =
	| "idle"
	| "initiating"
	| "streaming"
	| "complete"
	| "error";

// ============================================================
// Structured State Summary (derived, not stored)
// ============================================================

export interface AutomationSummary {
	phase: AutomationState;
	turnPhase: TurnPhase | null;
	completedStepCount: number;
	activeStep: Step | null;
	completedSteps: Array<{
		id: StepId;
		type: StepType;
		description: string;
		durationMs: number;
	}>;
	elapsedMs: number;
}

// ============================================================
// SSE Event Types
// ============================================================

export interface SDKMessageEnvelope {
	type: string;
	serverTimestamp: number;
	payload: unknown;
}

export interface RawSDKEvent {
	event: "sdk";
	data: SDKMessageEnvelope;
}

export interface StepStartEvent {
	event: "step:start";
	data: {
		stepId: StepId;
		turnId: TurnId;
		type: StepType;
		blockIndex: number;
		toolName?: string;
		toolCallId?: string;
		timestamp: number;
	};
}

export interface StepDeltaEvent {
	event: "step:delta";
	data: {
		stepId: StepId;
		delta: string;
		deltaType: "text" | "thinking" | "input_json";
		timestamp: number;
	};
}

export interface StepCompleteEvent {
	event: "step:complete";
	data: {
		stepId: StepId;
		parsedInput?: Record<string, unknown>;
		timestamp: number;
	};
}

export interface StepErrorEvent {
	event: "step:error";
	data: {
		stepId: StepId;
		error: string;
		timestamp: number;
	};
}

export interface SessionInitEvent {
	event: "session:init";
	data: {
		sessionId: SessionId;
		model: string;
		tools: string[];
		timestamp: number;
	};
}

export interface TurnStartEvent {
	event: "turn:start";
	data: {
		turnId: TurnId;
		timestamp: number;
	};
}

export interface TurnCompleteEvent {
	event: "turn:complete";
	data: {
		turnId: TurnId;
		stopReason: string;
		timestamp: number;
	};
}

export interface ResultEvent {
	event: "result";
	data: TurnResult;
}

export interface ErrorEvent {
	event: "error";
	data: {
		message: string;
		code?: string;
		timestamp: number;
	};
}

export interface DoneEvent {
	event: "done";
	data: "[DONE]";
}

export type SSEEvent =
	| RawSDKEvent
	| StepStartEvent
	| StepDeltaEvent
	| StepCompleteEvent
	| StepErrorEvent
	| SessionInitEvent
	| TurnStartEvent
	| TurnCompleteEvent
	| ResultEvent
	| ErrorEvent
	| DoneEvent;

// ============================================================
// Frontend State Types
// ============================================================

export interface RawEvent {
	id: number;
	timestamp: number;
	type: string;
	payload: unknown;
}

export interface AgentViewState {
	automation: AutomationState;
	conversation: Conversation;
	lastResult: TurnResult | null;
	error: { message: string; code?: string } | null;
	rawEvents: RawEvent[];
	connection: {
		isConnected: boolean;
		lastEventAt: number | null;
	};
}

export type StateAction =
	| { type: "SUBMIT_PROMPT"; prompt: string }
	| { type: "CONNECTION_OPENED" }
	| { type: "CONNECTION_CLOSED" }
	| { type: "USER_ABORT" }
	| { type: "SESSION_INIT"; sessionId: string; model: string; tools: string[] }
	| { type: "TURN_START"; turnId: TurnId }
	| { type: "TURN_COMPLETE"; turnId: TurnId; stopReason: string }
	| { type: "STEP_START"; step: StepStartEvent["data"] }
	| { type: "STEP_DELTA"; stepId: StepId; delta: string; deltaType: string }
	| {
			type: "STEP_COMPLETE";
			stepId: StepId;
			parsedInput?: Record<string, unknown>;
	  }
	| { type: "STEP_ERROR"; stepId: StepId; error: string }
	| { type: "RESULT"; result: TurnResult }
	| { type: "ERROR"; message: string; code?: string }
	| { type: "RAW_EVENT"; event: RawEvent };
