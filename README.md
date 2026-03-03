# duvo-test

Experiment to build a local agent chat UI powered by the Claude Agent SDK.

## What it is

A Bun monorepo with three workspaces:

- **`client/`** — React 19 + Vite chat interface with SSE streaming
- **`server/`** — Hono backend wrapping the Claude Agent SDK
- **`shared/`** — TypeScript types for the API contract

## Status: not working

The application does not function. The Anthropic API consistently returns 500 errors, and there are likely additional bugs in the implementation beyond that.

### What was completed

The project was planned as a 5-step build. Progress stalled early:

| Step | Goal | Outcome |
|------|------|---------|
| 1 | Basic agent chat | Implemented but not fully working |
| 2 | Tool access | Plans only — no implementation |
| 3 | Multi-agent / MCP | Research only |
| 4 | — | Never reached |
| 5 | — | Never reached |

Research notes and plans are in `research/` and `plans/`.

## Running (for reference)

```
bun install
bun run dev
```

Starts the client on port 5173 and server on port 3001.
