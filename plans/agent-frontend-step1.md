---
title: "Agent Frontend Step 1: Single-instruction streaming chat"
type: Feature
issue: null
research: ["research/research-agent-frontend-claude-sdk.md"]
status: Ready for Implementation
reviewed: false
reviewers: []
created: 2026-03-03
---

# PRD: Agent Frontend Step 1 — Single-instruction Streaming Chat

## Metadata
- **Type**: Feature
- **Priority**: High
- **Severity**: N/A
- **Estimated Complexity**: 4
- **Created**: 2026-03-03
- **Status**: Draft

## Overview

### Problem Statement
We need a lightweight frontend for our automation platform that can send instructions to an agentic system and receive streaming responses. This is **Step 1 of 5** — the foundation that later steps will extend with tools, multi-agent support, and more complex interactions.

### Goals & Objectives
1. User can type an instruction and receive a streaming response from a Claude agent
2. Multi-turn conversation — user can send follow-ups within the same session
3. Real-time token streaming — text appears progressively as the agent generates it
4. Clean architecture that's extensible for Steps 2-5

### Success Metrics
- **Primary Metric**: User can send an instruction and see tokens stream in real-time
- **Secondary Metrics**: Multi-turn works (follow-up uses same session context); abort/cancel works mid-stream
- **Quality Gates**: `bun run dev` starts both client and server; streaming latency < 500ms to first token; no CORS issues in dev

## User Stories

### Story 1: Send instruction and get streaming response
- **As a**: Platform user
- **I want**: To type an instruction and see the agent's response appear token-by-token
- **So that**: I get real-time feedback without waiting for the full response
- **Acceptance Criteria**:
  - [ ] Text input field accepts user instruction
  - [ ] Response streams in real-time (tokens appear progressively)
  - [ ] Loading state shown while agent is responding

### Story 2: Multi-turn conversation
- **As a**: Platform user
- **I want**: To send follow-up messages that have context from previous turns
- **So that**: I can refine or continue a conversation without restarting
- **Acceptance Criteria**:
  - [ ] Previous messages displayed in conversation view
  - [ ] Follow-up messages resume the same agent session
  - [ ] Session context is preserved across turns

### Story 3: Cancel in-flight request
- **As a**: Platform user
- **I want**: To stop a running agent response
- **So that**: I can cancel if the agent is going in the wrong direction
- **Acceptance Criteria**:
  - [ ] Stop button visible while agent is streaming
  - [ ] Clicking stop aborts the current stream
  - [ ] UI returns to input-ready state after cancel

## Requirements

### Functional Requirements

1. **FR-1**: Backend accepts POST with instruction, streams SSE response from Claude Agent SDK
   - Details: POST `/api/agent` with `{ prompt, sessionId? }`, returns `text/event-stream`
   - Priority: Must Have

2. **FR-2**: Frontend streams and displays response tokens progressively
   - Details: Use `fetch()` + `ReadableStream` reader to consume SSE from POST endpoint
   - Priority: Must Have

3. **FR-3**: Multi-turn conversation via streaming input mode
   - Details: Use streaming input mode (`query({ prompt: asyncIterable })`) to keep the SDK subprocess alive between turns. Feed follow-ups via `query.streamInput()`. This avoids the ~12s cold-start penalty of `resume` with string prompts. Server holds a `Map<sessionId, Query>` of active sessions.
   - Priority: Must Have

4. **FR-4**: Abort/cancel running agent requests
   - Details: `AbortController` on frontend `fetch()`, propagated to SDK via its `abortController` option
   - Priority: Must Have

5. **FR-5**: Basic error display
   - Details: Show error message to user for SDK errors (`error_max_turns`, `error_during_execution`, rate limits). Allow retry.
   - Priority: Must Have

6. **FR-6**: Display cost/usage after completion
   - Details: Show `total_cost_usd` and token counts from `result` message
   - Priority: Should Have

### Non-Functional Requirements

1. **NFR-1**: Streaming latency
   - Requirement: Time from submit to first visible token
   - Target: < 500ms (network) + SDK startup time
   - Measurement: Manual observation in dev

2. **NFR-2**: Dev experience
   - Requirement: Single command starts entire stack with hot reload
   - Target: `bun run dev` starts client + server concurrently
   - Measurement: Verify both processes start and Vite proxy works

### Technical Requirements

- **Stack**: TypeScript, React 19, Vite 6, Hono, Bun
- **Dependencies**: `@anthropic-ai/claude-agent-sdk`, `hono`, `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `zod@^4`
- **Architecture**: Bun workspaces monorepo — `client/` (Vite+React), `server/` (Bun+Hono), `shared/` (types). BHVR uses flat `client/`, `server/`, `shared/` directories (not `apps/` or `packages/`).
- **Data Model**: No database persistence. Active session state held in-memory via `Map<sessionId, Query>` on the server. SDK subprocess stays alive for the session duration (streaming input mode).
- **API Contracts**: `POST /api/agent` → SSE stream; `POST /api/agent/new` → create new session

## Scope

### In Scope
- Project scaffolding (BHVR template or manual equivalent)
- Hono backend with SSE streaming endpoint
- React frontend with instruction input and streaming response display
- Multi-turn conversation via SDK streaming input mode (keeps subprocess alive)
- Abort/cancel support
- Basic error display
- Vite dev proxy for CORS-free development

### Out of Scope
- Agent tool use (Read, Edit, Bash) — Step 2+
- Authentication / user management
- Persistent storage / database
- Production deployment / Docker
- Styling beyond minimal functional
- Multiple concurrent conversations
- Model selection UI
- Custom system prompts from UI

### Future Considerations
- Step 2: Agent tool access (file read/write, code execution)
- Step 3: Multi-agent orchestration
- Step 4: Custom tools via MCP
- Step 5: Production deployment

## Impact Analysis

### Affected Areas
- Greenfield project — no existing code affected

### Users Affected
- Developer/evaluator using the automation platform

### System Impact
- **Performance**: SDK spawns a subprocess on first message. Streaming input mode keeps it alive for follow-ups (<1s latency vs ~12s with `resume`). Server is stateful (holds active Query instances in memory).
- **Security**: API key in system environment, never sent to frontend. No auth needed for Step 1 (local dev only).
- **Data Integrity**: No persistent data. Session state managed by SDK.

### Dependencies
- **Upstream**: None (greenfield)
- **Downstream**: Steps 2-5 will extend this foundation
- **External**: Claude API (via Agent SDK), npm registry for packages

### Breaking Changes
- [x] **None** (greenfield project)

## Solution Design

### Approach

**Scaffold** the project using the BHVR template (`bun create bhvr@latest`) which provides a Bun+Hono+Vite+React monorepo with Turbo build orchestration and Bun workspaces. BHVR v0.5.1 (Dec 2025, 1.8k stars) uses flat directory structure: `client/`, `server/`, `shared/`.

**Backend** (`server/`): Hono server with stateful session management:

1. **Session store**: `Map<string, Query>` holds active agent sessions in memory. Each session is a running SDK subprocess.
2. **`POST /api/agent`**: Accepts `{ prompt, sessionId? }`:
   - If no `sessionId`: creates new `query()` in streaming input mode (prompt as `AsyncIterable`), stores in session map, generates a UUID as session ID
   - If `sessionId` provided: looks up existing query, feeds follow-up via `query.streamInput()`
   - Both cases stream SSE response via Hono's `streamSSE`
3. **Query options**: `includePartialMessages: true`, `model: "claude-sonnet-4-6"`, `allowedTools: []`, `permissionMode: "bypassPermissions"`, `allowDangerouslySkipPermissions: true`
4. **SSE event forwarding**: Filters SDK messages to forward: `system` (init), `stream_event` (text deltas), `assistant` (complete turns), `result` (final)

**Critical SSE gotchas** (from web research):
- Must parse request body BEFORE entering `streamSSE` callback (body stream consumed by response)
- Set `idleTimeout: 0` on `Bun.serve()` to prevent Bun from killing idle SSE connections
- Use `stream.onAbort()` for cleanup; wrap stream logic in try/catch (errors bypass Hono's `onError`)
- Disable compression on SSE routes (`Content-Encoding: identity`) to prevent buffering

**Frontend** (`client/`): React app with:
1. `useAgentStream` hook — manages fetch + ReadableStream SSE consumption, session tracking, abort
2. `AgentChat` component — displays conversation messages, input field, send/stop buttons
3. Vite proxy config — `/api` → `http://localhost:3001`

**Shared types** (`shared/`): TypeScript types for API request/response contracts between client and server.

**Multi-turn flow** (streaming input mode — avoids ~12s `resume` overhead):
1. First message: Server creates `query({ prompt: asyncIterable, options })`, feeds first user message, stores Query in session map with generated UUID
2. SDK subprocess starts, streams response → forwarded via SSE → client renders tokens
3. Client captures `sessionId` from SSE init event
4. Follow-up: Client sends `{ prompt, sessionId }` → server looks up Query, calls `query.streamInput(followUpAsyncIterable)` → subprocess continues with full context, <1s latency
5. Subprocess stays alive for the session lifetime

### Alternatives Considered

1. **Raw `Bun.serve` instead of Hono**
   - Pros: Zero framework dependency, slightly less code
   - Cons: No `streamSSE` helper, manual header management, no middleware for future steps
   - Why rejected: Hono adds minimal overhead and `streamSSE` significantly simplifies SSE handling

2. **V2 API (`createSession`) instead of V1 (`query`)**
   - Pros: Cleaner multi-turn pattern, no subprocess per follow-up
   - Cons: Marked `unstable_v2_*`, API may change between our 5 steps
   - Why rejected: V1 is stable. Can migrate to V2 when it stabilizes if needed.

3. **WebSocket instead of SSE**
   - Pros: Bidirectional, can push server events
   - Cons: More complex setup, overkill for request/response pattern
   - Why rejected: SSE is simpler and sufficient for streaming responses. Agent SDK is request-response, not bidirectional.

4. **Manual project setup instead of BHVR**
   - Pros: Full control over every file
   - Cons: More boilerplate to write, same result
   - Why rejected: User chose BHVR template for faster scaffolding

5. **`resume: sessionId` for multi-turn (instead of streaming input mode)**
   - Pros: Stateless server — no in-memory session map needed. Each request is independent.
   - Cons: ~12 second cold-start per follow-up (spawns new subprocess, reads JSONL from disk). Terrible UX for real-time chat.
   - Why rejected: 12s latency per turn is unacceptable. Streaming input mode keeps subprocess alive for <1s follow-up latency. Stateful server is acceptable for single-user Step 1.

### Data Model Changes
None — no persistence in Step 1.

### API Changes

**New endpoint:**
```
POST /api/agent
Content-Type: application/json

Request body:
{
  "prompt": string,       // User instruction
  "sessionId"?: string    // Optional session ID for multi-turn
}

Response:
Content-Type: text/event-stream

SSE events:
  event: system       data: { type: "system", subtype: "init", session_id: "...", ... }
  event: stream_event data: { type: "stream_event", event: { type: "content_block_delta", delta: { text: "..." } } }
  event: assistant    data: { type: "assistant", message: { content: [...] } }
  event: result       data: { type: "result", subtype: "success"|"error_*", total_cost_usd: number, ... }
  event: error        data: { type: "error", message: "..." }
  data: [DONE]
```

### UI/UX Changes

Minimal functional UI:
- Top: conversation message list (user messages + agent responses)
- Bottom: text input + send button (or stop button while streaming)
- After completion: small cost/usage indicator
- Error states: inline error message with retry option

## Implementation Plan

### Phase 1: Project Scaffolding
**Complexity**: 2 | **Priority**: High

- [ ] Run `bun create bhvr@latest duvo-test-app` (or scaffold in current directory)
- [ ] Adjust workspace structure if BHVR output differs from our needs
- [ ] Verify `bun install` succeeds
- [ ] Verify `bun run dev` starts both client and server
- [ ] Add `@anthropic-ai/claude-agent-sdk` and `zod@^4` to server dependencies

### Phase 2: Backend — Session Store & Agent SSE Endpoint
**Complexity**: 4 | **Priority**: High

- [ ] Create `server/src/sessions.ts` — session store (`Map<string, Query>`) with create/get/cleanup methods
- [ ] Create `POST /api/agent` route in Hono server
- [ ] Parse request body BEFORE entering `streamSSE` callback (critical: body stream consumed by response)
- [ ] First message (no sessionId): create `query()` in streaming input mode, store in session map, generate UUID
- [ ] Follow-up (with sessionId): look up Query, feed via `streamInput()`
- [ ] Use `streamSSE` to forward filtered SDK messages (system, stream_event, assistant, result)
- [ ] Set `idleTimeout: 0` on `Bun.serve()` to prevent connection kills
- [ ] Wrap streamSSE callback in try/catch (errors bypass Hono's onError)
- [ ] Use `stream.onAbort()` for cleanup
- [ ] Handle errors: catch SDK errors, send as SSE error event to client

### Phase 3: Frontend — Streaming Chat UI
**Complexity**: 3 | **Priority**: High

- [ ] Create `useAgentStream` hook:
  - POST to `/api/agent` with `fetch()`
  - Read SSE stream via `response.body.getReader()`
  - Parse SSE lines, dispatch by event type
  - Track session ID from `system` event
  - Support `AbortController` for cancel
  - Track loading/error/messages state
- [ ] Create `AgentChat` component:
  - Display conversation history (user + agent messages)
  - Text input with send handler
  - Stop button during streaming
  - Error display with retry
  - Cost/usage display after completion
- [ ] Wire up `App.tsx` to render `AgentChat`
- [ ] Configure Vite proxy: `/api` → `http://localhost:3001`

### Phase 4: Shared Types & Integration
**Complexity**: 2 | **Priority**: Medium

- [ ] Define shared types in `shared/src/types/`:
  - `AgentRequest` (`{ prompt: string, sessionId?: string }`)
  - `AgentSSEEvent` (union of forwarded SDK message types)
- [ ] Import shared types in both server and client
- [ ] End-to-end integration test: start both, send instruction, verify streaming response

### Phase 5: Polish & Validation
**Complexity**: 1 | **Priority**: Medium

- [ ] Test multi-turn: send instruction → get response → send follow-up → verify context
- [ ] Test abort: start streaming → click stop → verify stream stops
- [ ] Test error handling: invalid input, SDK errors
- [ ] Verify no CORS issues via Vite proxy
- [ ] Manual smoke test of full flow

## Relevant Files

### Existing Files
- `research/research-agent-frontend-claude-sdk.md` — Research findings informing this plan

### New Files (after BHVR scaffold + our additions)
- `server/src/index.ts` — Hono server with `/api/agent` SSE endpoint and session management
- `server/src/sessions.ts` — Session store (`Map<string, Query>`) and lifecycle management
- `client/src/hooks/useAgentStream.ts` — React hook for SSE consumption
- `client/src/components/AgentChat.tsx` — Chat UI component
- `client/src/App.tsx` — Main app wiring
- `client/vite.config.ts` — Vite config with proxy
- `shared/src/types/index.ts` — Shared TypeScript types

### Test Files
- Manual testing for Step 1 (E2E via browser). Automated tests deferred to a later step.

## Testing Strategy

### Unit Tests
- Deferred for Step 1. The codebase is small enough for manual verification.

### Integration Tests
- Deferred for Step 1.

### E2E Tests
- Deferred for Step 1.

### Manual Test Cases

1. **Basic streaming**:
   - Steps: Start dev server, type "Hello, what can you do?", submit
   - Expected: Tokens stream in progressively, result shows cost

2. **Multi-turn conversation**:
   - Steps: Send "What is 2+2?", wait for response, send "Now multiply that by 3"
   - Expected: Second response references "4" from first turn

3. **Abort mid-stream**:
   - Steps: Send a prompt that generates a long response, click Stop mid-stream
   - Expected: Streaming stops, UI returns to input-ready state

4. **Error handling**:
   - Steps: Stop the server, try to send a message
   - Expected: Error message displayed, no crash

## Risk Assessment

### Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| SDK subprocess startup latency (~12s first message) | High | Medium | Accept for first message. Streaming input mode keeps subprocess alive for follow-ups (<1s). |
| SSE parsing edge cases (chunked boundaries) | Medium | Medium | Use robust SSE line parser that handles partial chunks across read() calls |
| Bun idleTimeout kills SSE connections | High | High | Set `idleTimeout: 0` on `Bun.serve()`. Send keepalive pings every 5s for long idle periods. |
| Errors inside streamSSE bypass Hono onError | High | Medium | Wrap all streamSSE callback logic in try/catch. Send error events to client explicitly. |
| Server statefulness (in-memory session map) | Medium | Medium | Acceptable for single-user dev. Sessions lost on server restart. Not horizontally scalable. |
| Streaming input mode API surface uncertainty | Medium | Medium | Test the exact `streamInput()` API before building. Fallback to `resume` if streaming input doesn't work as expected (accept 12s penalty). |

### Business Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Step 1 architecture doesn't extend well to Steps 2-5 | Low | High | Architecture is modular (hook + component + endpoint). Each piece can be extended independently. |

### Mitigation Strategy
Start simple, validate the streaming pipeline end-to-end before adding complexity. The BHVR monorepo structure provides clean separation for future extension.

## Rollback Strategy

### Rollback Steps
1. This is a greenfield project — rollback is `trash apps/ packages/` and re-scaffold
2. Git provides full history for incremental rollback

### Rollback Conditions
- SDK cannot be installed or doesn't work with Bun
- Streaming pipeline has unfixable latency issues
- BHVR template is fundamentally incompatible with our needs

## Validation Commands

```bash
# Install dependencies
bun install

# Start dev server (both client + server)
bun run dev

# Verify server responds
curl -X POST http://localhost:3001/api/agent \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Say hello in one sentence"}'

# Verify client loads
open http://localhost:5173

# Verify streaming works (manual browser test)
# Type "Hello" in the input, press Send, observe streaming response
```

## Acceptance Criteria

- [ ] `bun install` succeeds with no errors
- [ ] `bun run dev` starts both client (Vite on :5173) and server (Hono on :3001)
- [ ] User can type an instruction and see tokens stream in real-time
- [ ] Multi-turn works: follow-up messages have context from previous turns
- [ ] Stop/cancel button aborts an in-flight stream
- [ ] Errors are displayed to the user (not silent failures)
- [ ] Cost/usage shown after agent completes
- [ ] No CORS errors in browser console

## Dependencies

### New Dependencies

- `@anthropic-ai/claude-agent-sdk@^0.2.63` — Claude Agent SDK for TypeScript (server)
- `zod@^4` — Peer dependency of Agent SDK (server)
- `hono@^4` — HTTP framework with SSE helper (server, likely included by BHVR)
- `react@^19` — UI framework (client, included by BHVR)
- `react-dom@^19` — React DOM renderer (client, included by BHVR)
- `vite@^6` — Frontend build tool (client, included by BHVR)
- `@vitejs/plugin-react@^4` — Vite React plugin (client, included by BHVR)
- `turbo` — Monorepo build orchestration (devDep, included by BHVR)

### Dependency Updates
- None (greenfield)

## Notes & Context

### Additional Context
- This is Step 1 of a 5-step assignment that will evolve the platform
- ANTHROPIC_API_KEY is already set in the system environment — no .env file needed
- The Claude Agent SDK was recently renamed from `@anthropic-ai/claude-code-sdk`

### Assumptions
- The BHVR template v0.5.1 (`bun create bhvr@latest`) is well-maintained (1.8k stars, Dec 2025) and includes Hono by default
- The Claude Agent SDK works correctly with Bun runtime (SDK auto-detects `executable`)
- Streaming input mode (`query.streamInput()`) works to keep subprocess alive between turns
- Single-user usage (no concurrency concerns for Step 1)
- `bunx` is in PATH (required by BHVR scaffold)

### Constraints
- TypeScript only (no Python)
- Bun for all JS/TS tooling
- Minimal functional UI — no styling framework
- No tools for the agent in Step 1

### Related Tasks/Issues
- Future: Steps 2-5 of the automation platform

### References
- Research document: `research/research-agent-frontend-claude-sdk.md`
- Claude Agent SDK docs: https://platform.claude.com/docs/en/agent-sdk/overview
- Claude Agent SDK TypeScript: https://platform.claude.com/docs/en/agent-sdk/typescript
- BHVR template: `bun create bhvr@latest`
- Hono SSE: https://hono.dev/docs/helpers/streaming

### Open Questions
- [ ] Does `query.streamInput()` work as expected for multi-turn with streaming input mode? (Fallback: use `resume` with ~12s per-turn penalty)
- [ ] Should we pin the SDK version exactly (`0.2.63`) or use `^` range? (SDK is pre-1.0, `^` could pull breaking changes)
- [ ] Should we implement session cleanup (timeout/eviction) for abandoned sessions, or defer to a later step?

## Blindspot Review

**Reviewers**: GPT-5.3-Codex (xhigh), Gemini 3 Pro
**Date**: 2026-03-03
**Plan Readiness**: Pending Review

### Addressed Concerns
_To be filled after review_

### Acknowledged but Deferred
_To be filled after review_

### Dismissed
_To be filled after review_
