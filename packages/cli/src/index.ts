import { constants } from "node:fs";
import { lstat, mkdir, open, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type AgentConnectionState,
  AgentSession,
  BROWSER_TOOLS,
  type BrowserTool,
  type Ledger,
  PRIVATE_DELIVERY_WARNING,
  RemoteTabError,
  createSession,
} from "@remote-tab/client";

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Arguments {
  command: string;
  state?: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
  ttl?: number;
  out?: string;
}

export const COMMANDS = [
  "create",
  "wait-ready",
  ...BROWSER_TOOLS,
  "remote_tab_handoff",
  "remote_tab_status",
  "remote_tab_stop",
  "handoff",
  "status",
  "stop",
  "ledger export",
  "ledger render",
] as const;

const aliases: Record<string, string> = {
  handoff: "remote_tab_handoff",
  status: "remote_tab_status",
  stop: "remote_tab_stop",
};
function invalid(message: string): never {
  throw new CliError("invalid_arguments", message);
}

/** Strict, side-effect-free parsing: complete validation happens before any network request. */
export function parseArgs(argv: string[]): Arguments {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { command: "help", args: {} };
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [name, inline] = arg.split(/=(.*)/s, 2);
    if (!["--state", "--args", "--timeout-ms", "--ttl", "--out"].includes(name))
      invalid(`Unknown flag: ${name}`);
    if (flags.has(name)) invalid(`Duplicate flag: ${name}`);
    const value = inline ?? argv[++i];
    if (!value || value.startsWith("--")) invalid(`Missing value for ${name}`);
    flags.set(name, value);
  }
  let command = positionals.shift() ?? "help";
  if (command === "ledger") command += ` ${positionals.shift() ?? ""}`;
  if (command === "help" && flags.size === 0 && positionals.length === 0)
    return { command, args: {} };
  if (!(COMMANDS as readonly string[]).includes(command)) invalid("Unknown command; use --help");
  command = aliases[command] ?? command;
  const browser = (BROWSER_TOOLS as readonly string[]).includes(command);
  const takesArgs = browser || command === "remote_tab_handoff";
  const json = flags.get("--args") ?? positionals.shift();
  if (positionals.length) invalid("Unexpected positional arguments");
  if (json !== undefined && !takesArgs) invalid("This command does not accept JSON arguments");
  let args: Record<string, unknown> = {};
  if (json !== undefined) {
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      invalid("Arguments must be valid JSON");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value))
      invalid("Arguments must be a JSON object");
    args = value as Record<string, unknown>;
  }
  if (
    command === "remote_tab_handoff" &&
    (typeof args.message !== "string" ||
      !args.message.trim() ||
      Object.keys(args).some((key) => key !== "message"))
  )
    invalid('Handoff requires {"message":"..."}');
  const result: Arguments = { command, args, state: flags.get("--state"), out: flags.get("--out") };
  for (const [flag, key] of [
    ["--timeout-ms", "timeoutMs"],
    ["--ttl", "ttl"],
  ] as const) {
    const value = flags.get(flag);
    if (value !== undefined) {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)
        invalid(`${flag} must be a positive integer`);
      result[key] = Number(value);
    }
  }
  if (result.ttl !== undefined && (command !== "create" || result.ttl < 60 || result.ttl > 3600))
    invalid("--ttl is only for create and must be 60..3600 seconds");
  if (result.out !== undefined && !command.startsWith("ledger "))
    invalid("--out is only for ledger");
  if (command.startsWith("ledger ") && !result.out) invalid("Ledger requires --out");
  if (command === "ledger render" && !/\.(gif|webm)$/i.test(result.out as string))
    invalid("ledger render --out must be a .gif or .webm path");
  return result;
}

export function defaultStatePath(env: Record<string, string | undefined>): string {
  return join(
    env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"),
    "remote-tab",
    "session.json",
  );
}

async function reserveState(path: string) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const parent = await lstat(directory);
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0)
    throw new CliError(
      "private_state_required",
      "State must be inside a private directory (mode 0700); create one with mkdir -m 700 and use --state DIR/session.json",
    );
  // Exclusive creation reserves the pathname before creating a remote session.
  return open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
}

async function loadState(path: string): Promise<AgentConnectionState> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0)
      throw new CliError(
        "private_state_required",
        "State must be a private regular file (mode 0600)",
      );
    return JSON.parse(await file.readFile("utf8")) as AgentConnectionState;
  } finally {
    await file.close();
  }
}

/** Write only after the client has verified the complete ledger and decrypted its attachments. */
export async function exportLedger(ledger: Ledger, output: string) {
  await mkdir(output, { mode: 0o700 }); // No recursive/existing-directory acceptance.
  try {
    const entries = [];
    for (const entry of ledger.entries) {
      const body = entry.envelope.body as { screenshot?: { blob_id?: string } };
      const attachments = [];
      for (const [index, attachment] of entry.attachments.entries()) {
        const screenshot =
          attachment.reference.blob_id === body.screenshot?.blob_id &&
          attachment.reference.mime_type === "image/png";
        const directory = screenshot ? "shots" : "blobs";
        const file = `${directory}/${String(entry.message.seq).padStart(6, "0")}-${index}.${screenshot ? "png" : "bin"}`;
        await mkdir(join(output, directory), { recursive: true, mode: 0o700 });
        await writeFile(join(output, file), attachment.bytes, { flag: "wx", mode: 0o600 });
        attachments.push({ reference: attachment.reference, file });
      }
      entries.push({ message: entry.message, envelope: entry.envelope, attachments });
    }
    await writeFile(
      join(output, "ledger.json"),
      `${JSON.stringify({ sessionId: ledger.sessionId, status: ledger.status, entries }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    return { sessionId: ledger.sessionId, out: output, entries: entries.length };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

export async function execute(
  args: Arguments,
  env: Record<string, string | undefined> = process.env,
): Promise<unknown> {
  if (args.command === "help")
    return {
      usage: "remote-tab COMMAND [JSON | --args JSON] [--state FILE] [--timeout-ms MS]",
      commands: COMMANDS,
      create: "create [--ttl 60..3600]; requires REMOTE_TAB_SERVER_URL and REMOTE_TAB_API_KEY",
      state:
        "Private local state; default $XDG_STATE_HOME/remote-tab/session.json or ~/.local/state/remote-tab/session.json. Create refuses overwrite; use a different --state for each session.",
      ledger:
        "ledger export --out NEW_DIRECTORY | ledger render --out FILE.gif|FILE.webm (M3 extension renderer)",
      handoff: 'handoff {"message":"Your turn"}; waits for human Done',
    };
  if (args.command === "ledger render")
    throw new CliError(
      "unsupported",
      "GIF/WebM rendering comes with the M3 extension page renderer. Use ledger export --out DIRECTORY to save the verified ledger now.",
    );
  const statePath = resolve(args.state ?? defaultStatePath(env));
  const options =
    args.timeoutMs === undefined
      ? {}
      : { timeoutMs: args.timeoutMs, requestTimeoutMs: args.timeoutMs };
  if (args.command === "create") {
    if (!env.REMOTE_TAB_SERVER_URL || !env.REMOTE_TAB_API_KEY)
      throw new CliError(
        "configuration",
        "Create requires REMOTE_TAB_SERVER_URL and REMOTE_TAB_API_KEY",
      );
    const reservation = await reserveState(statePath);
    try {
      const { code, session } = await createSession({
        serverUrl: env.REMOTE_TAB_SERVER_URL,
        apiKey: env.REMOTE_TAB_API_KEY,
        ttl: args.ttl,
        ...options,
      });
      await reservation.writeFile(`${JSON.stringify(session.exportState())}\n`);
      await reservation.sync();
      return { code, warning: PRIVATE_DELIVERY_WARNING, state: statePath };
    } catch (error) {
      await rm(statePath, { force: true });
      throw error;
    } finally {
      await reservation.close();
    }
  }
  const session = AgentSession.resume(await loadState(statePath), options);
  switch (args.command) {
    case "wait-ready":
      return session.waitReady(options);
    case "remote_tab_status":
      return session.status(options);
    case "remote_tab_stop":
      return session.stop();
    case "remote_tab_handoff":
      await session.handoff(args.args.message as string, options);
      return { ok: true };
    case "ledger export":
      return exportLedger(await session.ledger(), resolve(args.out as string));
    default:
      return session.send(args.command as BrowserTool, args.args, options);
  }
}

/** Exactly one JSON value on stdout on success, or one JSON error on stderr on failure. */
export async function runCLI(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  try {
    const result = await execute(parseArgs(argv), env);
    if (result && typeof result === "object" && "ok" in result && result.ok === false) {
      console.error(JSON.stringify(result));
      return 1;
    }
    console.log(
      JSON.stringify(result, (_key, value) =>
        value instanceof Uint8Array
          ? { encoding: "base64", data: Buffer.from(value).toString("base64") }
          : value,
      ),
    );
    return 0;
  } catch (error) {
    // Do not echo arbitrary exceptions: filesystem/JSON/transport failures can include private state.
    const known = error instanceof CliError || error instanceof RemoteTabError;
    const code = known
      ? error.code
      : error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "cli_error";
    console.error(
      JSON.stringify({
        error: {
          code,
          message: known
            ? error.message
            : "Command failed; check configuration, private state, and output paths",
        },
      }),
    );
    return 1;
  }
}
