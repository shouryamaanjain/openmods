// Which mod versions CI checks for a change (script/changed-versions.ts):
// the versions it touches, the mods on top of a changed base patch, and every
// mod's newest version when the CLI changes.
// The registry here is a git repository; each test commits a pull request's
// changes on top of main.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { addFile, addVersion, createHarness, createMod, git, release, sandbox, setGreeting, setLine, versions } from "./harness"

const sb = sandbox("ci")
const CHANGED = path.resolve(import.meta.dir, "../../script/changed-versions.ts")
const friendly = () => path.join(sb.reg, "mods", "t", "friendly", "fake")
const base = () => path.join(sb.reg, "mods", "openmods", "base", "fake")
// A version's first patch, as support.json lists it.
const patchOf = (dir: string, ref: string) => path.join(dir, versions(dir).find((v) => v.ref === ref)!.patches[0]!)

let main = ""
const commit = async (msg: string) => {
  await git(sb.reg, "add", "-A")
  await git(sb.reg, "commit", "-q", "-m", msg)
  return (await $`git -C ${sb.reg} rev-parse HEAD`.text()).trim()
}
const checked = async () => {
  await commit("pull request")
  const r = await $`bun ${CHANGED} --registry ${sb.reg} --base ${main}`.quiet()
  return JSON.parse(r.stdout.toString()) as { mod: string; at: string }[]
}

beforeAll(async () => {
  await createHarness(sb)
  await $`git -C ${sb.reg} init -q -b main`.quiet()
  await createMod(sb, "friendly", setGreeting("hello from friendly"))
  await createMod(sb, "base", setLine(1, "line 1, by openmods"), { owner: "openmods" })
  await release(sb, "v2.0.0", addFile("CHANGELOG.md", "2.0.0\n"))
  await addVersion(sb, friendly(), "v2.0.0")
  await addVersion(sb, base(), "v2.0.0")
  main = await commit("registry")
})

beforeEach(async () => {
  await git(sb.reg, "checkout", "-q", "-B", "pr", main)
  await git(sb.reg, "clean", "-qfd")
})

describe("the versions CI checks", () => {
  test("an older version's patch that changed, and not the newest", async () => {
    appendFileSync(patchOf(friendly(), "v1.0.0"), "\n")
    expect(await checked()).toEqual([{ mod: "mods/t/friendly/fake", at: "v1.0.0" }])
  })
  test("a version whose entry in support.json changed", async () => {
    const file = path.join(friendly(), "support.json")
    const support = JSON.parse(await Bun.file(file).text())
    support.versions[1].note = "a note on the older version"
    writeFileSync(file, JSON.stringify(support, null, 2))
    expect(await checked()).toEqual([{ mod: "mods/t/friendly/fake", at: "v1.0.0" }])
  })
  test("the newest version when the README changed", async () => {
    appendFileSync(path.join(sb.reg, "mods", "t", "friendly", "README.md"), "\nMore.\n")
    expect(await checked()).toEqual([{ mod: "mods/t/friendly/fake", at: "v2.0.0" }])
  })
  test("a changed base patch version, with every mod on top of it at that release", async () => {
    appendFileSync(patchOf(base(), "v1.0.0"), "\n")
    expect(await checked()).toEqual([
      { mod: "mods/openmods/base/fake", at: "v1.0.0" },
      { mod: "mods/t/friendly/fake", at: "v1.0.0" },
    ])
  })
  test("every mod's newest version when the CLI changed, as well as what a mod change touches", async () => {
    mkdirSync(path.join(sb.reg, "cli"), { recursive: true })
    writeFileSync(path.join(sb.reg, "cli", "x.ts"), "export {}\n")
    appendFileSync(patchOf(friendly(), "v1.0.0"), "\n")
    const r = await checked()
    expect(r).toContainEqual({ mod: "mods/t/friendly/fake", at: "v1.0.0" })
    expect(r).toContainEqual({ mod: "mods/t/friendly/fake", at: "v2.0.0" })
    expect(r).toContainEqual({ mod: "mods/openmods/base/fake", at: "v2.0.0" })
  })
  test("every mod's newest version when how mods are checked changed", async () => {
    mkdirSync(path.join(sb.reg, "script"), { recursive: true })
    writeFileSync(path.join(sb.reg, "script", "changed-versions.ts"), "// changed\n")
    const r = await checked()
    expect(r).toContainEqual({ mod: "mods/t/friendly/fake", at: "v2.0.0" })
    expect(r).toContainEqual({ mod: "mods/openmods/base/fake", at: "v2.0.0" })
  })
  test("nothing for a change outside the mods, the CLI and the harnesses", async () => {
    writeFileSync(path.join(sb.reg, "NOTES.md"), "notes\n")
    expect(await checked()).toEqual([])
  })
})
