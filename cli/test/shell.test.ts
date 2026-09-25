// The launcher and the shell. bash remembers where it found a command, so the
// launcher stays at ~/.openmods/bin/<binary> from the first install on and
// starts the stock harness while the mods are off: `openmods off` and
// `openmods on` then work in a terminal that already ran it. Only a terminal
// older than the launcher can miss it, and it is told how to fix that.
import { beforeAll, describe, expect, test } from "bun:test"
import { renameSync, symlinkSync } from "node:fs"
import path from "node:path"
import { CLI, createHarness, createMod, greeting, sandbox, setGreeting } from "./harness"

const sb = sandbox("shell")
const bin = () => path.join(sb.om, "bin")
const stockDir = () => path.join(sb.home, ".greet", "bin")

// One bash session: `lines` run in order, sharing bash's memory of commands.
// The lines are fixed text; paths reach them as quoted variables ($BIN,
// $LINK, and the CLI and registry in the `openmods` function).
async function bash(lines: string[], vars: Record<string, string> = {}) {
  const script = ['openmods() { bun "$OM_CLI" --registry "$OM_REG" --no-path "$@"; }', ...lines].join("\n")
  const p = Bun.spawn(["bash", "--norc", "--noprofile", "-c", script], {
    env: {
      HOME: sb.home,
      OPENMODS_HOME: sb.om,
      OPENMODS_NO_CHECK: "1",
      OPENMODS_NO_PROMPT: "1",
      OM_CLI: CLI,
      OM_REG: sb.reg,
      BIN: bin(),
      PATH: [bin(), stockDir(), path.dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      ...vars,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out, err, all: out + err }
}

beforeAll(async () => {
  await createHarness(sb)
  await createMod(sb, "friendly", setGreeting("hello from friendly"))
})

// The CLI run from its own shell, as from a terminal: one that has been open
// for `age` seconds when it runs the command.
async function fromShell(age: number, ...a: string[]) {
  const p = Bun.spawn(["sh", "-c", `sleep ${age}; bun "$@"; exit $?`, "sh", CLI, ...a, "--registry", sb.reg, "--no-path"], {
    env: { ...process.env, SHELL: "/bin/bash", PATH: `${bin()}:${process.env.PATH}`, HOME: sb.home, OPENMODS_HOME: sb.om, OPENMODS_NO_CHECK: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out, all: out + err }
}

describe("the first install", () => {
  test("tells a terminal older than the launcher how to pick it up", async () => {
    const r = await fromShell(3, "install", "t/friendly")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("If `greet` still starts your stock Fake in a terminal that ran it before, run `hash -r` there once")
    // Not a terminal opened after the launcher appeared.
    const again = await fromShell(0, "update", "fake", "--force")
    expect(again.code, again.all).toBe(0)
    expect(again.out).not.toContain("hash -r")
  })
})

describe("in a bash that already ran greet", () => {
  test("off, then on, run the right one", async () => {
    const r = await bash(["greet", "openmods off >/dev/null", "greet", "openmods on >/dev/null", "greet"])
    expect(r.err).not.toContain("No such file")
    expect(r.out.trim().split("\n")).toEqual(["hello from friendly", "stock greet", "hello from friendly"])
  })
  test("after the last mod is uninstalled, greet is the stock one", async () => {
    const r = await bash(["greet", "openmods uninstall t/friendly >/dev/null", "greet"])
    expect(r.out.trim().split("\n")).toEqual(["hello from friendly", "stock greet"])
  })
})

describe("with the mods off", () => {
  test("a stock harness that is gone is said plainly", async () => {
    renameSync(stockDir(), `${stockDir()}.away`)
    try {
      const r = await bash(["greet"])
      expect(r.code).toBe(127)
      expect(r.err).toContain("greet: your stock Fake was not found. Install it, or run `openmods on` for the modded build.")
    } finally {
      renameSync(`${stockDir()}.away`, stockDir())
    }
  })
  test("never starts itself, however PATH reaches it", async () => {
    const link = path.join(sb.T, "link-to-bin")
    symlinkSync(bin(), link)
    const r = await bash(['PATH="$LINK:.:$PATH"', 'cd "$BIN"', "greet"], { LINK: link })
    expect(r.code, r.all).toBe(0)
    expect(r.out.trim()).toBe("stock greet")
  })
  test("arguments reach the stock harness", async () => {
    expect(await greeting(sb)).toBe("stock greet")
    expect((await bash(["greet --version"])).out.trim()).toBe("1.0.0")
  })
})
