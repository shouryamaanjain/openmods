// A build in a terminal: a line per step with its time, a live line for the
// step running, and the build's own output in a log file, shown only when a
// step fails. The time each step took is kept, so the next build can say how
// long it has left and the update question how long an update takes.
import { beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
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
    await run(sb, live, "update", "fake", "--force")
    expect(Object.keys(timings())).toContain("Build")
  })
  test("turns a build's reported progress into a bar", async () => {
    setBuild(
      "printf '    Building [=====>     ] 5/10: some-crate\\r' && sleep 0.6 && mkdir -p out/bin && cp greet.sh out/bin/greet && chmod +x out/bin/greet",
    )
    const r = await run(sb, live, "update", "fake", "--force")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("██████████░░░░░░░░░░   50%")
  })
  test("says how long is left from the last build here, once it is a minute or more", async () => {
    const file = path.join(sb.om, "timings.json")
    writeFileSync(file, JSON.stringify({ fake: { ...timings(), Build: 600 } }))
    setBuild("sleep 0.6 && mkdir -p out/bin && cp greet.sh out/bin/greet && chmod +x out/bin/greet")
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

describe("outside a terminal", () => {
  test("the build's output streams as before, with no step lines", async () => {
    setBuild("echo building && mkdir -p out/bin && cp greet.sh out/bin/greet && chmod +x out/bin/greet")
    const r = await cli(sb, "update", "fake", "--force")
    expect(r.code, r.all).toBe(0)
    expect(r.all).toContain("building")
    expect(r.out).not.toContain("✓ Build")
  })
})
