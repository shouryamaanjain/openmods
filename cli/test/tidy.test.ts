// After a build, what the machine no longer needs goes, so disk use stays
// about where one build of each harness puts it, however many updates come:
// the old releases' tags in the checkout, Bun's download cache when a Bun
// harness moves to another release, and Bun versions nothing runs on.
import { beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs"
import path from "node:path"
import { addFile, addVersion, cli, createHarness, createMod, release, sandbox, setGreeting } from "./harness"

const sb = sandbox("tidy")
const checkout = () => path.join(sb.om, "harnesses", "fake", "src")
const cache = () => path.join(sb.om, "cache", "bun")
const toolchains = () => path.join(sb.om, "toolchains")
const tags = async () => (await $`git -C ${checkout()} tag`.text()).split("\n").filter(Boolean).sort()

beforeAll(async () => {
  await createHarness(sb)
  await createMod(sb, "friendly", setGreeting("hello from friendly"))
})

describe("after a build", () => {
  test("a first build clears nothing", async () => {
    mkdirSync(cache(), { recursive: true })
    writeFileSync(path.join(cache(), "a-package"), "")
    expect((await cli(sb, "install", "t/friendly")).code).toBe(0)
    expect(existsSync(path.join(cache(), "a-package"))).toBe(true)
    expect(await tags()).toEqual(["v1.0.0"])
  })
  test("moving to another release drops the old release's tags and, for a Bun harness, Bun's download cache", async () => {
    await release(sb, "v1.1.0", addFile("bun.lock", "{}\n"))
    await addVersion(sb, path.join(sb.reg, "mods", "t", "friendly", "fake"), "v1.1.0")
    const r = await cli(sb, "update", "fake")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("now runs Fake 1.1.0")
    expect(await tags()).toEqual(["v1.1.0"])
    expect(existsSync(cache())).toBe(false)
  })
  test("Bun versions nothing runs on go; the one openmods runs on, the one running, and a just-installed one stay", async () => {
    const old = Date.now() / 1000 - 2 * 3600
    for (const v of ["0.0.1", "1.3.14", Bun.version]) {
      mkdirSync(path.join(toolchains(), `bun-${v}`, "bin"), { recursive: true })
      utimesSync(path.join(toolchains(), `bun-${v}`), old, old)
    }
    // Put there moments ago, as another openmods setting up a dev clone might.
    mkdirSync(path.join(toolchains(), "bun-0.0.2", "bin"), { recursive: true })
    writeFileSync(path.join(sb.om, "bin", "openmods"), `#!/bin/sh\nexec "$OM/toolchains/bun-1.3.14/bin/bun" "$OM/registry/cli/src/index.ts" "$@"\n`)
    expect((await cli(sb, "update", "fake", "--force")).code).toBe(0)
    expect(existsSync(path.join(toolchains(), "bun-0.0.1"))).toBe(false)
    expect(existsSync(path.join(toolchains(), "bun-1.3.14"))).toBe(true)
    expect(existsSync(path.join(toolchains(), `bun-${Bun.version}`))).toBe(true)
    expect(existsSync(path.join(toolchains(), "bun-0.0.2"))).toBe(true)
  })
  test("an old tag a failed cleanup left is removed by the next build, of the same release too", async () => {
    await $`git -C ${checkout()} tag left-behind`.quiet()
    expect((await cli(sb, "update", "fake", "--force")).code).toBe(0)
    expect(await tags()).toEqual(["v1.1.0"])
  })
  test("the cleanup never fails a build that worked", async () => {
    const state = path.join(sb.om, "state.json")
    const other = path.join(sb.om, "harnesses", "other", "src")
    mkdirSync(other, { recursive: true })
    writeFileSync(path.join(other, "package.json"), "{ not json")
    writeFileSync(state, JSON.stringify({ ...JSON.parse(await Bun.file(state).text()), other: { ref: "v1", mods: [], off: [], hashes: {}, updates: {}, artifact: "", enabled: false } }))
    const r = await cli(sb, "update", "fake", "--force")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("now runs Fake 1.1.0")
  })
})
