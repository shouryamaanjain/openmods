// End-to-end tests of the CLI against a tiny fake harness: a git repo with a
// release tag whose "build" copies a shell script into the artifact path.
// Every command runs as a subprocess with its own OPEN_MODS_HOME, HOME and
// registry, so nothing touches the machine running the tests.
import { beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const CLI = path.resolve(import.meta.dir, "../src/index.ts")
const WATCH = path.resolve(import.meta.dir, "../../script/release-watch.ts")
const T = path.join(tmpdir(), `open-mods-test-${process.pid}`)
const HOME = path.join(T, "home")
const OM = path.join(T, "om")
const REG = path.join(T, "registry")
const HARNESS = path.join(T, "fake-harness")
const WORK = path.join(T, "work")

const git = (dir: string, ...a: string[]) =>
  $`git -C ${dir} -c user.name=t -c user.email=t@t ${a}`.quiet()

async function run(...a: string[]) {
  const p = Bun.spawn(["bun", CLI, ...a, "--registry", REG, "--no-path"], {
    env: { ...process.env, HOME, OPEN_MODS_HOME: OM, OPEN_MODS_NO_CHECK: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out, err, all: out + err }
}

beforeAll(async () => {
  for (const d of [HOME, OM, REG, HARNESS, WORK]) mkdirSync(d, { recursive: true })
  // The fake harness: one script that prints a greeting; "build" copies it.
  writeFileSync(path.join(HARNESS, "greet.sh"), "#!/bin/sh\necho hello from stock\n")
  writeFileSync(path.join(HARNESS, "README.md"), "fake harness\n")
  await $`git -C ${HARNESS} init -q -b main`.quiet()
  await git(HARNESS, "add", "-A")
  await git(HARNESS, "commit", "-q", "-m", "initial")
  await git(HARNESS, "tag", "v1.0.0")
  // The registry: schema-less minimum the CLI needs.
  mkdirSync(path.join(REG, "harnesses"), { recursive: true })
  mkdirSync(path.join(REG, "mods", "fake"), { recursive: true })
  mkdirSync(path.join(REG, "schema"), { recursive: true })
  writeFileSync(path.join(REG, "schema", "mod.schema.json"), "{}")
  writeFileSync(
    path.join(REG, "harnesses", "fake.json"),
    JSON.stringify({
      id: "fake",
      name: "Fake",
      repo: HARNESS,
      binary: "greet",
      install: "true",
      build: "mkdir -p out/bin && cp greet.sh out/bin/greet && chmod +x out/bin/greet",
      artifact: "out/bin/greet",
      releaseTagPattern: "v*",
    }),
  )
  // A mod: one commit on top of v1.0.0 that changes the greeting.
  await $`git clone -q ${HARNESS} ${WORK}`.quiet()
  writeFileSync(path.join(WORK, "greet.sh"), "#!/bin/sh\necho hello from the mod\n")
  await git(WORK, "commit", "-qam", "feat: friendlier greeting")
})

describe("pack", () => {
  test("turns commits on top of the release tag into a mod folder", async () => {
    const r = await run("pack", WORK, "--name", "friendly", "--harness", "fake")
    expect(r.code).toBe(0)
    const mod = JSON.parse(readFileSync(path.join(REG, "mods", "fake", "friendly", "mod.json"), "utf8"))
    expect(mod.upstream.ref).toBe("v1.0.0")
    expect(mod.patches).toEqual(["patches/0001-feat-friendlier-greeting.patch"])
    expect(mod.version).toBeUndefined()
    writeFileSync(
      path.join(REG, "mods", "fake", "friendly", "mod.json"),
      JSON.stringify({ ...mod, description: "A friendlier greeting.", author: { name: "t", github: "t" } }),
    )
  })
  test("refuses a bad name", async () => {
    expect((await run("pack", WORK, "--name", "Bad_Name", "--harness", "fake")).code).toBe(1)
  })
})

describe("list and info", () => {
  test("list shows the mod with its release", async () => {
    const r = await run("list")
    expect(r.out).toContain("fake/friendly")
    expect(r.out).toContain("v1.0.0")
  })
  test("info lists touched files", async () => {
    const r = await run("info", "fake/friendly")
    expect(r.out).toContain("greet.sh")
  })
})

describe("install, on, off, uninstall", () => {
  test("install needs a target", async () => {
    const r = await run("install")
    expect(r.code).toBe(1)
    expect(r.err).toContain("needs a mod")
  })
  test("install builds and switches on", async () => {
    const r = await run("install", "fake/friendly")
    expect(r.code).toBe(0)
    expect(r.out).toContain("now runs Fake v1.0.0 + friendly")
    const launcher = path.join(OM, "bin", "greet")
    expect(existsSync(launcher)).toBe(true)
    expect((await $`sh ${launcher}`.env({ OPEN_MODS_NO_CHECK: "1" }).text()).trim()).toBe("hello from the mod")
    // The build was copied aside, and the launcher points at the copy.
    expect(readFileSync(launcher, "utf8")).toContain(path.join(OM, "harnesses", "fake", "builds"))
  })
  test("update is a no-op when nothing changed", async () => {
    expect((await run("update", "fake")).out).toContain("already up to date")
  })
  test("off removes the launcher, on brings it back", async () => {
    expect((await run("off")).out).toContain("stock Fake again")
    expect(existsSync(path.join(OM, "bin", "greet"))).toBe(false)
    expect((await run("on")).out).toContain("now runs Fake v1.0.0 + friendly")
    expect(existsSync(path.join(OM, "bin", "greet"))).toBe(true)
  })
  test("off <mod> builds it out and keeps it installed", async () => {
    const r = await run("off", "fake/friendly")
    expect(r.out).toContain("Every Fake mod is off")
    expect((await run("status")).out).toContain("friendly is off")
    expect((await run("on", "fake/friendly")).out).toContain("now runs Fake v1.0.0 + friendly")
  })
  test("uninstall needs a target and removes everything", async () => {
    expect((await run("uninstall")).code).toBe(1)
    const r = await run("uninstall", "fake/friendly")
    expect(r.out).toContain("Removed the modded Fake build")
    expect(existsSync(path.join(OM, "bin", "greet"))).toBe(false)
    expect(existsSync(path.join(OM, "harnesses", "fake", "builds"))).toBe(false)
    const head = (await $`git -C ${path.join(OM, "harnesses", "fake", "src")} log -1 --format=%s`.text()).trim()
    expect(head).toBe("initial")
    expect((await run("uninstall", "fake/friendly")).code).toBe(1)
  })
})

describe("check and release watch", () => {
  test("check applies against a newer release", async () => {
    // A new upstream release that leaves greet.sh alone: the mod still applies.
    writeFileSync(path.join(HARNESS, "CHANGELOG.md"), "1.1.0\n")
    await git(HARNESS, "add", "-A")
    await git(HARNESS, "commit", "-q", "-m", "release 1.1.0")
    await git(HARNESS, "tag", "v1.1.0")
    const r = await run("check", path.join(REG, "mods", "fake", "friendly"), "--ref", "v1.1.0", "--build", "--json", "--workspace", path.join(T, "check"))
    expect(r.code).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.applies).toBe(true)
    expect(j.builds).toBe(true)
    writeFileSync(path.join(T, "results.json"), r.out)
  })
  test("check reports a conflict", async () => {
    // A release that rewrites the same line: the mod no longer applies.
    writeFileSync(path.join(HARNESS, "greet.sh"), "#!/bin/sh\necho hello from stock 2.0\n")
    await git(HARNESS, "commit", "-qam", "release 2.0.0")
    await git(HARNESS, "tag", "v2.0.0")
    const r = await run("check", path.join(REG, "mods", "fake", "friendly"), "--ref", "v2.0.0", "--json", "--workspace", path.join(T, "check"))
    expect(r.code).toBe(1)
    expect(JSON.parse(r.out).applies).toBe(false)
  })
  test("release watch bumps a passing mod and marks a failing one", async () => {
    const results = path.join(T, "results")
    mkdirSync(results, { recursive: true })
    writeFileSync(path.join(results, "friendly.json"), readFileSync(path.join(T, "results.json")))
    const plan = Bun.spawn(["bun", WATCH, "plan", "--ref", "v1.1.0", "--registry", REG], { cwd: REG, stdout: "pipe", stderr: "pipe" })
    const planned = JSON.parse(await new Response(plan.stdout).text())
    expect(planned.matrix).toEqual([{ mod: "mods/fake/friendly", harness: "fake", ref: "v1.1.0" }])
    const apply = Bun.spawn(["bun", WATCH, "apply", results, "--registry", REG], { cwd: REG, stdout: "pipe", stderr: "pipe" })
    const out = await new Response(apply.stdout).text()
    expect(await apply.exited).toBe(0)
    expect(out).toContain("1 mod now supports it, 0 do not")
    const mod = JSON.parse(readFileSync(path.join(REG, "mods", "fake", "friendly", "mod.json"), "utf8"))
    expect(mod.upstream.ref).toBe("v1.1.0")
    // Now a failure for v2.0.0.
    writeFileSync(path.join(results, "friendly.json"), JSON.stringify({ mod: "fake/friendly", ref: "v2.0.0", commit: "x", applies: false, error: "patch does not apply" }))
    const apply2 = Bun.spawn(["bun", WATCH, "apply", results, "--registry", REG], { cwd: REG, stdout: "pipe", stderr: "pipe" })
    expect(await apply2.exited).toBe(0)
    const status = JSON.parse(readFileSync(path.join(REG, "mods", "fake", "friendly", "status.json"), "utf8"))
    expect(status.ok).toBe(false)
    expect(status.supports).toBe("v1.1.0")
    expect(JSON.parse(readFileSync(path.join(REG, "mods", "fake", "friendly", "mod.json"), "utf8")).upstream.ref).toBe("v1.1.0")
  })
})
