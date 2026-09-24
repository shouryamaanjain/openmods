// A harness's `env`: variables the modded build and a dev clone start with,
// such as OpenCode's switch for its own self-update, since OpenMods offers
// the updates. A launcher written before the variable existed gets it with
// the daily check, without a rebuild.
import { beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cli, createHarness, createMod, git, greeting, sandbox, setGreeting } from "./harness"

const sb = sandbox("env")
const definition = path.join(sb.reg, "harnesses", "fake.json")
const setEnv = (env: Record<string, string>) => writeFileSync(definition, JSON.stringify({ ...JSON.parse(readFileSync(definition, "utf8")), env }))

beforeAll(async () => {
  await createHarness(sb)
  await createMod(sb, "envy", setGreeting("self-update=$GREET_SELF_UPDATE"))
  expect((await cli(sb, "install", "t/envy")).code).toBe(0)
})

describe("a harness's env", () => {
  test("reaches a build made before it existed, with the daily check", async () => {
    expect(await greeting(sb)).toBe("self-update=")
    setEnv({ GREET_SELF_UPDATE: "off", "not a name": "x" })
    await cli(sb, "check-updates", "fake")
    expect(await greeting(sb)).toBe("self-update=off")
    expect(readFileSync(path.join(sb.om, "bin", "greet"), "utf8")).not.toContain("not a name")
  })
  test("is kept on a rebuild", async () => {
    await cli(sb, "update", "fake", "--force")
    expect(await greeting(sb)).toBe("self-update=off")
  })
  test("is set for a clone under openmods dev", async () => {
    const clone = path.join(sb.T, "clone")
    await $`git clone -q ${sb.harness} ${clone}`.quiet()
    await git(clone, "checkout", "-q", "-b", "mine", "v1.0.0")
    writeFileSync(path.join(clone, "greet.sh"), "#!/bin/sh\necho dev self-update=$GREET_SELF_UPDATE\n")
    expect((await cli(sb, "dev", clone, "--fake")).code).toBe(0)
    expect(await greeting(sb)).toBe("dev self-update=off")
  })
})
