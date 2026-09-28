// The commands a user runs: install, status, on, off, uninstall, update.
import { beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
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
  test("switch a whole harness; for one mod they point to install and uninstall", async () => {
    const off = await cli(sb, "off", "t/friendly")
    expect(off.code).toBe(1)
    expect(off.err).toContain("To remove t/friendly: openmods uninstall t/friendly")
    const on = await cli(sb, "on", "t/friendly")
    expect(on.err).toContain("To add t/friendly: openmods install t/friendly")
  })
  test("names that are not a harness with mods are refused", async () => {
    const r = await cli(sb, "off", "nope")
    expect(r.code).toBe(1)
    expect(r.err).toContain('no mods installed for "nope"')
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

describe("the commands", () => {
  test("help lists the 11 a person types, and nothing else", async () => {
    const help = (await cli(sb, "help")).out
    for (const c of ["install", "uninstall", "update", "list", "info", "status", "on", "off", "dev", "pack", "check"]) expect(help).toContain(`openmods ${c}`)
    for (const c of ["setup", "check-updates", "registry", "installed", "add", "remove", "rm"]) expect(help).not.toContain(`openmods ${c} `)
    expect(help.match(/^ {2}openmods [a-z-]+/gm)!.length).toBe(11)
  })
  test("second names and registry are gone; status says where things come from", async () => {
    for (const c of ["add", "remove", "rm", "installed", "registry"]) expect((await cli(sb, c)).code, c).toBe(1)
    const status = (await cli(sb, "status")).out
    expect(status).toContain("mods list  ")
    expect(status).toContain("openmods   ")
  })
  test("setup and check-updates still run, for the installer and the launcher", async () => {
    expect((await cli(sb, "setup")).code).toBe(0)
    expect((await cli(sb, "check-updates")).code).toBe(0)
  })
})

describe("mods built out by an older openmods", () => {
  test("stay listed as built out, and install builds one back in", async () => {
    expect((await cli(sb, "install", "t/friendly")).code).toBe(0)
    const file = path.join(sb.om, "state.json")
    const state = JSON.parse(readFileSync(file, "utf8"))
    // As \`openmods off t/friendly\` used to leave it, before it was rebuilt out.
    state.fake.off = ["t/friendly"]
    writeFileSync(file, JSON.stringify(state))
    expect((await cli(sb, "status")).out).toContain("t/friendly is built out (openmods install t/friendly --fake builds it back in)")
    const r = await cli(sb, "install", "t/friendly")
    expect(r.code, r.all).toBe(0)
    const after = JSON.parse(readFileSync(file, "utf8")).fake
    expect(after.off).toEqual([])
    expect(after.mods).toEqual(["t/friendly"])
  })
  test("a state file that cannot be read still gets where things come from", async () => {
    const file = path.join(sb.om, "state.json")
    const kept = readFileSync(file, "utf8")
    writeFileSync(file, "{ damaged")
    const r = await cli(sb, "status")
    const json = await cli(sb, "status", "--json")
    writeFileSync(file, kept)
    expect(r.code).toBe(1)
    expect(r.err).toContain("cannot be read")
    expect(json.code).toBe(1)
    expect(json.out).toBe("")
    expect(json.err).toContain("cannot be read")
    expect(r.out).toContain("mods list  ")
    expect(r.out).toMatch(/openmods {3}run from /)
  })
})

