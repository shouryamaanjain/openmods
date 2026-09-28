// The mods list is live: list, info and install pull the registry first, so a
// mod published a minute ago shows up without updating anything. The program
// runs from its own copy in ~/.openmods/cli, so pulling never changes it; only
// `openmods update` does, and says from which version to which. An install
// from before that runs the CLI from the registry clone, and moves it out.
import { beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { addFile, createHarness, createMod, git, sandbox } from "./harness"

const sb = sandbox("live-list")
const REPO_CLI = path.resolve(import.meta.dir, "..")
const copy = () => path.join(sb.om, "cli")
const commit = async (message: string) => {
  await git(sb.reg, "add", "-A")
  await git(sb.reg, "commit", "-qm", message)
}

// openmods as installed: its own copy, and the registry cloned from a URL.
async function openmods(entry: string, ...a: string[]) {
  const p = Bun.spawn(["bun", entry, ...a], {
    env: {
      ...process.env,
      HOME: sb.home,
      OPENMODS_HOME: sb.om,
      OPENMODS_REGISTRY: `file://${sb.reg}`,
      OPENMODS_REVOKED_URL: "",
      OPENMODS_INDEX_URL: "",
      OPENMODS_NO_CHECK: "1",
      TMPDIR: sb.tmp,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out, err, all: out + err }
}
const run = (...a: string[]) => openmods(path.join(copy(), "src", "index.ts"), ...a)

beforeAll(async () => {
  await createHarness(sb)
  await createMod(sb, "friendly", addFile("FRIENDLY.md", "friendly\n"))
  // The registry, with the program's source in cli/, as on GitHub.
  mkdirSync(path.join(sb.reg, "cli"), { recursive: true })
  for (const f of ["src", "get-bun.sh", "package.json"]) cpSync(path.join(REPO_CLI, f), path.join(sb.reg, "cli", f), { recursive: true })
  await git(sb.reg, "init", "-q")
  await commit("registry")
  // As the installer leaves it: the program copied out of a fresh clone.
  await $`git clone -q ${`file://${sb.reg}`} ${path.join(sb.om, "registry")}`.quiet()
  mkdirSync(copy(), { recursive: true })
  for (const f of ["src", "get-bun.sh", "package.json"]) cpSync(path.join(sb.om, "registry", "cli", f), path.join(copy(), f), { recursive: true })
  writeFileSync(path.join(copy(), ".version"), "0.1.0 (installed)\n")
})

describe("the mods list", () => {
  test("lists what the registry has", async () => {
    const r = await run("list")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("t/friendly")
  })
  test("a mod published since shows up without updating anything", async () => {
    await createMod(sb, "fresh", addFile("FRESH.md", "fresh\n"))
    await commit("t/fresh")
    const r = await run("list")
    expect(r.out).toContain("t/fresh")
    expect((await run("info", "t/fresh")).out).toContain("FRESH.md")
  })
  test("offline, it uses what this machine fetched last, and says so", async () => {
    await git(path.join(sb.om, "registry"), "remote", "set-url", "origin", path.join(sb.T, "unreachable"))
    const r = await run("list")
    await git(path.join(sb.om, "registry"), "remote", "set-url", "origin", `file://${sb.reg}`)
    expect(r.code).toBe(0)
    expect(r.all).toContain("Could not reach the OpenMods registry")
    expect(r.out).toContain("t/fresh")
  })
})

describe("the program", () => {
  test("pulling the mods list never changes it", async () => {
    appendFileSync(path.join(sb.reg, "cli", "src", "index.ts"), "\n// a newer openmods\n")
    await commit("a newer openmods")
    expect((await run("list")).code).toBe(0)
    expect(readFileSync(path.join(copy(), "src", "index.ts"), "utf8")).not.toContain("a newer openmods")
  })
  test("openmods update replaces it, and says from which version to which", async () => {
    const r = await run("update")
    expect(r.code, r.all).toBe(0)
    const head = (await git(sb.reg, "rev-parse", "--short", "HEAD")).stdout.toString().trim()
    expect(r.all).toContain(`OpenMods is updated: 0.1.0 (installed) → 0.1.0 (${head}). Your next command runs it.`)
    expect(readFileSync(path.join(copy(), "src", "index.ts"), "utf8")).toContain("a newer openmods")
    expect((await run("update")).all).not.toContain("OpenMods is updated")
  })
  test("an install from before runs it from the registry clone, and moves it out once", async () => {
    rmSync(copy(), { recursive: true })
    mkdirSync(path.join(sb.om, "bin"), { recursive: true })
    const wrapper = path.join(sb.om, "bin", "openmods")
    writeFileSync(wrapper, `#!/bin/sh\nexec bun "${sb.om}/registry/cli/src/index.ts" "$@"\n`, { mode: 0o755 })
    const r = await openmods(path.join(sb.om, "registry", "cli", "src", "index.ts"), "status")
    expect(r.code, r.all).toBe(0)
    expect(existsSync(path.join(copy(), "src", "index.ts"))).toBe(true)
    expect(readFileSync(path.join(copy(), ".version"), "utf8")).toMatch(/^0\.1\.0 \([0-9a-f]+\)/)
    expect(readFileSync(wrapper, "utf8")).toContain(`${sb.om}/cli/src/index.ts`)
    expect(readFileSync(wrapper, "utf8")).not.toContain("/registry/cli/")
  })
})
