// What a user meets in their first days: naming a harness with its flag on
// on, off and update; an update that leaves the build a running session uses;
// and a shell startup file OpenMods cannot write.
import { beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cli, createHarness, createMod, greeting, registerHarness, run, sandbox, setGreeting } from "./harness"

const sb = sandbox("day-two")
const builds = () => readdirSync(path.join(sb.om, "harnesses", "fake", "builds")).filter((d) => !d.startsWith(".")).sort()
const helloRuns = () => readFileSync(path.join(sb.om, "bin", "hello"), "utf8")

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
  test("keeps the build that ran until now, for sessions started from it", async () => {
    const before = builds()
    expect(before).toEqual(["1.0.0+friendly-1"])
    await createMod(sb, "friendly", setGreeting("hello from friendly, update 2"))
    const r = await cli(sb, "update", "fake")
    expect(r.code, r.all).toBe(0)
    expect(builds()).toEqual(["1.0.0+friendly-1", "1.0.0+friendly-2"])
    expect(await greeting(sb)).toBe("hello from friendly, update 2")
  })
  test("and only that one: the build before it goes", async () => {
    await createMod(sb, "friendly", setGreeting("hello from friendly, update 3"))
    const r = await cli(sb, "update", "fake")
    expect(r.code, r.all).toBe(0)
    expect(builds()).toEqual(["1.0.0+friendly-2", "1.0.0+friendly-3"])
    expect(await greeting(sb)).toBe("hello from friendly, update 3")
  })
})

// (Root writes any file, so there the startup file cannot be made read-only.)
describe.skipIf(process.getuid?.() === 0)("a shell startup file that cannot be written", () => {
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
      expect(existsSync(path.join(sb.home, ".profile"))).toBe(false)
    } finally {
      chmodSync(bashrc, 0o644)
    }
  })
})
