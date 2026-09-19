// What happens when the harness ships a new release: check, the release
// watch bumping or marking mods, the launcher's update note, and update
// moving a user forward.
import { beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { addFile, cli, createHarness, createMod, greeting, release, sandbox, script, setGreeting, WATCH } from "./harness"

const sb = sandbox("releases")
const modDir = () => path.join(sb.reg, "mods", "fake", "friendly")
const modJson = () => JSON.parse(readFileSync(path.join(modDir(), "mod.json"), "utf8"))

beforeAll(async () => {
  await createHarness(sb)
  await createMod(sb, "friendly", setGreeting("hello from friendly"))
  await createMod(sb, "notes", addFile("NOTES.md", "notes\n"))
  await cli(sb, "install", "fake/friendly", "fake/notes")
})

describe("check", () => {
  test("passes on a release that does not touch the mod's lines", async () => {
    await release(sb, "v1.1.0", addFile("CHANGELOG.md", "1.1.0\n"))
    const r = await cli(sb, "check", modDir(), "--ref", "v1.1.0", "--build", "--json", "--workspace", path.join(sb.T, "check"))
    expect(r.code).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.applies).toBe(true)
    expect(j.builds).toBe(true)
    mkdirSync(path.join(sb.T, "results"), { recursive: true })
    writeFileSync(path.join(sb.T, "results", "friendly.json"), r.out)
  })
  test("fails on a release that rewrites the mod's lines", async () => {
    await release(sb, "v2.0.0", setGreeting("hello from stock 2.0"))
    const r = await cli(sb, "check", modDir(), "--ref", "v2.0.0", "--json", "--workspace", path.join(sb.T, "check"))
    expect(r.code).toBe(1)
    expect(JSON.parse(r.out).applies).toBe(false)
  })
})

describe("release watch", () => {
  test("plan lists mods not yet on the release", async () => {
    const r = await script(sb, WATCH, "plan", "--ref", "v1.1.0", "--registry", sb.reg)
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out).matrix.map((m: { mod: string }) => m.mod).sort()).toEqual(["mods/fake/friendly", "mods/fake/notes"])
  })
  test("apply bumps a passing mod to the release", async () => {
    const r = await script(sb, WATCH, "apply", path.join(sb.T, "results"), "--registry", sb.reg)
    expect(r.code).toBe(0)
    expect(r.out).toContain("1 mod now supports it, 0 do not")
    expect(modJson().upstream.ref).toBe("v1.1.0")
    expect(JSON.parse(readFileSync(path.join(modDir(), "status.json"), "utf8")).ok).toBe(true)
  })
  test("apply keeps a failing mod on its release and records why", async () => {
    writeFileSync(path.join(sb.T, "results", "friendly.json"), JSON.stringify({ mod: "fake/friendly", ref: "v2.0.0", commit: "x", applies: false, error: "patch does not apply" }))
    const r = await script(sb, WATCH, "apply", path.join(sb.T, "results"), "--registry", sb.reg)
    expect(r.code).toBe(0)
    expect(modJson().upstream.ref).toBe("v1.1.0")
    const status = JSON.parse(readFileSync(path.join(modDir(), "status.json"), "utf8"))
    expect(status).toMatchObject({ ok: false, tested: "v2.0.0", supports: "v1.1.0" })
  })
})

describe("the user's side", () => {
  test("check-updates says a newer release is blocked while one mod lags", async () => {
    // friendly is on v1.1.0 now, notes is still on v1.0.0.
    const r = await cli(sb, "check-updates", "fake", "--json")
    expect(r.code).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.available).toBe("v1.1.0")
    expect(j.allSupport).toBe(false)
    expect(j.blocked).toEqual(["notes"])
    expect(readFileSync(path.join(sb.om, "updates", "fake"), "utf8")).toContain("BLOCKED='notes is for v1.0.0'")
  })
  test("once every mod supports it, update moves the user to the new release", async () => {
    // Bump notes by hand, as the release watch would have.
    const file = path.join(sb.reg, "mods", "fake", "notes", "mod.json")
    const notes = JSON.parse(readFileSync(file, "utf8"))
    const commit = (await Bun.$`git -C ${sb.harness} rev-parse v1.1.0^{commit}`.text()).trim()
    writeFileSync(file, JSON.stringify({ ...notes, upstream: { ref: "v1.1.0", commit } }))
    const note = await cli(sb, "check-updates", "fake", "--json")
    expect(JSON.parse(note.out)).toMatchObject({ available: "v1.1.0", allSupport: true })
    const r = await cli(sb, "update", "fake")
    expect(r.code).toBe(0)
    expect(r.out).toContain("now runs Fake v1.1.0 + friendly + notes")
    expect(await greeting(sb)).toBe("hello from friendly")
  })
  test("the launcher never prompts when not at a terminal", async () => {
    writeFileSync(path.join(sb.om, "updates", "fake"), "CURRENT='v1.1.0'\nAVAILABLE='v9.9.9'\nALL_SUPPORT=1\nMODS='friendly'\nBLOCKED=''\nCHECKED=1\n")
    const out = await Bun.$`sh ${path.join(sb.om, "bin", "greet")}`.env({ OPEN_MODS_NO_CHECK: "1" }).text()
    expect(out.trim()).toBe("hello from friendly")
  })
})
