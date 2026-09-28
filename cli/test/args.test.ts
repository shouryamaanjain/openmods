// A harness's `args`: arguments the modded build and a dev clone always
// start with, before the user's, such as Codex's switch for its own update
// check, which has no environment variable. A launcher written before they
// existed gets them with the daily check, without a rebuild.
import { beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cli, createHarness, createMod, git, sandbox } from "./harness"

const sb = sandbox("args")
const definition = path.join(sb.reg, "harnesses", "fake.json")
const setArgs = (args: string[] | undefined) => {
  const { args: _, ...rest } = JSON.parse(readFileSync(definition, "utf8"))
  writeFileSync(definition, JSON.stringify(args ? { ...rest, args } : rest))
}
const greet = async (...a: string[]) =>
  (await $`sh ${path.join(sb.om, "bin", "greet")} ${a}`.text()).trim()

beforeAll(async () => {
  await createHarness(sb)
  // Each argument in brackets, so their boundaries show.
  await createMod(sb, "echo", (dir) => writeFileSync(path.join(dir, "greet.sh"), "#!/bin/sh\nprintf 'args:'; printf '[%s]' \"$@\"; echo\n"))
  expect((await cli(sb, "install", "t/echo")).code).toBe(0)
})

describe("a harness's args", () => {
  test("come before the user's, and reach a build made before they existed with the next command", async () => {
    setArgs(undefined)
    await cli(sb, "status")
    expect(await greet("mine")).toBe("args:[mine]")
    setArgs(["-c", "check_for_update_on_startup=false", "it's quoted"])
    await cli(sb, "status")
    expect(await greet("mine", "too")).toBe("args:[-c][check_for_update_on_startup=false][it's quoted][mine][too]")
  })
  test("are passed to a clone under openmods dev", async () => {
    setArgs(["--from-openmods"])
    const clone = path.join(sb.T, "clone")
    await $`git clone -q ${sb.harness} ${clone}`.quiet()
    await git(clone, "checkout", "-q", "-b", "mine", "v1.0.0")
    writeFileSync(path.join(clone, "greet.sh"), "#!/bin/sh\nprintf 'dev:'; printf '[%s]' \"$@\"; echo\n")
    try {
      expect((await cli(sb, "dev", clone, "--fake")).code).toBe(0)
      expect(await greet("mine")).toBe("dev:[--from-openmods][mine]")
    } finally {
      await cli(sb, "dev", "--stop")
    }
  })
})

describe("a harness's argsUnless", () => {
  const setUnless = (u: object | undefined) => {
    const { argsUnless: _, ...rest } = JSON.parse(readFileSync(definition, "utf8"))
    writeFileSync(definition, JSON.stringify(u ? { ...rest, argsUnless: u } : rest))
  }
  test("come after args and before the user's, unless the user gives one of its words", async () => {
    setArgs(["-c", "x=1"])
    setUnless({ args: ["--no-daemon"], given: ["agents", "--remote", "--remote=*"] })
    await cli(sb, "status")
    expect(await greet()).toBe("args:[-c][x=1][--no-daemon]")
    expect(await greet("resume", "--last")).toBe("args:[-c][x=1][--no-daemon][resume][--last]")
    expect(await greet("agents")).toBe("args:[-c][x=1][agents]")
    expect(await greet("--remote", "ws://h")).toBe("args:[-c][x=1][--remote][ws://h]")
    expect(await greet("--remote=ws://h")).toBe("args:[-c][x=1][--remote=ws://h]")
    // A word inside a longer argument is not the word.
    expect(await greet("fix the agents page")).toBe("args:[-c][x=1][--no-daemon][fix the agents page]")
  })
  test("reach a clone under openmods dev too", async () => {
    const clone = path.join(sb.T, "clone-unless")
    await $`git clone -q ${sb.harness} ${clone}`.quiet()
    await git(clone, "checkout", "-q", "-b", "mine", "v1.0.0")
    writeFileSync(path.join(clone, "greet.sh"), "#!/bin/sh\nprintf 'dev:'; printf '[%s]' \"$@\"; echo\n")
    expect((await cli(sb, "dev", clone, "--fake")).code).toBe(0)
    expect(await greet()).toBe("dev:[-c][x=1][--no-daemon]")
    expect(await greet("agents")).toBe("dev:[-c][x=1][agents]")
    setUnless(undefined)
    setArgs(undefined)
    await cli(sb, "dev", "--stop")
  })
})
