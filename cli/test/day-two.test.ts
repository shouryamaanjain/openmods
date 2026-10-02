// What a user meets in their first days: naming a harness with its flag on
// on, off and update; an update that leaves the build a running session uses;
// and a shell startup file OpenMods cannot write.
import { beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cli, createHarness, createMod, greeting, registerHarness, run, sandbox, setGreeting } from "./harness"

const sb = sandbox("day-two")
const builds = () => readdirSync(path.join(sb.om, "harnesses", "fake", "builds")).filter((d) => !d.startsWith(".")).sort()
const helloRuns = () => readFileSync(path.join(sb.om, "bin", "hello"), "utf8")
const running = () => path.dirname(JSON.parse(readFileSync(path.join(sb.om, "state.json"), "utf8")).fake.artifact)

beforeAll(async () => {
  await createHarness(sb)
  registerHarness(sb, { id: "other", name: "Other", binary: "hello" })
  await createMod(sb, "friendly", setGreeting("hello from friendly"))
  await createMod(sb, "lonely", setGreeting("hello from lonely"), { harness: "other" })
  expect((await cli(sb, "install", "t/friendly", "--fake", "--yes")).code).toBe(0)
  expect((await cli(sb, "install", "t/lonely", "--other", "--yes")).code).toBe(0)
})

describe("a harness flag on on, off and update", () => {
  test("off --other switches only that harness", async () => {
    const r = await cli(sb, "off", "--other")
    expect(r.code, r.all).toBe(0)
    expect(helloRuns()).toContain("switched off")
    expect(await greeting(sb)).toBe("hello from friendly")
  })
  test("on --other switches it back, and only it", async () => {
    const r = await cli(sb, "on", "--other")
    expect(r.code, r.all).toBe(0)
    expect(helloRuns()).not.toContain("switched off")
    expect(r.out).not.toContain("Fake")
  })
  test("a named harness and a flag together switch both", async () => {
    const off = await cli(sb, "off", "fake", "--other")
    expect(off.code, off.all).toBe(0)
    expect([helloRuns().includes("switched off"), await greeting(sb)]).toEqual([true, "stock greet"])
    expect((await cli(sb, "on", "--fake", "--other")).code).toBe(0)
    expect(await greeting(sb)).toBe("hello from friendly")
  })
  test("update --fake looks only at that harness", async () => {
    const r = await cli(sb, "update", "--fake")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("Fake 1.0.0 + t/friendly is already up to date")
    expect(r.out).not.toContain("Other")
  })
  test("a flag for a harness with no mods is refused", async () => {
    await cli(sb, "uninstall", "t/lonely", "--other")
    const r = await cli(sb, "off", "--other")
    expect(r.code).toBe(1)
    expect(r.err).toContain('no mods installed for "other"')
  })
  test("an unknown flag is refused", async () => {
    const r = await cli(sb, "off", "--nope")
    expect(r.code).toBe(1)
    expect(r.err).toContain("unknown option --nope")
  })
})

describe("an update", () => {
  test("keeps the build that ran until now, for sessions started from it, and only that one", async () => {
    const start = path.basename(running())
    await createMod(sb, "friendly", setGreeting("hello from friendly, next"))
    expect((await cli(sb, "update", "fake")).code).toBe(0)
    const second = path.basename(running())
    expect(builds()).toEqual([start, second].sort())
    await createMod(sb, "friendly", setGreeting("hello from friendly, after that"))
    expect((await cli(sb, "update", "fake")).code).toBe(0)
    const third = path.basename(running())
    expect(builds()).toEqual([second, third].sort())
    expect(await greeting(sb)).toBe("hello from friendly, after that")
  })
  test("keeps any build a running program was started from, however old, until it stops", async () => {
    const old = path.basename(builds().find((d) => d !== path.basename(running()))!)
    // A long session of that build: its path is in the program's command line.
    const session = Bun.spawn(["sh", "-c", "sleep 60; true", path.join(sb.om, "harnesses", "fake", "builds", old, "greet")])
    try {
      await createMod(sb, "friendly", setGreeting("hello from friendly, while a session runs"))
      expect((await cli(sb, "update", "fake")).code).toBe(0)
      expect(builds()).toContain(old)
      expect(builds().length).toBe(3)
    } finally {
      session.kill()
      await session.exited
    }
    await createMod(sb, "friendly", setGreeting("hello from friendly, once it stopped"))
    expect((await cli(sb, "update", "fake")).code).toBe(0)
    expect(builds()).not.toContain(old)
    expect(builds().length).toBe(2)
  })
  test("a forced rebuild of the same mods goes in a folder of its own, leaving the running one whole", async () => {
    const before = running()
    writeFileSync(path.join(before, "session-marker"), "still here\n")
    const r = await cli(sb, "update", "fake", "--force")
    expect(r.code, r.all).toBe(0)
    expect(running()).not.toBe(before)
    expect(readFileSync(path.join(before, "session-marker"), "utf8")).toBe("still here\n")
    expect(await greeting(sb)).toBe("hello from friendly, once it stopped")
  })
})

// bash's startup files as on Linux (~/.bashrc, then the login file); on macOS
// bash reads ~/.bash_profile. (Root writes any file, so there the startup file
// cannot be made read-only.)
describe.skipIf(process.platform !== "linux" || process.getuid?.() === 0)("a shell startup file that cannot be written", () => {
  test("is left alone, and the line to add is shown, without failing the command", async () => {
    const bashrc = path.join(sb.home, ".bashrc")
    writeFileSync(bashrc, "# managed by another tool\n")
    chmodSync(bashrc, 0o444)
    try {
      const r = await run(sb, { path: true, env: { SHELL: "/bin/bash" } }, "on", "fake")
      expect(r.code, r.all).toBe(0)
      expect(r.out).toContain("Could not edit ~/.bashrc")
      expect(r.out).toContain(`export PATH="${sb.om.replace(sb.home, "$HOME")}/bin:$PATH"  # openmods`)
      expect(readFileSync(bashrc, "utf8")).toBe("# managed by another tool\n")
      // A login shell still gets ~/.openmods/bin first.
      expect(readFileSync(path.join(sb.home, ".profile"), "utf8")).toContain("# openmods")
    } finally {
      chmodSync(bashrc, 0o644)
    }
  })
})

describe.skipIf(process.platform !== "linux")("a shell startup file that is a link to a file not made yet", () => {
  test("stays a link, and the line goes in the file it points to", async () => {
    const bashrc = path.join(sb.home, ".bashrc")
    const dotfiles = path.join(sb.home, "dotfiles")
    rmSync(bashrc, { force: true })
    mkdirSync(dotfiles, { recursive: true })
    symlinkSync(path.join(dotfiles, "bashrc"), bashrc)
    const r = await run(sb, { path: true, env: { SHELL: "/bin/bash" } }, "on", "fake")
    expect(r.code, r.all).toBe(0)
    expect(lstatSync(bashrc).isSymbolicLink()).toBe(true)
    expect(readFileSync(path.join(dotfiles, "bashrc"), "utf8")).toContain("# openmods")
  })
})
