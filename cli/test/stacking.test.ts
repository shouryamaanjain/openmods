// Several mods on one harness: stacking, declared conflicts, real conflicts,
// and a failed rebuild that must not take the working build away.
import { beforeAll, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { addFile, cli, createHarness, createMod, greeting, sandbox, setGreeting } from "./harness"

const sb = sandbox("stacking")

beforeAll(async () => {
  await createHarness(sb)
  await createMod(sb, "greeting", setGreeting("hello from greeting"))
  await createMod(sb, "readme", addFile("EXTRA.md", "extra\n"))
  await createMod(sb, "rival", setGreeting("hello from rival"))
  await createMod(sb, "declared", addFile("OTHER.md", "other\n"), { conflicts: ["t/readme"] })
})

describe("stacking", () => {
  test("two mods that touch different files install together", async () => {
    const r = await cli(sb, "install", "t/greeting", "t/readme")
    expect(r.code).toBe(0)
    expect(r.out).toContain("1.0.0 + t/greeting + t/readme")
    expect(await greeting(sb)).toBe("hello from greeting")
  })
  test("a mod that rewrites the same lines as an installed one is refused before building, and the build stays", async () => {
    const r = await cli(sb, "install", "t/rival")
    expect(r.code).toBe(1)
    expect(r.err).toContain("t/rival does not work with t/greeting on Fake: both change greet.sh (line 2)")
    expect(r.all).not.toContain("building")
    expect(await greeting(sb)).toBe("hello from greeting")
    expect((await cli(sb, "status")).out).not.toContain("rival")
  })
  test("a declared conflict is refused before anything is built", async () => {
    const r = await cli(sb, "install", "t/declared")
    expect(r.code).toBe(1)
    expect(r.err).toContain("their authors marked them as not working together")
  })
  test("uninstalling one of two keeps the other", async () => {
    const r = await cli(sb, "uninstall", "t/readme")
    expect(r.code).toBe(0)
    expect(r.out).toContain("1.0.0 + t/greeting")
    expect(await greeting(sb)).toBe("hello from greeting")
  })
})

describe("a failed rebuild", () => {
  test("keeps the previous build running", async () => {
    // Break the harness's build command in the registry, then try a rebuild.
    const file = path.join(sb.reg, "harnesses", "fake.json")
    const h = JSON.parse(await Bun.file(file).text())
    writeFileSync(file, JSON.stringify({ ...h, build: "echo build broke >&2; exit 1" }))
    const r = await cli(sb, "update", "fake", "--force")
    expect(r.code).toBe(1)
    expect(r.all).toContain("build broke")
    expect(await greeting(sb)).toBe("hello from greeting")
    writeFileSync(file, JSON.stringify(h))
  })
})
