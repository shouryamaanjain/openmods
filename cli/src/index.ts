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
import { footprint, incompatibility as whyNot, type Footprint } from "./overlap"

type Harness = {
  id: string
  name: string
  repo: string
  binary: string
  homepage?: string
  // The harness's own installer, offered when a mod is installed for a
  // harness the user does not have; `paths` are the folders it installs the
  // binary into, so it is found before the shell's PATH picks them up.
  installer?: { command: string; paths?: string[] }
  requirements?: { command: string; hint: string }[]
  install: string
  typecheck?: string
  build: string
  artifact: string
  releaseTagPattern?: string
}

// A mod is `owner/name`, with one folder per harness it supports, and in it
// one version per harness release it has worked on:
//
//   mods/<owner>/<name>/mod.json                 shared: description, license, maintainers
//   mods/<owner>/<name>/<harness>/support.json   its versions, newest first
//   mods/<owner>/<name>/<harness>/<release tag>/0001-….patch
//
// A version is never replaced when the mod moves to a newer release, so mods
// that move at different speeds can still be built together at a release
// they all have.
type Version = { ref: string; commit: string; patches: string[] }

// This type is one mod on one harness at one version: the shared fields,
// that version's release and patches, and every version it has. Loading a
// mod gives its newest version; `at` gives another. `dir` is the harness
// folder (patch paths are relative to it), `root` the mod's folder.
type Mod = {
  owner: string
  name: string
  id: string
  harness: string
  description: string
  author?: { name?: string; github?: string; url?: string }
  maintainers?: string[]
  license: string
  tags?: string[]
  upstream: { ref: string; commit: string }
  patches: string[]
  versions: Version[]
  conflicts?: string[]
  dir: string
  root: string
  // "registry": published in the registry. "local": unpublished, from
  // ~/.open-mods/local/<owner>/<name>, where authors keep mods they are
  // still working on or do not want to publish.
  source: "registry" | "local"
}

// mods: every installed mod, in apply order. off: the subset built out for now.
type State = Record<string, { ref: string; commit: string; mods: string[]; off: string[]; hashes: Record<string, string>; artifact: string; enabled: boolean }>

const HOME = process.env.OPEN_MODS_HOME ?? path.join(homedir(), ".open-mods")
// A release as people see it: "1.18.31" for the tag v1.18.31, "0.155.1" for
// rust-v0.155.1. The tag itself stays raw in mod.json and in git commands.
const rel = (ref: string) => ref.replace(/^[^0-9]*/, "")
const releaseKey = (ref: string) => ref.replace(/^[^0-9]*/, "").split(/[.+-]/).map((x) => Number(x) || 0)
const newerRelease = (a: string, b: string) => {
  const [x, y] = [releaseKey(a), releaseKey(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}
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
// Flags that take a value. Every other --flag is a switch, including the
// harness flags (--opencode, --codex, ...), so `install --opencode owner/mod`
// never swallows the mod as the flag's value.
const VALUE_FLAGS = new Set(["registry", "name", "owner", "harness", "base", "out", "ref", "workspace", "at"])
const SWITCHES = new Set(["build", "force", "help", "json", "local", "no-path", "typecheck"])
for (let i = 0; i < args.length; i++) {
  const a = args[i]!
  if (a.startsWith("--")) {
    const [k, v] = a.slice(2).split("=", 2)
    if (v !== undefined) flags.set(k!, v)
    else if (VALUE_FLAGS.has(k!) && args[i + 1] !== undefined) flags.set(k!, args[++i]!)
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
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/

function readJsonFile(file: string) {
  return JSON.parse(readFileSync(file, "utf8"))
}

/** One mod on one harness, from its harness folder (the one with support.json). */
function loadMod(dir: string, source: Mod["source"] = path.resolve(dir).startsWith(LOCAL) ? "local" : "registry"): Mod {
  dir = path.resolve(dir)
  const supportFile = path.join(dir, "support.json")
  if (!existsSync(supportFile)) fail(`${pretty(dir)} has no support.json`)
  const root = path.dirname(dir)
  const metaFile = path.join(root, "mod.json")
  if (!existsSync(metaFile)) fail(`${pretty(root)} has no mod.json`)
  const meta = readJsonFile(metaFile)
  const support = readJsonFile(supportFile)
  const owner = meta.owner ?? path.basename(path.dirname(root))
  const name = meta.name ?? path.basename(root)
  const versions = ((support.versions ?? []) as Version[]).slice().sort((a, b) => (newerRelease(a.ref, b.ref) ? -1 : newerRelease(b.ref, a.ref) ? 1 : 0))
  if (versions.length === 0) fail(`${pretty(supportFile)} lists no versions`)
  const newest = versions[0]!
  return {
    ...meta,
    conflicts: support.conflicts,
    owner,
    name,
    id: `${owner}/${name}`,
    harness: path.basename(dir),
    upstream: { ref: newest.ref, commit: newest.commit },
    patches: newest.patches,
    versions,
    dir,
    root,
    source,
  }
}

/** The mod's version for a release, or undefined when it has none. */
function at(mod: Mod, ref: string): Mod | undefined {
  const v = mod.versions.find((x) => x.ref === ref)
  return v && { ...mod, upstream: { ref: v.ref, commit: v.commit }, patches: v.patches }
}

const newestFirst = (refs: string[]) => [...new Set(refs)].sort((a, b) => (newerRelease(a, b) ? -1 : newerRelease(b, a) ? 1 : 0))

/** Releases every one of these mods has a version for, newest first. */
function sharedReleases(mods: Mod[]): string[] {
  if (mods.length === 0) return []
  return newestFirst(mods[0]!.versions.map((v) => v.ref)).filter((ref) => mods.every((m) => m.versions.some((v) => v.ref === ref)))
}

/** "t/a is for 1.19.0, 1.18.31; t/b is for 1.18.0" */
const releasesSaid = (mods: Mod[]) => mods.map((m) => `${m.id} is for ${m.versions.map((v) => rel(v.ref)).join(", ")}`).join("; ")

function modsUnder(base: string, source: Mod["source"], harness?: string): Mod[] {
  const dirs = (p: string) => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [])
  return dirs(base).flatMap((owner) =>
    dirs(path.join(base, owner))
      .filter((name) => existsSync(path.join(base, owner, name, "mod.json")))
      .flatMap((name) =>
        dirs(path.join(base, owner, name))
          .filter((h) => (!harness || h === harness) && existsSync(path.join(base, owner, name, h, "support.json")))
          .map((h) => loadMod(path.join(base, owner, name, h), source)),
      ),
  )
}

// Registry mods first, then local ones; a local mod shadows a registry mod
// with the same id on the same harness, so an author can test a change
// before publishing.
function listMods(reg: string, harness?: string): Mod[] {
  const local = modsUnder(LOCAL, "local", harness)
  const published = modsUnder(path.join(reg, "mods"), "registry", harness).filter(
    (m) => !local.some((l) => l.harness === m.harness && l.id === m.id),
  )
  return [...published, ...local].sort((a, b) => a.id.localeCompare(b.id) || a.harness.localeCompare(b.harness))
}

function allHarnesses(reg: string): Harness[] {
  return readdirSync(path.join(reg, "harnesses"))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => loadHarness(reg, f.replace(/\.json$/, "")))
}

/** `owner/name`, checked. */
function parseId(reg: string, spec: string): string {
  const parts = spec.split("/")
  if (parts.length !== 2 || !ID.test(parts[0]!) || !ID.test(parts[1]!)) fail(`"${spec}" is not a mod name. Mods are written owner/mod, e.g. shouryamaanjain/tetris.`)
  return spec
}

/** Every harness a mod supports. */
function supportsOf(reg: string, spec: string): Mod[] {
  const id = parseId(reg, spec)
  const found = listMods(reg).filter((m) => m.id === id)
  if (found.length === 0) {
    // The old harness/mod form, e.g. opencode/tetris.
    const [first, name] = id.split("/")
    const h = allHarnesses(reg).find((x) => x.id === first)
    const owners = h ? [...new Set(listMods(reg).filter((m) => m.name === name).map((m) => m.owner))] : []
    if (h) fail(`no mod "${id}". Mods are named owner/mod, and the harness is a flag: ${owners.length ? `open-mods install ${owners[0]}/${name} --${h.id}` : `open-mods install <owner>/${name} --${h.id}`}.`)
    fail(`no mod "${id}". \`open-mods list\` shows what is available.`)
  }
  return found
}

/** One mod on one harness. */
function resolveMod(reg: string, spec: string, harness: string): Mod {
  const all = supportsOf(reg, spec)
  return all.find((x) => x.harness === harness) ?? fail(`${spec} does not support ${harness}. It supports: ${all.map((x) => x.harness).join(", ")}.`)
}

/** The harnesses named on the command line: --opencode, --codex, or --harness <id>. */
function harnessFlags(reg: string): string[] {
  const ids = allHarnesses(reg).map((h) => h.id)
  for (const [k, v] of flags)
    if (v === true && !SWITCHES.has(k) && !ids.includes(k)) fail(`unknown option --${k}. The harness flags are ${ids.map((i) => `--${i}`).join(", ")}.`)
  const picked = ids.filter((id) => flags.get(id) === true)
  const named = flag("harness")
  if (named) {
    if (!ids.includes(named)) fail(`unknown harness "${named}". Known: ${ids.join(", ")}.`)
    if (!picked.includes(named)) picked.push(named)
  }
  return picked
}

const interactive = () => !!process.stdin.isTTY && !!process.stdout.isTTY && !has("json")
const color = !process.env.NO_COLOR && !!process.stdout.isTTY
const paint = (code: string, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text)
const dim = (t: string) => paint("2", t)
const bold = (t: string) => paint("1", t)
const accent = (t: string) => paint("36", t)

/**
 * An arrow-key selector at the terminal. Returns the chosen index, or null
 * when there is no terminal to ask at. Esc, q or Ctrl-C cancels the command.
 */
async function select(question: string, options: { label: string; hint?: string }[]): Promise<number | null> {
  if (!interactive()) return null
  const width = Math.max(...options.map((o) => o.label.length))
  let index = 0
  const lines = () => [
    `${accent("?")} ${bold(question)}`,
    ...options.map((o, i) => `${i === index ? accent("❯") : " "} ${i === index ? accent(o.label.padEnd(width)) : o.label.padEnd(width)}  ${dim(o.hint ?? "")}`),
    dim("  ↑↓ move · enter select · esc cancel"),
  ]
  const out = process.stdout
  out.write("\x1b[?25l" + lines().join("\n") + "\n")
  const redraw = () => out.write(`\x1b[${options.length + 2}A\x1b[0J` + lines().join("\n") + "\n")
  process.stdin.setRawMode(true)
  process.stdin.resume()
  const chosen = await new Promise<number | null>((resolve) => {
    const onKey = (buf: Buffer) => {
      const k = buf.toString()
      if (k === "\x1b[A" || k === "k") index = (index + options.length - 1) % options.length
      else if (k === "\x1b[B" || k === "j") index = (index + 1) % options.length
      else if (k === "\r" || k === "\n") return done(index)
      else if (k === "\x1b" || k === "q" || k === "\x03") return done(null)
      else return
      redraw()
    }
    const done = (v: number | null) => {
      process.stdin.off("data", onKey)
      resolve(v)
    }
    process.stdin.on("data", onKey)
  })
  process.stdin.setRawMode(false)
  process.stdin.pause()
  out.write(`\x1b[${options.length + 2}A\x1b[0J\x1b[?25h`)
  if (chosen === null) {
    out.write(`${dim("✕")} ${question} ${dim("cancelled")}\n`)
    process.exit(130)
  }
  out.write(`${accent("✔")} ${question} ${bold(options[chosen]!.label)}\n`)
  return chosen
}

/**
 * A y/N question on the terminal. Anything but y or yes is no. Returns null
 * when there is no terminal to ask on (OPEN_MODS_ASSUME_TTY lets tests answer
 * through stdin).
 */
async function confirm(question: string): Promise<boolean | null> {
  const tty = (process.stdin.isTTY && process.stdout.isTTY) || !!process.env.OPEN_MODS_ASSUME_TTY
  if (!tty || has("json")) return null
  process.stdout.write(`${question} [y/N] `)
  process.stdin.resume()
  const answer = await new Promise<string>((resolve) => {
    process.stdin.once("data", (buf) => resolve(buf.toString().split("\n")[0] ?? ""))
    process.stdin.once("end", () => resolve(""))
  })
  process.stdin.pause()
  if (!process.stdin.isTTY) process.stdout.write("\n")
  return /^y(es)?$/i.test(answer.trim())
}

/** What the user has of a harness today, for the selector's hints. */
async function stockHint(h: Harness, state: State): Promise<string> {
  const e = state[h.id]
  if (e?.mods.length) return `you have ${rel(e.ref)}, modded`
  const stock = stockBinary(h)
  if (!stock) return "not installed"
  const v = await versionOf(stock)
  return v ? `you have ${v.replace(/^[^0-9]*/, "")}` : "installed"
}

/**
 * Which harness(es) to use for a mod: the ones named with --<harness>, else
 * the only one it supports, else ask with the selector, else explain how to
 * choose. `among` limits the choice, e.g. to harnesses it is installed on.
 * With `needHarness` (install), a harness the user does not have is marked in
 * the selector, and choosing it offers the harness's official installer.
 */
async function chooseHarnesses(reg: string, spec: string, verb: string, opts: { among?: string[]; needHarness?: boolean } = {}): Promise<Mod[]> {
  const { among, needHarness } = opts
  let options = supportsOf(reg, spec)
  if (among) options = options.filter((m) => among.includes(m.harness))
  if (options.length === 0) fail(`${spec} is not installed on any harness`)
  const state = loadState()
  const have = (m: Mod) => !needHarness || hasHarness(loadHarness(reg, m.harness), state)
  const picked = harnessFlags(reg)
  let chosen: Mod[]
  if (picked.length) {
    const missing = picked.filter((id) => !options.some((m) => m.harness === id))
    if (missing.length)
      fail(
        `${spec} ${among ? "is not installed on" : "does not support"} ${missing.map((id) => loadHarness(reg, id).name).join(", ")}. ${among ? "It is installed on" : "It supports"} ${options.map((m) => `${loadHarness(reg, m.harness).name} (--${m.harness})`).join(", ")}.`,
      )
    chosen = options.filter((m) => picked.includes(m.harness))
  } else if (options.length === 1) {
    chosen = options
    if (!have(options[0]!)) {
      const name = loadHarness(reg, options[0]!.harness).name
      log(`Notice: ${spec} only supports ${name}, and ${name} is not installed on this system.`)
    }
  } else {
    // Harnesses the user has come first.
    if (needHarness) options = [...options.filter(have), ...options.filter((m) => !have(m))]
    const hints = await Promise.all(
      options.map(async (m) => {
        const h = loadHarness(reg, m.harness)
        const e = state[m.harness]
        const clash = needHarness
          ? listMods(reg, m.harness).find((o) => o.id !== m.id && e?.mods.includes(o.id) && !e.off.includes(o.id) && clashBetween(m, o))
          : undefined
        const mine = e?.mods.includes(m.id)
          ? "already installed"
          : clash
            ? `does not work with your ${clash.id}`
            : have(m)
              ? await stockHint(h, state)
              : `not installed · picking it installs ${h.name} first`
        return { label: h.name, hint: `mod is for ${rel(m.upstream.ref)} · ${mine}` }
      }),
    )
    const i =
      (await select(`${verb} ${spec} for which harness?`, hints)) ??
      fail(
        `${spec} ${among ? "is installed on" : "supports"} ${options.map((m) => `${loadHarness(reg, m.harness).name}${have(m) ? "" : " (not installed here)"}`).join(", ")}; choose with ${options.map((m) => `--${m.harness}`).join(" or ")}`,
      )
    chosen = [options[i]!]
  }
  const noticed = !picked.length && options.length === 1
  for (const m of chosen) if (!have(m)) await installHarness(loadHarness(reg, m.harness), noticed)
  return chosen
}

/** The user has a harness: its stock binary, or a modded build of it. */
function hasHarness(h: Harness, state: State): boolean {
  return !!stockBinary(h) || !!state[h.id]?.mods.length
}

/**
 * Offers to install a harness the user does not have, with the command its
 * own project documents. No means nothing happens; without a terminal it
 * prints the command instead.
 */
async function installHarness(h: Harness, noticed = false) {
  const how = h.installer?.command ?? fail(`${h.name} is not installed on this system. Install it${h.homepage ? ` from ${h.homepage}` : ""}, then run this again.`)
  log(`${noticed ? "" : `${h.name} is not installed on this system. `}Its official installer is:`)
  log(`  ${how}`)
  const yes = await confirm(`Install ${h.name} now?`)
  if (yes === null) fail(`install ${h.name} with the command above, then run this again.`)
  if (!yes) {
    log("Nothing installed.")
    process.exit(0)
  }
  const code = await Bun.spawn(["sh", "-c", how], { stdio: ["inherit", "inherit", "inherit"] }).exited
  if (code !== 0) fail(`the ${h.name} installer failed (exit ${code}); nothing else was changed`)
  const stock = stockBinary(h) ?? fail(`the ${h.name} installer finished, but \`${h.binary}\` was not found. Open a new terminal and run this again.`)
  const v = await versionOf(stock)
  log(`${h.name}${v ? ` ${v.replace(/^[^0-9]*/, "")}` : ""} is installed at ${pretty(stock)}.`)
  log("")
}

// A mod's version is the harness release it supports (mod.upstream.ref), so
// a code change at the same release is noticed by hashing the patches.
function patchHash(mod: Mod): string {
  const hasher = new Bun.CryptoHasher("sha256")
  for (const p of mod.patches) hasher.update(readFileSync(path.join(mod.dir, p)))
  return hasher.digest("hex").slice(0, 16)
}

const footprints = new Map<string, Footprint>()
function footprintOf(mod: Mod): Footprint {
  const key = `${mod.dir}:${patchHash(mod)}`
  if (!footprints.has(key)) footprints.set(key, footprint(mod.patches.map((p) => readFileSync(path.join(mod.dir, p), "utf8"))))
  return footprints.get(key)!
}

/** Why two mods cannot be on together on one harness, or null (see overlap.ts). */
const incompatibility = (a: Mod, b: Mod) => whyNot(a, footprintOf(a), b, footprintOf(b))

/** Two mods compared at the newest release both have a version for. */
function clashBetween(a: Mod, b: Mod): string | null {
  const r = sharedReleases([a, b])[0]
  return r ? incompatibility(at(a, r)!, at(b, r)!) : incompatibility(a, b)
}

/** Every other mod on the same harness that `mod` cannot be on together with. */
function incompatibleWith(reg: string, mod: Mod): { mod: Mod; why: string }[] {
  return listMods(reg, mod.harness)
    .filter((o) => o.id !== mod.id)
    .flatMap((o) => {
      const why = clashBetween(mod, o)
      return why ? [{ mod: o, why }] : []
    })
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

// Makes `root` a blobless git checkout of the harness. The folder may
// already exist without a repository, for example when CI restores cached
// dependencies (node_modules, target/) into it before the check runs; git
// clone refuses a non-empty folder, so the repository is set up in place and
// whatever is already there is kept.
async function initCheckout(repo: string, root: string) {
  if (existsSync(path.join(root, ".git"))) return
  mkdirSync(root, { recursive: true })
  await $`git -C ${root} init -q`
  await $`git -C ${root} remote add origin ${repo}`
  await $`git -C ${root} config remote.origin.promisor true`
  await $`git -C ${root} config remote.origin.partialclonefilter blob:none`
}

async function ensureCheckout(h: Harness, root: string, commit: string, ref: string) {
  if (!existsSync(path.join(root, ".git"))) {
    log(`Setting up ${h.repo} (blobless, this is a one-time cost)`)
    await initCheckout(h.repo, root)
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
    log(`Applying ${mod.id} (${mod.patches.length} patch${mod.patches.length === 1 ? "" : "es"})`)
    const files = mod.patches.map((p) => path.join(mod.dir, p))
    await fetchBases(root, mod)
    const r = await $`git -C ${root} am -3 --quiet ${files}`.env({ ...process.env, ...GIT_IDENTITY }).nothrow()
    if (r.exitCode !== 0) {
      await clearApplyState(root)
      fail(`${mod.id} does not apply cleanly on ${mod.harness} ${rel(mod.upstream.ref)}. It probably conflicts with a mod applied before it.`)
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
SELF=${JSON.stringify(path.join(BIN, h.binary))}
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
# (OPEN_MODS_ASSUME_TTY=1 lets tests drive the prompt without a terminal.)
if { { [ -t 0 ] && [ -t 1 ]; } || [ -n "$OPEN_MODS_ASSUME_TTY" ]; } && [ -z "$OPEN_MODS_NO_PROMPT" ] && [ -f "$NOTE" ]; then
  . "$NOTE"
  SNOOZED=$(cat "$NOTE.snooze" 2>/dev/null || echo 0)
  if [ -n "$AVAILABLE" ] && [ "$AVAILABLE" != "$CURRENT" ] && [ $((NOW - SNOOZED)) -gt 86400 ]; then
    if [ "$ALL_SUPPORT" = 1 ]; then
      printf '%s\n' "${h.name} $AVAILABLE is out and all your mods support it ($MODS). You are on $CURRENT."
      printf '%s' "Update now? It rebuilds ${h.name}, which takes a few minutes. [y/N] "
      read -r ANSWER
      case "$ANSWER" in
        y|Y|yes|YES)
          # The update replaces this launcher and removes the old build, so
          # start again from the new launcher rather than the old path above.
          if $CLI update "$HARNESS"; then rm -f "$NOTE"; exec "$SELF" "$@"; else
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
  const dirs = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    // Where the official installer puts it, found even before a new shell
    // picks up the PATH line it added.
    ...(h.installer?.paths ?? []).map((p) => p.replace(/^~(?=\/|$)/, homedir())),
  ].filter((d) => d && path.resolve(d) !== BIN)
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

// Keeps ~/.open-mods/bin at the front of PATH in the user's shell config.
// Adds the line once. If a later line puts something in front of it, such as
// a harness installer that appended its own PATH line, the open-mods line
// moves back to the end so modded builds still go first. Returns the file it
// edited and whether it added or moved the line, or null when nothing changed.
function setupPath(): { rc: string; moved: boolean } | null {
  if (has("no-path") || process.platform === "win32") return null
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
  const block = `# open-mods: modded builds go first; \`open-mods off\` steps aside\n${line}\n`
  const current = existsSync(rc) ? readFileSync(rc, "utf8") : ""
  const lines = current.split("\n")
  const last = lines.findLastIndex((l) => l.includes("# open-mods"))
  if (last >= 0) {
    const later = lines.slice(last + 1).some((l) => !l.trim().startsWith("#") && /PATH|fish_add_path|shellenv/.test(l))
    if (!later) return null
    const kept = lines.filter((l) => !l.includes("# open-mods")).join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n")
    writeFileSync(rc, `${kept}\n${block}`)
    return { rc, moved: true }
  }
  if (pathHasBin()) return null
  mkdirSync(path.dirname(rc), { recursive: true })
  writeFileSync(rc, `${current}${current.endsWith("\n") || current === "" ? "" : "\n"}\n${block}`)
  return { rc, moved: false }
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
    log(
      edited.moved
        ? `Moved the open-mods line to the end of ${pretty(edited.rc)}, so ${pretty(BIN)} stays first on PATH after a line added later.`
        : `Added ${pretty(BIN)} to the front of PATH in ${pretty(edited.rc)}.`,
    )
    log(`Open a new terminal, or run this in the current one:`)
    log(`  export PATH="${pretty(BIN).replace("~", "$HOME")}:$PATH"`)
  } else if (entry.enabled && !pathHasBin()) {
    log("")
    log(`Note: ${pretty(BIN)} is not on PATH in this shell. Open a new terminal, or run:`)
    log(`  export PATH="${pretty(BIN).replace("~", "$HOME")}:$PATH"`)
  }
}

// `adding` names the mods this rebuild brings in (install, on), so a clash is
// reported as theirs and the advice points at the mods already there.
// The release is `target` when given (update), else the one the user is on
// if every mod has a version for it, else the newest release they all have.
// Nothing else moves the user to another release.
async function rebuild(reg: string, harnessId: string, all: Mod[], off: string[] = [], adding: string[] = [], target?: string) {
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
  const active = all.filter((m) => !off.includes(m.id))
  if (active.length === 0) {
    switchOff(h)
    state[harnessId] = { ...(state[harnessId] ?? { ref: all[0]!.upstream.ref, commit: all[0]!.upstream.commit, artifact: "" }), mods: all.map((m) => m.id), off: [...off], hashes: {}, enabled: false }
    saveState(state)
    log(`Every ${h.name} mod is off (${off.join(", ")}), so \`${h.binary}\` runs your stock ${h.name}. \`open-mods on ${off[0]} --${harnessId}\` brings one back.`)
    return
  }
  // One release for all of them, and each mod's version for it.
  const current = state[harnessId]?.ref
  const shared = sharedReleases(active)
  if (shared.length === 0)
    fail(`${active.map((m) => m.id).join(" and ")} have no ${h.name} release in common, so they cannot be built together: ${releasesSaid(active)}. Nothing was changed.`)
  const release = target
    ? shared.includes(target)
      ? target
      : fail(`not every mod has a version for ${h.name} ${rel(target)}: ${releasesSaid(active)}`)
    : current && shared.includes(current)
      ? current
      : shared[0]!
  if (current && release !== current && !target) {
    const lacking = active.filter((m) => !at(m, current))
    log(`note: building ${h.name} ${rel(release)}, not ${rel(current)}: ${lacking.map((m) => m.id).join(", ")} ${lacking.length === 1 ? "has" : "have"} no version for ${rel(current)}.`)
  }
  const mods = active.map((m) => at(m, release)!)
  // Refuse a combination that cannot work before anything is touched. The
  // mods being added go last, so each clash is reported against them.
  const order = [...mods.filter((m) => !adding.includes(m.id)), ...mods.filter((m) => adding.includes(m.id))]
  for (let j = 1; j < order.length; j++) {
    const clashes = order.slice(0, j).flatMap((o) => {
      const why = incompatibility(o, order[j]!)
      return why ? [{ id: o.id, why }] : []
    })
    if (clashes.length) {
      const ids = clashes.map((c) => c.id)
      fail(
        `${order[j]!.id} does not work with ${clashes.map((c) => `${c.id} on ${h.name}: ${c.why}`).join("; nor with ")}. They cannot be on at the same time, so nothing was changed. \`open-mods off ${ids.join(" ")}\` or \`open-mods uninstall ${ids.join(" ")}\` makes room.`,
      )
    }
  }
  const base = mods[0]!.upstream
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
    mods: all.map((m) => m.id),
    off: off.filter((n) => all.some((m) => m.id === n)),
    hashes: Object.fromEntries(mods.map((m) => [m.id, patchHash(m)])),
    artifact,
    enabled: true,
  }
  saveState(state)
  explainSwitch(h, state[harnessId]!)
}

// ---------------------------------------------------------------- commands

async function cmdList() {
  const reg = await ensureRegistry()
  const only = positional[1] ?? harnessFlags(reg)[0]
  const mods = listMods(reg, only)
  if (has("json")) return console.log(JSON.stringify(mods.map(({ dir, root, ...m }) => m), null, 2))
  if (mods.length === 0) return log(only ? `No mods for ${only}.` : "No mods found.")
  const installed = loadState()
  // One line per mod, with every harness it supports and the release it is for.
  const byId = new Map<string, Mod[]>()
  for (const m of mods) byId.set(m.id, [...(byId.get(m.id) ?? []), m])
  const w = Math.max(...[...byId.keys()].map((id) => id.length))
  for (const [id, variants] of [...byId].sort(([a], [b]) => a.localeCompare(b))) {
    const any = variants.some((m) => installed[m.harness]?.mods.includes(id))
    const where = variants
      .sort((a, b) => a.harness.localeCompare(b.harness))
      .map((m) => `${m.harness} ${rel(m.upstream.ref)}${installed[m.harness]?.mods.includes(id) ? "*" : ""}`)
      .join(" · ")
    const local = variants.some((m) => m.source === "local") ? "(local) " : ""
    log(`${any ? "*" : " "} ${id.padEnd(w)}  ${where}`)
    log(`  ${" ".repeat(w)}  ${dim(local + variants[0]!.description)}`)
  }
  log("")
  log(`* = installed${mods.some((m) => m.source === "local") ? `   (local) = unpublished, from ${pretty(LOCAL)}` : ""}`)
}

async function cmdInfo() {
  const reg = await ensureRegistry()
  const spec = positional[1] ?? fail("usage: open-mods info <owner>/<mod> [--<harness>]")
  const picked = harnessFlags(reg)
  const variants = supportsOf(reg, spec).filter((m) => !picked.length || picked.includes(m.harness))
  if (variants.length === 0) fail(`${spec} does not support ${picked.join(", ")}`)
  if (has("json")) return console.log(JSON.stringify(variants.map((m) => ({ ...m, dir: undefined, root: undefined, touches: touchedFiles(m) })), null, 2))
  const m0 = variants[0]!
  log(`${bold(m0.id)}`)
  log(`  ${m0.description}`)
  const who = m0.maintainers?.length ? m0.maintainers.map((x) => `@${x}`).join(", ") : m0.author?.name ? `${m0.author.name}${m0.author.github ? ` (@${m0.author.github})` : ""}` : ""
  if (who) log(`  by ${who}`)
  log(`  license ${m0.license}${m0.tags?.length ? `  ·  tags ${m0.tags.join(", ")}` : ""}`)
  log(`  ${m0.source === "local" ? "local, unpublished" : "registry"}: ${pretty(m0.root)}`)
  for (const m of variants) {
    const h = loadHarness(reg, m.harness)
    log("")
    log(`  ${bold(h.name)}  for ${rel(m.upstream.ref)} ${dim(`(tag ${m.upstream.ref}, ${m.upstream.commit.slice(0, 12)})`)}   install: open-mods install ${m.id} --${m.harness}`)
    if (m.versions.length > 1) log(`    versions   ${m.versions.map((v) => rel(v.ref)).join(", ")}  ${dim("(one per release; below is the newest)")}`)
    log(`    patches`)
    for (const p of m.patches) log(`      ${p}`)
    log(`    touches`)
    for (const f of touchedFiles(m)) log(`      ${f}`)
    const clashes = incompatibleWith(reg, m)
    if (clashes.length) {
      log(`    does not work with`)
      for (const c of clashes) log(`      ${c.mod.id}  ${dim(c.why)}`)
    }
  }
}

async function cmdInstall() {
  const reg = await ensureRegistry()
  const specs = positional.slice(1)
  if (specs.length === 0) fail("install needs a mod, e.g. open-mods install shouryamaanjain/tetris --opencode. `open-mods list` shows what is available.")
  const wanted: Mod[] = []
  for (const spec of specs) wanted.push(...(await chooseHarnesses(reg, spec, "Install", { needHarness: true })))
  const state = loadState()
  for (const id of new Set(wanted.map((m) => m.harness))) {
    const current = (state[id]?.mods ?? []).map((n) => resolveMod(reg, n, id))
    const here = wanted.filter((w) => w.harness === id)
    const merged = [...current.filter((c) => !here.some((w) => w.id === c.id)), ...here]
    const off = (state[id]?.off ?? []).filter((n) => !here.some((w) => w.id === n))
    await rebuild(reg, id, merged, off, here.map((m) => m.id))
  }
}

async function cmdUninstall() {
  const reg = await ensureRegistry()
  const specs = positional.slice(1)
  if (specs.length === 0) fail("uninstall needs a mod, e.g. open-mods uninstall shouryamaanjain/tetris. `open-mods status` shows what is installed.")
  const state = loadState()
  const byHarness = new Map<string, string[]>()
  for (const spec of specs) {
    const id = parseId(reg, spec)
    const on = Object.keys(state).filter((h) => state[h]!.mods.includes(id))
    if (on.length === 0) fail(`${id} is not installed`)
    for (const m of await chooseHarnesses(reg, id, "Uninstall", { among: on })) byHarness.set(m.harness, [...(byHarness.get(m.harness) ?? []), id])
  }
  for (const [id, names] of byHarness) {
    const remaining = state[id]!.mods.filter((n) => !names.includes(n)).map((n) => resolveMod(reg, n, id))
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
    for (const m of e.off) log(`          ${m} is off (open-mods on ${m} --${id})`)
    log(`  stock   ${stock ? `${(await versionOf(stock)) ?? "?"}  ${pretty(stock)}` : "not found on PATH"}`)
    if (e.enabled && !onPath) log(`  note    ${pretty(BIN)} is not on PATH in this shell; open a new terminal or run: export PATH="${pretty(BIN).replace("~", "$HOME")}:$PATH"`)
  }
}

// `on`/`off` with no argument or a harness id switch the whole modded build
// (instant, no rebuild). With a mod, owner/name, they build that mod in or out.
async function modTarget(reg: string, state: State, arg: string | undefined, verb: string): Promise<{ id: string; name: string } | null> {
  if (!arg || !arg.includes("/")) {
    if (arg && !state[arg]) fail(`"${arg}" is neither an installed mod nor a harness; \`open-mods status\` lists both`)
    return null
  }
  const id = parseId(reg, arg)
  const on = Object.keys(state).filter((h) => state[h]!.mods.includes(id))
  if (on.length === 0) fail(`${id} is not installed`)
  const [m] = await chooseHarnesses(reg, id, verb, { among: on })
  return { id: m!.harness, name: id }
}

async function cmdOn() {
  const reg = await ensureRegistry()
  const state = loadState()
  const target = await modTarget(reg, state, positional[1], "Switch on")
  if (target) {
    const e = state[target.id]!
    if (!e.off.includes(target.name)) {
      log(`${target.name} is already on for ${target.id}.`)
      return
    }
    log(`Building ${target.name} back into ${target.id}`)
    await rebuild(reg, target.id, e.mods.map((n) => resolveMod(reg, n, target.id)), e.off.filter((n) => n !== target.name), [target.name])
    return
  }
  const ids = positional[1] ? [positional[1]] : Object.keys(state)
  if (ids.length === 0) fail("nothing to switch on; install a mod first")
  for (const id of ids) {
    const e = state[id] ?? fail(`no mods installed for ${id}`)
    const h = loadHarness(reg, id)
    if (e.mods.every((m) => e.off.includes(m))) fail(`every ${h.name} mod is off; \`open-mods on ${e.off[0]} --${id}\` builds one back in`)
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
  const target = await modTarget(reg, state, positional[1], "Switch off")
  if (target) {
    const e = state[target.id]!
    if (e.off.includes(target.name)) {
      log(`${target.name} is already off for ${target.id}.`)
      return
    }
    log(`Building ${target.name} out of ${target.id} (it stays installed; \`open-mods on ${target.name} --${target.id}\` restores it)`)
    await rebuild(reg, target.id, e.mods.map((n) => resolveMod(reg, n, target.id)), [...e.off, target.name])
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
    const mods = (e?.mods ?? []).map((n) => resolveMod(reg, n, id))
    const active = mods.filter((m) => !e?.off.includes(m.id))
    // The newest release every mod that is on has a version for.
    const target = sharedReleases(active)[0]
    const same =
      e &&
      existsSync(e.artifact) &&
      active.length > 0 &&
      target === e.ref &&
      active.every((m) => e.hashes[m.id] === patchHash(at(m, e.ref)!))
    if (same && !has("force")) {
      log(`${loadHarness(reg, id).name} ${rel(e.ref)} + ${active.map((m) => m.id).join(" + ")} is already up to date.`)
      continue
    }
    await rebuild(reg, id, mods, e?.off ?? [], [], target)
  }
}

// Author command: turn commits on top of a harness release into a mod folder.
async function cmdPack() {
  const reg = await ensureRegistry()
  const checkout = path.resolve(positional[1] ?? ".")
  const name = flag("name") ?? fail("usage: open-mods pack <harness-checkout> --name <mod> [--owner <you>] [--local] [--harness <id>] [--base <tag>] [--out <dir>] [--force]")
  if (!ID.test(name)) fail("mod name must be lowercase letters, digits and hyphens")
  if (!existsSync(path.join(checkout, ".git"))) fail(`${checkout} is not a git checkout`)

  const remote = (await $`git -C ${checkout} remote get-url origin`.nothrow().text()).trim()
  const harnesses = allHarnesses(reg)
  const harness =
    (flag("harness") ? harnesses.find((h) => h.id === flag("harness")) : undefined) ??
    harnesses.find((h) => flags.get(h.id) === true) ??
    harnesses.find((h) => remote.replace(/\.git$/, "").endsWith(h.repo.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, ""))) ??
    fail(`cannot tell which harness ${checkout} is; pass --harness <id>`)

  // The owner is the author's GitHub handle: --owner, else git's github.user,
  // else the GitHub CLI's login.
  const detected =
    (await $`git config --get github.user`.nothrow().quiet().text()).trim() ||
    (await $`gh api user --jq .login`.nothrow().quiet().text()).trim().toLowerCase()
  const owner = flag("owner") ?? (detected || fail("cannot tell who owns this mod; pass --owner <your GitHub handle>"))
  if (!ID.test(owner)) fail(`owner "${owner}" must be lowercase letters, digits and hyphens`)

  const pattern = harness.releaseTagPattern ?? "*"
  const base = flag("base") ?? (await $`git -C ${checkout} describe --tags --abbrev=0 --match ${pattern} HEAD`.nothrow().text()).trim()
  if (!base) fail(`no release tag found below HEAD; pass --base <tag>`)
  const commit = (await $`git -C ${checkout} rev-parse ${base}^{commit}`.text()).trim()
  const count = Number((await $`git -C ${checkout} rev-list --count ${base}..HEAD`.text()).trim())
  if (count === 0) fail(`no commits on top of ${base}; commit your changes first`)

  const root = path.resolve(flag("out") ?? path.join(has("local") ? LOCAL : path.join(reg, "mods"), owner, name))
  const out = path.join(root, harness.id)
  // Each release gets its own version, in a folder named after its tag. Other
  // versions stay: users building with mods that are still on those releases
  // need them.
  const supportFile = path.join(out, "support.json")
  const prevSupport = existsSync(supportFile) ? readJsonFile(supportFile) : {}
  const prevVersions: Version[] = prevSupport.versions ?? []
  if (prevVersions.some((v) => v.ref === base) && !has("force"))
    fail(`${owner}/${name} already has a version for ${harness.name} ${rel(base)}; pass --force to replace it`)
  const folder = path.join(out, base)
  rmSync(folder, { recursive: true, force: true })
  mkdirSync(folder, { recursive: true })
  await $`git -C ${checkout} format-patch --no-signature --no-stat --zero-commit --full-index -N -o ${folder} ${base}..HEAD`.quiet()
  const patches = readdirSync(folder)
    .filter((f) => f.endsWith(".patch"))
    .sort()
    .map((f) => `${base}/${f}`)
  const versions = [{ ref: base, commit, patches }, ...prevVersions.filter((v) => v.ref !== base)].sort((a, b) =>
    newerRelease(a.ref, b.ref) ? -1 : newerRelease(b.ref, a.ref) ? 1 : 0,
  )

  // mod.json is shared by every harness the mod supports: create it once,
  // keep what the author filled in.
  const author = (await $`git -C ${checkout} log -1 --format=%an HEAD`.text()).trim()
  const metaFile = path.join(root, "mod.json")
  const existing = existsSync(metaFile) ? readJsonFile(metaFile) : {}
  const meta = {
    $schema: path.relative(root, path.join(reg, "schema", "mod.schema.json")).replaceAll("\\", "/"),
    owner,
    name,
    description: existing.description ?? "TODO: one line, under 200 characters",
    author: existing.author ?? { name: author, github: owner },
    maintainers: existing.maintainers ?? [owner],
    license: existing.license ?? "MIT",
    tags: existing.tags ?? [],
  }
  writeFileSync(metaFile, JSON.stringify(meta, null, 2) + "\n")
  const support = {
    $schema: path.relative(out, path.join(reg, "schema", "support.schema.json")).replaceAll("\\", "/"),
    versions,
    ...(prevSupport.conflicts ? { conflicts: prevSupport.conflicts } : {}),
  }
  writeFileSync(supportFile, JSON.stringify(support, null, 2) + "\n")
  if (!existsSync(path.join(root, "README.md"))) {
    writeFileSync(
      path.join(root, "README.md"),
      `# ${name}\n\nTODO: what this mod changes, and why.\n\n## Install\n\n\`\`\`sh\nopen-mods install ${owner}/${name}\n\`\`\`\n`,
    )
  }
  log(`Packed ${count} commit${count === 1 ? "" : "s"} on top of ${harness.name} ${rel(base)} as ${owner}/${name}, in ${pretty(out)}`)
  log(`  ${patches.join("\n  ")}`)
  const others = versions.filter((v) => v.ref !== base)
  if (others.length) log(`It keeps its versions for ${others.map((v) => rel(v.ref)).join(", ")}.`)
  // A lockfile in a patch is nearly always build noise, and two mods that
  // both carry one cannot stack. Say so; the author decides.
  const lockfiles = touchedFiles(at(loadMod(out, has("local") ? "local" : "registry"), base)!).filter((f) => /(^|\/)(Cargo\.lock|bun\.lock|bun\.lockb|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum)$/.test(f))
  if (lockfiles.length) {
    log(`warning: the patches change ${lockfiles.join(", ")}. That is usually a build side effect, not part of the mod, and mods that both touch a lockfile cannot be installed together. Reset the file to the release and commit again unless the mod really needs it.`)
  }
  if (has("local")) log(`It is a local mod: \`open-mods install ${owner}/${name} --${harness.id}\` works now, and nothing is published until you pack it into the registry and open a PR.`)
  else log(`Edit mod.json (description, tags, license) and README.md, then open a PR to the registry.`)
}

// Author and CI command: does a mod apply (and build) against a given ref?
async function cmdCheck() {
  const reg = await ensureRegistry()
  // `check --harness <id> --ref <tag> --build` with no mod builds the stock
  // harness: the smoke test for a harness definition, on any machine or in CI.
  // A mod is its harness folder (mods/<owner>/<name>/<harness>), or owner/name
  // with --<harness>.
  const bare = harnessFlags(reg)
  const spec = positional[1] ?? (bare.length ? undefined : fail("usage: open-mods check <mod-folder | owner/mod --<harness>> [--ref <tag>] [--typecheck | --build] [--json]\n       open-mods check --harness <id> --ref <tag> [--typecheck | --build] [--json]"))
  const found = spec ? (existsSync(path.join(spec, "support.json")) ? loadMod(spec) : (await chooseHarnesses(reg, spec, "Check"))[0]!) : undefined
  // The newest version, or the one for the release --at names.
  const mod: Mod = found
    ? flag("at")
      ? (at(found, flag("at")!) ?? fail(`${found.id} has no version for ${flag("at")} on ${found.harness}; it has ${found.versions.map((v) => v.ref).join(", ")}`))
      : found
    : {
        owner: "",
        name: "(stock)",
        id: "(stock)",
        harness: bare[0]!,
        description: "",
        license: "",
        upstream: { ref: flag("ref") ?? fail("--harness needs --ref <tag>"), commit: "" },
        patches: [],
        versions: [],
        dir: "",
        root: "",
        source: "registry",
      }
  const h = loadHarness(reg, mod.harness)
  const ref = flag("ref") ?? mod.upstream.ref
  const root = flag("workspace") ? path.resolve(flag("workspace")!) : path.join(tmpdir(), `open-mods-check-${mod.harness}`)
  // A stock check (--harness, no mod) says so, so the release watch can tell
  // a harness build from a mod check.
  const result: Record<string, unknown> = spec
    ? { mod: mod.id, harness: mod.harness, madeFor: mod.upstream.ref, ref, touches: touchedFiles(mod) }
    : { harness: mod.harness, stock: true, ref }
  try {
    await initCheckout(h.repo, root)
    await $`git -C ${root} fetch --no-tags --filter=blob:none origin tag ${ref}`.quiet()
    await clearApplyState(root)
    await $`git -C ${root} checkout -q --force --detach ${ref}`
    result.commit = (await $`git -C ${root} rev-parse HEAD`.text()).trim()
    const files = mod.patches.map((p) => path.join(mod.dir, p))
    await fetchBases(root, mod)
    const am = files.length
      ? await $`git -C ${root} am -3 --quiet ${files}`.env({ ...process.env, ...GIT_IDENTITY }).nothrow().quiet()
      : { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    result.applies = am.exitCode === 0
    // The mod's patches as they apply to this release. The release watch saves
    // them when it bumps the mod, so a mod's patches always match the release
    // it claims, and the next release is compared against this one.
    if (result.applies && files.length) {
      const dir = path.join(tmpdir(), `open-mods-rebase-${process.pid}`)
      rmSync(dir, { recursive: true, force: true })
      await $`git -C ${root} format-patch --no-signature --no-stat --zero-commit --full-index -N -o ${dir} ${result.commit as string}..HEAD`.quiet()
      result.patches = readdirSync(dir)
        .filter((f) => f.endsWith(".patch"))
        .sort()
        .map((f) => ({ name: f, text: readFileSync(path.join(dir, f), "utf8") }))
      rmSync(dir, { recursive: true, force: true })
    }
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
    log(result.stock ? `stock ${mod.harness} at ${rel(ref)} (${String(result.commit ?? "?").slice(0, 12)})` : `${result.mod} (made for ${rel(String(result.madeFor))}) against ${rel(ref)} (${String(result.commit ?? "?").slice(0, 12)})`)
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
    const active = e.mods.filter((n) => !e.off.includes(n)).map((n) => resolveMod(reg, n, id))
    // The newest release every mod has a version for is what update builds.
    // If some mod has an even newer one, the mods without it block that.
    const shared = sharedReleases(active)[0] ?? e.ref
    const latest = newestFirst([e.ref, ...active.flatMap((m) => m.versions.map((v) => v.ref))])[0]!
    const newer = newerRelease(shared, e.ref) ? shared : ""
    const newest = newer || (newerRelease(latest, e.ref) ? latest : shared)
    const behind = newer ? [] : active.filter((m) => !at(m, newest))
    const changed = newest !== e.ref || active.some((m) => e.hashes[m.id] !== patchHash(at(m, e.ref) ?? m))
    // The launcher sources this file, so every value is single-quoted.
    const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`
    const lines = [
      `CURRENT=${q(rel(e.ref))}`,
      `AVAILABLE=${q(changed ? rel(newest) : "")}`,
      `ALL_SUPPORT=${behind.length === 0 ? 1 : 0}`,
      `MODS=${q(active.map((m) => m.id).join(", "))}`,
      `BLOCKED=${q(behind.map((m) => `${m.id} is for ${rel(m.upstream.ref)}`).join(", "))}`,
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
          mods: active.map((m) => m.id),
          blocked: behind.map((m) => m.id),
        }),
      )
    else log(changed ? `${id}: ${rel(newest)} available${behind.length ? `, blocked by ${behind.map((m) => m.id).join(", ")}` : ", all mods support it"}` : `${id}: up to date (${rel(e.ref)})`)
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
