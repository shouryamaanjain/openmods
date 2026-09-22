#!/usr/bin/env bun
// open-mods: install source-level mods into open-source agent harnesses.
//
// A mod is an ordered series of git patches against a pinned upstream commit.
// Installing one clones the harness, checks out that commit, applies the
// patches, builds, and links the resulting binary under ~/.open-mods/bin.
// The stock install of the harness is never touched.

import { $ } from "bun"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

type Harness = {
  id: string
  name: string
  repo: string
  binary: string
  requirements?: { command: string; hint: string }[]
  install: string
  typecheck?: string
  build: string
  artifact: string
  releaseTagPattern?: string
}

type Mod = {
  name: string
  harness: string
  description: string
  author?: { name?: string; github?: string; url?: string }
  license: string
  tags?: string[]
  upstream: { ref: string; commit: string }
  patches: string[]
  conflicts?: string[]
  dir: string
  // "registry": published in the registry. "local": unpublished, from
  // ~/.open-mods/local/<harness>/<mod>, where authors keep mods they are
  // still working on or do not want to publish.
  source: "registry" | "local"
}

// mods: every installed mod, in apply order. off: the subset built out for now.
type State = Record<string, { ref: string; commit: string; mods: string[]; off: string[]; hashes: Record<string, string>; artifact: string; enabled: boolean }>

const HOME = process.env.OPEN_MODS_HOME ?? path.join(homedir(), ".open-mods")
// A release as people see it: "1.18.31" for the tag v1.18.31, "0.155.1" for
// rust-v0.155.1. The tag itself stays raw in mod.json and in git commands.
const rel = (ref: string) => ref.replace(/^[^0-9]*/, "")
const DEFAULT_REGISTRY = "https://github.com/shouryamaanjain/open-mods"
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "open-mods",
  GIT_AUTHOR_EMAIL: "open-mods@localhost",
  GIT_COMMITTER_NAME: "open-mods",
  GIT_COMMITTER_EMAIL: "open-mods@localhost",
}

const args = process.argv.slice(2)
const flags = new Map<string, string | true>()
const positional: string[] = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]!
  if (a.startsWith("--")) {
    const [k, v] = a.slice(2).split("=", 2)
    if (v !== undefined) flags.set(k!, v)
    else if (args[i + 1] && !args[i + 1]!.startsWith("--")) flags.set(k!, args[++i]!)
    else flags.set(k!, true)
  } else positional.push(a)
}
const flag = (k: string) => {
  const v = flags.get(k)
  return typeof v === "string" ? v : undefined
}
const has = (k: string) => flags.has(k)

const log = (msg: string) => {
  if (!has("json")) console.log(msg)
}
const fail = (msg: string): never => {
  console.error(`error: ${msg}`)
  process.exit(1)
}

// ---------------------------------------------------------------- registry

function registryDir(): string {
  const explicit = flag("registry") ?? process.env.OPEN_MODS_REGISTRY
  if (explicit && existsSync(path.join(explicit, "mods"))) return path.resolve(explicit)
  const local = path.resolve(import.meta.dir, "..", "..")
  if (existsSync(path.join(local, "mods")) && existsSync(path.join(local, "harnesses"))) return local
  return path.join(HOME, "registry")
}

async function ensureRegistry(): Promise<string> {
  const dir = registryDir()
  if (existsSync(path.join(dir, "mods"))) return dir
  const url = flag("registry") ?? process.env.OPEN_MODS_REGISTRY ?? DEFAULT_REGISTRY
  log(`Fetching registry ${url}`)
  mkdirSync(path.dirname(dir), { recursive: true })
  await $`git clone --depth 1 ${url} ${dir}`.quiet()
  return dir
}

async function refreshRegistry(): Promise<string> {
  const dir = await ensureRegistry()
  if (dir === path.join(HOME, "registry")) {
    log("Updating registry")
    await $`git -C ${dir} pull --ff-only`.quiet()
  }
  return dir
}

function loadHarness(reg: string, id: string): Harness {
  const file = path.join(reg, "harnesses", `${id}.json`)
  if (!existsSync(file)) fail(`unknown harness "${id}" (no ${file})`)
  return JSON.parse(readFileSync(file, "utf8"))
}

const LOCAL = path.join(HOME, "local")

function loadMod(dir: string, source: Mod["source"] = dir.startsWith(LOCAL) ? "local" : "registry"): Mod {
  const file = path.join(dir, "mod.json")
  if (!existsSync(file)) fail(`${dir} has no mod.json`)
  const mod = JSON.parse(readFileSync(file, "utf8"))
  return { ...mod, dir, source }
}

function modsUnder(root: string, source: Mod["source"], harness?: string): Mod[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (!harness || d.name === harness))
    .flatMap((h) =>
      readdirSync(path.join(root, h.name), { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(path.join(root, h.name, d.name, "mod.json")))
        .map((d) => loadMod(path.join(root, h.name, d.name), source)),
    )
}

// Registry mods first, then local ones; a local mod with the same name as a
// registry mod shadows it, so an author can test a change before publishing.
function listMods(reg: string, harness?: string): Mod[] {
  const local = modsUnder(LOCAL, "local", harness)
  const published = modsUnder(path.join(reg, "mods"), "registry", harness).filter(
    (m) => !local.some((l) => l.harness === m.harness && l.name === m.name),
  )
  return [...published, ...local]
}

function resolveMod(reg: string, spec: string): Mod {
  const [harness, name] = spec.includes("/") ? spec.split("/", 2) : [undefined, spec]
  const found = listMods(reg, harness).filter((m) => m.name === name)
  if (found.length === 0) fail(`no mod "${spec}" in registry ${reg}`)
  if (found.length > 1) fail(`"${spec}" is ambiguous; use ${found.map((m) => `${m.harness}/${m.name}`).join(" or ")}`)
  return found[0]!
}

// A mod's version is the harness release it supports (mod.upstream.ref), so
// a code change at the same release is noticed by hashing the patches.
function patchHash(mod: Mod): string {
  const hasher = new Bun.CryptoHasher("sha256")
  for (const p of mod.patches) hasher.update(readFileSync(path.join(mod.dir, p)))
  return hasher.digest("hex").slice(0, 16)
}

function touchedFiles(mod: Mod): string[] {
  const files = new Set<string>()
  for (const p of mod.patches) {
    const text = readFileSync(path.join(mod.dir, p), "utf8")
    for (const m of text.matchAll(/^diff --git a\/(.+?) b\//gm)) files.add(m[1]!)
  }
  return [...files].sort()
}

// ------------------------------------------------------------------- state

const statePath = path.join(HOME, "state.json")
const loadState = (): State => {
  if (!existsSync(statePath)) return {}
  const raw = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, Partial<State[string]>>
  // Older state files lack artifact/enabled; derive them so nothing crashes.
  return Object.fromEntries(
    Object.entries(raw).map(([id, e]) => [
      id,
      {
        ref: e.ref ?? "",
        commit: e.commit ?? "",
        mods: e.mods ?? [],
        off: e.off ?? [],
        hashes: e.hashes ?? {},
        artifact: e.artifact ?? "",
        enabled: e.enabled ?? existsSync(path.join(HOME, "bin", id)),
      },
    ]),
  )
}
const saveState = (s: State) => {
  mkdirSync(HOME, { recursive: true })
  writeFileSync(statePath, JSON.stringify(s, null, 2) + "\n")
}

// ------------------------------------------------------------------- build

function artifactPath(h: Harness, root: string) {
  return path.join(root, h.artifact.replaceAll("{os}", process.platform).replaceAll("{arch}", process.arch))
}

async function checkRequirements(h: Harness) {
  for (const r of h.requirements ?? []) {
    if (r.command === "bun") continue // provisioned per release by ensureToolchain
    if (!Bun.which(r.command)) fail(`${h.name} needs "${r.command}". ${r.hint}`)
  }
}

// Leaves no `git am` in progress. `git am --abort` is enough on most git
// versions, but some leave .git/rebase-apply behind after a failed 3-way
// apply, and the next `git am` then refuses to start; so the state
// directory is removed as well. It holds nothing but the aborted apply.
async function clearApplyState(root: string) {
  await $`git -C ${root} am --abort`.nothrow().quiet()
  for (const d of ["rebase-apply", "rebase-merge"]) rmSync(path.join(root, ".git", d), { recursive: true, force: true })
}

async function ensureCheckout(h: Harness, root: string, commit: string, ref: string) {
  if (!existsSync(path.join(root, ".git"))) {
    log(`Cloning ${h.repo} (blobless, this is a one-time cost)`)
    mkdirSync(path.dirname(root), { recursive: true })
    await $`git clone --filter=blob:none --no-checkout --no-tags ${h.repo} ${root}`
  }
  const have = await $`git -C ${root} cat-file -t ${commit}`.nothrow().quiet()
  if (have.exitCode !== 0) {
    log(`Fetching ${ref}`)
    await $`git -C ${root} fetch --no-tags origin tag ${ref}`.quiet()
  }
  await clearApplyState(root)
  await $`git -C ${root} checkout -q --force --detach ${commit}`
}

// Harness checkouts are blobless: only the checked-out release's files are
// local. A three-way apply needs the version of each file the patch was
// made against, and git cannot fetch it on demand from the short ids in a
// patch, so it would report a conflict for any nearby upstream change. This
// fetches the mod's base commit and reads each touched file from it, which
// makes git fetch exactly those versions.
async function fetchBases(root: string, mod: Mod) {
  if (!mod.upstream.commit) return
  const have = await $`git -C ${root} cat-file -e ${mod.upstream.commit}^{commit}`.nothrow().quiet()
  if (have.exitCode !== 0) await $`git -C ${root} fetch --no-tags --filter=blob:none origin ${mod.upstream.commit}`.nothrow().quiet()
  for (const file of touchedFiles(mod)) await $`git -C ${root} cat-file -p ${mod.upstream.commit + ":" + file}`.nothrow().quiet()
}

async function applyMods(root: string, mods: Mod[]) {
  for (const mod of mods) {
    log(`Applying ${mod.harness}/${mod.name} (${mod.patches.length} patch${mod.patches.length === 1 ? "" : "es"})`)
    const files = mod.patches.map((p) => path.join(mod.dir, p))
    await fetchBases(root, mod)
    const r = await $`git -C ${root} am -3 --quiet ${files}`.env({ ...process.env, ...GIT_IDENTITY }).nothrow()
    if (r.exitCode !== 0) {
      await clearApplyState(root)
      fail(`${mod.harness}/${mod.name} does not apply cleanly at ${rel(mod.upstream.ref)}. It probably conflicts with a mod applied before it.`)
    }
  }
}

// Harness install/build commands run with these set, so a build can stamp
// itself: OPEN_MODS_HARNESS=opencode OPEN_MODS_REF=v1.18.31
// OPEN_MODS_VERSION=1.18.31 OPEN_MODS_MODS=vim-keys.quiet-startup
// (dot-separated, so "${OPEN_MODS_VERSION}+${OPEN_MODS_MODS}" is valid semver)
let buildEnv: Record<string, string> = {}

class CommandFailed extends Error {}

async function shell(cmd: string, cwd: string) {
  // With --json, stdout carries only the JSON result: a harness's install,
  // build and typecheck output goes to stderr instead.
  const proc = Bun.spawn(["sh", "-c", cmd], { cwd, stdio: ["inherit", has("json") ? 2 : "inherit", "inherit"], env: { ...process.env, ...buildEnv } })
  const code = await proc.exited
  if (code !== 0) throw new CommandFailed(`command failed (${code}): ${cmd}`)
}

// A harness release pins its toolchain (package.json "packageManager":
// "bun@1.3.14"). Building with a different version can produce a binary that
// is subtly broken (Bun 1.4.2 miscompiles OpenCode 1.18.31, for one), so the
// exact pinned version is installed under ~/.open-mods/toolchains and put
// first on PATH for the build. Nothing global changes.
async function ensureToolchain(root: string): Promise<string | null> {
  const pkg = path.join(root, "package.json")
  if (!existsSync(pkg)) return null
  const pm = JSON.parse(readFileSync(pkg, "utf8")).packageManager as string | undefined
  const m = pm?.match(/^bun@(\d+\.\d+\.\d+)/)
  if (!m) return null
  const want = m[1]!
  const have = Bun.which("bun") ? (await $`bun --version`.nothrow().text()).trim() : ""
  if (have === want) return null
  const dir = path.join(HOME, "toolchains", `bun-${want}`)
  const bin = path.join(dir, "bin")
  if (!existsSync(path.join(bin, "bun"))) {
    if (process.platform === "win32") fail(`this release needs bun ${want} (you have ${have || "none"}); install it from https://bun.sh`)
    log(`This release builds with bun ${want} (you have ${have || "none"}); installing it under ${pretty(dir)}`)
    mkdirSync(dir, { recursive: true })
    const r = await $`curl -fsSL https://bun.sh/install | BUN_INSTALL=${dir} bash -s ${"bun-v" + want}`.nothrow().quiet()
    if (r.exitCode !== 0 || !existsSync(path.join(bin, "bun"))) fail(`could not install bun ${want}: ${r.stderr.toString().trim().split("\n").at(-1)}`)
  }
  return bin
}

// The compiler's front half: verifies every name, type and signature a mod
// relies on without producing a binary. Minutes instead of the full build.
async function typecheck(h: Harness, root: string) {
  const cmd = h.typecheck ?? fail(`${h.name} has no typecheck command in its harness definition`)
  const toolchain = await ensureToolchain(root)
  if (toolchain) buildEnv = { ...buildEnv, PATH: `${toolchain}${path.delimiter}${process.env.PATH ?? ""}` }
  log(`Installing dependencies: ${h.install}`)
  await shell(h.install, root)
  log(`Typechecking: ${cmd}`)
  await shell(cmd, root)
}

async function build(h: Harness, root: string) {
  const toolchain = await ensureToolchain(root)
  if (toolchain) buildEnv = { ...buildEnv, PATH: `${toolchain}${path.delimiter}${process.env.PATH ?? ""}` }
  log(`Installing dependencies: ${h.install}`)
  await shell(h.install, root)
  log(`Building: ${h.build}`)
  await shell(h.build, root)
  const artifact = artifactPath(h, root)
  if (!existsSync(artifact)) fail(`build finished but ${artifact} does not exist`)
  return artifact
}

// A harness's build script may wipe its output folder before compiling, so
// a build that fails would leave nothing to run. Each successful build is
// copied to its own folder and the launcher points there; the previous copy
// stays until the new one exists, then the rest are cleared out.
function keepBuild(h: Harness, harnessId: string, artifact: string, stamp: string) {
  const builds = path.join(HOME, "harnesses", harnessId, "builds")
  const name = stamp.replace(/[^A-Za-z0-9._+-]/g, "_")
  const dest = path.join(builds, name)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  cpSync(path.dirname(artifact), dest, { recursive: true })
  const kept = path.join(dest, path.basename(artifact))
  if (!existsSync(kept)) fail(`could not copy the build to ${dest}`)
  for (const d of readdirSync(builds)) if (d !== name) rmSync(path.join(builds, d), { recursive: true, force: true })
  return kept
}

// ------------------------------------------------------------- switching
//
// ~/.open-mods/bin sits first on PATH. A modded build is "on" when its
// symlink is in that folder and "off" when it is not; either way the stock
// binary the harness installed is untouched and takes over when we step aside.

const BIN = path.join(HOME, "bin")
const pretty = (p: string) => p.replace(homedir(), "~")

// The launcher is what `opencode` runs. It starts the modded binary at once
// and, at most once a day, refreshes the registry in the background. When a
// newer harness release is supported by every installed mod, the next launch
// asks whether to update. It never rebuilds without a yes.
function launcherOf(h: Harness, artifact: string) {
  const cli = Bun.which("open-mods") ?? `${process.execPath} ${path.resolve(import.meta.path)}`
  return `#!/bin/sh
# open-mods launcher for ${h.binary}. \`open-mods off\` removes it; the stock ${h.name} is untouched.
HARNESS=${h.id}
REAL=${JSON.stringify(artifact)}
OM=${JSON.stringify(HOME)}
CLI=${JSON.stringify(cli)}
NOTE="$OM/updates/$HARNESS"
NOW=$(date +%s)

# Refresh the note in the background once a day; never delays startup.
if [ -z "$OPEN_MODS_NO_CHECK" ]; then
  LAST=$(cat "$NOTE.checked" 2>/dev/null || echo 0)
  if [ $((NOW - LAST)) -gt 86400 ]; then
    mkdir -p "$OM/updates" && echo "$NOW" > "$NOTE.checked"
    ( $CLI check-updates "$HARNESS" >/dev/null 2>&1 & )
  fi
fi

# Ask only at an interactive terminal, and not more than once a day after a no.
if [ -t 0 ] && [ -t 1 ] && [ -z "$OPEN_MODS_NO_PROMPT" ] && [ -f "$NOTE" ]; then
  . "$NOTE"
  SNOOZED=$(cat "$NOTE.snooze" 2>/dev/null || echo 0)
  if [ -n "$AVAILABLE" ] && [ "$AVAILABLE" != "$CURRENT" ] && [ $((NOW - SNOOZED)) -gt 86400 ]; then
    if [ "$ALL_SUPPORT" = 1 ]; then
      printf '%s\n' "${h.name} $AVAILABLE is out and all your mods support it ($MODS). You are on $CURRENT."
      printf '%s' "Update now? It rebuilds ${h.name}, which takes a few minutes. [y/N] "
      read -r ANSWER
      case "$ANSWER" in
        y|Y|yes|YES)
          if $CLI update "$HARNESS"; then rm -f "$NOTE"; else
            printf '%s\n' "Update failed; starting your current build. Run \"open-mods update $HARNESS\" to try again."
          fi ;;
        *) echo "$NOW" > "$NOTE.snooze" ;;
      esac
    else
      printf '%s\n' "${h.name} $AVAILABLE is out. Not every mod supports it yet ($BLOCKED), so you stay on $CURRENT."
      echo "$NOW" > "$NOTE.snooze"
    fi
  fi
fi

exec "$REAL" "$@"
`
}

function switchOn(h: Harness, artifact: string) {
  mkdirSync(BIN, { recursive: true })
  const target = path.join(BIN, h.binary)
  if (existsSync(target)) unlinkSync(target)
  writeFileSync(target, launcherOf(h, artifact), { mode: 0o755 })
  return target
}

function switchOff(h: Harness) {
  const target = path.join(BIN, h.binary)
  if (existsSync(target)) unlinkSync(target)
}

function stockBinary(h: Harness): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter((d) => d && path.resolve(d) !== BIN)
  for (const d of dirs) {
    const candidate = path.join(d, h.binary)
    if (existsSync(candidate)) return candidate
  }
  return null
}

async function versionOf(bin: string | null) {
  if (!bin) return null
  const out = await $`${bin} --version`.nothrow().quiet()
  return out.exitCode === 0 ? out.stdout.toString().trim().split("\n")[0] ?? null : null
}

const pathHasBin = () => (process.env.PATH ?? "").split(path.delimiter).some((d) => d && path.resolve(d) === BIN)

// Adds ~/.open-mods/bin to the front of PATH in the user's shell config, once.
// Returns the file it edited, or null when PATH already had it or --no-path was given.
function setupPath(): string | null {
  if (pathHasBin() || has("no-path") || process.platform === "win32") return null
  const shell = path.basename(process.env.SHELL ?? "")
  const rc =
    shell === "zsh"
      ? path.join(homedir(), ".zshrc")
      : shell === "fish"
        ? path.join(homedir(), ".config", "fish", "config.fish")
        : path.join(homedir(), process.platform === "darwin" ? ".bash_profile" : ".bashrc")
  const line =
    shell === "fish"
      ? `fish_add_path --prepend --move ${pretty(BIN).replace("~", "$HOME")}  # open-mods`
      : `export PATH="${pretty(BIN).replace("~", "$HOME")}:$PATH"  # open-mods`
  const current = existsSync(rc) ? readFileSync(rc, "utf8") : ""
  if (current.includes("# open-mods")) return null
  mkdirSync(path.dirname(rc), { recursive: true })
  writeFileSync(rc, `${current}${current.endsWith("\n") || current === "" ? "" : "\n"}\n# open-mods: modded builds go first; \`open-mods off\` steps aside\n${line}\n`)
  return rc
}

function explainSwitch(h: Harness, entry: State[string]) {
  const stock = stockBinary(h)
  log("")
  if (entry.enabled) {
    const active = entry.mods.filter((m) => !entry.off.includes(m))
    log(`\`${h.binary}\` now runs ${h.name} ${rel(entry.ref)} + ${active.join(" + ")}${entry.off.length ? ` (off: ${entry.off.join(", ")})` : ""}.`)
    if (stock) log(`Your stock ${h.name} is untouched at ${pretty(stock)}. \`open-mods off\` switches back to it.`)
  } else {
    log(`\`${h.binary}\` runs your stock ${h.name} again${stock ? ` (${pretty(stock)})` : ""}. \`open-mods on\` brings the mods back.`)
  }
  const edited = entry.enabled ? setupPath() : null
  if (edited) {
    log("")
    log(`Added ${pretty(BIN)} to the front of PATH in ${pretty(edited)}.`)
    log(`Open a new terminal, or run this in the current one:`)
    log(`  export PATH="${pretty(BIN).replace("~", "$HOME")}:$PATH"`)
  } else if (entry.enabled && !pathHasBin()) {
    log("")
    log(`Note: ${pretty(BIN)} is not on PATH in this shell. Open a new terminal, or run:`)
    log(`  export PATH="${pretty(BIN).replace("~", "$HOME")}:$PATH"`)
  }
}

async function rebuild(reg: string, harnessId: string, all: Mod[], off: string[] = []) {
  const h = loadHarness(reg, harnessId)
  await checkRequirements(h)
  const root = path.join(HOME, "harnesses", harnessId, "src")
  const state = loadState()
  if (all.length === 0) {
    // Last mod gone: leave nothing of it behind. The link, the built binary
    // and the patched commits all go; the stock harness release is what the
    // checkout is left pointing at, kept only as a cache for the next install.
    switchOff(h)
    const prev = state[harnessId]
    if (existsSync(path.join(root, ".git"))) {
      await clearApplyState(root)
      if (prev?.commit) await $`git -C ${root} checkout -q --force --detach ${prev.commit}`.nothrow().quiet()
    }
    const dist = path.dirname(path.dirname(artifactPath(h, root)))
    if (existsSync(dist)) rmSync(dist, { recursive: true, force: true })
    rmSync(path.join(HOME, "harnesses", harnessId, "builds"), { recursive: true, force: true })
    delete state[harnessId]
    saveState(state)
    log(`Removed the modded ${h.name} build${prev ? ` (${rel(prev.ref)} + ${prev.mods.join(" + ")})` : ""}: its link, its binary and its patched commits are gone.`)
    log(`\`${h.binary}\` runs your stock ${h.name}. The ${h.name} source checkout stays at ${pretty(root)} as a cache; delete it if you want the space back.`)
    return
  }
  const mods = all.filter((m) => !off.includes(m.name))
  if (mods.length === 0) {
    switchOff(h)
    state[harnessId] = { ...(state[harnessId] ?? { ref: all[0]!.upstream.ref, commit: all[0]!.upstream.commit, artifact: "" }), mods: all.map((m) => m.name), off: [...off], hashes: {}, enabled: false }
    saveState(state)
    log(`Every ${h.name} mod is off (${off.join(", ")}), so \`${h.binary}\` runs your stock ${h.name}. \`open-mods on ${harnessId}/${off[0]}\` brings one back.`)
    return
  }
  const base = mods[0]!.upstream
  const strays = mods.filter((m) => m.upstream.commit !== base.commit)
  if (strays.length > 0) {
    log(
      `note: ${strays.map((m) => m.name).join(", ")} were authored against a different ${h.name} release than ${mods[0]!.name} (${rel(base.ref)}); trying anyway.`,
    )
  }
  await ensureCheckout(h, root, base.commit, base.ref)
  await applyMods(root, mods)
  buildEnv = {
    OPEN_MODS_HARNESS: harnessId,
    OPEN_MODS_REF: base.ref,
    OPEN_MODS_VERSION: base.ref.replace(/^[^0-9]*/, ""),
    OPEN_MODS_MODS: mods.map((m) => m.name).join("."),
  }
  const built = await build(h, root).catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)))
  const artifact = keepBuild(h, harnessId, built, `${rel(base.ref)}+${mods.map((m) => m.name).join(".")}`)
  switchOn(h, artifact)
  state[harnessId] = {
    ref: base.ref,
    commit: base.commit,
    mods: all.map((m) => m.name),
    off: off.filter((n) => all.some((m) => m.name === n)),
    hashes: Object.fromEntries(mods.map((m) => [m.name, patchHash(m)])),
    artifact,
    enabled: true,
  }
  saveState(state)
  explainSwitch(h, state[harnessId]!)
}

// ---------------------------------------------------------------- commands

async function cmdList() {
  const reg = await ensureRegistry()
  const mods = listMods(reg, positional[1])
  if (has("json")) return console.log(JSON.stringify(mods.map(({ dir, ...m }) => m), null, 2))
  if (mods.length === 0) return log("No mods found.")
  const installed = loadState()
  const w = Math.max(...mods.map((m) => `${m.harness}/${m.name}`.length))
  for (const m of mods) {
    const mark = installed[m.harness]?.mods.includes(m.name) ? "*" : " "
    log(`${mark} ${`${m.harness}/${m.name}`.padEnd(w)}  ${rel(m.upstream.ref).padEnd(9)} ${m.source === "local" ? "(local) " : ""}${m.description}`)
  }
  log("")
  log(`* = installed${mods.some((m) => m.source === "local") ? `   (local) = unpublished, from ${pretty(LOCAL)}` : ""}`)
}

async function cmdInfo() {
  const reg = await ensureRegistry()
  const spec = positional[1] ?? fail("usage: open-mods info <harness>/<mod>")
  const m = resolveMod(reg, spec)
  const files = touchedFiles(m)
  if (has("json")) return console.log(JSON.stringify({ ...m, dir: undefined, touches: files }, null, 2))
  log(`${m.harness}/${m.name} for ${m.harness} ${rel(m.upstream.ref)}`)
  log(`  ${m.description}`)
  if (m.author?.name) log(`  by ${m.author.name}${m.author.github ? ` (@${m.author.github})` : ""}`)
  log(`  license ${m.license}`)
  log(`  built against ${m.harness} ${rel(m.upstream.ref)} (tag ${m.upstream.ref}, ${m.upstream.commit.slice(0, 12)})`)
  if (m.tags?.length) log(`  tags ${m.tags.join(", ")}`)
  log(`  patches`)
  for (const p of m.patches) log(`    ${p}`)
  log(`  touches`)
  for (const f of files) log(`    ${f}`)
  log(`  ${m.source === "local" ? "local, unpublished" : "registry"}: ${pretty(m.dir)}`)
}

async function cmdInstall() {
  const reg = await ensureRegistry()
  const specs = positional.slice(1)
  if (specs.length === 0) fail("install needs a mod to install, e.g. open-mods install opencode/vim-keys. `open-mods list` shows what is available.")
  const wanted = specs.map((s) => resolveMod(reg, s))
  const harnessIds = new Set(wanted.map((m) => m.harness))
  const state = loadState()
  for (const id of harnessIds) {
    const current = (state[id]?.mods ?? []).map((n) => resolveMod(reg, `${id}/${n}`))
    const merged = [...current.filter((c) => !wanted.some((w) => w.name === c.name)), ...wanted.filter((w) => w.harness === id)]
    for (const m of merged) {
      const clash = merged.find((o) => o !== m && (m.conflicts?.includes(o.name) || o.conflicts?.includes(m.name)))
      if (clash) fail(`${m.name} and ${clash.name} are marked as conflicting`)
    }
    const off = (state[id]?.off ?? []).filter((n) => !wanted.some((w) => w.name === n))
    await rebuild(reg, id, merged, off)
  }
}

async function cmdUninstall() {
  const reg = await ensureRegistry()
  const specs = positional.slice(1)
  if (specs.length === 0) fail("uninstall needs a mod to remove, e.g. open-mods uninstall opencode/vim-keys. `open-mods status` shows what is installed.")
  const state = loadState()
  const byHarness = new Map<string, string[]>()
  for (const s of specs) {
    const m = resolveMod(reg, s)
    byHarness.set(m.harness, [...(byHarness.get(m.harness) ?? []), m.name])
  }
  for (const [id, names] of byHarness) {
    const installed = state[id]?.mods ?? []
    const missing = names.filter((n) => !installed.includes(n))
    if (missing.length) fail(`${missing.map((n) => `${id}/${n}`).join(", ")} ${missing.length === 1 ? "is" : "are"} not installed`)
    const remaining = installed.filter((n) => !names.includes(n)).map((n) => resolveMod(reg, `${id}/${n}`))
    await rebuild(reg, id, remaining, state[id]?.off ?? [])
  }
}

async function cmdStatus() {
  const reg = await ensureRegistry()
  const state = loadState()
  if (has("json")) return console.log(JSON.stringify(state, null, 2))
  const ids = Object.keys(state)
  if (ids.length === 0) {
    log("No mods installed. `open-mods list` shows what is available.")
    return
  }
  for (const id of ids) {
    const h = loadHarness(reg, id)
    const e = state[id]!
    const stock = stockBinary(h)
    e.artifact ||= artifactPath(h, path.join(HOME, "harnesses", id, "src"))
    const built = existsSync(e.artifact)
    const onPath = pathHasBin()
    const runs = e.enabled && built && onPath ? "modded" : "stock"
    log(`${h.binary} → ${runs}`)
    const active = e.mods.filter((m) => !e.off.includes(m))
    log(`  modded  ${h.name} ${rel(e.ref)} + ${active.join(" + ") || "(nothing)"}  ${e.enabled ? "on" : "off (open-mods on)"}${built || !active.length ? "" : "  [not built; run open-mods update]"}`)
    for (const m of e.off) log(`          ${m} is off (open-mods on ${id}/${m})`)
    log(`  stock   ${stock ? `${(await versionOf(stock)) ?? "?"}  ${pretty(stock)}` : "not found on PATH"}`)
    if (e.enabled && !onPath) log(`  note    ${pretty(BIN)} is not on PATH in this shell; open a new terminal or run: export PATH="${pretty(BIN).replace("~", "$HOME")}:$PATH"`)
  }
}

// `on`/`off` with no argument or a harness id switch the whole modded build
// (instant, no rebuild). With a mod name they build that one mod in or out.
function modTarget(reg: string, state: State, arg: string | undefined): { id: string; name: string } | null {
  if (!arg) return null
  if (arg.includes("/")) {
    const m = resolveMod(reg, arg)
    if (!state[m.harness]?.mods.includes(m.name)) fail(`${m.harness}/${m.name} is not installed`)
    return { id: m.harness, name: m.name }
  }
  if (state[arg]) return null
  const hits = Object.entries(state).filter(([, e]) => e.mods.includes(arg))
  if (hits.length === 1) return { id: hits[0]![0], name: arg }
  if (hits.length > 1) fail(`"${arg}" is installed for several harnesses; say ${hits.map(([id]) => `${id}/${arg}`).join(" or ")}`)
  return fail(`"${arg}" is neither an installed mod nor a harness; \`open-mods status\` lists both`)
}

async function cmdOn() {
  const reg = await ensureRegistry()
  const state = loadState()
  const target = modTarget(reg, state, positional[1])
  if (target) {
    const e = state[target.id]!
    if (!e.off.includes(target.name)) {
      log(`${target.id}/${target.name} is already on.`)
      return
    }
    log(`Building ${target.id}/${target.name} back in`)
    await rebuild(reg, target.id, e.mods.map((n) => resolveMod(reg, `${target.id}/${n}`)), e.off.filter((n) => n !== target.name))
    return
  }
  const ids = positional[1] ? [positional[1]] : Object.keys(state)
  if (ids.length === 0) fail("nothing to switch on; install a mod first")
  for (const id of ids) {
    const e = state[id] ?? fail(`no mods installed for ${id}`)
    const h = loadHarness(reg, id)
    if (e.mods.every((m) => e.off.includes(m))) fail(`every ${h.name} mod is off; \`open-mods on ${id}/${e.off[0]}\` builds one back in`)
    e.artifact ||= artifactPath(h, path.join(HOME, "harnesses", id, "src"))
    if (!existsSync(e.artifact)) fail(`the modded ${h.name} build is missing; run: open-mods update ${id}`)
    switchOn(h, e.artifact)
    e.enabled = true
    saveState(state)
    explainSwitch(h, e)
  }
}

async function cmdOff() {
  const reg = await ensureRegistry()
  const state = loadState()
  const target = modTarget(reg, state, positional[1])
  if (target) {
    const e = state[target.id]!
    if (e.off.includes(target.name)) {
      log(`${target.id}/${target.name} is already off.`)
      return
    }
    log(`Building ${target.id}/${target.name} out (it stays installed; \`open-mods on ${target.id}/${target.name}\` restores it)`)
    await rebuild(reg, target.id, e.mods.map((n) => resolveMod(reg, `${target.id}/${n}`)), [...e.off, target.name])
    return
  }
  const ids = positional[1] ? [positional[1]] : Object.keys(state)
  if (ids.length === 0) fail("nothing to switch off")
  for (const id of ids) {
    const e = state[id] ?? fail(`no mods installed for ${id}`)
    const h = loadHarness(reg, id)
    switchOff(h)
    e.enabled = false
    saveState(state)
    explainSwitch(h, e)
  }
}

async function cmdUpdate() {
  const reg = await refreshRegistry()
  const state = loadState()
  const ids = positional[1] ? [positional[1]] : Object.keys(state)
  for (const id of ids) {
    const e = state[id]
    const mods = (e?.mods ?? []).map((n) => resolveMod(reg, `${id}/${n}`))
    const active = mods.filter((m) => !e?.off.includes(m.name))
    const same =
      e &&
      existsSync(e.artifact) &&
      active.length > 0 &&
      active.every((m) => m.upstream.commit === e.commit && e.hashes[m.name] === patchHash(m))
    if (same && !has("force")) {
      log(`${loadHarness(reg, id).name} ${rel(e.ref)} + ${active.map((m) => m.name).join(" + ")} is already up to date.`)
      continue
    }
    await rebuild(reg, id, mods, e?.off ?? [])
  }
}

// Author command: turn commits on top of a harness release into a mod folder.
async function cmdPack() {
  const reg = await ensureRegistry()
  const checkout = path.resolve(positional[1] ?? ".")
  const name = flag("name") ?? fail("usage: open-mods pack <harness-checkout> --name <mod-name> [--local] [--harness <id>] [--base <tag>] [--out <dir>]")
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(name)) fail("mod name must be lowercase letters, digits and hyphens")
  if (!existsSync(path.join(checkout, ".git"))) fail(`${checkout} is not a git checkout`)

  const remote = (await $`git -C ${checkout} remote get-url origin`.nothrow().text()).trim()
  const harnesses = readdirSync(path.join(reg, "harnesses"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => loadHarness(reg, f.replace(/\.json$/, "")))
  const harness =
    (flag("harness") ? harnesses.find((h) => h.id === flag("harness")) : undefined) ??
    harnesses.find((h) => remote.replace(/\.git$/, "").endsWith(h.repo.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, ""))) ??
    fail(`cannot tell which harness ${checkout} is; pass --harness <id>`)

  const pattern = harness.releaseTagPattern ?? "*"
  const base = flag("base") ?? (await $`git -C ${checkout} describe --tags --abbrev=0 --match ${pattern} HEAD`.nothrow().text()).trim()
  if (!base) fail(`no release tag found below HEAD; pass --base <tag>`)
  const commit = (await $`git -C ${checkout} rev-parse ${base}^{commit}`.text()).trim()
  const count = Number((await $`git -C ${checkout} rev-list --count ${base}..HEAD`.text()).trim())
  if (count === 0) fail(`no commits on top of ${base}; commit your changes first`)

  const out = path.resolve(flag("out") ?? (has("local") ? path.join(LOCAL, harness.id, name) : path.join(reg, "mods", harness.id, name)))
  if (existsSync(out) && !has("force")) fail(`${out} already exists; pass --force to overwrite`)
  rmSync(path.join(out, "patches"), { recursive: true, force: true })
  mkdirSync(path.join(out, "patches"), { recursive: true })
  await $`git -C ${checkout} format-patch --no-signature --no-stat --zero-commit --full-index -N -o ${path.join(out, "patches")} ${base}..HEAD`.quiet()
  const patches = readdirSync(path.join(out, "patches"))
    .filter((f) => f.endsWith(".patch"))
    .sort()
    .map((f) => `patches/${f}`)

  const author = (await $`git -C ${checkout} log -1 --format=%an HEAD`.text()).trim()
  const existing = existsSync(path.join(out, "mod.json")) ? JSON.parse(readFileSync(path.join(out, "mod.json"), "utf8")) : {}
  const manifest = {
    $schema: path.relative(out, path.join(reg, "schema", "mod.schema.json")).replaceAll("\\", "/"),
    name,
    harness: harness.id,
    description: existing.description ?? "TODO: one line, under 200 characters",
    author: existing.author ?? { name: author },
    license: existing.license ?? "MIT",
    tags: existing.tags ?? [],
    upstream: { ref: base, commit },
    patches,
  }
  writeFileSync(path.join(out, "mod.json"), JSON.stringify(manifest, null, 2) + "\n")
  if (!existsSync(path.join(out, "README.md"))) {
    writeFileSync(
      path.join(out, "README.md"),
      `# ${name}\n\nTODO: what this mod changes in ${harness.name}, and why.\n\n## Install\n\n\`\`\`sh\nopen-mods install ${harness.id}/${name}\n\`\`\`\n`,
    )
  }
  log(`Packed ${count} commit${count === 1 ? "" : "s"} on top of ${rel(base)} into ${out}`)
  log(`  ${patches.join("\n  ")}`)
  // A lockfile in a patch is nearly always build noise, and two mods that
  // both carry one cannot stack. Say so; the author decides.
  const lockfiles = touchedFiles({ ...manifest, dir: out, source: "local" } as Mod).filter((f) => /(^|\/)(Cargo\.lock|bun\.lock|bun\.lockb|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum)$/.test(f))
  if (lockfiles.length) {
    log(`warning: the patches change ${lockfiles.join(", ")}. That is usually a build side effect, not part of the mod, and mods that both touch a lockfile cannot be installed together. Reset the file to the release and commit again unless the mod really needs it.`)
  }
  if (has("local")) log(`It is a local mod: \`open-mods install ${harness.id}/${name}\` works now, and nothing is published until you pack it into the registry and open a PR.`)
  else log(`Edit mod.json (description, tags, license) and README.md, then open a PR to the registry.`)
}

// Author and CI command: does a mod apply (and build) against a given ref?
async function cmdCheck() {
  const reg = await ensureRegistry()
  // `check --harness <id> --ref <tag> --build` builds the stock harness with no
  // mod: the smoke test for a harness definition, on any machine or in CI.
  const bare = flag("harness")
  const spec = positional[1] ?? (bare ? undefined : fail("usage: open-mods check <mod-dir | harness/mod> [--ref <tag>] [--typecheck | --build] [--json]\n       open-mods check --harness <id> [--ref <tag>] [--typecheck | --build] [--json]"))
  const mod: Mod = spec
    ? existsSync(path.join(spec, "mod.json"))
      ? loadMod(path.resolve(spec))
      : resolveMod(reg, spec)
    : {
        name: "(stock)",
        harness: bare!,
        description: "",
        license: "",
        upstream: { ref: flag("ref") ?? fail("--harness needs --ref <tag>"), commit: "" },
        patches: [],
        dir: "",
        source: "registry",
      }
  const h = loadHarness(reg, mod.harness)
  const ref = flag("ref") ?? mod.upstream.ref
  const root = flag("workspace") ? path.resolve(flag("workspace")!) : path.join(tmpdir(), `open-mods-check-${mod.harness}`)
  const result: Record<string, unknown> = { mod: `${mod.harness}/${mod.name}`, madeFor: mod.upstream.ref, ref, touches: touchedFiles(mod) }
  try {
    if (!existsSync(path.join(root, ".git"))) {
      mkdirSync(root, { recursive: true })
      await $`git clone --filter=blob:none --no-checkout --no-tags ${h.repo} ${root}`.quiet()
    }
    await $`git -C ${root} fetch --no-tags origin tag ${ref}`.quiet()
    await clearApplyState(root)
    await $`git -C ${root} checkout -q --force --detach ${ref}`
    result.commit = (await $`git -C ${root} rev-parse HEAD`.text()).trim()
    const files = mod.patches.map((p) => path.join(mod.dir, p))
    await fetchBases(root, mod)
    const am = files.length
      ? await $`git -C ${root} am -3 --quiet ${files}`.env({ ...process.env, ...GIT_IDENTITY }).nothrow().quiet()
      : { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    result.applies = am.exitCode === 0
    if (!result.applies) {
      result.error = (am.stderr.toString() + am.stdout.toString()).trim()
      await clearApplyState(root)
    } else if (has("build") || has("typecheck")) {
      await checkRequirements(h)
      // The stamp must be valid semver build metadata: mod names are, "(stock)" is not.
      buildEnv = { OPEN_MODS_HARNESS: h.id, OPEN_MODS_REF: ref, OPEN_MODS_VERSION: rel(ref), OPEN_MODS_MODS: mod.patches.length ? mod.name : "stock" }
      if (has("typecheck")) {
        try {
          await typecheck(h, root)
          result.typechecks = true
        } catch (e) {
          result.typechecks = false
          result.error = e instanceof Error ? e.message : String(e)
        }
      }
      if (has("build") && result.typechecks !== false) {
        try {
          result.artifact = await build(h, root)
          result.builds = true
        } catch (e) {
          result.builds = false
          result.error = e instanceof Error ? e.message : String(e)
        }
      }
    }
  } catch (e) {
    result.applies ??= false
    result.error = e instanceof Error ? e.message : String(e)
  }
  if (has("json")) console.log(JSON.stringify(result, null, 2))
  else {
    log(`${result.mod} (made for ${rel(String(result.madeFor))}) against ${rel(ref)} (${String(result.commit ?? "?").slice(0, 12)})`)
    log(`  applies:    ${result.applies ? "yes" : "NO"}`)
    if (has("typecheck")) log(`  typechecks: ${result.typechecks ? "yes" : "NO"}`)
    if (has("build")) log(`  builds:     ${result.builds ? "yes" : "NO"}`)
    if (result.error) log(`  ${String(result.error).split("\n").join("\n  ")}`)
  }
  if (result.applies !== true || (has("typecheck") && result.typechecks !== true) || (has("build") && result.builds !== true)) process.exit(1)
}

// Compare what is installed with what the registry now says, and leave a
// note for the launcher. Runs in the background from the launcher once a
// day; safe to run by hand.
const releaseKey = (ref: string) => ref.replace(/^[^0-9]*/, "").split(/[.+-]/).map((x) => Number(x) || 0)
const newerRelease = (a: string, b: string) => {
  const [x, y] = [releaseKey(a), releaseKey(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

async function cmdCheckUpdates() {
  const reg = await refreshRegistry()
  const state = loadState()
  const ids = positional[1] ? [positional[1]] : Object.keys(state)
  mkdirSync(path.join(HOME, "updates"), { recursive: true })
  for (const id of ids) {
    const e = state[id]
    const note = path.join(HOME, "updates", id)
    if (!e) {
      rmSync(note, { force: true })
      continue
    }
    const active = e.mods.filter((n) => !e.off.includes(n)).map((n) => resolveMod(reg, `${id}/${n}`))
    const refs = [...new Set(active.map((m) => m.upstream.ref))]
    const newest = refs.reduce((a, b) => (newerRelease(b, a) ? b : a), e.ref)
    const behind = active.filter((m) => m.upstream.ref !== newest)
    const changed = active.some((m) => m.upstream.commit !== e.commit || e.hashes[m.name] !== patchHash(m))
    // The launcher sources this file, so every value is single-quoted.
    const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`
    const lines = [
      `CURRENT=${q(rel(e.ref))}`,
      `AVAILABLE=${q(changed ? rel(newest) : "")}`,
      `ALL_SUPPORT=${behind.length === 0 ? 1 : 0}`,
      `MODS=${q(active.map((m) => m.name).join(", "))}`,
      `BLOCKED=${q(behind.map((m) => `${m.name} is for ${rel(m.upstream.ref)}`).join(", "))}`,
      `CHECKED=${Math.floor(Date.now() / 1000)}`,
    ]
    writeFileSync(note, lines.join("\n") + "\n")
    writeFileSync(`${note}.checked`, `${Math.floor(Date.now() / 1000)}\n`)
    if (has("json"))
      console.log(
        JSON.stringify({
          current: rel(e.ref),
          currentTag: e.ref,
          available: changed ? rel(newest) : "",
          availableTag: changed ? newest : "",
          allSupport: behind.length === 0,
          mods: active.map((m) => m.name),
          blocked: behind.map((m) => m.name),
        }),
      )
    else log(changed ? `${id}: ${rel(newest)} available${behind.length ? `, blocked by ${behind.map((m) => m.name).join(", ")}` : ", all mods support it"}` : `${id}: up to date (${rel(e.ref)})`)
  }
}

async function cmdRegistry() {
  log(`registry: ${registryDir()}`)
  log(`home:     ${HOME}`)
}

import { COMMANDS, ENVIRONMENT, FILES, GLOBAL_FLAGS, INTRO } from "./reference"

const wrap = (text: string, width = 78, indent = "") =>
  text
    .split(" ")
    .reduce<string[]>((lines, word) => {
      const last = lines[lines.length - 1]
      if (last !== undefined && (last + " " + word).length <= width) lines[lines.length - 1] = last + " " + word
      else lines.push(indent + word)
      return lines
    }, [])
    .join("\n")

// Two columns, wrapped to 100 characters: the term, then its description
// continued under itself.
function columns(rows: [string, string][]): string {
  const width = Math.min(Math.max(...rows.map(([term]) => term.length)) + 2, 52)
  return rows
    .map(([term, text]) => {
      const body = wrap(text, 100 - 2 - width).split("\n")
      const first = term.length + 2 > width ? `  ${term}\n${" ".repeat(2 + width)}${body[0]}` : `  ${term.padEnd(width)}${body[0]}`
      return [first, ...body.slice(1).map((l) => " ".repeat(2 + width) + l)].join("\n")
    })
    .join("\n")
}

function helpText(): string {
  const line = (c: (typeof COMMANDS)[number]) => c.short ?? c.usage.split("\n")[0]!
  const section = (title: string, list: typeof COMMANDS) => `${title}\n${columns(list.map((c) => [line(c), c.summary]))}`
  const flags = (list: typeof GLOBAL_FLAGS) => columns(list.map((f) => [f.flag, f.description]))
  return [
    wrap(`open-mods: ${INTRO}`),
    "",
    section("usage", COMMANDS.filter((c) => c.audience === "users")),
    "",
    section("for mod authors", COMMANDS.filter((c) => c.audience === "authors")),
    "",
    `options\n${flags(GLOBAL_FLAGS)}`,
    "",
    `environment\n${flags(ENVIRONMENT)}`,
    "",
    `files\n${flags(FILES)}`,
    "",
    "Full reference: https://openmods.dev/cli/",
    "",
  ].join("\n")
}

function commandHelp(name: string): string | null {
  const c = COMMANDS.find((c) => c.name === name || c.aliases?.includes(name))
  if (!c) return null
  const lines = [c.usage, "", c.summary, "", ...c.description.flatMap((d) => [wrap(d), ""])]
  if (c.aliases?.length) lines.push(`aliases: ${c.aliases.join(", ")}`, "")
  if (c.flags?.length) lines.push("options", columns(c.flags.map((f) => [f.flag, f.description])), "")
  if (c.examples?.length) lines.push("examples", ...c.examples.map((e) => `  ${e.command}${e.note ? `   # ${e.note}` : ""}`), "")
  return lines.join("\n")
}

const commands: Record<string, () => Promise<void>> = {
  list: cmdList,
  info: cmdInfo,
  install: cmdInstall,
  add: cmdInstall,
  uninstall: cmdUninstall,
  remove: cmdUninstall,
  rm: cmdUninstall,
  status: cmdStatus,
  installed: cmdStatus,
  on: cmdOn,
  off: cmdOff,
  update: cmdUpdate,
  pack: cmdPack,
  check: cmdCheck,
  registry: cmdRegistry,
  "check-updates": cmdCheckUpdates,
}

const cmd = positional[0]
if (cmd === "help" && positional[1]) {
  const text = commandHelp(positional[1])
  if (!text) fail(`unknown command "${positional[1]}"\n\n${helpText()}`)
  console.log(text)
} else if (!cmd || cmd === "help" || has("help")) {
  console.log(helpText())
} else if (commands[cmd]) {
  if (has("help")) console.log(commandHelp(cmd) ?? helpText())
  else await commands[cmd]!()
} else {
  fail(`unknown command "${cmd}"\n\n${helpText()}`)
}
