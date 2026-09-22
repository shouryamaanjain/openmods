// The rule for a new harness release: if the release changed any line the
// mod changes, the mod conflicts (yellow). If it changed other lines, even
// right next to the mod's, the mod still applies (green). Checked against a
// remote that serves blobless clones, as GitHub does.
import { beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cli, createHarness, createMod, release, sandbox, script, setLine, WATCH } from "./harness"

const sb = sandbox("overlap")
let mod = ""

beforeAll(async () => {
  await createHarness(sb)
  // The mod changes line 6 of lines.txt, at v1.0.0.
  mod = await createMod(sb, "line-six", setLine(6, "line 6, changed by the mod"))
})

const check = async (ref: string) => {
  const r = await cli(sb, "check", mod, "--ref", ref, "--typecheck", "--json", "--workspace", path.join(sb.T, `check-${ref}`))
  return { code: r.code, result: JSON.parse(r.out) }
}

describe("a new release", () => {
  test("that changes nothing near the mod: applies", async () => {
    await release(sb, "v1.1.0", setLine(12, "line 12, changed upstream"))
    const { code, result } = await check("v1.1.0")
    expect(result.applies).toBe(true)
    expect(result.typechecks).toBe(true)
    expect(code).toBe(0)
  })
  test("that changes a line next to the mod's, but not the mod's: applies", async () => {
    // Line 4 is inside the patch's context, so a plain apply fails and git
    // needs the three-way merge, which needs the base file in a blobless clone.
    await release(sb, "v1.2.0", setLine(4, "line 4, changed upstream"))
    const { code, result } = await check("v1.2.0")
    expect(result.error ?? "").not.toContain("sha1 information is lacking")
    expect(result.applies).toBe(true)
    expect(code).toBe(0)
  })
  test("that changes the mod's own line: conflicts", async () => {
    await release(sb, "v1.3.0", setLine(6, "line 6, changed upstream"))
    const { code, result } = await check("v1.3.0")
    expect(result.applies).toBe(false)
    expect(code).toBe(1)
  })
  test("--json output stays valid JSON even though the harness prints while building", async () => {
    const r = await cli(sb, "check", "--harness", "fake", "--ref", "v1.1.0", "--build", "--json", "--workspace", path.join(sb.T, "check-stock"))
    expect(() => JSON.parse(r.out)).not.toThrow()
    expect(JSON.parse(r.out).builds).toBe(true)
    expect(r.err).toContain("building")
  })
})

// A bump rewrites the mod's patches as they apply to the new release, so the
// next comparison starts from the last verified version and an install never
// needs the original base. Checked with an old-style patch (short blob ids),
// which a blobless clone cannot fetch a base for.
describe("a bump", () => {
  let dir = ""
  const patchText = () => {
    const mod = JSON.parse(readFileSync(path.join(dir, "mod.json"), "utf8"))
    return mod.patches.map((p: string) => readFileSync(path.join(dir, p), "utf8")).join("\n")
  }

  test("starts from an old-style patch with short blob ids", async () => {
    dir = await createMod(sb, "line-nine", setLine(9, "line 9, changed by the mod"))
    for (const f of readdirSync(path.join(dir, "patches"))) {
      const p = path.join(dir, "patches", f)
      writeFileSync(p, readFileSync(p, "utf8").replace(/^index ([0-9a-f]{7})[0-9a-f]+\.\.([0-9a-f]{7})[0-9a-f]+/m, "index $1..$2"))
    }
    expect(patchText()).toMatch(/^index [0-9a-f]{7}\.\.[0-9a-f]{7} /m)
  })

  test("rewrites the patches for the new release", async () => {
    // Line 7 is in the patch's context: the merge is needed, and it is clean.
    await release(sb, "v1.4.0", setLine(7, "line 7, changed upstream"))
    const r = await cli(sb, "check", dir, "--ref", "v1.4.0", "--typecheck", "--json", "--workspace", path.join(sb.T, "check-bump"))
    expect(JSON.parse(r.out).applies).toBe(true)
    const results = path.join(sb.T, "results-bump")
    mkdirSync(results, { recursive: true })
    writeFileSync(path.join(results, "line-nine.json"), r.out)
    const apply = await script(sb, WATCH, "apply", results, "--registry", sb.reg)
    expect(apply.code, apply.err).toBe(0)
    const mod = JSON.parse(readFileSync(path.join(dir, "mod.json"), "utf8"))
    expect(mod.upstream.ref).toBe("v1.4.0")
    // The new patch's context is the new release's text, with full blob ids.
    expect(patchText()).toContain(" line 7, changed upstream")
    expect(patchText()).toMatch(/^index [0-9a-f]{40}\.\.[0-9a-f]{40} /m)
  })

  test("installs from scratch at the new release", async () => {
    // A fresh blobless checkout, as a new user gets.
    const r = await cli(sb, "check", dir, "--json", "--workspace", path.join(sb.T, "check-fresh"))
    expect(JSON.parse(r.out)).toMatchObject({ ref: "v1.4.0", applies: true })
  })

  test("is compared against the version it was bumped to on the next release", async () => {
    await release(sb, "v1.5.0", setLine(12, "line 12, changed again upstream"))
    const r = await cli(sb, "check", dir, "--ref", "v1.5.0", "--json", "--workspace", path.join(sb.T, "check-next"))
    const j = JSON.parse(r.out)
    expect(j.madeFor).toBe("v1.4.0")
    expect(j.applies).toBe(true)
  })
})
