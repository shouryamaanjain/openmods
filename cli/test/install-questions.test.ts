// Installing asks before a change the user may not expect, and a build that
// fails says which mod failed and that nothing changed:
// - a first mod older than the user's own harness: build the older release?
// - adding a mod that moves every mod to another release: go ahead?
// - mods with no release in common: refused, naming what to uninstall, which
//   is the user's call;
// - a failed build: the mod named, and what still runs.
// Without a terminal to ask on, nothing happens and it says to add --yes.
import { beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { addFile, addVersion, cli, createHarness, createMod, greeting, registerHarness, release, run, sandbox, setGreeting } from "./harness"

const sb = sandbox("install-questions")
const state = () => (existsSync(path.join(sb.om, "state.json")) ? JSON.parse(readFileSync(path.join(sb.om, "state.json"), "utf8")).fake : undefined)

beforeAll(async () => {
  // A build that fails when a mod adds the file "breaks".
  await createHarness(sb, { build: '[ -e breaks ] && { echo "error: this mod breaks the build" >&2; exit 1; }; mkdir -p out/bin && cp greet.sh out/bin/greet && chmod +x out/bin/greet' })
  await createMod(sb, "friendly", setGreeting("hello from friendly"))
  await createMod(sb, "breaker", addFile("breaks", "x\n"))
  await release(sb, "v1.1.0", addFile("CHANGELOG.md", "1.1.0\n"))
  await createMod(sb, "later", addFile("LATER.md", "later\n"), { base: "v1.1.0" })
  // The user's own Fake is 1.1.0, newer than friendly supports.
  writeFileSync(path.join(sb.home, ".greet", "bin", "greet"), '#!/bin/sh\n[ "$1" = --version ] && echo 1.1.0 && exit 0\necho stock greet\n', { mode: 0o755 })
})

describe("installing", () => {
  test("a first mod older than the user's own harness is built only on a yes", async () => {
    const question = "Fake 1.0.0 is the newest release t/friendly has a version for; your Fake is 1.1.0. Build Fake 1.0.0 with it?"
    const script = await cli(sb, "install", "t/friendly")
    expect(script.code).toBe(1)
    expect(script.err).toContain(question)
    expect(script.err).toContain("add --yes to go ahead")
    expect(state()).toBeUndefined()
    const no = await run(sb, { answer: "n\n" }, "install", "t/friendly")
    expect(no.out).toContain("Nothing was changed.")
    expect(state()).toBeUndefined()
    const yes = await cli(sb, "install", "t/friendly", "--yes")
    expect(yes.code, yes.all).toBe(0)
    expect(yes.out).toContain("now runs Fake 1.0.0 + t/friendly")
  })
  test("a mod that fails to build is named, and nothing changes", async () => {
    const r = await cli(sb, "install", "t/breaker")
    expect(r.code).toBe(1)
    expect(r.err).toContain("t/breaker could not be built with your other Fake mods. Nothing changed: `greet` still runs Fake 1.0.0 + t/friendly.")
    expect(r.err).toContain("`openmods info t/breaker` shows who maintains it")
    expect(await greeting(sb)).toBe("hello from friendly")
    expect(state().mods).toEqual(["t/friendly"])
  })
  test("mods with no release in common are refused, naming what to uninstall", async () => {
    const r = await cli(sb, "install", "t/later")
    expect(r.code).toBe(1)
    expect(r.err).toContain("To have t/later, uninstall t/friendly first: openmods uninstall t/friendly")
    expect(state().mods).toEqual(["t/friendly"])
  })
  test("a mod that moves every mod to a newer release asks, since that is an update too", async () => {
    await addVersion(sb, path.join(sb.reg, "mods", "t", "friendly", "fake"), "v1.1.0")
    const r = await run(sb, { answer: "y\n" }, "install", "t/later")
    expect(r.out).toContain("This also updates Fake from 1.0.0 to 1.1.0 for all your mods, since t/later has no version for 1.0.0. Go ahead?")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("now runs Fake 1.1.0 + t/friendly + t/later")
  })
  test("a first mod that fails to build leaves the stock harness running, and says so", async () => {
    expect((await cli(sb, "uninstall", "t/friendly", "t/later")).code).toBe(0)
    const r = await cli(sb, "install", "t/breaker", "--yes")
    expect(r.code).toBe(1)
    expect(r.err).toContain("t/breaker could not be built. Nothing changed: `greet` still runs your stock Fake.")
    expect(await greeting(sb)).toBe("stock greet")
  })
})

describe("across harnesses, and in scripts", () => {
  const other = (name: string, v: string) => writeFileSync(path.join(sb.home, ".hello", "bin", "hello"), `#!/bin/sh\n[ "$1" = --version ] && echo ${v} && exit 0\necho stock hello ${name}\n`, { mode: 0o755 })
  const otherState = () => (existsSync(path.join(sb.om, "state.json")) ? JSON.parse(readFileSync(path.join(sb.om, "state.json"), "utf8")).other : undefined)
  test("--yes also runs a missing harness's official installer", async () => {
    registerHarness(sb, { id: "other", name: "Other", binary: "hello" })
    await createMod(sb, "elsewhere", addFile("ELSEWHERE.md", "x\n"), { harness: "other" })
    const r = await cli(sb, "install", "t/elsewhere", "--yes")
    expect(r.code, r.all).toBe(0)
    expect(existsSync(path.join(sb.home, ".hello", "bin", "hello"))).toBe(true)
    expect(otherState().mods).toEqual(["t/elsewhere"])
  })
  test("an install on several harnesses asks every question before it builds any", async () => {
    expect((await cli(sb, "uninstall", "t/elsewhere")).code).toBe(0)
    await createMod(sb, "twin", addFile("TWIN.md", "x\n"), { base: "v1.1.0" })
    await createMod(sb, "twin", addFile("TWIN.md", "x\n"), { harness: "other" })
    // Other is 1.1.0 here, newer than twin supports on it: that is a question.
    other("", "1.1.0")
    const r = await cli(sb, "install", "t/twin", "--fake", "--other")
    expect(r.code).toBe(1)
    expect(r.err).toContain("Build Other 1.0.0 with it?")
    // Fake, which needed no question, was not built either.
    expect(state()?.mods ?? []).toEqual([])
  })
})

describe("advice when mods share no release", () => {
  test("names what to uninstall even when each pair of mods shares a release", async () => {
    await release(sb, "v1.2.0", addFile("NEWS.md", "1.2.0\n"))
    await createMod(sb, "pa", addFile("PA.md", "x\n"))
    await addVersion(sb, path.join(sb.reg, "mods", "t", "pa", "fake"), "v1.1.0")
    await createMod(sb, "pb", addFile("PB.md", "x\n"))
    await addVersion(sb, path.join(sb.reg, "mods", "t", "pb", "fake"), "v1.2.0")
    expect((await cli(sb, "install", "t/pa", "t/pb", "--yes")).code).toBe(0)
    await createMod(sb, "pc", addFile("PC.md", "x\n"), { base: "v1.1.0" })
    await addVersion(sb, path.join(sb.reg, "mods", "t", "pc", "fake"), "v1.2.0")
    // pc shares 1.1.0 with pa and 1.2.0 with pb, but no release with both.
    const r = await cli(sb, "install", "t/pc")
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/To have t\/pc, uninstall t\/p[ab] first: openmods uninstall t\/p[ab]$/m)
  })
  test("a failed build says so truthfully when the old build has gone missing", async () => {
    const artifact = JSON.parse(readFileSync(path.join(sb.om, "state.json"), "utf8")).fake.artifact
    rmSync(artifact)
    const r = await cli(sb, "install", "t/breaker", "--yes")
    expect(r.code).toBe(1)
    expect(r.err).toContain("still runs nothing: its build is missing")
  })
})
