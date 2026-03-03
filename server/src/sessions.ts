import {
  type Query,
  query as sdkQuery,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync } from "fs";
import { basename, isAbsolute, join, resolve } from "path";

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const SESSION_BASE = "/tmp/duvo-sessions";

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
  sessionDir: string;
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

const DEFAULT_SYSTEM_PROMPT = `You are a helpful assistant with access to web search and file tools.

When a task requires saving data to a file:
- Use the Write tool to create the file in the current directory with a relative path (e.g. "results.csv", not "/absolute/path/results.csv")
- Do NOT include the file contents in your message — just confirm what you saved and the filename
- After saving, reply with a brief summary: what you found and where you saved it

For CSV files, always include a header row.

IMPORTANT security rules for Bash:
- NEVER read files outside your working directory using Bash
- NEVER access ~/.claude, ~/.config, or any dotfiles/config directories
- NEVER attempt to discover or list MCP configurations on the host system
- Only use Bash for tasks the user explicitly requests`;

function buildSystemPrompt(base: string, mcpPath?: string): string {
  if (!mcpPath) return base;
  const resolvedPath = resolve(mcpPath);
  return `${base}

## Connected Data Source: Filesystem MCP

You have a filesystem data connection to: ${resolvedPath}
Use your mcp__filesystem__* tools to interact with this data:
- mcp__filesystem__list_directory — list files in a directory
- mcp__filesystem__read_text_file — read a single file
- mcp__filesystem__read_multiple_files — read multiple files at once
- mcp__filesystem__directory_tree — see the full directory tree
- mcp__filesystem__search_files — search for files by pattern
- mcp__filesystem__get_file_info — get file metadata

ALWAYS prefer these MCP tools over Bash/Read for accessing the connected directory.
These tools are sandboxed to the connected directory — they cannot access files outside it.`;
}

const MCP_FILESYSTEM_TOOLS = [
  "mcp__filesystem__read_text_file",
  "mcp__filesystem__read_multiple_files",
  "mcp__filesystem__list_directory",
  "mcp__filesystem__directory_tree",
  "mcp__filesystem__search_files",
  "mcp__filesystem__get_file_info",
];

export function createSession(
  prompt: string,
  systemPrompt?: string,
  mcpConnection?: { enabled: boolean; path: string },
): Session {
  const id = crypto.randomUUID();
  const ac = new AbortController();
  const queue = new MessageQueue();

  // Create per-session output directory
  const sessionDir = join(SESSION_BASE, id);
  mkdirSync(sessionDir, { recursive: true });

  // Enqueue first message — the SDK's streamInput for-await loop will read it immediately
  queue.enqueue(makeUserMessage(prompt, ""));

  const baseTools = ["WebSearch", "WebFetch", "Write", "Bash", "Read"];
  const mcpActive = mcpConnection?.enabled && mcpConnection.path.trim().length > 0;
  const allowedTools = mcpActive
    ? [...baseTools, ...MCP_FILESYSTEM_TOOLS]
    : baseTools;

  const mcpServers =
    mcpActive
      ? {
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", resolve(mcpConnection.path)],
          },
        }
      : undefined;

  const q = sdkQuery({
    prompt: queue,
    options: {
      model: "claude-sonnet-4-6",
      allowedTools,
      maxTurns: 10,
      cwd: sessionDir,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      abortController: ac,
      ...(mcpServers ? { mcpServers } : {}),
      // Redirect Write tool absolute paths into the session directory
      canUseTool: async (toolName, input) => {
        if (toolName === "Write") {
          const filePath = input.file_path as string | undefined;
          if (filePath && isAbsolute(filePath) && !filePath.startsWith(sessionDir)) {
            const remapped = join(sessionDir, basename(filePath));
            return {
              behavior: "allow" as const,
              updatedInput: { ...input, file_path: remapped },
            };
          }
        }
        // Block Bash/Read from accessing sensitive paths
        if (toolName === "Bash") {
          const cmd = (input.command as string) ?? "";
          const sensitive = [
            "~/.claude", "$HOME/.claude", "/.claude/",
            "~/.config", "$HOME/.config", "/.config/",
            ".mcp.json", "mcp.json",
          ];
          if (sensitive.some((p) => cmd.includes(p))) {
            return { behavior: "deny" as const, message: "Access to system configuration files is not allowed" };
          }
        }
        return { behavior: "allow" as const, updatedPermissions: [] };
      },
      systemPrompt: systemPrompt ?? buildSystemPrompt(
        DEFAULT_SYSTEM_PROMPT,
        mcpActive ? mcpConnection.path : undefined,
      ),
      // Clear CLAUDECODE env var to allow subprocess when running inside Claude Code
      env: { ...process.env, CLAUDECODE: undefined },
    },
  });

  const session: Session = {
    id,
    sdkSessionId: "",
    query: q,
    queue,
    streaming: false,
    sessionDir,
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
