---
date: 2026-03-03
git_commit: 7ab2b169837ed6d049c0498632519d2f5323d5ee
branch: feat/step-4
repository: github.com/iamladi/duvo-test
topic: Automatic evaluation of agent task completion
tags: [evaluation, sessions, sse, result-message, sdk]
status: complete
last_updated: 2026-03-03
last_updated_by: research-eval-job-20260303-001
---

# Research: Automatic Evaluation of Agent Task Completion

## Research Question

How would you implement an automatic evaluation feature in the current codebase? When the agent completes its task, evaluate whether it was successful or not. The artifact for evaluation is the SDK `result` message. Results must be stored in session state AND emitted as an SSE event to the frontend.

### Interview Decisions
- **Artifact**: SDK `result` message — `subtype`, `result` text, `totalCostUsd`, `durationMs`, `numTurns`, `usage`
- **Output**: Session state + SSE event visible on the frontend
- **Depth**: Full pipeline trace — every hook point identified

---

## Summary

The codebase already routes the SDK `result` message through a well-defined pipeline:
`SDK generator → nextWithRetry → tracker.process() → emitSSEEvent() → SSE wire → useAgentView SSE parser → agentViewReducer`.

There is **no existing evaluation infrastructure** — zero hits for `evaluation|eval` across all TypeScript files.

**Critical finding**: `StepTracker.process()` emits both the `result` event and the `done` event **in the same batch** (step-tracker.ts:71–98). Both are flushed to the client before the `if (sdkMessage.type === "result")` check at index.ts:190. This means evaluation SSE events **cannot** be inserted after line 190 — they would arrive after `done`.

**Recommended hook point**: Before `tracker.process(sdkMessage)` at index.ts:172–173. Evaluation runs, emits an `evaluation` SSE event, then StepTracker emits `result` + `done` in its normal sequence.

**Team**: Locator (file inventory) + Analyzer (pipeline trace) + Pattern Finder (data shapes). Web search ran in parallel.

---

## Detailed Findings

### 1. SDK `result` Message — Raw Fields

Source: `server/src/step-tracker.ts:71–98`

The raw SDK message has these fields:
```
{
  type: "result",
  subtype: "success" | "error_max_turns" | "error_during_execution" | "error_max_budget_usd",
  result: string | undefined,          // agent's final text output
  total_cost_usd: number,
  duration_ms: number,
  num_turns: number,
  usage: {
    input_tokens: number,
    output_tokens: number,
    cache_creation_input_tokens: number,
    cache_read_input_tokens: number,
  }
}
```

These are camelCase-mapped into `TurnResult` (shared/src/types/index.ts:119–130):
```typescript
export interface TurnResult {
  subtype: "success" | "error_max_turns" | "error_during_execution" | "error_max_budget_usd";
  result?: string;
  totalCostUsd: number;
  durationMs: number;
  numTurns: number;
  usage: UsageInfo;
}
```

### 2. Full Pipeline Trace [Consensus]

**Step 1 — Generator iteration** (`server/src/index.ts:131–138`)
```typescript
while (true) {
  if (aborted) break;
  const { value: msg, done } = await nextWithRetry(session.query);  // line 134
  if (done) {
    deleteSession(session.id);  // generator exhausted: delete session
    break;
  }
```
`nextWithRetry` (index.ts:45–73) wraps `.next()` with 3-attempt exponential backoff for transient/rate-limit errors.

**Step 2 — StepTracker processes message** (`server/src/index.ts:173`)
```typescript
const sseEvents = tracker.process(sdkMessage);  // line 173
```
For `type === "result"`, `tracker.process()` returns **two events** in sequence (step-tracker.ts:71–98):
1. `{ event: "result", data: TurnResult }` — the structured result
2. `{ event: "done", data: "[DONE]" }` — end-of-stream signal

**Step 3 — Events flushed to client** (`server/src/index.ts:174–187`)
```typescript
for (const sseEvent of sseEvents) {
  // override session:init sessionId ...
  await emitSSEEvent(stream, sseEvent);  // line 182
}
```
By the time this loop finishes on a `result` message, BOTH the `result` AND `done` events are on the wire.

**Step 4 — File scan and break** (`server/src/index.ts:190–208`)
```typescript
if (sdkMessage.type === "result") {
  // scan session.sessionDir for created files → emit file_created events
  // then:
  break;  // line 207 — exits the while loop
}
```
Session is **not** deleted here. It stays alive for follow-up messages (30-min TTL reset).

**Step 5 — finally block** (`server/src/index.ts:228–236`)
```typescript
} finally {
  session.streaming = false;  // line 229
  await stream.writeSSE({ data: "[DONE]" });  // line 233 — safety-net fallback
}
```

**Step 6 — Frontend SSE parsing** (`client/src/hooks/useAgentView.ts`)
- ReadableStream reader + TextDecoder + `\n\n` splits
- `handleSSEEvent()` dispatches `{ type: "RESULT", result: TurnResult }` on `result` event
- `agentViewReducer` sets `state.lastResult = action.result`, `state.automation = "complete"` (or `"error"`)
- `ObservableAutomationView` renders cost/tokens/time/turns footer from `state.lastResult`

### 3. Critical Ordering Constraint [Analyzer]

The `done` SSE event is emitted at `step-tracker.ts:98` inside the same `events` array as the `result` event. Both are flushed in the `for...of sseEvents` loop at `index.ts:174–187`. This happens **before** the `if (sdkMessage.type === "result")` block at line 190.

**Consequence**: Any evaluation SSE event inserted at or after line 190 arrives at the client **after `done`**. The frontend's SSE parser may ignore events after `done` depending on implementation.

### 4. Hook Points for Evaluation [Analyzer]

#### Hook A — Before `tracker.process()` (RECOMMENDED)

**Location**: `server/src/index.ts:172`, before the `tracker.process(sdkMessage)` call.

```typescript
// Line 172 — INSERT HERE
if (sdkMessage.type === "result") {
  const evalResult = await evaluate(sdkMessage, session);
  session.lastEvaluation = evalResult;             // persist to session state
  await emitSSEEvent(stream, {
    event: "evaluation",
    data: evalResult,
  });
}

// Line 173 — existing code continues normally
const sseEvents = tracker.process(sdkMessage);    // emits result + done
```

Pros:
- `sdkMessage.result` (agent's final text) is available for LLM-as-judge
- `session.sessionDir` accessible for file inspection
- SSE stream is open; `evaluation` event arrives **before** `result` and `done`
- Session is live and writable

#### Hook B — Inside StepTracker, separate `done` from `result`

**Location**: `server/src/step-tracker.ts:71–98`. Remove the `done` push at line 98; let the route handler emit `done` after evaluation.

Requires changes to both `step-tracker.ts` and `index.ts`. More surgical but breaks StepTracker's current API contract.

#### Hook C — Session state only at line 190

**Location**: `server/src/index.ts:190`. Can store evaluation in `session.lastEvaluation` but **cannot** emit SSE events to the frontend (already past `done`). Only viable if evaluation results are retrieved later via a separate API endpoint (e.g., `GET /api/sessions/:id/evaluation`).

### 5. Session Object Shape [Locator + Pattern Finder]

`server/src/sessions.ts:47–55`:
```typescript
export type Session = {
  id: string;
  sdkSessionId: string;
  query: Query;
  queue: MessageQueue;
  streaming: boolean;
  ttlTimer: ReturnType<typeof setTimeout>;
  sessionDir: string;
  // No evaluation field exists today
};
```

Session lifecycle:
- Created by `createSession()` — allocates ID, starts TTL, creates `sessionDir` at `/tmp/duvo-sessions/<id>`
- Follow-ups via `feedFollowUp()` — enqueues to `queue`, resets TTL
- Deleted by `deleteSession()` — clears timer, calls `query.close()`, removes from map
- On `result` message: session is **preserved** (NOT deleted). TTL continues.
- On generator `done` (exhausted): `deleteSession()` called immediately (index.ts:136)

### 6. SSE Event Inventory [Pattern Finder]

All events emitted by the server, in order of a typical successful session:

| Event name | Source | Data shape |
|---|---|---|
| `sdk` | StepTracker:22 | `{ type, serverTimestamp, payload }` |
| `session:init` | StepTracker:34 | `{ sessionId, model, tools, timestamp }` |
| `turn:start` | StepTracker:112 | `{ turnId, timestamp }` |
| `step:start` | StepTracker:126 | `{ stepId, turnId, type, blockIndex, toolName?, toolCallId?, timestamp }` |
| `step:delta` | StepTracker:163 | `{ stepId, delta, deltaType, timestamp }` |
| `step:complete` | StepTracker:176 | `{ stepId, timestamp }` |
| `turn:complete` | StepTracker:55 | `{ turnId, stopReason, timestamp }` |
| `file_created` | index.ts:161 | `{ type, filename, downloadUrl }` _(files_persisted path)_ |
| `result` | StepTracker:72 | `TurnResult` |
| `done` | StepTracker:98 | `"[DONE]"` |
| `file_created` | index.ts:194 | `{ type, filename, downloadUrl }` _(post-result dir scan)_ |
| `error` | index.ts:219 | `{ message, code, timestamp }` |

`SSEEvent` union (shared/src/types/index.ts:263–274) lists all 10 current event types. An `EvaluationEvent` would need to be added as the 11th.

### 7. Evaluation Logic — What Can Be Scored

From the raw SDK `result` message at Hook A:

**Deterministic signals (no LLM needed)**:
- `subtype !== "success"` → definitive failure. Subtypes:
  - `"error_max_turns"` — agent exhausted its turn budget
  - `"error_during_execution"` — runtime exception in agent
  - `"error_max_budget_usd"` — cost limit hit
- `subtype === "success"` → agent completed without hitting a limit
- `numTurns`, `totalCostUsd`, `durationMs` — efficiency metrics
- Files in `session.sessionDir` — artifact presence check

**Heuristic signals (cheap, no LLM)**:
- `result` text length — empty result despite `success` subtype may indicate a hollow completion
- File count in `sessionDir` — task required file creation, zero files = likely incomplete
- `usage.outputTokens` — very low output on complex tasks may signal superficial work

**LLM-as-judge (expensive)**:
- Feed `sdkMessage.result` + original prompt back to Claude with a scoring rubric
- Returns a score + rationale
- Requires a second Claude API call — adds latency + cost

---

## Code References

| File | Line | Description |
|---|---|---|
| `server/src/step-tracker.ts` | 71–98 | `case "result"`: builds `TurnResult`, pushes `result` + `done` events |
| `server/src/step-tracker.ts` | 18 | `process()` signature — returns `SSEEvent[]` |
| `server/src/index.ts` | 131–138 | Manual `.next()` loop, generator exhaustion |
| `server/src/index.ts` | 172–188 | **Hook A location** — before `tracker.process()` |
| `server/src/index.ts` | 190–208 | `result` check, file scan, `break` |
| `server/src/index.ts` | 228–236 | `finally` block — `streaming = false`, fallback `[DONE]` |
| `server/src/sessions.ts` | 47–55 | `Session` type — all fields |
| `server/src/sessions.ts` | 9–10 | `SESSION_TTL_MS = 30min`, `SESSION_BASE = /tmp/duvo-sessions` |
| `shared/src/types/index.ts` | 119–130 | `TurnResult` interface |
| `shared/src/types/index.ts` | 112–117 | `UsageInfo` interface |
| `shared/src/types/index.ts` | 244–246 | `ResultEvent` SSE wrapper |
| `shared/src/types/index.ts` | 258–261 | `DoneEvent` SSE wrapper |
| `shared/src/types/index.ts` | 263–274 | `SSEEvent` discriminated union |
| `shared/src/types/index.ts` | 292–303 | `AgentViewState` — includes `lastResult: TurnResult | null` |
| `shared/src/types/index.ts` | 305–324 | `StateAction` union — includes `{ type: "RESULT"; result: TurnResult }` |
| `client/src/hooks/useAgentView.ts` | (dispatch) | `handleSSEEvent()` → dispatches `RESULT` action |

GitHub permalinks (branch: feat/step-4, commit: 7ab2b16):
- [step-tracker.ts L71–98](https://github.com/iamladi/duvo-test/blob/7ab2b169837ed6d049c0498632519d2f5323d5ee/server/src/step-tracker.ts#L71)
- [index.ts L172–208](https://github.com/iamladi/duvo-test/blob/7ab2b169837ed6d049c0498632519d2f5323d5ee/server/src/index.ts#L172)
- [shared/types L119–130](https://github.com/iamladi/duvo-test/blob/7ab2b169837ed6d049c0498632519d2f5323d5ee/shared/src/types/index.ts#L119)

---

## Architecture Documentation

### Current Flow (no evaluation)

```
SDK generator
  └─ nextWithRetry()           index.ts:134
       └─ msg.type === "result"
            └─ tracker.process(msg)    index.ts:173  ← result + done emitted HERE
                 └─ for sseEvents → emitSSEEvent()   index.ts:182
                      └─ [result SSE] → client
                      └─ [done SSE]   → client
            └─ readdirSync(sessionDir) index.ts:192
            └─ break                   index.ts:207
  └─ finally: session.streaming = false
```

### Proposed Flow (with evaluation at Hook A)

```
SDK generator
  └─ nextWithRetry()
       └─ msg.type === "result"  ← NEW: check here
            ├─ evaluate(msg, session)        NEW evaluator.ts
            ├─ session.lastEvaluation = …    persist to session state
            ├─ emitSSEEvent("evaluation", …) NEW SSE event → client
            └─ tracker.process(msg)          existing: result + done
                 └─ for sseEvents → emitSSEEvent()
                      └─ [evaluation SSE] already sent
                      └─ [result SSE]     → client
                      └─ [done SSE]       → client
       └─ readdirSync(sessionDir)
       └─ break
  └─ finally: session.streaming = false
```

### Files Requiring Changes

| File | Change |
|---|---|
| `shared/src/types/index.ts` | Add `EvaluationResult` type; add `EvaluationEvent` to `SSEEvent` union; add `lastEvaluation` to `AgentViewState`; add `EVALUATION` to `StateAction` |
| `server/src/sessions.ts` | Add `lastEvaluation?: EvaluationResult` to `Session` type |
| `server/src/index.ts` | Insert evaluation call at line 172, before `tracker.process()` |
| `server/src/evaluator.ts` | **New file** — `evaluate(sdkMessage, session): Promise<EvaluationResult>` |
| `client/src/hooks/useAgentView.ts` | Add `case "EVALUATION"` to reducer; handle `evaluation` SSE event |
| `client/src/components/ObservableAutomationView.tsx` | Render evaluation badge/card in result footer |

---

## Related Research

- `research/research-observable-automation.md` — StepTracker design and SSE event model
- `research/research-agent-file-output-download.md` — file scan after result, `sessionDir` pattern
- `research/research-agent-frontend-claude-sdk.md` — frontend SSE parsing, `useAgentView` hook

---

## Follow-up Research [2026-03-03 — Web Search]

### Additional SDK `result` Fields Not Captured by Current Codebase

The web search agent found the authoritative SDK type definition. The current `StepTracker` (`step-tracker.ts:71–98`) only extracts a subset of result fields. The full SDK `result` message (success branch) includes:

| Field | Type | Captured today? | Eval relevance |
|---|---|---|---|
| `subtype` | union string | Yes (`TurnResult`) | Primary pass/fail |
| `result` | `string` | Yes (`TurnResult`) | LLM judge input |
| `total_cost_usd` | `number` | Yes | Cost metric |
| `duration_ms` | `number` | Yes | Wall-clock latency |
| `num_turns` | `number` | Yes | Efficiency proxy |
| `usage` | token counts | Yes | Token metrics |
| **`is_error`** | `boolean` | **No** | Secondary fail signal |
| **`duration_api_ms`** | `number` | **No** | API-only latency (vs total) |
| **`stop_reason`** | `string \| null` | **No** | `"end_turn"` vs `"max_tokens"` |
| **`permission_denials`** | `SDKPermissionDenial[]` | **No** | Blocked tool calls → confidence penalty |
| **`modelUsage`** | `{[model]: ModelUsage}` | **No** | Per-model cost breakdown |
| **`structured_output`** | `unknown` | **No** | Self-evaluation artifact (if outputFormat set) |
| **`errors`** | `string[]` (error branch only) | **No** | Human-readable error strings |
| **`uuid`** | `UUID` | **No** | SDK-level message ID |

**`SDKPermissionDenial`** structure (not yet in codebase):
```typescript
{ tool_name: string; tool_use_id: string; tool_input: Record<string, unknown> }
```

**`is_error` anomaly**: In some SDK 0.2.x versions, `is_error: true` can appear alongside `subtype: "success"` due to an AJV validation bug. Do not use `is_error` as the sole gate — check `subtype === "success"` first.

### Structured Output as Self-Evaluation Artifact

Instead of a second LLM judge call, pass `outputFormat` to the existing `sdkQuery()` call. The agent self-evaluates and `structured_output` becomes the eval artifact — zero extra latency, zero extra API cost:

```typescript
import { z } from "zod";

const EvalSchema = z.object({
  task_completed: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  artifacts_produced: z.array(z.string()),
  blockers: z.array(z.string()),
});

// Pass to sdkQuery():
options: { outputFormat: { type: "json_schema", schema: z.toJSONSchema(EvalSchema) } }

// Then on result:
if (msg.type === "result" && msg.subtype === "success" && msg.structured_output) {
  const eval = EvalSchema.safeParse(msg.structured_output);
}
```

Error subtype `"error_max_structured_output_retries"` = agent couldn't conform to schema → treat as `confidence: 0`.

Downside: model scores its own work (potential bias). A separate cheap judge call (claude-haiku) is less biased.

### Heuristic Scoring Ladder (cheapest → most expensive)

1. `subtype !== "success"` → score `0`, skip all further evaluation
2. `is_error === true` (with subtype check) → score `0`
3. `stop_reason === "max_tokens"` → truncated output, apply penalty
4. `permission_denials.length > 0` → blocked tool calls, apply confidence penalty
5. `result.length < 50` → empty/refusal, score `0`
6. `num_turns >= maxTurns` → hit ceiling, apply confidence penalty
7. Heuristic pass → fire LLM judge (claude-haiku, ~$0.0001/call)

### Multi-Turn Cost Accumulation

The SDK provides per-`query()` cost only. For sessions with follow-up turns, `total_cost_usd` must be accumulated manually from each `result` message. `evalHistory: EvalRecord[]` on the Session object handles this.

### External Sources

- [Claude Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) — canonical type definitions
- [Track cost and usage](https://platform.claude.com/docs/en/agent-sdk/cost-tracking) — `modelUsage`, multi-turn deduplication
- [Structured outputs](https://platform.claude.com/docs/en/agent-sdk/structured-outputs) — `outputFormat`, `structured_output` field
- [Demystifying evals for AI agents — Anthropic Engineering](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) — eval-driven development guidance
- [LLM-as-a-Judge guide — Langfuse](https://langfuse.com/docs/evaluation/evaluation-methods/llm-as-a-judge)
- [Evaluate Coding Agents — Promptfoo](https://www.promptfoo.dev/docs/guides/evaluate-coding-agents/)

---

## Open Questions

1. **LLM-as-judge latency**: If evaluation calls Claude again, it adds ~2–5s to every session end. Should it be synchronous (blocks `done`) or async (fires after `done`, stored only in session state)?

2. **Evaluation criteria**: Should evaluation rules be hardcoded (subtype !== "success" = fail) or configurable per prompt/session? The current Session type has no task-description field separate from the prompt.

3. **Multi-turn sessions**: Sessions are NOT deleted on `result` — they stay alive for follow-ups. Should evaluation reset on each follow-up turn, or accumulate across turns?

4. **`done` ordering with evaluation SSE**: If evaluation runs before `tracker.process()` (Hook A), the sequence is `evaluation → result → done`. The frontend's `useAgentView` SSE parser processes events sequentially — does it handle `evaluation` before `RESULT` dispatch? The reducer would need an `EVALUATION` action independent of `RESULT`.

5. **Heuristic vs LLM-as-judge**: For a start, is `subtype === "success"` sufficient as the pass/fail signal, or is deeper scoring (LLM-as-judge on `result` text) required for the MVP?
