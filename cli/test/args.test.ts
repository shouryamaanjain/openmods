// A harness's `args`: arguments the modded build and a dev clone always
// start with, before the user's, such as Codex's switch for its own update
// check, which has no environment variable. A launcher written before they
// existed gets them with the daily check, without a rebuild.
import { beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs"
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
      expect(r.err).toContain("this is for your stock Fake, which was not found")
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


describe("a harness's sameRelease", () => {
  const stock = () => path.join(sb.home, ".greet", "bin", "greet")
  const ran = () => path.join(sb.T, "stock-ran")
  // A stock program that says its release inside it, and says so when it runs.
  // Written in place, as an update might; its time a little ahead, so it is
  // newer than the release the launcher read before, within the same second.
  let ahead = 0
  const placeStock = (version: string) => {
    writeFileSync(stock(), `#!/bin/sh\n# user-agent=fake/latest/${version}/cli\ntouch ${ran()}\necho stock greet\n`, { mode: 0o755 })
    const t = Date.now() / 1000 + 10 * ++ahead
    utimesSync(stock(), t, t)
  }
  const set = (same: object | undefined) => {
    const { sameRelease: _s, valueOptions: _v, ...rest } = JSON.parse(readFileSync(definition, "utf8"))
    writeFileSync(definition, JSON.stringify(same ? { ...rest, valueOptions: ["--server"], sameRelease: same } : rest))
  }
  const same = (extra: object = {}) => ({
    stockVersion: "user-agent=fake/[^/ ]*/([0-9][0-9.]*)/cli",
    stockWhen: ["service", "--service"],
    env: { SHARED_DB: "1" },
    envUnlessModsChange: ["db/**"],
    argsLast: { args: ["--standalone"], unless: ["serve", "--server", "--server=*"] },
    ...extra,
  })
  // The modded build shows its env as well as its arguments.
  const showEnv = () => {
    const artifact = JSON.parse(readFileSync(path.join(sb.om, "state.json"), "utf8")).fake.artifact
    writeFileSync(artifact, "#!/bin/sh\nprintf 'args:'; printf '[%s]' \"$@\"; echo \" db:${SHARED_DB:-own}\"\n", { mode: 0o755 })
  }
  const run = async (...a: string[]) => (await $`sh ${path.join(sb.om, "bin", "greet")} ${a}`.nothrow().quiet()).stdout.toString().trim()
  const original = () => readFileSync(stock(), "utf8")
  let before = ""

  test("the same release as the stock one: its uses go to stock, env set, args after the user's", async () => {
    before = original()
    placeStock("1.0.0")
    set(same())
    await cli(sb, "status")
    // status shows the stock version by running it; the launcher never does.
    rmSync(ran(), { force: true })
    showEnv()
    expect(await run()).toBe("args:[--standalone] db:1")
    expect(await run("session", "list")).toBe("args:[session][list][--standalone] db:1")
    expect(await run("run", "--", "hi")).toBe("args:[run][--standalone][--][hi] db:1")
    expect(await run("serve")).toBe("args:[serve] db:1")
    expect(await run("--server", "http://h", "list")).toBe("args:[--server][http://h][list] db:1")
    // The stock program was read for its release, never run.
    expect(existsSync(ran())).toBe(false)
    expect(await run("service", "stop")).toBe("stock greet")
    expect(await run("serve", "--service")).toBe("stock greet")
    // A value of --server is not the command.
    expect(await run("--server", "service")).toBe("args:[--server][service] db:1")
  })
  test("another release: nothing changes, and a stock program that changes is read again", async () => {
    rmSync(ran(), { force: true })
    placeStock("1.0.1")
    expect(await run()).toBe("args:[] db:own")
    expect(await run("service", "stop")).toBe("args:[service][stop] db:own")
    placeStock("1.0.0")
    expect(await run()).toBe("args:[--standalone] db:1")
    expect(existsSync(ran())).toBe(false)
  })
  test("mods that change the files envUnlessModsChange names keep their own data; the rest still applies", async () => {
    set(same({ envUnlessModsChange: ["*.sh"] }))
    await cli(sb, "status")
    showEnv()
    expect(await run()).toBe("args:[--standalone] db:own")
    expect(await run("service")).toBe("stock greet")
  })
  test("a build from before its changed files were kept counts as changing them", async () => {
    set(same())
    const file = path.join(sb.om, "state.json")
    const state = JSON.parse(readFileSync(file, "utf8"))
    delete state.fake.changed
    writeFileSync(file, JSON.stringify(state))
    await cli(sb, "status")
    showEnv()
    expect(await run()).toBe("args:[--standalone] db:own")
  })
  test("OpenCode's own rules", async () => {
    const opencode = JSON.parse(readFileSync(path.resolve(import.meta.dir, "../../harnesses/opencode.json"), "utf8"))
    const { sameRelease: _s, valueOptions: _v, ...rest } = JSON.parse(readFileSync(definition, "utf8"))
    writeFileSync(definition, JSON.stringify({ ...rest, valueOptions: opencode.valueOptions, sameRelease: opencode.sameRelease }))
    // Its release as OpenCode's program carries it.
    writeFileSync(stock(), `#!/bin/sh\n# --user-agent=opencode/latest/1.0.0/cli\necho stock greet\n`, { mode: 0o755 })
    const t = Date.now() / 1000 + 10 * ++ahead
    utimesSync(stock(), t, t)
    const file = path.join(sb.om, "state.json")
    const setChanged = async (changed: string[]) => {
      const state = JSON.parse(readFileSync(file, "utf8"))
      writeFileSync(file, JSON.stringify({ ...state, fake: { ...state.fake, changed } }))
      await cli(sb, "status")
      showEnv()
    }
    await setChanged(["packages/tui/src/app.tsx"])
    const on = "OPENCODE_DISABLE_CHANNEL_DB"
    expect(await run()).toBe("args:[--standalone] db:own")
    expect(readFileSync(path.join(sb.om, "bin", "greet"), "utf8")).toContain(`export ${on}='1'`)
    for (const uses of [["service", "stop"], ["pair"], ["mcp", "list"], ["plugin", "list"], ["debug", "paths"], ["serve", "--service"]]) expect(await run(...uses)).toBe("stock greet")
    for (const own of [["serve"], ["upgrade"], ["update"], ["uninstall"], ["acp"], ["--server", "http://h"], ["--standalone"]]) expect(await run(...own)).toBe(`args:${own.map((a) => `[${a}]`).join("")} db:own`)
    expect(await run("session", "list")).toBe("args:[session][list][--standalone] db:own")
    expect(await run("-s", "service", "run", "--", "x")).toBe("args:[-s][service][run][--standalone][--][x] db:own")
    // Mods that change OpenCode's tables or migrations keep their own database.
    for (const changed of ["packages/core/src/database/migration/20260101_x.ts", "packages/core/src/session/sql.ts", "packages/core/src/database/schema.sql.ts"]) {
      await setChanged([changed])
      expect(readFileSync(path.join(sb.om, "bin", "greet"), "utf8")).not.toContain(on)
    }
    set(same())
  })
  test("with no stock harness, nothing changes", async () => {
    renameSync(path.join(sb.home, ".greet"), path.join(sb.home, ".greet.away"))
    try {
      expect(await run()).toBe("args:[] db:own")
      expect(await run("service")).toBe("args:[service] db:own")
    } finally {
      renameSync(path.join(sb.home, ".greet.away"), path.join(sb.home, ".greet"))
      writeFileSync(stock(), before, { mode: 0o755 })
      set(undefined)
      await cli(sb, "status")
    }
  })
})

describe("a harness's stockMarker", () => {
  const stock = () => path.join(sb.home, ".greet", "bin", "greet")
  const setMarker = (marker: string | undefined) => {
    const { stockMarker: _m, ...rest } = JSON.parse(readFileSync(definition, "utf8"))
    writeFileSync(definition, JSON.stringify(marker ? { ...rest, stockMarker: marker } : rest))
  }
  // Another program of the same name, first on PATH.
  const other = path.join(sb.T, "other-bin")
  const run = async (...a: string[]) => {
    const r = await $`sh ${path.join(sb.om, "bin", "greet")} ${a}`.env({ ...process.env, PATH: `${other}:${process.env.PATH}` }).nothrow().quiet()
    return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString() }
  }
  let before = ""
  test("only a program carrying it is the stock harness: a namesake first on PATH is passed over", async () => {
    before = readFileSync(stock(), "utf8")
    mkdirSync(other, { recursive: true })
    writeFileSync(path.join(other, "greet"), "#!/bin/sh\necho a namesake\n", { mode: 0o755 })
    writeFileSync(stock(), "#!/bin/sh\n# made by greet.example\necho stock greet\n", { mode: 0o755 })
    setMarker("greet\\.example")
    expect((await cli(sb, "off")).code).toBe(0)
    expect((await run()).out).toBe("stock greet")
  })
  test("without it, nothing is the stock harness", async () => {
    writeFileSync(stock(), "#!/bin/sh\necho stock greet\n", { mode: 0o755 })
    const r = await run()
    expect(r.code).toBe(127)
    expect(r.err).toContain("your stock Fake was not found")
    expect((await cli(sb, "status")).out).not.toContain(".greet/bin/greet")
  })
  test("setup puts no launcher in front of a namesake", async () => {
    setMarker("greet\\.example")
    const launcher = path.join(sb.om, "bin", "greet")
    const kept = readFileSync(launcher, "utf8")
    rmSync(launcher)
    try {
      await cli(sb, "setup")
      expect(existsSync(launcher)).toBe(false)
    } finally {
      writeFileSync(launcher, kept, { mode: 0o755 })
      writeFileSync(stock(), before, { mode: 0o755 })
      setMarker(undefined)
      expect((await cli(sb, "on")).code).toBe(0)
    }
  })
})
