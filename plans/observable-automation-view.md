---
title: "Observable Automation View"
type: Feature
issue: null
research: ["research/research-observable-automation.md", "research/state-model-spec.md", "research/research-observable-automation-ui.md"]
status: Ready for Implementation
reviewed: true
reviewers: ["codex", "gemini"]
created: 2026-03-03
---

# PRD: Observable Automation View

## Metadata
- **Type**: Feature
- **Priority**: High
- **Estimated Complexity**: 5 (across 5 phases, each ≤5)
- **Created**: 2026-03-03
- **Status**: Ready for Implementation

## Overview

### Problem Statement

The current chat UI (`AgentChat.tsx` + `useAgentStream.ts`) treats the agent as a black box — it shows a flat chat bubble with streamed text and a tool name indicator, but provides no visibility into the agent's step-by-step execution. When the agent reads files, calls tools, thinks, and responds across multiple turns, the user has no way to see what's happening, what already happened, or what's currently executing.

Additionally, the application is currently non-functional: the Anthropic API returns 500 errors, making it impossible to test or use any UI.

### Goals & Objectives

1. **Fix the base**: Diagnose and resolve the API 500 errors so the agent chat functions end-to-end
2. **Dual-layer event protocol**: Backend emits both raw SDK events and derived structured step events via SSE
3. **Split pane view**: Raw stream (left) + structured state summary (right) displaying the automation as it unfolds
4. **Step lifecycle visibility**: Each step (thinking, text, tool_use, tool_result) shows status (pending → running → complete/error) with expandable detail
5. **Derived state summary**: Real-time automation summary showing phase, active step, completed steps, and elapsed time

### Success Metrics

- **Primary Metric**: Agent automation is observable — user can see every step as it happens in real-time
- **Secondary Metrics**:
  - All 7 primary SDK message types (system, stream_event, assistant, user, result, tool_progress, tool_use_summary) are captured and displayed
  - Split pane renders both raw log and structured state simultaneously
  - Auto-scroll works with pause-on-scroll-up
- **Quality Gates**:
  - Basic chat works end-to-end (500 errors resolved)
  - StepTracker unit tests pass
  - Reducer unit tests pass
  - E2E test: send prompt → see steps → see result

## User Stories

### Story 1: Observe agent execution
- **As a**: Developer using the local agent UI
- **I want**: To see each step the agent takes (reading files, calling tools, generating text) as it happens
- **So that**: I understand what the agent is doing and can assess whether it's on the right track
- **Acceptance Criteria**:
  - [ ] Each step appears in the raw stream as it starts
  - [ ] Steps show status indicators (spinning for active, check for complete, X for error)
  - [ ] Tool use steps show the tool name; full input shown on completion
  - [ ] Text steps stream tokens in real-time

### Story 2: Understand automation state at a glance
- **As a**: Developer monitoring an automation
- **I want**: A structured summary pane showing current phase, completed steps, and active step
- **So that**: I can quickly understand where the automation is without reading the full stream
- **Acceptance Criteria**:
  - [ ] Summary shows: automation phase, turn phase, completed step count, active step, elapsed time
  - [ ] Completed steps listed with type, description, and duration
  - [ ] Summary updates in real-time as steps complete

### Story 3: Review raw SDK events
- **As a**: Developer debugging agent behavior
- **I want**: Access to the raw SDK event log alongside the structured view
- **So that**: I can inspect the exact messages the SDK produces
- **Acceptance Criteria**:
  - [ ] Raw events shown in append-only log with timestamp and type
  - [ ] Log auto-scrolls to bottom; pauses when I scroll up
  - [ ] "Jump to bottom" button appears when scrolled up

## Requirements

### Functional Requirements

1. **FR-1**: Backend StepTracker processes SDK messages into structured step events
   - Details: Implements the `StepTracker` class from `research/state-model-spec.md`. Emits dual-layer SSE events (`sdk` + `step:*`/`turn:*`/`session:*`/`result`/`done`).
   - Priority: Must Have

2. **FR-2**: Frontend state managed by `useReducer` with `agentViewReducer`
   - Details: Replaces current `useState`-based `useAgentStream` hook. Dispatches both structured actions and `RAW_EVENT` actions from incoming SSE events.
   - Priority: Must Have

3. **FR-3**: Split pane UI with raw stream (left) and structured state (right)
   - Details: Uses `react-resizable-panels` for resizable split. Raw stream uses `@radix-ui/react-accordion` for expandable step items. Structured view shows `AutomationSummary`.
   - Priority: Must Have

4. **FR-4**: Auto-scroll with pause-on-scroll-up
   - Details: Both panes auto-scroll to bottom during streaming. If user scrolls up, auto-scroll pauses. "Jump to bottom" button appears when not at bottom.
   - Priority: Must Have

5. **FR-5**: Status indicator system
   - Details: Each step shows an icon: pending (gray circle), running (blue spinner), complete (green check), error (red X). Uses `lucide-react` icons.
   - Priority: Must Have

6. **FR-6**: Multi-turn step collapsing
   - Details: When a follow-up message is sent, steps from previous turns auto-collapse. Latest turn stays expanded. Users can expand old turns manually.
   - Priority: Should Have

7. **FR-7**: Tool input display
   - Details: Tool use steps show tool name immediately. Full parsed input JSON displayed only after `step:complete` (not streamed partial JSON).
   - Priority: Must Have

### Non-Functional Requirements

1. **NFR-1**: Streaming performance
   - Requirement: Handle 30-60 token deltas/sec without frame drops
   - Target: No visible jank during text streaming
   - Measurement: Manual observation during multi-tool agent runs

2. **NFR-2**: Memory bounded
   - Requirement: Raw events log capped to prevent unbounded growth
   - Target: Ring buffer at 10,000 entries
   - Measurement: Memory profiling during long sessions

3. **NFR-3**: Connection resilience
   - Requirement: SSE connection errors surface clearly to user
   - Target: Error state with message and retry option
   - Measurement: Manual test: kill server mid-stream → error shown

### Technical Requirements

- **Stack**: React 19 + Vite 6 (client), Hono + Bun (server), TypeScript
- **Dependencies**: `@radix-ui/react-accordion`, `lucide-react`, `react-resizable-panels`, `use-stick-to-bottom`
- **Architecture**: Dual-layer SSE (raw SDK + derived step events). Backend `StepTracker` class. Frontend `useReducer` pattern.
- **Data Model**: Types from `research/state-model-spec.md` — `Step`, `Turn`, `Conversation`, `AgentViewState`, `StateAction`, `SSEEvent`
- **API Contracts**: Existing `POST /api/agent` endpoint, modified to emit dual-layer SSE events instead of current single-layer forwarding

## Scope

### In Scope

- Diagnosing and fixing the API 500 errors
- Backend `StepTracker` class with dual-layer event emission
- Frontend `agentViewReducer` replacing current `useAgentStream` hook
- Split pane layout (raw stream + structured state)
- Step lifecycle rendering (status indicators, expandable detail)
- `AutomationSummary` derived state display
- Auto-scroll with pause-on-scroll-up
- Multi-turn step collapsing
- Basic monospace code block rendering for all tool I/O

### Out of Scope

- Permission gates / tool approval (bypassPermissions mode; deferred to Step 3+)
- Custom tool renderers (syntax highlighting, diff view, terminal rendering)
- Conversation tree hierarchy view (just summary + step list)
- Multi-agent support (SDKTaskStarted/Progress/Notification)
- XState migration
- Zustand / external state library
- Search and filter within steps
- Timeline/Gantt visualization
- Partial JSON streaming for tool inputs

### Future Considerations

- Permission flow with bidirectional communication (POST endpoint for mid-stream approvals)
- Custom renderers per tool type (Read→syntax highlight, Edit→diff, Bash→terminal)
- Full conversation tree hierarchy in structured view
- Multi-agent task tracking
- XState migration if state complexity grows in Steps 3-5

## Impact Analysis

### Affected Areas

- `server/src/index.ts` — SSE event emission completely reworked (StepTracker replaces ad-hoc forwarding)
- `server/src/sessions.ts` — May need changes if 500 fix requires session/SDK config changes
- `shared/src/types/index.ts` — Replaced with comprehensive type system from state-model-spec
- `client/src/hooks/useAgentStream.ts` — Replaced by new `useAgentView` hook with `useReducer`
- `client/src/components/AgentChat.tsx` — Replaced by `ObservableAutomationView` and sub-components

### Users Affected

- Local developer using the agent UI (sole user for this experimental project)

### System Impact

- **Performance**: Higher SSE bandwidth (dual-layer), mitigated by structured events being small. Frontend reducer handles high-frequency deltas.
- **Security**: No change — same bypassPermissions mode, same local-only scope
- **Data Integrity**: Structured events derived from SDK messages; no separate storage. StepTracker is stateless across sessions.

### Dependencies

- **Upstream**: Claude Agent SDK v0.2.63 — the source of all SDK messages
- **Downstream**: None (local experiment)
- **External**: Anthropic API (the source of 500 errors to diagnose)

### Breaking Changes

- [x] `AgentSSEEvent` type in `shared/` completely replaced — new dual-layer event types
- [x] Frontend `useAgentStream` hook removed — replaced by `useAgentView`
- [x] `AgentChat.tsx` component removed — replaced by `ObservableAutomationView`
- [x] SSE event format changes — old single-event-type format replaced by named events (`sdk`, `step:start`, etc.)

Note: This is an experimental local project with no consumers, so breaking changes are acceptable.

## Solution Design

### Approach

Follow the architecture specified in `research/state-model-spec.md` and `research/research-observable-automation.md`:

1. **Backend**: Create a `StepTracker` class that takes raw SDK messages and produces dual-layer SSE events. Integrate it into the existing `POST /api/agent` endpoint, replacing the current ad-hoc event forwarding. The StepTracker maintains per-turn state (current turn ID, active steps by block index, step counter).

2. **Frontend state**: Replace the 7-`useState` hook (`useAgentStream`) with a single `useReducer` + `useCallback` hook (`useAgentView`). The reducer maintains `AgentViewState` (automation lifecycle, conversation with turns/steps, raw event log, connection state, result, error). An SSE event handler function bridges incoming SSE events to reducer actions.

3. **Frontend UI**: Replace `AgentChat` with `ObservableAutomationView` — a split pane layout using `react-resizable-panels`. Left pane: `RawStreamView` showing an append-only log of raw SDK events with expandable items (Radix Accordion). Right pane: `StructuredStateView` showing `AutomationSummary` + step list with status indicators.

4. **Shared types**: Replace current `AgentSSEEvent` with the full type system from the spec: `SSEEvent`, `Step`, `Turn`, `Conversation`, `AgentViewState`, `StateAction`, `AutomationSummary`.

### Alternatives Considered

1. **Single-layer structured events only (no raw SDK pass-through)**
   - Pros: Less bandwidth, simpler protocol
   - Cons: No raw event debugging capability in frontend
   - Why rejected: User chose dual-layer for full flexibility

2. **Client-side event derivation (raw only + client derives steps)**
   - Pros: Simpler backend
   - Cons: Duplicates state machine logic if multiple frontends added; harder to test
   - Why rejected: Backend-derived steps provide single source of truth

3. **External state library (XState, Zustand)**
   - Pros: More powerful state management for complex flows
   - Cons: Overkill for current step (linear state transitions, no parallel states)
   - Why rejected: `useReducer` sufficient for Step 2. Can migrate to XState if Steps 3-5 need it.

### Data Model Changes

Current `AgentSSEEvent` (46 lines, union of 9 event types with loose typing) replaced by:
- Shared types from `research/state-model-spec.md`: `Step`, `StepBase`, `ThinkingStep`, `TextStep`, `ToolUseStep`, `ToolResultStep`, `Turn`, `UserTurn`, `AssistantTurn`, `Conversation`, `TurnResult`, `UsageInfo`, `AutomationSummary`
- SSE event types: `RawSDKEvent`, `StepStartEvent`, `StepDeltaEvent`, `StepCompleteEvent`, `StepErrorEvent`, `SessionInitEvent`, `TurnStartEvent`, `TurnCompleteEvent`, `ResultEvent`, `ErrorEvent`, `DoneEvent`
- Frontend state: `AgentViewState`, `StateAction`

### API Changes

`POST /api/agent` — same endpoint, same request body (`AgentRequest`), but SSE response format changes:
- **Before**: Named events `system`, `stream_event`, `assistant`, `result`, `tool_progress`, `tool_use_summary`, `tool_result`, `file_created`, `error` with raw SDK payloads
- **After**: Named events `sdk`, `session:init`, `turn:start`, `turn:complete`, `step:start`, `step:delta`, `step:complete`, `step:error`, `result`, `error`, `done` with structured payloads

`GET /api/files/:sessionId/:filename` — unchanged.

### UI/UX Changes

Current: Single-column chat bubble layout with inline tool name indicator.

New: Full-viewport split pane layout:
- **Left pane (RawStreamView)**: Vertical list of raw SDK events. Each event is a collapsible accordion item showing type + timestamp in header, full payload in body. Auto-scrolls to bottom.
- **Right pane (StructuredStateView)**: Automation summary card (phase, turn phase, elapsed time) + vertical step list. Each step shows status icon, type, description, duration. Current turn expanded, previous turns collapsed.
- **Input bar**: Bottom of viewport, same as current (prompt input + Send/Stop button).
- **View toggle**: Tabs or segmented control to switch between raw-only, structured-only, or split view.
- **Result footer**: Cost, tokens, duration — shown after automation completes.

## Implementation Plan

### Phase 1: Fix Base — Diagnose and Resolve 500 Errors
**Complexity**: 3 | **Priority**: High

All subsequent phases depend on a working agent. This phase stabilizes the foundation.

**Web research finding**: 500 errors from the Anthropic API are most commonly: (a) transient infrastructure overload (`request_id: null` pattern), (b) context window exhaustion at ~92% of 200k limit, or (c) SDK subprocess spawn failures. The current error handler in `index.ts` deletes the session on any error — no retry for transient failures.

- [ ] Run `bun run dev` and attempt a simple prompt to reproduce the 500 error
- [ ] Inspect server logs for the exact error: check for `request_id: null` (transient), context window usage data, or subprocess spawn errors
- [ ] Check SDK configuration: model name (`claude-sonnet-4-6`), `ANTHROPIC_API_KEY` env var availability, SDK version compatibility
- [ ] Check for common issues: env var stripping, subprocess spawn failures, API key not set in environment
- [ ] Add retry wrapper with exponential backoff around `session.query.next()` for transient 500s (retry up to 3 times with 1s/2s/4s delays for errors containing "Internal server error" or "overloaded"). Retries ONLY on transport/connection errors — not on SDK-level errors where tool execution already occurred. <!-- Addressed: Codex concern about retry duplicating side effects -->
- [ ] Add error classification: 401/403 → fail-fast with auth error; 429 → retry with Retry-After header; 500 with `request_id: null` → transient retry; 500 with `request_id` → server error, fail-fast; network timeout → retry <!-- Addressed: Codex failure classification gap -->
- [ ] Fix the root cause and verify a simple prompt returns a complete response
- [ ] Verify follow-up messages work (session reuse)

### Phase 2: Backend — StepTracker + Dual-Layer SSE Protocol
**Complexity**: 4 | **Priority**: High

- [ ] Create `shared/src/types/index.ts` — replace current types with full type system from state-model-spec (Step, Turn, Conversation, SSEEvent union, TurnResult, etc.)
- [ ] Create `server/src/step-tracker.ts` — implement `StepTracker` class from spec: `process(sdkMessage) → SSEEvent[]`, `processStreamEvent()`, `processToolResults()`, `blockTypeToStepType()`
- [ ] Refactor `server/src/index.ts` — replace ad-hoc `FORWARDED_TYPES` + event forwarding with StepTracker integration: instantiate per session, pipe SDK messages through `tracker.process()`, emit all returned SSE events
- [ ] Update SSE emission to use named events (`sdk`, `step:start`, `step:delta`, `step:complete`, `turn:start`, `turn:complete`, `session:init`, `result`, `error`, `done`)
- [ ] Define terminal event contract: normal completion emits `result` + `done`; user abort emits `done` only; server error emits `error` + `done`; the `done` event is ALWAYS the last event in every termination path. Backend `finally` block guarantees `done` emission. <!-- Addressed: Codex terminal event contract concern -->
- [ ] Manual test: send a prompt, inspect SSE output with curl (not old UI, since SSE format has changed). Verify dual-layer events for a simple prompt and a tool-use prompt. <!-- Addressed: Codex phase-order validation concern -->

### Phase 3: Frontend — State Management Overhaul
**Complexity**: 5 | **Priority**: High

- [ ] Create `client/src/hooks/useAgentView.ts` — `useReducer(agentViewReducer, initialState)` + SSE fetch logic + `handleSSEEvent()` dispatcher
- [ ] Implement `agentViewReducer` from spec: all 13 action types (SUBMIT_PROMPT, CONNECTION_OPENED/CLOSED, USER_ABORT, SESSION_INIT, TURN_START/COMPLETE, STEP_START/DELTA/COMPLETE/ERROR, RESULT, ERROR, RAW_EVENT)
- [ ] `ERROR` action must sweep all `running` steps to `error` status and set `endTime`. `USER_ABORT` must do the same. This prevents dangling spinner states. <!-- Addressed: Gemini dangling running states concern -->
- [ ] `RAW_EVENT` action must enforce ring buffer: if `rawEvents.length >= 10_000`, drop oldest entries before appending. <!-- Addressed: Consensus ring buffer concern -->
- [ ] Implement helper functions: `updateCurrentAssistantTurn()`, `createStep()`, `appendDelta()`, `stepTypeToPhase()`
- [ ] Implement `deriveAutomationSummary(state): AutomationSummary` selector function with `elapsedMs` computed from `Date.now() - firstStepStartTime`. Use a lightweight `setInterval(1000)` in the hook to force re-derive while streaming (timer starts on `initiating`, stops on `complete`/`error`/`idle`). <!-- Addressed: Codex elapsed timer concern -->
- [ ] SSE parsing: reuse existing ReadableStream + TextDecoder pattern, bridge parsed SSE events to `handleSSEEvent()` which dispatches both structured actions and RAW_EVENT
- [ ] Maintain abort/retry/mount-guard patterns from existing hook. Retry semantics: retry re-sends the same prompt to the same session (if session exists) or creates a new session. Does NOT create duplicate user turns — reuses the existing UserTurn in state. <!-- Addressed: Codex retry button semantics concern -->

### Phase 4: Frontend — Split Pane UI Components
**Complexity**: 5 | **Priority**: High

**Web research findings**:
- `react-resizable-panels`: Panel enforces `overflow: hidden` — must use inner wrapper div with `height: 100%; overflow-y: auto` for scrollable content.
- `@radix-ui/react-accordion`: `--radix-accordion-content-height` CSS variable is NOT updated when children resize (e.g., streaming content grows). Fix: wrap content in a `ResizeObserver` component that updates the CSS variable. Also use `forceMount` on `Accordion.Content` to prevent streaming content from being unmounted when collapsed.
- Auto-scroll: `use-stick-to-bottom` (StackBlitz Labs) is production-ready, powers bolt.new, handles velocity-based spring animations for variable-rate streaming. Zero dependencies.

- [ ] Install dependencies: `@radix-ui/react-accordion`, `lucide-react`, `react-resizable-panels`, `use-stick-to-bottom` <!-- Removed: tailwind-merge + clsx — project uses inline styles, not Tailwind CSS classes. Addressed: Gemini contradictory styling concern -->
- [ ] Create `client/src/components/ObservableAutomationView.tsx` — root layout with `PanelGroup` (horizontal split), input bar, result footer. Inner wrapper divs for scrollable Panel content. Split view only (no view toggle in this plan — deferred). <!-- Addressed: Codex scope creep concern about view toggle -->
- [ ] Create `client/src/components/RawStreamView.tsx` — append-only event log with `use-stick-to-bottom` for auto-scroll + "Jump to bottom" button, event items showing type + timestamp + expandable payload. Truncate payloads > 10KB with "[truncated]" indicator and "Show full" toggle. <!-- Addressed: Consensus tool payload size concern -->
- [ ] Create `client/src/components/StructuredStateView.tsx` — `AutomationSummary` card + step list with status icons (lucide: Loader2, CheckCircle2, XCircle, Circle), step type labels, descriptions, durations. Also uses `use-stick-to-bottom` for auto-scroll. <!-- Addressed: Codex FR-4 both-panes auto-scroll concern -->
- [ ] Create `client/src/components/StepItem.tsx` — accordion item per step with `DynamicAccordionContent` wrapper (ResizeObserver updates `--radix-accordion-content-height`). Collapsed: icon + type + name/description + duration. Expanded: monospace content with 50KB truncation limit + "Show full" toggle. Use `forceMount` on active streaming items. <!-- Addressed: Consensus tool payload size concern -->
- [ ] Implement multi-turn collapsing: previous assistant turns render collapsed, current turn expanded
- [ ] Update `client/src/App.tsx` to render `ObservableAutomationView` instead of `AgentChat`

### Phase 5: Testing & Validation
**Complexity**: 3 | **Priority**: Medium

- [ ] Unit tests for `StepTracker`: verify SDK message → SSE event mapping for each message type (system init, content_block_start/delta/stop for text/thinking/tool_use, assistant complete, user tool_result, result success/error)
- [ ] StepTracker edge case tests: orphan delta (no preceding start), duplicate content_block_start, unknown block types, missing toolCallId in tool_result, out-of-order events. StepTracker must not throw — emit safe fallback events. <!-- Addressed: Codex out-of-order/orphan event concern + tool result correlation concern -->
- [ ] StepTracker terminal path tests: verify `done` is always the final event for each termination mode (success, error, abort)
- [ ] Unit tests for `agentViewReducer`: verify each action type produces correct state transitions
- [ ] Reducer edge case tests: ERROR action sweeps running steps to error status; USER_ABORT does the same; RAW_EVENT respects ring buffer cap (test at 10,001 events) <!-- Addressed: Gemini dangling states + consensus ring buffer -->
- [ ] Unit tests for `deriveAutomationSummary`: verify summary computation from various states
- [ ] E2E test: start dev servers, send a prompt, verify steps appear in UI, verify result displays
- [ ] Manual test: multi-turn conversation, verify step collapsing, verify auto-scroll pause/resume

## Relevant Files

### Existing Files

- `server/src/index.ts` — Main Hono server; SSE streaming endpoint to be refactored (Phase 2)
- `server/src/sessions.ts` — Session management; may need changes for 500 fix (Phase 1)
- `shared/src/types/index.ts` — API contract types; to be completely replaced (Phase 2)
- `client/src/hooks/useAgentStream.ts` — Current streaming hook; to be replaced by `useAgentView` (Phase 3)
- `client/src/components/AgentChat.tsx` — Current chat UI; to be replaced by new components (Phase 4)
- `client/src/App.tsx` — App root; import swap from AgentChat to ObservableAutomationView (Phase 4)
- `research/state-model-spec.md` — Full implementation spec (types, StepTracker, reducer)
- `research/research-observable-automation.md` — Research findings (SDK catalog, UI patterns, architecture)

### New Files

- `server/src/step-tracker.ts` — StepTracker class converting SDK messages to structured SSE events
- `client/src/hooks/useAgentView.ts` — useReducer-based hook replacing useAgentStream
- `client/src/components/ObservableAutomationView.tsx` — Root split pane layout
- `client/src/components/RawStreamView.tsx` — Raw SDK event log pane
- `client/src/components/StructuredStateView.tsx` — Structured state summary pane
- `client/src/components/StepItem.tsx` — Individual step accordion item

### Test Files

- `server/src/step-tracker.test.ts` — StepTracker unit tests
- `client/src/hooks/useAgentView.test.ts` — Reducer + summary selector unit tests
- `e2e/observable-automation.test.ts` — E2E test for the full flow

## Testing Strategy

### Unit Tests

- `StepTracker.process()` — test each SDK message type produces correct SSE events:
  - `system` init → `sdk` + `session:init`
  - `stream_event` content_block_start (text) → `sdk` + `step:start(text)`
  - `stream_event` content_block_delta (text_delta) → `sdk` + `step:delta(text)`
  - `stream_event` content_block_start (tool_use) → `sdk` + `step:start(tool_use, toolName, toolCallId)`
  - `stream_event` content_block_delta (input_json_delta) → `sdk` + `step:delta(input_json)`
  - `stream_event` content_block_stop → `sdk` + `step:complete`
  - `stream_event` message_start → `sdk` + `turn:start`
  - `assistant` complete → `sdk` + `turn:complete`
  - `user` tool results → `sdk` + `step:start(tool_result)` + `step:complete` per result
  - `result` success → `sdk` + `result` + `done`
  - `result` error → `sdk` + `result` + `done` (with error subtype)
- `agentViewReducer` — test each action type:
  - SUBMIT_PROMPT → automation: initiating, user turn added
  - SESSION_INIT → automation: streaming, session data set
  - TURN_START → new assistant turn added
  - STEP_START → new step in current turn, phase updated
  - STEP_DELTA → content appended to correct step
  - STEP_COMPLETE → step status: complete, endTime set
  - RESULT → automation: complete (success) or error
  - ERROR → automation: error, error info set
  - RAW_EVENT → rawEvents appended
- `deriveAutomationSummary` — correct computation from various state snapshots

### Integration Tests

- SSE round-trip: POST to `/api/agent` with mock SDK → verify structured events in SSE output

### E2E Tests

- Send a simple prompt → verify UI shows steps appearing in real-time
- Send a prompt that triggers tool use → verify tool_use and tool_result steps appear
- Multi-turn: send follow-up → verify previous turn collapses, new turn appears
- Abort mid-stream → verify UI shows idle state

### Manual Test Cases

1. **Test Case**: Full automation flow
   - Steps: Start dev, send "Read the README.md file and summarize it"
   - Expected: See text step, tool_use step (Read), tool_result step, final text step, result footer with cost/tokens

2. **Test Case**: Scroll behavior
   - Steps: Send a prompt that generates many steps, scroll up during streaming
   - Expected: Auto-scroll pauses, "Jump to bottom" button appears, clicking it resumes auto-scroll

3. **Test Case**: Split pane interaction
   - Steps: During streaming, resize the split pane divider
   - Expected: Both panes resize smoothly, content reflows

## Risk Assessment

### Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| 500 error has no simple fix (SDK bug, API-side issue) | Medium | High | Check SDK version compatibility, try different model, check API status page, file SDK issue if needed |
| High-frequency step:delta events cause UI jank | Medium | Medium | requestAnimationFrame batching, React.memo on non-streaming components, measure and optimize |
| StepTracker state gets out of sync with SDK message ordering | Low | High | Comprehensive unit tests for all message sequences; defensive null checks |
| react-resizable-panels + streaming content causes layout thrashing | Low | Medium | Inner wrapper divs with overflow:auto (Panel enforces overflow:hidden). Test with high-frequency updates. |
| Radix Accordion clips streaming content (fixed height CSS var) | High | Medium | ResizeObserver wrapper updates `--radix-accordion-content-height`. `forceMount` prevents content unmount during streaming. |

### Business Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| None — experimental local project | N/A | N/A | N/A |

### Mitigation Strategy

- Phase 1 (fix base) blocks all other phases — if unfixable, the rest is moot
- Each phase is independently testable — partial progress is valuable
- The research spec provides full implementation code — reduces ambiguity

## Rollback Strategy

### Rollback Steps

1. `git checkout main` — all changes are on a feature branch
2. `bun install` — restore original dependencies

### Rollback Conditions

- Phase 1 fails to resolve 500 errors after investigation
- StepTracker introduces regressions in basic chat functionality

## Validation Commands

```bash
# Install dependencies
bun install

# Run unit tests
bun test

# Type check
bunx tsc --noEmit

# Start dev servers
bun run dev

# Manual validation: open http://localhost:5173
# Send "What is 2 + 2?" → verify steps appear in both panes
# Send "Read the file server/src/index.ts" → verify tool_use + tool_result steps
```

## Acceptance Criteria

- [ ] API 500 errors resolved — basic chat works end-to-end
- [ ] StepTracker emits dual-layer events (raw `sdk` + structured `step:*`/`turn:*`)
- [ ] Frontend `useReducer` manages full `AgentViewState` with all 13 action types
- [ ] Split pane renders raw stream (left) and structured state summary (right)
- [ ] Steps show real-time status indicators (spinning → check/X)
- [ ] Tool use steps display tool name immediately, full input on completion
- [ ] Auto-scroll pins to bottom; pauses on scroll-up with "Jump to bottom" button
- [ ] Previous turns collapse on follow-up message
- [ ] Result footer shows cost, tokens, duration after completion
- [ ] StepTracker unit tests pass
- [ ] Reducer unit tests pass
- [ ] E2E test passes

## Dependencies

### New Dependencies

- `@radix-ui/react-accordion` — Expandable step cards in raw stream view
- `lucide-react` — Status icons (Loader2, CheckCircle2, XCircle, Circle)
- `react-resizable-panels` — Split pane layout
- `use-stick-to-bottom` — Auto-scroll with pause-on-scroll-up (StackBlitz Labs, powers bolt.new)

### Dependency Updates

- None

## Notes & Context

### Additional Context

- The full implementation code for StepTracker, reducer, types, and helpers exists in `research/state-model-spec.md`. Implementers should use this as the primary reference.
- The existing `useAgentStream` hook (319 lines) contains battle-tested patterns for SSE parsing, mount guards, abort handling, and retry logic. These patterns should be preserved in the new `useAgentView` hook.
- Current UI uses inline styles. The new components should also use inline styles for consistency (no Tailwind CSS classes). No `tailwind-merge` or `clsx` needed.

### Assumptions

- The 500 error is fixable (configuration issue, not an SDK/API bug)
- Claude Agent SDK v0.2.63 emits the message types documented in the research
- The `includePartialMessages: true` option provides `stream_event` messages with content_block_start/delta/stop inner events
- Tool results arrive as `user` type messages with `tool_result` content blocks

### Constraints

- TypeScript-first, Bun runtime, no Python
- No external state management libraries (useReducer only)
- No auth needed (local dev only)
- bypassPermissions mode (no permission gates)

### Related Tasks/Issues

- `plans/agent-frontend-step1.md` — Original Step 1 plan (basic agent chat)
- `plans/agent-frontend-step1.5.md` — Step 1.5 plan (tool use + file download)

### References

- `research/state-model-spec.md` — Full TypeScript implementation spec
- `research/research-observable-automation.md` — Research findings
- `research/research-observable-automation-ui.md` — UI pattern research
- Claude Agent SDK docs: https://platform.claude.com/docs/en/agent-sdk/typescript
- Radix Accordion: https://www.radix-ui.com/primitives/docs/components/accordion
- react-resizable-panels: https://github.com/bvaughn/react-resizable-panels

### Open Questions

- [x] Dual-layer vs single-layer? → **Dual-layer** (interview decision)
- [x] MVP view mode? → **Split pane** (interview decision)
- [x] Tool input streaming? → **Wait for complete** (interview decision)
- [x] Multi-turn UX? → **Collapse previous turns** (interview decision)
- [x] Auto-scroll? → **Pin-to-bottom + pause on scroll-up** (interview decision)
- [x] Permission gates? → **Defer** (interview decision)
- [x] Custom renderers? → **Basic only** (interview decision)
- [x] Structured view depth? → **Summary + step list** (interview decision)
- [x] Fix strategy? → **Diagnose & fix** (interview decision)

## Blindspot Review

**Reviewers**: GPT-5.3-Codex (xhigh), Gemini 3 Pro
**Date**: 2026-03-03
**Plan Readiness**: Ready (after addressing below)

### Addressed Concerns

- [Consensus] Ring buffer for rawEvents missing from Phase 3 implementation → Added explicit task in Phase 3 reducer + test in Phase 5
- [Consensus] Tool payload/DOM unbounded growth → Added truncation limits (10KB raw view, 50KB step detail) with "Show full" toggle in Phase 4
- [Codex, Critical] Terminal event contract undefined → Added terminal event spec in Phase 2 (done is always last event; defined per termination mode)
- [Codex, Critical] Retry can duplicate side effects → Restricted retries to transport/connection errors only; documented in Phase 1
- [Codex, High] Failure classification gap (401/403/429/timeout) → Added error classification matrix in Phase 1
- [Codex, High] Retry button semantics ambiguous → Clarified in Phase 3 (re-sends prompt to same session, no duplicate user turns)
- [Codex, High] Out-of-order/orphan event tests missing → Added edge case tests in Phase 5
- [Codex, Medium] FR-4 auto-scroll only specified for raw pane → Both panes now use use-stick-to-bottom
- [Codex, Medium] Real-time elapsed timer missing → Added setInterval(1000) tick mechanism in Phase 3
- [Codex, Medium] Phase-order validation ambiguity → Phase 2 manual test now uses curl, not old UI
- [Codex, Medium] View toggle scope creep → Removed from Phase 4; split-only for this plan
- [Gemini, Medium] Dangling running states on stream error → ERROR and USER_ABORT actions now sweep running steps to error
- [Gemini, Medium] Contradictory styling dependencies → Removed tailwind-merge + clsx; inline styles only

### Acknowledged but Deferred

- [Gemini, Critical] SSE reconnection/state hydration strategy → Out of scope for local dev tool. SSE over localhost rarely drops. If needed later, can add EventSource with lastEventId + server-side replay.
- [Codex, High] Integration test needs injectable SDK seam → StepTracker tests use programmatic SDK-like message construction; no mock provider needed for this scope.
- [Codex, Medium] Tool result correlation edge cases (missing toolCallId) → Added defensive test. Full correlation tracking deferred to multi-agent support.

### Dismissed

- [Gemini, Critical] Invalid model ID `claude-sonnet-4-6` → **Incorrect finding.** `claude-sonnet-4-6` is a valid current model ID per Anthropic's latest naming (Claude 4.6 family). Gemini's training data predates this model release.
- [Codex, Medium] Ring buffer lacks implementation step → Duplicate of consensus finding above (already addressed).
