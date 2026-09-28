// The launcher only starts the build: no update check in the background, no
// question before a session. Launchers from before that are replaced by the
// next openmods command, or by the daily `check-updates` they run, offline.
import { beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { addFile, addVersion, cli, createHarness, createMod, release, sandbox, setGreeting } from "./harness"

const sb = sandbox("launcher")
const launcher = () => path.join(sb.om, "bin", "greet")

// As from a terminal, where the old launcher would have asked.
async function launch() {
  const p = Bun.spawn(["sh", launcher()], {
    env: { ...process.env, HOME: sb.home, OPENMODS_HOME: sb.om, OPENMODS_REGISTRY: sb.reg, OPENMODS_ASSUME_TTY: "1" },
    stdin: new TextEncoder().encode("y\n"),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out, err }
}

// The launcher an older openmods wrote, trimmed to what matters here: a
// background check once a day, and a question from its note.
const oldLauncher = () => `#!/bin/sh
NOTE="${sb.om}/updates/fake"
( openmods check-updates fake >/dev/null 2>&1 & )
[ -f "$NOTE" ] && . "$NOTE" && printf '%s\\n' "$MESSAGE"
exec "${readFileSync(launcher(), "utf8").match(/exec '([^']+)'/)![1]}" "$@"
`

beforeAll(async () => {
  await createHarness(sb)
  await createMod(sb, "friendly", setGreeting("hello from friendly"))
  expect((await cli(sb, "install", "t/friendly")).code).toBe(0)
  // A release every mod supports: the old launcher would have offered it.
  await release(sb, "v1.1.0", addFile("CHANGELOG.md", "1.1.0\n"))
  await addVersion(sb, path.join(sb.reg, "mods", "t", "friendly", "fake"), "v1.1.0")
})

describe("the launcher", () => {
  test("only starts the build, even at a terminal with an update out", async () => {
    const script = readFileSync(launcher(), "utf8")
    expect(script).not.toContain("check-updates")
    expect(script).not.toContain("read ")
    const r = await launch()
    expect(r.code).toBe(0)
    expect(r.out.trim()).toBe("hello from friendly")
    expect(r.err).toBe("")
    expect(existsSync(path.join(sb.om, "updates"))).toBe(false)
  })
  test("one from an older openmods is replaced by the next command, and its notes go", async () => {
    writeFileSync(launcher(), oldLauncher(), { mode: 0o755 })
    mkdirSync(path.join(sb.om, "updates"), { recursive: true })
    writeFileSync(path.join(sb.om, "updates", "fake"), "MESSAGE='Fake 1.1.0 is out'\n")
    expect((await cli(sb, "status")).code).toBe(0)
    expect(readFileSync(launcher(), "utf8")).not.toContain("check-updates")
    expect(existsSync(path.join(sb.om, "updates"))).toBe(false)
    expect((await launch()).out.trim()).toBe("hello from friendly")
  })
  test("the daily check an old launcher runs only replaces it, offline, and says nothing", async () => {
    writeFileSync(launcher(), oldLauncher(), { mode: 0o755 })
    const r = await cli(sb, "check-updates", "fake")
    expect(r.code).toBe(0)
    expect(r.all).toBe("")
    expect(readFileSync(launcher(), "utf8")).not.toContain("check-updates")
    // Still on the release it was built for: nothing was updated.
    expect(readFileSync(launcher(), "utf8")).toContain("builds/1.0.0+friendly-1")
  })
  test("check-updates is not offered as a command", async () => {
    expect((await cli(sb, "help")).out).not.toContain("check-updates")
  })
  test("updating happens with openmods update", async () => {
    const r = await cli(sb, "update", "fake")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("now runs Fake 1.1.0 + t/friendly")
    expect((await launch()).out.trim()).toBe("hello from friendly")
  })
})
