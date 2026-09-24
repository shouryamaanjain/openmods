// What a build asks of the machine and the network: a harness checkout holds
// only the release it builds, not the history behind it, and a dependency
// install that fails partway, as downloads do on a slow connection, is tried
// once more before the build gives up.
import { beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { addFile, cli, createHarness, createMod, git, greeting, release, sandbox, setGreeting } from "./harness"

const sb = sandbox("machines")
const checkout = () => path.join(sb.om, "harnesses", "fake", "src")
const definition = path.join(sb.reg, "harnesses", "fake.json")
const setInstall = (install: string) => writeFileSync(definition, JSON.stringify({ ...JSON.parse(readFileSync(definition, "utf8")), install }))

beforeAll(async () => {
  await createHarness(sb)
  await release(sb, "v1.0.1", addFile("NOTES.md", "a commit the build does not need\n"))
  await release(sb, "v1.0.2", addFile("NOTES.md", "and another\n"))
})

describe("a harness checkout", () => {
  test("holds only the release it builds", async () => {
    await createMod(sb, "friendly", setGreeting("hello from friendly"))
    const r = await cli(sb, "install", "t/friendly")
    expect(r.code, r.all).toBe(0)
    expect(await greeting(sb)).toBe("hello from friendly")
    expect(existsSync(path.join(checkout(), ".git", "shallow"))).toBe(true)
    const commits = Number((await $`git -C ${checkout()} rev-list --count HEAD`.text()).trim())
    expect(commits).toBe(2) // the release and the mod's one patch
  })
  test("gets the commit the registry pins when the tag it has points elsewhere", async () => {
    await git(sb.harness, "checkout", "-q", "v1.0.0")
    addFile("RETAG.md", "v1.0.0, tagged again\n")(sb.harness)
    await git(sb.harness, "add", "-A")
    await git(sb.harness, "commit", "-q", "-m", "v1.0.0 again")
    await git(sb.harness, "tag", "-f", "v1.0.0")
    const pinned = (await git(sb.harness, "rev-parse", "HEAD")).stdout.toString().trim()
    await git(sb.harness, "checkout", "-q", "-")
    const support = path.join(sb.reg, "mods", "t", "friendly", "fake", "support.json")
    const s = JSON.parse(readFileSync(support, "utf8"))
    writeFileSync(support, JSON.stringify({ ...s, versions: s.versions.map((v: object) => ({ ...v, commit: pinned })) }))
    await cli(sb, "uninstall", "t/friendly")
    const r = await cli(sb, "install", "t/friendly")
    expect(r.code, r.all).toBe(0)
    expect((await $`git -C ${checkout()} rev-parse HEAD~1`.text()).trim()).toBe(pinned)
    expect(existsSync(path.join(checkout(), "RETAG.md"))).toBe(true)
    expect(Number((await $`git -C ${checkout()} rev-list --count HEAD`.text()).trim())).toBe(2) // still no history
  })
})

describe("a kept build", () => {
  const builds = () => path.join(sb.om, "harnesses", "fake", "builds")
  const setBuild = (fields: Record<string, unknown>) => writeFileSync(definition, JSON.stringify({ ...JSON.parse(readFileSync(definition, "utf8")), ...fields }))
  // A package: the binary in bin/, a helper beside it in res/, and compiler
  // output next to the package that a build should not keep.
  const build = "mkdir -p out/pkg/bin out/pkg/res out/cache && cp greet.sh out/pkg/bin/greet && chmod +x out/pkg/bin/greet && printf helper > out/pkg/res/helper && printf junk > out/cache/junk"
  test("holds the harness's keep folder whole, and nothing else from the build's output", async () => {
    setBuild({ build, artifact: "out/pkg/bin/greet", keep: "out/pkg" })
    await cli(sb, "uninstall", "t/friendly")
    const r = await cli(sb, "install", "t/friendly")
    expect(r.code, r.all).toBe(0)
    const [kept] = readdirSync(builds())
    const dir = path.join(builds(), kept!)
    expect([readdirSync(dir).sort(), readdirSync(path.join(dir, "res"))]).toEqual([["bin", "res"], ["helper"]])
    expect(await greeting(sb)).toBe("hello from friendly")
  })
  // (Root reads any file, so there the copy cannot be made to fail this way.)
  test.skipIf(process.getuid?.() === 0)("a rebuild whose copy fails leaves the build that runs whole", async () => {
    const unreadable = "&& printf secret > out/pkg/res/locked && chmod 000 out/pkg/res/locked"
    setBuild({ build: `${build} ${unreadable}`, artifact: "out/pkg/bin/greet", keep: "out/pkg" })
    const r = await cli(sb, "update", "fake", "--force")
    chmodSync(path.join(sb.om, "harnesses", "fake", "src", "out", "pkg", "res", "locked"), 0o644)
    expect(r.code).toBe(1)
    expect(r.err).toContain("could not copy the build")
    const kept = readdirSync(builds())
    expect(kept.length).toBe(1)
    expect(readdirSync(path.join(builds(), kept[0]!, "res"))).toEqual(["helper"])
    expect(await greeting(sb)).toBe("hello from friendly")
  })
  test("without a keep folder, holds the binary's own folder", async () => {
    setBuild({ build, artifact: "out/pkg/bin/greet", keep: undefined })
    const r = await cli(sb, "update", "fake", "--force")
    expect(r.code, r.all).toBe(0)
    const [kept] = readdirSync(builds())
    expect(readdirSync(path.join(builds(), kept!))).toEqual(["greet"])
    expect(await greeting(sb)).toBe("hello from friendly")
  })
})

describe("a dependency install", () => {
  test("that fails once is tried again", async () => {
    const marker = path.join(sb.T, "tried")
    setInstall(`[ -f ${marker} ] || { touch ${marker}; echo "download failed" >&2; exit 1; }`)
    await cli(sb, "uninstall", "t/friendly")
    const r = await cli(sb, "install", "t/friendly")
    expect(r.code, r.all).toBe(0)
    expect(r.all).toContain("Some downloads failed. Trying once more.")
    expect(await greeting(sb)).toBe("hello from friendly")
  })
  test("that fails twice stops the build", async () => {
    setInstall("echo 'download failed' >&2; exit 1")
    await cli(sb, "uninstall", "t/friendly")
    const r = await cli(sb, "install", "t/friendly")
    expect(r.code).toBe(1)
    expect(r.all).toContain("Trying once more.")
  })
})
