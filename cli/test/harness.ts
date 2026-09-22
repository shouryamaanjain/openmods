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
export const cli = (sb: Sandbox, ...a: string[]) => run(sb, {}, ...a)

/**
 * The CLI with options: `answer` is typed at its y/N questions, `env` is
 * added to its environment, and `path: true` lets it edit the shell config.
 */
export async function run(sb: Sandbox, opts: { answer?: string; env?: Record<string, string>; path?: boolean }, ...a: string[]) {
  const p = Bun.spawn(["bun", CLI, ...a, "--registry", sb.reg, ...(opts.path ? [] : ["--no-path"])], {
    env: {
      ...process.env,
      HOME: sb.home,
      OPEN_MODS_HOME: sb.om,
      OPEN_MODS_NO_CHECK: "1",
      PATH: process.env.PATH ?? "",
      ...(opts.answer !== undefined ? { OPEN_MODS_ASSUME_TTY: "1" } : {}),
      ...opts.env,
    },
    stdin: opts.answer !== undefined ? new TextEncoder().encode(opts.answer) : "ignore",
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
 * Creates the fake harness at v1.0.0, registers it, and installs its stock
 * binary the way its official installer would. `build` may be overridden,
 * e.g. with a command that fails, to test what the CLI does then.
 */
export async function createHarness(sb: Sandbox, opts: { build?: string } = {}) {
  writeFileSync(path.join(sb.harness, "greet.sh"), "#!/bin/sh\necho hello from stock\n")
  writeFileSync(path.join(sb.harness, "README.md"), "fake harness\n")
  // What the fake build recipe depends on: a build config, and one line of package.json.
  writeFileSync(path.join(sb.harness, "build.cfg"), "compiler=1\n")
  writeFileSync(path.join(sb.harness, "package.json"), JSON.stringify({ version: "1.0.0", packageManager: "pnpm@9.0.0" }, null, 2) + "\n")
  writeFileSync(path.join(sb.harness, "lines.txt"), Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n")
  await $`git -C ${sb.harness} init -q -b main`.quiet()
  // Serve partial clones like GitHub does, so the CLI's blobless clones
  // really are blobless here too.
  await git(sb.harness, "config", "uploadpack.allowFilter", "true")
  await git(sb.harness, "config", "uploadpack.allowAnySHA1InWant", "true")
  await git(sb.harness, "add", "-A")
  await git(sb.harness, "commit", "-q", "-m", "initial")
  await git(sb.harness, "tag", "v1.0.0")
  mkdirSync(path.join(sb.reg, "mods"), { recursive: true })
  mkdirSync(path.join(sb.reg, "schema"), { recursive: true })
  writeFileSync(path.join(sb.reg, "schema", "mod.schema.json"), "{}\n")
  writeFileSync(path.join(sb.reg, "schema", "support.schema.json"), "{}\n")
  writeFileSync(path.join(sb.reg, "README.md"), "# registry\n")
  writeFileSync(path.join(sb.reg, "CONTRIBUTING.md"), "# Contributing\n\nSteps.\n")
  registerHarness(sb, { id: "fake", name: "Fake", binary: "greet", build: opts.build })
  await $`sh -c ${stockInstaller("greet")}`.env({ ...process.env, HOME: sb.home }).quiet()
}

/**
 * A harness's official installer, faked: it puts a stock binary in
 * ~/.<binary>/bin that prints its version and a greeting.
 */
export const stockInstaller = (binary: string) =>
  `mkdir -p "$HOME/.${binary}/bin" && printf '#!/bin/sh\\n[ "$1" = --version ] && echo 1.0.0 && exit 0\\necho stock ${binary}\\n' > "$HOME/.${binary}/bin/${binary}" && chmod +x "$HOME/.${binary}/bin/${binary}"`

/**
 * Registers a harness definition for the fake harness repo. A second id (say
 * "other", binary "hello") lets a test have a mod that supports two harnesses.
 */
export function registerHarness(sb: Sandbox, h: { id: string; name: string; binary: string; build?: string }) {
  mkdirSync(path.join(sb.reg, "harnesses"), { recursive: true })
  writeFileSync(
    path.join(sb.reg, "harnesses", `${h.id}.json`),
    JSON.stringify({
      id: h.id,
      name: h.name,
      repo: `file://${sb.harness}`,
      binary: h.binary,
      installer: { command: stockInstaller(h.binary), paths: [`~/.${h.binary}/bin`] },
      install: "echo installing dependencies",
      typecheck: "echo typechecking && sh -n greet.sh",
      build: h.build ?? "echo building && mkdir -p out/bin && cp greet.sh out/bin/greet && chmod +x out/bin/greet",
      artifact: "out/bin/greet",
      recipe: [{ file: "build.cfg" }, { file: "package.json", lines: '"packageManager"' }],
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
 * Makes a mod from a change on top of a release and packs it into the
 * registry (or ~/.open-mods/local with `local`) as t/<name>, for the fake
 * harness unless `harness` says otherwise. Returns the harness folder,
 * mods/t/<name>/<harness>.
 */
export async function createMod(
  sb: Sandbox,
  name: string,
  change: (dir: string) => void,
  opts: { base?: string; local?: boolean; conflicts?: string[]; harness?: string } = {},
) {
  const harness = opts.harness ?? "fake"
  const work = path.join(sb.T, `work-${name}`)
  rmSync(work, { recursive: true, force: true })
  await $`git clone -q ${sb.harness} ${work}`.quiet()
  await git(work, "checkout", "-q", opts.base ?? "v1.0.0")
  change(work)
  await git(work, "add", "-A")
  await git(work, "commit", "-q", "-m", `feat: ${name}`)
  const r = await cli(sb, "pack", work, "--name", name, "--owner", "t", "--harness", harness, "--force", ...(opts.local ? ["--local"] : []))
  if (r.code !== 0) throw new Error(`pack failed: ${r.all}`)
  const root = opts.local ? path.join(sb.om, "local", "t", name) : path.join(sb.reg, "mods", "t", name)
  const metaFile = path.join(root, "mod.json")
  writeFileSync(metaFile, JSON.stringify({ ...JSON.parse(readFileSync(metaFile, "utf8")), description: `The ${name} mod.` }, null, 2))
  const dir = path.join(root, harness)
  if (opts.conflicts) {
    const supportFile = path.join(dir, "support.json")
    writeFileSync(supportFile, JSON.stringify({ ...JSON.parse(readFileSync(supportFile, "utf8")), conflicts: opts.conflicts }, null, 2))
  }
  return dir
}

/** Replaces line `n` (1-based) of lines.txt. */
export const setLine = (n: number, text: string) => (dir: string) => {
  const file = path.join(dir, "lines.txt")
  const lines = readFileSync(file, "utf8").split("\n")
  lines[n - 1] = text
  writeFileSync(file, lines.join("\n"))
}

export const setGreeting = (text: string) => (dir: string) => writeFileSync(path.join(dir, "greet.sh"), `#!/bin/sh\necho ${text}\n`)
export const addFile = (name: string, text: string) => (dir: string) => writeFileSync(path.join(dir, name), text)

/** What `greet` prints right now through the launcher, or null when off. */
export async function greeting(sb: Sandbox) {
  const launcher = path.join(sb.om, "bin", "greet")
  if (!existsSync(launcher)) return null
  return (await $`sh ${launcher}`.env({ OPEN_MODS_NO_CHECK: "1", OPEN_MODS_NO_PROMPT: "1" }).text()).trim()
}
