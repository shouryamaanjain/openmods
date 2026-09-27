// OpenCode 2's dev command, as harnesses/opencode.json has it. OpenCode 2
// starts its background server by running its entry file again, so the
// launcher runs the clone through an entry file of its own that sets the
// version and channel and loads the TUI's preload. Run here against a stub
// clone whose path a shell or a TypeScript string could trip over.
import { beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cli, createHarness, git, sandbox } from "./harness"

const sb = sandbox("opencode-dev")
const clone = path.join(sb.T, 'my "odd" clone')
const log = path.join(sb.T, "runs.log")
const launcher = () => path.join(sb.om, "bin", "occ")

// Each start of the stub OpenCode: what it was run with and how it was set up.
async function run(...args: string[]) {
  rmSync(log, { force: true })
  const r = await $`sh ${launcher()} ${args}`.env({ ...process.env, LOG: log }).nothrow().quiet()
  expect(r.exitCode, r.stderr.toString()).toBe(0)
  return readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l))
}

beforeAll(async () => {
  await createHarness(sb)
  const fake = JSON.parse(readFileSync(path.join(sb.reg, "harnesses", "fake.json"), "utf8"))
  const opencode = JSON.parse(readFileSync(path.resolve(import.meta.dir, "../../harnesses/opencode.json"), "utf8"))
  writeFileSync(path.join(sb.reg, "harnesses", "oc.json"), JSON.stringify({ ...fake, id: "oc", name: "OC", binary: "occ", dev: opencode.dev }))
  await $`git clone -q ${sb.harness} ${clone}`.quiet()
  await git(clone, "checkout", "-q", "-b", "my-mod", "v1.0.0")
  const preload = path.join(clone, "packages", "cli", "node_modules", "@opentui", "solid", "scripts")
  mkdirSync(preload, { recursive: true })
  mkdirSync(path.join(clone, "node_modules"), { recursive: true })
  mkdirSync(path.join(clone, "packages", "cli", "src"), { recursive: true })
  writeFileSync(path.join(preload, "preload.js"), "globalThis.PRELOADED = true\n")
  writeFileSync(
    path.join(clone, "packages", "cli", "src", "index.ts"),
    `import { appendFileSync } from "node:fs"
declare const OPENCODE_VERSION: string, OPENCODE_CHANNEL: string
appendFileSync(process.env.LOG!, JSON.stringify({ args: process.argv.slice(2), version: OPENCODE_VERSION, channel: OPENCODE_CHANNEL, preloaded: (globalThis as any).PRELOADED === true }) + "\\n")
`,
  )
})

describe("OpenCode 2 dev mode", () => {
  test("runs the clone through its entry file, preloaded, with the version and its own channel", async () => {
    const r = await cli(sb, "dev", clone, "--oc")
    expect(r.code, r.all).toBe(0)
    const runs = await run()
    expect(runs.at(-1)).toEqual({ args: [], version: "1.0.0+my-mod-dev", channel: "openmods-dev", preloaded: true })
  })
  test("opening the interface stops the previous dev server first, so every edit shows", async () => {
    expect((await run()).map((r) => r.args)).toEqual([["service", "stop"], []])
    expect((await run("--model", "x")).map((r) => r.args)).toEqual([["service", "stop"], ["--model", "x"]])
    expect((await run(sb.T)).map((r) => r.args)).toEqual([["service", "stop"], [sb.T]])
  })
  test("subcommands and --version leave the server running, for a session open elsewhere", async () => {
    expect((await run("run", "hello")).map((r) => r.args)).toEqual([["run", "hello"]])
    expect((await run("service", "status")).map((r) => r.args)).toEqual([["service", "status"]])
    expect((await run("--version")).map((r) => r.args)).toEqual([["--version"]])
  })
  test("an entry that cannot be written stops the start and says so", async () => {
    const modules = path.join(clone, "node_modules")
    rmSync(modules, { recursive: true, force: true })
    const r = await $`sh ${launcher()}`.env({ ...process.env, LOG: log }).nothrow().quiet()
    mkdirSync(modules, { recursive: true })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.toString()).toContain("openmods dev: could not write")
  })
})
