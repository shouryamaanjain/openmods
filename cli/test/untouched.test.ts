// OpenMods never changes a harness's code: a modded build is the release plus
// the user's mods, nothing of OpenMods'. Where stock and modded would clash
// side by side, the launcher passes the harness's own switches instead (for
// Codex: no shared background server, no update notice, no feedback upload).
// A build made while OpenMods still added a patch of its own is offered a
// rebuild without it.
import { beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cli, createHarness, createMod, sandbox, setGreeting } from "./harness"

const sb = sandbox("untouched")
const stateFile = () => path.join(sb.om, "state.json")
const codex = JSON.parse(readFileSync(path.resolve(import.meta.dir, "../../harnesses/codex.json"), "utf8"))
const opencode = JSON.parse(readFileSync(path.resolve(import.meta.dir, "../../harnesses/opencode.json"), "utf8"))

beforeAll(async () => {
  await createHarness(sb)
  await createMod(sb, "friendly", setGreeting("hello from friendly"))
})

describe("a modded build", () => {
  test("is the release plus the user's mods, and nothing else", async () => {
    expect((await cli(sb, "install", "t/friendly")).code).toBe(0)
    const src = path.join(sb.om, "harnesses", "fake", "src")
    const commits = (await $`git -C ${src} log --format=%s v1.0.0..HEAD`.text()).trim().split("\n")
    expect(commits).toEqual(["feat: friendly"])
  })
  test("keeps the harness's own version: no stamp is written into its files", () => {
    expect(codex.build).not.toContain("Cargo.toml")
    expect(codex.build).not.toContain("OPENMODS_MODS")
    expect(opencode.build).toContain('OPENCODE_VERSION="${OPENMODS_VERSION}"')
  })
  test("Codex gets its own switches from the launcher, not a patch", () => {
    expect(codex.args).toEqual(["-c", "check_for_update_on_startup=false", "-c", "feedback.enabled=false"])
    expect(codex.argsUnless).toEqual({ args: ["--no-daemon"], given: ["agents", "--remote", "--remote=*"] })
  })
})

describe("a build made with OpenMods' old patch", () => {
  test("is offered a rebuild, and update makes it again without the patch", async () => {
    const state = JSON.parse(readFileSync(stateFile(), "utf8"))
    state.fake.hashes["openmods/base"] = "old"
    state.fake.updates["openmods/base"] = 2
    writeFileSync(stateFile(), JSON.stringify(state))
    const look = await cli(sb, "check-updates", "fake", "--json")
    expect(JSON.parse(look.out)).toMatchObject({ ask: true })
    expect(readFileSync(path.join(sb.om, "updates", "fake"), "utf8")).toContain("still has the patch OpenMods used to add to every build")
    const r = await cli(sb, "update", "fake")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("now runs Fake 1.0.0 + t/friendly")
    const after = JSON.parse(readFileSync(stateFile(), "utf8")).fake
    expect(after.hashes["openmods/base"]).toBeUndefined()
    expect((await cli(sb, "update", "fake")).out).toContain("already up to date")
  })
})
