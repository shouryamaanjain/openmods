// The rule for a new harness release: if the release changed any line the
// mod changes, the mod conflicts (yellow). If it changed other lines, even
// right next to the mod's, the mod still applies (green). Checked against a
// remote that serves blobless clones, as GitHub does.
import { beforeAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { cli, createHarness, createMod, release, sandbox, setLine } from "./harness"

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
