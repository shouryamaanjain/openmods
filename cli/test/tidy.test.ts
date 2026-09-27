// After a build, what the machine no longer needs goes, so disk use stays
// about where one build of each harness puts it, however many updates come:
// the old releases' tags in the checkout, Bun's download cache when a Bun
// harness moves to another release, and Bun versions nothing runs on.
import { beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
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
  test("a Bun folder that is a broken link does not stop the rest of the cleanup", async () => {
    const old = Date.now() / 1000 - 2 * 3600
    symlinkSync(path.join(sb.T, "nowhere"), path.join(toolchains(), "bun-0.0.3"))
    mkdirSync(path.join(toolchains(), "bun-0.0.4", "bin"), { recursive: true })
    utimesSync(path.join(toolchains(), "bun-0.0.4"), old, old)
    expect((await cli(sb, "update", "fake", "--force")).code).toBe(0)
    expect(existsSync(path.join(toolchains(), "bun-0.0.4"))).toBe(false)
  })
  test("one build of a harness at a time: a running one is said, a dead one's lock is taken over", async () => {
    const lock = path.join(sb.om, "harnesses", "fake", "build.lock")
    writeFileSync(lock, String(process.pid))
    const busy = await cli(sb, "update", "fake", "--force")
    expect(busy.code).toBe(1)
    expect(busy.err).toContain(`another openmods is building Fake right now (process ${process.pid})`)
    writeFileSync(lock, "999999")
    expect((await cli(sb, "update", "fake", "--force")).code).toBe(0)
    expect(existsSync(lock)).toBe(false)
    // A killed build's lock whose process id another process has taken since:
    // that process started after the lock was written, so it is not the owner.
    writeFileSync(lock, "")
    const before = Date.now() / 1000 - 60
    utimesSync(lock, before, before)
    const other = Bun.spawn(["sleep", "30"])
    writeFileSync(lock, String(other.pid))
    utimesSync(lock, before, before)
    try {
      expect((await cli(sb, "update", "fake", "--force")).code).toBe(0)
    } finally {
      other.kill()
    }
  })
  test("the cleanup never fails a build that worked", async () => {
    const state = path.join(sb.om, "state.json")
    const other = path.join(sb.om, "harnesses", "other", "src")
    mkdirSync(other, { recursive: true })
    writeFileSync(path.join(other, "package.json"), "{ not json")
    // While a harness's pin cannot be read, no Bun version is taken for unused.
    mkdirSync(path.join(toolchains(), "bun-0.0.5", "bin"), { recursive: true })
    utimesSync(path.join(toolchains(), "bun-0.0.5"), Date.now() / 1000 - 7200, Date.now() / 1000 - 7200)
    writeFileSync(state, JSON.stringify({ ...JSON.parse(await Bun.file(state).text()), other: { ref: "v1", mods: [], off: [], hashes: {}, updates: {}, artifact: "", enabled: false } }))
    const r = await cli(sb, "update", "fake", "--force")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("now runs Fake 1.1.0")
    expect(existsSync(path.join(toolchains(), "bun-0.0.5"))).toBe(true)
  })
})
