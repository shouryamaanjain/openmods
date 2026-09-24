// `openmods dev`: the harness command runs the author's clone straight from
// source, so an edit shows up the next time it starts, with nothing to commit,
// pack or build. Anything else that switches the harness ends it.
import { beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { existsSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cli, createHarness, createMod, git, greeting, sandbox, setGreeting } from "./harness"

const sb = sandbox("dev")
const clone = path.join(sb.T, "my-clone")

beforeAll(async () => {
  await createHarness(sb)
  await createMod(sb, "friendly", setGreeting("hello from friendly"))
  await $`git clone -q ${sb.harness} ${clone}`.quiet()
  await git(clone, "checkout", "-q", "-b", "my-mod", "v1.0.0")
})

describe("openmods dev", () => {
  test("makes the harness command run the clone, and edits show up without committing", async () => {
    const r = await cli(sb, "dev", clone, "--fake")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("now runs your clone at")
    expect(r.out).toContain("as Fake 1.0.0+my-mod-dev")
    expect(await greeting(sb)).toBe("hello from stock")
    writeFileSync(path.join(clone, "greet.sh"), "#!/bin/sh\necho hello from my edit\n")
    expect(await greeting(sb)).toBe("hello from my edit")
    expect((await cli(sb, "status")).out).toContain("dev     Fake 1.0.0+my-mod-dev")
  })
  test("the daily check leaves the clone's launcher alone", async () => {
    await cli(sb, "check-updates", "fake")
    expect(await greeting(sb)).toBe("hello from my edit")
  })
  test("--stop goes back to stock when there is no modded build", async () => {
    const r = await cli(sb, "dev", "--stop")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("runs your stock Fake again")
    expect(await greeting(sb)).toBeNull()
    expect((await cli(sb, "dev", "--stop")).code).toBe(1)
  })
  test("installing a mod ends dev mode and says so; --stop then returns to that build", async () => {
    expect((await cli(sb, "dev", clone, "--fake")).code).toBe(0)
    const r = await cli(sb, "install", "t/friendly")
    expect(r.out).toContain("no longer runs your clone")
    expect(await greeting(sb)).toBe("hello from friendly")
    expect((await cli(sb, "dev", clone, "--fake")).code).toBe(0)
    expect(await greeting(sb)).toBe("hello from my edit")
    const stop = await cli(sb, "dev", "--stop")
    expect(stop.out).toContain("runs your modded Fake again")
    expect(await greeting(sb)).toBe("hello from friendly")
  })
  test("needs a clone", async () => {
    const r = await cli(sb, "dev", sb.T)
    expect(r.code).toBe(1)
    expect(r.err).toContain("is not a clone of a harness")
    expect(existsSync(path.join(sb.om, "dev.json"))).toBe(false)
  })
})
