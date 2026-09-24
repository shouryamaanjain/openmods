// The launcher's update prompt, end to end. It asks once per offer: a no
// is final until there is something new, a new release or a new update of a
// mod. A yes rebuilds and starts the new build in the same invocation.
import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { $ } from "bun"
import { addFile, addVersion, cli, createHarness, createMod, git, release, sandbox, setGreeting } from "./harness"

const sb = sandbox("launcher")
const launcher = () => path.join(sb.om, "bin", "greet")

async function launch(answer: string) {
  const p = Bun.spawn(["sh", launcher()], {
    env: { ...process.env, HOME: sb.home, OPENMODS_HOME: sb.om, OPENMODS_REGISTRY: sb.reg, OPENMODS_NO_CHECK: "1", OPENMODS_ASSUME_TTY: "1" },
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
  await addVersion(sb, path.join(sb.reg, "mods", "t", "friendly", "fake"), "v1.1.0")
  await cli(sb, "check-updates", "fake")
})

describe("the update prompt", () => {
  test("offers a release every mod supports, once", async () => {
    const r = await launch("n\n")
    expect(r.out).toContain("Fake 1.1.0 is out, and all your mods support it.")
    // Only a first build was timed, which says nothing about a rebuild.
    expect(r.out).toContain("Update now? It rebuilds Fake. [y/N]")
    expect(r.out).toContain("You will not be asked about this again")
    expect(r.out).toContain("hello from friendly")
    expect(r.code).toBe(0)
  })
  test("after a no, the same offer is never shown again", async () => {
    await cli(sb, "check-updates", "fake")
    const r = await launch("")
    expect(r.out).not.toContain("Update now?")
    expect(r.out.trim()).toBe("hello from friendly")
  })
  test("a new update of a mod is something new, so it asks again, with the author's note", async () => {
    const work = path.join(sb.T, "work-friendly")
    await git(work, "fetch", "-q", "--tags")
    await git(work, "checkout", "-q", "v1.1.0")
    writeFileSync(path.join(work, "greet.sh"), "#!/bin/sh\necho hello from friendly, update 2\n")
    await git(work, "commit", "-qam", "fix: friendlier")
    const pack = await cli(sb, "pack", work, "--name", "friendly", "--owner", "t", "--harness", "fake", "--force", "--note", "friendlier greeting")
    expect(pack.out).toContain("This is update 2: friendlier greeting.")
    await cli(sb, "check-updates", "fake")
    const r = await launch("y\n")
    expect(r.out).toContain("Fake 1.1.0 is out, and all your mods support it. New in your mods: t/friendly update 2 (friendlier greeting).")
    expect(r.all).toContain("now runs Fake 1.1.0 + t/friendly")
    expect(r.all).not.toContain("No such file")
    expect(r.out).toContain("hello from friendly, update 2")
    expect(r.code).toBe(0)
    expect(readFileSync(launcher(), "utf8")).toContain("builds/1.1.0+friendly-2")
  })
  test("after updating, the next launch does not ask", async () => {
    await cli(sb, "check-updates", "fake")
    const r = await launch("")
    expect(r.out).not.toContain("Update now?")
    expect(r.out.trim()).toBe("hello from friendly, update 2")
  })
  test("status shows a pending update only when there is one", async () => {
    expect((await cli(sb, "status")).out).not.toContain("update  ")
  })
})
