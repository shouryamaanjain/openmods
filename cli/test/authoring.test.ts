// The author's side: pack, local mods, and the site generator.
import { beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { addFile, cli, CLI, createHarness, createMod, git, greeting, sandbox, script, setGreeting, SITE } from "./harness"

const sb = sandbox("authoring")

beforeAll(async () => {
  await createHarness(sb)
})

describe("pack", () => {
  test("writes patches and a manifest pinned to the release below the commits", async () => {
    const dir = await createMod(sb, "friendly", setGreeting("hello from friendly"))
    expect(dir).toBe(path.join(sb.reg, "mods", "t", "friendly", "fake"))
    const support = JSON.parse(readFileSync(path.join(dir, "support.json"), "utf8"))
    expect(support.versions).toHaveLength(1)
    expect(support.versions[0].ref).toBe("v1.0.0")
    expect(support.versions[0].commit).toMatch(/^[0-9a-f]{40}$/)
    expect(support.versions[0].patches).toEqual(["v1.0.0/0001-feat-friendly.patch"])
    const meta = JSON.parse(readFileSync(path.join(dir, "..", "mod.json"), "utf8"))
    expect(meta.owner).toBe("t")
    expect(meta.name).toBe("friendly")
    expect(meta.version).toBeUndefined()
    expect(existsSync(path.join(dir, "..", "README.md"))).toBe(true)
  })
  test("refuses a bad name", async () => {
    expect((await cli(sb, "pack", sb.harness, "--name", "Bad_Name", "--owner", "t", "--harness", "fake")).code).toBe(1)
  })
  test("info lists the files a mod touches", async () => {
    expect((await cli(sb, "info", "t/friendly")).out).toContain("greet.sh")
  })
})

describe("local mods", () => {
  test("are listed and installable, and shadow a registry mod of the same name", async () => {
    await createMod(sb, "friendly", setGreeting("hello from local friendly"), { local: true })
    const list = await cli(sb, "list")
    expect(list.out).toContain("(local)")
    expect(list.out.match(/t\/friendly/g)?.length).toBe(1)
    const r = await cli(sb, "install", "t/friendly")
    expect(r.code).toBe(0)
    const out = await Bun.$`sh ${path.join(sb.om, "bin", "greet")}`.env({ OPENMODS_NO_CHECK: "1" }).text()
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
    expect(home).toContain("t/friendly")
    expect(home).toContain("t/notes")
    const page = readFileSync(path.join(out, "mods", "t", "notes", "index.html"), "utf8")
    expect(home).toContain('class="badge ok"')
    expect(page).toContain("openmods install t/notes --fake")
    expect(page).toContain("Works on the latest Fake release")
    expect(page).toContain("NOTES.md")
    expect(JSON.parse(readFileSync(path.join(out, "index.json"), "utf8")).mods.length).toBe(2)
  })
})

describe("trying and publishing from a clone", () => {
  test("install <clone> packs it as a local mod, named after the branch, and installs it", async () => {
    // It changes the same line as t/friendly, installed above.
    expect((await cli(sb, "uninstall", "t/friendly")).code).toBe(0)
    const work = path.join(sb.T, "work-branchy")
    await Bun.$`git clone -q ${sb.harness} ${work}`.quiet()
    await git(work, "checkout", "-q", "-b", "Cool_Mod", "v1.0.0")
    writeFileSync(path.join(work, "greet.sh"), "#!/bin/sh\necho hello from a clone\n")
    await git(work, "commit", "-qam", "feat: greet from a clone")
    const r = await cli(sb, "install", work, "--owner", "t", "--fake")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("as the local mod t/cool-mod")
    expect(r.out).toContain("now runs Fake 1.0.0 + t/cool-mod")
    expect(await greeting(sb)).toBe("hello from a clone")
  })
  test("a clone on a detached release needs --name", async () => {
    const work = path.join(sb.T, "work-branchy")
    await git(work, "checkout", "-q", "--detach", "HEAD")
    const r = await cli(sb, "install", work, "--owner", "t", "--fake")
    expect(r.code).toBe(1)
    expect(r.err).toContain('cannot name the mod after the branch "HEAD"; pass --name <mod>')
    expect((await cli(sb, "install", work, "--owner", "t", "--fake", "--name", "cool-mod")).code).toBe(0)
  })
  test("pack will not publish into the CLI's own copy of the registry", async () => {
    const own = path.join(sb.om, "registry")
    await Bun.$`cp -R ${sb.reg} ${own}`.quiet()
    const p = await Bun.$`bun ${CLI} pack ${path.join(sb.T, "work-branchy")} --name nope --owner t --harness fake --registry ${own}`
      .env({ ...process.env, HOME: sb.home, OPENMODS_HOME: sb.om, OPENMODS_NO_CHECK: "1" })
      .nothrow()
      .quiet()
    expect(p.exitCode).toBe(1)
    expect(p.stderr.toString()).toContain("pack writes the mod into your fork of the registry")
  })
})
