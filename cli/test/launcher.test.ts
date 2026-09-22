// The launcher's update prompt, end to end: a new release is supported by
// the installed mod, the user answers y, the harness is rebuilt, and the new
// build starts in the same invocation.
import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { $ } from "bun"
import { addFile, cli, createHarness, createMod, release, sandbox, setGreeting } from "./harness"

const sb = sandbox("launcher")
const launcher = () => path.join(sb.om, "bin", "greet")

async function launch(answer: string) {
  const p = Bun.spawn(["sh", launcher()], {
    env: { ...process.env, HOME: sb.home, OPEN_MODS_HOME: sb.om, OPEN_MODS_REGISTRY: sb.reg, OPEN_MODS_NO_CHECK: "1", OPEN_MODS_ASSUME_TTY: "1" },
    stdin: new TextEncoder().encode(answer),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out, err, all: out + err }
}

beforeAll(async () => {
  await createHarness(sb)
  await createMod(sb, "friendly", setGreeting("hello from friendly"))
  await cli(sb, "install", "t/friendly")
  // A release that leaves the mod's lines alone, and the bump the release
  // watch would commit for it.
  await release(sb, "v1.1.0", addFile("CHANGELOG.md", "1.1.0\n"))
  const file = path.join(sb.reg, "mods", "t", "friendly", "fake", "support.json")
  const commit = (await $`git -C ${sb.harness} rev-parse v1.1.0^{commit}`.text()).trim()
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), upstream: { ref: "v1.1.0", commit } }))
  await cli(sb, "check-updates", "fake")
})

describe("the update prompt", () => {
  test("n launches the current build and snoozes", async () => {
    const r = await launch("n\n")
    expect(r.out).toContain("Fake 1.1.0 is out and all your mods support it")
    expect(r.out).toContain("hello from friendly")
    expect(r.code).toBe(0)
  })
  test("y rebuilds onto the new release and starts the new build in the same run", async () => {
    rmSync(path.join(sb.om, "updates", "fake.snooze"), { force: true })
    const r = await launch("y\n")
    expect(r.all).toContain("now runs Fake 1.1.0 + t/friendly")
    expect(r.all).not.toContain("No such file")
    expect(r.out).toContain("hello from friendly")
    expect(r.code).toBe(0)
    expect(readFileSync(launcher(), "utf8")).toContain("builds/1.1.0+friendly")
  })
  test("after updating, the next launch does not ask again", async () => {
    const r = await launch("")
    expect(r.out).not.toContain("Update now?")
    expect(r.out.trim()).toBe("hello from friendly")
  })
})
