// The OpenMods base patch: an internal mod, openmods/base, that goes first
// into every modded build. Users never list, install or remove it, it is not
// in the version stamp, existing builds are offered it once, and a mod that
// changes its lines cannot be installed.
import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cli, createHarness, createMod, greeting, sandbox, script, setGreeting, setLine, SITE } from "./harness"

const sb = sandbox("base")
const state = () => JSON.parse(readFileSync(path.join(sb.om, "state.json"), "utf8")).fake
const launcher = () => readFileSync(path.join(sb.om, "bin", "greet"), "utf8")

beforeAll(async () => {
  await createHarness(sb)
  await createMod(sb, "friendly", setGreeting("hello from friendly"))
  await createMod(sb, "first-line", setLine(1, "line 1, by a mod"))
})

describe("the base patch", () => {
  test("a build from before it existed is offered it once, as an update", async () => {
    expect((await cli(sb, "install", "t/friendly")).code).toBe(0)
    const dir = await createMod(sb, "base", setLine(1, "line 1, by openmods"), { owner: "openmods" })
    const meta = path.join(dir, "..", "mod.json")
    writeFileSync(meta, JSON.stringify({ ...JSON.parse(readFileSync(meta, "utf8")), internal: true, description: "Points bug reports from modded builds to OpenMods." }, null, 2))
    const r = JSON.parse((await cli(sb, "check-updates", "fake", "--json")).out)
    expect(r).toMatchObject({ ask: true, updates: [{ id: "openmods/base", update: 1 }] })
    expect(r.message).toBe("New in your Fake mods: the OpenMods base patch update 1.")
  })
  test("goes first into every build, and stays out of the version stamp and the mod list", async () => {
    const r = await cli(sb, "update", "fake")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("now runs Fake 1.0.0 + t/friendly")
    expect(r.all).toContain("Applying the OpenMods base patch")
    expect(state().mods).toEqual(["t/friendly"])
    expect(Object.keys(state().updates).sort()).toEqual(["openmods/base", "t/friendly"])
    expect(launcher()).toContain("builds/1.0.0+friendly-1/")
    expect(await greeting(sb)).toBe("hello from friendly")
    expect((await cli(sb, "list")).out).not.toContain("openmods/base")
    expect((await cli(sb, "update", "fake")).out).toContain("already up to date")
  })
  test("cannot be installed or removed by hand", async () => {
    expect((await cli(sb, "install", "openmods/base")).err).toContain('no mod "openmods/base"')
    expect((await cli(sb, "uninstall", "openmods/base")).code).toBe(1)
  })
  test("a mod that changes the base patch's lines is refused", async () => {
    const r = await cli(sb, "install", "t/first-line")
    expect(r.code).toBe(1)
    expect(r.err).toContain("t/first-line does not work with the OpenMods base patch on Fake")
    expect(r.err).toContain("cannot be installed until its author moves those lines")
  })
  test("a mod is checked with it, as users build it, and its patches stay its own", async () => {
    const r = await cli(sb, "check", path.join(sb.reg, "mods", "t", "friendly", "fake"), "--json")
    expect(r.code, r.all).toBe(0)
    const out = JSON.parse(r.out)
    expect(out).toMatchObject({ applies: true, base: 1 })
    expect(out.patches).toHaveLength(1)
    expect(out.patches[0].text).not.toContain("by openmods")
  })
  test("a mod that changes its lines fails the check", async () => {
    const r = await cli(sb, "check", path.join(sb.reg, "mods", "t", "first-line", "fake"))
    expect(r.code).toBe(1)
    expect(r.out).toContain("it does not apply on top of the OpenMods base patch at 1.0.0")
  })
  test("is not listed on the site", async () => {
    const out = path.join(sb.T, "site")
    expect((await script(sb, SITE, "--registry", sb.reg, "--out", out, "--offline")).code).toBe(0)
    expect(readFileSync(path.join(out, "index.html"), "utf8")).not.toContain("openmods/base")
  })
})
