// The Codex recipe, run against a stub Codex tree with a fake rustc and a
// stand-in for Codex's package builder:
//
// - It asks rustc for the build target where Codex's rust-toolchain.toml is,
//   inside codex-rs. With rustup and no default toolchain, rustc outside that
//   folder cannot say, and the build would get an empty --target. The fake
//   rustc answers only next to a toolchain file.
// - The build folder stays near the size of one build: a new Codex release
//   first removes the old compiled copies of Codex's own crates (they are
//   compiled again for it anyway), a new Rust removes everything, nothing
//   incremental is kept, and a folder grown past 1.5 times its last clean
//   build is cleared, whatever grew it.
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
const cleaned = path.join(dir, "cargo-clean.log")
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
// cargo, standing in: the workspace's packages, and what it was asked to clean.
writeFileSync(
  path.join(bin, "cargo"),
  `#!/bin/sh
case "$1" in
  metadata) [ -n "$FAKE_METADATA_FAILS" ] && exit 1; echo '{"packages":[{"name":"codex-cli"},{"name":"codex-tui"},{"name":"codex-core"}]}' ;;
  clean) shift; echo "$*" >> "${cleaned}" ;;
esac
`,
)
chmodSync(path.join(bin, "cargo"), 0o755)
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
  rmSync(cleaned, { force: true })
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
// The size of the last clean build, as the recipe records it; a big one keeps
// the size cap out of the way of the tests about other rules.
const baseKb = (kb: number) => writeFileSync(path.join(rs, "target", ".openmods-base-kb"), `${kb}\n`)
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

const cleanedWith = () => (existsSync(cleaned) ? readFileSync(cleaned, "utf8").trim() : "")

describe("the Codex build folder", () => {
  test("a clean build records its size, without the package it leaves", async () => {
    rmSync(path.join(rs, "target"), { recursive: true, force: true })
    await build({})
    const kb = Number(readFileSync(path.join(rs, "target", ".openmods-base-kb"), "utf8"))
    expect(kb).toBeGreaterThan(0)
    baseKb(1e9)
  })
  test("keeps nothing incremental: the build runs without it, and what an earlier one kept is removed", async () => {
    session("codex_tui-abc", 10)
    expect(await build({ CARGO_BUILD_JOBS: "8" })).toBe(host)
    expect(sessions()).toEqual([])
  })
  test("a new Codex release removes the old compiled copies of Codex's own crates first; the same release removes nothing", async () => {
    await build({ OPENMODS_VERSION: "0.157.1" })
    expect(cleanedWith()).toBe("")
    await build({ OPENMODS_VERSION: "0.158.0" })
    expect(cleanedWith()).toBe(`--offline --release --target ${host} -p codex-cli -p codex-tui -p codex-core`)
    expect(readFileSync(path.join(release, ".openmods-version"), "utf8").trim()).toBe("0.158.0")
  })
  test("if the crates cannot be listed, nothing is cleaned and the build goes on", async () => {
    await build({ OPENMODS_VERSION: "0.159.0", FAKE_METADATA_FAILS: "1" })
    expect(cleanedWith()).toBe("")
  })
  test("clears the whole release build on a new Rust, and nothing on a build from before it kept track", async () => {
    writeFileSync(path.join(release, "kept-dependency"), "")
    await build({ OPENMODS_VERSION: "0.159.0" })
    expect(existsSync(path.join(release, "kept-dependency"))).toBe(true)
    await build({ OPENMODS_VERSION: "0.159.0", FAKE_RUSTC: "1.96.0" })
    expect(existsSync(path.join(release, "kept-dependency"))).toBe(false)
    // A target folder from before these markers: nothing is taken for stale.
    writeFileSync(path.join(release, "kept-dependency"), "")
    rmSync(path.join(release, ".openmods-rustc"))
    rmSync(path.join(release, ".openmods-version"))
    await build({ OPENMODS_VERSION: "0.160.0" })
    expect(existsSync(path.join(release, "kept-dependency"))).toBe(true)
    expect(cleanedWith()).toBe("")
  })
  test("a folder grown past 1.5 times its last clean build is cleared, and measured again", async () => {
    writeFileSync(path.join(release, "stale"), "x".repeat(200_000))
    baseKb(10)
    await build({})
    expect(existsSync(path.join(release, "stale"))).toBe(false)
    expect(Number(readFileSync(path.join(rs, "target", ".openmods-base-kb"), "utf8"))).toBeLessThan(100)
    // Within the cap, nothing is cleared.
    writeFileSync(path.join(release, "kept"), "x")
    baseKb(1e9)
    await build({})
    expect(existsSync(path.join(release, "kept"))).toBe(true)
  })
  test("a folder from an older openmods, with no size recorded, is cleared once", async () => {
    writeFileSync(path.join(release, "old-build"), "")
    rmSync(path.join(rs, "target", ".openmods-base-kb"))
    await build({})
    expect(existsSync(path.join(release, "old-build"))).toBe(false)
    expect(Number(readFileSync(path.join(rs, "target", ".openmods-base-kb"), "utf8"))).toBeGreaterThan(0)
  })
  test("a first build that did not finish keeps what it did, and the next one records the size", async () => {
    writeFileSync(path.join(release, "partial"), "")
    baseKb(0)
    await build({})
    expect(existsSync(path.join(release, "partial"))).toBe(true)
    expect(Number(readFileSync(path.join(rs, "target", ".openmods-base-kb"), "utf8"))).toBeGreaterThan(0)
  })
})
