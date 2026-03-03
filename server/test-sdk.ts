import { query } from "@anthropic-ai/claude-agent-sdk";

console.log("Starting query...");

const q = query({
  prompt: "Say hello in one word",
  options: {
    model: "claude-sonnet-4-6",
    allowedTools: [],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    env: { ...process.env, CLAUDECODE: undefined },
  },
});

console.log("Query created, iterating...");

for await (const msg of q) {
  console.log(`[${msg.type}]`, JSON.stringify(msg).slice(0, 200));
  if (msg.type === "result") break;
}

console.log("Done");
