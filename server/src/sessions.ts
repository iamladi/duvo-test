import {
  type Query,
  query as sdkQuery,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Queue-based async iterable that keeps the SDK's streamInput for-await loop
 * alive without blocking. Matches the SDK's own internal queue pattern (q4).
 */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private resolve: ((result: IteratorResult<SDKUserMessage>) => void) | null =
    null;

  enqueue(msg: SDKUserMessage): void {
    if (this.resolve) {
      this.resolve({ value: msg, done: false });
      this.resolve = null;
    } else {
      this.queue.push(msg);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({
            value: this.queue.shift()!,
            done: false as const,
          });
        }
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.resolve = resolve;
        });
      },
    };
  }
}

export type Session = {
  id: string;
  sdkSessionId: string;
  query: Query;
  queue: MessageQueue;
  streaming: boolean;
  ttlTimer: ReturnType<typeof setTimeout>;
};

const sessions = new Map<string, Session>();

function makeUserMessage(
  prompt: string,
  sessionId: string,
): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: prompt },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

function resetTTL(session: Session): void {
  clearTimeout(session.ttlTimer);
  session.ttlTimer = setTimeout(
    () => deleteSession(session.id),
    SESSION_TTL_MS,
  );
}

export function createSession(prompt: string): Session {
  const id = crypto.randomUUID();
  const ac = new AbortController();
  const queue = new MessageQueue();

  // Enqueue first message — the SDK's streamInput for-await loop will read it immediately
  queue.enqueue(makeUserMessage(prompt, ""));

  const q = sdkQuery({
    prompt: queue,
    options: {
      model: "claude-sonnet-4-6",
      allowedTools: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      abortController: ac,
      // Clear CLAUDECODE env var to allow subprocess when running inside Claude Code
      env: { CLAUDECODE: undefined },
    },
  });

  const session: Session = {
    id,
    sdkSessionId: "",
    query: q,
    queue,
    streaming: false,
    ttlTimer: setTimeout(() => deleteSession(id), SESSION_TTL_MS),
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function feedFollowUp(session: Session, prompt: string): void {
  resetTTL(session);
  // Enqueue into the same queue — the SDK's for-await loop picks it up
  session.queue.enqueue(makeUserMessage(prompt, session.sdkSessionId));
}

export function deleteSession(id: string): void {
  const session = sessions.get(id);
  if (session) {
    clearTimeout(session.ttlTimer);
    session.query.close();
    sessions.delete(id);
  }
}
