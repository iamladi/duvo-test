---
date: 2026-03-03
topic: "Observable automation UI patterns for AI agent execution monitoring"
tags: [react, sse, streaming, agent-ui, observability, event-sourcing, xstate, zustand, shadcn, timeline]
status: complete
last_updated: 2026-03-03
last_updated_by: web-researcher
---

# Research: Observable Automation UI Patterns

## Research Question

How to build a React frontend that observes Claude Agent SDK conversations in real-time — rendering thinking, tool calls, tool execution, results, and final response as structured, step-by-step UI with both a raw streaming view and a derived state summary.

## Summary

The prior research (`research-agent-frontend-claude-sdk.md`) established the SDK internals and basic streaming architecture. This research covers the **UI layer above the stream**: how to render multi-step agent execution in a way that feels observable, debuggable, and legible to users.

**Key findings**:

1. **Event taxonomy**: The SDK emits structurally distinct message types that map cleanly to UI "phases" — thinking, tool dispatch, tool execution, tool result, response. Design the SSE protocol to preserve these distinctions rather than flattening to raw text.
2. **Recommended protocol**: Emit typed SSE events mirroring SDK message types. The frontend derives a structured `AgentRun` state via a `useReducer` reducer — this is the event sourcing pattern applied to streaming.
3. **React pattern**: A `useAgentRun` hook consuming SSE, dispatching into a reducer, and exposing a structured `AgentRun` object. Components are pure renderers of that state.
4. **Component architecture**: A timeline/step-list of `AgentStep` cards, each expandable to show raw events, tool inputs, and tool outputs. Uses shadcn Timeline + Radix Accordion for expandability.
5. **State management**: `useReducer` is sufficient for per-run state. No Zustand/XState needed unless supporting multi-run history or complex permission flows.

---

## Detailed Findings

### 1. AI Agent Observability UI Patterns (Industry, 2025-2026)

The leading platforms (LangSmith, Langfuse, AgentOps, Maxim AI) have converged on a common visual grammar:

#### Common Visual Grammar

| Component | Description | When to use |
|-----------|-------------|-------------|
| **Trace/span tree** | Expandable hierarchy of nested spans | Multi-agent, complex pipelines |
| **Step timeline** | Sequential list of steps, each with status badge | Single-agent linear flows (our case) |
| **Tool call cards** | Shows tool name, input params, output result | Whenever a tool fires |
| **Streaming text** | Character-by-character or token-by-token append | LLM text output |
| **Thinking indicator** | Spinner/pulse while waiting for model | Between steps |
| **Cost/usage footer** | Token counts, cost, duration | End of run |
| **Session replay** | Rewind to earlier step | Advanced debugging (not needed for Step 2) |

**For our use case** (single Claude agent, sequential steps, no sub-agents), the **step timeline** pattern is ideal:

```
[run started]
  [thinking...]           ← spinner while stream_events arrive
  [step 1] ✓ Read file    ← completed tool call (expandable)
  [step 2] ✓ Edit file    ← completed tool call (expandable)
  [step 3] ⟳ Running Bash ← in-progress tool call
  ...
  [response] Assistant answer text streams here...
  [done] 2.3s · 1,240 tokens · $0.0042
```

#### Key Design Principles from LangSmith / OpenAI Playground

1. **Status is immediate** — show "in progress" before results arrive, not a blank space.
2. **Expandability** — each step shows a summary line by default; clicking expands to show full tool input/output JSON.
3. **Raw log toggle** — a "raw events" panel alongside the structured view satisfies developers who want full fidelity.
4. **Non-blocking streaming** — text continues streaming while completed steps are visible above.
5. **Error states are first-class** — failed tool calls, permission denials, and rate limits each have distinct visual treatment.

---

### 2. SSE Event Protocol Design

#### Recommendation: Typed Events Mirroring SDK Structure

The backend should emit SSE events whose `event:` type maps directly to the SDK's `SDKMessage` types. The frontend then has all the information needed to derive structure without guessing.

**Proposed event taxonomy**:

```
event: system
data: { "type": "system", "subtype": "init", "session_id": "...", "model": "...", "tools": [...] }

event: thinking
data: { "type": "thinking" }   ← emitted when stream_events with text_delta arrive but no tool yet started

event: text_delta
data: { "type": "text_delta", "text": "token string" }

event: tool_start
data: { "type": "tool_start", "tool_use_id": "toolu_xxx", "name": "Read", "input": {} }

event: tool_input_delta
data: { "type": "tool_input_delta", "tool_use_id": "toolu_xxx", "partial_json": "{\"path\":" }

event: tool_complete
data: { "type": "tool_complete", "tool_use_id": "toolu_xxx", "name": "Read", "input": {...} }

event: tool_result
data: { "type": "tool_result", "tool_use_id": "toolu_xxx", "result_preview": "file contents..." }

event: assistant_complete
data: { "type": "assistant_complete", "text": "Full assistant text" }

event: result
data: { "type": "result", "subtype": "success", "total_cost_usd": 0.004, "duration_ms": 2300, "num_turns": 3, "usage": {...} }

event: error
data: { "type": "error", "subtype": "error_during_execution", "message": "..." }
```

#### Backend Mapping (Bun + Hono)

```typescript
// server/src/agent-stream.ts
import { query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export async function* toSSEEvents(prompt: string): AsyncGenerator<{ event: string; data: string }> {
  const q = query({ prompt, options: { includePartialMessages: true } });

  for await (const msg of q) {
    switch (msg.type) {
      case "system":
        yield { event: "system", data: JSON.stringify(msg) };
        break;

      case "stream_event": {
        const ev = msg.event;
        if (ev.type === "content_block_start") {
          if (ev.content_block.type === "tool_use") {
            yield {
              event: "tool_start",
              data: JSON.stringify({
                type: "tool_start",
                tool_use_id: ev.content_block.id,
                name: ev.content_block.name,
                input: {},
              }),
            };
          }
        } else if (ev.type === "content_block_delta") {
          if (ev.delta.type === "text_delta") {
            yield {
              event: "text_delta",
              data: JSON.stringify({ type: "text_delta", text: ev.delta.text }),
            };
          } else if (ev.delta.type === "input_json_delta") {
            yield {
              event: "tool_input_delta",
              data: JSON.stringify({
                type: "tool_input_delta",
                index: ev.index,
                partial_json: ev.delta.partial_json,
              }),
            };
          }
        } else if (ev.type === "content_block_stop") {
          // The 'assistant' message arrives separately with complete tool input
        }
        break;
      }

      case "assistant": {
        // Complete assistant message — emit tool_complete for each tool_use block
        for (const block of msg.message.content) {
          if (block.type === "tool_use") {
            yield {
              event: "tool_complete",
              data: JSON.stringify({
                type: "tool_complete",
                tool_use_id: block.id,
                name: block.name,
                input: block.input,
              }),
            };
          }
        }
        yield { event: "assistant_complete", data: JSON.stringify({ type: "assistant_complete" }) };
        break;
      }

      case "user": {
        // Tool results
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") {
              const preview = typeof block.content === "string"
                ? block.content.slice(0, 500)
                : JSON.stringify(block.content).slice(0, 500);
              yield {
                event: "tool_result",
                data: JSON.stringify({
                  type: "tool_result",
                  tool_use_id: block.tool_use_id,
                  result_preview: preview,
                }),
              };
            }
          }
        }
        break;
      }

      case "result":
        yield { event: "result", data: JSON.stringify(msg) };
        break;
    }
  }
}
```

#### Frontend SSE Parsing

```typescript
// Parse SSE text/event-stream format
function parseSSEChunk(chunk: string): Array<{ event: string; data: string }> {
  const events: Array<{ event: string; data: string }> = [];
  const blocks = chunk.split("\n\n").filter(Boolean);
  for (const block of blocks) {
    const lines = block.split("\n");
    let event = "message";
    let data = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) event = line.slice(7);
      if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (data) events.push({ event, data });
  }
  return events;
}
```

#### Should the frontend derive structure from raw events, or should the backend do it?

**Recommendation: Backend derives structure.** The backend has complete context (SDK message types, tool IDs), so it should translate SDK internals into a clean semantic protocol. The frontend should not have to understand `content_block_start` index-to-tool-id mapping. This also keeps the frontend portable — any SSE-speaking backend works.

---

### 3. React State Model: Derived State via Reducer

#### AgentRun Data Model

```typescript
// packages/shared/src/types.ts

export type StepStatus = "pending" | "running" | "done" | "error";

export type ToolStep = {
  kind: "tool";
  stepId: string;           // tool_use_id
  name: string;
  status: StepStatus;
  inputPartial: string;     // raw JSON accumulating during streaming
  inputFinal: Record<string, unknown> | null;
  resultPreview: string | null;
};

export type TextStep = {
  kind: "text";
  stepId: string;
  status: StepStatus;
  text: string;             // accumulates via text_delta
};

export type AgentStep = ToolStep | TextStep;

export type RunStatus = "idle" | "running" | "done" | "error";

export type AgentRun = {
  runId: string | null;
  status: RunStatus;
  model: string | null;
  steps: AgentStep[];
  result: {
    cost_usd: number;
    duration_ms: number;
    num_turns: number;
    usage: Record<string, number>;
  } | null;
  error: string | null;
};
```

#### Reducer

```typescript
// hooks/useAgentRun.ts

type AgentEvent =
  | { type: "system"; session_id: string; model: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; tool_use_id: string; name: string }
  | { type: "tool_input_delta"; index: number; partial_json: string }
  | { type: "tool_complete"; tool_use_id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; result_preview: string }
  | { type: "assistant_complete" }
  | { type: "result"; subtype: string; total_cost_usd: number; duration_ms: number; num_turns: number; usage: Record<string, number> }
  | { type: "error"; message: string }
  | { type: "reset" };

const initialRun: AgentRun = {
  runId: null,
  status: "idle",
  model: null,
  steps: [],
  result: null,
  error: null,
};

function agentRunReducer(state: AgentRun, event: AgentEvent): AgentRun {
  switch (event.type) {
    case "reset":
      return { ...initialRun };

    case "system":
      return { ...state, runId: event.session_id, model: event.model, status: "running" };

    case "text_delta": {
      const last = state.steps[state.steps.length - 1];
      if (last?.kind === "text" && last.status === "running") {
        return {
          ...state,
          steps: [
            ...state.steps.slice(0, -1),
            { ...last, text: last.text + event.text },
          ],
        };
      }
      // Start a new text step
      const stepId = `text-${state.steps.length}`;
      return {
        ...state,
        steps: [...state.steps, { kind: "text", stepId, status: "running", text: event.text }],
      };
    }

    case "tool_start":
      return {
        ...state,
        steps: [
          ...state.steps,
          {
            kind: "tool",
            stepId: event.tool_use_id,
            name: event.name,
            status: "running",
            inputPartial: "",
            inputFinal: null,
            resultPreview: null,
          },
        ],
      };

    case "tool_input_delta": {
      const steps = state.steps.map((s) =>
        s.kind === "tool" && s.status === "running" && !s.inputFinal
          ? { ...s, inputPartial: s.inputPartial + event.partial_json }
          : s
      );
      return { ...state, steps };
    }

    case "tool_complete": {
      const steps = state.steps.map((s) =>
        s.kind === "tool" && s.stepId === event.tool_use_id
          ? { ...s, inputFinal: event.input, inputPartial: "" }
          : s
      );
      return { ...state, steps };
    }

    case "tool_result": {
      const steps = state.steps.map((s) =>
        s.kind === "tool" && s.stepId === event.tool_use_id
          ? { ...s, status: "done" as StepStatus, resultPreview: event.result_preview }
          : s
      );
      return { ...state, steps };
    }

    case "assistant_complete": {
      // Mark any still-running text step as done
      const steps = state.steps.map((s) =>
        s.kind === "text" && s.status === "running" ? { ...s, status: "done" as StepStatus } : s
      );
      return { ...state, steps };
    }

    case "result":
      return {
        ...state,
        status: event.subtype === "success" ? "done" : "error",
        result: {
          cost_usd: event.total_cost_usd,
          duration_ms: event.duration_ms,
          num_turns: event.num_turns,
          usage: event.usage,
        },
        error: event.subtype !== "success" ? event.subtype : null,
      };

    case "error":
      return { ...state, status: "error", error: event.message };

    default:
      return state;
  }
}
```

#### useAgentRun Hook

```typescript
export function useAgentRun() {
  const [run, dispatch] = useReducer(agentRunReducer, initialRun);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(async (prompt: string) => {
    abortRef.current?.abort();
    dispatch({ type: "reset" });
    abortRef.current = new AbortController();

    const response = await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
      signal: abortRef.current.signal,
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        for (const { event, data } of parseSSEChunk(chunk + "\n\n")) {
          try {
            dispatch(JSON.parse(data) as AgentEvent);
          } catch {
            // Malformed event — ignore
          }
        }
      }
    }
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { run, start, cancel };
}
```

---

### 4. React Component Architecture

#### Component Tree

```
<AgentRunView run={run} onStart={start} onCancel={cancel}>
  <PromptInput />                    ← user prompt submission
  <RunStatusBadge status={run.status} />
  <StepList steps={run.steps}>
    <ToolStepCard step={toolStep}>   ← expandable
      <StepSummaryRow />             ← always visible: icon + name + status
      <StepDetail>                   ← visible when expanded
        <InputDisplay input={...} />
        <ResultDisplay result={...} />
      </StepDetail>
    </ToolStepCard>
    <TextStepCard step={textStep}>   ← streaming text, no expand needed
      <StreamingText text={...} />
    </TextStepCard>
  </StepList>
  <ResultFooter result={run.result} /> ← cost, tokens, duration
</AgentRunView>
```

#### ToolStepCard with Radix Accordion

```tsx
// components/ToolStepCard.tsx
import * as Accordion from "@radix-ui/react-accordion";

const statusIcon = {
  pending: <Clock className="w-4 h-4 text-muted-foreground" />,
  running: <Loader2 className="w-4 h-4 animate-spin text-blue-500" />,
  done: <CheckCircle2 className="w-4 h-4 text-green-500" />,
  error: <XCircle className="w-4 h-4 text-red-500" />,
};

export function ToolStepCard({ step }: { step: ToolStep }) {
  return (
    <Accordion.Item value={step.stepId} className="border rounded-lg">
      <Accordion.Trigger className="flex items-center gap-2 px-3 py-2 w-full text-left text-sm">
        <span className="font-mono bg-muted px-1.5 py-0.5 rounded text-xs">{step.name}</span>
        {statusIcon[step.status]}
        <ChevronDown className="ml-auto w-4 h-4 transition-transform data-[state=open]:rotate-180" />
      </Accordion.Trigger>
      <Accordion.Content className="px-3 pb-3 text-xs font-mono space-y-2">
        {step.inputFinal ? (
          <div>
            <div className="text-muted-foreground mb-1">Input</div>
            <pre className="bg-muted p-2 rounded overflow-auto max-h-40">
              {JSON.stringify(step.inputFinal, null, 2)}
            </pre>
          </div>
        ) : step.inputPartial ? (
          <div>
            <div className="text-muted-foreground mb-1">Input (streaming...)</div>
            <pre className="bg-muted p-2 rounded overflow-auto max-h-40">{step.inputPartial}</pre>
          </div>
        ) : null}
        {step.resultPreview && (
          <div>
            <div className="text-muted-foreground mb-1">Result</div>
            <pre className="bg-muted p-2 rounded overflow-auto max-h-40">{step.resultPreview}</pre>
          </div>
        )}
      </Accordion.Content>
    </Accordion.Item>
  );
}
```

#### Raw Events Toggle

Alongside the structured view, maintain a `rawEvents: string[]` array in a separate piece of state and display it in a scrollable pre block when toggled:

```tsx
// components/RawEventsPanel.tsx
export function RawEventsPanel({ events }: { events: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    ref.current?.scrollTo(0, ref.current.scrollHeight);
  }, [events]);

  return (
    <pre
      ref={ref}
      className="text-xs font-mono bg-zinc-950 text-zinc-300 p-3 rounded h-64 overflow-auto"
    >
      {events.join("\n")}
    </pre>
  );
}
```

---

### 5. State Management Approach

#### Recommendation: `useReducer` for per-run state, no external library needed

| Library | When to use | Verdict for this case |
|---------|-------------|----------------------|
| `useReducer` | Single run, local component tree | **Recommended** — sufficient, zero dependencies |
| Zustand | Multi-run history, cross-component access | Use if run history across sessions is needed |
| XState | Permission dialogs, complex flows with guards | Use if `canUseTool` callback creates async permission gates |
| Jotai/Valtio | Fine-grained atom subscriptions | Unnecessary — reducer handles all updates |

**Why `useReducer` is sufficient**: The event stream is unidirectional and sequential. Each event maps to a single reducer action. State is consumed by one component tree. The reducer is fully testable without React.

#### If permission flows are needed (XState)

When the agent asks for permission (`canUseTool` callback), it creates a bidirectional interaction: frontend must reply with approval/denial before the agent continues. This is where XState shines — the machine can model `{ running → awaiting_permission → running }` with explicit guards.

```typescript
// Future extension — not needed for Step 2
const agentMachine = createMachine({
  id: "agent",
  initial: "idle",
  states: {
    idle: { on: { START: "running" } },
    running: {
      on: {
        PERMISSION_REQUIRED: "awaiting_permission",
        DONE: "complete",
        ERROR: "failed",
      },
    },
    awaiting_permission: {
      on: {
        APPROVE: "running",
        DENY: "running", // agent continues with denial
      },
    },
    complete: { type: "final" },
    failed: { type: "final" },
  },
});
```

---

### 6. Libraries and Dependencies

| Library | Purpose | Install |
|---------|---------|---------|
| `@radix-ui/react-accordion` | Expandable step cards | `bun add @radix-ui/react-accordion` |
| `lucide-react` | Status icons (Loader2, CheckCircle2, etc.) | `bun add lucide-react` |
| `tailwind-merge` | Conditional class merging | `bun add tailwind-merge` |
| `clsx` | Class name utility | `bun add clsx` |
| shadcn Timeline | Copy-paste timeline component | Manual copy from shadcn registry |
| `xstate` | Only if permission flows needed | `bun add xstate @xstate/react` |
| `zustand` | Only if multi-run history needed | `bun add zustand` |

No specialized "AI streaming" library is needed — the pattern is `useReducer` + `fetch` + `ReadableStream`.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                     React Frontend                       │
│                                                         │
│  ┌──────────────┐    ┌──────────────────────────────┐  │
│  │  PromptInput  │    │        AgentRunView           │  │
│  └──────┬────────┘    │                              │  │
│         │ start(prompt)│  ┌──────────────────────┐   │  │
│  ┌──────▼────────┐    │  │      StepList         │   │  │
│  │ useAgentRun() │    │  │  ToolStepCard (x N)   │   │  │
│  │               │    │  │  TextStepCard          │   │  │
│  │ fetch POST    │    │  │  ResultFooter          │   │  │
│  │ ReadableStream│    │  └──────────────────────┘   │  │
│  │ parseSSE()    │    │                              │  │
│  │ dispatch()    │    │  ┌──────────────────────┐   │  │
│  │               │    │  │   RawEventsPanel      │   │  │
│  │ AgentRun state│───►│  │   (toggle on/off)     │   │  │
│  └───────────────┘    │  └──────────────────────┘   │  │
│                        └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
              │ SSE (text/event-stream)
              ▼
┌─────────────────────────────────────────────────────────┐
│                     Bun + Hono Backend                   │
│                                                         │
│  POST /api/agent { prompt }                             │
│  → toSSEEvents(prompt)                                  │
│     → query() → AsyncGenerator<SDKMessage>              │
│     → map SDKMessage to typed SSE events                │
│     → stream via streamSSE()                            │
└─────────────────────────────────────────────────────────┘
```

---

## Key Decisions

### Decision 1: Typed SSE events vs. raw passthrough

**Options**:
- A) Pass raw `SDKMessage` objects through as SSE events (backend is thin)
- B) Map to a semantic event protocol (backend translates, frontend is simpler)

**Recommendation: B** — backend translates. Rationale: the SDK's `stream_event` with `content_block_start` index tracking and tool-ID correlation is complex. Centralizing this in the backend prevents duplication if we add other clients (e.g., CLI, mobile). The frontend's reducer stays clean.

### Decision 2: Single-phase vs. two-phase rendering

**Options**:
- A) Render the structured view only (derive everything from state)
- B) Render both structured view and raw event log simultaneously

**Recommendation: B** — always maintain `rawEvents: string[]` in parallel (append every SSE event to it). Expose via toggle. This costs nothing (string appends) and is invaluable for debugging during development.

### Decision 3: State isolation

Each run should produce a fresh `AgentRun` object dispatched from scratch via `reset`. Previous runs can be stored in a `runs: AgentRun[]` array in a Zustand store if history is desired, but the live run state stays in local `useReducer`.

---

## Related Documentation

- Vercel AI SDK tool invocations: https://sdk.vercel.ai/docs/ai-sdk-ui/chatbot-with-tool-calling
- Radix Accordion: https://www.radix-ui.com/primitives/docs/components/accordion
- shadcn Timeline community template: https://ui.shadcn.com/
- LangSmith trace viewer concepts: https://docs.smith.langchain.com/concepts/tracing
- XState v5 actors: https://stately.ai/docs/actors
- Anthropic SDK MessageStream events: https://github.com/anthropics/anthropic-sdk-typescript#streaming-helpers

---

## Open Questions

1. **Tool input streaming UX**: Should partial `inputPartial` JSON be displayed while still accumulating, or only shown when `inputFinal` arrives? (Streaming JSON is often unreadable mid-stream.)
2. **Multi-turn context**: The `streamInput()` method allows feeding follow-up messages to an existing `query()`. Should the UI support a reply box while the agent is in progress?
3. **Step ordering**: Tool calls and text can interleave. The reducer handles this, but should the UI group consecutive text blocks or treat each separately?
4. **Scroll behavior**: Should the view auto-scroll to the latest step, or pin to the bottom only when the user hasn't scrolled up?
5. **Permission gates**: If `canUseTool` is used, the frontend needs a way to send approval back to the server mid-stream. This requires a second channel (e.g., a separate POST endpoint) since SSE is unidirectional.
