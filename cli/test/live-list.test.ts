// OpenMods as installed by install.sh, used through the openmods command it
// writes. The mods list is live: list, info and install pull the registry
// first, so a mod published a minute ago shows up without updating anything.
// The program runs from its own copy (~/.openmods/cli, a link to a version
// folder), so pulling never changes it; only `openmods update`, or the
// installer run again, does. An install from before that layout moves over
// the first time it runs this code.
import { beforeAll, describe, expect, test } from "bun:test"
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { addFile, addVersion, createHarness, createMod, git, release, sandbox } from "./harness"

const sb = sandbox("live-list")
const REPO = path.resolve(import.meta.dir, "../..")
const copy = () => path.join(sb.om, "cli")
const wrapper = () => path.join(sb.om, "bin", "openmods")
const commit = async (message: string) => {
  await git(sb.reg, "add", "-A")
  await git(sb.reg, "commit", "-qm", message)
}
const env = () => ({
  ...process.env,
  HOME: sb.home,
  SHELL: "/bin/zsh",
  OPENMODS_HOME: sb.om,
  OPENMODS_REGISTRY: `file://${sb.reg}`,
  OPENMODS_REVOKED_URL: "",
  OPENMODS_NO_CHECK: "1",
  TMPDIR: sb.tmp,
})
async function sh(...a: string[]) {
  return shWith({}, ...a)
}
async function shWith(extra: Record<string, string>, ...a: string[]) {
  const p = Bun.spawn(["sh", ...a], { env: { ...env(), ...extra }, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out, err, all: out + err }
}
const openmods = (...a: string[]) => sh(wrapper(), ...a)
const installer = () => sh(path.join(REPO, "install.sh"))

beforeAll(async () => {
  await createHarness(sb)
  await createMod(sb, "friendly", addFile("FRIENDLY.md", "friendly\n"))
  // The registry as on GitHub: mods, recipes, and the program's source in cli/.
  mkdirSync(path.join(sb.reg, "cli"), { recursive: true })
  for (const f of ["src", "get-bun.sh", "package.json"]) cpSync(path.join(REPO, "cli", f), path.join(sb.reg, "cli", f), { recursive: true })
  await git(sb.reg, "init", "-q")
  await commit("registry")
  // The Bun the installer would download: the one running these tests.
  mkdirSync(path.join(sb.om, "toolchains", "bun-1.3.14", "bin"), { recursive: true })
  symlinkSync(process.execPath, path.join(sb.om, "toolchains", "bun-1.3.14", "bin", "bun"))
})

describe("the installer", () => {
  test("sets the program up in its own copy, which the openmods command runs", async () => {
    const r = await installer()
    expect(r.code, r.all).toBe(0)
    expect(lstatSync(copy()).isSymbolicLink()).toBe(true)
    expect(readFileSync(path.join(copy(), ".version"), "utf8")).toMatch(/^0\.1\.0 \([0-9a-f]+\)$/m)
    expect(readFileSync(wrapper(), "utf8")).toContain('"$OM/cli/src/index.ts"')
  })
})

describe("the mods list", () => {
  test("a mod published since shows up in list, info and install, without updating anything", async () => {
    await createMod(sb, "fresh", addFile("FRESH.md", "fresh\n"))
    await commit("t/fresh")
    expect((await openmods("list")).out).toContain("t/fresh")
    expect((await openmods("info", "t/fresh")).out).toContain("FRESH.md")
    const r = await openmods("install", "t/fresh")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("now runs Fake 1.0.0 + t/fresh")
  })
  test("offline, it uses what this machine fetched last and says so on stderr; --json stays clean", async () => {
    const clone = path.join(sb.om, "registry")
    await git(clone, "remote", "set-url", "origin", path.join(sb.T, "unreachable"))
    const r = await openmods("list")
    const j = await openmods("list", "--json")
    await git(clone, "remote", "set-url", "origin", `file://${sb.reg}`)
    expect(r.code).toBe(0)
    expect(r.err).toContain("note: could not update the mods list (")
    expect(r.err).toContain("using the copy this machine fetched last")
    expect(r.out).toContain("t/fresh")
    expect(() => JSON.parse(j.out)).not.toThrow()
    expect(j.err).toContain("could not update the mods list")
  })
})

describe("one source of mods data", () => {
  test("the launcher's background look pulls the mods list, so it sees a release published since", async () => {
    await release(sb, "v1.1.0", addFile("CHANGELOG.md", "1.1.0\n"))
    await addVersion(sb, path.join(sb.reg, "mods", "t", "fresh", "fake"), "v1.1.0")
    await commit("t/fresh for 1.1.0")
    expect((await openmods("check-updates", "fake")).code).toBe(0)
    expect(readFileSync(path.join(sb.om, "updates", "fake"), "utf8")).toContain("Fake 1.1.0 is out, and all your mods support it.")
  })
  test("commands that pull get the removed-mods list with the pull; the others fetch it on their own", async () => {
    let hits = 0
    const server = Bun.serve({ port: 0, fetch: () => (hits++, Response.json({ revoked: [] })) })
    const url = { OPENMODS_REVOKED_URL: `http://localhost:${server.port}/revoked.json` }
    await shWith(url, wrapper(), "list")
    await shWith(url, wrapper(), "info", "t/fresh")
    expect(hits).toBe(0)
    await shWith(url, wrapper(), "status")
    expect(hits).toBe(1)
    server.stop()
  })
})

describe("the program", () => {
  const version = () => readFileSync(path.join(copy(), ".version"), "utf8").trim()
  test("publishing a mod is not a new version of OpenMods", async () => {
    const before = version()
    await createMod(sb, "third", addFile("THIRD.md", "third\n"))
    await commit("t/third")
    const r = await openmods("update")
    expect(r.all).not.toContain("OpenMods is updated")
    expect(version()).toBe(before)
  })
  test("pulling never changes it; openmods update switches to the new one and says so", async () => {
    const before = version()
    appendFileSync(path.join(sb.reg, "cli", "src", "reference.ts"), "\n// a newer openmods\n")
    await commit("a newer openmods")
    expect((await openmods("list")).code).toBe(0)
    expect(readFileSync(path.join(copy(), "src", "reference.ts"), "utf8")).not.toContain("a newer openmods")
    const r = await openmods("update")
    expect(r.code, r.all).toBe(0)
    expect(r.all).toContain(`OpenMods is updated: ${before} → `)
    expect(readFileSync(path.join(copy(), "src", "reference.ts"), "utf8")).toContain("a newer openmods")
    // The version before stays, for a command that started on it.
    expect(readdirSync(path.join(sb.om, "cli-versions")).filter((d) => !d.includes(".")).length).toBe(2)
    expect((await openmods("update")).all).not.toContain("OpenMods is updated")
  })
  test("an install from before runs it from the registry clone, and moves it out the first time", async () => {
    rmSync(copy())
    writeFileSync(wrapper(), readFileSync(wrapper(), "utf8").replace('"$OM/cli/src/index.ts"', '"$OM/registry/cli/src/index.ts"'), { mode: 0o755 })
    const r = await openmods("status")
    expect(r.code, r.all).toBe(0)
    expect(existsSync(path.join(copy(), "src", "index.ts"))).toBe(true)
    expect(readFileSync(wrapper(), "utf8")).toContain('"$OM/cli/src/index.ts"')
  })
  test("a version folder that is already there is used as it is, never replaced", async () => {
    const versions = path.join(sb.om, "cli-versions")
    const current = realpathSync(copy())
    // As if another command had set up the current version already, while
    // this one still runs an older one.
    writeFileSync(path.join(current, "in-use"), "")
    const older = path.join(versions, "0000000")
    cpSync(current, older, { recursive: true })
    writeFileSync(path.join(older, ".version"), "0.1.0 (0000000)\n")
    rmSync(path.join(older, "in-use"))
    rmSync(copy())
    symlinkSync(older, copy())
    const r = await openmods("update")
    expect(r.code, r.all).toBe(0)
    expect(existsSync(path.join(copy(), "in-use"))).toBe(true)
  })
  test("the installer fails, and says so, when it cannot set the program up", async () => {
    appendFileSync(path.join(sb.reg, "cli", "src", "reference.ts"), "\n// another openmods\n")
    await commit("another openmods")
    // A file where the version folders go: nothing can be set up there, for
    // any user, root included. The current copy is kept elsewhere meanwhile.
    const versions = path.join(sb.om, "cli-versions")
    const aside = path.join(sb.T, "versions-aside")
    const current = path.basename(realpathSync(copy()))
    renameSync(versions, aside)
    rmSync(copy())
    symlinkSync(path.join(aside, current), copy())
    writeFileSync(versions, "not a folder\n")
    const r = await installer()
    rmSync(versions)
    renameSync(aside, versions)
    rmSync(copy())
    symlinkSync(path.join(versions, current), copy())
    expect(r.code).not.toBe(0)
    expect(r.all).toContain("openmods could not set itself up")
  })
  test("running the installer again leaves it working", async () => {
    const r = await installer()
    expect(r.code, r.all).toBe(0)
    expect(readFileSync(wrapper(), "utf8")).toContain('"$OM/cli/src/index.ts"')
    expect((await openmods("status")).code).toBe(0)
  })
})
