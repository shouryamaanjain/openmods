// The launcher and the shell. bash remembers where it found a command, so the
// launcher stays at ~/.openmods/bin/<binary> from the first install on and
// starts the stock harness while the mods are off: `openmods off` and
// `openmods on` then work in a terminal that already ran it. Only the first
// install can be missed by such a terminal, and a bash user is told how to
// fix that.
import { beforeAll, describe, expect, test } from "bun:test"
import { rmSync, renameSync } from "node:fs"
import path from "node:path"
import { CLI, createHarness, createMod, greeting, run, sandbox, setGreeting } from "./harness"

const sb = sandbox("shell")
const bin = () => path.join(sb.om, "bin")
const stockDir = () => path.join(sb.home, ".greet", "bin")

// One bash session: `lines` run in order, sharing bash's memory of commands.
async function bash(lines: string[]) {
  const openmods = `bun ${CLI} --registry ${sb.reg} --no-path`
  const script = lines.map((l) => l.replace(/^openmods /, `${openmods} `)).join("\n")
  const p = Bun.spawn(["bash", "--norc", "--noprofile", "-c", script], {
    env: {
      HOME: sb.home,
      OPENMODS_HOME: sb.om,
      OPENMODS_NO_CHECK: "1",
      OPENMODS_NO_PROMPT: "1",
      PATH: `${bin()}:${stockDir()}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
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

describe("the first install", () => {
  test("tells a bash user how to have a terminal that ran the stock harness pick it up", async () => {
    const env = { SHELL: "/bin/bash", PATH: `${bin()}:${process.env.PATH}` }
    const r = await run(sb, { env }, "install", "t/friendly")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("If `greet` still starts your stock Fake in a terminal that ran it before, run `hash -r` there once")
    // Only when the launcher is new.
    const again = await run(sb, { env }, "update", "fake", "--force")
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
  test("arguments reach the stock harness", async () => {
    rmSync(path.join(sb.T, "none"), { force: true })
    expect(await greeting(sb)).toBe("stock greet")
    expect((await bash(["greet --version"])).out.trim()).toBe("1.0.0")
  })
})
