// The release watch when checks cannot tell, and when releases come quickly:
// a check that could not run to the end (the release or its dependencies
// could not be fetched, or it crashed and left no result) records nothing
// against the mod and is tried again; and a release after one that changed
// the build recipe is compared with the release the recipe last worked at.
import { beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { addFile, cli, createHarness, createMod, release, sandbox, script, setGreeting, versions, WATCH } from "./harness"

const sb = sandbox("release-watch")
const dirOf = (name: string) => path.join(sb.reg, "mods", "t", name, "fake")
const statusOf = (name: string) => JSON.parse(readFileSync(path.join(dirOf(name), "status.json"), "utf8"))
const results = () => path.join(sb.T, "results")
const plan = (names: string[]) => JSON.stringify(names.map((n) => ({ mod: `mods/t/${n}/fake`, harness: "fake", ref: "v1.1.0" })))
const apply = (names: string[]) => script(sb, WATCH, "apply", results(), "--matrix", plan(names), "--registry", sb.reg)
const commitTitle = () => readFileSync(path.join(results(), "COMMIT_MSG"), "utf8").split("\n")[0]

beforeAll(async () => {
  await createHarness(sb)
  for (const name of ["good", "crashed", "garbled", "offline"]) await createMod(sb, name, addFile(`${name}.txt`, `${name}\n`))
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
  test("counts the runs a mod could not be checked, up to three, and stops writing then", async () => {
    await apply(["crashed"])
    await apply(["crashed"])
    const third = readFileSync(path.join(dirOf("crashed"), "status.json"), "utf8")
    expect(JSON.parse(third).unchecked.runs).toBe(3)
    await apply(["crashed"])
    expect(readFileSync(path.join(dirOf("crashed"), "status.json"), "utf8")).toBe(third)
  })
  test("a check that does tell replaces the count with its verdict", async () => {
    writeFileSync(path.join(results(), "mods_t_crashed_fake.json"), JSON.stringify({ mod: "t/crashed", harness: "fake", ref: "v1.1.0", commit: "x", applies: false, error: "patch does not apply" }))
    expect((await apply(["crashed"])).code).toBe(0)
    const st = statusOf("crashed")
    expect(st).toMatchObject({ tested: "v1.1.0", ok: false })
    expect(st.unchecked).toBeUndefined()
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
