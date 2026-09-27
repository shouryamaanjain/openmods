// The release watch when checks cannot tell, and when releases come quickly:
// a check that could not run to the end (the release or its dependencies
// could not be fetched, or it crashed and left no result) records nothing
// against the mod and is tried again; and a release after one that changed
// the build recipe is compared with the release the recipe last worked at.
import { beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { addFile, cli, createHarness, createMod, git, release, sandbox, script, setGreeting, versions, WATCH } from "./harness"

const sb = sandbox("release-watch")
const dirOf = (name: string) => path.join(sb.reg, "mods", "t", name, "fake")
const statusOf = (name: string) => JSON.parse(readFileSync(path.join(dirOf(name), "status.json"), "utf8"))
const results = () => path.join(sb.T, "results")
const plan = (names: string[]) => JSON.stringify(names.map((n) => ({ mod: `mods/t/${n}/fake`, harness: "fake", ref: "v1.1.0" })))
const apply = (names: string[]) => script(sb, WATCH, "apply", results(), "--matrix", plan(names), "--registry", sb.reg)

// A stand-in for the GitHub CLI: it records every call, answers \`issue list\`
// with issues.json, and fails the call fail-gh names (\`issue create\`, say).
const ghLog = () => path.join(sb.T, "gh.log")
const ghIssues = () => path.join(sb.T, "issues.json")
const ghFails = () => path.join(sb.T, "fail-gh")
const applyWithIssues = (names: string[]) => watchWithIssues("apply", results(), "--matrix", plan(names))
async function watchWithIssues(...a: string[]) {
  const p = Bun.spawn(["bun", WATCH, ...a, "--registry", sb.reg, "--issues"], {
    cwd: sb.reg,
    env: { ...process.env, PATH: `${path.join(sb.T, "bin")}:${process.env.PATH}`, GITHUB_REPOSITORY: "t/registry", GH_LOG: ghLog(), GH_ISSUES: ghIssues(), GH_FAILS: ghFails() },
    stdout: "pipe",
    stderr: "pipe",
  })
  await p.exited
  return existsSync(ghLog()) ? readFileSync(ghLog(), "utf8").split("\n---\n").filter(Boolean) : []
}
const commitTitle = () => readFileSync(path.join(results(), "COMMIT_MSG"), "utf8").split("\n")[0]

beforeAll(async () => {
  await createHarness(sb)
  for (const name of ["good", "crashed", "garbled", "offline", "counted"]) await createMod(sb, name, addFile(`${name}.txt`, `${name}\n`))
  mkdirSync(path.join(sb.T, "bin"), { recursive: true })
  writeFileSync(
    path.join(sb.T, "bin", "gh"),
    `#!/bin/sh\nprintf '%s\\n---\\n' "$*" >> "$GH_LOG"\n[ "$1 $2" = "$(cat "$GH_FAILS" 2>/dev/null)" ] && exit 1\ncase "$1 $2" in\n  "issue list") cat "$GH_ISSUES" 2>/dev/null || echo "[]" ;;\n  "issue create") echo "https://github.com/t/registry/issues/9" ;;\nesac\n`,
  )
  chmodSync(path.join(sb.T, "bin", "gh"), 0o755)
  await createMod(sb, "friendly", setGreeting("hello from friendly"))
  await release(sb, "v1.1.0", addFile("CHANGELOG.md", "1.1.0\n"))
})

describe("a check that could not tell", () => {
  test("a release that cannot be fetched is not checked, not a failure of the mod", async () => {
    const r = await cli(sb, "check", dirOf("good"), "--ref", "v9.9.9", "--typecheck", "--json", "--workspace", path.join(sb.T, "ws"))
    expect(r.code).toBe(1)
    const j = JSON.parse(r.out)
    expect(j.unchecked).toContain("could not get v9.9.9")
    expect(j.applies).toBeUndefined()
  })
  test("dependencies that cannot be installed are not a failure of the mod either", async () => {
    const file = path.join(sb.reg, "harnesses", "fake.json")
    const h = readFileSync(file, "utf8")
    writeFileSync(file, JSON.stringify({ ...JSON.parse(h), install: "echo 'network is down' >&2; exit 3" }))
    try {
      const r = await cli(sb, "check", dirOf("good"), "--ref", "v1.1.0", "--typecheck", "--json", "--workspace", path.join(sb.T, "ws"))
      expect(r.code).toBe(1)
      const j = JSON.parse(r.out)
      expect(j.applies).toBe(true)
      expect(j.typechecks).toBeUndefined()
      expect(j.unchecked).toContain("could not install the dependencies")
    } finally {
      writeFileSync(file, h)
    }
  })
})

describe("the check's workspace", () => {
  test("openmods' own, left from another repository, follows the harness's, and takes the release's tag from it", async () => {
    const ws = path.join(sb.tmp, "openmods-check-fake")
    const other = path.join(sb.T, "other-harness")
    mkdirSync(other, { recursive: true })
    await git(other, "init", "-q")
    writeFileSync(path.join(other, "greet.sh"), "echo other\n")
    await git(other, "add", "-A")
    await git(other, "commit", "-q", "-m", "other")
    await git(other, "tag", "v1.1.0")
    await git(other, "init", "-q", ws)
    await git(ws, "remote", "add", "origin", other)
    await git(ws, "fetch", "-q", "origin", "tag", "v1.1.0")
    const r = await cli(sb, "check", dirOf("good"), "--ref", "v1.1.0", "--json")
    expect(r.code, r.all).toBe(0)
    expect(JSON.parse(r.out)).toMatchObject({ applies: true, commit: (await git(sb.harness, "rev-parse", "v1.1.0^{commit}")).stdout.toString().trim() })
    expect((await git(ws, "remote", "get-url", "origin")).stdout.toString().trim()).toEndWith(sb.harness)
  })
})

describe("apply", () => {
  test("records the checks that told, and nothing against the ones that could not", async () => {
    mkdirSync(results(), { recursive: true })
    const good = await cli(sb, "check", dirOf("good"), "--ref", "v1.1.0", "--typecheck", "--json", "--workspace", path.join(sb.T, "ws"))
    expect(good.code, good.all).toBe(0)
    writeFileSync(path.join(results(), "mods_t_good_fake.json"), good.out)
    // crashed: no result at all. garbled: half a result. offline: could not install.
    writeFileSync(path.join(results(), "mods_t_garbled_fake.json"), '{"mod": "t/garbled", "applies": tr')
    writeFileSync(path.join(results(), "mods_t_offline_fake.json"), JSON.stringify({ mod: "t/offline", harness: "fake", ref: "v1.1.0", applies: true, unchecked: "could not install the dependencies: network is down", error: "network is down" }))
    const r = await apply(["good", "crashed", "garbled", "offline"])
    expect(r.code, r.err).toBe(0)
    expect(versions(dirOf("good")).map((v) => v.ref)).toContain("v1.1.0")
    for (const name of ["crashed", "garbled", "offline"]) {
      expect(versions(dirOf(name)).map((v) => v.ref)).not.toContain("v1.1.0")
      const st = existsSync(path.join(dirOf(name), "status.json")) ? statusOf(name) : {}
      expect(st.ok).toBeUndefined()
      expect(st.unchecked).toMatchObject({ ref: "v1.1.0", runs: 1 })
    }
    expect(statusOf("offline").unchecked.error).toContain("network is down")
    expect(commitTitle()).toBe("Fake 1.1.0: 1 mod now supports it, 0 do not; 3 mods not checked yet")
  })
  test("counts the runs a mod could not be checked; on the third, asks the maintainers once, then writes nothing more", async () => {
    rmSync(ghLog(), { force: true })
    expect((await applyWithIssues(["counted"])).some((c) => c.startsWith("issue create"))).toBe(false)
    await applyWithIssues(["counted"])
    const third = await applyWithIssues(["counted"])
    const created = third.find((c) => c.startsWith("issue create"))
    expect(created).toContain("The release watch could not check t/counted on Fake 1.1.0")
    expect(created).toContain("--label release watch")
    expect(JSON.parse(readFileSync(path.join(dirOf("counted"), "status.json"), "utf8")).unchecked).toMatchObject({ runs: 3, issued: true })
    const after = readFileSync(path.join(dirOf("counted"), "status.json"), "utf8")
    rmSync(ghLog(), { force: true })
    await applyWithIssues(["counted"])
    expect(readFileSync(path.join(dirOf("counted"), "status.json"), "utf8")).toBe(after)
    expect((existsSync(ghLog()) ? readFileSync(ghLog(), "utf8") : "").includes("issue create")).toBe(false)
  })
  test("an issue GitHub would not take is asked for again on the next run; one already open is not opened twice", async () => {
    const status = path.join(dirOf("counted"), "status.json")
    const st = JSON.parse(readFileSync(status, "utf8"))
    delete st.unchecked.issued
    writeFileSync(status, JSON.stringify(st))
    writeFileSync(ghFails(), "issue create")
    rmSync(ghLog(), { force: true })
    expect((await applyWithIssues(["counted"])).some((c) => c.startsWith("issue create"))).toBe(true)
    rmSync(ghFails())
    expect(JSON.parse(readFileSync(status, "utf8")).unchecked.issued).toBeUndefined()
    // The next run asks again.
    rmSync(ghLog(), { force: true })
    expect((await applyWithIssues(["counted"])).some((c) => c.startsWith("issue create"))).toBe(true)
    expect(JSON.parse(readFileSync(status, "utf8")).unchecked.issued).toBe(true)
    st.unchecked.runs = 3
    writeFileSync(status, JSON.stringify(st))
    // Now it is open already: found, not created again.
    writeFileSync(ghIssues(), JSON.stringify([{ number: 9, title: "The release watch could not check t/counted on Fake 1.1.0" }]))
    rmSync(ghLog(), { force: true })
    const calls = await applyWithIssues(["counted"])
    expect(calls.some((c) => c.startsWith("issue create"))).toBe(false)
    expect(JSON.parse(readFileSync(status, "utf8")).unchecked.issued).toBe(true)
  })
  test("an alert for an older release stays open while the mod still cannot be checked at a newer one", async () => {
    writeFileSync(ghIssues(), JSON.stringify([{ number: 8, title: "The release watch could not check t/counted on Fake 1.0.5" }]))
    rmSync(ghLog(), { force: true })
    const calls = await watchWithIssues("plan", "--ref", "v1.1.0")
    expect(calls.some((c) => c.startsWith("issue close"))).toBe(false)
  })
  test("a verdict closes the mod's could-not-check issues, for any release", async () => {
    writeFileSync(ghIssues(), JSON.stringify([
      { number: 9, title: "The release watch could not check t/counted on Fake 1.1.0" },
      { number: 8, title: "The release watch could not check t/counted on Fake 1.0.5" },
      { number: 7, title: "The release watch could not check t/other on Fake 1.1.0" },
    ]))
    writeFileSync(path.join(results(), "mods_t_counted_fake.json"), JSON.stringify({ mod: "t/counted", harness: "fake", ref: "v1.1.0", commit: "x", applies: false, error: "patch does not apply" }))
    rmSync(ghLog(), { force: true })
    const calls = await applyWithIssues(["counted"])
    expect(calls.filter((c) => c.startsWith("issue close")).map((c) => c.split(" ")[2]).sort()).toEqual(["8", "9"])
    rmSync(ghIssues())
  })
  test("without the plan, a result that cannot be read or named fails the run, after recording the rest", async () => {
    const lone = path.join(sb.T, "lone")
    mkdirSync(lone, { recursive: true })
    writeFileSync(path.join(lone, "mods_t_garbled_fake.json"), "{")
    writeFileSync(path.join(lone, "results.json"), "{")
    const r = await script(sb, WATCH, "apply", lone, "--registry", sb.reg)
    expect(r.code).toBe(1)
    expect(r.err).toContain("does not say which mod it is for")
    expect(statusOf("garbled").unchecked.ref).toBe("v1.1.0")
  })
  test("a check that does tell replaces the count with its verdict", async () => {
    writeFileSync(path.join(results(), "mods_t_crashed_fake.json"), JSON.stringify({ mod: "t/crashed", harness: "fake", ref: "v1.1.0", commit: "x", applies: false, error: "patch does not apply" }))
    expect((await apply(["crashed"])).code).toBe(0)
    const st = statusOf("crashed")
    expect(st).toMatchObject({ tested: "v1.1.0", ok: false })
    expect(st.unchecked).toBeUndefined()
  })
})

describe("recipe alerts", () => {
  const changed = (to: string) => JSON.stringify([{ harness: "fake", name: "Fake", from: "v1.1.0", to, state: "changed", changes: ["-compiler=1", "+compiler=2"] }])
  test("an older release's recipe issue closes only once the newer release's issue is open to replace it", async () => {
    writeFileSync(ghIssues(), JSON.stringify([{ number: 5, title: "Fake 1.2.0 changed the OpenMods build recipe" }]))
    const empty = path.join(sb.T, "no-results")
    mkdirSync(empty, { recursive: true })
    writeFileSync(ghFails(), "issue create")
    rmSync(ghLog(), { force: true })
    let calls = await watchWithIssues("apply", empty, "--recipe", changed("v1.3.0"))
    expect(calls.some((c) => c.startsWith("issue create"))).toBe(true)
    expect(calls.some((c) => c.startsWith("issue close"))).toBe(false)
    rmSync(ghFails())
    rmSync(ghLog(), { force: true })
    calls = await watchWithIssues("apply", empty, "--recipe", changed("v1.3.0"))
    expect(calls.find((c) => c.startsWith("issue close"))).toStartWith("issue close 5")
    rmSync(ghIssues())
  })
})

describe("releases that come quickly", () => {
  test("a release after one that changed the recipe is compared with where the recipe last worked", async () => {
    await release(sb, "v1.2.0", addFile("build.cfg", "compiler=2\n"))
    await release(sb, "v1.3.0", addFile("NEWS.md", "1.3.0\n"))
    mkdirSync(path.join(sb.reg, "status"), { recursive: true })
    // v1.2.0 changed the recipe and is held; nobody has built it yet.
    writeFileSync(path.join(sb.reg, "status", "fake.json"), JSON.stringify({ tested: "v1.2.0", from: "v1.1.0", recipe: "changed", changes: ["-compiler=1", "+compiler=2"] }))
    const r = await script(sb, WATCH, "plan", "--ref", "v1.3.0", "--registry", sb.reg)
    expect(r.code, r.err).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.recipe).toMatchObject([{ harness: "fake", from: "v1.1.0", to: "v1.3.0", state: "changed" }])
    expect(j.matrix).toEqual([])
  })
})
