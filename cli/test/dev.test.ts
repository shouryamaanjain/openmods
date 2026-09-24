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
    expect(await greeting(sb)).toBe("stock greet")
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
  test("names are letters, digits and hyphens, since they go into the launcher", async () => {
    const r = await cli(sb, "dev", clone, "--fake", "--name", "x'; rm -rf ~; '")
    expect(r.code).toBe(1)
    expect(r.err).toContain("--name must be lowercase letters, digits and hyphens")
  })
  test("status --json reports the clone", async () => {
    expect((await cli(sb, "dev", clone, "--fake")).code).toBe(0)
    const j = JSON.parse((await cli(sb, "status", "--json")).out)
    expect(j.fake.dev.version).toBe("1.0.0+my-mod-dev")
    expect(j.fake.mods).toEqual(["t/friendly"])
  })
  test("--stop never brings back a build whose mod was revoked meanwhile", async () => {
    writeFileSync(path.join(sb.reg, "revoked.json"), JSON.stringify({ revoked: [{ id: "t/friendly", reason: "It sends your files away." }] }))
    const r = await cli(sb, "dev", "--stop")
    expect(r.out).toContain("t/friendly was removed from OpenMods")
    const run = await $`sh ${path.join(sb.om, "bin", "greet")}`.nothrow().quiet()
    expect(run.stdout.toString().trim()).toBe("stock greet")
    expect(run.stderr.toString()).toContain("removed from OpenMods")
  })
  test("needs a clone", async () => {
    const r = await cli(sb, "dev", sb.T)
    expect(r.code).toBe(1)
    expect(r.err).toContain("is not a clone of a harness")
    expect(existsSync(path.join(sb.om, "dev.json"))).toBe(false)
  })
})
