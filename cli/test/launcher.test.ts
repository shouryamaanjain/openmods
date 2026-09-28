// The launcher's heads-up. At a terminal it looks for news in the background
// on every start, never holding the start up, and shows what the last look
// found on the next start: a newer release every mod supports, or a fix for
// a mod, asked about once (a no is final for that offer); a newer release
// some mods hold back, said once. Scripts only get the build.
import { beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { addFile, addVersion, cli, createHarness, createMod, git, release, run, sandbox, setGreeting } from "./harness"

const sb = sandbox("launcher")
const launcher = () => path.join(sb.om, "bin", "greet")
const note = () => path.join(sb.om, "updates", "fake")

// As from a terminal, unless `script`. The background look is turned off
// here unless `look`, and run by hand with `look()`, so each test knows
// which note the launcher reads.
async function launch(answer = "", opts: { look?: boolean; script?: boolean; index?: string; shell?: string } = {}) {
  const p = Bun.spawn([opts.shell ?? "sh", launcher()], {
    env: {
      ...process.env,
      HOME: sb.home,
      OPENMODS_HOME: sb.om,
      OPENMODS_REGISTRY: sb.reg,
      OPENMODS_REVOKED_URL: "",
      ...(opts.script ? {} : { OPENMODS_ASSUME_TTY: "1" }),
      ...(opts.look ? {} : { OPENMODS_NO_CHECK: "1" }),
    },
    stdin: new TextEncoder().encode(answer),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out, err }
}
const look = () => cli(sb, "check-updates", "fake")

beforeAll(async () => {
  await createHarness(sb)
  await createMod(sb, "friendly", setGreeting("hello from friendly"))
  expect((await cli(sb, "install", "t/friendly")).code).toBe(0)
  // A release the mod supports, as the release watch would have recorded it.
  await release(sb, "v1.1.0", addFile("CHANGELOG.md", "1.1.0\n"))
  await addVersion(sb, path.join(sb.reg, "mods", "t", "friendly", "fake"), "v1.1.0")
})

describe("the launcher's heads-up", () => {
  test("in a script it only starts the build, and looks for nothing", async () => {
    const r = await launch("", { script: true, look: true })
    expect(r.out.trim()).toBe("hello from friendly")
    await Bun.sleep(1500)
    expect(existsSync(note())).toBe(false)
  })
  test("at a terminal it starts the build at once and looks in the background", async () => {
    // A live list that takes 3 seconds to answer: the start must not wait for it.
    const slow = Bun.serve({ port: 0, fetch: async () => (await Bun.sleep(3000), new Response("", { status: 503 })) })
    // sh, and dash where there is one: Linux's sh, which once held the start.
    for (const shell of ["sh", ...(existsSync("/bin/dash") ? ["/bin/dash"] : [])]) {
      const started = Date.now()
      const r = await launch("", { look: true, index: `http://localhost:${slow.port}/index.json`, shell })
      expect(Date.now() - started, shell).toBeLessThan(2000)
      expect(r.out.trim()).toBe("hello from friendly")
    }
    // Unanswered, the look falls back to the registry copy.
    for (let i = 0; i < 60 && !existsSync(note()); i++) await Bun.sleep(250)
    slow.stop(true)
    expect(readFileSync(note(), "utf8")).toContain("Fake 1.1.0 is out, and all your mods support it.")
  })
  test("the next start asks about a release every mod supports; a no is final for it", async () => {
    const r = await launch("n\n")
    expect(r.out).toContain("Fake 1.1.0 is out, and all your mods support it.")
    expect(r.out).toContain("Update now? It rebuilds Fake. [y/N]")
    expect(r.out).toContain("You will not be asked about this again")
    expect(r.out).toContain("hello from friendly")
    await look()
    expect((await launch("")).out.trim()).toBe("hello from friendly")
    expect((await cli(sb, "status")).out).toContain("news    Fake 1.1.0 is out, and all your mods support it. `openmods update fake` does it.")
  })
  test("a fix for a mod is something new, so it asks again, and a yes updates and starts the new build", async () => {
    const work = path.join(sb.T, "work-friendly")
    await git(work, "fetch", "-q", "--tags")
    await git(work, "checkout", "-q", "v1.1.0")
    writeFileSync(path.join(work, "greet.sh"), "#!/bin/sh\necho hello from friendly, update 2\n")
    await git(work, "commit", "-qam", "fix: friendlier")
    await cli(sb, "pack", work, "--name", "friendly", "--owner", "t", "--harness", "fake", "--force", "--note", "friendlier greeting")
    await look()
    const r = await launch("y\n")
    expect(r.out).toContain("Fake 1.1.0 is out, and all your mods support it. New in your mods: t/friendly update 2.")
    expect(r.out).toContain("now runs Fake 1.1.0 + t/friendly")
    expect(r.out).toContain("hello from friendly, update 2")
    expect(existsSync(note())).toBe(false)
    await look()
    expect((await launch("")).out.trim()).toBe("hello from friendly, update 2")
  })
  test("a newer release that a mod holds back is said once, without a question", async () => {
    await createMod(sb, "notes", addFile("NOTES.md", "notes\n"), { base: "v1.1.0" })
    expect((await cli(sb, "install", "t/notes")).code).toBe(0)
    await release(sb, "v1.2.0", addFile("NEWS.md", "1.2.0\n"))
    await addVersion(sb, path.join(sb.reg, "mods", "t", "friendly", "fake"), "v1.2.0")
    await look()
    const r = await launch("")
    expect(r.out).toContain("Fake 1.2.0 is out, but t/notes has no version for it yet. You stay on 1.1.0.")
    expect(r.out).not.toContain("Update now?")
    await look()
    expect((await launch("")).out).not.toContain("is out")
  })
  test("the question says how long a rebuild takes once one was timed", async () => {
    const work = path.join(sb.T, "work-friendly")
    writeFileSync(path.join(work, "greet.sh"), "#!/bin/sh\necho hello from friendly, update 3\n")
    await git(work, "commit", "-qam", "fix: friendlier still")
    await cli(sb, "pack", work, "--name", "friendly", "--owner", "t", "--harness", "fake", "--force")
    await look()
    expect((await launch("n\n")).out).toContain("Update now? It rebuilds Fake (under a minute). [y/N]")
  })
  test("news says nothing about a build switched off, and a name that is not a harness is refused", async () => {
    expect((await cli(sb, "off")).code).toBe(0)
    expect(existsSync(note())).toBe(false)
    expect((await cli(sb, "status")).out).not.toContain("news")
    expect((await cli(sb, "on")).code).toBe(0)
    // A lock left by a killed build does not silence the news.
    writeFileSync(path.join(sb.om, "harnesses", "fake", "build.lock"), "999999")
    await look()
    expect(existsSync(note())).toBe(true)
    // A harness the registry no longer has loses its note.
    const def = path.join(sb.reg, "harnesses", "fake.json")
    const kept = readFileSync(def, "utf8")
    rmSync(def)
    await cli(sb, "check-updates")
    writeFileSync(def, kept)
    expect(existsSync(note())).toBe(false)
    const bad = await cli(sb, "check-updates", "../state.json")
    expect(bad.code).toBe(1)
    expect(existsSync(path.join(sb.om, "state.json"))).toBe(true)
  })
})
