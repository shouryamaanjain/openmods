// The author's side: pack, local mods, and the site generator.
import { beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { addFile, cli, createHarness, createMod, sandbox, script, setGreeting, SITE } from "./harness"

const sb = sandbox("authoring")

beforeAll(async () => {
  await createHarness(sb)
})

describe("pack", () => {
  test("writes patches and a manifest pinned to the release below the commits", async () => {
    const dir = await createMod(sb, "friendly", setGreeting("hello from friendly"))
    const mod = JSON.parse(readFileSync(path.join(dir, "mod.json"), "utf8"))
    expect(mod.upstream.ref).toBe("v1.0.0")
    expect(mod.upstream.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(mod.patches).toEqual(["patches/0001-feat-friendly.patch"])
    expect(mod.version).toBeUndefined()
    expect(existsSync(path.join(dir, "README.md"))).toBe(true)
  })
  test("refuses a bad name", async () => {
    expect((await cli(sb, "pack", sb.harness, "--name", "Bad_Name", "--harness", "fake")).code).toBe(1)
  })
  test("info lists the files a mod touches", async () => {
    expect((await cli(sb, "info", "fake/friendly")).out).toContain("greet.sh")
  })
})

describe("local mods", () => {
  test("are listed and installable, and shadow a registry mod of the same name", async () => {
    await createMod(sb, "friendly", setGreeting("hello from local friendly"), { local: true })
    const list = await cli(sb, "list")
    expect(list.out).toContain("(local)")
    expect(list.out.match(/fake\/friendly/g)?.length).toBe(1)
    const r = await cli(sb, "install", "fake/friendly")
    expect(r.code).toBe(0)
    const out = await Bun.$`sh ${path.join(sb.om, "bin", "greet")}`.env({ OPEN_MODS_NO_CHECK: "1" }).text()
    expect(out.trim()).toBe("hello from local friendly")
  })
})

describe("site", () => {
  test("builds a page per mod with its release badge and diff", async () => {
    await createMod(sb, "notes", addFile("NOTES.md", "notes\n"))
    const out = path.join(sb.T, "site")
    const r = await script(sb, SITE, "--registry", sb.reg, "--out", out, "--offline")
    expect(r.code).toBe(0)
    const home = readFileSync(path.join(out, "index.html"), "utf8")
    expect(home).toContain("fake/friendly")
    expect(home).toContain("fake/notes")
    const page = readFileSync(path.join(out, "mods", "fake", "notes", "index.html"), "utf8")
    expect(home).toContain('class="badge ok"')
    expect(page).toContain("open-mods install fake/notes")
    expect(page).toContain("Works on the latest Fake release")
    expect(page).toContain("NOTES.md")
    expect(JSON.parse(readFileSync(path.join(out, "index.json"), "utf8")).mods.length).toBe(2)
  })
})
