#!/usr/bin/env bun
// openmods: install source-level mods into open-source agent harnesses.
//
// A mod is an ordered series of git patches against a pinned upstream commit.
// Installing one clones the harness, checks out that commit, applies the
// patches, builds, and links the resulting binary under ~/.openmods/bin.
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
  // Runs a clone from source, for `openmods dev`; see schema/harness.schema.json.
  dev?: string
  // Set for the modded build (and a dev clone) when it starts, such as turning
  // off the harness's own self-update: OpenMods offers updates for it.
  env?: Record<string, string>
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
//
// Each version also says which update of the mod's code it holds: a number
// pack assigns, one higher each time the code changes, never typed by the
// author. Moving to a new release keeps the number, since the code is the
// same. `note` is the author's one line on what the update changed.
type Version = { ref: string; commit: string; patches: string[]; update: number; note?: string }

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
  update: number
  note?: string
  versions: Version[]
  conflicts?: string[]
  dir: string
  root: string
  // "registry": published in the registry. "local": unpublished, from
  // ~/.openmods/local/<owner>/<name>, where authors keep mods they are
  // still working on or do not want to publish.
  source: "registry" | "local"
  // The OpenMods base patch (see BASE_ID) is the only internal mod.
  internal?: boolean
}

// mods: every installed mod, in apply order. off: the subset built out for now.
// updates: which update of each mod the build holds.
type State = Record<string, { ref: string; commit: string; mods: string[]; off: string[]; hashes: Record<string, string>; updates: Record<string, number>; artifact: string; enabled: boolean }>

const HOME = process.env.OPENMODS_HOME ?? path.join(homedir(), ".openmods")
// A release as people see it: "1.18.31" for the tag v1.18.31, "0.155.1" for
// rust-v0.155.1. The tag itself stays raw in mod.json and in git commands.
const rel = (ref: string) => ref.replace(/^[^0-9]*/, "")
const releaseKey = (ref: string) => ref.replace(/^[^0-9]*/, "").split(/[.+-]/).map((x) => Number(x) || 0)
const newerRelease = (a: string, b: string) => {
  const [x, y] = [releaseKey(a), releaseKey(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}
const DEFAULT_REGISTRY = "https://github.com/shouryamaanjain/openmods"
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "openmods",
  GIT_AUTHOR_EMAIL: "openmods@localhost",
  GIT_COMMITTER_NAME: "openmods",
  GIT_COMMITTER_EMAIL: "openmods@localhost",
}

const args = process.argv.slice(2)
const flags = new Map<string, string | true>()
const positional: string[] = []
// Flags that take a value. Every other --flag is a switch, including the
// harness flags (--opencode, --codex, ...), so `install --opencode owner/mod`
// never swallows the mod as the flag's value.
const VALUE_FLAGS = new Set(["registry", "name", "owner", "harness", "base", "out", "ref", "workspace", "at", "note"])
const SWITCHES = new Set(["build", "force", "help", "json", "local", "no-path", "typecheck", "stop"])
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
  const explicit = flag("registry") ?? process.env.OPENMODS_REGISTRY
  if (explicit && existsSync(path.join(explicit, "mods"))) return path.resolve(explicit)
  const local = path.resolve(import.meta.dir, "..", "..")
  if (existsSync(path.join(local, "mods")) && existsSync(path.join(local, "harnesses"))) return local
  return path.join(HOME, "registry")
}

async function ensureRegistry(): Promise<string> {
  const dir = registryDir()
  if (existsSync(path.join(dir, "mods"))) return dir
  const url = flag("registry") ?? process.env.OPENMODS_REGISTRY ?? DEFAULT_REGISTRY
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
  const versions = ((support.versions ?? []) as Version[]).map((v) => ({ ...v, update: v.update ?? 1 })).sort((a, b) => (newerRelease(a.ref, b.ref) ? -1 : newerRelease(b.ref, a.ref) ? 1 : 0))
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
    update: newest.update,
    note: newest.note,
    versions,
    dir,
    root,
    source,
  }
}

/** The mod's version for a release, or undefined when it has none. */
function at(mod: Mod, ref: string): Mod | undefined {
  const v = mod.versions.find((x) => x.ref === ref)
  return v && { ...mod, upstream: { ref: v.ref, commit: v.commit }, patches: v.patches, update: v.update, note: v.note }
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

// OpenMods' own patch, applied first in every modded build. It keeps a
// modded harness from sending its users to the upstream project for problems
// the upstream project did not cause: crash reports, feedback uploads and the
// agent's "report issues at" line point to OpenMods instead. It lives in the
// registry as an internal mod, so it gets versions, overlap checks and the
// release watch like any mod, but users never list, install or remove it.
const BASE_ID = "openmods/base"
const baseFor = (reg: string, harness: string) => listMods(reg, harness).find((m) => m.id === BASE_ID)
const shown = (id: string) => (id === BASE_ID ? "the OpenMods base patch" : id)

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
  const found = listMods(reg).filter((m) => m.id === id && !m.internal)
  if (found.length === 0) {
    // The old harness/mod form, e.g. opencode/tetris.
    const [first, name] = id.split("/")
    const h = allHarnesses(reg).find((x) => x.id === first)
    const owners = h ? [...new Set(listMods(reg).filter((m) => m.name === name).map((m) => m.owner))] : []
    if (h) fail(`no mod "${id}". Mods are named owner/mod, and the harness is a flag: ${owners.length ? `openmods install ${owners[0]}/${name} --${h.id}` : `openmods install <owner>/${name} --${h.id}`}.`)
    fail(`no mod "${id}". \`openmods list\` shows what is available.`)
  }
  return found
}

/** One mod on one harness. */
function resolveMod(reg: string, spec: string, harness: string): Mod {
  const all = supportsOf(reg, spec)
  return all.find((x) => x.harness === harness) ?? fail(`${spec} does not support ${harness}. It supports: ${all.map((x) => x.harness).join(", ")}.`)
}

/** One installed mod on one harness, or undefined when the registry no longer has it. */
const findMod = (reg: string, id: string, harness: string) => listMods(reg, harness).find((m) => m.id === id && !m.internal)

// revoked.json in the registry: mods, or some of their updates, removed for
// doing harm. They are never built, and a build that has one stops running
// it: the launcher warns and starts the stock harness instead.
type Revocation = { id: string; updates?: number[]; reason: string }
function revocations(reg: string): Revocation[] {
  const file = path.join(reg, "revoked.json")
  return existsSync(file) ? ((readJsonFile(file).revoked ?? []) as Revocation[]) : []
}
const revocationOf = (reg: string, id: string, update: number | undefined) =>
  revocations(reg).find((r) => r.id === id && (!r.updates || update === undefined || r.updates.includes(update)))

/**
 * The mods built into a harness's current build that are revoked. Installs
 * from before update numbers were recorded have theirs worked out from the
 * patches, when the registry still has the version they were built from; if
 * it cannot be known, an update-specific revocation counts, to be safe.
 */
function revokedIn(reg: string, harness: string, e: State[string]) {
  return e.mods.filter((id) => !e.off.includes(id)).flatMap((id) => {
    let update = e.updates[id]
    if (update === undefined) {
      const v = (() => {
        const m = findMod(reg, id, harness)
        return m && at(m, e.ref)
      })()
      if (v && patchHash(v) === e.hashes[id]) update = v.update
    }
    const r = revocationOf(reg, id, update)
    return r ? [{ id, reason: r.reason }] : []
  })
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
 * when there is no terminal to ask on (OPENMODS_ASSUME_TTY lets tests answer
 * through stdin).
 */
async function confirm(question: string): Promise<boolean | null> {
  const tty = (process.stdin.isTTY && process.stdout.isTTY) || !!process.env.OPENMODS_ASSUME_TTY
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

// What a set of patches changes, without line numbers or context: two sets
// with the same code rebased onto different releases compare equal.
function codeOf(texts: string[]): string {
  return texts
    .flatMap((t) => t.split("\n").filter((l) => /^[-+]/.test(l) && !/^(\+\+\+|---)( |$)/.test(l)))
    .join("\n")
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
        updates: e.updates ?? {},
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
  // Checked by the tag, not the commit: asking a blobless checkout about an
  // object it lacks makes git download it, with all the history behind it.
  const tagged = await $`git -C ${root} rev-parse -q --verify ${`refs/tags/${ref}^{commit}`}`.nothrow().quiet()
  if (tagged.exitCode !== 0) {
    log(`Fetching ${ref}`)
    await $`git -C ${root} fetch --no-tags --depth 1 origin tag ${ref}`.quiet()
  } else if (tagged.stdout.toString().trim() !== commit) {
    // The registry pins a different commit than the tag we have.
    log(`Fetching ${commit.slice(0, 12)}`)
    await $`git -C ${root} fetch --no-tags --depth 1 origin ${commit}`.quiet()
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
  // Usually the release being built, found by its tag. Otherwise it is
  // fetched on its own: looking the commit up would download it with all
  // its history (see ensureCheckout).
  const tagged = await $`git -C ${root} rev-parse -q --verify ${`refs/tags/${mod.upstream.ref}^{commit}`}`.nothrow().quiet()
  if (tagged.stdout.toString().trim() !== mod.upstream.commit) await $`git -C ${root} fetch --no-tags --depth 1 --filter=blob:none origin ${mod.upstream.commit}`.nothrow().quiet()
  for (const file of touchedFiles(mod)) await $`git -C ${root} cat-file -p ${mod.upstream.commit + ":" + file}`.nothrow().quiet()
}

async function applyMods(root: string, mods: Mod[]) {
  for (const mod of mods) {
    log(`Applying ${shown(mod.id)} (${mod.patches.length} patch${mod.patches.length === 1 ? "" : "es"})`)
    const files = mod.patches.map((p) => path.join(mod.dir, p))
    await fetchBases(root, mod)
    const r = await $`git -C ${root} am -3 --quiet ${files}`.env({ ...process.env, ...GIT_IDENTITY }).nothrow()
    if (r.exitCode !== 0) {
      await clearApplyState(root)
      fail(`${mod.id} does not apply cleanly on ${mod.harness} ${rel(mod.upstream.ref)}. It probably conflicts with a mod applied before it.`)
    }
  }
}

// "tetris-8.vim-keys-3": each mod and the update it is on, valid as semver
// build metadata, so `opencode --version` says exactly what is built in.
const stampOf = (mods: Mod[]) => mods.map((m) => `${m.name}-${m.update}`).join(".")

// Harness install/build commands run with these set, so a build can stamp
// itself: OPENMODS_HARNESS=opencode OPENMODS_REF=v1.18.31
// OPENMODS_VERSION=1.18.31 OPENMODS_MODS=vim-keys-2.quiet-startup-1
// (dot-separated, so "${OPENMODS_VERSION}+${OPENMODS_MODS}" is valid semver)
let buildEnv: Record<string, string> = {}

class CommandFailed extends Error {}

async function shell(cmd: string, cwd: string) {
  // With --json, stdout carries only the JSON result: a harness's install,
  // build and typecheck output goes to stderr instead.
  // Bun's package and transpiler caches go in ~/.openmods too, unless you
  // chose a place for them, so builds leave nothing behind outside it.
  const cache = {
    BUN_INSTALL_CACHE_DIR: process.env.BUN_INSTALL_CACHE_DIR ?? path.join(HOME, "cache", "bun"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH ?? path.join(HOME, "cache", "transpiler"),
  }
  const proc = Bun.spawn(["sh", "-c", cmd], { cwd, stdio: ["inherit", has("json") ? 2 : "inherit", "inherit"], env: { ...process.env, ...cache, ...buildEnv } })
  const code = await proc.exited
  if (code !== 0) throw new CommandFailed(`command failed (${code}): ${cmd}`)
}

// A harness release pins its toolchain (package.json "packageManager":
// "bun@1.3.14"). Building with a different version can produce a binary that
// is subtly broken (Bun 1.4.2 miscompiles OpenCode 1.18.31, for one), so the
// exact pinned version is installed under ~/.openmods/toolchains and put
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
    log(`Getting Bun ${want}, the version this release builds with (once, into ${pretty(dir)})`)
    const r = await $`sh ${path.resolve(import.meta.dir, "..", "get-bun.sh")} ${want} ${dir}`.nothrow().quiet()
    if (r.exitCode !== 0 || !existsSync(path.join(bin, "bun"))) fail(`could not install bun ${want}: ${r.stderr.toString().trim().split("\n").at(-1)}`)
  }
  return bin
}

// A dependency install downloads thousands of packages, and on a slow or
// flaky connection some fail. A second try usually finishes the job from
// what the first one got.
async function installDeps(h: Harness, root: string, what = "dependencies") {
  log(`Installing ${what}: ${h.install}`)
  try {
    await shell(h.install, root)
  } catch (e) {
    if (!(e instanceof CommandFailed)) throw e
    log("Some downloads failed. Trying once more.")
    await shell(h.install, root)
  }
}

// The compiler's front half: verifies every name, type and signature a mod
// relies on without producing a binary. Minutes instead of the full build.
async function typecheck(h: Harness, root: string) {
  const cmd = h.typecheck ?? fail(`${h.name} has no typecheck command in its harness definition`)
  const toolchain = await ensureToolchain(root)
  if (toolchain) buildEnv = { ...buildEnv, PATH: `${toolchain}${path.delimiter}${process.env.PATH ?? ""}` }
  await installDeps(h, root)
  log(`Typechecking: ${cmd}`)
  await shell(cmd, root)
}

async function build(h: Harness, root: string) {
  const toolchain = await ensureToolchain(root)
  if (toolchain) buildEnv = { ...buildEnv, PATH: `${toolchain}${path.delimiter}${process.env.PATH ?? ""}` }
  await installDeps(h, root)
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
// ~/.openmods/bin sits first on PATH. A modded build is "on" when its
// symlink is in that folder and "off" when it is not; either way the stock
// binary the harness installed is untouched and takes over when we step aside.

const BIN = path.join(HOME, "bin")
const pretty = (p: string) => p.replace(homedir(), "~")

// The launcher is what `opencode` runs. It starts the modded binary at once
// and, at most once a day, refreshes the registry in the background. When
// there is something to update (a newer release all installed mods support,
// or a new update of one of them) the next launch asks, once. A no is final
// for that offer: it asks again only when there is something new. It never
// rebuilds without a yes.
// `export` lines for a harness's env, quoted like the rest of the launcher.
// Names that are not shell variable names are left out, and so is PATH,
// which the launcher sets up itself (the dev clone's pinned toolchain).
function envOf(h: Harness) {
  const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`
  return Object.entries(h.env ?? {})
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && k !== "PATH")
    .map(([k, v]) => `export ${k}=${q(v)}\n`)
    .join("")
}

function launcherOf(h: Harness, artifact: string) {
  const cli = Bun.which("openmods") ?? `${process.execPath} ${path.resolve(import.meta.path)}`
  return `#!/bin/sh
# openmods launcher for ${h.binary}. \`openmods off\` removes it; the stock ${h.name} is untouched.
HARNESS=${h.id}
SELF=${JSON.stringify(path.join(BIN, h.binary))}
REAL=${JSON.stringify(artifact)}
OM=${JSON.stringify(HOME)}
CLI=${JSON.stringify(cli)}
NOTE="$OM/updates/$HARNESS"
NOW=$(date +%s)

# Refresh the note in the background once a day; never delays startup.
if [ -z "$OPENMODS_NO_CHECK" ]; then
  LAST=$(cat "$NOTE.checked" 2>/dev/null || echo 0)
  if [ $((NOW - LAST)) -gt 86400 ]; then
    mkdir -p "$OM/updates" && echo "$NOW" > "$NOTE.checked"
    ( $CLI check-updates "$HARNESS" >/dev/null 2>&1 & )
  fi
fi

# Show each offer once, and only at an interactive terminal.
# (OPENMODS_ASSUME_TTY=1 lets tests drive the prompt without a terminal.)
if { { [ -t 0 ] && [ -t 1 ]; } || [ -n "$OPENMODS_ASSUME_TTY" ]; } && [ -z "$OPENMODS_NO_PROMPT" ] && [ -f "$NOTE" ]; then
  . "$NOTE"
  if [ -n "$KEY" ] && [ "$KEY" != "$(cat "$NOTE.seen" 2>/dev/null)" ]; then
    printf '%s\n' "$KEY" > "$NOTE.seen"
    printf '%s\n' "$MESSAGE"
    if [ "$ASK" = 1 ]; then
      printf '%s' "Update now? It rebuilds ${h.name}, which usually takes a minute or two. [y/N] "
      read -r ANSWER
      case "$ANSWER" in
        y|Y|yes|YES)
          # The update replaces this launcher and removes the old build, so
          # start again from the new launcher rather than the old path above.
          if $CLI update "$HARNESS"; then exec "$SELF" "$@"; else
            printf '%s\n' "Update failed; starting your current build. Run \"openmods update $HARNESS\" to try again."
          fi ;;
        *) printf '%s\n' "Not now. You will not be asked about this again; \"openmods update\" does it any time." ;;
      esac
    fi
  fi
fi

${envOf(h)}exec "$REAL" "$@"
`
}

// `openmods dev`: the harness command runs a clone of the harness straight
// from source, so each edit shows up the next time it starts; no packing,
// committing or building. Which clone, per harness, lives in dev.json.
// `toolchain` is kept so the launcher can be written again later (older
// entries lack it and keep their launcher until the next `openmods dev`).
type Dev = Record<string, { path: string; version: string; toolchain?: string | null }>
const devFile = path.join(HOME, "dev.json")
const loadDev = (): Dev => (existsSync(devFile) ? readJsonFile(devFile) : {})
const saveDev = (d: Dev) => {
  if (Object.keys(d).length) writeFileSync(devFile, JSON.stringify(d, null, 2) + "\n")
  else rmSync(devFile, { force: true })
}
const devOf = (harnessId: string) => loadDev()[harnessId]

function devLauncherOf(h: Harness, clone: string, version: string, toolchain: string | null) {
  const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`
  const run = h.dev!.replaceAll("{root}", q(clone)).replaceAll("{version}", version)
  return `#!/bin/sh
# openmods dev: \`${h.binary}\` runs your clone at ${clone} from source.
# \`openmods dev --stop\` switches back.
${toolchain ? `PATH=${q(toolchain)}:"$PATH"; export PATH\n` : ""}${envOf(h)}${run} "$@"
`
}

// A launcher written by an older openmods, or before the harness's env
// changed, is brought up to date without a rebuild: the dev clone's while it
// runs one. Never a revoked build's, which must keep refusing to run it.
function refreshLauncher(reg: string, h: Harness, e: State[string] | undefined) {
  const launcher = path.join(BIN, h.binary)
  if (!existsSync(launcher)) return
  const dev = loadDev()[h.id]
  if (dev) {
    if (dev.toolchain === undefined || !h.dev) return
    const want = devLauncherOf(h, dev.path, dev.version, dev.toolchain)
    if (readFileSync(launcher, "utf8") !== want) writeFileSync(launcher, want, { mode: 0o755 })
    return
  }
  if (!e?.enabled || !e.artifact || revokedIn(reg, h.id, e).length) return
  if (readFileSync(launcher, "utf8") !== launcherOf(h, e.artifact)) switchOn(h, e.artifact)
}

// Anything else that writes or removes the launcher ends dev mode, and says so.
function endDev(h: Harness) {
  const d = loadDev()
  if (!d[h.id]) return
  delete d[h.id]
  saveDev(d)
  log(`\`${h.binary}\` no longer runs your clone; \`openmods dev\` in it switches back.`)
}

// The launcher for a build that contains a revoked mod: it never runs the
// build again. It says why on every launch and starts the stock harness.
function revokedLauncherOf(h: Harness, bad: { id: string; reason: string }[], stock: string | null) {
  const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`
  const ids = bad.map((b) => b.id).join(" ")
  const message = [
    ...bad.map((b) => `${b.id} was removed from OpenMods: ${b.reason}`),
    stock
      ? `Your modded ${h.name} will not run again; this starts your stock ${h.name}. \`openmods uninstall ${ids}\` removes the mod.`
      : `Your modded ${h.name} will not run again. \`openmods uninstall ${ids}\` removes the mod.`,
  ].join("\n")
  return `#!/bin/sh
# openmods: this ${h.name} build contains a mod removed from OpenMods, so it does not run.
printf '%s\\n' ${q(message)} >&2
${stock ? `exec ${JSON.stringify(stock)} "$@"` : "exit 1"}
`
}

// The launcher stays at ~/.openmods/bin/<binary> from the first install on,
// whether it runs the modded build or the stock one: bash remembers where it
// found a command, so a launcher that came and went would leave `opencode`
// pointing at a missing file after `openmods off`, or at the stock one after
// `openmods on`.
function switchOn(h: Harness, artifact: string) {
  endDev(h)
  writeLauncher(h, launcherOf(h, artifact))
}

function switchOff(h: Harness) {
  endDev(h)
  writeLauncher(h, stockLauncherOf(h))
}

// Writes the launcher. A new one may not be picked up by a bash that already
// ran the stock harness in this terminal, so that case gets one line of help.
function writeLauncher(h: Harness, script: string) {
  mkdirSync(BIN, { recursive: true })
  const target = path.join(BIN, h.binary)
  const fresh = !existsSync(target)
  if (!fresh) unlinkSync(target)
  writeFileSync(target, script, { mode: 0o755 })
  if (fresh && path.basename(process.env.SHELL ?? "") === "bash" && pathHasBin())
    log(`If \`${h.binary}\` still starts your stock ${h.name} in a terminal that ran it before, run \`hash -r\` there once; bash remembers where it found it.`)
}

// The launcher while the mods are off: it finds the stock harness on PATH,
// or where its official installer puts it, each time it starts.
function stockLauncherOf(h: Harness) {
  const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`
  const installed = (h.installer?.paths ?? []).map((p) => q(p.replace(/^~(?=\/|$)/, homedir())))
  return `#!/bin/sh
# openmods launcher for ${h.binary}, switched off: it starts your stock ${h.name}.
# \`openmods on\` brings the mods back.
SELF_DIR=${q(BIN)}
OLD_IFS=$IFS; IFS=:
for d in $PATH; do
  IFS=$OLD_IFS
  [ -n "$d" ] && [ "\${d%/}" != "$SELF_DIR" ] && [ -f "$d/${h.binary}" ] && [ -x "$d/${h.binary}" ] && exec "$d/${h.binary}" "$@"
done
IFS=$OLD_IFS
${installed.length ? `for d in ${installed.join(" ")}; do
  [ -f "$d/${h.binary}" ] && [ -x "$d/${h.binary}" ] && exec "$d/${h.binary}" "$@"
done
` : ""}printf '%s\n' ${q(`${h.binary}: your stock ${h.name} was not found. Install it, or run \`openmods on\` for the modded build.`)} >&2
exit 127
`
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

// Keeps ~/.openmods/bin at the front of PATH in the user's shell config.
// Adds the line once. If a later line puts something in front of it, such as
// a harness installer that appended its own PATH line, the openmods line
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
      ? `fish_add_path --prepend --move ${pretty(BIN).replace("~", "$HOME")}  # openmods`
      : `export PATH="${pretty(BIN).replace("~", "$HOME")}:$PATH"  # openmods`
  const block = `# openmods: modded builds go first; \`openmods off\` steps aside\n${line}\n`
  const current = existsSync(rc) ? readFileSync(rc, "utf8") : ""
  const lines = current.split("\n")
  const last = lines.findLastIndex((l) => l.includes("# openmods"))
  if (last >= 0) {
    const later = lines.slice(last + 1).some((l) => !l.trim().startsWith("#") && /PATH|fish_add_path|shellenv/.test(l))
    if (!later) return null
    const kept = lines.filter((l) => !l.includes("# openmods")).join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n")
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
    if (stock) log(`Your stock ${h.name} is untouched at ${pretty(stock)}. \`openmods off\` switches back to it.`)
  } else {
    log(`\`${h.binary}\` runs your stock ${h.name} again${stock ? ` (${pretty(stock)})` : ""}. \`openmods on\` brings the mods back.`)
  }
  const edited = entry.enabled ? setupPath() : null
  if (edited) {
    log("")
    log(
      edited.moved
        ? `Moved the openmods line to the end of ${pretty(edited.rc)}, so ${pretty(BIN)} stays first on PATH after a line added later.`
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
    state[harnessId] = { ...(state[harnessId] ?? { ref: all[0]!.upstream.ref, commit: all[0]!.upstream.commit, artifact: "" }), mods: all.map((m) => m.id), off: [...off], hashes: {}, updates: {}, enabled: false }
    saveState(state)
    log(`Every ${h.name} mod is off (${off.join(", ")}), so \`${h.binary}\` runs your stock ${h.name}. \`openmods on ${off[0]} --${harnessId}\` brings one back.`)
    return
  }
  // One release for all of them, and each mod's version for it. The base
  // patch goes first; if it has no version for any release the mods share,
  // the build goes ahead without it and says so.
  const current = state[harnessId]?.ref
  const basePatch = baseFor(reg, harnessId)
  let set = basePatch ? [basePatch, ...active] : active
  if (basePatch && sharedReleases(set).length === 0 && sharedReleases(active).length) {
    log(`note: the OpenMods base patch has no version for a ${h.name} release your mods share, so this build goes without it.`)
    set = active
  }
  const shared = sharedReleases(set)
  if (shared.length === 0)
    fail(`${active.map((m) => m.id).join(" and ")} have no ${h.name} release in common, so they cannot be built together: ${releasesSaid(active)}. Nothing was changed.`)
  const release = target
    ? shared.includes(target)
      ? target
      : fail(`not every mod has a version for ${h.name} ${rel(target)}: ${releasesSaid(set)}`)
    : current && shared.includes(current)
      ? current
      : shared[0]!
  if (current && release !== current && !target) {
    const lacking = set.filter((m) => !at(m, current))
    log(`note: building ${h.name} ${rel(release)}, not ${rel(current)}: ${lacking.map((m) => shown(m.id)).join(", ")} ${lacking.length === 1 ? "has" : "have"} no version for ${rel(current)}.`)
  }
  const mods = set.map((m) => at(m, release)!)
  for (const m of mods) {
    const r = revocationOf(reg, m.id, m.update)
    if (r) fail(`${m.id} was removed from OpenMods: ${r.reason} It cannot be built. \`openmods uninstall ${m.id}\` removes it.`)
  }
  // Refuse a combination that cannot work before anything is touched. The
  // mods being added go last, so each clash is reported against them.
  const order = [...mods.filter((m) => !adding.includes(m.id)), ...mods.filter((m) => adding.includes(m.id))]
  for (let j = 1; j < order.length; j++) {
    const clashes = order.slice(0, j).flatMap((o) => {
      const why = incompatibility(o, order[j]!)
      return why ? [{ id: o.id, why }] : []
    })
    if (clashes.length) {
      const ids = clashes.map((c) => c.id).filter((id) => id !== BASE_ID)
      fail(
        `${order[j]!.id} does not work with ${clashes.map((c) => `${shown(c.id)} on ${h.name}: ${c.why}`).join("; nor with ")}. ${
          ids.length
            ? `They cannot be on at the same time, so nothing was changed. \`openmods off ${ids.join(" ")}\` or \`openmods uninstall ${ids.join(" ")}\` makes room.`
            : "Every modded build carries that patch, so this mod cannot be installed until its author moves those lines. Nothing was changed."
        }`,
      )
    }
  }
  const base = mods[0]!.upstream
  await ensureCheckout(h, root, base.commit, base.ref)
  await applyMods(root, mods)
  buildEnv = {
    OPENMODS_HARNESS: harnessId,
    OPENMODS_REF: base.ref,
    OPENMODS_VERSION: base.ref.replace(/^[^0-9]*/, ""),
    OPENMODS_MODS: stampOf(mods.filter((m) => m.id !== BASE_ID)),
  }
  const built = await build(h, root).catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)))
  const artifact = keepBuild(h, harnessId, built, `${rel(base.ref)}+${stampOf(mods.filter((m) => m.id !== BASE_ID))}`)
  switchOn(h, artifact)
  state[harnessId] = {
    ref: base.ref,
    commit: base.commit,
    mods: all.map((m) => m.id),
    off: off.filter((n) => all.some((m) => m.id === n)),
    hashes: Object.fromEntries(mods.map((m) => [m.id, patchHash(m)])),
    updates: Object.fromEntries(mods.map((m) => [m.id, m.update])),
    artifact,
    enabled: true,
  }
  saveState(state)
  // The launcher's note described the build this replaces.
  rmSync(path.join(HOME, "updates", harnessId), { force: true })
  explainSwitch(h, state[harnessId]!)
}

// ---------------------------------------------------------------- commands

async function cmdList() {
  const reg = await ensureRegistry()
  const only = positional[1] ?? harnessFlags(reg)[0]
  const mods = listMods(reg, only).filter((m) => !m.internal)
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
  const spec = positional[1] ?? fail("usage: openmods info <owner>/<mod> [--<harness>]")
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
    log(`  ${bold(h.name)}  for ${rel(m.upstream.ref)} ${dim(`(tag ${m.upstream.ref}, ${m.upstream.commit.slice(0, 12)})`)}   install: openmods install ${m.id} --${m.harness}`)
    log(`    update     ${m.update}${m.note ? `: ${m.note}` : ""}`)
    if (m.versions.length > 1) log(`    versions   ${m.versions.map((v) => `${rel(v.ref)} (update ${v.update})`).join(", ")}  ${dim("(one per release; below is the newest)")}`)
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

/** Which harness a clone is: from --<harness> or --harness, else its origin remote. */
async function harnessOfClone(reg: string, checkout: string): Promise<Harness> {
  const remote = (await $`git -C ${checkout} remote get-url origin`.nothrow().text()).trim()
  const harnesses = allHarnesses(reg)
  return (
    (flag("harness") ? harnesses.find((h) => h.id === flag("harness")) : undefined) ??
    harnesses.find((h) => flags.get(h.id) === true) ??
    harnesses.find((h) => remote.replace(/\.git$/, "").endsWith(h.repo.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, ""))) ??
    fail(`cannot tell which harness ${checkout} is; pass --harness <id>`)
  )
}

const isPathSpec = (s: string) => s === "." || s === ".." || /^(\.{1,2}\/|\/|~)/.test(s)

async function cmdInstall() {
  const reg = await ensureRegistry()
  let specs = positional.slice(1)
  if (specs.length === 0) fail("install needs a mod, e.g. openmods install shouryamaanjain/tetris --opencode. `openmods list` shows what is available.")
  // `openmods install .` in a clone of a harness: pack its commits on top of
  // the release as a local mod, then install that, so an author can try a
  // mod the way users will run it without a separate pack step.
  if (specs.some(isPathSpec)) {
    if (specs.length !== 1) fail("install a checkout on its own: openmods install <path to your harness clone>")
    const checkout = path.resolve(specs[0]!.replace(/^~(?=\/|$)/, homedir()))
    if (!existsSync(path.join(checkout, ".git"))) fail(`${pretty(checkout)} is not a git checkout of a harness`)
    const branch = (await $`git -C ${checkout} rev-parse --abbrev-ref HEAD`.nothrow().text()).trim()
    const fromBranch = branch.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
    const name =
      flag("name") ??
      (fromBranch && !["head", "main", "master", "dev", "develop"].includes(fromBranch) && ID.test(fromBranch)
        ? fromBranch
        : fail(`cannot name the mod after the branch "${branch}"; pass --name <mod>`))
    flags.set("name", name)
    flags.set("local", true)
    flags.set("force", true)
    positional[1] = checkout
    const packed = await cmdPack({ quiet: true })
    log(`Packed ${pretty(checkout)} as the local mod ${packed.owner}/${packed.name}.`)
    specs = [`${packed.owner}/${packed.name}`]
    flags.set(packed.harness, true)
  }
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
  if (specs.length === 0) fail("uninstall needs a mod, e.g. openmods uninstall shouryamaanjain/tetris. `openmods status` shows what is installed.")
  const state = loadState()
  const byHarness = new Map<string, string[]>()
  for (const spec of specs) {
    const id = parseId(reg, spec)
    const on = Object.keys(state).filter((h) => state[h]!.mods.includes(id))
    if (on.length === 0) fail(`${id} is not installed`)
    // A mod removed from the registry can still be uninstalled: which
    // harnesses have it comes from what is installed.
    const known = listMods(reg).some((m) => m.id === id && !m.internal)
    const picked = harnessFlags(reg)
    const targets = known
      ? (await chooseHarnesses(reg, id, "Uninstall", { among: on })).map((m) => m.harness)
      : picked.length
        ? on.filter((h) => picked.includes(h))
        : on.length === 1
          ? on
          : fail(`${id} is installed on ${on.join(", ")}; choose with ${on.map((h) => `--${h}`).join(" or ")}`)
    for (const h of targets) byHarness.set(h, [...(byHarness.get(h) ?? []), id])
  }
  for (const [id, names] of byHarness) {
    // The build is remade from the remaining mods' patches, so one the
    // registry no longer has has to go too; say so rather than fail on it.
    const left = state[id]!.mods.filter((n) => !names.includes(n))
    const gone = left.filter((n) => !findMod(reg, n, id))
    if (gone.length)
      fail(
        `${gone.join(", ")} ${gone.length === 1 ? "is" : "are"} no longer in the registry either, so your ${id} build cannot be remade with ${gone.length === 1 ? "it" : "them"}. Uninstall ${gone.length === 1 ? "it" : "them"} too: openmods uninstall ${[...names, ...gone].join(" ")}`,
      )
    const remaining = left.map((n) => resolveMod(reg, n, id))
    await rebuild(reg, id, remaining, state[id]?.off ?? [])
  }
}

async function cmdStatus() {
  const reg = await ensureRegistry()
  const state = loadState()
  const dev = loadDev()
  if (has("json")) {
    const out: Record<string, unknown> = { ...state }
    for (const [id, d] of Object.entries(dev)) out[id] = { ...(state[id] ?? {}), dev: d }
    return console.log(JSON.stringify(out, null, 2))
  }
  const ids = Object.keys(state)
  for (const [id, d] of Object.entries(dev)) {
    const h = loadHarness(reg, id)
    log(`${h.binary} → your clone, from source`)
    log(`  dev     ${h.name} ${d.version}  ${pretty(d.path)}  (openmods dev --stop switches back)`)
  }
  if (ids.length === 0) {
    if (!Object.keys(dev).length) log("No mods installed. `openmods list` shows what is available.")
    return
  }
  for (const id of ids.filter((i) => !dev[i])) {
    const h = loadHarness(reg, id)
    const e = state[id]!
    const stock = stockBinary(h)
    e.artifact ||= artifactPath(h, path.join(HOME, "harnesses", id, "src"))
    const built = existsSync(e.artifact)
    const onPath = pathHasBin()
    const runs = e.enabled && built && onPath ? "modded" : "stock"
    log(`${h.binary} → ${runs}`)
    const active = e.mods.filter((m) => !e.off.includes(m))
    log(`  modded  ${h.name} ${rel(e.ref)} + ${active.join(" + ") || "(nothing)"}  ${e.enabled ? "on" : "off (openmods on)"}${built || !active.length ? "" : "  [not built; run openmods update]"}`)
    for (const m of e.off) log(`          ${m} is off (openmods on ${m} --${id})`)
    log(`  stock   ${stock ? `${(await versionOf(stock)) ?? "?"}  ${pretty(stock)}` : "not found on PATH"}`)
    for (const b of revokedIn(reg, id, e)) log(`  removed ${b.id} was removed from OpenMods: ${b.reason} \`openmods uninstall ${b.id}\``)
    const pending = readNote(id)
    if (pending?.ASK === "1" && pending.MESSAGE) log(`  update  ${pending.MESSAGE} \`openmods update ${id}\` does it.`)
    if (e.enabled && !onPath) log(`  note    ${pretty(BIN)} is not on PATH in this shell; open a new terminal or run: export PATH="${pretty(BIN).replace("~", "$HOME")}:$PATH"`)
  }
}

// `on`/`off` with no argument or a harness id switch the whole modded build
// (instant, no rebuild). With a mod, owner/name, they build that mod in or out.
async function modTarget(reg: string, state: State, arg: string | undefined, verb: string): Promise<{ id: string; name: string } | null> {
  if (!arg || !arg.includes("/")) {
    if (arg && !state[arg]) fail(`"${arg}" is neither an installed mod nor a harness; \`openmods status\` lists both`)
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
    if (e.mods.every((m) => e.off.includes(m))) fail(`every ${h.name} mod is off; \`openmods on ${e.off[0]} --${id}\` builds one back in`)
    e.artifact ||= artifactPath(h, path.join(HOME, "harnesses", id, "src"))
    if (!existsSync(e.artifact)) fail(`the modded ${h.name} build is missing; run: openmods update ${id}`)
    const bad = revokedIn(reg, id, e)
    if (bad.length) fail(`this ${h.name} build has ${bad.map((b) => `${b.id}, which was removed from OpenMods: ${b.reason}`).join("; ")} \`openmods uninstall ${bad.map((b) => b.id).join(" ")}\` removes it.`)
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
    log(`Building ${target.name} out of ${target.id} (it stays installed; \`openmods on ${target.name} --${target.id}\` restores it)`)
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
    // The newest release every mod that is on has a version for, with the
    // base patch if it has one there too.
    const basePatch = baseFor(reg, id)
    const withBase = basePatch ? [basePatch, ...active] : active
    const target = sharedReleases(withBase)[0] ?? sharedReleases(active)[0]
    const same =
      e &&
      existsSync(e.artifact) &&
      active.length > 0 &&
      target === e.ref &&
      withBase.every((m) => {
        const v = at(m, e.ref)
        return v ? e.hashes[m.id] === patchHash(v) : e.hashes[m.id] === undefined
      })
    if (same && !has("force")) {
      // For anyone who turned the daily check off, this is where it happens.
      refreshLauncher(reg, loadHarness(reg, id), e)
      log(`${loadHarness(reg, id).name} ${rel(e.ref)} + ${active.map((m) => m.id).join(" + ")} is already up to date.`)
      continue
    }
    await rebuild(reg, id, mods, e?.off ?? [], [], target)
  }
}

// Author command: the harness command runs a clone of the harness straight
// from source, so an edit shows up the next time it starts.
async function cmdDev() {
  const reg = await ensureRegistry()
  const state = loadState()
  if (has("stop")) {
    const d = loadDev()
    const picked = harnessFlags(reg)
    const ids = (picked.length ? picked : Object.keys(d)).filter((id) => d[id])
    if (ids.length === 0) fail("no harness is running a clone; run `openmods dev` inside a harness clone to start")
    for (const id of ids) {
      const h = loadHarness(reg, id)
      const e = state[id]
      delete d[id]
      saveDev(d)
      // A mod revoked while the clone ran never comes back: the build's
      // launcher is the one that warns and starts the stock harness.
      const bad = e ? revokedIn(reg, id, e) : []
      if (e?.enabled && bad.length) {
        writeFileSync(path.join(BIN, h.binary), revokedLauncherOf(h, bad, stockBinary(h)), { mode: 0o755 })
        log(`${bad.map((b) => `${b.id} was removed from OpenMods: ${b.reason}`).join(" ")} \`${h.binary}\` runs your stock ${h.name}; \`openmods uninstall ${bad.map((b) => b.id).join(" ")}\` removes it.`)
      } else if (e?.enabled && e.artifact && existsSync(e.artifact)) {
        switchOn(h, e.artifact)
        log(`\`${h.binary}\` runs your modded ${h.name} again: ${rel(e.ref)} + ${e.mods.filter((m) => !e.off.includes(m)).join(" + ")}.`)
      } else {
        switchOff(h)
        log(`\`${h.binary}\` runs your stock ${h.name} again.`)
      }
    }
    return
  }

  const clone = path.resolve(positional[1] ?? ".")
  if (!existsSync(path.join(clone, ".git"))) fail(`${pretty(clone)} is not a clone of a harness. Run \`openmods dev\` inside your clone, or pass its path.`)
  const h = await harnessOfClone(reg, clone)
  if (!h.dev) fail(`${h.name} cannot run from source yet; \`openmods install .\` builds your clone instead`)
  const release = (await $`git -C ${clone} describe --tags --abbrev=0 --match ${h.releaseTagPattern ?? "*"} HEAD`.nothrow().text()).trim()
  const branch = (await $`git -C ${clone} rev-parse --abbrev-ref HEAD`.nothrow().text()).trim()
  const fromBranch = branch === "HEAD" ? "" : branch.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
  const name = flag("name") ?? (fromBranch || "dev")
  if (!ID.test(name)) fail("--name must be lowercase letters, digits and hyphens")
  // Only characters a version can hold: it goes into the launcher script.
  const version = `${release ? rel(release) : "0.0.0"}+${name}-dev`.replace(/[^0-9A-Za-z.+-]/g, "")

  // Its dependencies, with the toolchain its release pins.
  const toolchain = await ensureToolchain(clone)
  if (toolchain) buildEnv = { ...buildEnv, PATH: `${toolchain}${path.delimiter}${process.env.PATH ?? ""}` }
  await installDeps(h, clone, `${h.name}'s dependencies in ${pretty(clone)}`).catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)))

  const d = loadDev()
  d[h.id] = { path: clone, version, toolchain }
  saveDev(d)
  mkdirSync(BIN, { recursive: true })
  writeFileSync(path.join(BIN, h.binary), devLauncherOf(h, clone, version, toolchain), { mode: 0o755 })
  const back = state[h.id]?.enabled ? "your modded build" : `your stock ${h.name}`
  log("")
  log(`\`${h.binary}\` now runs your clone at ${pretty(clone)} from source, as ${h.name} ${version}.`)
  log(`Edit, then start \`${h.binary}\` again to see the change: nothing to commit, pack or build. \`openmods dev --stop\` switches back to ${back}.`)
  const edited = setupPath()
  if (edited) log(`Added ${pretty(BIN)} to the front of PATH in ${pretty(edited.rc)}; open a new terminal to use it.`)
  else if (!pathHasBin()) log(`Note: ${pretty(BIN)} is not on PATH in this shell. Open a new terminal, or run: export PATH="${pretty(BIN).replace("~", "$HOME")}:$PATH"`)
}

// Author command: turn commits on top of a harness release into a mod folder.
async function cmdPack(opts: { quiet?: boolean } = {}): Promise<{ owner: string; name: string; harness: string }> {
  const reg = await ensureRegistry()
  // Publishing writes into your fork of the registry, never into the copy the
  // CLI keeps in ~/.openmods and updates itself from.
  if (!has("local") && !flag("out") && path.resolve(reg) === path.join(HOME, "registry"))
    fail(
      "pack writes the mod into your fork of the registry. Pass its folder, e.g. `openmods pack . --name <mod> --registry ../openmods`, or use --local to try it on this machine only.",
    )
  const checkout = path.resolve(positional[1] ?? ".")
  const name = flag("name") ?? fail("usage: openmods pack <harness-checkout> --name <mod> [--owner <you>] [--local] [--harness <id>] [--base <tag>] [--out <dir>] [--force]")
  if (!ID.test(name)) fail("mod name must be lowercase letters, digits and hyphens")
  if (!existsSync(path.join(checkout, ".git"))) fail(`${checkout} is not a git checkout`)

  const harness = await harnessOfClone(reg, checkout)

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
  // The latest update's code, read before its folder may be replaced below.
  const code = (dir: string, files: string[]) => codeOf(files.map((f) => readFileSync(path.join(dir, f), "utf8")))
  const latest = prevVersions.length ? prevVersions.reduce((a, b) => ((b.update ?? 1) > (a.update ?? 1) ? b : a)) : undefined
  const latestCode = latest && latest.patches.every((p) => existsSync(path.join(out, p))) ? code(out, latest.patches) : undefined
  const folder = path.join(out, base)
  rmSync(folder, { recursive: true, force: true })
  mkdirSync(folder, { recursive: true })
  await $`git -C ${checkout} format-patch --no-signature --no-stat --zero-commit --full-index -N -o ${folder} ${base}..HEAD`.quiet()
  const patches = readdirSync(folder)
    .filter((f) => f.endsWith(".patch"))
    .sort()
    .map((f) => `${base}/${f}`)
  // The update number: the latest one again when the changed lines are the
  // same as the latest update's (a rebase onto another release, or a repack),
  // else one more. The note goes with the update.
  const same = latestCode !== undefined && latestCode === code(out, patches)
  const update = latest ? (same ? (latest.update ?? 1) : (latest.update ?? 1) + 1) : 1
  const note = flag("note") ?? (same ? latest?.note : undefined)
  const version: Version = { ref: base, commit, patches, update, ...(note ? { note } : {}) }
  const versions = [version, ...prevVersions.filter((v) => v.ref !== base)].sort((a, b) =>
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
      [
        `# ${name}`,
        "",
        "TODO: what this mod changes, and why.",
        "",
        "## Permissions",
        "",
        "What the mod does beyond the harness itself. Write none where it does nothing.",
        "",
        "- Network: TODO (none, or what it connects to and why)",
        "- Files: TODO (none outside what the harness already reads and writes, or which)",
        "- Commands: TODO (none, or which it runs)",
        "- Agent instructions: TODO (unchanged, or what it adds to what the agent is told)",
        "",
        "## Install",
        "",
        "```sh",
        `openmods install ${owner}/${name}`,
        "```",
        "",
      ].join("\n"),
    )
  }
  log(`Packed ${count} commit${count === 1 ? "" : "s"} on top of ${harness.name} ${rel(base)} as ${owner}/${name}, in ${pretty(out)}`)
  log(`  ${patches.join("\n  ")}`)
  log(same ? `Same code as update ${update}, so it stays update ${update}.` : `This is update ${update}${note ? `: ${note}` : ""}.${note || !latest ? "" : " Pass --note to say what changed; users see it when they are offered the update."}`)
  const others = versions.filter((v) => v.ref !== base)
  if (others.length) log(`It keeps its versions for ${others.map((v) => rel(v.ref)).join(", ")}.`)
  // A lockfile in a patch is nearly always build noise, and two mods that
  // both carry one cannot stack. Say so; the author decides.
  const lockfiles = touchedFiles(at(loadMod(out, has("local") ? "local" : "registry"), base)!).filter((f) => /(^|\/)(Cargo\.lock|bun\.lock|bun\.lockb|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum)$/.test(f))
  if (lockfiles.length) {
    log(`warning: the patches change ${lockfiles.join(", ")}. That is usually a build side effect, not part of the mod, and mods that both touch a lockfile cannot be installed together. Reset the file to the release and commit again unless the mod really needs it.`)
  }
  if (opts.quiet) return { owner, name, harness: harness.id }
  if (has("local")) log(`It is a local mod: \`openmods install ${owner}/${name} --${harness.id}\` works now, and nothing is published until you pack it into the registry and open a PR.`)
  else log(`Edit mod.json (description, tags, license) and README.md, then open a PR to the registry.`)
  return { owner, name, harness: harness.id }
}

// Author and CI command: does a mod apply (and build) against a given ref?
async function cmdCheck() {
  const reg = await ensureRegistry()
  // `check --harness <id> --ref <tag> --build` with no mod builds the stock
  // harness: the smoke test for a harness definition, on any machine or in CI.
  // A mod is its harness folder (mods/<owner>/<name>/<harness>), or owner/name
  // with --<harness>.
  const bare = harnessFlags(reg)
  const spec = positional[1] ?? (bare.length ? undefined : fail("usage: openmods check <mod-folder | owner/mod --<harness>> [--ref <tag>] [--typecheck | --build] [--json]\n       openmods check --harness <id> --ref <tag> [--typecheck | --build] [--json]"))
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
        update: 0,
        versions: [],
        dir: "",
        root: "",
        source: "registry",
      }
  const h = loadHarness(reg, mod.harness)
  const ref = flag("ref") ?? mod.upstream.ref
  const root = flag("workspace") ? path.resolve(flag("workspace")!) : path.join(tmpdir(), `openmods-check-${mod.harness}`)
  // A stock check (--harness, no mod) says so, so the release watch can tell
  // a harness build from a mod check.
  const result: Record<string, unknown> = spec
    ? { mod: mod.id, harness: mod.harness, madeFor: mod.upstream.ref, ref, touches: touchedFiles(mod) }
    : { harness: mod.harness, stock: true, ref }
  try {
    await initCheckout(h.repo, root)
    await $`git -C ${root} fetch --no-tags --depth 1 --filter=blob:none origin tag ${ref}`.quiet()
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
      const dir = path.join(tmpdir(), `openmods-rebase-${process.pid}`)
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
      buildEnv = { OPENMODS_HARNESS: h.id, OPENMODS_REF: ref, OPENMODS_VERSION: rel(ref), OPENMODS_MODS: mod.patches.length ? mod.name : "stock" }
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
    const file = path.join(HOME, "updates", id)
    if (!e) {
      rmSync(file, { force: true })
      continue
    }
    const h = loadHarness(reg, id)
    const launcher = path.join(BIN, h.binary)
    // In dev mode the launcher runs the author's clone; leave it alone.
    if (devOf(id)) {
      refreshLauncher(reg, h, e)
      log(`${id}: runs your clone (openmods dev); no updates while it does.`)
      continue
    }
    // A revoked mod stops running: the launcher warns on every launch and
    // starts the stock harness instead, until the mod is uninstalled.
    const bad = revokedIn(reg, id, e)
    if (bad.length) {
      if (e.enabled && existsSync(launcher)) writeFileSync(launcher, revokedLauncherOf(h, bad, stockBinary(h)), { mode: 0o755 })
      const message = `${bad.map((b) => `${b.id} was removed from OpenMods: ${b.reason}`).join(" ")} \`openmods uninstall ${bad.map((b) => b.id).join(" ")}\` removes it.`
      log(`${id}: ${message}`)
      if (has("json")) console.log(JSON.stringify({ current: rel(e.ref), revoked: bad }))
      continue
    }
    // A change to how the launcher asks, or to the harness's env, reaches
    // everyone without a rebuild.
    refreshLauncher(reg, h, e)
    // A mod the registry no longer has keeps running as built; it just has no updates.
    const active = e.mods.filter((n) => !e.off.includes(n)).flatMap((n) => findMod(reg, n, id) ?? [])
    const offer = updateOffer(h, e, active, baseFor(reg, id))
    // The launcher sources this file, so every value is single-quoted. KEY
    // names the offer: the launcher shows each one once, and a no is final
    // until the key changes (another release, another mod update).
    const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`
    const now = Math.floor(Date.now() / 1000)
    writeFileSync(file, [`CURRENT=${q(rel(e.ref))}`, `KEY=${q(offer.key)}`, `ASK=${offer.ask ? 1 : 0}`, `MESSAGE=${q(offer.message)}`, `CHECKED=${now}`].join("\n") + "\n")
    writeFileSync(`${file}.checked`, `${now}\n`)
    if (has("json"))
      console.log(
        JSON.stringify({
          current: rel(e.ref),
          currentTag: e.ref,
          available: offer.latest ? rel(offer.latest) : "",
          availableTag: offer.latest,
          allSupport: offer.blocked.length === 0,
          blocked: offer.blocked,
          moveTo: offer.moveTo ? rel(offer.moveTo) : "",
          updates: offer.updates,
          ask: offer.ask,
          message: offer.message,
        }),
      )
    else log(offer.message ? `${id}: ${offer.message}${offer.ask ? ` \`openmods update ${id}\` does it.` : ""}` : `${id}: up to date (${rel(e.ref)})`)
  }
}

/** The launcher's note for a harness, as written by check-updates. */
function readNote(id: string): Record<string, string> | null {
  const file = path.join(HOME, "updates", id)
  if (!existsSync(file)) return null
  const out: Record<string, string> = {}
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line)
    if (m) out[m[1]!] = m[2]!.replace(/^'|'$/g, "").replaceAll("'\\''", "'")
  }
  return out
}

/**
 * What there is to offer a user for one harness: a newer release every mod
 * that is on has a version for (`moveTo`), and new updates of their mods at
 * the release they would be on (`updates`). Either one is a question; a newer
 * release that some mods hold back is only a notice. `key` names the offer.
 */
function updateOffer(h: Harness, e: State[string], mine: Mod[], basePatch?: Mod) {
  // The base patch counts like a mod when it has a version the mods share.
  const active = basePatch && sharedReleases([basePatch, ...mine]).length ? [basePatch, ...mine] : mine
  const shared = sharedReleases(active)[0]
  const moveTo = shared && newerRelease(shared, e.ref) ? shared : ""
  const newest = newestFirst([e.ref, ...active.flatMap((m) => m.versions.map((v) => v.ref))])[0]!
  const latest = newerRelease(newest, e.ref) ? newest : ""
  const blocked = latest ? active.filter((m) => !at(m, latest)).map((m) => m.id) : []
  const target = moveTo || e.ref
  // Which update of each mod the build holds; older installs did not record
  // it, so it is read from the patches when they still match.
  const installed = (m: Mod) => {
    if (e.updates[m.id] !== undefined) return e.updates[m.id]!
    // A build from before the base patch existed has none of it.
    if (m.id === BASE_ID) return e.hashes[m.id] === undefined ? 0 : undefined
    const v = at(m, e.ref)
    return v && patchHash(v) === e.hashes[m.id] ? v.update : undefined
  }
  const updates = active.flatMap((m) => {
    const v = at(m, target)
    const have = installed(m)
    return v && have !== undefined && v.update > have ? [{ id: m.id, update: v.update, ...(v.note ? { note: v.note } : {}) }] : []
  })
  const said = updates.map((u) => `${shown(u.id)} update ${u.update}${u.note ? ` (${u.note})` : ""}`).join(", ")
  const ask = !!moveTo || updates.length > 0
  const message = moveTo
    ? `${h.name} ${rel(moveTo)} is out, and all your mods support it.${said ? ` New in your mods: ${said}.` : ""}`
    : updates.length
      ? `New in your ${h.name} mods: ${said}.`
      : blocked.length
        ? `${h.name} ${rel(latest)} is out, but ${blocked.map(shown).join(", ")} ${blocked.length === 1 ? "has" : "have"} no version for it yet, so you stay on ${rel(e.ref)}.`
        : ""
  const key = ask ? `update ${moveTo} ${updates.map((u) => `${u.id}@${u.update}`).join(",")}` : blocked.length ? `blocked ${latest}` : ""
  return { moveTo, latest, blocked, updates, ask, message, key }
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
    wrap(`openmods: ${INTRO}`),
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
  pack: async () => void (await cmdPack()),
  dev: cmdDev,
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
