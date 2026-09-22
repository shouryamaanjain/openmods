// CI never builds a harness. Instead, on each release it compares the lines
// our build recipe depends on. A change there holds the harness's mods until
// a person runs the manual harness build, which records the recipe as
// verified; version bumps and other noise do not hold anything.
import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cli, createHarness, createMod, release, sandbox, script, setGreeting, WATCH } from "./harness"

const sb = sandbox("recipe")
const plan = async (ref: string) => {
  const r = await script(sb, WATCH, "plan", "--ref", ref, "--registry", sb.reg)
  if (r.code !== 0) throw new Error(r.err)
  return JSON.parse(r.out) as { matrix: { mod: string }[]; recipe: { state: string; from: string; to: string; changes: string[] }[] }
}
const setPackageJson = (fields: Record<string, string>) => (dir: string) => {
  const file = path.join(dir, "package.json")
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...fields }, null, 2) + "\n")
}
const status = () => JSON.parse(readFileSync(path.join(sb.reg, "status", "fake.json"), "utf8"))
const modRef = () => JSON.parse(readFileSync(path.join(sb.reg, "mods", "t", "friendly", "fake", "support.json"), "utf8")).upstream.ref

beforeAll(async () => {
  await createHarness(sb)
  await createMod(sb, "friendly", setGreeting("hello from friendly"))
})

describe("a release", () => {
  test("that only bumps versions does not hold anything", async () => {
    await release(sb, "v1.1.0", setPackageJson({ version: "1.1.0" }))
    const j = await plan("v1.1.0")
    expect(j.recipe).toMatchObject([{ state: "unchanged", from: "v1.0.0", to: "v1.1.0", changes: [] }])
    expect(j.matrix.map((m) => m.mod)).toEqual(["mods/t/friendly/fake"])
    const r = await script(sb, WATCH, "apply", path.join(sb.T, "none"), "--recipe", JSON.stringify(j.recipe), "--registry", sb.reg)
    expect(r.code, r.err).toBe(0)
    expect(status()).toMatchObject({ tested: "v1.1.0", recipe: "unchanged" })
  })

  test("that changes the recipe holds the mods and says what changed", async () => {
    await release(sb, "v1.2.0", (dir) => writeFileSync(path.join(dir, "build.cfg"), "compiler=2\n"))
    const j = await plan("v1.2.0")
    expect(j.matrix).toEqual([])
    expect(j.recipe).toMatchObject([{ state: "changed", from: "v1.1.0", to: "v1.2.0" }])
    expect(j.recipe[0]!.changes).toEqual(["build.cfg: -compiler=1", "build.cfg: +compiler=2"])
    const out = path.join(sb.T, "results-held")
    const r = await script(sb, WATCH, "apply", out, "--recipe", JSON.stringify(j.recipe), "--registry", sb.reg)
    expect(r.code, r.err).toBe(0)
    expect(r.out).toContain("build recipe changed, mods held")
    expect(status()).toMatchObject({ tested: "v1.2.0", recipe: "changed" })
    expect(modRef()).toBe("v1.0.0")
  })

  test("stays held on the next run, without re-checking", async () => {
    const j = await plan("v1.2.0")
    expect(j.matrix).toEqual([])
    expect(j.recipe).toMatchObject([{ state: "held" }])
  })

  test("is released by a verified harness build, and the mods are checked again", async () => {
    // What the manual harness build workflow runs after a successful build.
    const b = await cli(sb, "check", "--harness", "fake", "--ref", "v1.2.0", "--build", "--json", "--workspace", path.join(sb.T, "build"))
    expect(JSON.parse(b.out).builds).toBe(true)
    const v = await script(sb, WATCH, "verify", "fake", "v1.2.0", "--registry", sb.reg)
    expect(v.code, v.err).toBe(0)
    expect(status()).toMatchObject({ tested: "v1.2.0", recipe: "verified" })
    const j = await plan("v1.2.0")
    expect(j.recipe).toMatchObject([{ state: "unchanged" }])
    expect(j.matrix.map((m) => m.mod)).toEqual(["mods/t/friendly/fake"])
  })

  test("that changes an unwatched line of a watched file does not hold anything", async () => {
    await release(sb, "v1.3.0", setPackageJson({ description: "a new field" }))
    const j = await plan("v1.3.0")
    expect(j.recipe).toMatchObject([{ state: "unchanged", from: "v1.2.0", to: "v1.3.0" }])
  })

  test("that changes a watched line of a watched file holds the mods", async () => {
    await release(sb, "v1.4.0", setPackageJson({ packageManager: "pnpm@10.0.0" }))
    const j = await plan("v1.4.0")
    expect(j.recipe[0]!.state).toBe("changed")
    expect(j.recipe[0]!.changes).toEqual([`package.json: -"packageManager": "pnpm@9.0.0"`, `package.json: +"packageManager": "pnpm@10.0.0"`])
  })
})
