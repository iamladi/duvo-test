---
date: 2026-03-03
git_commit: null
branch: main
repository: duvo-test
topic: "Observable automation view for Claude Agent SDK conversations"
tags: [observable-automation, agent-sdk, react, sse, streaming, state-machine, step-timeline, tool-use, reducer]
status: complete
last_updated: 2026-03-03
last_updated_by: research-team
---

# Research: Observable Automation View

## Research Question

How to design and build a view that observes Claude Agent SDK automation as it unfolds step by step — showing both raw streaming output and a structured state summary, so the user can derive the key state of the automation at any point during execution.

## Summary

**Team composition**: 4 researchers — Locator (SDK message catalog), Analyzer (state model & event protocol), Pattern Finder (UI patterns from existing tools), Web Researcher (external best practices & libraries). All four completed successfully.

**Interview decisions**: Agent SDK conversations scope, raw stream + structured state fidelity, full-stack depth, design spec output.

**Key findings**:

1. **The SDK emits 18+ message types** but only 7 are primary user-visible steps: `system` (init), `stream_event` (token streaming + tool call identification), `assistant` (complete turns), `user` (tool results), `result` (final outcome), `tool_progress` (long-running tools), `tool_use_summary` (condensed summaries). These map cleanly to a step timeline UI.

2. **Dual-layer event protocol**: The backend should emit both raw SDK events (`sdk:*`) and derived structured events (`step:*`, `turn:*`, `session:*`). A `StepTracker` class on the backend converts SDK messages into structured step events. The frontend consumes structured events for the step view and raw events for the log view.

3. **Hierarchy is Conversation > Turn > Step > Detail**: Each assistant turn contains steps (thinking, text, tool_use, tool_result). Steps have a lifecycle: `pending → running → complete | error`. Turns have phases: `thinking → responding → tool_calling → tool_executing → complete`.

4. **`useReducer` is sufficient** for state management. No XState or Zustand needed for Step 1. The reducer dispatches actions from SSE events, maintaining both a structured conversation tree and a raw event log.

5. **Industry patterns converge on a step timeline** with expandable detail (GitHub Actions, LangSmith, Vercel AI SDK). Key patterns: sequential step list with collapsible items, typed state machine components, status indicator system, custom renderers per tool type, dual view (raw + structured), auto-scroll with pause-on-scroll-up.

---

## Detailed Findings

### 1. SDK Message Type Catalog [Locator] [Consensus]

The Claude Agent SDK's `query()` returns `AsyncGenerator<SDKMessage>` — a union of **18+ types**, organized into three tiers of observability.

#### Tier 1: Primary User-Visible Steps

| Type | `type` field | When emitted | Key data | User-visible step |
|------|-------------|--------------|----------|-------------------|
| SDKSystemMessage | `"system"` (subtype: `"init"`) | First message | `session_id`, `tools`, `model` | "Session started" |
| SDKPartialAssistantMessage | `"stream_event"` | Token streaming | `event: BetaRawMessageStreamEvent` | Text tokens, tool call identification, thinking |
| SDKAssistantMessage | `"assistant"` | Complete turn | `message.content: ContentBlock[]`, `parent_tool_use_id` | "Agent response complete" |
| SDKUserMessage | `"user"` | Tool results | `message.content: ToolResultBlock[]` | "Tool X returned result" |
| SDKResultMessage | `"result"` | Automation complete | `total_cost_usd`, `duration_ms`, `usage` | "Automation complete" or "Failed" |
| SDKToolProgressMessage | `"tool_progress"` | Long-running tools | `tool_name`, `elapsed_time_seconds` | "Tool X running... (Ns)" |
| SDKToolUseSummaryMessage | `"tool_use_summary"` | After tool usage | `summary`, `preceding_tool_use_ids` | Compact summary |

#### Tier 2: Conditionally Visible

| Type | `type` field | When to show |
|------|-------------|--------------|
| SDKStatusMessage | `"system"` (subtype: `"status"`) | Show "Compacting..." indicator |
| SDKCompactBoundaryMessage | `"system"` (subtype: `"compact_boundary"`) | Show "Context compacted" |
| SDKTaskStartedMessage | `"system"` (subtype: `"task_started"`) | Multi-agent: "Task started" |
| SDKTaskProgressMessage | `"system"` (subtype: `"task_progress"`) | Multi-agent: task updates |
| SDKTaskNotificationMessage | `"system"` (subtype: `"task_notification"`) | Multi-agent: "Task completed" |
| SDKRateLimitEvent | `"rate_limit_event"` | Warning/error on rate limits |
| SDKAuthStatusMessage | `"auth_status"` | Authentication in progress |
| SDKPromptSuggestionMessage | `"prompt_suggestion"` | Suggested next prompts |

#### Tier 3: Hidden (infrastructure)

SDKHookStartedMessage, SDKHookProgressMessage, SDKHookResponseMessage, SDKFilesPersistedEvent, SDKUserMessageReplay — internal plumbing, not shown in UI unless debug mode.

#### Stream Event Inner Types [Locator]

The `stream_event` message wraps Anthropic's `BetaRawMessageStreamEvent`. The inner events critical for rendering:

| Inner event | Delta type | What it provides |
|------------|-----------|-----------------|
| `content_block_start` | — | New block: `text`, `tool_use` (with `id`, `name`), or `thinking` |
| `content_block_delta` | `text_delta` | Individual text tokens for streaming display |
| `content_block_delta` | `input_json_delta` | Partial JSON of tool input being constructed |
| `content_block_delta` | `thinking_delta` | Extended thinking content |
| `content_block_stop` | — | Block complete |
| `message_start` | — | New assistant message begins |
| `message_delta` | — | Top-level changes: `stop_reason`, cumulative `usage` |
| `message_stop` | — | Message complete |

#### Tool Use Message Flow [Locator]

When the agent uses a tool, the exact message sequence is:

```
1. stream_event: content_block_start { type: "text" }
2. stream_event: content_block_delta { type: "text_delta" }    (agent reasoning)
3. stream_event: content_block_stop
4. stream_event: content_block_start { type: "tool_use", id, name }
5. stream_event: content_block_delta { type: "input_json_delta" }  (partial JSON)
6. stream_event: content_block_stop
7. stream_event: message_delta { stop_reason: "tool_use" }
8. stream_event: message_stop
9. assistant { content: [TextBlock, ToolUseBlock, ...] }   (complete turn)
   --- tool execution ---
10. tool_progress { tool_name, elapsed_time_seconds }       (for long-running tools)
11. user { content: [ToolResultBlock, ...] }                (tool results)
12. tool_use_summary { summary }                            (optional summary)
    --- agent processes results, may do more tool calls ---
13. stream_event: ... (next response)
14. result { subtype: "success", total_cost_usd, ... }
```

**Parallel tool calls**: Multiple `ToolUseBlock` entries in a single assistant `content` array = parallel calls within one turn. Across turns, tool calls are sequential.

**Nested agents**: `parent_tool_use_id` on assistant/user messages indicates subagent nesting. SDKTaskStarted/Progress/Notification messages track background task lifecycle.

---

### 2. State Model Design [Analyzer]

Full specification lives in `research/state-model-spec.md`. Key design elements:

#### Automation Lifecycle

```
idle → initiating → streaming → complete
                 \→ error      \→ error
```

Five states: `idle` (ready for input), `initiating` (waiting for first SDK event), `streaming` (receiving events), `complete` (success), `error` (failure). The `complete → idle` transition is automatic.

#### Data Hierarchy

```
Conversation (session)
  └── Turn[]
        ├── UserTurn { content: string }
        └── AssistantTurn { steps: Step[], phase: TurnPhase }
              └── Step = ThinkingStep | TextStep | ToolUseStep | ToolResultStep
```

Each step has: `id`, `type`, `status` (pending/running/complete/error), `startTime`, `endTime`, and type-specific data.

**TurnPhase** tracks where a turn is: `thinking | responding | tool_calling | tool_executing | complete`.

#### Structured State Summary (derived, not stored)

```typescript
interface AutomationSummary {
  phase: AutomationState;
  turnPhase: TurnPhase | null;
  completedStepCount: number;
  activeStep: Step | null;
  completedSteps: Array<{ id, type, description, durationMs }>;
  elapsedMs: number;
}
```

This is computed on demand from the conversation state — no separate storage needed.

---

### 3. Backend Event Protocol [Analyzer] [Web Researcher] [Consensus]

#### Design Decision: Dual-Layer Events

Both researchers independently recommended the same pattern: the backend emits **two categories** of SSE events simultaneously.

1. **Raw SDK events** (`sdk`) — forwarded SDK messages for the raw stream view
2. **Structured events** (`step:start`, `step:delta`, `step:complete`, `turn:start`, `turn:complete`, `session:init`, `result`, `error`, `done`) — derived by a `StepTracker` class for the structured view

This separates concerns: the frontend raw view consumes `sdk` events directly, while the structured view consumes `step:*` events. The backend owns the state machine logic.

#### StepTracker Class

A lightweight per-session processor that converts SDK messages into structured events:

```typescript
class StepTracker {
  private currentTurnId: TurnId;
  private stepCounter = 0;
  private activeSteps: Map<number, StepId> = new Map(); // blockIndex → stepId

  process(sdkMessage: SDKMessage): SSEEvent[] {
    const events: SSEEvent[] = [];
    // Always emit raw SDK event
    events.push({ event: "sdk", data: { type: sdkMessage.type, serverTimestamp: Date.now(), payload: sdkMessage } });
    // Derive structured events based on message type
    // ... (full implementation in research/state-model-spec.md)
    return events;
  }
}
```

Key mappings:
- `content_block_start` → `step:start` (with step type derived from block type)
- `content_block_delta` → `step:delta` (text, thinking, or input_json)
- `content_block_stop` → `step:complete`
- `message_start` → `turn:start`
- `assistant` complete → `turn:complete`
- `user` with tool results → `step:start + step:complete` for each result
- `result` → `result` + `done`

#### SSE Event Type Definitions

```typescript
type SSEEvent =
  | { event: "sdk"; data: SDKMessageEnvelope }
  | { event: "session:init"; data: { sessionId, model, tools, timestamp } }
  | { event: "turn:start"; data: { turnId, timestamp } }
  | { event: "turn:complete"; data: { turnId, stopReason, timestamp } }
  | { event: "step:start"; data: { stepId, turnId, type, blockIndex, toolName?, toolCallId?, timestamp } }
  | { event: "step:delta"; data: { stepId, delta, deltaType, timestamp } }
  | { event: "step:complete"; data: { stepId, parsedInput?, timestamp } }
  | { event: "step:error"; data: { stepId, error, timestamp } }
  | { event: "result"; data: TurnResult }
  | { event: "error"; data: { message, code?, timestamp } }
  | { event: "done"; data: "[DONE]" };
```

---

### 4. Frontend State Model [Analyzer] [Web Researcher] [Consensus]

Both researchers converged on `useReducer` as the state management approach.

#### Root State Shape

```typescript
interface AgentViewState {
  automation: AutomationState;  // idle | initiating | streaming | complete | error
  conversation: Conversation;    // sessionId, turns[], model, tools
  lastResult: TurnResult | null;
  error: { message: string; code?: string } | null;
  rawEvents: RawEvent[];         // append-only log for raw stream view
  connection: { isConnected: boolean; lastEventAt: number | null };
}
```

#### Reducer Actions

```typescript
type StateAction =
  | { type: "SUBMIT_PROMPT"; prompt: string }
  | { type: "CONNECTION_OPENED" }
  | { type: "CONNECTION_CLOSED" }
  | { type: "USER_ABORT" }
  | { type: "SESSION_INIT"; sessionId: string; model: string; tools: string[] }
  | { type: "TURN_START"; turnId: TurnId }
  | { type: "TURN_COMPLETE"; turnId: TurnId; stopReason: string }
  | { type: "STEP_START"; step: StepStartData }
  | { type: "STEP_DELTA"; stepId: StepId; delta: string; deltaType: string }
  | { type: "STEP_COMPLETE"; stepId: StepId; parsedInput?: Record<string, unknown> }
  | { type: "STEP_ERROR"; stepId: StepId; error: string }
  | { type: "RESULT"; result: TurnResult }
  | { type: "ERROR"; message: string; code?: string }
  | { type: "RAW_EVENT"; event: RawEvent };
```

The SSE event handler bridges SSE events to reducer actions — a single incoming SSE event dispatches both a structured action AND a `RAW_EVENT` action to keep both views synchronized.

Full reducer implementation is in `research/state-model-spec.md`.

---

### 5. UI Patterns from Existing Tools [Pattern Finder]

10 patterns identified across 6+ tools (Claude Code, GitHub Actions, LangSmith, LangFuse, Vercel AI SDK, Temporal, Dagster, AgentPrism):

#### Primary Patterns (must implement)

| # | Pattern | Used by | Application |
|---|---------|---------|-------------|
| 1 | **Sequential Step List with Expandable Detail** | Claude Code, GitHub Actions, Vercel AI SDK | Primary raw stream view — each action is a collapsible list item |
| 2 | **Typed Part Rendering with State Machine** | Vercel AI SDK, Temporal | Each step is a state machine component with distinct rendering per state |
| 5 | **Real-Time Streaming with Auto-Scroll** | Claude Code, GitHub Actions | Stream `content_block_delta` tokens, auto-scroll, pause on scroll-up |
| 6 | **Dual View (Raw + Structured)** | LangFuse, LangSmith, Dagster | Two synchronized panes — raw stream left, structured state right |
| 7 | **Status Indicator System** | All tools | Consistent icons/colors: pending (gray), active (blue pulse), running (orange spinner), complete (green check), error (red X) |
| 8 | **Generative UI / Custom Step Renderers** | Vercel AI SDK, Claude Code | Specialized renderers per tool type: Read→syntax highlight, Edit→diff, Bash→terminal |

#### Secondary Patterns (nice to have)

| # | Pattern | Application |
|---|---------|-------------|
| 3 | **Hierarchical Tree View** | Structured state view — Conversation > Turn > Steps tree |
| 4 | **Timeline/Gantt Visualization** | Optional performance analysis view |
| 9 | **Search and Filter** | Filter steps by type, tool name, status |
| 10 | **Split Panel Detail View** | Click step → detail panel with full I/O |

---

### 6. Recommended Component Architecture [Pattern Finder] [Web Researcher] [Consensus]

```
<ObservableAutomationView>
  ├── <ViewToggle mode="raw|structured|split" />
  ├── <SplitPane>
  │   ├── <RawStreamView>                     // Pattern 1 + 5
  │   │   ├── <StepList>
  │   │   │   ├── <StepItem status state>     // Pattern 2 + 7
  │   │   │   │   ├── <StatusIndicator />
  │   │   │   │   ├── <StepSummary />         // collapsed: icon + name + status
  │   │   │   │   └── <StepContent />         // expanded: Pattern 8
  │   │   │   │       ├── <ThinkingBlock />   // muted italic
  │   │   │   │       ├── <ToolCallBlock />   // input JSON
  │   │   │   │       ├── <DiffBlock />       // Edit tool diff
  │   │   │   │       ├── <CodeBlock />       // syntax-highlighted
  │   │   │   │       └── <MarkdownBlock />   // response text
  │   │   └── <FilterBar />                   // Pattern 9
  │   │
  │   └── <StructuredStateView>               // Pattern 3 + 6
  │       ├── <ConversationTree>              // Turn > Steps hierarchy
  │       ├── <StateSummary>                  // Derived automation state
  │       │   ├── <CurrentPhase />
  │       │   ├── <CompletedSteps />
  │       │   ├── <ActiveStep />
  │       │   └── <TokensUsed />
  │       └── <TimelineView />                // Pattern 4 (optional)
  │
  └── <DetailPanel />                         // Pattern 10
      <ResultFooter />                        // cost, tokens, duration
```

---

### 7. Libraries and Dependencies [Web Researcher]

| Library | Purpose | When to add |
|---------|---------|-------------|
| `@radix-ui/react-accordion` | Expandable step cards | Required |
| `lucide-react` | Status icons (Loader2, CheckCircle2, XCircle) | Required |
| `react-resizable-panels` | Split pane layout | Required |
| `tailwind-merge` + `clsx` | Conditional class merging | Required |
| `@evilmartians/agent-prism` | AI agent trace visualization (alpha) | Evaluate |
| `xstate` + `@xstate/react` | Only if permission flows added | Deferred |
| `zustand` | Only if multi-run history needed | Deferred |

No specialized AI streaming library needed. The pattern is `useReducer` + `fetch` + `ReadableStream`.

---

### 8. Performance Considerations [Analyzer]

For high-frequency `step:delta` events (token streaming at ~30-60fps):

1. **requestAnimationFrame batching** — batch multiple deltas into one state update per frame
2. **React.memo** — on components that don't depend on streaming content
3. **Selector functions** — extract only the data each component needs
4. **Ring buffer for rawEvents** — cap at ~10,000 entries to prevent unbounded growth
5. **Separate rawEvents from conversation** — different update patterns, different rendering needs (virtualized log vs collapsible tree)

---

## Code References

### Full Implementation Specs
- State model, types, backend StepTracker, frontend reducer: `research/state-model-spec.md`
- Web research report with hook/component code: `research/research-observable-automation-ui.md`

### SDK Documentation
- Claude Agent SDK overview: https://platform.claude.com/docs/en/agent-sdk/overview
- TypeScript API: https://platform.claude.com/docs/en/agent-sdk/typescript
- SDK demos: https://github.com/anthropics/claude-agent-sdk-demos

### UI Pattern Sources
- Vercel AI SDK tool invocations: https://sdk.vercel.ai/docs/ai-sdk-ui/chatbot-with-tool-calling
- LangSmith trace viewer: https://docs.smith.langchain.com/concepts/tracing
- Radix Accordion: https://www.radix-ui.com/primitives/docs/components/accordion
- Hono SSE helper: https://hono.dev/docs/helpers/streaming

---

## Architecture Documentation

### System Architecture

```
Browser (React + Vite)
    │
    │  POST /api/agent { prompt, sessionId? }
    │  ← SSE stream: sdk + step:* + turn:* + session:* + result events
    │
Bun Server (Hono)
    │  StepTracker converts SDK messages → structured events
    │  Emits both raw + structured via streamSSE
    │
    │  query({ prompt, options })
    │  ← AsyncGenerator<SDKMessage>
    │
Claude Agent SDK
    │  Spawns subprocess, JSON-over-stdio
    │
Claude API
```

### Data Flow

1. User submits prompt → `SUBMIT_PROMPT` action → state becomes `initiating`
2. Frontend POSTs to `/api/agent` → SSE stream opens → `CONNECTION_OPENED`
3. Backend calls `query()` with `includePartialMessages: true`
4. SDK emits messages → `StepTracker.process()` produces dual events:
   - `sdk` event → frontend dispatches `RAW_EVENT` → appends to `rawEvents[]`
   - `step:start` → dispatches `STEP_START` → new step in `conversation.turns[].steps[]`
   - `step:delta` → dispatches `STEP_DELTA` → step content grows
   - `step:complete` → dispatches `STEP_COMPLETE` → step status = complete
5. Tool use cycle: `step:start(tool_use)` → `step:delta(input_json)` → `step:complete` → tool executes → `step:start(tool_result)` → `step:complete`
6. Agent may do multiple tool-use cycles before final response
7. `result` event → `RESULT` action → state becomes `complete` or `error`
8. Stream closes → `CONNECTION_CLOSED`

### State at Any Point

During execution, the UI derives `AutomationSummary` from current state:

```
Phase: streaming
Turn phase: tool_executing
Steps completed: 3
  [✓] Text: "I'll read the file..." (0.8s)
  [✓] Tool: Read({ file_path: "/src/index.ts" }) (0.2s)
  [✓] Tool Result: Read → 200 lines (0.1s)
Active step:
  [⟳] Text: "The file contains a Hono server..." (streaming)
Elapsed: 4.2s
```

---

## Related Research

- `research/research-agent-frontend-claude-sdk.md` — SDK internals, streaming architecture, project setup
- `research/state-model-spec.md` — Full TypeScript type definitions, StepTracker implementation, reducer code
- `research/research-observable-automation-ui.md` — Web research on UI patterns, hook implementation, component code

---

## Open Questions

1. **Tool input streaming UX**: Show partial `inputPartial` JSON while accumulating, or wait for `inputFinal`? Streaming JSON is often unreadable mid-stream. [Web Researcher]

2. **Permission gates**: If `canUseTool` is added later, the frontend needs a second channel (POST endpoint) for mid-stream approvals since SSE is unidirectional. Design now or defer? [Web Researcher] [Analyzer]

3. **Auto-scroll behavior**: Auto-scroll to latest step, or pin-to-bottom only when user hasn't scrolled up? Need a "scroll to bottom" button for the latter. [Pattern Finder]

4. **Step ordering in UI**: Tool calls and text can interleave. Should the UI group consecutive text blocks or treat each separately? [Web Researcher]

5. **Multi-turn state reset**: When a follow-up message is sent, should completed steps from the previous turn be collapsed/dimmed, or kept at full visibility? [Analyzer]

6. **Dual-layer vs single-layer protocol**: The Analyzer proposed `step:*` events derived by backend StepTracker. The Web Researcher proposed typed semantic events (`tool_start`, `tool_result`, etc.) without the raw `sdk` pass-through. Both approaches work — the dual-layer approach (Analyzer) is more flexible but adds bandwidth. Which to implement? [Divergence point]

7. **XState migration path**: The reducer is sufficient for Step 1, but Steps 2-5 add tool permissions, multi-agent, and complex flows. Should the reducer be designed now to be XState-compatible? [Analyzer] [Web Researcher]
