export type AgentRequest = {
  prompt: string;
  sessionId?: string;
  systemPrompt?: string;
};

export type AgentSSEEvent =
  | { type: "system"; subtype: "init"; session_id: string }
  | {
      type: "stream_event";
      event: {
        type: string;
        index?: number;
        content_block?: { type: string; id?: string; name?: string; text?: string };
        delta?: { type: string; text?: string; partial_json?: string };
      };
    }
  | {
      type: "assistant";
      message: {
        content: Array<
          | { type: "text"; text: string }
          | { type: "tool_use"; id: string; name: string; input: unknown }
        >;
      };
    }
  | {
      type: "result";
      subtype: "success" | "error_max_turns" | "error_during_execution" | "error_max_budget_usd";
      result?: string;
      total_cost_usd: number;
      duration_ms: number;
      num_turns: number;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens: number;
        cache_read_input_tokens: number;
      };
    }
  | { type: "error"; message: string }
  | { type: "tool_progress"; tool_use_id: string; tool_name: string; elapsed_time_seconds: number }
  | { type: "tool_use_summary"; summary: string }
  | { type: "tool_result"; parent_tool_use_id: string | null; success: boolean }
  | { type: "file_created"; filename: string; downloadUrl: string };
