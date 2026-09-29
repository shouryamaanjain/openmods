// A harness's `args`: arguments the modded build and a dev clone always
// start with, before the user's, such as Codex's switch for its own update
// check, which has no environment variable. A launcher written before they
// existed gets them with the daily check, without a rebuild.
import { beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cli, createHarness, createMod, git, sandbox } from "./harness"

const sb = sandbox("args")
const definition = path.join(sb.reg, "harnesses", "fake.json")
const setArgs = (args: string[] | undefined) => {
  const { args: _, ...rest } = JSON.parse(readFileSync(definition, "utf8"))
  writeFileSync(definition, JSON.stringify(args ? { ...rest, args } : rest))
}
const greet = async (...a: string[]) =>
  (await $`sh ${path.join(sb.om, "bin", "greet")} ${a}`.text()).trim()

beforeAll(async () => {
  await createHarness(sb)
  // Each argument in brackets, so their boundaries show.
  await createMod(sb, "echo", (dir) => writeFileSync(path.join(dir, "greet.sh"), "#!/bin/sh\nprintf 'args:'; printf '[%s]' \"$@\"; echo\n"))
  expect((await cli(sb, "install", "t/echo")).code).toBe(0)
})

describe("a harness's args", () => {
  test("come before the user's, and reach a build made before they existed with the next command", async () => {
    setArgs(undefined)
    await cli(sb, "status")
    expect(await greet("mine")).toBe("args:[mine]")
    setArgs(["-c", "check_for_update_on_startup=false", "it's quoted"])
    await cli(sb, "status")
    expect(await greet("mine", "too")).toBe("args:[-c][check_for_update_on_startup=false][it's quoted][mine][too]")
  })
  test("are passed to a clone under openmods dev", async () => {
    setArgs(["--from-openmods"])
    const clone = path.join(sb.T, "clone")
    await $`git clone -q ${sb.harness} ${clone}`.quiet()
    await git(clone, "checkout", "-q", "-b", "mine", "v1.0.0")
    writeFileSync(path.join(clone, "greet.sh"), "#!/bin/sh\nprintf 'dev:'; printf '[%s]' \"$@\"; echo\n")
    try {
      expect((await cli(sb, "dev", clone, "--fake")).code).toBe(0)
      expect(await greet("mine")).toBe("dev:[--from-openmods][mine]")
    } finally {
      await cli(sb, "dev", "--stop")
    }
  })
})

describe("a harness's argsUnless", () => {
  const setUnless = (u: object | undefined) => {
    const { argsUnless: _, ...rest } = JSON.parse(readFileSync(definition, "utf8"))
    writeFileSync(definition, JSON.stringify(u ? { ...rest, argsUnless: u } : rest))
  }
  test("come after args and before the user's, unless the user gives one of its words", async () => {
    setArgs(["-c", "x=1"])
    setUnless({ args: ["--no-daemon"], given: ["agents", "--remote", "--remote=*"] })
    await cli(sb, "status")
    expect(await greet()).toBe("args:[-c][x=1][--no-daemon]")
    expect(await greet("resume", "--last")).toBe("args:[-c][x=1][--no-daemon][resume][--last]")
    expect(await greet("agents")).toBe("args:[-c][x=1][agents]")
    expect(await greet("--remote", "ws://h")).toBe("args:[-c][x=1][--remote][ws://h]")
    expect(await greet("--remote=ws://h")).toBe("args:[-c][x=1][--remote=ws://h]")
    // After --, words are the user's text, not a command.
    expect(await greet("--", "agents")).toBe("args:[-c][x=1][--no-daemon][--][agents]")
    // A word inside a longer argument is not the word.
    expect(await greet("fix the agents page")).toBe("args:[-c][x=1][--no-daemon][fix the agents page]")
  })
  test("reach a clone under openmods dev too", async () => {
    const clone = path.join(sb.T, "clone-unless")
    await $`git clone -q ${sb.harness} ${clone}`.quiet()
    await git(clone, "checkout", "-q", "-b", "mine", "v1.0.0")
    writeFileSync(path.join(clone, "greet.sh"), "#!/bin/sh\nprintf 'dev:'; printf '[%s]' \"$@\"; echo\n")
    expect((await cli(sb, "dev", clone, "--fake")).code).toBe(0)
    expect(await greet()).toBe("dev:[-c][x=1][--no-daemon]")
    expect(await greet("agents")).toBe("dev:[-c][x=1][agents]")
    setUnless(undefined)
    setArgs(undefined)
    await cli(sb, "dev", "--stop")
  })
})

describe("a harness's stockWhen", () => {
  const set = (fields: Record<string, unknown>) => {
    const { stockWhen: _s, valueOptions: _v, ...rest } = JSON.parse(readFileSync(definition, "utf8"))
    writeFileSync(definition, JSON.stringify({ ...rest, ...fields }))
  }
  const run = async (...a: string[]) => {
    const r = await $`sh ${path.join(sb.om, "bin", "greet")} ${a}`.nothrow().quiet()
    return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString() }
  }
  const words = { stockWhen: ["agents", "--remote", "--remote=*"], valueOptions: ["-m", "--model"] }
  test("hands the command and options it names to the stock harness; a prompt or an option's value is not the command", async () => {
    set(words)
    await cli(sb, "status")
    expect((await run("agents")).out).toBe("stock greet")
    expect((await run("--remote=ws://h")).out).toBe("stock greet")
    expect((await run("-m", "gpt", "agents")).out).toBe("stock greet")
    // exec's prompt, a model named agents, and words after --: the modded build.
    expect((await run("exec", "agents")).out).toBe("args:[exec][agents]")
    expect((await run("-m", "agents", "hi")).out).toBe("args:[-m][agents][hi]")
    expect((await run("-m", "--remote", "hi")).out).toBe("args:[-m][--remote][hi]")
    expect((await run("--", "agents")).out).toBe("args:[--][agents]")
    expect((await run("resume")).out).toBe("args:[resume]")
  })
  test("with no stock harness to be found, stops and says so; the modded build never takes those runs", async () => {
    set(words)
    await cli(sb, "status")
    const stock = path.join(sb.home, ".greet")
    renameSync(stock, `${stock}.away`)
    try {
      const r = await run("agents")
      expect(r.code).toBe(127)
      expect(r.out).toBe("")
      expect(r.err).toContain("this runs your stock Fake, which was not found")
      expect((await run("hi")).out).toBe("args:[hi]")
    } finally {
      renameSync(`${stock}.away`, stock)
    }
  })
  test("a clone under openmods dev routes the same way", async () => {
    set(words)
    const clone = path.join(sb.T, "clone-stock")
    await $`git clone -q ${sb.harness} ${clone}`.quiet()
    await git(clone, "checkout", "-q", "-b", "mine", "v1.0.0")
    writeFileSync(path.join(clone, "greet.sh"), "#!/bin/sh\nprintf 'dev:'; printf '[%s]' \"$@\"; echo\n")
    expect((await cli(sb, "dev", clone, "--fake")).code).toBe(0)
    expect((await run("agents")).out).toBe("stock greet")
    expect((await run("exec", "agents")).out).toBe("dev:[exec][agents]")
    await cli(sb, "dev", "--stop")
    set({})
    await cli(sb, "status")
  })
})

describe("a harness's shared server", () => {
  const server = () => path.join(sb.home, ".srv", "current", "bin", "greet")
  const setServer = () => {
    const h = JSON.parse(readFileSync(definition, "utf8"))
    writeFileSync(definition, JSON.stringify({ ...h, sharedServer: { home: "~/.srv", binary: "current/bin/greet", versionFile: "current/package.json", reset: "server reset" } }))
  }
  const place = (text: string) => {
    mkdirSync(path.dirname(server()), { recursive: true })
    writeFileSync(server(), text, { mode: 0o755 })
  }
  test("set up from a modded build is pointed out, with the stock command that resets it", async () => {
    setServer()
    // An older openmods's build: its package's version carries the stamp. It
    // is read, never run: running it would print "ran".
    const ran = path.join(sb.T, "server-ran")
    place(`#!/bin/sh\ntouch ${ran}\n`)
    writeFileSync(path.join(sb.home, ".srv", "current", "package.json"), JSON.stringify({ version: "1.0.0+echo-1" }))
    expect((await cli(sb, "status")).out).toContain("was set up from a modded build, and your stock Fake uses it too. To give it back to your stock Fake, run: ~/.greet/bin/greet server reset")
    expect(existsSync(ran)).toBe(false)
    expect((await cli(sb, "update", "fake")).out).toContain("was set up from a modded build")
    // With no stock harness, the advice is to install it first, never the modded command.
    renameSync(path.join(sb.home, ".greet"), path.join(sb.home, ".greet.away"))
    const none = (await cli(sb, "status")).out
    renameSync(path.join(sb.home, ".greet.away"), path.join(sb.home, ".greet"))
    expect(none).toContain("To give it back to your stock Fake, install your stock Fake")
    writeFileSync(path.join(sb.home, ".srv", "current", "package.json"), JSON.stringify({ version: "1.0.0" }))
    // A copy of the current modded build.
    const artifact = JSON.parse(readFileSync(path.join(sb.om, "state.json"), "utf8")).fake.artifact
    place(readFileSync(artifact, "utf8"))
    expect((await cli(sb, "status")).out).toContain("was set up from a modded build")
  })
  test("stock's own is left unmentioned", async () => {
    place("#!/bin/sh\necho 1.0.0\n")
    expect((await cli(sb, "status")).out).not.toContain("background server")
    const { sharedServer: _, ...rest } = JSON.parse(readFileSync(definition, "utf8"))
    writeFileSync(definition, JSON.stringify(rest))
  })
})

