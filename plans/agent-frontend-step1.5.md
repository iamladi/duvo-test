---
title: "Agent Frontend Step 1.5: Tool Use, File Output & Download"
type: Enhancement
issue: null
research: ["research/research-agent-file-output-download.md"]
status: Draft
reviewed: false
reviewers: []
created: 2026-03-03
---

# PRD: Agent Frontend Step 1.5 — Tool Use, File Output & Download

## Metadata
- **Type**: Enhancement
- **Priority**: High
- **Severity**: N/A
- **Estimated Complexity**: 4
- **Created**: 2026-03-03
- **Status**: Draft

## Overview

### Problem Statement
Step 1 delivers a streaming chat that only produces text responses (`allowedTools: []`). To demonstrate real utility — e.g. "Fetch the latest AI news from the web and save them into a CSV" — the agent needs tool access (web search, file creation) and the user needs a way to download the resulting file. This is a targeted enhancement on top of the Step 1 foundation that remains within the existing architecture.

### Goals & Objectives
1. Agent can use built-in tools (WebSearch, WebFetch, Write, Bash, Read) to complete tasks that produce file output
2. User sees what tools the agent is using via minimal status indicators in the chat
3. When the agent creates a file, a download button appears inline in the chat
4. The system prompt is configurable per request so different task types can be supported

### Success Metrics
- **Primary Metric**: User sends "Fetch the latest AI news from the web and save them into a CSV" and receives a downloadable CSV file
- **Secondary Metrics**: Tool status shows during execution; multi-turn still works with tools enabled; cost/usage still displays
- **Quality Gates**: File download works in browser; no regressions to Step 1 streaming; `bun run dev` still starts both services

## User Stories

### Story 1: Execute a task that produces file output
- **As a**: Platform user
- **I want**: To instruct the agent to fetch AI news and save to CSV
- **So that**: I get structured data I can use elsewhere
- **Acceptance Criteria**:
  - [ ] Agent uses WebSearch to find news articles
  - [ ] Agent creates a CSV file with structured columns (title, source, url, date, summary)
  - [ ] Download button appears in chat after file is created
  - [ ] Clicking download saves the CSV to the user's machine

### Story 2: See what the agent is doing
- **As a**: Platform user
- **I want**: To see status indicators when the agent uses tools
- **So that**: I know the agent is working and what step it's on
- **Acceptance Criteria**:
  - [ ] "Using WebSearch..." appears when agent searches
  - [ ] "Writing file..." appears when agent creates a file
  - [ ] Status clears after tool completes

### Story 3: Provide a custom system prompt
- **As a**: Platform user
- **I want**: To optionally include a system prompt with my request
- **So that**: I can guide the agent for different task types
- **Acceptance Criteria**:
  - [ ] `systemPrompt` field accepted in request body
  - [ ] Agent behavior reflects the system prompt
  - [ ] Omitting systemPrompt still works (no regression)

## Requirements

### Functional Requirements

1. **FR-1**: Enable built-in SDK tools on all sessions
   - Details: Change `allowedTools: []` to `["WebSearch", "WebFetch", "Write", "Bash", "Read"]` in `sessions.ts`. Set `maxTurns: 10` (up from implicit 1).
   - Priority: Must Have

2. **FR-2**: Per-session output directory via `cwd`
   - Details: Create `/tmp/duvo-sessions/<sessionId>/` on session init. Pass as `cwd` to SDK `query()`. Agent writes files there.
   - Priority: Must Have

3. **FR-3**: Detect file creation from `SDKUserMessage.tool_use_result`
   - Details: In SSE forwarding loop, check `user` messages for `FileWriteOutput` (has `filePath` and `type: "create"|"update"`). Emit custom `file_created` SSE event with `{ filename, downloadUrl }`.
   - Priority: Must Have

4. **FR-4**: File download endpoint
   - Details: `GET /api/files/:sessionId/:filename` with path traversal prevention, proper `Content-Disposition: attachment` header, and MIME type detection.
   - Priority: Must Have

5. **FR-5**: Forward tool progress SSE events
   - Details: Forward `tool_progress` (tool name + elapsed time) and `tool_use_summary` (natural language summary) SDK messages to client.
   - Priority: Must Have

6. **FR-6**: Minimal tool status display in chat UI
   - Details: Show "Using {toolName}..." text during tool execution. Clear after tool completes. No collapsible cards — just a status line.
   - Priority: Must Have

7. **FR-7**: File download button in chat UI
   - Details: When `file_created` SSE event arrives, render an inline download button with filename. Uses `<a href={downloadUrl} download>` for browser-native download.
   - Priority: Must Have

8. **FR-8**: Configurable system prompt per request
   - Details: Add optional `systemPrompt` field to `AgentRequest`. Pass to SDK `query()` options. When omitted, no system prompt is set.
   - Priority: Must Have

9. **FR-9**: Sanitized tool result forwarding
   - Details: Forward `tool_result` SSE event with `{ parent_tool_use_id, success }` (omit full file content for bandwidth).
   - Priority: Should Have

### Non-Functional Requirements

1. **NFR-1**: No regressions to Step 1 functionality
   - Requirement: Text streaming, multi-turn, abort, error display, cost display all still work
   - Target: All Step 1 acceptance criteria still pass
   - Measurement: Manual smoke test

2. **NFR-2**: File download latency
   - Requirement: Download starts immediately when user clicks
   - Target: < 100ms to start download (files are local)
   - Measurement: Manual observation

### Technical Requirements

- **Stack**: Same as Step 1 — TypeScript, React 19, Vite 6, Hono, Bun
- **Dependencies**: No new dependencies — all changes use existing `@anthropic-ai/claude-agent-sdk`, `hono`, `react`
- **Architecture**: Same Bun workspaces monorepo — `client/`, `server/`, `shared/`
- **Data Model**: Per-session output directory at `/tmp/duvo-sessions/<sessionId>/`. No database changes.
- **API Contracts**: Modified `POST /api/agent` (new `systemPrompt` field, more SSE event types). New `GET /api/files/:sessionId/:filename`.

## Scope

### In Scope
- Enable SDK tools (WebSearch, WebFetch, Write, Bash, Read) on all sessions
- Per-session output directory via `cwd`
- File creation detection from `tool_use_result`
- File download endpoint with path traversal prevention
- Forward tool_progress and tool_use_summary SSE events
- Minimal tool status line in chat UI
- Inline file download button in chat UI
- Configurable system prompt per request
- Extend shared types for new SSE events
- Vite proxy for `/api/files` route

### Out of Scope
- Collapsible tool use cards (rich UI) — deferred to Step 2
- Multiple file download / zip — single file per download button
- Session directory cleanup / TTL — defer, `/tmp` is ephemeral
- File size limits — news CSVs are typically <1MB
- File preview (showing CSV contents inline) — just download
- Bash-created file detection — system prompt mitigates
- `sandbox` option for OS-level restrictions — `cwd` + `allowedTools` sufficient for dev
- Tool permission UI — `bypassPermissions` handles this

### Future Considerations
- Step 2: Rich tool use display with collapsible cards
- Step 2: File preview (CSV table, JSON viewer)
- Step 2: Session directory cleanup on TTL expiry
- Step 3+: Per-tool permission controls

## Impact Analysis

### Affected Areas
- `server/src/sessions.ts` — query options (allowedTools, maxTurns, cwd, systemPrompt)
- `server/src/index.ts` — SSE forwarding loop (new event types), new GET endpoint
- `shared/src/types/index.ts` — AgentRequest (systemPrompt), AgentSSEEvent (new union members)
- `client/src/hooks/useAgentStream.ts` — handle new SSE events (tool_progress, file_created)
- `client/src/components/AgentChat.tsx` — tool status line, download button
- `client/vite.config.ts` — proxy `/api/files` route

### Users Affected
- Same developer/evaluator user from Step 1 — now has tool-powered agent

### System Impact
- **Performance**: Agent uses multiple turns (3-5 typical, max 10). Each turn involves tool execution. Total task time: 30-90 seconds for news research. No impact on streaming responsiveness.
- **Security**: `bypassPermissions` with scoped `allowedTools` and per-session `cwd`. Path traversal prevention on download endpoint. Acceptable for single-user dev.
- **Data Integrity**: Files written to `/tmp/duvo-sessions/` which is ephemeral. Lost on server restart. Acceptable for Step 1.5.

### Dependencies
- **Upstream**: Step 1 implementation (complete — all files exist)
- **Downstream**: Steps 2-5 will extend tool use and file handling
- **External**: Claude API (via Agent SDK) for tool execution, web for news fetching

### Breaking Changes
- [x] **None** — `POST /api/agent` adds optional `systemPrompt` field (backwards compatible). New SSE events are additive. New GET endpoint is additive.

## Solution Design

### Approach

**Minimal surgical changes** to the existing Step 1 codebase. Six files modified, zero files created.

**Server changes**:

1. **`sessions.ts`**: Change `allowedTools: []` → `["WebSearch", "WebFetch", "Write", "Bash", "Read"]`. Add `maxTurns: 10`. Create per-session output directory and pass as `cwd`. Accept `systemPrompt` parameter in `createSession()`.

2. **`index.ts`**: Extend `FORWARDED_TYPES` to include `tool_progress` and `tool_use_summary`. Add file detection in `user` message handler — when `tool_use_result.filePath` exists, emit `file_created` SSE event. Add `GET /api/files/:sessionId/:filename` route with path traversal prevention.

**Client changes**:

3. **`useAgentStream.ts`**: Add state for `activeToolName` and `createdFiles`. Handle `tool_progress` events (set active tool name), `tool_result` events (clear active tool), and `file_created` events (add to createdFiles list). Also detect `content_block_start` with `type: "tool_use"` in existing `stream_event` handler for immediate tool name display.

4. **`AgentChat.tsx`**: Show tool status line above the input area when a tool is active. Render download buttons for created files after the last assistant message.

**Shared type changes**:

5. **`shared/src/types/index.ts`**: Add `systemPrompt?: string` to `AgentRequest`. Add `tool_progress`, `tool_use_summary`, `tool_result`, `file_created` to `AgentSSEEvent` union. Extend `stream_event` type to include `content_block` (for tool_use detection).

**Config change**:

6. **`client/vite.config.ts`**: The existing `/api` proxy already covers `/api/files/*` — no change needed.

### Alternatives Considered

1. **Custom MCP tool for news fetching**
   - Pros: Full control over search behavior, structured output
   - Cons: More code to write and maintain, reinvents WebSearch
   - Why rejected: Built-in SDK tools (WebSearch + WebFetch + Write) do exactly what's needed

2. **Blob URL download (client-side) instead of server endpoint**
   - Pros: No server endpoint needed, file content comes through SSE
   - Cons: Large CSVs would bloat SSE stream, can't download files not yet in memory
   - Why rejected: Server endpoint is cleaner — file stays on disk, SSE sends only metadata

3. **Rich collapsible tool cards (excel-demo pattern)**
   - Pros: More polished UX, shows tool inputs/outputs
   - Cons: Significantly more code (ToolUseDisplay component, metadata mapping, expand/collapse state)
   - Why rejected: User chose minimal status line for Step 1.5 — defer rich UI to Step 2

4. **Per-request tool toggle**
   - Pros: User can choose chat-only vs tools mode
   - Cons: Adds UI complexity (toggle/checkbox), more state to manage
   - Why rejected: User chose all sessions get tools — simpler

### Data Model Changes
- Per-session directory: `/tmp/duvo-sessions/<sessionId>/` — created on session init, ephemeral

### API Changes

**Modified endpoint**:
```
POST /api/agent
Content-Type: application/json

Request body:
{
  "prompt": string,            // User instruction
  "sessionId"?: string,        // Optional session ID for multi-turn
  "systemPrompt"?: string      // Optional system prompt (NEW)
}

Response (SSE stream):
  // Existing events (unchanged)
  event: system       data: { type: "system", subtype: "init", session_id: "..." }
  event: stream_event data: { type: "stream_event", event: { ... } }
  event: assistant    data: { type: "assistant", message: { content: [...] } }
  event: result       data: { type: "result", ... }
  event: error        data: { type: "error", message: "..." }

  // New events (Step 1.5)
  event: tool_progress    data: { type: "tool_progress", tool_use_id: "...", tool_name: "WebSearch", elapsed_time_seconds: 2.1 }
  event: tool_use_summary data: { type: "tool_use_summary", summary: "Searched for..." }
  event: tool_result      data: { type: "tool_result", parent_tool_use_id: "...", success: true }
  event: file_created     data: { type: "file_created", filename: "ai_news.csv", downloadUrl: "/api/files/.../ai_news.csv" }

  data: [DONE]
```

**New endpoint**:
```
GET /api/files/:sessionId/:filename

Response:
  Content-Type: text/csv (or appropriate MIME type)
  Content-Disposition: attachment; filename="ai_news.csv"
  [file contents]
```

### UI/UX Changes

Minimal additions to existing chat UI:

1. **Tool status line**: Between message list and input area. Shows "Using WebSearch..." with a simple spinner character when a tool is active. Hidden when no tool running.

2. **Download button**: Inline after the assistant message that triggered file creation. Shows filename + "Download" button. Uses `<a href download>` for browser-native download.

No styling framework changes — continues using inline styles matching Step 1 aesthetic.

## Implementation Plan

### Phase 1: Server — Enable Tools & Per-Session Directories
**Complexity**: 3 | **Priority**: High

- [ ] Modify `sessions.ts:createSession()` — accept `systemPrompt` parameter, change `allowedTools` to `["WebSearch", "WebFetch", "Write", "Bash", "Read"]`, add `maxTurns: 10`, create per-session dir at `/tmp/duvo-sessions/<sessionId>/`, pass as `cwd`
- [ ] Add `import { mkdirSync } from "fs"` and `import { join } from "path"` to `sessions.ts`
- [ ] Update `server/src/index.ts` — pass `body.systemPrompt` through to `createSession()`

### Phase 2: Server — SSE Event Forwarding & File Detection
**Complexity**: 3 | **Priority**: High

- [ ] Extend `FORWARDED_TYPES` in `index.ts` to include `"tool_progress"` and `"tool_use_summary"`
- [ ] Add `user` message handler in the SSE loop: detect `tool_use_result.filePath` for file creation, emit `file_created` SSE event
- [ ] Add sanitized `tool_result` SSE event for tool completion signal
- [ ] Add `GET /api/files/:sessionId/:filename` route with path traversal prevention, MIME detection, `Content-Disposition: attachment`
- [ ] Add `import { basename, resolve, join } from "path"` to index.ts

### Phase 3: Shared Types Update
**Complexity**: 1 | **Priority**: High

- [ ] Add `systemPrompt?: string` to `AgentRequest` type
- [ ] Add `tool_progress`, `tool_use_summary`, `tool_result`, `file_created` to `AgentSSEEvent` union
- [ ] Extend `stream_event` variant to include `content_block` field (for tool_use block detection)

### Phase 4: Client — Hook & UI Updates
**Complexity**: 3 | **Priority**: High

- [ ] Add `activeToolName` and `createdFiles` state to `useAgentStream` hook
- [ ] Handle `tool_progress` SSE event — set `activeToolName` to `tool_name`
- [ ] Handle `tool_result` SSE event — clear `activeToolName`
- [ ] Handle `file_created` SSE event — add to `createdFiles` array
- [ ] Detect `content_block_start` with `content_block.type === "tool_use"` in `stream_event` handler — set `activeToolName` immediately
- [ ] Update `AgentChat.tsx` — add tool status line (shows "Using {toolName}..." when active)
- [ ] Update `AgentChat.tsx` — render download buttons for `createdFiles` after the message list
- [ ] Return `activeToolName` and `createdFiles` from hook

### Phase 5: Integration Test & Validation
**Complexity**: 2 | **Priority**: Medium

- [ ] Manual test: Send "Fetch the latest AI news from the web and save them into a CSV"
- [ ] Verify: Tool status shows during WebSearch, WebFetch, Write execution
- [ ] Verify: Download button appears with correct filename
- [ ] Verify: Clicking download saves valid CSV to machine
- [ ] Verify: Multi-turn still works (send follow-up after tool-using turn)
- [ ] Verify: Abort still works during tool execution
- [ ] Verify: Step 1 text-only chat still works (no regressions)

## Relevant Files

### Existing Files (to modify)
- `server/src/sessions.ts` — Add tools, cwd, maxTurns, systemPrompt to query options
- `server/src/index.ts` — Extend SSE forwarding, add file detection, add download endpoint
- `shared/src/types/index.ts` — Extend AgentRequest and AgentSSEEvent types
- `client/src/hooks/useAgentStream.ts` — Handle new SSE events, add tool/file state
- `client/src/components/AgentChat.tsx` — Tool status line, download buttons
- `client/vite.config.ts` — No change needed (existing `/api` proxy covers `/api/files`)

### New Files
- None — all changes are modifications to existing files

### Test Files
- Manual testing for Step 1.5 (same approach as Step 1)

## Testing Strategy

### Unit Tests
- Deferred for Step 1.5 — codebase is small enough for manual verification

### Integration Tests
- Deferred for Step 1.5

### E2E Tests
- Deferred for Step 1.5

### Manual Test Cases

1. **News CSV task (primary)**:
   - Steps: Start dev, send "Fetch the latest AI news from the web and save them into a CSV"
   - Expected: Tool status indicators show during execution. Download button appears. CSV downloads with valid headers and data.

2. **Custom system prompt**:
   - Steps: (via curl or modified UI) Send request with `systemPrompt: "You are a data analyst. Always output CSV with semicolons as delimiters."`
   - Expected: Agent behavior reflects the system prompt

3. **Multi-turn with tools**:
   - Steps: Send "Search for AI news", wait for response, send "Now save those results as a CSV"
   - Expected: Follow-up uses context from first turn, file download works

4. **Abort during tool execution**:
   - Steps: Send a complex task, click Stop while WebSearch is running
   - Expected: Tool execution stops, UI returns to input-ready state

5. **Step 1 regression check**:
   - Steps: Send "What is 2+2?", verify streaming response
   - Expected: Text streams normally, no tool indicators, cost displays

6. **Download endpoint security**:
   - Steps: Attempt `GET /api/files/../../../etc/passwd` and `GET /api/files/../../server/src/index.ts`
   - Expected: 400 or 403 response, no file served

## Risk Assessment

### Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Agent uses Bash instead of Write for CSV creation | Medium | Medium | System prompt explicitly instructs "use Write tool". If Bash is used, file won't have download button but task still completes. |
| `tool_use_result` structure differs from research expectations | Low | High | Research cross-referenced SDK type definitions and demo code. If structure differs, detection logic is isolated in one `if` block — easy to fix. |
| Tool execution significantly increases response time | High | Low | Expected: 30-90 seconds for multi-tool tasks. This is inherent to the task complexity, not a bug. |
| `cwd` doesn't affect Write tool path as expected | Low | High | Research confirmed `cwd` sets subprocess working directory. Agent may use absolute paths — system prompt instructs relative path usage. |
| SSE connection drops during long tool execution (>60s) | Medium | Medium | `idleTimeout: 0` already set in Step 1. Bun won't kill the connection. Browser fetch has no built-in timeout. |

### Business Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Step 1.5 changes break Step 1 functionality | Low | High | Changes are additive. `FORWARDED_TYPES` expansion doesn't affect existing events. New SSE events are handled by new `case` branches. |

### Mitigation Strategy
Changes are surgical — 6 files modified, zero created. Each change is isolated and can be reverted independently. The SSE forwarding loop extension uses a `switch` statement so new cases don't affect existing ones.

## Rollback Strategy

### Rollback Steps
1. Revert `sessions.ts` — change `allowedTools` back to `[]`, remove `cwd` and `maxTurns`
2. Revert `index.ts` — remove new SSE event handlers and download endpoint
3. Revert shared types and client hook changes
4. `bun install` to ensure clean state

### Rollback Conditions
- Tool use causes SDK errors or crashes
- File download endpoint has security issues
- SSE stream breaks with new event types

## Validation Commands

```bash
# Install dependencies (no new deps)
bun install

# Start dev server (both client + server)
bun run dev

# Verify server responds with tools
curl -X POST http://localhost:3001/api/agent \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Search for the latest AI news and save results to a CSV file"}'

# Verify file download endpoint
# (after agent creates a file, use the session ID from the SSE stream)
# curl http://localhost:3001/api/files/<sessionId>/ai_news.csv -o test.csv

# Verify path traversal prevention
curl -v http://localhost:3001/api/files/../../../etc/passwd

# Verify client loads
open http://localhost:5173
```

## Acceptance Criteria

- [ ] Agent uses WebSearch/WebFetch to find AI news when prompted
- [ ] Agent creates CSV file with structured columns (title, source, url, date, summary)
- [ ] Download button appears inline in chat after file creation
- [ ] Clicking download saves valid CSV to user's machine
- [ ] Tool status line shows "Using {toolName}..." during tool execution
- [ ] `systemPrompt` field accepted in request body and affects agent behavior
- [ ] Path traversal attempts on download endpoint return 400/403
- [ ] All Step 1 functionality still works (streaming, multi-turn, abort, error display, cost)
- [ ] `bun run dev` starts both services without errors

## Dependencies

### New Dependencies
- None — all changes use existing packages

### Dependency Updates
- None

## Notes & Context

### Additional Context
- Step 1 is fully implemented with all files in place
- ANTHROPIC_API_KEY is set in system environment
- This is Step 1.5 of a 5-step assignment — enhances Step 1 without waiting for Step 2's full tool use design
- The primary demo task is: "Fetch the latest AI news from the web and save them into a CSV"

### Assumptions
- The Write tool's `FileWriteOutput` always includes `filePath` (confirmed by SDK type definitions)
- `cwd` reliably sets the subprocess working directory for file operations
- `maxTurns: 10` is sufficient for news search + CSV creation (typical: 3-5 turns)
- `/tmp/duvo-sessions/` is writable and ephemeral (standard for macOS/Linux)
- The Vite proxy already handles `/api/files/*` via the existing `/api` rule

### Constraints
- TypeScript only
- Bun for all JS/TS tooling
- Minimal UI — inline styles, no CSS framework
- No new files — all modifications to existing Step 1 files

### Related Tasks/Issues
- Step 1 plan: `plans/agent-frontend-step1.md`
- Step 1 research: `research/research-agent-frontend-claude-sdk.md`
- Step 1.5 research: `research/research-agent-file-output-download.md`
- Future: Steps 2-5 of the automation platform

### References
- Research document: `research/research-agent-file-output-download.md`
- Claude Agent SDK docs: https://platform.claude.com/docs/en/agent-sdk/typescript
- SDK tool types: `sdk-tools.d.ts` (FileWriteOutput ~line 1979)
- SDK demos: https://github.com/anthropics/claude-agent-sdk-demos
- Hono streaming: https://hono.dev/docs/helpers/streaming

### Open Questions
- [ ] Does `cwd` reliably cause the agent to write files in the session directory? Or does it sometimes use absolute paths outside `cwd`? (Fallback: scan session dir for new files after each tool execution)
- [ ] Should we add a default system prompt when none is provided, or let the agent operate with just the built-in Claude Code system prompt?

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
