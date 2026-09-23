// What happens when the harness ships a new release: check, the release
// watch bumping or marking mods, the launcher's update note, and update
// moving a user forward.
import { beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { addFile, addVersion, cli, createHarness, createMod, greeting, release, sandbox, script, setGreeting, SITE, versions, WATCH } from "./harness"

const sb = sandbox("releases")
const modDir = () => path.join(sb.reg, "mods", "t", "friendly", "fake")
const newestRef = () => versions(modDir())[0]!.ref

beforeAll(async () => {
  await createHarness(sb)
  await createMod(sb, "friendly", setGreeting("hello from friendly"))
  await createMod(sb, "notes", addFile("NOTES.md", "notes\n"))
  await cli(sb, "install", "t/friendly", "t/notes")
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
  test("--typecheck runs the harness's typecheck instead of the build", async () => {
    const r = await cli(sb, "check", modDir(), "--ref", "v1.1.0", "--typecheck", "--json", "--workspace", path.join(sb.T, "check"))
    expect(r.code, r.all).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.applies).toBe(true)
    expect(j.typechecks).toBe(true)
    expect(j.builds).toBeUndefined()
  })
  test("--typecheck fails when the mod does not typecheck", async () => {
    const dir = await createMod(sb, "syntax-error", (d) => writeFileSync(path.join(d, "greet.sh"), "#!/bin/sh\necho hello from stock\nif then fi\n"))
    const r = await cli(sb, "check", dir, "--ref", "v1.1.0", "--typecheck", "--json", "--workspace", path.join(sb.T, "check"))
    expect(r.code).toBe(1)
    const j = JSON.parse(r.out)
    expect(j.applies).toBe(true)
    expect(j.typechecks).toBe(false)
  })
  test("--harness --build builds the stock harness with no mod", async () => {
    const r = await cli(sb, "check", "--harness", "fake", "--ref", "v1.1.0", "--build", "--json", "--workspace", path.join(sb.T, "check"))
    expect(r.code).toBe(0)
    const j = JSON.parse(r.out)
    expect(j).toMatchObject({ harness: "fake", stock: true, builds: true })
    expect(j.mod).toBeUndefined()
  })
  test("--harness --build reports a failing stock build as JSON", async () => {
    const file = path.join(sb.reg, "harnesses", "fake.json")
    const h = JSON.parse(readFileSync(file, "utf8"))
    writeFileSync(file, JSON.stringify({ ...h, build: "echo toolchain missing >&2; exit 1" }))
    const r = await cli(sb, "check", "--harness", "fake", "--ref", "v1.1.0", "--build", "--json", "--workspace", path.join(sb.T, "check"))
    writeFileSync(file, JSON.stringify(h))
    expect(r.code).toBe(1)
    expect(JSON.parse(r.out)).toMatchObject({ harness: "fake", stock: true, builds: false })
  })
  test("fails on a release that rewrites the mod's lines", async () => {
    await release(sb, "v2.0.0", setGreeting("hello from stock 2.0"))
    const r = await cli(sb, "check", modDir(), "--ref", "v2.0.0", "--json", "--workspace", path.join(sb.T, "check"))
    expect(r.code).toBe(1)
    expect(JSON.parse(r.out).applies).toBe(false)
  })
})

describe("release watch", () => {
  let recipe = "[]"
  test("plan lists mods not yet on the release, after finding the recipe unchanged", async () => {
    const r = await script(sb, WATCH, "plan", "--ref", "v1.1.0", "--registry", sb.reg)
    expect(r.code).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.matrix.map((m: { mod: string }) => m.mod).sort()).toEqual(["mods/t/friendly/fake", "mods/t/notes/fake", "mods/t/syntax-error/fake"])
    expect(j.recipe).toMatchObject([{ harness: "fake", from: "v1.0.0", to: "v1.1.0", state: "unchanged" }])
    recipe = JSON.stringify(j.recipe)
  })
  test("apply bumps a mod that typechecked and records the recipe check", async () => {
    // A typecheck-only result, as the release watch produces.
    const r0 = JSON.parse(readFileSync(path.join(sb.T, "results", "friendly.json"), "utf8"))
    writeFileSync(path.join(sb.T, "results", "friendly.json"), JSON.stringify({ ...r0, builds: undefined, typechecks: true }))
    const r = await script(sb, WATCH, "apply", path.join(sb.T, "results"), "--recipe", recipe, "--registry", sb.reg)
    expect(r.code, r.err).toBe(0)
    expect(r.out).toContain("1 mod now supports it, 0 do not")
    expect(versions(modDir()).map((v) => v.ref)).toEqual(["v1.1.0", "v1.0.0"])
    expect(JSON.parse(readFileSync(path.join(modDir(), "status.json"), "utf8")).ok).toBe(true)
    expect(JSON.parse(readFileSync(path.join(sb.reg, "status", "fake.json"), "utf8"))).toMatchObject({ tested: "v1.1.0", recipe: "unchanged" })
    // harnesses/ holds only definitions: anything else there is read as a harness.
    expect(readdirSync(path.join(sb.reg, "harnesses"))).toEqual(["fake.json"])
  })
  test("apply keeps a failing mod on its release and records why", async () => {
    writeFileSync(path.join(sb.T, "results", "friendly.json"), JSON.stringify({ mod: "t/friendly", harness: "fake", ref: "v2.0.0", commit: "x", applies: false, error: "patch does not apply" }))
    const r = await script(sb, WATCH, "apply", path.join(sb.T, "results"), "--registry", sb.reg)
    expect(r.code).toBe(0)
    expect(newestRef()).toBe("v1.1.0")
    const status = JSON.parse(readFileSync(path.join(modDir(), "status.json"), "utf8"))
    expect(status).toMatchObject({ ok: false, tested: "v2.0.0", supports: "v1.1.0" })
  })
})

describe("after the release watch wrote its results", () => {
  test("the site still builds from the registry", async () => {
    const out = path.join(sb.T, "site")
    const r = await script(sb, SITE, "--registry", sb.reg, "--out", out, "--offline")
    expect(r.code, r.err).toBe(0)
    expect(readFileSync(path.join(out, "index.html"), "utf8")).toContain("t/friendly")
  })
})

describe("the user's side", () => {
  test("check-updates says a newer release is blocked while one mod lags", async () => {
    // friendly is on v1.1.0 now, notes is still on v1.0.0.
    const r = await cli(sb, "check-updates", "fake", "--json")
    expect(r.code).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.available).toBe("1.1.0")
    expect(j.allSupport).toBe(false)
    expect(j.blocked).toEqual(["t/notes"])
    expect(readFileSync(path.join(sb.om, "updates", "fake"), "utf8")).toContain("MESSAGE='Fake 1.1.0 is out, but t/notes has no version for it yet, so you stay on 1.0.0.'")
  })
  test("once every mod supports it, update moves the user to the new release", async () => {
    // Bump notes by hand, as the release watch would have.
    await addVersion(sb, path.join(sb.reg, "mods", "t", "notes", "fake"), "v1.1.0")
    const note = await cli(sb, "check-updates", "fake", "--json")
    expect(JSON.parse(note.out)).toMatchObject({ available: "1.1.0", allSupport: true })
    const r = await cli(sb, "update", "fake")
    expect(r.code).toBe(0)
    expect(r.out).toContain("now runs Fake 1.1.0 + t/friendly + t/notes")
    expect(await greeting(sb)).toBe("hello from friendly")
  })
  test("the launcher never prompts when not at a terminal", async () => {
    writeFileSync(path.join(sb.om, "updates", "fake"), "CURRENT='1.1.0'\nKEY='update v9.9.9 '\nASK=1\nMESSAGE='Fake 9.9.9 is out, and all your mods support it.'\nCHECKED=1\n")
    const out = await Bun.$`sh ${path.join(sb.om, "bin", "greet")}`.env({ OPEN_MODS_NO_CHECK: "1" }).text()
    expect(out.trim()).toBe("hello from friendly")
  })
})
