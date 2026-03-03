---
title: "Automatic Evaluation of Agent Task Completion"
type: Feature
issue: null
research: ["research/research-evaluation-job-completion.md"]
status: Draft
reviewed: false
reviewers: []
created: 2026-03-03
---

# PRD: Automatic Evaluation of Agent Task Completion

## Metadata
- **Type**: Feature
- **Priority**: High
- **Severity**: N/A
- **Estimated Complexity**: 6
- **Created**: 2026-03-03
- **Status**: Draft

## Overview

### Problem Statement

When the Claude Agent SDK completes a task it emits a `result` message with a `subtype`, final output text, cost, duration, and turn count. The current codebase surfaces these efficiency metrics in the UI footer, but there is **no judgment about whether the task was actually completed successfully**. A `subtype: "success"` only means the agent stopped without hitting a limit — it does not mean the task goal was accomplished.

Users have no automated signal indicating whether the agent delivered what was asked.

### Goals & Objectives

1. After each SDK `result` message, run an LLM-as-judge (claude-haiku) that evaluates whether the agent completed the user's original task.
2. Persist the evaluation result in session state so it survives the stream close.
3. Emit an `evaluation` SSE event before `result` + `done` so the frontend receives it during the live stream.
4. Render a pass/fail badge with confidence and reasoning in the result footer — alongside the existing cost/tokens metrics.
5. Degrade gracefully: if haiku fails, emit `evaluation` SSE with `status: "error"` and show "Evaluation unavailable" in the UI.

### Success Metrics

- **Primary Metric**: `evaluation` SSE event arrives at the frontend for 100% of completed sessions (success or error subtypes).
- **Secondary Metrics**: Average haiku call latency < 5s; "Evaluating…" spinner visible during evaluation; pass/fail badge rendered after evaluation SSE.
- **Quality Gates**: No change to `result` + `done` SSE ordering; existing E2E tests still pass; TypeScript type-checks clean.

## User Stories

### Story 1: Completed Task Evaluation
- **As a**: local developer using the duvo-test agent UI
- **I want**: to see whether the agent successfully completed my task
- **So that**: I can decide whether to send a follow-up or start a new session
- **Acceptance Criteria**:
  - [ ] After the agent stream finishes, a pass/fail badge appears in the result footer
  - [ ] The badge shows confidence (0–100%) and a one-sentence reasoning from haiku
  - [ ] The badge says "Pass" (green) for `passed: true` and "Fail" (red) for `passed: false`

### Story 2: Evaluation During Stream
- **As a**: local developer watching the streaming UI
- **I want**: to see an "Evaluating…" spinner while haiku runs
- **So that**: I understand why the stream hasn't closed yet after the agent finished
- **Acceptance Criteria**:
  - [ ] When the `result` SSE arrives, the footer shows "Evaluating…" spinner
  - [ ] When the `evaluation` SSE arrives, the spinner is replaced by the badge
  - [ ] Stream closes normally with `done` after evaluation

### Story 3: Graceful Failure
- **As a**: local developer
- **I want**: the app to stay functional even if haiku is unreachable
- **So that**: evaluation errors never break the main chat flow
- **Acceptance Criteria**:
  - [ ] If haiku call fails, `evaluation` SSE is still emitted with `status: "error"`
  - [ ] UI shows "Evaluation unavailable" instead of a badge
  - [ ] `result` and `done` SSE events still fire normally

## Requirements

### Functional Requirements

1. **FR-1**: Evaluation runs for every SDK `result` message (both `success` and error subtypes)
   - Details: Call `claude-haiku-4-5-20251001` synchronously at Hook A (`index.ts:172`, before `tracker.process()`)
   - Priority: Must Have

2. **FR-2**: Evaluation uses all four judge inputs
   - Details: Pass `session.originalPrompt`, `sdkMessage.result`, file list from `sessionDir`, and `numTurns + totalCostUsd` to haiku
   - Priority: Must Have

3. **FR-3**: `evaluation` SSE event emitted before `result` and `done`
   - Details: SSE sequence must be `evaluation → result → done`
   - Priority: Must Have

4. **FR-4**: Evaluation result persisted to `session.lastEvaluation`
   - Details: Written before emitting the SSE so state is consistent if SSE fails
   - Priority: Must Have

5. **FR-5**: `originalPrompt` stored on Session at creation time
   - Details: `createSession()` accepts `prompt: string`; stored as `session.originalPrompt`
   - Priority: Must Have

6. **FR-6**: Frontend shows "Evaluating…" spinner on `result` SSE arrival
   - Details: `agentViewReducer` sets `evaluation: "pending"` on `RESULT` action
   - Priority: Must Have

7. **FR-7**: Frontend renders pass/fail badge on `evaluation` SSE arrival
   - Details: `ObservableAutomationView` reads `state.lastEvaluation` and renders badge
   - Priority: Must Have

8. **FR-8**: Haiku failure emits `evaluation` SSE with `status: "error"`
   - Details: `evaluate()` catches all errors and returns `{ status: "error", passed: false, confidence: 0, reasoning: "Evaluation failed", evaluatedBy: "llm" }`
   - Priority: Must Have

### Non-Functional Requirements

1. **NFR-1**: Latency
   - Requirement: Haiku evaluation call completes within 8 seconds
   - Target: p95 < 5s
   - Measurement: Log `durationMs` from haiku `result` message

2. **NFR-2**: Cost
   - Requirement: Haiku evaluation adds < $0.001 per session turn
   - Target: ~$0.0001 per eval (haiku pricing)
   - Measurement: Log `totalCostUsd` from haiku `result` message

3. **NFR-3**: No regression
   - Requirement: Existing `result` + `done` SSE ordering and session TTL behavior unchanged
   - Target: 0 failing E2E tests
   - Measurement: `bun test`

### Technical Requirements

- **Stack**: Bun + Hono (server), React 19 + Vite (client), Claude Agent SDK v0.2.63
- **Dependencies**: No new packages — uses existing `@anthropic-ai/claude-code` SDK `query()` for haiku call
- **Architecture**: Hook A pattern — synchronous evaluation at `index.ts:172` before `tracker.process()`
- **Data Model**: `EvaluationResult` (new), `EvaluationEvent` (new SSE type), `Session.originalPrompt` (new field), `Session.lastEvaluation` (new field), `AgentViewState.lastEvaluation` (new field), `AgentViewState.evaluationStatus` (new field)
- **API Contracts**: New `EvaluationEvent` added to `SSEEvent` discriminated union; `EVALUATION` + `RESULT` actions updated in `StateAction`

## Scope

### In Scope
- `evaluator.ts` — new server module with `evaluate()` function
- `EvaluationResult` type in shared types
- `EvaluationEvent` in `SSEEvent` union
- `session.originalPrompt` field — stored at `createSession()`
- `session.lastEvaluation` field — updated on each `result` message
- "Evaluating…" spinner state in frontend reducer
- Pass/fail badge in `ObservableAutomationView` result footer
- Graceful error path (`status: "error"`)

### Out of Scope
- Historical evaluation across sessions (no DB persistence beyond session TTL)
- Configurable evaluation rubrics per prompt
- Heuristic pre-check gate (always call haiku)
- Separate `GET /api/sessions/:id/evaluation` endpoint
- LLM-judge response streaming
- Evaluation of tool calls mid-turn (only final `result` message)

### Future Considerations
- `evalHistory: EvalRecord[]` for multi-turn evaluation accumulation
- Configurable rubric per session (e.g., "did it produce a file?")
- LLM judge model selection (claude-sonnet for high-stakes tasks)
- Evaluation analytics dashboard

## Impact Analysis

### Affected Areas
- `server/src/index.ts` — evaluation call inserted at line 172
- `server/src/sessions.ts` — `Session` type extended with two fields
- `server/src/evaluator.ts` — new file
- `shared/src/types/index.ts` — type additions
- `client/src/hooks/useAgentView.ts` — new SSE handler + reducer action
- `client/src/components/ObservableAutomationView.tsx` — new badge UI

### Users Affected
- Local developer using the chat UI: sees "Evaluating…" spinner + pass/fail badge on every completed task

### System Impact
- **Performance**: +2–5s per session end (haiku call); no impact on in-progress turns
- **Security**: Haiku API key already in env; no new secret surface area
- **Data Integrity**: `session.lastEvaluation` reset on each `result` message; no stale state across turns

### Dependencies
- **Upstream**: SDK `result` message must include `result` text (may be `undefined` on error subtypes — evaluator handles gracefully)
- **Downstream**: Frontend `useAgentView` hook and `ObservableAutomationView` depend on new SSE event
- **External**: `claude-haiku-4-5-20251001` model availability; uses same `ANTHROPIC_API_KEY`

### Breaking Changes
- [ ] None — `EvaluationEvent` added to union (additive); `Session` fields are optional-compatible with existing code
- [ ] `createSession()` signature changes to accept `prompt: string` — all call sites in `index.ts` must be updated

## Solution Design

### Approach

Insert an evaluation step at **Hook A** (`index.ts:172`), immediately before `tracker.process(sdkMessage)`. This is the only position where:
- The SSE stream is still open
- `sdkMessage.result` (agent output) is available
- `session.sessionDir` is accessible for file inspection
- The `evaluation` SSE can arrive before `result` + `done`

The `evaluate()` function calls `claude-haiku-4-5-20251001` using the existing SDK `query()` pattern with a structured rubric prompt. It receives all four judge inputs: original prompt, agent result text, file list, and efficiency metrics. It returns `EvaluationResult` synchronously (awaited). On any error it returns `{ status: "error" }` without throwing.

The session stores `originalPrompt` at creation time via an updated `createSession(prompt: string)` signature.

### Alternatives Considered

1. **Heuristic only (no LLM)**
   - Pros: Zero latency, zero cost, deterministic
   - Cons: `subtype: "success"` doesn't mean task completed; misses hollow completions
   - Why rejected: User wants genuine task completion evaluation, not just error detection

2. **Structured output self-eval (outputFormat)**
   - Pros: Zero extra latency, zero extra cost
   - Cons: Model scoring its own work has inherent bias; requires changing the main `sdkQuery()` call
   - Why rejected: Bias concern; user chose unbiased judge

3. **Hook C — store only, no SSE**
   - Pros: No ordering constraint
   - Cons: Requires separate API endpoint; evaluation not visible during stream
   - Why rejected: User wants inline SSE delivery before `done`

4. **Hook B — modify StepTracker to separate `done` from `result`**
   - Pros: Clean separation
   - Cons: Breaks StepTracker API contract; more invasive
   - Why rejected: Hook A achieves same ordering with less surface area change

### Data Model Changes

**New type in `shared/src/types/index.ts`**:
```typescript
export interface EvaluationResult {
  passed: boolean;
  confidence: number;       // 0–1
  reasoning: string;
  evaluatedBy: "heuristic" | "llm";
  status: "ok" | "error";
}

export interface EvaluationEvent {
  event: "evaluation";
  data: EvaluationResult;
}
```

**Updated `SSEEvent` union** — add `EvaluationEvent`

**Updated `AgentViewState`**:
```typescript
lastEvaluation: EvaluationResult | null;
evaluationStatus: "idle" | "pending" | "complete" | "error";
```

**Updated `StateAction`**:
```typescript
| { type: "EVALUATION"; evaluation: EvaluationResult }
// RESULT action triggers evaluationStatus: "pending"
```

**Updated `Session` type**:
```typescript
originalPrompt: string;
lastEvaluation?: EvaluationResult;
```

### API Changes

No new HTTP endpoints. New `EvaluationEvent` added to the SSE wire format.

SSE sequence per completed session:
```
evaluation → result → done
```

### UI/UX Changes

**`ObservableAutomationView` result footer (existing)**:
- When `evaluationStatus === "pending"`: show "Evaluating…" spinner chip alongside cost/tokens
- When `evaluationStatus === "complete"` and `lastEvaluation.status === "ok"`:
  - `passed: true` → green badge "Pass · {confidence}% · {reasoning}"
  - `passed: false` → red badge "Fail · {confidence}% · {reasoning}"
- When `evaluationStatus === "error"`: show grey badge "Evaluation unavailable"

## Implementation Plan

### Phase 1: Shared Types
**Complexity**: 2 | **Priority**: High

- [ ] Add `EvaluationResult` interface to `shared/src/types/index.ts`
- [ ] Add `EvaluationEvent` interface to `shared/src/types/index.ts`
- [ ] Add `EvaluationEvent` to `SSEEvent` discriminated union
- [ ] Add `lastEvaluation: EvaluationResult | null` and `evaluationStatus` to `AgentViewState`
- [ ] Add `{ type: "EVALUATION"; evaluation: EvaluationResult }` to `StateAction` union
- [ ] Update `RESULT` action comment to note it triggers `evaluationStatus: "pending"`

### Phase 2: Session + Server Core
**Complexity**: 4 | **Priority**: High

- [ ] Add `originalPrompt: string` and `lastEvaluation?: EvaluationResult` to `Session` type in `sessions.ts`
- [ ] Update `createSession(id, sdkSessionId, query, queue, sessionDir, prompt)` to accept and store `originalPrompt`
- [ ] Update `createSession()` call site in `index.ts` to pass the user prompt
- [ ] Create `server/src/evaluator.ts` with `evaluate(sdkMessage, session): Promise<EvaluationResult>`
  - Builds haiku judge prompt from all four inputs
  - Calls `query()` with `claude-haiku-4-5-20251001`
  - Parses haiku response into `EvaluationResult`
  - Catches all errors, returns `{ status: "error", passed: false, confidence: 0, reasoning: "Evaluation failed", evaluatedBy: "llm" }`

### Phase 3: Server Integration (Hook A)
**Complexity**: 3 | **Priority**: High

- [ ] In `server/src/index.ts` at line 172, before `tracker.process(sdkMessage)`:
  - Check `sdkMessage.type === "result"`
  - Await `evaluate(sdkMessage, session)`
  - Set `session.lastEvaluation = evalResult`
  - Call `await emitSSEEvent(stream, { event: "evaluation", data: evalResult })`
- [ ] Verify SSE sequence in logs: `evaluation → result → done`

### Phase 4: Frontend
**Complexity**: 4 | **Priority**: High

- [ ] In `client/src/hooks/useAgentView.ts`:
  - Handle `evaluation` SSE event in `handleSSEEvent()` → dispatch `{ type: "EVALUATION", evaluation: data }`
  - Update `agentViewReducer`:
    - `RESULT` action: set `evaluationStatus: "pending"`
    - `EVALUATION` action: set `lastEvaluation`, set `evaluationStatus: "complete"` (or `"error"` if `status === "error"`)
  - Initialize `AgentViewState` with `lastEvaluation: null, evaluationStatus: "idle"`
- [ ] In `client/src/components/ObservableAutomationView.tsx`:
  - Read `state.evaluationStatus` and `state.lastEvaluation`
  - Render "Evaluating…" spinner when `evaluationStatus === "pending"`
  - Render pass/fail badge with confidence + reasoning when `evaluationStatus === "complete"`
  - Render "Evaluation unavailable" when `evaluationStatus === "error"`

### Phase 5: Testing & Validation
**Complexity**: 3 | **Priority**: High

- [ ] Unit test `evaluator.ts`: mock `query()`, verify prompt construction and response parsing
- [ ] Unit test reducer: `RESULT` sets pending, `EVALUATION` resolves to complete/error
- [ ] E2E test: start session, send prompt, verify `evaluation` SSE event arrives before `done`, verify badge renders
- [ ] Manual test: kill haiku mid-call (mock failure) → confirm "Evaluation unavailable" renders

## Relevant Files

### Existing Files
- `server/src/index.ts` — Hook A insertion point at line 172; `createSession()` call site
- `server/src/sessions.ts` — `Session` type; `createSession()` function
- `server/src/step-tracker.ts` — `process()` returns `[result, done]` events; ordering reference
- `shared/src/types/index.ts` — `TurnResult`, `SSEEvent`, `AgentViewState`, `StateAction`
- `client/src/hooks/useAgentView.ts` — SSE parser, reducer, `handleSSEEvent()`
- `client/src/components/ObservableAutomationView.tsx` — result footer rendering

### New Files
- `server/src/evaluator.ts` — `evaluate(sdkMessage, session): Promise<EvaluationResult>` — all haiku judge logic isolated here

### Test Files
- `server/src/evaluator.test.ts` — unit tests for evaluator (mock `query()`)
- `client/src/hooks/useAgentView.test.ts` — reducer unit tests for EVALUATION/RESULT actions
- `e2e/evaluation.test.ts` — end-to-end: verify `evaluation` SSE precedes `done`, badge renders

## Testing Strategy

### Unit Tests
- `evaluator.ts`: mock `query()` to return success/failure/error; assert `EvaluationResult` shape, `evaluatedBy: "llm"`, graceful error path
- `agentViewReducer`: `RESULT` action → `evaluationStatus: "pending"`; `EVALUATION` with `status: "ok"` → `"complete"`; `EVALUATION` with `status: "error"` → `"error"`

### Integration Tests
- Server route handler: send mock `result` SDK message through the full pipeline; assert `evaluation` SSE arrives before `result` SSE in the emitted event sequence

### E2E Tests
- Start dev server, send a task prompt, collect all SSE events in order, assert:
  1. `evaluation` event arrives before `result` event
  2. `result` arrives before `done`
  3. Frontend renders pass/fail badge (or "Evaluation unavailable")

### Manual Test Cases
1. **Happy path**:
   - Steps: Start session, send "List files in /tmp", wait for completion
   - Expected: "Evaluating…" spinner, then green/red badge with reasoning in footer

2. **Haiku failure simulation**:
   - Steps: Set `ANTHROPIC_API_KEY` to invalid value temporarily, run session
   - Expected: "Evaluation unavailable" badge in footer, `done` still fires

3. **Error subtype**:
   - Steps: Send a prompt that triggers `error_max_turns` (set `maxTurns: 1`)
   - Expected: haiku still called, badge reflects pass/fail based on haiku judgment

## Risk Assessment

### Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Haiku timeout blocks `done` for > 8s | Medium | Medium | Wrap `evaluate()` in `Promise.race` with 8s timeout; on timeout return `status: "error"` |
| `session.originalPrompt` is wrong message (system prompt vs user turn) | Low | Medium | Store prompt from the first user message object, not from session:init event |
| `sdkMessage.result` is `undefined` on error subtypes | Medium | Low | Evaluator handles `undefined` gracefully — passes empty string to judge |
| Haiku self-reports task as "pass" even when result is clearly wrong | Medium | Low | Accepted per user choice (no heuristic gate); future improvement |
| `is_error: true` with `subtype: "success"` (AJV bug) | Low | Low | Don't gate on `is_error`; pass to haiku regardless |

### Business Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Haiku cost accumulation on high-volume testing | Low | Low | ~$0.0001/eval; only local dev environment |

### Mitigation Strategy

Wrap `evaluate()` with a hard timeout (8s). All errors return `status: "error"` without throwing. The `finally` block in `index.ts` ensures `session.streaming = false` and the fallback `[DONE]` regardless of evaluation outcome.

## Rollback Strategy

### Rollback Steps

1. Revert `server/src/index.ts` — remove evaluation call at Hook A
2. Revert `server/src/sessions.ts` — remove `originalPrompt` + `lastEvaluation` fields
3. Remove `server/src/evaluator.ts`
4. Revert `shared/src/types/index.ts` — remove `EvaluationResult`, `EvaluationEvent`, `evaluationStatus`
5. Revert `client/src/hooks/useAgentView.ts` — remove `EVALUATION` action handler
6. Revert `client/src/components/ObservableAutomationView.tsx` — remove badge UI

### Rollback Conditions
- Haiku calls causing > 10s average session end latency
- Evaluation SSE emitted after `done` (ordering regression)

## Validation Commands

```bash
# Type-check all packages
bun run typecheck

# Run all tests
bun run test

# Run linter (Biome runs automatically via hook, but can run manually)
bun run lint

# Build the project
bun run build

# Start dev server and exercise evaluation manually
bun run dev
# Then in browser: send a prompt, confirm "Evaluating..." spinner + badge appear

# Verify SSE event ordering (manual curl test)
curl -N http://localhost:3001/api/sessions/<id>/stream \
  | grep -E '"event":"(evaluation|result|done)"'
# Expected output order: evaluation → result → done
```

## Acceptance Criteria

- [ ] `evaluation` SSE event arrives before `result` and `done` on every completed session
- [ ] `session.lastEvaluation` populated after each `result` message
- [ ] `session.originalPrompt` stored at session creation
- [ ] "Evaluating…" spinner visible in result footer while haiku runs
- [ ] Pass/fail badge with confidence + reasoning rendered after `evaluation` SSE
- [ ] "Evaluation unavailable" shown on haiku failure — stream still closes normally
- [ ] TypeScript compilation clean (`bun run typecheck`)
- [ ] All existing E2E tests still pass
- [ ] `evaluate()` unit tests pass with mocked `query()`
- [ ] Reducer unit tests cover `RESULT → pending` and `EVALUATION → complete/error` transitions

## Dependencies

### New Dependencies
- None — uses existing `@anthropic-ai/claude-code` SDK and `claude-haiku-4-5-20251001` model

### Dependency Updates
- None

## Notes & Context

### Additional Context
- Research doc: `research/research-evaluation-job-completion.md` — full pipeline trace, hook analysis, SDK field inventory
- The `is_error` field on SDK result has a known AJV bug (can be `true` alongside `subtype: "success"`). Do not use as evaluation gate.
- `permission_denials` field is available on the raw SDK message but not captured by `TurnResult` today. The evaluator accesses the raw `sdkMessage` directly at Hook A, so it can read `permission_denials` and pass count to haiku as an efficiency signal.
- `stop_reason` and `duration_api_ms` are also available on raw message — useful inputs for haiku context.

### Assumptions
- `ANTHROPIC_API_KEY` in env has access to `claude-haiku-4-5-20251001`
- Session `originalPrompt` = the first user-typed message (the initial task description), not system-level messages
- `session.sessionDir` may be empty for conversational tasks — haiku should treat empty file list as valid

### Constraints
- Must not change `result` + `done` SSE ordering
- Must not block the `finally` block — evaluation timeout must be < session idle timeout (30 min)
- TypeScript-first; no Python; no new npm packages

### Related Tasks/Issues
- Follows Step 4 (MCP filesystem data connection) on branch `feat/step-4`
- Prerequisite for Step 5 (production deployment) — evaluation data is useful for observability

### References
- [Claude Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Track cost and usage](https://platform.claude.com/docs/en/agent-sdk/cost-tracking)
- [Demystifying evals for AI agents — Anthropic Engineering](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- `research/research-evaluation-job-completion.md` — canonical source for this plan

### Open Questions
- [ ] Should `evaluator.ts` use `query()` (with subprocess) or direct Anthropic SDK client for haiku? Using `query()` adds subprocess overhead for a simple one-shot call. Direct SDK client (`new Anthropic().messages.create()`) is simpler and faster for this use case — requires installing `@anthropic-ai/sdk` or using the already-bundled client in the agent SDK.

## Blindspot Review

**Reviewers**: N/A (pre-implementation draft)
**Date**: 2026-03-03
**Plan Readiness**: Ready for Implementation

### Addressed Concerns
- [Research] SSE ordering constraint (evaluation must precede `done`) → Hook A placement confirmed
- [Interview] Haiku latency UX → "Evaluating…" spinner on `RESULT` action
- [Interview] `originalPrompt` not on Session → added to `createSession()` signature

### Acknowledged but Deferred
- [Research, Low] `evalHistory: EvalRecord[]` for multi-turn accumulation → deferred, reset-per-turn sufficient for MVP
- [Research, Low] Configurable rubric per session → deferred, no session-level task metadata today
- [Research, Medium] `is_error` AJV bug handling → noted in assumptions; no special code needed (haiku handles it)

### Dismissed
- [Research, Low] Hook B (StepTracker refactor) → dismissed; Hook A achieves same ordering with less invasiveness
- [Research, Low] Hook C (REST-only) → dismissed; user wants live SSE delivery
