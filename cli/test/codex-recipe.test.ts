// The Codex recipe, run against a stub Codex tree with a fake rustc and a
// stand-in for Codex's package builder:
//
// - It asks rustc for the build target where Codex's rust-toolchain.toml is,
//   inside codex-rs. With rustup and no default toolchain, rustc outside that
//   folder cannot say, and the build would get an empty --target. The fake
//   rustc answers only next to a toolchain file.
// - Rebuilds after a mod change compile incrementally when there is memory
//   for it (4 or more build jobs), and what that keeps is cleared when it can
//   no longer be used: on a new Codex release, a new Rust, and old sessions.
import { afterAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const codex = JSON.parse(readFileSync(path.resolve(import.meta.dir, "../../harnesses/codex.json"), "utf8"))
const dir = mkdtempSync(path.join(tmpdir(), "openmods-codex-recipe-"))
// A path with spaces, as a home folder can have.
const root = path.join(dir, "my codex")
const rs = path.join(root, "codex-rs")
const bin = path.join(dir, "bin")
const record = path.join(dir, "builder.log")
const host = "aarch64-apple-darwin"
const release = path.join(rs, "target", host, "release")
mkdirSync(path.join(rs, "cli"), { recursive: true })
mkdirSync(path.join(root, "scripts"), { recursive: true })
mkdirSync(bin)
writeFileSync(path.join(rs, "rust-toolchain.toml"), '[toolchain]\nchannel = "1.95.0"\n')
writeFileSync(
  path.join(bin, "rustc"),
  `#!/bin/sh
[ -f rust-toolchain.toml ] || { echo "error: rustup could not choose a version of rustc to run" >&2; exit 1; }
case "$1" in -vV) echo 'host: ${host}' ;; -V) echo "rustc \${FAKE_RUSTC:-1.95.0}" ;; esac
`,
)
chmodSync(path.join(bin, "rustc"), 0o755)
// Codex's package builder, standing in: records how it was run and leaves a binary.
writeFileSync(
  path.join(root, "scripts", "build_codex_package.py"),
  `import os, sys
open(os.environ["RECORD"], "a").write(os.environ.get("CARGO_PROFILE_RELEASE_INCREMENTAL", "") + " " + sys.argv[sys.argv.index("--target") + 1] + "\\n")
os.makedirs("codex-rs/target/openmods-package/bin", exist_ok=True)
open("codex-rs/target/openmods-package/bin/codex", "w").write("")
`,
)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// A command from the recipe, run by a fixed shell program as its argument.
const sh = (command: string, cwd: string, env: Record<string, string> = {}) =>
  $`sh -c ${'eval "$1"'} sh ${command}`.cwd(cwd).env({ ...process.env, PATH: `${bin}:${process.env.PATH}`, RECORD: record, ...env }).nothrow().quiet()

// The --target a command asks rustc for, worked out where it runs that part.
async function target(command: string, cwd: string) {
  const inner = command.match(/(?:--target |host=)"\$\(([^"]*)\)"/)?.[1]
  expect(inner, command).toBeDefined()
  return (await sh(`printf "%s" "$(${inner})"`, cwd)).stdout.toString()
}

// One build, as the CLI runs it: the checkout's cli/Cargo.toml is fresh each time.
async function build(env: Record<string, string>) {
  writeFileSync(path.join(rs, "cli", "Cargo.toml"), '[package]\nname = "codex-cli"\nversion.workspace = true\n')
  rmSync(record, { force: true })
  const r = await sh(codex.build, root, { OPENMODS_VERSION: "0.157.1", OPENMODS_MODS: "space-invaders-1", ...env })
  expect(r.exitCode, r.stderr.toString()).toBe(0)
  return readFileSync(record, "utf8").trim()
}
const session = (name: string, age: number) => {
  const d = path.join(release, "incremental", name)
  mkdirSync(d, { recursive: true })
  const t = Date.now() / 1000 - age
  utimesSync(d, t, t)
}
const sessions = () => (existsSync(path.join(release, "incremental")) ? readdirSync(path.join(release, "incremental")).sort() : [])

describe("the Codex recipe's build target, with no default Rust toolchain", () => {
  test("the build asks inside codex-rs, where it starts", async () => {
    expect(codex.build.startsWith("cd codex-rs &&")).toBe(true)
    expect(await target(codex.build, rs)).toBe(host)
  })
  test("the dev command asks inside codex-rs, from the checkout's root", async () => {
    expect(await target(codex.dev, root)).toBe(host)
  })
  test("the dependency step asks from codex-rs, where it runs", async () => {
    expect(codex.install.startsWith("cd codex-rs &&")).toBe(true)
    expect(await target(codex.install, rs)).toBe(host)
  })
})

describe("the Codex build's incremental compiling", () => {
  test("is on with 4 or more build jobs, and off with fewer or none set", async () => {
    expect(await build({ CARGO_BUILD_JOBS: "8" })).toBe(`true ${host}`)
    expect(await build({ CARGO_BUILD_JOBS: "4" })).toBe(`true ${host}`)
    expect(await build({ CARGO_BUILD_JOBS: "3" })).toBe(`false ${host}`)
    expect(await build({ CARGO_BUILD_JOBS: "12" })).toBe(`true ${host}`)
    expect(await build({ CARGO_BUILD_JOBS: "" })).toBe(`false ${host}`)
  })
  // The CLI package's crates (codex, codex_cli) get a new folder with each
  // mod stamp, so their old ones are removed. Any other crate keeps one folder,
  // which rustc cleans itself; one name can be two crates in use at once, a
  // library and a program, so those are left alone.
  test("keeps only the newest folder of the stamped crates, and every other crate's folders", async () => {
    session("codex-old", 300)
    session("codex-new", 10)
    session("codex_cli-old", 300)
    session("codex_cli-new", 10)
    session("codex_code_mode_host-lib", 200)
    session("codex_code_mode_host-bin", 20)
    session("codex_core-a", 300)
    await build({ CARGO_BUILD_JOBS: "8" })
    expect(sessions()).toEqual(["codex-new", "codex_cli-new", "codex_code_mode_host-bin", "codex_code_mode_host-lib", "codex_core-a"])
  })
  test("clears what it kept on a new Codex release", async () => {
    await build({ CARGO_BUILD_JOBS: "8", OPENMODS_VERSION: "0.158.0" })
    expect(sessions()).toEqual([])
    expect(readFileSync(path.join(release, ".openmods-version"), "utf8").trim()).toBe("0.158.0")
  })
  test("clears the whole release build on a new Rust, and nothing on a build from before it kept track", async () => {
    writeFileSync(path.join(release, "kept-dependency"), "")
    await build({ CARGO_BUILD_JOBS: "8", OPENMODS_VERSION: "0.158.0" })
    expect(existsSync(path.join(release, "kept-dependency"))).toBe(true)
    await build({ CARGO_BUILD_JOBS: "8", OPENMODS_VERSION: "0.158.0", FAKE_RUSTC: "1.96.0" })
    expect(existsSync(path.join(release, "kept-dependency"))).toBe(false)
    // A target folder from before these markers: nothing is taken for stale.
    writeFileSync(path.join(release, "kept-dependency"), "")
    rmSync(path.join(release, ".openmods-rustc"))
    await build({ CARGO_BUILD_JOBS: "8", OPENMODS_VERSION: "0.158.0" })
    expect(existsSync(path.join(release, "kept-dependency"))).toBe(true)
  })
})
