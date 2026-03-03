export type AgentRequest = {
  prompt: string;
  sessionId?: string;
};

export type AgentSSEEvent =
  | { type: "system"; subtype: "init"; session_id: string }
  | {
      type: "stream_event";
      event: {
        type: string;
        delta?: { type: string; text?: string };
      };
    }
  | {
      type: "assistant";
      message: { content: Array<{ type: string; text?: string }> };
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
  | { type: "error"; message: string };
