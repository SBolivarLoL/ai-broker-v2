type Invocation = {
  args: string[];
  needsCredentials: boolean;
};

const helpTopics = new Set([
  "",
  "doctor",
  "account",
  "account get",
  "position",
  "position list",
  "order",
  "order list",
]);

const diagnosticArgs = new Map<string, string[][]>([
  ["doctor", [[]]],
  ["account get", [[]]],
  ["position list", [[]]],
  ["order list", [[], ["--status", "open"], ["--status=open"]]],
]);

function topicFor(args: string[]) {
  return args.join(" ");
}

function isHelpInvocation(args: string[]) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return true;
  }
  if (args[0] === "help") {
    return helpTopics.has(topicFor(args.slice(1)));
  }
  const flag = args.at(-1);
  if (flag !== "--help" && flag !== "-h") {
    return false;
  }
  return helpTopics.has(topicFor(args.slice(0, -1)));
}

export function classifyInvocation(args: string[]): Invocation {
  if (args.length === 1 && (args[0] === "version" || args[0] === "--version")) {
    return { args, needsCredentials: false };
  }
  if (isHelpInvocation(args)) {
    return { args, needsCredentials: false };
  }

  const command = args[0] === "doctor" ? "doctor" : topicFor(args.slice(0, 2));
  const commandLength = command === "doctor" ? 1 : 2;
  const allowed = diagnosticArgs.get(command);
  if (allowed?.some((candidate) =>
    candidate.length === args.length - commandLength &&
    candidate.every((value, index) => value === args[index + commandLength])
  )) {
    return { args, needsCredentials: true };
  }

  throw new Error(
    "Only read-only Alpaca diagnostics are available: doctor, account get, position list, and order list --status open.",
  );
}

function childEnvironment(includeCredentials: boolean) {
  const inherited = Object.entries(process.env).filter(([key, value]) =>
    value !== undefined && !key.startsWith("ALPACA_") &&
    !key.startsWith("APCA_") &&
    !/(?:API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|USER_ID)(?:_|$)/i.test(key),
  ) as Array<[string, string]>;
  if (!includeCredentials) return Object.fromEntries(inherited);
  return Object.fromEntries([
    ...inherited,
    ["ALPACA_API_KEY", process.env.APCA_API_KEY_ID!],
    ["ALPACA_SECRET_KEY", process.env.APCA_API_SECRET_KEY!],
    ["ALPACA_LIVE_TRADE", "false"],
    ["ALPACA_QUIET", "1"],
  ]);
}

function requireCredentials() {
  if (!process.env.APCA_API_KEY_ID?.trim()) {
    throw new Error("APCA_API_KEY_ID is required for Alpaca diagnostics.");
  }
  if (!process.env.APCA_API_SECRET_KEY?.trim()) {
    throw new Error("APCA_API_SECRET_KEY is required for Alpaca diagnostics.");
  }
}

export async function main(args = Bun.argv.slice(2)) {
  let invocation: Invocation;
  try {
    invocation = classifyInvocation(args);
    if (invocation.needsCredentials) requireCredentials();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const binary = Bun.which("alpaca");
  if (!binary) {
    console.error("Install alpacahq/tap/cli (alpaca executable not found in PATH).");
    return 1;
  }

  try {
    const child = Bun.spawn([binary, ...invocation.args], {
      cwd: process.cwd(),
      env: childEnvironment(invocation.needsCredentials),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return await child.exited;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) process.exit(await main());
