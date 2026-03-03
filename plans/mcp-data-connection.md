---
title: "MCP Data Connection — Filesystem"
type: Feature
issue: null
research: [research/research-mcp-data-connection.md]
status: Draft
reviewed: false
reviewers: []
created: 2026-03-03
---

# PRD: MCP Data Connection — Filesystem

## Metadata
- **Type**: Feature
- **Priority**: High
- **Estimated Complexity**: 4
- **Created**: 2026-03-03
- **Status**: Draft

## Overview

### Problem Statement
The agent currently operates in isolation — it can search the web and write files, but cannot read data from the user's own systems. Step 4 of the duvo-test progression requires demonstrating that an agent can "connect" to a user's data source via MCP, and that this connection is visually observable and toggleable.

### Goals & Objectives
1. Agent can read files from a user-specified directory via the filesystem MCP server
2. User can enable/disable the connection via a connection card UI before starting a session
3. MCP tool calls are visually distinguished from built-in tools in the step view
4. A pre-seeded demo dataset ships with the project for immediate demonstration

### Success Metrics
- **Primary**: Agent successfully calls `mcp__filesystem__*` tools and returns data from the connected directory
- **Quality Gates**: Connection toggle works, MCP badge appears on tool steps, pre-seeded data loads correctly

## User Stories

### Story 1: Connect to my files
- **As a**: duvo-test user
- **I want**: to point the agent at a directory on my machine
- **So that**: the agent can read and analyze my files
- **Acceptance Criteria**:
  - [ ] Connection card shows above the input area
  - [ ] I can type a directory path or use the pre-seeded default
  - [ ] Agent can list and read files from that directory

### Story 2: See the agent using my data
- **As a**: duvo-test user
- **I want**: to clearly see when the agent is reading from my connected data
- **So that**: I understand which data sources the agent is accessing
- **Acceptance Criteria**:
  - [ ] MCP tool steps show a "Filesystem" badge in the step view
  - [ ] Tool name displays as the full `mcp__filesystem__*` name
  - [ ] Connection card shows connected/disconnected status

### Story 3: Disconnect my data
- **As a**: duvo-test user
- **I want**: to disable the filesystem connection
- **So that**: the agent can no longer access my files
- **Acceptance Criteria**:
  - [ ] Toggling off removes MCP tools from the agent's capabilities
  - [ ] Starting a new session without the connection means no filesystem tools available

## Requirements

### Functional Requirements
1. **FR-1**: Add `mcpServers` config to `sdkQuery()` when filesystem connection is enabled
   - Details: Pass `@modelcontextprotocol/server-filesystem` config with user-specified directory path
   - Priority: Must Have

2. **FR-2**: Extend `AgentRequest` to carry MCP connection state
   - Details: Add `mcpConnection?: { enabled: boolean; path: string }` to the request body
   - Priority: Must Have

3. **FR-3**: Connection card component above the input area
   - Details: Shows connected/disconnected state, path input, connect/disconnect button
   - Priority: Must Have

4. **FR-4**: MCP badge on tool steps
   - Details: Steps where `toolName` starts with `mcp__` show a small badge (e.g., "Filesystem")
   - Priority: Must Have

5. **FR-5**: Pre-seeded demo data directory
   - Details: Ship 3-4 sample files in a known location, used as default path
   - Priority: Must Have

6. **FR-6**: Read-only filesystem tools only
   - Details: Only allow `read_text_file`, `read_multiple_files`, `list_directory`, `directory_tree`, `search_files`, `get_file_info` — no write tools
   - Priority: Must Have

### Non-Functional Requirements
1. **NFR-1**: Performance
   - Requirement: MCP server startup should not noticeably delay session creation
   - Target: <2s overhead for MCP subprocess spawn
   - Measurement: Manual observation

### Technical Requirements
- **Stack**: Same as existing (Hono + Bun server, React client, shared types)
- **Dependencies**: `@modelcontextprotocol/server-filesystem` (npm, run via `npx`)
- **Architecture**: MCP server spawned as subprocess by Claude Agent SDK — no direct management needed
- **API Contracts**: Extended `AgentRequest` type with optional `mcpConnection` field

## Scope

### In Scope
- Filesystem MCP server integration via SDK `mcpServers` option
- Connection card UI component (above input, styled card)
- MCP badge on tool steps in `StepItem`
- Pre-seeded demo data directory with sample files
- Per-session connection persistence (set once, active for session lifetime)

### Out of Scope
- Multiple simultaneous MCP connections
- SQLite or other MCP server types
- File browser / directory picker UI (text input only)
- Write operations via MCP
- System prompt changes (organic discovery)
- E2E tests

### Future Considerations
- Multiple MCP server support (the SDK supports `Record<string, McpServerConfig>`)
- Connection management panel with saved connections
- MCP server health monitoring via `mcpServerStatus()`

## Impact Analysis

### Affected Areas
- `server/src/sessions.ts` — `createSession()` gains MCP config
- `server/src/index.ts` — passes MCP config from request body to session
- `shared/src/types/index.ts` — extended `AgentRequest` type
- `client/src/hooks/useAgentView.ts` — sends MCP config with requests
- `client/src/components/ObservableAutomationView.tsx` — connection card + state
- `client/src/components/StepItem.tsx` — MCP badge rendering

### System Impact
- **Performance**: MCP server subprocess adds ~1-2s to first session creation (npx install + spawn). Subsequent sessions within same server process may reuse npm cache.
- **Security**: Filesystem server is sandboxed to the specified directory by the MCP server itself. Read-only tools only.
- **Data Integrity**: No writes to user files. Agent reads only.

### Dependencies
- **Upstream**: `@modelcontextprotocol/server-filesystem` npm package
- **External**: `npx` must be available in PATH (standard with Node.js)

### Breaking Changes
- [x] **None** — additive change, existing API contract unchanged (new field is optional)

## Solution Design

### Approach

**Server-side** (`sessions.ts`):
- `createSession()` accepts an optional `mcpConnection` parameter
- When enabled, adds `mcpServers.filesystem` to `sdkQuery()` options with `command: "npx"` and `args: ["-y", "@modelcontextprotocol/server-filesystem", path]`
- Adds read-only MCP tool names to `allowedTools`: `mcp__filesystem__read_text_file`, `mcp__filesystem__read_multiple_files`, `mcp__filesystem__list_directory`, `mcp__filesystem__directory_tree`, `mcp__filesystem__search_files`, `mcp__filesystem__get_file_info`

**Shared types** (`types/index.ts`):
- Add `mcpConnection?: { enabled: boolean; path: string }` to `AgentRequest`

**Server route** (`index.ts`):
- Pass `body.mcpConnection` through to `createSession()`

**Client hook** (`useAgentView.ts`):
- Accept MCP connection state and include in fetch body
- Expose MCP state for the view to manage

**Client UI** (`ObservableAutomationView.tsx`):
- Add connection card component above the input area
- Card shows: connection status indicator (dot), path input, connect/disconnect button
- Card state stored as local `useState` — persists for session lifetime
- Pass MCP config to `sendMessage()` which includes it in the request body

**Step badge** (`StepItem.tsx`):
- In `stepLabel()`, detect `mcp__` prefix on `toolName`
- Extract server name (e.g., "filesystem") and show as a small badge/tag

**Demo data**:
- Create `demo-data/` directory at project root with 3-4 sample files
- Default path in connection card points to this directory (relative, resolved server-side)

### Alternatives Considered
1. **SQLite MCP server**
   - Pros: More impressive demo (agent writes SQL)
   - Cons: Requires pre-seeded `.db` file, more setup complexity
   - Why rejected: User chose filesystem for simplicity

2. **System prompt injection for MCP awareness**
   - Pros: Agent reliably uses MCP tools first
   - Cons: Less realistic — real agents discover tools organically
   - Why rejected: User chose organic discovery

3. **Settings panel for connections**
   - Pros: Cleaner separation, extensible
   - Cons: More navigation, heavier implementation
   - Why rejected: User chose connection card above input for visibility

### API Changes

**Extended `AgentRequest`**:
```typescript
export type AgentRequest = {
  prompt: string;
  sessionId?: string;
  systemPrompt?: string;
  mcpConnection?: {
    enabled: boolean;
    path: string;
  };
};
```

### UI/UX Changes

Connection card above input area:
```
┌─────────────────────────────────────────────────┐
│ 🟢 Filesystem Connected                        │
│ Path: [/path/to/demo-data          ] [Disconnect]│
└─────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────┐
│ [Type a message...                    ] [Send]  │
└─────────────────────────────────────────────────┘
```

When disconnected:
```
┌─────────────────────────────────────────────────┐
│ ⚪ Filesystem Disconnected                      │
│ Path: [/path/to/demo-data          ] [Connect]  │
└─────────────────────────────────────────────────┘
```

MCP badge on step items:
```
✓ mcp__filesystem__list_directory [Filesystem]  0.8s
```

## Implementation Plan

### Phase 1: Types, Demo Data & Server Integration
**Complexity**: 2 | **Priority**: High

- [ ] Extend `AgentRequest` in `shared/src/types/index.ts` with `mcpConnection` field
- [ ] Create `demo-data/` directory with 3-4 sample files (e.g., `sales.csv`, `notes.md`, `config.json`)
- [ ] Update `createSession()` in `server/src/sessions.ts` to accept and apply MCP config
- [ ] Update `POST /api/agent` in `server/src/index.ts` to pass `mcpConnection` through
- [ ] Install `@modelcontextprotocol/server-filesystem` as a dependency (or rely on `npx -y`)

### Phase 2: Client Integration
**Complexity**: 3 | **Priority**: High

- [ ] Add connection card component in `ObservableAutomationView.tsx` (above input area)
- [ ] Add MCP connection state management (`useState` for enabled + path)
- [ ] Pass MCP config from view → `useAgentView` hook → fetch body
- [ ] Update `sendMessage()` in `useAgentView.ts` to include `mcpConnection` in `AgentRequest`
- [ ] Add MCP badge to `StepItem.tsx` for `mcp__` prefixed tool names

### Phase 3: Manual Testing & Polish
**Complexity**: 1 | **Priority**: Medium

- [ ] Verify MCP server starts and agent can list/read demo-data files
- [ ] Verify connection card toggle works (enable → tools available, disable → tools gone)
- [ ] Verify MCP badge appears on filesystem tool steps
- [ ] Verify disabled connection means no MCP tools in session

## Relevant Files

### Existing Files
- `server/src/sessions.ts` — `createSession()` at line 88, `sdkQuery()` options at line 100-128
- `server/src/index.ts` — `POST /api/agent` route at line 89, passes body to `createSession()` at line 110
- `shared/src/types/index.ts` — `AgentRequest` at line 5-9
- `client/src/hooks/useAgentView.ts` — `sendMessage()` at line 469, fetch body at line 482-485
- `client/src/components/ObservableAutomationView.tsx` — input area at line 182-248
- `client/src/components/StepItem.tsx` — `stepLabel()` at line 33-44, trigger UI at line 107-139
- `server/src/step-tracker.ts` — `content_block_start` handling at line 120-140 (already passes `toolName`)

### New Files
- `demo-data/sales.csv` — sample CSV with a few rows of data
- `demo-data/notes.md` — sample markdown notes
- `demo-data/config.json` — sample JSON config
- `demo-data/README.md` — explains the demo data purpose

### Test Files
- None (out of scope per user decision)

## Testing Strategy

### Manual Test Cases
1. **Test Case: Happy path — read demo data**
   - Steps: Enable connection with default path → ask "what files are available?" → verify agent lists demo-data contents
   - Expected: Agent calls `mcp__filesystem__list_directory`, returns file list

2. **Test Case: Disable connection**
   - Steps: Toggle connection off → start new prompt → verify no MCP tools used
   - Expected: Agent cannot call filesystem tools, uses only built-in tools

3. **Test Case: Custom path**
   - Steps: Type a real directory path → enable → ask about files
   - Expected: Agent reads files from the specified directory

4. **Test Case: Badge visibility**
   - Steps: With connection enabled, trigger a filesystem tool call
   - Expected: Step item shows "Filesystem" badge next to tool name

## Risk Assessment

### Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| `npx` not in PATH on some systems | Low | Medium | Document requirement; could fall back to `bunx` |
| MCP server startup latency | Medium | Low | First call takes ~2s for npx install; acceptable for demo |
| MCP tool naming mismatch | Low | High | Verify actual tool names from `@modelcontextprotocol/server-filesystem` before implementation |

## Rollback Strategy

### Rollback Steps
1. Revert the commit — all changes are additive
2. No database or persistent state changes to undo

### Rollback Conditions
- MCP server fails to spawn reliably
- Tool naming convention doesn't match `mcp__<server>__<tool>` pattern

## Validation Commands

```bash
# Build check
cd server && bun run build
cd client && bun run build

# Start dev servers
bun run dev

# Manual: open localhost:5173, enable connection, ask about files
```

## Acceptance Criteria

- [ ] Connection card renders above input with path field and connect/disconnect button
- [ ] Enabling connection adds filesystem MCP server to agent session
- [ ] Agent can list and read files from the connected directory
- [ ] Disabling connection removes MCP tools from agent capabilities
- [ ] MCP tool steps show a "Filesystem" badge in the step view
- [ ] Pre-seeded demo-data directory ships with sample files
- [ ] No regressions in existing chat/streaming functionality

## Dependencies

### New Dependencies
- `@modelcontextprotocol/server-filesystem` — run via `npx -y`, not installed as project dependency (runtime-only)

## Notes & Context

### Assumptions
- `npx` is available in the system PATH (standard with Node.js)
- The SDK's `mcpServers` option spawns and manages the MCP subprocess lifecycle automatically
- MCP tool names follow the `mcp__<serverName>__<toolName>` pattern
- The filesystem MCP server accepts directory path as CLI argument and sandboxes access to that directory

### Constraints
- Read-only tools only — no `write_file`, `create_directory`, `move_file`
- Per-session connection (cannot change mid-session)
- Single MCP server only (filesystem)

### References
- Research: `research/research-mcp-data-connection.md`
- SDK MCP docs: `research/research-agent-frontend-claude-sdk.md` lines 87, 134, 239-263
- MCP server source: https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem

### Open Questions
- [x] Which MCP server? → Filesystem
- [x] Toggle UX? → Connection card above input
- [x] Read-only? → Yes
- [x] Per-session or per-message? → Per-session
- [x] System prompt mention? → No, organic discovery
- [x] Visual distinction? → Badge/tag on step
- [x] Demo data? → Pre-seeded default + custom path
- [ ] Does `bunx` work as drop-in for `npx` to spawn MCP servers? Verify during implementation.

## Blindspot Review

**Reviewers**: Not yet reviewed
**Date**: —
**Plan Readiness**: Draft
