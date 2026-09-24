// The commands a user runs: install, status, on, off, uninstall, update.
import { beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { cli, createHarness, createMod, greeting, sandbox, setGreeting } from "./harness"

const sb = sandbox("commands")

beforeAll(async () => {
  await createHarness(sb)
  await createMod(sb, "friendly", setGreeting("hello from friendly"))
})

describe("install", () => {
  test("needs a target", async () => {
    const r = await cli(sb, "install")
    expect(r.code).toBe(1)
    expect(r.err).toContain("needs a mod")
  })
  test("builds the mod in and switches it on", async () => {
    const r = await cli(sb, "install", "t/friendly")
    expect(r.code).toBe(0)
    expect(r.out).toContain("now runs Fake 1.0.0 + t/friendly")
    expect(await greeting(sb)).toBe("hello from friendly")
  })
  test("the launcher runs a kept copy of the build, not the checkout", async () => {
    const launcher = readFileSync(path.join(sb.om, "bin", "greet"), "utf8")
    expect(launcher).toContain(path.join(sb.om, "harnesses", "fake", "builds"))
  })
  test("status says which build greet runs", async () => {
    const r = await cli(sb, "status")
    expect(r.out).toContain("Fake 1.0.0 + t/friendly")
    expect(r.out).toContain("on")
  })
  test("update is a no-op when nothing changed", async () => {
    expect((await cli(sb, "update", "fake")).out).toContain("already up to date")
  })
})

describe("on and off", () => {
  test("off makes greet stock again without rebuilding; on restores it", async () => {
    expect((await cli(sb, "off")).out).toContain("stock Fake again")
    expect(await greeting(sb)).toBe("stock greet")
    expect((await cli(sb, "on")).out).toContain("now runs Fake 1.0.0 + t/friendly")
    expect(await greeting(sb)).toBe("hello from friendly")
  })
  test("off <mod> builds that mod out but keeps it installed", async () => {
    expect((await cli(sb, "off", "t/friendly")).out).toContain("Every Fake mod is off")
    expect((await cli(sb, "status")).out).toContain("friendly is off")
    expect((await cli(sb, "on", "t/friendly")).out).toContain("now runs Fake 1.0.0 + t/friendly")
  })
  test("names that are neither a mod nor a harness are refused", async () => {
    const r = await cli(sb, "off", "nope")
    expect(r.code).toBe(1)
    expect(r.err).toContain("neither an installed mod nor a harness")
  })
})

describe("uninstall", () => {
  test("needs a target", async () => {
    expect((await cli(sb, "uninstall")).code).toBe(1)
  })
  test("removes the build and the patched commits; greet runs stock", async () => {
    const r = await cli(sb, "uninstall", "t/friendly")
    expect(r.out).toContain("Removed the modded Fake build")
    expect(await greeting(sb)).toBe("stock greet")
    expect(existsSync(path.join(sb.om, "harnesses", "fake", "builds"))).toBe(false)
    const head = (await $`git -C ${path.join(sb.om, "harnesses", "fake", "src")} log -1 --format=%s`.text()).trim()
    expect(head).toBe("initial")
    expect((await cli(sb, "status")).out).toContain("No mods installed")
  })
  test("refuses a mod that is not installed", async () => {
    expect((await cli(sb, "uninstall", "t/friendly")).code).toBe(1)
  })
})
