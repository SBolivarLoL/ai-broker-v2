import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const launcher = resolve(import.meta.dir, "../../scripts/alpaca.sh");

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ai-broker-alpaca-"));
  const fake = join(directory, "alpaca");
  await mkdir(join(directory, "home"));
  await writeFile(fake, `#!/bin/sh
printf 'args=%s\\n' "$*"
printf 'api=%s\\n' "\${ALPACA_API_KEY-absent}"
printf 'secret=%s\\n' "\${ALPACA_SECRET_KEY-absent}"
printf 'live=%s\\n' "\${ALPACA_LIVE_TRADE-absent}"
printf 'quiet=%s\\n' "\${ALPACA_QUIET-absent}"
printf 'profile=%s\\n' "\${ALPACA_PROFILE-absent}"
printf 'sec=%s\\n' "\${SEC_USER_AGENT-absent}"
printf 'apca_id=%s\\n' "\${APCA_API_KEY_ID-absent}"
printf 'apca_secret=%s\\n' "\${APCA_API_SECRET_KEY-absent}"
printf 'openai=%s\\n' "\${OPENAI_API_KEY-absent}"
printf 'preview=%s\\n' "\${PREVIEW_SECRET-absent}"
exit "\${FAKE_EXIT:-0}"
`);
  await chmod(fake, 0o755);
  return directory;
}

async function run(
  directory: string,
  args: string[],
  overrides: Record<string, string | undefined> = {},
) {
  const env: Record<string, string> = {
    PATH: `${directory}:${process.env.PATH ?? ""}`,
    HOME: join(directory, "home"),
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) env[key] = value;
  }
  const child = Bun.spawn(["sh", launcher, ...args], {
    cwd: directory,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status: await child.exited, stdout, stderr };
}

test("Bun dotenv parsing accepts the example contact value and maps paper credentials", async () => {
  const directory = await fixture();
  try {
    await writeFile(join(directory, ".env"), `APCA_API_KEY_ID=dotenv-key
APCA_API_SECRET_KEY=dotenv-secret
SEC_USER_AGENT=ai-broker-v2 your-email@example.com
`);
    const result = await run(directory, ["account", "get"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("args=account get");
    expect(result.stdout).toContain("api=dotenv-key");
    expect(result.stdout).toContain("secret=dotenv-secret");
    expect(result.stdout).toContain("live=false");
    expect(result.stdout).toContain("quiet=1");
    expect(result.stdout).toContain("sec=ai-broker-v2 your-email@example.com");
    expect(result.stdout).toContain("apca_id=absent");
    expect(result.stdout).toContain("apca_secret=absent");

    for (const args of [
      ["order", "list"],
      ["order", "list", "--status", "open"],
      ["order", "list", "--status=open"],
    ]) {
      const orderList = await run(directory, args, {
        APCA_API_KEY_ID: "dotenv-key",
        APCA_API_SECRET_KEY: "dotenv-secret",
      });
      expect(orderList.status).toBe(0);
      expect(orderList.stdout).toContain(`args=${args.join(" ")}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("diagnostics strip inherited Alpaca profile and live/debug controls", async () => {
  const directory = await fixture();
  try {
    const result = await run(directory, ["doctor"], {
      APCA_API_KEY_ID: "key with no shell parsing",
      APCA_API_SECRET_KEY: "secret with no shell parsing",
      ALPACA_API_KEY: "inherited-leak",
      ALPACA_SECRET_KEY: "inherited-leak",
      ALPACA_LIVE_TRADE: "true",
      ALPACA_PROFILE: "live",
      ALPACA_DEBUG: "1",
      OPENAI_API_KEY: "inherited-leak",
      PREVIEW_SECRET: "inherited-leak",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("api=key with no shell parsing");
    expect(result.stdout).toContain("secret=secret with no shell parsing");
    expect(result.stdout).toContain("live=false");
    expect(result.stdout).toContain("profile=absent");
    expect(result.stdout).toContain("apca_id=absent");
    expect(result.stdout).toContain("apca_secret=absent");
    expect(result.stdout).toContain("openai=absent");
    expect(result.stdout).toContain("preview=absent");
    expect(result.stdout).not.toContain("inherited-leak");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing credentials and mutation commands fail before invoking the CLI", async () => {
  const directory = await fixture();
  try {
    const missing = await run(directory, ["account", "get"], {
      APCA_API_KEY_ID: undefined,
      APCA_API_SECRET_KEY: undefined,
    });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("APCA_API_KEY_ID is required");
    expect(missing.stdout).toBe("");

    const missingSecret = await run(directory, ["account", "get"], {
      APCA_API_KEY_ID: "key",
      APCA_API_SECRET_KEY: undefined,
    });
    expect(missingSecret.status).toBe(2);
    expect(missingSecret.stderr).toContain("APCA_API_SECRET_KEY is required");
    expect(missingSecret.stdout).toBe("");

    for (const args of [
      ["order", "submit"],
      ["order", "cancel", "id"],
      ["position", "close", "AAPL"],
      ["api", "get"],
      ["profile", "list"],
      ["doctor", "--debug"],
      ["order", "list", "--status", "closed"],
    ]) {
      const rejected = await run(directory, args, {
        APCA_API_KEY_ID: "key",
        APCA_API_SECRET_KEY: "secret",
      });
      expect(rejected.status).toBe(2);
      expect(rejected.stderr).toContain("Only read-only Alpaca diagnostics");
      expect(rejected.stdout).toBe("");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("help and version work without credentials and diagnostic exit codes propagate", async () => {
  const directory = await fixture();
  try {
    const help = await run(directory, ["help", "order", "list"], {
      APCA_API_KEY_ID: undefined,
      APCA_API_SECRET_KEY: undefined,
      ALPACA_PROFILE: "live",
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("args=help order list");
    expect(help.stdout).toContain("profile=absent");

    const version = await run(directory, ["--version"], {
      APCA_API_KEY_ID: undefined,
      APCA_API_SECRET_KEY: undefined,
    });
    expect(version.status).toBe(0);

    const propagated = await run(directory, ["doctor"], {
      APCA_API_KEY_ID: "key",
      APCA_API_SECRET_KEY: "secret",
      FAKE_EXIT: "23",
    });
    expect(propagated.status).toBe(23);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
