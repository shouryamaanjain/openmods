// Which mods can be installed together on one harness. Two mods that change
// the same lines of a release, or lines right next to each other, cannot:
// git cannot merge them. The CLI works that out from the patches alone and
// refuses the combination before it builds; info and the site list it.
import { beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { footprint, overlaps } from "../src/overlap"
import { cli, createHarness, createMod, greeting, sandbox, script, setLine, SITE } from "./harness"

const sb = sandbox("combinations")

// Two mods as commit series on a 30-line file, and whether git can apply the
// second on top of the first the way the CLI does (git am -3).
type Step = (lines: string[]) => string[]
const set = (n: number, t: string): Step => (l) => ((l[n - 1] = t), l)
const insertAfter = (n: number, ...t: string[]): Step => (l) => (l.splice(n, 0, ...t), l)
const remove = (n: number): Step => (l) => (l.splice(n - 1, 1), l)
async function pair(a: Step[], b: Step[]) {
  const dir = mkdtempSync(path.join(sb.T, "pair-"))
  const g = (...x: string[]) => $`git -C ${dir} -c user.name=t -c user.email=t@t ${x}`.quiet()
  const base = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
  await g("init", "-q")
  writeFileSync(path.join(dir, "f.txt"), base.join("\n") + "\n")
  await g("add", "-A")
  await g("commit", "-qm", "release")
  await g("tag", "release")
  const patches: Record<string, string[]> = {}
  for (const [name, steps] of [["a", a], ["b", b]] as const) {
    await g("checkout", "-q", "-B", name, "release")
    let cur = base.slice()
    for (const s of steps) {
      cur = s(cur)
      writeFileSync(path.join(dir, "f.txt"), cur.join("\n") + "\n")
      await g("commit", "-qam", name)
    }
    const out = path.join(dir, `.${name}`)
    await g("format-patch", "-q", "--full-index", "-o", out, `release..${name}`)
    patches[name] = readdirSync(out).sort().map((f) => path.join(out, f))
  }
  await g("checkout", "-q", "--detach", "release")
  await g("am", "-q", ...patches.a!)
  const applies = (await $`git -C ${dir} -c user.name=t -c user.email=t@t am -3 -q ${patches.b!}`.nothrow().quiet()).exitCode === 0
  const read = (files: string[]) => footprint(files.map((f) => readFileSync(f, "utf8")))
  return { applies, predicted: overlaps(read(patches.a!), read(patches.b!)).length === 0 }
}

describe("the line rule agrees with git", () => {
  const cases: [string, Step[], Step[], boolean][] = [
    ["the same line", [set(5, "A")], [set(5, "B")], false],
    ["lines next to each other", [set(5, "A")], [set(6, "B")], false],
    ["one unchanged line between", [set(5, "A")], [set(7, "B")], true],
    ["an insertion right after a changed line", [set(5, "A")], [insertAfter(5, "B")], false],
    ["a deletion next to a change", [remove(10)], [set(11, "B")], false],
    ["a later patch moved by an earlier one's insertions", [insertAfter(2, "A1", "A2", "A3"), set(19, "A")], [set(18, "B")], true],
    ["the same, next to it", [insertAfter(2, "A1", "A2", "A3"), set(19, "A")], [set(17, "B")], false],
    ["a later patch deleting the mod's own lines", [insertAfter(8, "A1", "A2"), remove(10)], [set(10, "B")], true],
  ]
  for (const [label, a, b, together] of cases)
    test(label, async () => {
      const r = await pair(a, b)
      expect(r.applies).toBe(together)
      expect(r.predicted).toBe(together)
    })
})

describe("the CLI", () => {
  beforeAll(async () => {
    await createHarness(sb)
    await createMod(sb, "six", setLine(6, "line 6, by six"))
    await createMod(sb, "seven", setLine(7, "line 7, by seven"))
    await createMod(sb, "eight", setLine(8, "line 8, by eight"))
  })
  test("installs mods with an unchanged line between them together", async () => {
    const r = await cli(sb, "install", "t/six", "t/eight")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("1.0.0 + t/six + t/eight")
  })
  test("refuses a mod next to an installed one before building, and keeps the build", async () => {
    const r = await cli(sb, "install", "t/seven")
    expect(r.code).toBe(1)
    expect(r.err).toContain("t/seven does not work with t/six on Fake: both change lines.txt (line 7)")
    expect(r.all).not.toContain("building")
    expect(await greeting(sb)).toBe("hello from stock")
    expect((await cli(sb, "status")).out).toContain("t/six + t/eight")
  })
  test("names every installed mod it clashes with", async () => {
    await createMod(sb, "seven-too", setLine(7, "line 7, by seven-too"))
    const r = await cli(sb, "install", "t/seven")
    expect(r.err).toContain("t/seven does not work with t/six on Fake: both change lines.txt (line 7); nor with t/eight on Fake: both change lines.txt (line 8)")
    expect(r.err).toContain("`openmods off t/six t/eight`")
  })
  test("once they are off, it installs, and they cannot come back on", async () => {
    expect((await cli(sb, "off", "t/six", "--fake")).code).toBe(0)
    expect((await cli(sb, "uninstall", "t/eight")).code).toBe(0)
    const i = await cli(sb, "install", "t/seven")
    expect(i.code, i.all).toBe(0)
    const r = await cli(sb, "on", "t/six")
    expect(r.code).toBe(1)
    expect(r.err).toContain("t/six does not work with t/seven")
  })
  test("info lists the mods it does not work with", async () => {
    const out = (await cli(sb, "info", "t/seven")).out
    expect(out).toContain("does not work with")
    expect(out).toContain("t/six")
    expect(out).toContain("t/eight")
    expect(out).toContain("t/seven-too")
  })
  test("the site lists them on the mod's page and in index.json", async () => {
    const out = path.join(sb.T, "site")
    expect((await script(sb, SITE, "--registry", sb.reg, "--out", out, "--offline")).code).toBe(0)
    const page = readFileSync(path.join(out, "mods", "t", "seven", "index.html"), "utf8")
    expect(page).toContain("Cannot be installed together with")
    expect(page).toContain("t/six")
    const index = JSON.parse(readFileSync(path.join(out, "index.json"), "utf8"))
    expect(index.mods.find((m: { id: string }) => m.id === "t/seven").harnesses.fake.incompatible).toEqual(["t/eight", "t/seven-too", "t/six"])
    expect(index.mods.find((m: { id: string }) => m.id === "t/six").harnesses.fake.incompatible).toEqual(["t/seven", "t/seven-too"])
  })
})
