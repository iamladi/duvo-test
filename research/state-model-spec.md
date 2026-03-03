# State Model Specification: Observable Automation View

## 1. Automation Lifecycle States

The automation (a single agent turn initiated by a user message) follows a finite state machine with these states:

```
idle -> initiating -> streaming -> complete
                  \-> error      \-> error
```

### State Definitions

| State | Description | Entry Trigger | Available Data |
|-------|-------------|---------------|----------------|
| `idle` | No active automation. Ready for user input. | Initial state, or after `complete`/`error` acknowledged | Previous conversation history |
| `initiating` | User submitted prompt. Waiting for first SDK event. | User sends message | The prompt text, sessionId (if follow-up) |
| `streaming` | Receiving SDK events. Agent is thinking/responding/using tools. | First `system` or `stream_event` received | Live steps, partial content, current phase |
| `complete` | Agent turn finished successfully. | `result` message with `subtype: "success"` | Full turn content, cost, usage, duration |
| `error` | Agent turn failed. | `result` with error subtype, or network/parse error | Error type, message, partial content so far |

### State Transitions

```typescript
type AutomationState = "idle" | "initiating" | "streaming" | "complete" | "error";

type AutomationTransition =
  | { from: "idle"; to: "initiating"; trigger: "user_submit" }
  | { from: "initiating"; to: "streaming"; trigger: "first_sdk_event" }
  | { from: "initiating"; to: "error"; trigger: "connection_error" }
  | { from: "streaming"; to: "complete"; trigger: "result_success" }
  | { from: "streaming"; to: "error"; trigger: "result_error" | "stream_error" }
  | { from: "streaming"; to: "idle"; trigger: "user_abort" }
  | { from: "complete"; to: "idle"; trigger: "acknowledged" } // auto-transition
  | { from: "error"; to: "idle"; trigger: "dismissed" | "retry" };
```

Note: The `complete -> idle` transition is automatic (the UI stays showing the result, but the automation state resets to accept new input). There is no explicit "acknowledged" action from the user; the state moves to `idle` as soon as the result is processed so the input is re-enabled.

---

## 2. Hierarchy: Conversation > Turn > Step > Detail

### The Full Hierarchy

```
Conversation (session)
  └── Turn[]
        ├── UserTurn (user message)
        └── AssistantTurn (agent response)
              └── Step[]
                    ├── ThinkingStep (extended thinking block)
                    ├── TextStep (text response block)
                    ├── ToolUseStep (tool call block)
                    └── ToolResultStep (tool execution result)
                          └── Detail (streaming deltas within a step)
```

### TypeScript Type Definitions

```typescript
// ============================================================
// Core Identity
// ============================================================

type StepId = string; // e.g., "step_001"
type TurnId = string; // e.g., "turn_001"
type SessionId = string; // UUID from SDK

// ============================================================
// Step Model
// ============================================================

type StepStatus = "pending" | "running" | "complete" | "error";

type StepType = "thinking" | "text" | "tool_use" | "tool_result";

/** Base fields shared by all steps */
interface StepBase {
  id: StepId;
  type: StepType;
  status: StepStatus;
  startTime: number; // Date.now() when step began
  endTime?: number; // Date.now() when step completed
  /** The content_block index from the SDK stream */
  blockIndex: number;
}

/** Extended thinking step — the agent's internal reasoning */
interface ThinkingStep extends StepBase {
  type: "thinking";
  /** Accumulated thinking text (may be redacted in production) */
  content: string;
}

/** Text response step — the agent's visible response to the user */
interface TextStep extends StepBase {
  type: "text";
  /** Accumulated text content, built up from text_delta events */
  content: string;
}

/** Tool use step — the agent requesting to call a tool */
interface ToolUseStep extends StepBase {
  type: "tool_use";
  /** Tool call ID from the SDK */
  toolCallId: string;
  /** Tool name (e.g., "Read", "Edit", "Bash") */
  toolName: string;
  /** Accumulated JSON input string, built from input_json_delta events */
  inputJson: string;
  /** Parsed input object (set when block completes and JSON is valid) */
  parsedInput?: Record<string, unknown>;
}

/** Tool result step — the result of executing a tool */
interface ToolResultStep extends StepBase {
  type: "tool_result";
  /** The tool_use step this result corresponds to */
  toolCallId: string;
  toolName: string;
  /** Whether the tool execution succeeded */
  isError: boolean;
  /** The tool's output content */
  content: string;
}

type Step = ThinkingStep | TextStep | ToolUseStep | ToolResultStep;

// ============================================================
// Turn Model
// ============================================================

type TurnRole = "user" | "assistant";

interface UserTurn {
  id: TurnId;
  role: "user";
  content: string;
  timestamp: number;
}

interface AssistantTurn {
  id: TurnId;
  role: "assistant";
  steps: Step[];
  /** Derived: current phase of this turn */
  phase: TurnPhase;
  /** Set when the turn completes */
  stopReason?: string;
  timestamp: number;
}

type Turn = UserTurn | AssistantTurn;

type TurnPhase =
  | "thinking"       // Agent is in extended thinking
  | "responding"     // Agent is generating text
  | "tool_calling"   // Agent is building a tool call
  | "tool_executing" // Tool is running (between tool_use and tool_result)
  | "complete";      // Turn finished

// ============================================================
// Conversation (Session) Model
// ============================================================

interface Conversation {
  sessionId: SessionId | null;
  turns: Turn[];
  /** Model name from the system init message */
  model: string | null;
  /** Available tools from the system init message */
  tools: string[];
}

// ============================================================
// Result / Usage Model
// ============================================================

interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

interface TurnResult {
  subtype: "success" | "error_max_turns" | "error_during_execution" | "error_max_budget_usd";
  result?: string;
  totalCostUsd: number;
  durationMs: number;
  numTurns: number;
  usage: UsageInfo;
}

// ============================================================
// Structured State Summary (derived, not stored)
// ============================================================

/**
 * At any point during streaming, the UI can derive this summary
 * from the current state. This is NOT stored separately — it's
 * computed from the conversation + automation state.
 */
interface AutomationSummary {
  /** Current high-level phase */
  phase: AutomationState;
  /** Current turn phase (if streaming) */
  turnPhase: TurnPhase | null;
  /** Number of completed steps in current turn */
  completedStepCount: number;
  /** Currently executing step (if any) */
  activeStep: Step | null;
  /** List of completed steps with brief descriptions */
  completedSteps: Array<{
    id: StepId;
    type: StepType;
    description: string; // e.g., "Called Read tool", "Generated 142 tokens"
    durationMs: number;
  }>;
  /** Elapsed time for current turn */
  elapsedMs: number;
}
```

---

## 3. Backend Event Protocol

### Design Decision: Dual-Layer Events

The backend emits two categories of SSE events:

1. **Raw SDK events** (`sdk:*`) — forwarded with minimal transformation for the raw stream view
2. **Structured step events** (`step:*`) — derived by the backend for the structured state view

This separates concerns: the frontend raw view can consume `sdk:*` events directly, while the structured view consumes `step:*` events. The backend owns the state machine logic for deriving steps from raw SDK events, which keeps the frontend simpler.

### SSE Event Protocol

```typescript
// ============================================================
// Raw SDK Events (forwarded from Agent SDK)
// ============================================================

/** Wrapper for all forwarded SDK messages */
type RawSDKEvent = {
  /** SSE event name: "sdk" */
  event: "sdk";
  data: SDKMessageEnvelope;
};

/** Thin envelope around the SDK message */
interface SDKMessageEnvelope {
  /** Original SDK message type */
  type: string;
  /** Timestamp when the server received this message */
  serverTimestamp: number;
  /** The raw SDK message payload */
  payload: unknown;
}

// ============================================================
// Structured Step Events (derived by backend)
// ============================================================

type StepEvent =
  | StepStartEvent
  | StepDeltaEvent
  | StepCompleteEvent
  | StepErrorEvent;

interface StepStartEvent {
  event: "step:start";
  data: {
    stepId: StepId;
    turnId: TurnId;
    type: StepType;
    blockIndex: number;
    /** For tool_use: tool name and call ID */
    toolName?: string;
    toolCallId?: string;
    timestamp: number;
  };
}

interface StepDeltaEvent {
  event: "step:delta";
  data: {
    stepId: StepId;
    /** The delta content — text chunk, thinking chunk, or input_json chunk */
    delta: string;
    /** Delta type for disambiguation */
    deltaType: "text" | "thinking" | "input_json";
    timestamp: number;
  };
}

interface StepCompleteEvent {
  event: "step:complete";
  data: {
    stepId: StepId;
    /** For tool_use: the parsed input */
    parsedInput?: Record<string, unknown>;
    timestamp: number;
  };
}

interface StepErrorEvent {
  event: "step:error";
  data: {
    stepId: StepId;
    error: string;
    timestamp: number;
  };
}

// ============================================================
// Lifecycle Events
// ============================================================

interface SessionInitEvent {
  event: "session:init";
  data: {
    sessionId: SessionId;
    model: string;
    tools: string[];
    timestamp: number;
  };
}

interface TurnStartEvent {
  event: "turn:start";
  data: {
    turnId: TurnId;
    timestamp: number;
  };
}

interface TurnCompleteEvent {
  event: "turn:complete";
  data: {
    turnId: TurnId;
    stopReason: string;
    timestamp: number;
  };
}

interface ResultEvent {
  event: "result";
  data: TurnResult;
}

interface ErrorEvent {
  event: "error";
  data: {
    message: string;
    code?: string;
    timestamp: number;
  };
}

interface DoneEvent {
  event: "done";
  data: "[DONE]";
}

// ============================================================
// Union of all SSE events
// ============================================================

type SSEEvent =
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
```

### Backend Processing Pipeline

The backend maintains a lightweight `StepTracker` per session that converts SDK messages into step events:

```typescript
/**
 * Backend-side state tracker that converts raw SDK messages
 * into structured step events. One instance per active session.
 */
class StepTracker {
  private currentTurnId: TurnId;
  private stepCounter = 0;
  private activeSteps: Map<number, StepId> = new Map(); // blockIndex -> stepId

  /**
   * Process an incoming SDK message and return zero or more
   * structured events to emit via SSE.
   */
  process(sdkMessage: SDKMessage): SSEEvent[] {
    const events: SSEEvent[] = [];

    // Always emit the raw SDK event
    events.push({
      event: "sdk",
      data: {
        type: sdkMessage.type,
        serverTimestamp: Date.now(),
        payload: sdkMessage,
      },
    });

    // Derive structured events based on message type
    switch (sdkMessage.type) {
      case "system":
        if (sdkMessage.subtype === "init") {
          events.push({
            event: "session:init",
            data: {
              sessionId: sdkMessage.session_id,
              model: sdkMessage.model,
              tools: sdkMessage.tools ?? [],
              timestamp: Date.now(),
            },
          });
        }
        break;

      case "stream_event":
        events.push(...this.processStreamEvent(sdkMessage.event));
        break;

      case "assistant":
        // Complete assistant message — emit turn:complete
        events.push({
          event: "turn:complete",
          data: {
            turnId: this.currentTurnId,
            stopReason: sdkMessage.message?.stop_reason ?? "unknown",
            timestamp: Date.now(),
          },
        });
        break;

      case "user":
        // Tool results — emit tool_result steps
        events.push(...this.processToolResults(sdkMessage));
        break;

      case "result":
        events.push({
          event: "result",
          data: {
            subtype: sdkMessage.subtype,
            result: sdkMessage.result,
            totalCostUsd: sdkMessage.total_cost_usd,
            durationMs: sdkMessage.duration_ms,
            numTurns: sdkMessage.num_turns,
            usage: {
              inputTokens: sdkMessage.usage.input_tokens,
              outputTokens: sdkMessage.usage.output_tokens,
              cacheCreationInputTokens: sdkMessage.usage.cache_creation_input_tokens,
              cacheReadInputTokens: sdkMessage.usage.cache_read_input_tokens,
            },
          },
        });
        events.push({ event: "done", data: "[DONE]" });
        break;
    }

    return events;
  }

  private processStreamEvent(event: StreamEvent): SSEEvent[] {
    const events: SSEEvent[] = [];

    switch (event.type) {
      case "message_start":
        this.currentTurnId = `turn_${Date.now()}`;
        events.push({
          event: "turn:start",
          data: { turnId: this.currentTurnId, timestamp: Date.now() },
        });
        break;

      case "content_block_start": {
        const stepId = `step_${++this.stepCounter}`;
        this.activeSteps.set(event.index, stepId);
        const block = event.content_block;

        events.push({
          event: "step:start",
          data: {
            stepId,
            turnId: this.currentTurnId,
            type: this.blockTypeToStepType(block.type),
            blockIndex: event.index,
            toolName: block.type === "tool_use" ? block.name : undefined,
            toolCallId: block.type === "tool_use" ? block.id : undefined,
            timestamp: Date.now(),
          },
        });
        break;
      }

      case "content_block_delta": {
        const stepId = this.activeSteps.get(event.index);
        if (!stepId) break;

        const delta = event.delta;
        let deltaText = "";
        let deltaType: "text" | "thinking" | "input_json" = "text";

        if (delta.type === "text_delta") {
          deltaText = delta.text;
          deltaType = "text";
        } else if (delta.type === "thinking_delta") {
          deltaText = delta.thinking;
          deltaType = "thinking";
        } else if (delta.type === "input_json_delta") {
          deltaText = delta.partial_json;
          deltaType = "input_json";
        }

        events.push({
          event: "step:delta",
          data: { stepId, delta: deltaText, deltaType, timestamp: Date.now() },
        });
        break;
      }

      case "content_block_stop": {
        const stepId = this.activeSteps.get(event.index);
        if (!stepId) break;
        this.activeSteps.delete(event.index);

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
      case "thinking": return "thinking";
      case "tool_use": return "tool_use";
      case "text":
      default: return "text";
    }
  }

  private processToolResults(userMessage: SDKUserMessage): SSEEvent[] {
    // Tool results come as user messages with tool_result content blocks.
    // Each one corresponds to a previous tool_use step.
    const events: SSEEvent[] = [];

    for (const block of userMessage.message?.content ?? []) {
      if (block.type === "tool_result") {
        const stepId = `step_${++this.stepCounter}`;
        events.push({
          event: "step:start",
          data: {
            stepId,
            turnId: this.currentTurnId,
            type: "tool_result",
            blockIndex: -1, // tool results don't have a block index
            toolCallId: block.tool_use_id,
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
```

---

## 4. Frontend State Shape

### Root State

```typescript
// ============================================================
// Frontend Root State
// ============================================================

interface AgentViewState {
  /** High-level automation state */
  automation: AutomationState;

  /** The full conversation */
  conversation: Conversation;

  /** Current turn result (set on completion) */
  lastResult: TurnResult | null;

  /** Error info (set when automation is in "error" state) */
  error: { message: string; code?: string } | null;

  /** Raw event log for the raw stream view */
  rawEvents: RawEvent[];

  /** Connection metadata */
  connection: {
    /** Whether SSE connection is active */
    isConnected: boolean;
    /** Time of last received event */
    lastEventAt: number | null;
  };
}

/** A single raw event for the log view */
interface RawEvent {
  id: number; // monotonic counter for React keys
  timestamp: number;
  type: string; // SDK message type
  payload: unknown; // the full raw message
}

// Initial state
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
  connection: {
    isConnected: false,
    lastEventAt: null,
  },
};
```

### State Update Logic (Reducer Pattern)

```typescript
// ============================================================
// Actions (from SSE events -> state updates)
// ============================================================

type StateAction =
  // Lifecycle
  | { type: "SUBMIT_PROMPT"; prompt: string }
  | { type: "CONNECTION_OPENED" }
  | { type: "CONNECTION_CLOSED" }
  | { type: "USER_ABORT" }

  // Session
  | { type: "SESSION_INIT"; sessionId: string; model: string; tools: string[] }

  // Turn lifecycle
  | { type: "TURN_START"; turnId: TurnId }
  | { type: "TURN_COMPLETE"; turnId: TurnId; stopReason: string }

  // Step lifecycle
  | { type: "STEP_START"; step: StepStartEvent["data"] }
  | { type: "STEP_DELTA"; stepId: StepId; delta: string; deltaType: string }
  | { type: "STEP_COMPLETE"; stepId: StepId; parsedInput?: Record<string, unknown> }
  | { type: "STEP_ERROR"; stepId: StepId; error: string }

  // Result
  | { type: "RESULT"; result: TurnResult }

  // Error
  | { type: "ERROR"; message: string; code?: string }

  // Raw events (for log view)
  | { type: "RAW_EVENT"; event: RawEvent };


function agentViewReducer(state: AgentViewState, action: StateAction): AgentViewState {
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
      return {
        ...state,
        automation: "idle",
        connection: { ...state.connection, isConnected: false },
      };

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

    case "STEP_START": {
      return updateCurrentAssistantTurn(state, (turn) => {
        const newStep = createStep(action.step);
        const phase = stepTypeToPhase(action.step.type);
        return { ...turn, steps: [...turn.steps, newStep], phase };
      });
    }

    case "STEP_DELTA": {
      return updateCurrentAssistantTurn(state, (turn) => ({
        ...turn,
        steps: turn.steps.map((step) =>
          step.id === action.stepId
            ? appendDelta(step, action.delta)
            : step
        ),
      }));
    }

    case "STEP_COMPLETE": {
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
            : step
        ),
        // After a tool_use completes, phase becomes "tool_executing"
        // (waiting for tool_result). Otherwise keep current phase.
        phase: turn.steps.find((s) => s.id === action.stepId)?.type === "tool_use"
          ? "tool_executing"
          : turn.phase,
      }));
    }

    case "TURN_COMPLETE": {
      return updateCurrentAssistantTurn(state, (turn) => ({
        ...turn,
        phase: "complete",
        stopReason: action.stopReason,
      }));
    }

    case "RESULT":
      return {
        ...state,
        automation: action.result.subtype === "success" ? "complete" : "error",
        lastResult: action.result,
        error: action.result.subtype !== "success"
          ? { message: `Agent ended with: ${action.result.subtype}` }
          : null,
      };

    case "ERROR":
      return {
        ...state,
        automation: "error",
        error: { message: action.message, code: action.code },
      };

    case "RAW_EVENT":
      return {
        ...state,
        rawEvents: [...state.rawEvents, action.event],
        connection: { ...state.connection, lastEventAt: action.event.timestamp },
      };

    default:
      return state;
  }
}

// ============================================================
// Helper Functions
// ============================================================

function updateCurrentAssistantTurn(
  state: AgentViewState,
  updater: (turn: AssistantTurn) => AssistantTurn,
): AgentViewState {
  const turns = [...state.conversation.turns];
  const lastTurn = turns[turns.length - 1];
  if (!lastTurn || lastTurn.role !== "assistant") return state;
  turns[turns.length - 1] = updater(lastTurn as AssistantTurn);
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
        toolCallId: data.toolCallId!,
        toolName: data.toolName!,
        inputJson: "",
      };
    case "tool_result":
      return {
        ...base,
        type: "tool_result",
        toolCallId: data.toolCallId!,
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

function stepTypeToPhase(type: StepType): TurnPhase {
  switch (type) {
    case "thinking": return "thinking";
    case "text": return "responding";
    case "tool_use": return "tool_calling";
    case "tool_result": return "tool_executing";
  }
}
```

### Rendering Both Views Efficiently

The dual raw+structured view is handled by the state shape itself:

- **Structured view** reads from `conversation.turns[].steps[]` — this is the hierarchical, processed view
- **Raw stream view** reads from `rawEvents[]` — this is the append-only log of every SDK message

Both are updated by the same incoming SSE events (a single event dispatches both a structured action AND a `RAW_EVENT` action), so they stay synchronized without duplication of event processing logic.

```typescript
// In the SSE event handler:
function handleSSEEvent(event: SSEEvent, dispatch: (action: StateAction) => void) {
  // Always log raw SDK events
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

  // Process structured events
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
      dispatch({ type: "STEP_DELTA", ...event.data });
      break;
    case "step:complete":
      dispatch({ type: "STEP_COMPLETE", ...event.data });
      break;
    case "step:error":
      dispatch({ type: "STEP_ERROR", ...event.data });
      break;
    case "turn:complete":
      dispatch({ type: "TURN_COMPLETE", ...event.data });
      break;
    case "result":
      dispatch({ type: "RESULT", result: event.data });
      break;
    case "error":
      dispatch({ type: "ERROR", ...event.data });
      break;
  }
}
```

---

## 5. SDK Message -> State Transition Mapping

This table maps every relevant SDK message type to the state transitions and step events it produces:

| SDK Message | `type` field | Stream Event subtype | State Transition | Step Event(s) Emitted |
|---|---|---|---|---|
| System init | `system` | `init` | `initiating -> streaming` | `session:init` |
| Stream: message_start | `stream_event` | `message_start` | (none — already streaming) | `turn:start` |
| Stream: content_block_start (text) | `stream_event` | `content_block_start` | phase -> `responding` | `step:start { type: "text" }` |
| Stream: content_block_start (thinking) | `stream_event` | `content_block_start` | phase -> `thinking` | `step:start { type: "thinking" }` |
| Stream: content_block_start (tool_use) | `stream_event` | `content_block_start` | phase -> `tool_calling` | `step:start { type: "tool_use" }` |
| Stream: content_block_delta (text_delta) | `stream_event` | `content_block_delta` | (none) | `step:delta { deltaType: "text" }` |
| Stream: content_block_delta (thinking_delta) | `stream_event` | `content_block_delta` | (none) | `step:delta { deltaType: "thinking" }` |
| Stream: content_block_delta (input_json_delta) | `stream_event` | `content_block_delta` | (none) | `step:delta { deltaType: "input_json" }` |
| Stream: content_block_stop | `stream_event` | `content_block_stop` | phase -> `tool_executing` (if was tool_use) | `step:complete` |
| Stream: message_delta | `stream_event` | `message_delta` | (none — contains stop_reason, usage) | (none — info captured in turn:complete) |
| Stream: message_stop | `stream_event` | `message_stop` | (none) | (none) |
| Assistant (complete) | `assistant` | — | (none) | `turn:complete` |
| User (tool results) | `user` | — | (none) | `step:start + step:complete` for each tool_result |
| Result (success) | `result` | — | `streaming -> complete` | `result`, `done` |
| Result (error_*) | `result` | — | `streaming -> error` | `result`, `done` |
| Status | `status` | — | (none) | (forwarded as raw only) |
| Tool progress | `tool_progress` | — | (none) | (forwarded as raw only) |
| Rate limit | `rate_limit` | — | (none) | (forwarded as raw only) |

### Multi-Turn Tool Loop Example

A typical agent turn with tool use produces this event sequence:

```
1. system (init)                    -> session:init
2. stream_event (message_start)     -> turn:start
3. stream_event (content_block_start, text)      -> step:start (text, step_1)
4. stream_event (content_block_delta, text_delta) -> step:delta (step_1, "I'll read...")
5. stream_event (content_block_stop)             -> step:complete (step_1)
6. stream_event (content_block_start, tool_use)  -> step:start (tool_use, step_2, "Read")
7. stream_event (content_block_delta, input_json) -> step:delta (step_2, '{"file_path":...')
8. stream_event (content_block_stop)             -> step:complete (step_2)
9. stream_event (message_delta)                  -> (captured for stop_reason)
10. stream_event (message_stop)                  -> (noop)
11. assistant (complete message)                 -> turn:complete
12. user (tool_result for Read)                  -> step:start + step:complete (tool_result, step_3)
13. stream_event (message_start)                 -> turn:start (new sub-turn)
14. stream_event (content_block_start, text)     -> step:start (text, step_4)
15. stream_event (content_block_delta, text_delta) -> step:delta (step_4, "The file contains...")
16. stream_event (content_block_stop)            -> step:complete (step_4)
17. stream_event (message_delta)                 -> (stop_reason: "end_turn")
18. stream_event (message_stop)                  -> (noop)
19. assistant (complete message)                 -> turn:complete
20. result (success)                             -> result + done
```

The structured view at step 12 would show:

```
Turn 1 (assistant):
  [complete] Text: "I'll read the file..."          (step_1)
  [complete] Tool: Read({ file_path: "..." })       (step_2)
  [complete] Tool Result: Read -> (200 lines)       (step_3)
  [running]  Text: "The file contains..."           (step_4)  <- currently streaming
```

---

## 6. Design Decisions & Rationale

### Why backend-derived steps (not frontend-only)?

1. **Single source of truth**: The backend owns the state machine, avoiding divergence between multiple frontends
2. **Testability**: Step derivation logic can be unit tested independently of the UI
3. **Future-proofing**: When we add multi-agent (Step 3), the backend can track cross-agent step hierarchies
4. **Bandwidth**: Step events are small; raw events are forwarded anyway for the log view

### Why not XState/formal state machine library?

For Step 1, a `useReducer`-based approach is sufficient. The state transitions are linear (no parallel states, no hierarchical substates needed yet). If complexity grows in Steps 2-5, we can migrate the reducer to XState — the action/event model is compatible.

### Why separate `rawEvents` from `conversation`?

- `rawEvents` is an append-only log optimized for the raw stream view (virtualized list)
- `conversation.turns[].steps[]` is a structured tree optimized for the step view (collapsible panels)
- They serve different rendering needs and update patterns

### Why `phase` on AssistantTurn instead of global?

The phase is scoped to a turn because in multi-turn tool loops (Step 2+), the agent may complete one turn, execute a tool, and start a new sub-turn. The per-turn phase accurately reflects where each turn is in its lifecycle.

### Immutability considerations

The reducer produces new state objects on every update. For high-frequency `step:delta` events (token streaming), this means frequent re-renders. Mitigation strategies:
- **React.memo** on components that don't depend on the streaming content
- **Selector functions** that extract only the data each component needs
- **requestAnimationFrame batching** for delta events (batch multiple deltas into one state update per frame)
- The raw events array should use a ring buffer (capped at e.g., 10,000 entries) to prevent unbounded growth
