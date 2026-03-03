---
date: 2026-03-03
topic: "Step 1.5: Agent Tool Use (Web Search + CSV Creation) with File Download"
tags: [claude-agent-sdk, tool-use, file-download, sse, streaming, hono, csv, web-search]
status: complete
last_updated: 2026-03-03
last_updated_by: research-team
---

# Research: Agent File Output & Download (Step 1.5)

## Research Question

How to extend the Step 1 streaming chat frontend to support agent tool use (web search + file creation) and let the user download agent-created files? Specifically: the agent executes "Fetch the latest AI news from the web and save them into a CSV" and the user gets a download button in the chat.

## Summary

**Team composition**: 4 researchers — Locator (SDK tool APIs), Analyzer (execution flow + file serving), Pattern Finder (UX patterns + demo code), Web Researcher (external docs). All four completed successfully.

**Key findings**:

1. **Tool names are plain strings**: `allowedTools: ["WebSearch", "WebFetch", "Write", "Bash", "Read"]` — exact strings matching Claude Code built-in tool names. [Locator] [Web Researcher] [Consensus]

2. **Tool use streams in two places**: As `content_block_start/delta/stop` events inside `stream_event` messages (for real-time UI), AND as complete blocks in `assistant` messages. Tool results come back in synthetic `user` messages with `tool_use_result` field. [Analyzer] [Consensus]

3. **File creation is detectable from `FileWriteOutput`**: When the Write tool completes, the `SDKUserMessage.tool_use_result` contains `{ type: "create", filePath: string, content: string }`. Parse this server-side, emit a custom `file_created` SSE event with a download URL. [Analyzer] [Locator]

4. **Per-session output directories**: Set `cwd` to `/tmp/duvo-sessions/<sessionId>/` — the agent writes files there. Serve via `GET /api/files/:sessionId/:filename` with `Content-Disposition: attachment`. [Analyzer]

5. **Tool progress display**: Forward `tool_progress` (periodic elapsed time) and `tool_use_summary` (natural language description) SSE events. Client shows "Searching the web..." spinners and collapsible tool cards. [Pattern Finder] [Web Researcher]

6. **SDK demos provide validated patterns**: `excel-demo` has `ToolUseDisplay` component and `outputFiles` pattern. `simple-chatapp` confirms the `MessageQueue` + `AsyncIterable` approach for tool-enabled agents. [Pattern Finder] [Analyzer]

7. **`bypassPermissions` works with hooks**: Tools auto-execute without prompts. Hooks still fire and can block. Combined with scoped `allowedTools` and `cwd`, blast radius is contained. [Locator] [Web Researcher]

---

## Detailed Findings

### 1. Built-in SDK Tool Names [Locator] [Web Researcher] [Consensus]

The Claude Agent SDK exposes these built-in tools as string identifiers for `allowedTools`:

| Tool String | Purpose | Needed for Step 1.5? |
|---|---|---|
| `"WebSearch"` | Search the web | Yes — find AI news |
| `"WebFetch"` | Fetch URL content + AI summary | Yes — read article details |
| `"Write"` | Create/overwrite files | Yes — save CSV |
| `"Bash"` | Execute shell commands | Yes — fallback data processing |
| `"Read"` | Read files (text, images, PDFs) | Yes — verify output |
| `"Edit"` | String replacement in files | No |
| `"Glob"` | File pattern matching | No |
| `"Grep"` | Content search | No |
| `"Task"` | Launch subagents | No |
| `"NotebookEdit"` | Jupyter notebooks | No |
| `"TodoWrite"` | Task list management | No |
| `"AskUserQuestion"` | Clarifying questions | No |

**Step 1.5 configuration**:
```typescript
allowedTools: ["WebSearch", "WebFetch", "Write", "Bash", "Read"]
```

There are also two distinct options:
- `tools` — defines which tools are *available* (can be `{ type: "preset", preset: "claude_code" }` for all default tools, or an explicit array)
- `allowedTools` — filter on top of `tools` (whitelist approach)

For Step 1.5, using `allowedTools` alone is sufficient — it implicitly makes only those tools available.

Source: SDK type definitions (`sdk-tools.d.ts`), official docs at https://platform.claude.com/docs/en/agent-sdk/typescript

### 2. Tool Execution Message Flow [Analyzer] [Consensus]

When `allowedTools` includes tools and the agent uses them, the SDK message stream follows this sequence:

```
1.  system (init)                    — session_id, tools list, cwd
2.  stream_event (message_start)     — assistant turn begins
3.  stream_event (content_block_start, type: "text")
4.  stream_event (content_block_delta, text_delta)      ← TEXT TOKENS
5.  stream_event (content_block_stop)
6.  stream_event (content_block_start, type: "tool_use") ← TOOL CALL STARTS
    → content_block: { type: "tool_use", id: "toolu_xxx", name: "WebSearch" }
7.  stream_event (content_block_delta, input_json_delta)  ← TOOL INPUT STREAMING
    → delta: { type: "input_json_delta", partial_json: '{"query":"latest AI...' }
8.  stream_event (content_block_stop)                     ← TOOL INPUT COMPLETE
9.  stream_event (message_stop)
10. assistant                         ← COMPLETE message with all content blocks
11. tool_progress                     ← PERIODIC during execution
    → { tool_use_id, tool_name: "WebSearch", elapsed_time_seconds: 2.1 }
12. user                              ← TOOL RESULT (synthetic)
    → { parent_tool_use_id, isSynthetic: true, tool_use_result: {...} }
13. stream_event (message_start)      ← NEXT assistant turn
14. ... (more streaming, possibly more tool calls) ...
15. tool_use_summary                  ← AFTER tool sequence completes
    → { summary: "Searched for 'latest AI news'...", preceding_tool_use_ids: [...] }
16. result                            ← FINAL result with cost
```

**Key insight**: Tool use appears in TWO views:
- **Streaming view** (`stream_event`): `content_block_start` with `type: "tool_use"` → `input_json_delta` deltas → `content_block_stop`. Good for real-time UI ("Agent is searching...").
- **Complete view** (`assistant` message): `message.content` array with full `{ type: "tool_use", id, name, input }` blocks. Good for rendering complete tool cards.

### 3. Tool Result Message Structure [Analyzer] [Locator]

```typescript
type SDKUserMessage = {
  type: 'user';
  message: MessageParam;              // Anthropic API tool_result content blocks
  parent_tool_use_id: string | null;  // Links to the originating tool_use
  isSynthetic?: boolean;              // true for auto-generated tool results
  tool_use_result?: unknown;          // THE STRUCTURED RESULT — typed per tool
  uuid?: UUID;
  session_id: string;
};
```

### 4. File Creation Detection [Analyzer] [Locator] [Consensus]

**Recommended approach**: Parse `SDKUserMessage.tool_use_result` when it's a `FileWriteOutput`:

```typescript
interface FileWriteOutput {
  type: "create" | "update";
  filePath: string;              // Absolute path to created file
  content: string;               // Full file content
  structuredPatch: Array<{
    oldStart: number; oldLines: number;
    newStart: number; newLines: number;
    lines: string[];
  }>;
  originalFile: string | null;   // null for new files
  gitDiff?: { filename: string; status: string; additions: number; deletions: number; changes: number; patch: string; };
}
```

**Detection logic** (server-side, in SSE forwarding loop):
```typescript
if (message.type === "user" && message.tool_use_result) {
  const result = message.tool_use_result as any;
  if (result.filePath && (result.type === "create" || result.type === "update")) {
    const filename = basename(result.filePath);
    // Emit custom SSE event
    await stream.writeSSE({
      event: 'file_created',
      data: JSON.stringify({
        type: 'file_created',
        filename,
        downloadUrl: `/api/files/${sessionId}/${filename}`,
      })
    });
  }
}
```

**Why NOT detect from Bash output**: `BashOutput` has `{ stdout, stderr, interrupted }` — no explicit file path info. If the agent runs `echo "..." > file.csv`, we can't reliably detect it. Mitigation: system prompt instructs "always use the Write tool for file creation."

**Alternative detection**: `SDKFilesPersistedEvent` (`type: "system", subtype: "files_persisted"`) with `files: Array<{ filename, file_id }>`. This fires when files are persisted but may not fire for all Write operations in non-git contexts. [Locator]

### 5. Per-Session Output Directory & `cwd` [Analyzer] [Locator]

The SDK's `cwd` option sets the working directory for the Claude Code subprocess:

```typescript
const SESSION_BASE = '/tmp/duvo-sessions';

function getSessionDir(sessionId: string): string {
  const dir = join(SESSION_BASE, sessionId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// In query():
options: { cwd: getSessionDir(sessionId) }
```

**Important**: `cwd` does NOT enforce a sandbox. The agent can use absolute paths to write anywhere. For Step 1.5 (single-user dev), this is acceptable. For production, use:
- `canUseTool` callback to validate paths stay within session dir
- Or the `sandbox` option for OS-level restrictions

The `SDKSystemMessage` (init) reports back the `cwd`, confirming it was applied.

### 6. File Download Endpoint [Analyzer] [Pattern Finder]

```typescript
import { join, basename, resolve } from 'path';

const SESSION_BASE = '/tmp/duvo-sessions';

app.get('/api/files/:sessionId/:filename', async (c) => {
  const { sessionId, filename } = c.req.param();

  // Path traversal prevention
  if (sessionId.includes('..') || filename.includes('..') ||
      sessionId.includes('/') || filename.includes('/')) {
    return c.json({ error: 'Invalid path' }, 400);
  }

  const filePath = resolve(join(SESSION_BASE, sessionId, filename));
  const expectedBase = resolve(join(SESSION_BASE, sessionId));

  if (!filePath.startsWith(expectedBase)) {
    return c.json({ error: 'Access denied' }, 403);
  }

  const file = Bun.file(filePath);
  if (!await file.exists()) {
    return c.json({ error: 'File not found' }, 404);
  }

  const ext = filename.split('.').pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    csv: 'text/csv',
    txt: 'text/plain',
    json: 'application/json',
  };

  return new Response(file.stream(), {
    headers: {
      'Content-Type': mimeTypes[ext || ''] || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(file.size),
    }
  });
});
```

**Security**: `resolve()` + prefix check prevents path traversal. Session isolation by directory structure.

### 7. SSE Event Extensions for Step 1.5 [Analyzer] [Consensus]

**Step 1 events** (unchanged):

| SSE Event | SDK Message Type | Purpose |
|---|---|---|
| `system` | `SDKSystemMessage` (init) | Session start |
| `stream_event` | `SDKPartialAssistantMessage` | Token streaming |
| `assistant` | `SDKAssistantMessage` | Complete assistant turns |
| `result` | `SDKResultMessage` | Final result with cost |
| `error` | (custom) | Error display |

**New Step 1.5 events**:

| SSE Event | Source | Purpose | Payload |
|---|---|---|---|
| `tool_progress` | `SDKToolProgressMessage` | Tool execution spinner | `{ tool_use_id, tool_name, elapsed_time_seconds }` |
| `tool_use_summary` | `SDKToolUseSummaryMessage` | What tool did | `{ summary }` |
| `tool_result` | `SDKUserMessage` (synthetic) | Tool completion signal | `{ parent_tool_use_id, tool_name, success }` |
| `file_created` | Server-generated | Download button trigger | `{ filename, downloadUrl }` |

**Tool use detection already works** via existing `stream_event` forwarding — client can detect `content_block_start` with `content_block.type === "tool_use"` and show tool name immediately.

### 8. Tool Progress & Summary Display [Pattern Finder] [Web Researcher]

**`SDKToolProgressMessage`**:
```typescript
{
  type: 'tool_progress',
  tool_use_id: string,
  tool_name: string,             // "WebSearch", "Write", "Bash"
  parent_tool_use_id: string | null,
  elapsed_time_seconds: number,  // How long running
  task_id?: string,
  uuid: UUID,
  session_id: string
}
```

Fires periodically during long-running tool execution. Use for "Searching the web... (3s)" spinner.

**`SDKToolUseSummaryMessage`**:
```typescript
{
  type: 'tool_use_summary',
  summary: string,                    // e.g., "Searched for 'latest AI news March 2026' and found 10 results"
  preceding_tool_use_ids: string[],
  uuid: UUID,
  session_id: string
}
```

Fires after tool sequences complete. Display as a subtle summary line in the chat.

### 9. Frontend Component Patterns [Pattern Finder]

**ToolUseDisplay** (from SDK's `excel-demo`):
- Color-coded left border per tool category (cyan=web, amber=file write, violet=bash)
- Collapsed by default with tool name + first parameter preview
- Expandable to show all parameters
- Icon + tool name + description header

```tsx
function ToolUseDisplay({ toolUse }: { toolUse: ToolUseBlock }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const metadata = getToolMetadata(toolUse.name); // icon, color, description

  return (
    <div className="my-2 border-l-4 rounded-md" style={{ borderLeftColor: metadata.color }}>
      <div className="bg-gray-50 px-3 py-2 cursor-pointer" onClick={() => setIsExpanded(!isExpanded)}>
        <div className="flex items-center gap-2">
          <span>{metadata.icon}</span>
          <span className="font-medium">{toolUse.name}</span>
        </div>
        {!isExpanded && <div className="text-xs text-gray-600 truncate">{previewText}</div>}
      </div>
      {isExpanded && <div className="p-3">{/* full parameters */}</div>}
    </div>
  );
}
```

**Tool metadata mapping**:
| Tool | Icon | Color | Description |
|---|---|---|---|
| `WebSearch` | Globe | Cyan | "Web Search" |
| `WebFetch` | Link | Cyan | "Fetch URL" |
| `Write` | Pencil | Amber | "File Write" |
| `Bash` | Terminal | Violet | "Shell Command" |
| `Read` | Eye | Blue | "File Read" |

**FileDownload component**:
```tsx
function FileDownload({ file }: { file: { filename: string; downloadUrl: string } }) {
  return (
    <div className="mt-3 pt-3 border-t border-gray-200">
      <div className="flex items-center justify-between p-2 bg-gray-50 rounded">
        <span>{file.filename}</span>
        <a href={file.downloadUrl} download className="px-3 py-1 bg-blue-500 text-white rounded text-sm">
          Download
        </a>
      </div>
    </div>
  );
}
```

**State management for tool execution**:
```typescript
interface StreamState {
  messages: ChatMessage[];
  activeTools: Map<string, { id: string; name: string; inputJson: string }>;
  createdFiles: Array<{ filename: string; downloadUrl: string }>;
  isStreaming: boolean;
}
```

### 10. Agent Configuration for "Fetch AI News → Save CSV" [Analyzer]

```typescript
function createAgentQuery(sessionId: string, prompt: AsyncIterable<SDKUserMessage>) {
  const sessionDir = getSessionDir(sessionId);

  return query({
    prompt,
    options: {
      model: 'claude-sonnet-4-6',
      cwd: sessionDir,
      maxTurns: 10,
      includePartialMessages: true,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      allowedTools: ['WebSearch', 'WebFetch', 'Write', 'Bash', 'Read'],
      systemPrompt: `You are an AI research assistant. When asked to find news or information:
1. Use WebSearch to find relevant, recent articles
2. Use WebFetch to get details from promising sources
3. Compile results into a structured CSV file using the Write tool
4. Always use absolute file paths based on your current working directory
5. CSV files should have headers and be well-formatted
6. After saving, confirm the filename and summarize what was saved

When creating CSV files, always include these columns at minimum:
- title: Article title
- source: Publication/website name
- url: Article URL
- date: Publication date
- summary: Brief summary of the article`,
    }
  });
}
```

**Why `maxTurns: 10`**: Typical task flow is WebSearch → WebFetch (×2-3) → Write → confirm = 3-5 turns. 10 gives room for thorough research.

**Cost estimate**: `claude-sonnet-4-6` with this task: ~$0.05-0.15 per query. Optional: `maxBudgetUsd: 0.50` to cap.

### 11. Permission Model [Locator] [Web Researcher]

| Mode | Behavior |
|---|---|
| `"default"` | Unmatched tools trigger `canUseTool` callback |
| `"acceptEdits"` | Auto-approves file edits and safe filesystem Bash commands |
| `"bypassPermissions"` | Auto-approves ALL tools (requires `allowDangerouslySkipPermissions: true`) |
| `"plan"` | No tool execution |
| `"dontAsk"` | Deny if not pre-approved |

**For Step 1.5**: `bypassPermissions` is correct because:
- Headless server — no interactive permission prompts possible
- `allowedTools` scopes which tools can execute
- `cwd` scopes file output location
- Hooks still fire and can block if needed
- Single-user dev environment (no multi-tenant security concerns)

### 12. Updated SSE Forwarding Logic [Analyzer] [Consensus]

```typescript
for await (const message of agentQuery) {
  switch (message.type) {
    // Step 1 events (unchanged)
    case 'system':
    case 'stream_event':
    case 'assistant':
    case 'result':
      await stream.writeSSE({ event: message.type, data: JSON.stringify(message) });
      break;

    // Step 1.5 additions
    case 'tool_progress':
      await stream.writeSSE({
        event: 'tool_progress',
        data: JSON.stringify({
          type: 'tool_progress',
          tool_use_id: message.tool_use_id,
          tool_name: message.tool_name,
          elapsed_time_seconds: message.elapsed_time_seconds,
        })
      });
      break;

    case 'tool_use_summary':
      await stream.writeSSE({
        event: 'tool_use_summary',
        data: JSON.stringify({ type: 'tool_use_summary', summary: message.summary })
      });
      break;

    case 'user':
      if (message.isSynthetic && message.tool_use_result) {
        const result = message.tool_use_result as any;

        // Detect file creation
        if (result.filePath && (result.type === 'create' || result.type === 'update')) {
          const filename = basename(result.filePath);
          await stream.writeSSE({
            event: 'file_created',
            data: JSON.stringify({
              type: 'file_created', filename,
              downloadUrl: `/api/files/${sessionId}/${filename}`,
            })
          });
        }

        // Forward sanitized tool result (omit full content)
        await stream.writeSSE({
          event: 'tool_result',
          data: JSON.stringify({
            type: 'tool_result',
            parent_tool_use_id: message.parent_tool_use_id,
            success: !result.error,
          })
        });
      }
      break;

    // Ignore: status, rate_limit, hook_*, compact_boundary, etc.
  }
}
```

### 13. Updated Shared Types [Analyzer]

```typescript
// shared/src/types/index.ts — Step 1.5 extensions

export type AgentRequest = {
  prompt: string;
  sessionId?: string;
};

export type AgentSSEEvent =
  // Step 1 events (unchanged)
  | { type: "system"; subtype: "init"; session_id: string }
  | { type: "stream_event"; event: {
      type: string;
      index?: number;
      content_block?: { type: string; id?: string; name?: string; text?: string };
      delta?: { type: string; text?: string; partial_json?: string };
    }}
  | { type: "assistant"; message: { content: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: unknown }
    >}}
  | { type: "result"; subtype: string; result?: string; total_cost_usd: number;
      duration_ms: number; num_turns: number; usage: {
        input_tokens: number; output_tokens: number;
        cache_creation_input_tokens: number; cache_read_input_tokens: number;
      }}
  | { type: "error"; message: string }

  // Step 1.5 events (NEW)
  | { type: "tool_progress"; tool_use_id: string; tool_name: string; elapsed_time_seconds: number }
  | { type: "tool_use_summary"; summary: string }
  | { type: "tool_result"; parent_tool_use_id: string; tool_name?: string; success: boolean }
  | { type: "file_created"; filename: string; downloadUrl: string };
```

---

## Code References

### SDK Package
- npm: `@anthropic-ai/claude-agent-sdk@0.2.63`
- GitHub: https://github.com/anthropics/claude-agent-sdk-typescript
- Type definitions: `sdk.d.ts` (`SDKToolProgressMessage` ~line 2105, `SDKToolUseSummaryMessage` ~line 2116, `SDKUserMessage` ~line 2124, `SDKFilesPersistedEvent` ~line 1695)
- Tool types: `sdk-tools.d.ts` (`FileWriteOutput` ~line 1979, `BashOutput` ~line 1858, `WebSearchOutput` ~line 2191)

### Official Demos
- `claude-agent-sdk-demos/simple-chatapp` — MessageQueue + AsyncIterable pattern, tool_use extraction
- `claude-agent-sdk-demos/excel-demo` — `ToolUseDisplay` component, `outputFiles` download pattern, `toolMetadata` mapping
- `claude-agent-sdk-demos/email-agent` — Per-tool renderers, WebSocket streaming alternative
- `claude-agent-sdk-demos/research-agent` — Multi-agent with SubagentTracker, `allowedTools` per agent

### Documentation
- SDK overview: https://platform.claude.com/docs/en/agent-sdk/overview
- TypeScript API: https://platform.claude.com/docs/en/agent-sdk/typescript
- Permissions: https://platform.claude.com/docs/en/agent-sdk/permissions
- Hono streaming: https://hono.dev/docs/helpers/streaming
- Hono static files: https://hono.dev/docs/getting-started/bun#serve-static-files

---

## Architecture Documentation

### Step 1.5 Architecture Overview

```
Browser (React + Vite)
    │
    │  POST /api/agent { prompt, sessionId? }
    │  ← SSE stream (text/event-stream)
    │     events: system, stream_event, assistant, result
    │             tool_progress, tool_use_summary, tool_result, file_created  ← NEW
    │
    │  GET /api/files/:sessionId/:filename                                   ← NEW
    │  ← File download (Content-Disposition: attachment)
    │
Bun Server (Hono)
    │
    │  query({ prompt, options: { allowedTools, cwd, ... } })
    │  ← AsyncGenerator<SDKMessage>
    │
    │  Detects FileWriteOutput → emits file_created SSE event
    │  Serves files from /tmp/duvo-sessions/:sessionId/
    │
Claude Agent SDK
    │
    │  Subprocess with tools: WebSearch, WebFetch, Write, Bash, Read
    │  cwd: /tmp/duvo-sessions/:sessionId/
    │
Claude API
```

### Changes from Step 1

| Area | Step 1 | Step 1.5 |
|---|---|---|
| `allowedTools` | `[]` | `["WebSearch", "WebFetch", "Write", "Bash", "Read"]` |
| `maxTurns` | `1` | `10` |
| `cwd` | (default) | `/tmp/duvo-sessions/<sessionId>/` |
| `systemPrompt` | (none) | News research instructions |
| SSE events forwarded | 4 types | 8 types (+tool_progress, tool_use_summary, tool_result, file_created) |
| New endpoint | — | `GET /api/files/:sessionId/:filename` |
| New UI components | — | `ToolUseDisplay`, `FileDownload` |

### Data Flow: "Fetch AI News → Save CSV → Download"

1. User types "Fetch the latest AI news from the web and save them into a CSV"
2. Frontend POSTs to `/api/agent`
3. Server creates query with `allowedTools` and per-session `cwd`
4. Agent decides to use `WebSearch` → SSE: `stream_event (tool_use: WebSearch)` → UI shows "Searching..."
5. Agent calls `WebSearch("latest AI news March 2026")` → SSE: `tool_progress` → UI shows elapsed time
6. Search results return → Agent decides to `WebFetch` top articles → SSE: tool events
7. Agent compiles results → calls `Write` to save CSV → SSE: `stream_event (tool_use: Write)`
8. Write tool completes → `SDKUserMessage` with `FileWriteOutput` → Server detects file creation
9. Server emits `file_created` SSE event: `{ filename: "ai_news.csv", downloadUrl: "/api/files/:sid/ai_news.csv" }`
10. Frontend renders download button inline in the chat message
11. Agent confirms: "I've saved 15 AI news articles to ai_news.csv" → SSE: `stream_event (text_delta)`
12. `result` event with cost → UI shows cost/usage
13. User clicks "Download" → browser hits `GET /api/files/:sid/ai_news.csv` → file downloads

---

## Related Research

- `research/research-agent-frontend-claude-sdk.md` — Base SDK API research for Step 1
- `research/research-step1.5-tool-execution-analysis.md` — Analyzer's detailed tool execution flow analysis
- Claude Agent SDK demos: https://github.com/anthropics/claude-agent-sdk-demos
- Hono SSE helper: https://hono.dev/docs/helpers/streaming

---

## Open Questions

1. **Bash-created files**: If the agent uses `echo "..." > file.csv` via Bash instead of Write, file detection fails. Mitigation: system prompt instructs "always use Write tool." Is this reliable enough?

2. **Session directory cleanup**: When to delete `/tmp/duvo-sessions/<sessionId>/`? Options: on session close, after TTL (e.g., 1 hour), manual. Defer to later step?

3. **Multiple files per session**: Should we support listing all session files? Or just the ones emitted via `file_created` events? Per-file download buttons are sufficient for Step 1.5.

4. **File size limits**: The Write tool has no built-in limit. A news CSV is typically <1MB. Should we cap at some limit for safety?

5. **Streaming input mode compatibility**: Step 1 uses streaming input mode for multi-turn. Does tool use work correctly with streaming input mode, or does each tool-using turn need a fresh `query()`?

6. **`SDKFilesPersistedEvent` reliability**: Is `files_persisted` emitted for all Write operations, or only in git-tracked directories? If reliable, it's a cleaner detection mechanism than parsing `tool_use_result`.
