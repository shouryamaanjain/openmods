// A harness's `env`: variables the modded build and a dev clone start with,
// such as OpenCode's switch for its own self-update, since OpenMods offers
// the updates. A launcher written before the variable existed gets it with
// the daily check, or with `openmods update` for anyone who turned the check
// off, without a rebuild. PATH is the launcher's own and cannot be set.
import { beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cli, createHarness, createMod, git, greeting, sandbox, setGreeting } from "./harness"

const sb = sandbox("env")
const definition = path.join(sb.reg, "harnesses", "fake.json")
const setEnv = (env: Record<string, string> | undefined) => {
  const { env: _, ...rest } = JSON.parse(readFileSync(definition, "utf8"))
  writeFileSync(definition, JSON.stringify(env ? { ...rest, env } : rest))
}
const launcher = () => readFileSync(path.join(sb.om, "bin", "greet"), "utf8")

beforeAll(async () => {
  await createHarness(sb)
  await createMod(sb, "envy", setGreeting("self-update=$GREET_SELF_UPDATE"))
  setEnv(undefined)
  expect((await cli(sb, "install", "t/envy")).code).toBe(0)
})

describe("a harness's env", () => {
  test("reaches a build made before it existed, with the daily check", async () => {
    setEnv(undefined)
    await cli(sb, "update", "fake", "--force")
    expect(await greeting(sb)).toBe("self-update=")
    setEnv({ GREET_SELF_UPDATE: "off", "not a name": "x" })
    await cli(sb, "check-updates", "fake")
    expect(await greeting(sb)).toBe("self-update=off")
    expect(launcher()).not.toContain("not a name")
  })
  test("reaches it with openmods update when there is nothing to rebuild", async () => {
    setEnv({ GREET_SELF_UPDATE: "quiet" })
    const r = await cli(sb, "update", "fake")
    expect(r.out).toContain("is already up to date")
    expect(await greeting(sb)).toBe("self-update=quiet")
  })
  test("is kept on a rebuild", async () => {
    setEnv({ GREET_SELF_UPDATE: "off" })
    await cli(sb, "update", "fake", "--force")
    expect(await greeting(sb)).toBe("self-update=off")
  })
  test("cannot replace PATH", async () => {
    setEnv({ PATH: "/nowhere", GREET_SELF_UPDATE: "off" })
    await cli(sb, "check-updates", "fake")
    expect(launcher()).not.toContain("export PATH")
    expect(await greeting(sb)).toBe("self-update=off")
  })
  test("is set for a clone under openmods dev, and follows a change with the daily check", async () => {
    setEnv({ GREET_SELF_UPDATE: "off" })
    const clone = path.join(sb.T, "clone")
    await $`git clone -q ${sb.harness} ${clone}`.quiet()
    await git(clone, "checkout", "-q", "-b", "mine", "v1.0.0")
    writeFileSync(path.join(clone, "greet.sh"), "#!/bin/sh\necho dev self-update=$GREET_SELF_UPDATE\n")
    expect((await cli(sb, "dev", clone, "--fake")).code).toBe(0)
    expect(await greeting(sb)).toBe("dev self-update=off")
    setEnv({ GREET_SELF_UPDATE: "changed" })
    await cli(sb, "check-updates", "fake")
    expect(await greeting(sb)).toBe("dev self-update=changed")
  })
  test("a harness that drops its dev command leaves a dev launcher as it is", async () => {
    const { dev: _, ...rest } = JSON.parse(readFileSync(definition, "utf8"))
    writeFileSync(definition, JSON.stringify({ ...rest, env: { GREET_SELF_UPDATE: "again" } }))
    const r = await cli(sb, "check-updates", "fake")
    expect(r.code, r.all).toBe(0)
    expect(await greeting(sb)).toBe("dev self-update=changed")
  })
})
