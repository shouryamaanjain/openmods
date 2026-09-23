// A mod keeps one version per harness release it has worked on. Mods that
// move to new releases at different speeds can still be built together at a
// release they all have, and nothing moves a user to another release except
// update, or a mod that has no version for the one they are on.
import { beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { addFile, addVersion, cli, createHarness, createMod, git, greeting, release, sandbox, setGreeting, versions } from "./harness"

const sb = sandbox("history")
const dirOf = (name: string) => path.join(sb.reg, "mods", "t", name, "fake")
const state = () => JSON.parse(readFileSync(path.join(sb.om, "state.json"), "utf8")).fake

beforeAll(async () => {
  await createHarness(sb)
  await createMod(sb, "friendly", setGreeting("hello from friendly"))
  await createMod(sb, "notes", addFile("NOTES.md", "notes\n"))
  await createMod(sb, "extra", addFile("EXTRA.md", "extra\n"))
  // Fake 1.1.0 is out. friendly moved to it; notes and extra did not.
  await release(sb, "v1.1.0", addFile("CHANGELOG.md", "1.1.0\n"))
  await addVersion(sb, dirOf("friendly"), "v1.1.0")
  // Fake 1.2.0 is out, and a mod made only for it.
  await release(sb, "v1.2.0", addFile("CHANGELOG.md", "1.2.0\n"))
  await createMod(sb, "fresh", addFile("FRESH.md", "fresh\n"), { base: "v1.2.0" })
})

describe("building", () => {
  test("a mod on its own builds its newest version", async () => {
    const r = await cli(sb, "install", "t/friendly")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("now runs Fake 1.1.0 + t/friendly")
  })
  test("adding a mod with no version for the current release builds the newest release both have, and says so", async () => {
    const r = await cli(sb, "install", "t/notes")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("building Fake 1.0.0, not 1.1.0: t/notes has no version for 1.1.0")
    expect(r.out).toContain("now runs Fake 1.0.0 + t/friendly + t/notes")
    expect(await greeting(sb)).toBe("hello from friendly")
  })
  test("other rebuilds stay on the release, with each mod's version for it", async () => {
    expect((await cli(sb, "install", "t/extra")).code).toBe(0)
    const r = await cli(sb, "uninstall", "t/extra")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("now runs Fake 1.0.0 + t/friendly + t/notes")
    expect(r.out).not.toContain("note: building")
    expect(state().ref).toBe("v1.0.0")
  })
  test("mods with no release in common are refused, naming what each has, and the build stays", async () => {
    const r = await cli(sb, "install", "t/fresh")
    expect(r.code).toBe(1)
    expect(r.err).toContain("have no Fake release in common")
    expect(r.err).toContain("t/friendly is for 1.1.0, 1.0.0; t/notes is for 1.0.0; t/fresh is for 1.2.0")
    expect(state().mods).toEqual(["t/friendly", "t/notes"])
    expect(await greeting(sb)).toBe("hello from friendly")
  })
})

describe("updates", () => {
  test("a newer release is blocked by the mods with no version for it", async () => {
    const r = await cli(sb, "check-updates", "fake", "--json")
    expect(JSON.parse(r.out)).toMatchObject({ current: "1.0.0", available: "1.1.0", allSupport: false, blocked: ["t/notes"] })
    expect((await cli(sb, "update", "fake")).out).toContain("already up to date")
  })
  test("once every mod has a version for it, update moves there", async () => {
    await addVersion(sb, dirOf("notes"), "v1.1.0")
    const note = await cli(sb, "check-updates", "fake", "--json")
    expect(JSON.parse(note.out)).toMatchObject({ available: "1.1.0", allSupport: true, blocked: [], moveTo: "1.1.0", ask: true })
    expect((await cli(sb, "status")).out).toContain("update  Fake 1.1.0 is out, and all your mods support it. `open-mods update fake` does it.")
    const r = await cli(sb, "update", "fake")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("now runs Fake 1.1.0 + t/friendly + t/notes")
  })
})

describe("mod updates", () => {
  const work = path.join(sb.T, "work-notes")
  test("the same code packed at another release keeps its update number", async () => {
    await git(work, "fetch", "-q", "--tags")
    await git(work, "checkout", "-q", "v1.2.0")
    writeFileSync(path.join(work, "NOTES.md"), "notes\n")
    await git(work, "add", "-A")
    await git(work, "commit", "-qm", "feat: notes")
    const r = await cli(sb, "pack", work, "--name", "notes", "--owner", "t", "--harness", "fake")
    expect(r.out).toContain("Same code as update 1, so it stays update 1.")
    expect(versions(dirOf("notes"))[0]).toMatchObject({ ref: "v1.2.0", update: 1 })
  })
  test("new code at the release the user is on is offered on its own, with no release change", async () => {
    await git(work, "checkout", "-q", "v1.1.0")
    writeFileSync(path.join(work, "NOTES.md"), "better notes\n")
    await git(work, "add", "-A")
    await git(work, "commit", "-qm", "fix: notes")
    const pack = await cli(sb, "pack", work, "--name", "notes", "--owner", "t", "--harness", "fake", "--force", "--note", "clearer notes")
    expect(pack.out).toContain("This is update 2: clearer notes.")
    const r = JSON.parse((await cli(sb, "check-updates", "fake", "--json")).out)
    expect(r).toMatchObject({ moveTo: "", ask: true, updates: [{ id: "t/notes", update: 2, note: "clearer notes" }] })
    expect(r.message).toBe("New in your Fake mods: t/notes update 2 (clearer notes).")
    const u = await cli(sb, "update", "fake")
    expect(u.code, u.all).toBe(0)
    expect(state().updates).toEqual({ "t/friendly": 1, "t/notes": 2 })
    expect(JSON.parse((await cli(sb, "check-updates", "fake", "--json")).out)).toMatchObject({ ask: false, updates: [] })
  })
})

describe("authoring", () => {
  test("pack adds a version for another release and keeps the others", async () => {
    const work = path.join(sb.T, "work-friendly")
    await git(work, "fetch", "-q", "--tags")
    await git(work, "checkout", "-q", "v1.2.0")
    writeFileSync(path.join(work, "greet.sh"), "#!/bin/sh\necho hello from friendly 1.2\n")
    await git(work, "commit", "-qam", "feat: friendly")
    const r = await cli(sb, "pack", work, "--name", "friendly", "--owner", "t", "--harness", "fake")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("It keeps its versions for 1.1.0, 1.0.0.")
    expect(versions(dirOf("friendly")).map((v) => v.ref)).toEqual(["v1.2.0", "v1.1.0", "v1.0.0"])
  })
  test("pack refuses to replace a release's version without --force", async () => {
    const r = await cli(sb, "pack", path.join(sb.T, "work-friendly"), "--name", "friendly", "--owner", "t", "--harness", "fake")
    expect(r.code).toBe(1)
    expect(r.err).toContain("already has a version for Fake 1.2.0; pass --force")
  })
  test("info lists the versions", async () => {
    expect((await cli(sb, "info", "t/friendly")).out).toContain("versions   1.2.0 (update 2), 1.1.0 (update 1), 1.0.0 (update 1)")
  })
  test("check --at checks an older version", async () => {
    const r = await cli(sb, "check", dirOf("friendly"), "--at", "v1.0.0", "--json", "--workspace", path.join(sb.T, "check"))
    expect(JSON.parse(r.out)).toMatchObject({ madeFor: "v1.0.0", ref: "v1.0.0", applies: true })
  })
  test("the registry check accepts versions and catches a stray patch", async () => {
    const validate = () => $`bun ${path.resolve(import.meta.dir, "../../script/validate.ts")} --registry ${sb.reg}`.nothrow().quiet()
    const ok = await validate()
    expect(ok.stdout.toString() + ok.stderr.toString()).toContain("registry ok")
    writeFileSync(path.join(dirOf("notes"), "v1.0.0", "0002-stray.patch"), "stray\n")
    const bad = await validate()
    expect(bad.exitCode).toBe(1)
    expect(bad.stderr.toString()).toContain("v1.0.0/0002-stray.patch is not listed in support.json")
  })
})
