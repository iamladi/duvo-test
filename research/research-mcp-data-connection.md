---
date: 2026-03-03
git_commit: 7ab2b169837ed6d049c0498632519d2f5323d5ee
branch: feat/step-3
repository: duvo-test
topic: MCP Data Connection — Simple Free MCP Servers for Agent Data Access
tags: [mcp, data-connection, agent-sdk, filesystem, sqlite]
status: complete
last_updated: 2026-03-03
last_updated_by: research
---

# Research: MCP Data Connection

## Research Question

What is the simplest, free-to-use MCP server we can integrate with the existing duvo-test codebase to demonstrate an agent "connecting" to external data? The user must be able to enable/disable the connection, and it should be visually clear the agent is using this MCP data source.

## Summary

**Recommendation: `@modelcontextprotocol/server-filesystem`** — zero auth, zero external services, pure `npx`, ~268k monthly npm downloads. The agent reads real files from a user-designated directory. Enable/disable is a boolean toggle that adds or removes the `mcpServers` config from `sdkQuery()`.

**Runner-up: `mcp-server-sqlite-npx`** — same zero-auth story but with a seeded `.db` file. More impressive demo (agent writes SQL), slightly more setup.

The SDK already supports MCP natively. The integration point is `sessions.ts:100-129` where `sdkQuery()` is called — adding `mcpServers` to the options object is the entire server-side change.

## Detailed Findings

### 1. Current SDK Integration Point

The agent session is created in `server/src/sessions.ts:88-142`. The `sdkQuery()` call at line 100 accepts an `options` object that already supports:

```
mcpServers?: Record<string, McpServerConfig>
```

This is documented in the existing research at `research/research-agent-frontend-claude-sdk.md:134` and the SDK itself exposes `mcpServerStatus()`, `setMcpServers()`, and `reconnectMcpServer()` methods (same file, line 87).

Current allowed tools (`sessions.ts:104`):
```typescript
allowedTools: ["WebSearch", "WebFetch", "Write", "Bash", "Read"]
```

MCP tools follow the naming pattern `mcp__<server-name>__<tool-name>` and must be added to `allowedTools` for the agent to use them.

### 2. MCP Server Options (Ranked by Demo Quality)

#### Option 1: Filesystem Server (Recommended)

| Attribute | Value |
|---|---|
| Package | `@modelcontextprotocol/server-filesystem` |
| Source | [GitHub](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) |
| Setup | 1/5 — `npx` one-liner, no config files |
| Auth | None |
| npm downloads | ~268,000/month |

**Tools exposed:**
- `read_text_file`, `read_multiple_files` — read file contents
- `list_directory`, `directory_tree` — browse structure
- `search_files` — glob-based search
- `get_file_info` — metadata
- `write_file`, `create_directory`, `move_file` — write ops (can restrict via allowedTools)

**SDK config:**
```typescript
mcpServers: {
  filesystem: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
  }
},
allowedTools: [
  "WebSearch", "WebFetch", "Write", "Bash", "Read",
  "mcp__filesystem__read_text_file",
  "mcp__filesystem__list_directory",
  "mcp__filesystem__directory_tree"
]
```

The directory path is a CLI argument — the server only exposes that directory. No credentials, no external services.

**Why this is best for demo:**
- User picks a directory → agent can browse and read files from it
- Clear "data connection" metaphor — "connect to your project files"
- Toggle is trivial: include/exclude the `mcpServers` key
- Tool calls appear in the observable automation view's step tracker (`step-tracker.ts:120-140` handles `content_block_start` with tool metadata)

#### Option 2: SQLite Server

| Attribute | Value |
|---|---|
| Package | `mcp-server-sqlite-npx` (community Node.js port) |
| Source | [GitHub](https://github.com/johnnyoshika/mcp-server-sqlite-npx) |
| Setup | 2/5 — needs a pre-seeded `.db` file |
| Auth | None |

**SDK config:**
```typescript
mcpServers: {
  sqlite: {
    command: "npx",
    args: ["-y", "mcp-server-sqlite-npx", "/absolute/path/to/database.db"]
  }
}
```

Agent reads schema, writes SQL, returns results. More impressive but requires seed data. The official Anthropic SQLite server is Python/uvx — this is the npx drop-in.

#### Option 3: Memory Server (Knowledge Graph)

| Attribute | Value |
|---|---|
| Package | `@modelcontextprotocol/server-memory` |
| Source | [GitHub](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) |
| Setup | 1/5 |
| Auth | None |

9 tools including `create_entities`, `read_graph`, `search_nodes`. Stores to local `memory.jsonl`. Good for multi-turn memory persistence, less "reading upstream data."

#### Option 4: Fetch Server (Web Data)

| Attribute | Value |
|---|---|
| Package | `mcp-server-fetch` (official, Python/uvx) |
| Setup | 2/5 — requires `uvx` |
| Auth | None |

Fetches URLs and returns content as markdown. Would work but requires Python runtime, conflicting with the project's bun-first approach.

#### Option 5: Everything Server (Test/Demo)

| Attribute | Value |
|---|---|
| Package | `@modelcontextprotocol/server-everything` |
| Setup | 1/5 |
| Auth | None |

Reference server exposing example prompts, resources, and tools. Best for verifying MCP works, not for meaningful data access.

### 3. Integration Architecture

**Server-side changes** — `server/src/sessions.ts`:

The `createSession()` function at line 88 would accept an MCP config parameter. When enabled, the `sdkQuery()` options at line 100-128 include `mcpServers`. When disabled, the key is omitted entirely.

```typescript
// sessions.ts — conceptual integration point (line 100-129)
const q = sdkQuery({
  prompt: queue,
  options: {
    model: "claude-sonnet-4-6",
    allowedTools: [
      "WebSearch", "WebFetch", "Write", "Bash", "Read",
      // MCP tools added conditionally:
      ...(mcpEnabled ? ["mcp__filesystem__read_text_file", "mcp__filesystem__list_directory"] : [])
    ],
    // MCP server added conditionally:
    ...(mcpEnabled ? {
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", targetDir]
        }
      }
    } : {}),
    // ... rest of options
  },
});
```

**Client-side changes:**

The `AgentRequest` type at `shared/src/types/index.ts:5-9` would extend to include MCP connection state. The observable automation view (`client/src/components/ObservableAutomationView.tsx`) would show a toggle for enabling/disabling the connection, and MCP tool calls would appear as steps in the structured state view.

**Visibility:** The step tracker at `server/src/step-tracker.ts:120-140` already handles tool_use blocks — MCP tool calls (`mcp__filesystem__*`) will appear as regular tool steps with the full `mcp__` prefix visible in both the raw SDK event stream (left pane) and the structured state view (right pane).

### 4. Enable/Disable UX

The system prompt (`sessions.ts:79-86`) can be extended to tell the agent about its connected data source:

```
You have access to the user's project files via the filesystem connection.
Use list_directory and read_text_file to explore their data.
```

When disabled, this instruction is removed and the MCP tools are not in `allowedTools`, so the agent physically cannot use them. This makes the enable/disable behavior unambiguous.

## Code References

| File | Lines | What |
|---|---|---|
| `server/src/sessions.ts` | 100-129 | `sdkQuery()` call — integration point for `mcpServers` |
| `server/src/sessions.ts` | 104 | Current `allowedTools` array |
| `server/src/sessions.ts` | 79-86 | System prompt — extend for MCP context |
| `server/src/sessions.ts` | 88 | `createSession()` signature — add MCP params |
| `server/src/step-tracker.ts` | 120-140 | Tool step rendering — MCP tools appear here |
| `shared/src/types/index.ts` | 5-9 | `AgentRequest` type — extend for MCP toggle |
| `client/src/components/ObservableAutomationView.tsx` | 42-250 | Main view — add connection toggle UI |
| `research/research-agent-frontend-claude-sdk.md` | 87 | SDK MCP method references |
| `research/research-agent-frontend-claude-sdk.md` | 134 | `mcpServers` option type |
| `research/research-agent-frontend-claude-sdk.md` | 239-263 | `createSdkMcpServer()` example |

## Architecture Documentation

```
┌─────────────────────────────────────────────────────┐
│ Client (React)                                      │
│                                                     │
│  ┌──────────────┐  ┌────────────────────────────┐   │
│  │ Toggle:      │  │ Observable Automation View  │   │
│  │ [x] Files    │  │                            │   │
│  │ [ ] Database │  │  Left: Raw SDK events      │   │
│  └──────┬───────┘  │  Right: Steps (incl MCP)   │   │
│         │          └────────────────────────────┘   │
└─────────┼───────────────────────────────────────────┘
          │ POST /api/agent { mcpEnabled: true, mcpDir: "..." }
          ▼
┌─────────────────────────────────────────────────────┐
│ Server (Hono)                                       │
│                                                     │
│  sessions.ts:createSession()                        │
│    └─ sdkQuery({ mcpServers: { filesystem: ... } }) │
│         │                                           │
│         ▼                                           │
│  ┌──────────────────────────────────┐               │
│  │ Claude Agent SDK subprocess     │               │
│  │                                  │               │
│  │  Built-in: WebSearch, Write...   │               │
│  │  MCP: mcp__filesystem__*         │──┐            │
│  └──────────────────────────────────┘  │            │
│                                        │            │
│  step-tracker.ts processes tool calls  │            │
│  (MCP tools appear with mcp__ prefix)  │            │
└────────────────────────────────────────┼────────────┘
                                         │
                        ┌────────────────▼──────────┐
                        │ MCP Server (npx subprocess)│
                        │ @modelcontextprotocol/     │
                        │   server-filesystem        │
                        │                            │
                        │ Exposes: /user/chosen/dir  │
                        └────────────────────────────┘
```

## Related Research

- `research/research-agent-frontend-claude-sdk.md` — SDK API reference including MCP methods
- `research/research-observable-automation.md` — Step 3 observable automation architecture

## Open Questions

1. **Directory picker UX**: Should the user type a path, or should we provide a file browser? Typing is simpler for v1.
2. **Multiple connections**: Should the UI support multiple MCP servers simultaneously (e.g., filesystem + SQLite)? The SDK supports `Record<string, McpServerConfig>` so it's trivial technically.
3. **Read-only mode**: Should we restrict filesystem to read-only tools (`read_text_file`, `list_directory`) or allow writes? Read-only is safer for demo.
4. **System prompt injection**: When MCP is enabled, should the system prompt explicitly mention the connection, or let the agent discover tools organically? Explicit is better for demo clarity.
5. **Bunx vs npx**: The project uses bun, but `@modelcontextprotocol/server-filesystem` is typically run via `npx`. Need to verify `bunx` works as a drop-in for MCP server spawning.
