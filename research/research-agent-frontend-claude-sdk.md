---
date: 2026-03-03
topic: "Lightweight agent frontend with Claude Agent SDK, React+Vite, streaming"
tags: [claude-agent-sdk, react, vite, bun, hono, sse, streaming, typescript]
status: complete
last_updated: 2026-03-03
last_updated_by: research-team
---

# Research: Lightweight Agent Frontend with Claude Agent SDK

## Research Question

How to build a full-stack agent frontend (Step 1 of 5) that:
- Accepts user instructions via a minimal React UI
- Sends them to a Bun backend using the Claude Agent SDK
- Streams responses back in real-time via SSE

## Summary

**Team composition**: 4 researchers — Locator (SDK package discovery), Analyzer (API internals), Pattern Finder (architecture patterns), Web Researcher (external docs/examples). All four completed successfully.

**Key findings**:

1. **Package**: `@anthropic-ai/claude-agent-sdk` v0.2.63 (npm). Renamed from `@anthropic-ai/claude-code-sdk`. No runtime dependencies; peer dep on `zod@^4`.
2. **API**: V1 `query()` is stable and returns an `AsyncGenerator<SDKMessage>`. V2 session-based API exists but is marked unstable.
3. **Streaming**: Set `includePartialMessages: true` to get token-level `stream_event` messages containing `content_block_delta` with `text_delta` — this is how we stream to the frontend.
4. **Backend**: Hono on Bun with `streamSSE` helper is the recommended approach. Raw `Bun.serve` with `ReadableStream` also works.
5. **Frontend**: React + Vite. Use `fetch()` + `ReadableStream` reader for POST-based SSE consumption (native `EventSource` only supports GET).
6. **Project structure**: Bun workspaces monorepo — `client/` (Vite+React), `server/` (Bun+Hono), `shared/` (types). The `bhvr` template scaffolds this exact setup.
7. **Environment**: `ANTHROPIC_API_KEY` is already set in the system environment.

---

## Detailed Findings

### 1. Claude Agent SDK Package [Locator] [Consensus]

| Field | Value |
|-------|-------|
| Package | `@anthropic-ai/claude-agent-sdk` |
| Version | `0.2.63` (stable), `0.2.64` (next) |
| Published | 2026-02-28 |
| Entry | `sdk.mjs` (ESM only, `"type": "module"`) |
| Types | `sdk.d.ts` |
| Peer dep | `zod@^4.0.0` |
| Runtime deps | None |
| Engine | Node >= 18 |
| Repo | https://github.com/anthropics/claude-agent-sdk-typescript |
| Docs | https://platform.claude.com/docs/en/agent-sdk/overview |
| Demos | https://github.com/anthropics/claude-agent-sdk-demos |

The package was renamed from `@anthropic-ai/claude-code-sdk`. A migration guide exists at https://platform.claude.com/docs/en/agent-sdk/migration-guide.

The Anthropic SDK (`@anthropic-ai/sdk`) is **not** a listed dependency — its types (`BetaMessage`, `BetaRawMessageStreamEvent`) are used at build time only.

### 2. Core API: V1 `query()` [Analyzer] [Consensus]

The primary function returns an `AsyncGenerator<SDKMessage, void>` with additional control methods.

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt: "Your instruction here",
  options: {
    allowedTools: ["Read", "Edit", "Bash"],
    permissionMode: "acceptEdits",
    model: "claude-opus-4-6",
    includePartialMessages: true,
  }
});

for await (const message of q) {
  // Process messages as they stream
}
```

**Query object methods** (beyond async iteration):
- `interrupt()` — stop current execution
- `close()` — terminate the subprocess
- `setModel(model)` — change model mid-session
- `setPermissionMode(mode)` — change permissions
- `streamInput(stream)` — feed additional messages for multi-turn
- `initializationResult()` — get session metadata
- `supportedModels()` / `supportedCommands()` / `supportedAgents()`
- `mcpServerStatus()` / `setMcpServers()` / `reconnectMcpServer()`
- `rewindFiles(userMessageId, opts)` — file checkpointing
- `stopTask(taskId)` — stop a running task

### 3. Core API: V2 Session-based (unstable preview) [Analyzer] [Web Researcher]

Cleaner API for multi-turn conversations, but marked unstable.

```typescript
import { unstable_v2_createSession } from "@anthropic-ai/claude-agent-sdk";

await using session = unstable_v2_createSession({ model: "claude-opus-4-6" });
await session.send("Hello!");
for await (const msg of session.stream()) {
  // Process messages
}
```

One-shot convenience:
```typescript
import { unstable_v2_prompt } from "@anthropic-ai/claude-agent-sdk";
const result = await unstable_v2_prompt("Question?", { model: "claude-opus-4-6" });
```

**Note**: V2 gives complete `AssistantMessage`s, not partial deltas. For token-by-token streaming, V1 with `includePartialMessages: true` is what we need.

### 4. Options Reference [Locator] [Analyzer] [Consensus]

```typescript
type Options = {
  model?: string;                    // e.g. "claude-opus-4-6"
  systemPrompt?: string | { type: "preset"; preset: "claude_code"; append?: string };
  tools?: string[] | { type: "preset"; preset: "claude_code" };
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";
  allowDangerouslySkipPermissions?: boolean;
  maxTurns?: number;
  maxBudgetUsd?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
  executable?: "bun" | "deno" | "node";
  includePartialMessages?: boolean;  // CRITICAL for streaming
  abortController?: AbortController;
  resume?: string;                   // session ID to resume
  sessionId?: string;
  persistSession?: boolean;
  mcpServers?: Record<string, McpServerConfig>;
  agents?: Record<string, AgentDefinition>;
  canUseTool?: CanUseTool;           // permission callback
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  thinking?: ThinkingConfig;
  effort?: "low" | "medium" | "high" | "max";
  outputFormat?: { type: "json_schema"; schema: JSONSchema };
  settingSources?: ("user" | "project" | "local")[];
  sandbox?: SandboxSettings;
  continue?: boolean;
  forkSession?: boolean;
  promptSuggestions?: boolean;
};
```

### 5. Streaming Mechanism [Analyzer] [Pattern Finder] [Consensus]

The SDK uses a **child process + JSON-over-stdio** pattern internally. `query()` spawns a Claude Code subprocess and communicates via stdin/stdout with newline-delimited JSON.

**SDKMessage types** (what the async generator yields):

| Type | `type` field | When emitted |
|------|-------------|--------------|
| `SDKSystemMessage` | `"system"` | First message — session_id, tools, model |
| `SDKAssistantMessage` | `"assistant"` | Complete assistant turns |
| `SDKPartialAssistantMessage` | `"stream_event"` | Token-by-token streaming (requires `includePartialMessages: true`) |
| `SDKUserMessage` | `"user"` | Tool results flowing back |
| `SDKResultMessage` | `"result"` | Final result with cost, usage, duration |
| `SDKStatusMessage` | `"status"` | Progress updates (e.g., compacting) |
| `SDKToolProgressMessage` | `"tool_progress"` | Tool execution progress |
| `SDKToolUseSummaryMessage` | `"tool_use_summary"` | Tool use summaries |
| `SDKRateLimitEvent` | `"rate_limit"` | Rate limit info |

**Streaming event flow** with `includePartialMessages: true`:

```
stream_event (message_start)
stream_event (content_block_start) — text block
stream_event (content_block_delta) — text chunks  ← THE TOKENS
stream_event (content_block_stop)
stream_event (content_block_start) — tool_use block (if agent uses tools)
stream_event (content_block_delta) — tool input chunks
stream_event (content_block_stop)
assistant — complete message
... tool executes ...
result — final result
```

**Extracting text tokens**:
```typescript
if (message.type === "stream_event") {
  const event = message.event;
  if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
    const token = event.delta.text;  // <-- individual token string
  }
}
```

**Important limitations**:
- Extended thinking (`maxThinkingTokens`) disables `stream_event` messages
- Structured output (`outputFormat`) only appears in final `ResultMessage`

### 6. Result Message Structure [Analyzer]

```typescript
type SDKResultMessage = {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_execution" | "error_max_budget_usd";
  result: string;          // on success
  total_cost_usd: number;
  duration_ms: number;
  num_turns: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
};
```

### 7. Session Management [Analyzer] [Web Researcher]

```typescript
import { query, listSessions, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";

// Capture session ID from init message
let sessionId: string;
for await (const msg of query({ prompt: "..." })) {
  if (msg.type === "system" && msg.subtype === "init") {
    sessionId = msg.session_id;
  }
}

// Resume later
for await (const msg of query({
  prompt: "Continue",
  options: { resume: sessionId }
})) { /* ... */ }

// List/read past sessions
const sessions = await listSessions({ dir: "/path/to/project", limit: 10 });
const history = await getSessionMessages(sessionId);
```

### 8. Custom Tools via MCP [Web Researcher]

```typescript
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const myTool = tool(
  "my_tool",
  "Description",
  { input: z.string() },
  async ({ input }) => ({
    content: [{ type: "text", text: `Result: ${input}` }]
  })
);

const mcpServer = createSdkMcpServer({
  name: "my-tools",
  tools: [myTool],
});

for await (const msg of query({
  prompt: "Use my_tool",
  options: { mcpServers: { "my-tools": mcpServer } }
})) { /* ... */ }
```

### 9. Backend Framework: Hono [Pattern Finder]

**Why Hono wins for this use case**:

| Factor | Hono | Elysia | Express | Raw Bun.serve |
|--------|------|--------|---------|---------------|
| SSE support | First-class `streamSSE` helper | Built-in but had perf issues | Manual | Manual with ReadableStream |
| Runtime | Multi-runtime (Bun, Node, Deno, CF Workers) | Bun-only | Node-focused | Bun-only |
| TypeScript | Great | Best (Eden e2e types) | Needs @types | Native |
| Complexity | Minimal | More features | Familiar but verbose | Zero framework |

Hono's `streamSSE` auto-sets headers and auto-closes:

```typescript
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

const app = new Hono();

app.post("/api/agent", async (c) => {
  return streamSSE(c, async (stream) => {
    for await (const msg of agentQuery) {
      await stream.writeSSE({
        event: msg.type,
        data: JSON.stringify(msg),
      });
    }
  });
});
```

### 10. Frontend SSE Consumption [Pattern Finder] [Consensus]

Since `EventSource` only supports GET, and we need POST (to send instructions), use `fetch()` + `ReadableStream`:

```typescript
const response = await fetch("/api/agent", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt }),
  signal: abortController.signal,
});

const reader = response.body!.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const chunk = decoder.decode(value);
  // Parse SSE lines: "data: {...}\n\n"
}
```

### 11. CORS-free Dev with Vite Proxy [Web Researcher] [Pattern Finder]

```typescript
// vite.config.ts
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
```

Frontend hits `/api/agent` — Vite proxies to Bun server. No CORS headers needed in dev.

---

## Code References

### SDK Package
- npm: `@anthropic-ai/claude-agent-sdk@0.2.63`
- GitHub: https://github.com/anthropics/claude-agent-sdk-typescript
- Demos: https://github.com/anthropics/claude-agent-sdk-demos

### Documentation
- Overview: https://platform.claude.com/docs/en/agent-sdk/overview
- TypeScript API: https://platform.claude.com/docs/en/agent-sdk/typescript
- V2 Preview: https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview
- Migration: https://platform.claude.com/docs/en/agent-sdk/migration-guide

### Project Template
- BHVR (Bun+Hono+Vite+React): `bun create bhvr@latest`

---

## Architecture Documentation

### Recommended Architecture (Step 1)

```
Browser (React + Vite)
    │
    │  POST /api/agent { prompt }
    │  ← SSE stream (text/event-stream)
    │
Bun Server (Hono)
    │
    │  query({ prompt, options })
    │  ← AsyncGenerator<SDKMessage>
    │
Claude Agent SDK
    │
    │  Spawns subprocess, JSON-over-stdio
    │
Claude API
```

### Project Structure

```
duvo-test/
├── package.json              # Bun workspaces: ["apps/*", "packages/*"]
├── turbo.json                # Dev/build orchestration
├── .env                      # ANTHROPIC_API_KEY (or use system env)
├── apps/
│   ├── client/               # React + Vite
│   │   ├── package.json
│   │   ├── index.html
│   │   ├── vite.config.ts    # Proxy /api → localhost:3001
│   │   └── src/
│   │       ├── main.tsx
│   │       ├── App.tsx
│   │       ├── hooks/
│   │       │   └── useAgentStream.ts
│   │       └── components/
│   │           └── AgentChat.tsx
│   └── server/               # Bun + Hono
│       ├── package.json
│       └── src/
│           └── index.ts      # Hono app + SSE endpoint
└── packages/
    └── shared/               # Shared TypeScript types
        ├── package.json
        └── src/
            └── types.ts      # AgentMessage, StreamChunk, etc.
```

### Data Flow (Streaming)

1. User types instruction in React input, submits form
2. Frontend POSTs `{ prompt }` to `/api/agent` (proxied to Bun server)
3. Bun server calls `query({ prompt, options: { includePartialMessages: true } })`
4. SDK spawns subprocess, starts streaming `SDKMessage` objects
5. Server wraps each message as SSE `data:` line, enqueues to `ReadableStream`
6. Frontend reads stream via `response.body.getReader()`
7. Frontend parses SSE lines, extracts `text_delta` from `stream_event` messages
8. React state updates progressively, rendering tokens as they arrive
9. On `result` message, marks streaming complete, shows cost/usage

### Key Options for Step 1

```typescript
{
  model: "claude-sonnet-4-6",       // fast, cost-effective for Step 1
  allowedTools: [],                  // no tools for Step 1 (pure chat)
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  includePartialMessages: true,      // token streaming
  maxTurns: 1,                       // single response for Step 1
  abortController: new AbortController(),
}
```

---

## Related Research

- Hono SSE documentation: https://hono.dev/docs/helpers/streaming
- Bun HTTP server: https://bun.sh/docs/api/http
- Vite proxy config: https://vite.dev/config/server-options#server-proxy
- React 19 streaming patterns: fetch + ReadableStream

---

## Open Questions

1. **V1 vs V2 API**: V2 is cleaner for multi-turn (Steps 2-5) but unstable. Should we start with V1 for stability, or V2 to avoid migration later?
2. **Tool permissions**: Steps 2-5 likely add tool use. What tools should the agent have access to? How to handle permission prompts in a web UI?
3. **Session persistence**: The SDK supports `persistSession` and `resume`. Should we store session IDs in the frontend for conversation continuity?
4. **Model selection**: `claude-sonnet-4-6` for speed/cost, or `claude-opus-4-6` for quality? Should the user be able to choose?
5. **Error handling**: The SDK can emit `error_max_turns`, `error_during_execution`, `error_max_budget_usd`. How should these be displayed in the UI?
6. **`settingSources`**: Defaults to `[]` — SDK does NOT load CLAUDE.md or settings.json by default. Do we need project context for our agents?
7. **BHVR vs manual setup**: The `bhvr` template scaffolds the exact structure we need. Worth using, or build from scratch for full control?
