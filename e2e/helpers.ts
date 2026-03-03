import { $ } from "bun";

const BASE_URL = "http://localhost:5173";
const AGENT_BROWSER = `${process.env.HOME}/.bun/bin/agent-browser`;

/** Run an agent-browser command and return trimmed stdout. Throws on non-zero exit. */
export async function ab(...args: string[]): Promise<string> {
  const result = await $`${AGENT_BROWSER} ${args}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(
      `agent-browser ${args.join(" ")} failed (exit ${result.exitCode}):\n${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString().trim();
}

export async function open(path = "") {
  await ab("open", `${BASE_URL}${path}`);
}

export async function snapshot(): Promise<string> {
  return ab("snapshot");
}

export async function fill(selector: string, text: string) {
  await ab("fill", selector, text);
}

export async function click(selector: string) {
  await ab("click", selector);
}

export async function wait(ms: number) {
  await ab("wait", String(ms));
}

export async function screenshot(path: string) {
  await ab("screenshot", path);
}

/** Poll snapshot until predicate returns true or timeout (ms) expires. */
export async function waitForSnapshot(
  predicate: (snap: string) => boolean,
  timeoutMs = 15_000,
  intervalMs = 500,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = await snapshot();
    if (predicate(snap)) return snap;
    await Bun.sleep(intervalMs);
  }
  const final = await snapshot();
  throw new Error(`waitForSnapshot timed out. Last snapshot:\n${final}`);
}

/** Assert dev servers are reachable before running tests. */
export async function assertServersUp() {
  const checks = [
    fetch("http://localhost:5173/").then((r) => {
      if (!r.ok) throw new Error(`Frontend returned ${r.status}`);
    }),
    fetch("http://localhost:3001/").then((r) => {
      if (!r.ok) throw new Error(`Backend returned ${r.status}`);
    }),
  ];
  await Promise.all(checks).catch(() => {
    throw new Error(
      "Dev servers not running. Start them with: bun run dev",
    );
  });
}
