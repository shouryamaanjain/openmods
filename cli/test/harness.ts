// A fake harness for the tests. It stands in for OpenCode, Codex or fx: a git
// repo with release tags, an install command, and a build command that
// produces an executable at the artifact path. The executable is a shell
// script that prints a greeting, so a mod is a commit that changes the
// greeting and "does it work" is one line of output.
//
// Every test file gets its own sandbox: HOME, OPEN_MODS_HOME and the
// registry all live under a temp folder, and the CLI runs as a subprocess,
// so nothing on the machine is read or written.
import { $ } from "bun"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

export const CLI = path.resolve(import.meta.dir, "../src/index.ts")
export const WATCH = path.resolve(import.meta.dir, "../../script/release-watch.ts")
export const SITE = path.resolve(import.meta.dir, "../../script/site.ts")

export type Sandbox = ReturnType<typeof sandbox>

export function sandbox(name: string) {
  const T = path.join(tmpdir(), `open-mods-test-${name}-${process.pid}`)
  rmSync(T, { recursive: true, force: true })
  const dirs = {
    T,
    home: path.join(T, "home"),
    om: path.join(T, "om"),
    reg: path.join(T, "registry"),
    harness: path.join(T, "fake-harness"),
  }
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })
  return dirs
}

export const git = (dir: string, ...a: string[]) => $`git -C ${dir} -c user.name=t -c user.email=t@t ${a}`.quiet()

/** The CLI as a user would run it, inside the sandbox. */
export async function cli(sb: Sandbox, ...a: string[]) {
  const p = Bun.spawn(["bun", CLI, ...a, "--registry", sb.reg, "--no-path"], {
    env: { ...process.env, HOME: sb.home, OPEN_MODS_HOME: sb.om, OPEN_MODS_NO_CHECK: "1", PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out, err, all: out + err }
}

export async function script(sb: Sandbox, file: string, ...a: string[]) {
  const p = Bun.spawn(["bun", file, ...a], { cwd: sb.reg, stdout: "pipe", stderr: "pipe" })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out, err }
}

/**
 * Creates the fake harness at v1.0.0 and registers it. `build` may be
 * overridden, e.g. with a command that fails, to test what the CLI does then.
 */
export async function createHarness(sb: Sandbox, opts: { build?: string } = {}) {
  writeFileSync(path.join(sb.harness, "greet.sh"), "#!/bin/sh\necho hello from stock\n")
  writeFileSync(path.join(sb.harness, "README.md"), "fake harness\n")
  await $`git -C ${sb.harness} init -q -b main`.quiet()
  await git(sb.harness, "add", "-A")
  await git(sb.harness, "commit", "-q", "-m", "initial")
  await git(sb.harness, "tag", "v1.0.0")
  mkdirSync(path.join(sb.reg, "harnesses"), { recursive: true })
  mkdirSync(path.join(sb.reg, "mods", "fake"), { recursive: true })
  mkdirSync(path.join(sb.reg, "schema"), { recursive: true })
  writeFileSync(path.join(sb.reg, "schema", "mod.schema.json"), "{}\n")
  writeFileSync(path.join(sb.reg, "README.md"), "# registry\n")
  writeFileSync(path.join(sb.reg, "CONTRIBUTING.md"), "# Contributing\n\nSteps.\n")
  writeFileSync(
    path.join(sb.reg, "harnesses", "fake.json"),
    JSON.stringify({
      id: "fake",
      name: "Fake",
      repo: sb.harness,
      binary: "greet",
      install: "true",
      build: opts.build ?? "mkdir -p out/bin && cp greet.sh out/bin/greet && chmod +x out/bin/greet",
      artifact: "out/bin/greet",
      releaseTagPattern: "v*",
    }),
  )
}

/** Tags a new upstream release after applying `change` to the harness. */
export async function release(sb: Sandbox, tag: string, change: (dir: string) => void) {
  change(sb.harness)
  await git(sb.harness, "add", "-A")
  await git(sb.harness, "commit", "-q", "-m", `release ${tag}`)
  await git(sb.harness, "tag", tag)
}

/**
 * Makes a mod from a change on top of a release, packs it into the registry
 * (or ~/.open-mods/local with `local`), and fills in the manifest.
 */
export async function createMod(sb: Sandbox, name: string, change: (dir: string) => void, opts: { base?: string; local?: boolean; conflicts?: string[] } = {}) {
  const work = path.join(sb.T, `work-${name}`)
  rmSync(work, { recursive: true, force: true })
  await $`git clone -q ${sb.harness} ${work}`.quiet()
  await git(work, "checkout", "-q", opts.base ?? "v1.0.0")
  change(work)
  await git(work, "add", "-A")
  await git(work, "commit", "-q", "-m", `feat: ${name}`)
  const r = await cli(sb, "pack", work, "--name", name, "--harness", "fake", "--force", ...(opts.local ? ["--local"] : []))
  if (r.code !== 0) throw new Error(`pack failed: ${r.all}`)
  const dir = opts.local ? path.join(sb.om, "local", "fake", name) : path.join(sb.reg, "mods", "fake", name)
  const file = path.join(dir, "mod.json")
  const mod = JSON.parse(readFileSync(file, "utf8"))
  writeFileSync(file, JSON.stringify({ ...mod, description: `The ${name} mod.`, author: { name: "t", github: "t" }, ...(opts.conflicts ? { conflicts: opts.conflicts } : {}) }, null, 2))
  return dir
}

export const setGreeting = (text: string) => (dir: string) => writeFileSync(path.join(dir, "greet.sh"), `#!/bin/sh\necho ${text}\n`)
export const addFile = (name: string, text: string) => (dir: string) => writeFileSync(path.join(dir, name), text)

/** What `greet` prints right now through the launcher, or null when off. */
export async function greeting(sb: Sandbox) {
  const launcher = path.join(sb.om, "bin", "greet")
  if (!existsSync(launcher)) return null
  return (await $`sh ${launcher}`.env({ OPEN_MODS_NO_CHECK: "1", OPEN_MODS_NO_PROMPT: "1" }).text()).trim()
}
