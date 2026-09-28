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
  test("a build runs the harness's build install when it has one; a typecheck runs the full install", async () => {
    const file = path.join(sb.reg, "harnesses", "fake.json")
    const h = readFileSync(file, "utf8")
    writeFileSync(file, JSON.stringify({ ...JSON.parse(h), buildInstall: "echo installing what the build needs" }))
    try {
      const built = await cli(sb, "check", modDir(), "--ref", "v1.1.0", "--build", "--workspace", path.join(sb.T, "check"))
      expect(built.code, built.all).toBe(0)
      expect(built.all).toContain("installing what the build needs")
      expect(built.all).not.toContain("installing dependencies")
      const checked = await cli(sb, "check", modDir(), "--ref", "v1.1.0", "--typecheck", "--workspace", path.join(sb.T, "check"))
      expect(checked.code, checked.all).toBe(0)
      expect(checked.all).toContain("installing dependencies")
      expect(checked.all).not.toContain("installing what the build needs")
    } finally {
      writeFileSync(file, h)
    }
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
  test("a release channel that cannot be reached skips that harness, and the run goes on", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("down", { status: 503 }) })
    const file = path.join(sb.reg, "harnesses", "fake.json")
    const h = readFileSync(file, "utf8")
    writeFileSync(file, JSON.stringify({ ...JSON.parse(h), latestRelease: { url: `http://127.0.0.1:${server.port}/latest`, tag: "v{version}" } }))
    try {
      const r = await script(sb, WATCH, "plan", "--registry", sb.reg)
      expect(r.code, r.err).toBe(0)
      expect(r.err).toContain("fake: could not tell its newest release")
      expect(JSON.parse(r.out).matrix).toEqual([])
    } finally {
      writeFileSync(file, h)
      server.stop(true)
    }
  })
  test("the registry check refuses a release channel without an https URL and a tag with {version}", async () => {
    const file = path.join(sb.reg, "harnesses", "fake.json")
    const h = readFileSync(file, "utf8")
    writeFileSync(file, JSON.stringify({ ...JSON.parse(h), latestRelease: { url: "https://example.invalid/latest", tag: ["v{version}"] } }))
    try {
      const r = await Bun.$`bun ${path.resolve(import.meta.dir, "../../script/validate.ts")} --registry ${sb.reg}`.nothrow().quiet()
      expect(r.stderr.toString()).toContain('latestRelease needs an https "url" and a "tag" with {version} in it')
    } finally {
      writeFileSync(file, h)
    }
  })
  test("the site shows the release a harness's channel names", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ version: "9.9.9" }) })
    const file = path.join(sb.reg, "harnesses", "fake.json")
    const h = readFileSync(file, "utf8")
    writeFileSync(file, JSON.stringify({ ...JSON.parse(h), latestRelease: { url: `http://127.0.0.1:${server.port}/latest`, tag: "v{version}" } }))
    try {
      const out = path.join(sb.T, "site-channel")
      const r = await script(sb, SITE, "--registry", sb.reg, "--out", out)
      expect(r.code, r.err).toBe(0)
      const index = JSON.parse(readFileSync(path.join(out, "index.json"), "utf8"))
      expect(index.harnesses.find((x: { id: string }) => x.id === "fake")).toMatchObject({ tag: "v9.9.9" })
    } finally {
      writeFileSync(file, h)
      server.stop(true)
    }
  })
  test("follows a harness's own release channel when its definition names one, not its newest tag", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ version: "1.0.0" }) })
    const file = path.join(sb.reg, "harnesses", "fake.json")
    const h = readFileSync(file, "utf8")
    writeFileSync(file, JSON.stringify({ ...JSON.parse(h), latestRelease: { url: `http://127.0.0.1:${server.port}/latest`, tag: "v{version}" } }))
    try {
      const r = await script(sb, WATCH, "plan", "--registry", sb.reg)
      expect(r.code, r.err).toBe(0)
      const j = JSON.parse(r.out)
      expect(j.matrix).toEqual([])
      expect(j.recipe).toEqual([])
    } finally {
      writeFileSync(file, h)
      server.stop(true)
    }
  })
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
  test("update says a newer release is blocked while one mod lags", async () => {
    // friendly is on v1.1.0 now, notes is still on v1.0.0.
    const r = await cli(sb, "update", "fake")
    expect(r.code).toBe(0)
    expect(r.out).toContain("Fake 1.1.0 is out, but t/notes has no version for it yet, so you stay on 1.0.0.")
  })
  test("once every mod supports it, update moves the user to the new release", async () => {
    // Bump notes by hand, as the release watch would have.
    await addVersion(sb, path.join(sb.reg, "mods", "t", "notes", "fake"), "v1.1.0")
    const r = await cli(sb, "update", "fake")
    expect(r.code).toBe(0)
    expect(r.out).toContain("now runs Fake 1.1.0 + t/friendly + t/notes")
    expect(await greeting(sb)).toBe("hello from friendly")
  })
})
