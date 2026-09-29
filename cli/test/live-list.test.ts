// OpenMods as installed by install.sh, used through the openmods command it
// writes. The mods list is live: list, info and install pull the registry
// first, so a mod published a minute ago shows up without updating anything.
// The program runs from its own copy (~/.openmods/cli, a link to a version
// folder), so pulling never changes it; only `openmods update`, or the
// installer run again, does, and only to a release (a vX.Y.Z tag). An install from before that layout moves over
// the first time it runs this code.
import { beforeAll, describe, expect, test } from "bun:test"
import { appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
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
const releaseOpenMods = (version: string) => git(sb.reg, "tag", `v${version}`)
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
  await releaseOpenMods("0.1.0")
  // The Bun the installer would download: the one running these tests.
  mkdirSync(path.join(sb.om, "toolchains", "bun-1.3.14", "bin"), { recursive: true })
  symlinkSync(process.execPath, path.join(sb.om, "toolchains", "bun-1.3.14", "bin", "bun"))
})

describe("the installer", () => {
  test("sets the program up in its own copy, which the openmods command runs", async () => {
    const r = await installer()
    expect(r.code, r.all).toBe(0)
    expect(lstatSync(copy()).isSymbolicLink()).toBe(true)
    expect(readFileSync(path.join(copy(), ".version"), "utf8")).toBe("0.1.0\n")
    expect(readFileSync(wrapper(), "utf8")).toContain('"$OM/cli/src/index.ts"')
    // status names the version running: the installed copy's.
    expect((await openmods("status")).out).toMatch(/openmods {3}0\.1\.0, home /)
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
    // The launcher itself, at a terminal, with its background look on.
    const started = Date.now()
    const r = await shWith({ OPENMODS_ASSUME_TTY: "1", OPENMODS_NO_CHECK: "" }, path.join(sb.om, "bin", "greet"))
    expect(Date.now() - started).toBeLessThan(2000)
    expect(r.code, r.all).toBe(0)
    const note = path.join(sb.om, "updates", "fake")
    for (let i = 0; i < 60 && !existsSync(note); i++) await Bun.sleep(250)
    expect(readFileSync(note, "utf8")).toContain("Fake 1.1.0 is out, and all your mods support it.")
  })
  test("the background look leaves the registry alone while another command runs", async () => {
    await createMod(sb, "busy", addFile("BUSY.md", "x\n"))
    await commit("t/busy")
    const clone = path.join(sb.om, "registry")
    const head = async () => (await git(clone, "rev-parse", "HEAD")).stdout.toString().trim()
    const before = await head()
    // A command running now: this test's own process.
    mkdirSync(path.join(sb.om, "busy"), { recursive: true })
    writeFileSync(path.join(sb.om, "busy", String(process.pid)), "")
    await openmods("check-updates", "fake")
    expect(await head()).toBe(before)
    rmSync(path.join(sb.om, "busy", String(process.pid)))
    await openmods("check-updates", "fake")
    expect(await head()).not.toBe(before)
  })
  test("a mod revoked in the registry is stopped by the pull that brings the news", async () => {
    writeFileSync(path.join(sb.reg, "revoked.json"), JSON.stringify({ revoked: [{ id: "t/fresh", reason: "It deletes your files." }] }))
    await commit("revoke t/fresh")
    const r = await openmods("list")
    expect(r.out).toContain("t/fresh was removed from OpenMods")
    expect(readFileSync(path.join(sb.om, "bin", "greet"), "utf8")).toContain("build contains a mod removed from OpenMods")
    writeFileSync(path.join(sb.reg, "revoked.json"), JSON.stringify({ revoked: [] }))
    await commit("unrevoke t/fresh")
    await openmods("list")
    expect(readFileSync(path.join(sb.om, "bin", "greet"), "utf8")).not.toContain("removed from OpenMods")
  })
  test("a marker whose process number another process took does not hold the look back", async () => {
    await createMod(sb, "later-still", addFile("LATER.md", "x\n"))
    await commit("t/later-still")
    const clone = path.join(sb.om, "registry")
    const before = (await git(clone, "rev-parse", "HEAD")).stdout.toString().trim()
    // A process started after the marker was written: not the command that left it.
    const other = Bun.spawn(["sleep", "30"])
    const marker = path.join(sb.om, "busy", String(other.pid))
    mkdirSync(path.dirname(marker), { recursive: true })
    writeFileSync(marker, "")
    const old = Date.now() / 1000 - 60
    utimesSync(marker, old, old)
    try {
      await openmods("check-updates", "fake")
    } finally {
      other.kill()
    }
    expect((await git(clone, "rev-parse", "HEAD")).stdout.toString().trim()).not.toBe(before)
    expect(existsSync(marker)).toBe(false)
  })
  test("a removed-mods list named with OPENMODS_REVOKED_URL is fetched even by commands that pull", async () => {
    let hits = 0
    const server = Bun.serve({ port: 0, fetch: () => (hits++, Response.json({ revoked: [] })) })
    const url = { OPENMODS_REVOKED_URL: `http://localhost:${server.port}/revoked.json` }
    await shWith(url, wrapper(), "list")
    await shWith(url, wrapper(), "install", "t/fresh", "--yes")
    expect(hits).toBe(2)
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
  test("pulling never changes it; code not released yet never runs; openmods update switches to a new release and says so", async () => {
    const before = version()
    appendFileSync(path.join(sb.reg, "cli", "src", "reference.ts"), "\n// a newer openmods\n")
    await commit("a newer openmods")
    expect((await openmods("list")).code).toBe(0)
    expect(readFileSync(path.join(copy(), "src", "reference.ts"), "utf8")).not.toContain("a newer openmods")
    // Merged, but not released: update leaves the program as it is.
    expect((await openmods("update")).all).not.toContain("OpenMods is updated")
    expect(readFileSync(path.join(copy(), "src", "reference.ts"), "utf8")).not.toContain("a newer openmods")
    await releaseOpenMods("0.1.1")
    // A tag that is not a plain version is not a release.
    await git(sb.reg, "tag", "v9.9.9-rc1")
    const r = await openmods("update")
    expect(r.code, r.all).toBe(0)
    expect(r.all).toContain(`OpenMods is updated: ${before} → 0.1.1.`)
    expect(version()).toBe("0.1.1")
    expect(readFileSync(path.join(copy(), "src", "reference.ts"), "utf8")).toContain("a newer openmods")
    // The version before stays, for a command that started on it.
    expect(readdirSync(path.join(sb.om, "cli-versions")).filter((d) => !d.startsWith(".")).length).toBe(2)
    expect((await openmods("update")).all).not.toContain("OpenMods is updated")
  })
  test("when the releases cannot be reached, update says so and goes on with the mods", async () => {
    const before = version()
    const clone = path.join(sb.om, "registry")
    await git(clone, "remote", "set-url", "origin", path.join(sb.T, "unreachable"))
    const r = await openmods("update")
    await git(clone, "remote", "set-url", "origin", `file://${sb.reg}`)
    expect(r.code, r.all).toBe(0)
    expect(r.err).toContain("note: could not update OpenMods itself (could not reach ")
    expect(version()).toBe(before)
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
    await releaseOpenMods("0.1.2")
    // A file where the version folders go: nothing can be set up there, for
    // any user, root included. The current copy is kept elsewhere meanwhile.
    const versions = path.join(sb.om, "cli-versions")
    const aside = path.join(sb.T, "versions-aside")
    const current = path.basename(realpathSync(copy()))
    renameSync(versions, aside)
    rmSync(copy())
    symlinkSync(path.join(aside, current), copy())
    writeFileSync(versions, "not a folder\n")
    // The openmods command of an older install, which must keep working.
    const before = readFileSync(wrapper(), "utf8")
    writeFileSync(wrapper(), before.replace('"$OM/cli/src/index.ts"', '"$OM/registry/cli/src/index.ts"'), { mode: 0o755 })
    const r = await installer()
    const after = readFileSync(wrapper(), "utf8")
    writeFileSync(wrapper(), before, { mode: 0o755 })
    rmSync(versions)
    renameSync(aside, versions)
    rmSync(copy())
    symlinkSync(path.join(versions, current), copy())
    expect(r.code).not.toBe(0)
    expect(r.all).toContain("openmods could not set itself up")
    expect(after).toContain('"$OM/registry/cli/src/index.ts"')
  })
  test("the installer fails when setup does, even with the program already on that release", async () => {
    // A harness definition setup cannot read.
    const bad = path.join(sb.om, "registry", "harnesses", "broken.json")
    writeFileSync(bad, "{")
    const r = await installer()
    rmSync(bad)
    expect(r.code).not.toBe(0)
    expect(r.all).toContain("openmods could not set itself up")
  })
  test("setup on its own leaves the program alone and needs no network", async () => {
    const before = version()
    const clone = path.join(sb.om, "registry")
    await git(clone, "remote", "set-url", "origin", path.join(sb.T, "unreachable"))
    const r = await openmods("setup")
    await git(clone, "remote", "set-url", "origin", `file://${sb.reg}`)
    expect(r.code, r.all).toBe(0)
    expect(version()).toBe(before)
  })
  test("an update keeps the version the command itself runs from, even when the link was switched away from it", async () => {
    const versions = path.join(sb.om, "cli-versions")
    // This command runs 0.1.1 while another has already switched the link
    // to 0.1.2, and a newer release is out.
    const mine = path.join(versions, "0.1.1")
    if (!existsSync(mine)) {
      cpSync(realpathSync(copy()), mine, { recursive: true })
      writeFileSync(path.join(mine, ".version"), "0.1.1\n")
    }
    appendFileSync(path.join(sb.reg, "cli", "src", "reference.ts"), "\n// yet another openmods\n")
    await commit("yet another openmods")
    await releaseOpenMods("0.1.3")
    const r = await sh("-c", `exec "$0" "$@"`, path.join(sb.om, "toolchains", "bun-1.3.14", "bin", "bun"), path.join(mine, "src", "index.ts"), "update")
    expect(r.code, r.all).toBe(0)
    expect(version()).toBe("0.1.3")
    expect(existsSync(mine)).toBe(true)
  })
  test("a release is taken as the remote has it, not as a tag fetched here before", async () => {
    // Fetched here once, then moved on the remote before it was set up.
    appendFileSync(path.join(sb.reg, "cli", "src", "reference.ts"), "\n// first try\n")
    await commit("first try")
    await releaseOpenMods("0.1.4")
    await git(path.join(sb.om, "registry"), "fetch", "-q", "origin", "tag", "v0.1.4")
    appendFileSync(path.join(sb.reg, "cli", "src", "reference.ts"), "\n// the real one\n")
    await commit("the real one")
    await git(sb.reg, "tag", "-f", "v0.1.4")
    const r = await openmods("update")
    expect(r.code, r.all).toBe(0)
    expect(version()).toBe("0.1.4")
    expect(readFileSync(path.join(copy(), "src", "reference.ts"), "utf8")).toContain("the real one")
  })
  test("when the openmods command cannot be pointed at the new version, it says so and keeps working", async () => {
    // An install from before, whose command runs the registry clone, with
    // its bin folder read-only.
    const bin = path.join(sb.om, "bin")
    const before = readFileSync(wrapper(), "utf8")
    writeFileSync(wrapper(), before.replace('"$OM/cli/src/index.ts"', '"$OM/registry/cli/src/index.ts"'), { mode: 0o755 })
    rmSync(copy())
    chmodSync(bin, 0o555)
    const r = await openmods("status")
    chmodSync(bin, 0o755)
    writeFileSync(wrapper(), before, { mode: 0o755 })
    expect(r.code, r.all).toBe(0)
    expect(r.err).toContain("the openmods command could not be pointed at it")
  })
  test("running the installer again leaves it working, on the newest release", async () => {
    const r = await installer()
    expect(r.code, r.all).toBe(0)
    expect(version()).toBe("0.1.4")
    expect(readFileSync(wrapper(), "utf8")).toContain('"$OM/cli/src/index.ts"')
    expect((await openmods("status")).code).toBe(0)
  })
})
