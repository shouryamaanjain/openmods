// A build in a terminal: a line per step with its time, a live line for the
// step running, and the build's own output in a log file, shown only when a
// step fails. The time each step took is kept, so the next build can say how
// long it has left and the update question how long an update takes.
import { beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { lastRebuild } from "../src/progress"
import { cli, createHarness, createMod, run, sandbox, setGreeting } from "./harness"

const sb = sandbox("progress")
const live = { env: { OPENMODS_LIVE: "1", NO_COLOR: "1" } }
const definition = path.join(sb.reg, "harnesses", "fake.json")
const setBuild = (build: string) => writeFileSync(definition, JSON.stringify({ ...JSON.parse(readFileSync(definition, "utf8")), build }))
const logs = () => readdirSync(path.join(sb.om, "logs")).map((f) => path.join(sb.om, "logs", f))
const timings = () => JSON.parse(readFileSync(path.join(sb.om, "timings.json"), "utf8")).fake

beforeAll(async () => {
  await createHarness(sb)
  await createMod(sb, "friendly", setGreeting("hello from friendly"))
})

describe("a build in a terminal", () => {
  test("shows each step and its time, and keeps the build's own output in a log", async () => {
    const r = await run(sb, live, "install", "t/friendly")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("Fake 1.0.0 + t/friendly")
    for (const step of ["Source", "Patches", "Dependencies", "Build"]) expect(r.out).toMatch(new RegExp(`✓ ${step} +0:0\\d`))
    expect(r.out).not.toContain("installing dependencies")
    expect(r.out).not.toContain("building")
    const log = readFileSync(logs().at(-1)!, "utf8")
    expect(log).toContain("installing dependencies")
    expect(log).toContain("building")
    expect(r.out).toContain("now runs Fake 1.0.0 + t/friendly")
  })
  test("keeps how long each step took, a first build apart from later ones", async () => {
    expect(Object.keys(timings()).sort()).toEqual(["Build:first", "Dependencies:first", "Patches:first", "Source:first"])
    await cli(sb, "check-updates", "fake")
    expect(readFileSync(path.join(sb.om, "updates", "fake"), "utf8")).toContain("ESTIMATE=''")
    await run(sb, live, "update", "fake", "--force")
    expect(Object.keys(timings())).toContain("Build")
    // Now a rebuild was timed, the update question can say how long one takes.
    await cli(sb, "check-updates", "fake")
    expect(readFileSync(path.join(sb.om, "updates", "fake"), "utf8")).toContain("ESTIMATE='under a minute'")
  })
  test("a rebuild is not estimated from a first build, and never outlasts the bar", async () => {
    const file = path.join(sb.om, "timings.json")
    writeFileSync(file, JSON.stringify({ fake: { "Build:first": 600, Build: 600 } }))
    setBuild(
      "printf '    Building [==================> ] 99/100: codex\\r' && sleep 1.5 && mkdir -p out/bin && cp greet.sh out/bin/greet && chmod +x out/bin/greet",
    )
    const r = await run(sb, live, "update", "fake", "--force")
    expect(r.code, r.all).toBe(0)
    const withBar = r.out.split("\r").filter((frame) => frame.includes("99%"))
    expect(withBar.length).toBeGreaterThan(0)
    expect(withBar.some((frame) => frame.includes("min left"))).toBe(false)
    writeFileSync(file, JSON.stringify({ fake: { "Build:first": 600 } }))
    setBuild("sleep 1.5 && mkdir -p out/bin && cp greet.sh out/bin/greet && chmod +x out/bin/greet")
    expect((await run(sb, live, "update", "fake", "--force")).out).not.toContain("min left")
  })
  test("turns a build's reported progress into a bar", async () => {
    setBuild(
      "printf '    Building [=====>     ] 5/10: some-crate\\r' && sleep 1.5 && mkdir -p out/bin && cp greet.sh out/bin/greet && chmod +x out/bin/greet",
    )
    const r = await run(sb, live, "update", "fake", "--force")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("██████████░░░░░░░░░░   50%")
  })
  test("says how long is left from the last build here, once it is a minute or more", async () => {
    const file = path.join(sb.om, "timings.json")
    writeFileSync(file, JSON.stringify({ fake: { ...timings(), Build: 600 } }))
    setBuild("sleep 1.5 && mkdir -p out/bin && cp greet.sh out/bin/greet && chmod +x out/bin/greet")
    const r = await run(sb, live, "update", "fake", "--force")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("· ~10 min left")
    expect(r.out).not.toContain("<1 min")
  })
  test("a failed step says so, with the end of its output and the log", async () => {
    setBuild("echo 'error: cannot find this'; exit 2")
    const r = await run(sb, live, "update", "fake", "--force")
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/✗ Build +failed after 0:0\d/)
    expect(r.out).toContain("error: cannot find this")
    const shown = r.out.match(/Full log: (\S+)/)?.[1]
    expect(shown && existsSync(shown)).toBe(true)
  })
})

describe("when things go wrong", () => {
  const good = "mkdir -p out/bin && cp greet.sh out/bin/greet && chmod +x out/bin/greet"
  test("a progress report split across two chunks of output still makes a bar", async () => {
    setBuild(`printf '    Building [=====>     ] 5/' && sleep 0.3 && printf '10: some-crate\\r' && sleep 1.5 && ${good}`)
    const r = await run(sb, live, "update", "fake", "--force")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("50%")
  })
  test("a build that finishes without its binary fails its Build step, with the log", async () => {
    setBuild("rm -rf out && echo compiled nothing")
    const r = await run(sb, live, "update", "fake", "--force")
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/✗ Build +failed after/)
    expect(r.out).toContain("compiled nothing")
    expect(r.out).toContain("Full log:")
    expect(r.err).toContain("build finished but")
  })
  test.skipIf(process.getuid?.() === 0)("a timings file that cannot be written does not stop a build", async () => {
    setBuild(good)
    const file = path.join(sb.om, "timings.json")
    chmodSync(file, 0o444)
    const r = await run(sb, live, "update", "fake", "--force")
    chmodSync(file, 0o644)
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("✓ Build")
  })
  test("a release that cannot be fetched fails its Source step", async () => {
    const saved = readFileSync(definition, "utf8")
    writeFileSync(definition, JSON.stringify({ ...JSON.parse(saved), repo: `file://${path.join(sb.T, "no-such-repo")}` }))
    rmSync(path.join(sb.om, "harnesses", "fake", "src"), { recursive: true, force: true })
    const r = await run(sb, live, "update", "fake", "--force")
    writeFileSync(definition, saved)
    rmSync(path.join(sb.om, "harnesses", "fake", "src"), { recursive: true, force: true })
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/✗ Source +failed after/)
  })
})

describe("the rebuild estimate", () => {
  test("needs every step of a rebuild timed, not a first build's", () => {
    const file = path.join(sb.T, "partial.json")
    writeFileSync(file, JSON.stringify({ fake: { Source: 3, Patches: 1, Dependencies: 20 } }))
    expect(lastRebuild(file, "fake")).toBeUndefined()
    writeFileSync(file, JSON.stringify({ fake: { Source: 3, Patches: 1, Dependencies: 20, "Build:first": 500 } }))
    expect(lastRebuild(file, "fake")).toBeUndefined()
    writeFileSync(file, JSON.stringify({ fake: { Source: 3, Patches: 1, Dependencies: 20, Build: 90 } }))
    expect(lastRebuild(file, "fake")).toBe(114)
  })
})

describe("outside a terminal", () => {
  test("the build's output streams as before, with no step lines", async () => {
    setBuild("echo building && mkdir -p out/bin && cp greet.sh out/bin/greet && chmod +x out/bin/greet")
    const r = await cli(sb, "update", "fake", "--force")
    expect(r.code, r.all).toBe(0)
    expect(r.all).toContain("building")
    expect(r.out).not.toContain("✓ Build")
  })
})
