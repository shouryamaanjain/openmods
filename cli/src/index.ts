#!/usr/bin/env bun
// openmods: install source-level mods into open-source harnesses.
//
// A mod is an ordered series of git patches against a pinned upstream commit.
// Installing one clones the harness, checks out that commit, applies the
// patches, builds, and links the resulting binary under ~/.openmods/bin.
// The stock install of the harness is never touched.

import { $ } from "bun"
import { accessSync, constants, cpSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { cpus, homedir, tmpdir, totalmem } from "node:os"
import path from "node:path"
import { footprint, incompatibility as whyNot, type Footprint } from "./overlap"
import { lastRebuild, Progress, roughly } from "./progress"
import { managerHere, missingMessage, type Requirement } from "./requirements"
import { codeOf, withPrivateEmails } from "./private-email"
import { sameRepo } from "./same-repo"
import { getZig, usableZig, zigPin } from "./zig"

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
  // What a build needs on the machine: a command on PATH, or a `check` that
  // must succeed (a library, say), on every OS or only on `os`; see
  // requirements.ts for how the missing ones are installed.
  requirements?: Requirement[]
  install: string
  /** The install a build needs, when it is less than `install`, which a typecheck and `openmods dev` run. */
  buildInstall?: string
  typecheck?: string
  build: string
  artifact: string
  // The folder that holds the binary and everything it needs, kept whole
  // for each build; the binary's own folder when unset. See
  // schema/harness.schema.json.
  keep?: string
  // Runs a clone from source, for `openmods dev`; see schema/harness.schema.json.
  dev?: string
  // Set for the modded build (and a dev clone) when it starts, such as turning
  // off the harness's own self-update: OpenMods offers updates for it.
  env?: Record<string, string>
  // Arguments the modded build (and a dev clone) always starts with, before
  // the user's: for a setting with no environment variable, such as Codex's
  // update check.
  args?: string[]
  // More args, unless the user's include one of \`given\`; see the schema.
  argsUnless?: { args: string[]; given: string[] }
  // The user's arguments that start the stock harness instead; see the schema.
  stockWhen?: string[]
  // Its options that take a value, to find the command word; see the schema.
  valueOptions?: string[]
  // Where it keeps a server its stock and modded builds could share; see the schema.
  sharedServer?: { home: string; homeEnv?: string; binary: string; versionFile?: string; reset: string }
  // What changes when the stock harness is the modded build's own release;
  // see the schema.
  sameRelease?: SameRelease
  // Found in the stock harness's program, to tell it from another program of
  // the same name; see the schema.
  stockMarker?: string
  releaseTagPattern?: string
}
type SameRelease = {
  stockVersion: string
  env?: Record<string, string>
  envUnlessModsChange?: string[]
  stockWhen?: string[]
  argsLast?: { args: string[]; unless?: string[] }
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
  // Marked internal in its mod.json: never listed or installed by hand.
  internal?: boolean
}

// mods: every installed mod, in apply order. off: the subset built out for now.
// updates: which update of each mod the build holds.
type State = Record<string, { ref: string; commit: string; mods: string[]; off: string[]; hashes: Record<string, string>; updates: Record<string, number>; artifact: string; enabled: boolean; plain?: boolean; changed?: string[] }>

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
const SWITCHES = new Set(["build", "force", "help", "json", "local", "no-path", "typecheck", "stop", "yes"])
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
  // While a build step is on screen, what it would print goes to its log.
  if (progress?.live && progress.running) progress.note(msg)
  else if (!has("json")) console.log(msg)
}
// While a change is being built: what to say if it fails, after the error.
let failNote: (() => string[]) | undefined
const fail = (msg: string): never => {
  progress?.failed()
  console.error(`error: ${msg}`)
  for (const line of failNote?.() ?? []) console.error(line)
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

// The registry openmods cloned holds the mods list, the build recipes and the
// list of removed mods; list, info, install and update pull it first, so new
// mods show up without updating anything. The program itself runs from its
// own copy (see installCli), so a pull never changes it. A pull that fails,
// or takes more than 20 seconds, leaves the copy on this machine, and says so
// on stderr, so --json output stays clean.
let pullsAllowed = true
// Whether this run pulled the registry: then its list of removed mods is
// fresh too, and no separate fetch is needed. One pull per run.
let pulled: Promise<boolean> | undefined
async function refreshRegistry(): Promise<string> {
  const dir = await ensureRegistry()
  if (dir !== path.join(HOME, "registry") || !pullsAllowed) return dir
  // The launcher's background look leaves the registry alone while another
  // openmods command runs: that one may be reading mods and patches from it.
  if (positional[0] === "check-updates" && otherCommandRuns()) return dir
  pulled ??= pullRegistry(dir)
  await pulled
  return dir
}
// Each command but the background look leaves a marker while it runs.
const BUSY = path.join(HOME, "busy")
function markBusy() {
  try {
    mkdirSync(BUSY, { recursive: true })
    const me = path.join(BUSY, String(process.pid))
    writeFileSync(me, "")
    process.on("exit", () => rmSync(me, { force: true }))
  } catch {}
}
function otherCommandRuns() {
  try {
    return readdirSync(BUSY).some((f) => {
      if (Number(f) === process.pid) return false
      // Its process must have started before the marker was written: a
      // process that took the number of a killed command is not it.
      let written: number
      try {
        written = lstatSync(path.join(BUSY, f)).mtimeMs
      } catch (e) {
        // Gone since the listing: that command has ended. Anything else
        // unreadable counts as running, to be safe.
        return (e as NodeJS.ErrnoException).code !== "ENOENT"
      }
      if (lockOwnerRuns(Number(f), written)) return true
      // Left by a command that was killed.
      rmSync(path.join(BUSY, f), { force: true })
      return false
    })
  } catch {
    return false
  }
}
async function pullRegistry(dir: string): Promise<boolean> {
  const p = Bun.spawn(["git", "-C", dir, "pull", "-q", "--ff-only"], {
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      ...sshTransport(),
      GIT_HTTP_LOW_SPEED_LIMIT: "1000",
      GIT_HTTP_LOW_SPEED_TIME: "15",
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    timeout: 20_000,
  })
  const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()])
  if (code !== 0) {
    const why = p.signalCode ? "it took too long" : err.trim().split("\n").filter(Boolean).at(-1)?.replace(/^(fatal|error): /, "") || `git exited with ${code}`
    console.error(`note: could not update the mods list (${why}); using the copy this machine fetched last.`)
  }
  return code === 0
}

// The program runs from ~/.openmods/cli, never from the registry clone:
// pulling the mods list must not change what runs. It is a released version
// of OpenMods, a vX.Y.Z tag of the registry, taken by the installer and by
// \`openmods update\`; code merged since the newest release never runs on a
// user's machine. Each version gets its own folder, and ~/.openmods/cli is a
// link swapped to it in one step, so the openmods command always finds a
// whole program. Returns the versions when it switched.
const CLI_DIR = path.join(HOME, "cli")
const CLI_VERSIONS = path.join(HOME, "cli-versions")
const runsFromRegistry = () => {
  try {
    return realpathSync(import.meta.dir).startsWith(realpathSync(path.join(HOME, "registry")) + path.sep)
  } catch {
    return false
  }
}
// The openmods command runs the copy, not the registry clone.
function pointWrapperAtCopy() {
  const wrapper = path.join(BIN, "openmods")
  if (!existsSync(wrapper)) return
  const text = readFileSync(wrapper, "utf8")
  const moved = text.replaceAll("/registry/cli/src/index.ts", "/cli/src/index.ts")
  if (moved !== text) writeScript(wrapper, moved)
}
// ssh that never waits on a prompt, unless the user set up a transport of
// their own (GIT_SSH_COMMAND or GIT_SSH), which is kept as it is.
const sshTransport = (): Record<string, string> =>
  process.env.GIT_SSH_COMMAND || process.env.GIT_SSH ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10" }
// git talking to the registry's remote, given at most 20 seconds, like the
// pull; fails with git's last line of error.
async function remoteGit(reg: string, ...a: string[]): Promise<string> {
  const p = Bun.spawn(["git", "-C", reg, ...a], {
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      ...sshTransport(),
      GIT_HTTP_LOW_SPEED_LIMIT: "1000",
      GIT_HTTP_LOW_SPEED_TIME: "15",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  })
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()])
  if (code !== 0) throw new Error(p.signalCode ? "it took too long" : err.trim().split("\n").at(-1)?.replace(/^(fatal|error): /, "") || `git exited with ${code}`)
  return out
}
const RELEASE = /^\d+\.\d+\.\d+$/
// The newest release the registry's remote has, as "X.Y.Z".
async function newestRelease(reg: string): Promise<string> {
  const out = await remoteGit(reg, "ls-remote", "--tags", "--refs", "origin", "v*").catch((e: Error) => {
    throw new Error(`could not reach ${remoteOf(reg)} (${e.message})`)
  })
  const versions = out
    .split("\n")
    .map((l) => l.match(/refs\/tags\/v(\d+)\.(\d+)\.(\d+)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])])
    .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!)
  const newest = versions.at(-1)
  if (!newest) throw new Error(`${remoteOf(reg)} has no release of OpenMods`)
  return newest.join(".")
}
function remoteOf(reg: string) {
  return Bun.spawnSync(["git", "-C", reg, "remote", "get-url", "origin"]).stdout.toString().trim() || pretty(reg)
}
// \`release\` is the one to set up, when the caller already knows it (the
// installer); otherwise the newest.
async function installCli(reg: string, release?: string): Promise<{ from: string; to: string } | null> {
  const to = release ?? (await newestRelease(reg))
  const readVersion = (dir: string) => {
    try {
      return readFileSync(path.join(dir, ".version"), "utf8").trim()
    } catch {
      return ""
    }
  }
  const from = readVersion(CLI_DIR)
  if (from === to) {
    pointWrapperAtCopy()
    return null
  }
  const dest = path.join(CLI_VERSIONS, to)
  if (readVersion(dest) !== to) {
    const tag = `v${to}`
    // As the remote has it now, even if a tag of that name was fetched
    // before; the installer has just done this itself.
    if (!release)
      await remoteGit(reg, "fetch", "-q", "--depth", "1", "origin", `+refs/tags/${tag}:refs/tags/${tag}`).catch((e: Error) => {
        throw new Error(`could not fetch OpenMods ${to} (${e.message})`)
      })
    const next = path.join(CLI_VERSIONS, `.new-${to}-${process.pid}`)
    rmSync(next, { recursive: true, force: true })
    mkdirSync(next, { recursive: true })
    const archive = await $`git -C ${reg} archive --format=tar ${tag} cli/src cli/package.json cli/get-bun.sh`.nothrow().quiet()
    if (archive.exitCode !== 0) {
      rmSync(next, { recursive: true, force: true })
      throw new Error(`OpenMods ${to} has no program in cli/`)
    }
    await $`tar -x -C ${next} --strip-components=1 < ${archive.stdout}`.quiet()
    writeFileSync(path.join(next, ".version"), `${to}\n`)
    // A version folder, once there, is whole and never replaced: another
    // command may have put it there first and linked to it already.
    try {
      renameSync(next, dest)
    } catch {
      rmSync(next, { recursive: true, force: true })
    }
    if (readVersion(dest) !== to) throw new Error(`could not set up ${pretty(dest)}`)
  }
  // The folders running now stay, for a command that started on them: the
  // one the link points to, and this command's own, which another command
  // may have switched away from meanwhile.
  const running = new Set<string>()
  for (const dir of [CLI_DIR, path.join(import.meta.dir, "..")])
    try {
      const real = realpathSync(dir)
      if (path.dirname(real) === realpathSync(CLI_VERSIONS)) running.add(path.basename(real))
    } catch {}
  // A folder left by an earlier layout is moved aside, then the link swapped in.
  if (existsSync(CLI_DIR) && !lstatSync(CLI_DIR).isSymbolicLink()) renameSync(CLI_DIR, path.join(CLI_VERSIONS, `old-${process.pid}`))
  const link = `${CLI_DIR}.${process.pid}`
  rmSync(link, { force: true })
  symlinkSync(dest, link)
  renameSync(link, CLI_DIR)
  // The openmods command of an install from before runs the registry clone
  // until it points at the copy.
  try {
    pointWrapperAtCopy()
  } catch (e) {
    throw new Error(`OpenMods ${to} is set up in ${pretty(CLI_DIR)}, but the openmods command could not be pointed at it: ${e instanceof Error ? e.message : String(e)}`)
  }
  // Tidying up after the switch: a failure is only a note.
  try {
    // Only this version and the ones running stay. Folders being set up by
    // another command (.new-*) are left alone.
    const keep = new Set([to, ...running])
    for (const d of readdirSync(CLI_VERSIONS)) if (!keep.has(d) && !d.startsWith(".")) rmSync(path.join(CLI_VERSIONS, d), { recursive: true, force: true })
  } catch (e) {
    console.error(`note: OpenMods ${to} is set up, but tidying up after it failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  return { from, to }
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

// OpenMods used to change harness code itself: a patch of its own in every
// build (openmods/base), and a version stamp in the build's files. It never
// does now. A build made since is marked \`plain\` in the state; any other is
// made again, without either, on the next update.
const carriesBase = (e: State[string]) => !e.plain
const shown = (id: string) => id

function allHarnesses(reg: string): Harness[] {
  return readdirSync(path.join(reg, "harnesses"))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => loadHarness(reg, f.replace(/\.json$/, "")))
}

/** `owner/name`, checked. */
function parseId(reg: string, spec: string): string {
  const parts = spec.split("/")
  if (parts.length !== 2 || !ID.test(parts[0]!) || !ID.test(parts[1]!)) fail(`"${spec}" is not a mod name. Mods are written owner/mod, e.g. shouryamaanjain/space-invaders.`)
  return spec
}

/** Every harness a mod supports. */
function supportsOf(reg: string, spec: string): Mod[] {
  const id = parseId(reg, spec)
  const found = listMods(reg).filter((m) => m.id === id && !m.internal)
  if (found.length === 0) {
    // The old harness/mod form, e.g. opencode/space-invaders.
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
const isRevocation = (r: unknown): r is Revocation => {
  const x = r as Revocation
  return !!x && typeof x.id === "string" && typeof x.reason === "string" && (x.updates === undefined || (Array.isArray(x.updates) && x.updates.every((u) => typeof u === "number")))
}
// The list for this run: the registry checkout's own, unless a list fetched
// on its own says otherwise (see fetchRevocations).
let fetchedRevocations: { list: Revocation[]; fresh: boolean } | null = null
function revocations(reg: string): Revocation[] {
  let local: Revocation[] = []
  try {
    const file = path.join(reg, "revoked.json")
    if (existsSync(file)) local = ((readJsonFile(file).revoked ?? []) as unknown[]).filter(isRevocation)
  } catch {}
  if (!fetchedRevocations) return local
  // Fetched just now: it is the list. Only the last copy, offline: whichever
  // of it and the checkout is newer may list more, so both count.
  return fetchedRevocations.fresh ? fetchedRevocations.list : [...local, ...fetchedRevocations.list]
}

// The list of removed mods is fetched on its own, on every command the user
// runs, so a removed mod stops running without pulling the registry (which
// also holds the CLI's code). By default the list of the registry openmods
// cloned, else the official one; OPENMODS_REVOKED_URL names another, and set
// empty turns the fetch off. The copy kept is used only for the same list.
// Offline, or on any error, the last copy stands; it never holds a command
// up for more than a few seconds.
const REVOKED_COPY = path.join(HOME, "revoked.json")
async function revokedUrl(reg: string) {
  const set = process.env.OPENMODS_REVOKED_URL
  if (set !== undefined) return set
  const origin =
    reg === path.join(HOME, "registry") ? (await $`git -C ${reg} remote get-url origin`.nothrow().quiet()).stdout.toString().trim() : DEFAULT_REGISTRY
  const gh = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(origin)
  return gh ? `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/HEAD/revoked.json` : ""
}
// Whether the list is known: fetched now, or a copy of this same list kept.
// With `offline`, only the kept copy is read.
async function fetchRevocations(reg: string, offline = false): Promise<boolean> {
  const url = await revokedUrl(reg)
  if (!url) return true
  let kept: { url?: string; revoked?: unknown[] } = {}
  try {
    kept = readJsonFile(REVOKED_COPY)
  } catch {}
  if (kept.url === url && Array.isArray(kept.revoked)) fetchedRevocations = { list: kept.revoked.filter(isRevocation), fresh: false }
  if (offline) return fetchedRevocations !== null
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    // The registry always has the file, with an empty list when nothing is
    // revoked; anything but a good answer leaves the last copy standing.
    const body = res.ok ? ((await res.json()) as { revoked?: unknown }) : null
    // A list with anything malformed in it is not taken; the last copy stands.
    if (!body || !Array.isArray(body.revoked) || !body.revoked.every(isRevocation)) return fetchedRevocations !== null
    fetchedRevocations = { list: body.revoked, fresh: true }
    const tmp = `${REVOKED_COPY}.${process.pid}`
    writeFileSync(tmp, JSON.stringify({ url, revoked: body.revoked }) + "\n")
    renameSync(tmp, REVOKED_COPY)
  } catch {}
  return fetchedRevocations !== null
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

// A revoked mod stops running: the launcher warns on every launch and starts
// the stock harness instead, until the mod is uninstalled. Returns what to say.
function stopRevoked(h: Harness, e: State[string], bad: { id: string; reason: string }[]) {
  const launcher = path.join(BIN, h.binary)
  if (e.enabled && existsSync(launcher)) writeScript(launcher, revokedLauncherOf(h, bad, stockBinary(h)))
  return `${bad.map((b) => `${b.id} was removed from OpenMods: ${b.reason}`).join(" ")} \`openmods uninstall ${bad.map((b) => b.id).join(" ")}\` removes it.`
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
// A build draws its progress only in a terminal, and not in CI.
// (OPENMODS_LIVE=1 lets tests see it without a terminal.)
const live = () => process.env.OPENMODS_LIVE === "1" || (!!process.stdout.isTTY && !has("json") && !process.env.CI)
let progress: Progress | undefined
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
/**
 * A question before a change the user may not expect. --yes answers yes.
 * With no terminal to ask on, it stops and says how to go ahead; a no leaves
 * everything as it is.
 */
// What a no leaves behind; \`install .\` has packed a local mod by then.
let declined = "Nothing was changed."
async function askUser(question: string) {
  if (has("yes")) return
  const yes = await confirm(question)
  if (yes === null) fail(`${question} Answer in a terminal, or add --yes to go ahead.`)
  if (!yes) {
    log(declined)
    process.exit(0)
  }
}

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
  const yes = has("yes") || (await confirm(`Install ${h.name} now?`))
  if (yes === null) fail(`install ${h.name} with the command above, then run this again, or add --yes to have openmods run it.`)
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
        updates: e.updates ?? {},
        artifact: e.artifact ?? "",
        enabled: e.enabled ?? existsSync(path.join(HOME, "bin", id)),
        ...(e.plain ? { plain: true } : {}),
        ...(Array.isArray(e.changed) ? { changed: e.changed } : {}),
      },
    ]),
  )
}
const saveState = (s: State) => {
  mkdirSync(HOME, { recursive: true })
  writeFileSync(statePath, JSON.stringify(s, null, 2) + "\n")
}

// ------------------------------------------------------------------- build

function artifactPath(h: Harness, root: string, file = h.artifact) {
  return path.join(root, file.replaceAll("{os}", process.platform).replaceAll("{arch}", process.arch))
}

// Before anything is fetched or built, so a missing tool or library is
// found in a second, not at the end of a long build. All of them at once.
async function checkRequirements(h: Harness) {
  const missing: Requirement[] = []
  for (const r of h.requirements ?? []) {
    if (r.os && r.os !== process.platform) continue
    if (r.command === "bun") continue // provisioned per release by ensureToolchain
    const ok = r.check
      ? (await $`sh -c ${r.check}`.nothrow().quiet()).exitCode === 0
      : !r.command || !!Bun.which(r.command)
    if (!ok) missing.push(r)
  }
  if (missing.length) {
    const manager = managerHere(process.platform, (c) => !!Bun.which(c))
    fail(missingMessage(h.name, missing, manager, process.getuid?.() === 0))
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
  // Only a release's own commit is built: the commit the registry pins must
  // be the one its tag names. A commit fetched by its id could be any commit
  // the host serves, a fork's included. Checked by the tag, not the commit:
  // asking a blobless checkout about an object it lacks makes git download
  // it, with all the history behind it.
  const tagCommit = async () => (await $`git -C ${root} rev-parse -q --verify ${`refs/tags/${ref}^{commit}`}`.nothrow().quiet()).stdout.toString().trim()
  if ((await tagCommit()) !== commit) {
    log(`Fetching ${ref}`)
    const r = await $`git -C ${root} fetch --no-tags --depth 1 origin ${`+refs/tags/${ref}:refs/tags/${ref}`}`
      .env({ ...process.env, GIT_TERMINAL_PROMPT: "0" })
      .nothrow()
      .quiet()
    if (r.exitCode !== 0) fail(`could not fetch ${h.name} ${rel(ref)} from ${h.repo}: ${r.stderr.toString().trim().split("\n").at(-1) || `git exited with ${r.exitCode}`}`)
    const now = await tagCommit()
    if (now !== commit)
      fail(`the registry has ${h.name} ${rel(ref)} as commit ${commit.slice(0, 12)}, but its tag ${ref} is ${now.slice(0, 12) || "missing"} at ${h.repo}. OpenMods builds only a release's own commit, so nothing was built; tell the registry's maintainers.`)
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
// Whether all of them could be fetched: a file the patches add has none, but
// one the release has that could not be read means a merge may fail for
// that, not for the mod.
async function fetchBases(root: string, mod: Mod) {
  if (!mod.upstream.commit) return true
  // Usually the release being built, found by its tag. Otherwise it is
  // fetched on its own: looking the commit up would download it with all
  // its history (see ensureCheckout). What counts is what is here after,
  // not whether that fetch worked: the commit may be here already.
  const tagged = await $`git -C ${root} rev-parse -q --verify ${`refs/tags/${mod.upstream.ref}^{commit}`}`.nothrow().quiet()
  if (tagged.stdout.toString().trim() !== mod.upstream.commit)
    await $`git -C ${root} fetch --no-tags --depth 1 --filter=blob:none origin ${mod.upstream.commit}`.nothrow().quiet()
  let fetched = (await $`git -C ${root} cat-file -e ${mod.upstream.commit + "^{tree}"}`.nothrow().quiet()).exitCode === 0
  for (const file of fetched ? touchedFiles(mod) : []) {
    const inTree = (await $`git -C ${root} ls-tree ${mod.upstream.commit} -- ${file}`.nothrow().quiet()).stdout.toString().trim()
    if (inTree && (await $`git -C ${root} cat-file -p ${mod.upstream.commit + ":" + file}`.nothrow().quiet()).exitCode !== 0) fetched = false
  }
  return fetched
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

// "space-invaders-8.vim-keys-3": each mod and the update it is on, valid as semver
// build metadata, so `opencode --version` says exactly what is built in.
const stampOf = (mods: Mod[]) => mods.map((m) => `${m.name}-${m.update}`).join(".")

// Harness install/build commands run with these set, so a build can stamp
// itself: OPENMODS_HARNESS=opencode OPENMODS_REF=v1.18.31
// OPENMODS_VERSION=1.18.31 OPENMODS_MODS=vim-keys-2.quiet-startup-1
// (dot-separated, so "${OPENMODS_VERSION}+${OPENMODS_MODS}" is valid semver)
let buildEnv: Record<string, string> = {}

class CommandFailed extends Error {}

// Cargo runs a compile job per core whatever the memory, and a big crate can
// then run a machine out of it (Codex's core alone peaks near 4 GB). Unless
// you set CARGO_BUILD_JOBS, a Rust build runs one job per 2.5 GB of memory,
// and never more than there are cores.
function cargoJobs() {
  if (process.env.CARGO_BUILD_JOBS) return process.env.CARGO_BUILD_JOBS
  const byMemory = Math.floor(Math.min(totalmem(), containerMemory()) / (2.5 * 1024 ** 3))
  return String(Math.max(1, Math.min(cpus().length, byMemory)))
}

// In a Linux container, the memory it may use, which can be far below the
// machine's (cgroup v2, then v1); otherwise no limit.
function containerMemory() {
  for (const file of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const limit = Number(readFileSync(file, "utf8").trim())
      if (Number.isFinite(limit) && limit > 0) return limit
    } catch {}
  }
  return Number.POSITIVE_INFINITY
}

async function shell(cmd: string, cwd: string) {
  // With --json, stdout carries only the JSON result: a harness's install,
  // build and typecheck output goes to stderr instead.
  // Bun's package and transpiler caches, and Zig's, go in ~/.openmods too, unless you
  // chose a place for them, so builds leave nothing behind outside it.
  const cache = {
    BUN_INSTALL_CACHE_DIR: process.env.BUN_INSTALL_CACHE_DIR ?? path.join(HOME, "cache", "bun"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH ?? path.join(HOME, "cache", "transpiler"),
    ZIG_GLOBAL_CACHE_DIR: process.env.ZIG_GLOBAL_CACHE_DIR ?? path.join(HOME, "cache", "zig"),
  }
  const env = { ...process.env, ...cache, CARGO_BUILD_JOBS: cargoJobs(), ...buildEnv }
  let code: number
  if (progress?.live && progress.running) {
    // On screen is the step's line; the output goes to its log, and Cargo is
    // asked to report its progress there too.
    progress.command()
    const proc = Bun.spawn(["sh", "-c", cmd], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, CARGO_TERM_PROGRESS_WHEN: "always", CARGO_TERM_PROGRESS_WIDTH: "100" },
    })
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder()
      for await (const chunk of stream) progress?.output(decoder.decode(chunk, { stream: true }))
    }
    await Promise.all([pump(proc.stdout), pump(proc.stderr)])
    code = await proc.exited
  } else {
    const proc = Bun.spawn(["sh", "-c", cmd], { cwd, stdio: ["inherit", has("json") ? 2 : "inherit", "inherit"], env })
    code = await proc.exited
  }
  if (code !== 0) throw new CommandFailed(`command failed (${code}): ${cmd}`)
}

// A harness release pins its toolchain: Bun in package.json ("packageManager":
// "bun@1.3.14"), Zig in build.zig.zon (minimum_zig_version, which its builds
// use exactly: Zig changes between versions). Building with a different
// version can produce a binary that is subtly broken (Bun 1.4.2 miscompiles
// OpenCode 1.18.31, for one), or not build at all, so the exact pinned
// version is installed under ~/.openmods/toolchains and put first on PATH
// for the build. Nothing global changes.
async function ensureToolchain(root: string): Promise<string | null> {
  return (await ensureBun(root)) ?? (await ensureZig(root))
}
// The toolchains a checkout pins, as the folder names they get under
// ~/.openmods/toolchains, for tidy to keep. Throws when a pin is there but
// cannot be read.
function pinnedToolchains(root: string): string[] {
  const pins: string[] = []
  const pkg = path.join(root, "package.json")
  if (existsSync(pkg)) {
    const bun = String(JSON.parse(readFileSync(pkg, "utf8")).packageManager ?? "").match(/^bun@(\d+\.\d+\.\d+)/)
    if (bun) pins.push(`bun-${bun[1]}`)
  }
  const zig = zigPin(root)
  if (zig) pins.push(`zig-${zig}`)
  return pins
}
// Zig, from ziglang.org (see zig.ts); the one on PATH when it is the version.
async function ensureZig(root: string): Promise<string | null> {
  const want = zigPin(root)
  if (!want) return null
  const have = Bun.which("zig") ? (await $`zig version`.nothrow().text()).trim() : ""
  if (have === want) return null
  const dir = path.join(HOME, "toolchains", `zig-${want}`)
  if (await usableZig(path.join(dir, "bin"), want)) return path.join(dir, "bin")
  log(`Getting Zig ${want}, the version this release builds with (once, into ${pretty(dir)})`)
  return getZig(want, dir).catch((e: unknown) => fail(`could not get Zig ${want}: ${e instanceof Error ? e.message : String(e)}`))
}
async function ensureBun(root: string): Promise<string | null> {
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

// A failure that is not the code's: the release could not be fetched or its
// dependencies installed. `check` reports these as not checked, so the
// release watch tries again instead of blaming the mod.
class Unchecked extends Error {}
// A mod version that pins a commit other than its release's own.
class WrongCommit extends Error {}

// A dependency install downloads thousands of packages, and on a slow or
// flaky connection some fail. A second try usually finishes the job from
// what the first one got.
async function installDeps(h: Harness, root: string, what = "dependencies", cmd = h.install) {
  log(`Installing ${what}: ${cmd}`)
  try {
    await shell(cmd, root)
  } catch (e) {
    if (!(e instanceof CommandFailed)) throw e
    log("Some downloads failed. Trying once more.")
    await shell(cmd, root)
  }
}

// The compiler's front half: verifies every name, type and signature a mod
// relies on without producing a binary. Minutes instead of the full build.
async function typecheck(h: Harness, root: string) {
  const cmd = h.typecheck ?? fail(`${h.name} has no typecheck command in its harness definition`)
  const toolchain = await ensureToolchain(root)
  if (toolchain) buildEnv = { ...buildEnv, PATH: `${toolchain}${path.delimiter}${process.env.PATH ?? ""}` }
  await installDeps(h, root).catch((e: unknown) => {
    throw new Unchecked(`could not install the dependencies: ${e instanceof Error ? e.message : String(e)}`)
  })
  log(`Typechecking: ${cmd}`)
  await shell(cmd, root)
}

async function build(h: Harness, root: string) {
  const step = <T>(name: string, fn: () => Promise<T>) => (progress ? progress.run(name, fn) : fn())
  await step("Dependencies", async () => {
    const toolchain = await ensureToolchain(root)
    if (toolchain) buildEnv = { ...buildEnv, PATH: `${toolchain}${path.delimiter}${process.env.PATH ?? ""}` }
    // Only what the build needs, when the harness says what that is; a
    // typecheck and `openmods dev` install everything.
    await installDeps(h, root, "dependencies", h.buildInstall ?? h.install).catch((e: unknown) => {
      throw new Unchecked(`could not install the dependencies: ${e instanceof Error ? e.message : String(e)}`)
    })
  })
  const artifact = artifactPath(h, root)
  await step("Build", async () => {
    log(`Building: ${h.build}`)
    await shell(h.build, root)
    if (!existsSync(artifact)) fail(`build finished but ${artifact} does not exist`)
  })
  return artifact
}

// A harness's build script may wipe its output folder before compiling, so
// a build that fails would leave nothing to run. Each successful build is
// copied to its own folder and the launcher points there; the previous copy
// stays until the new one exists, then the rest are cleared out. What is
// copied is the harness's `keep` folder, the binary with what it needs beside
// it (Codex's package: its helpers and resources), or else the binary alone.
// The build that ran until now (`previous`, its artifact) stays too: a session
// started from it keeps running across the update, and Codex starts its
// apply_patch and sandbox helpers from its own executable's path.
function keepBuild(h: Harness, harnessId: string, root: string, stamp: string, previous?: string) {
  const builds = path.join(HOME, "harnesses", harnessId, "builds")
  const base = stamp.replace(/[^A-Za-z0-9._+-]/g, "_")
  const inBuilds = previous ? path.relative(path.resolve(builds), path.resolve(previous)) : ""
  const kept = inBuilds && !inBuilds.startsWith("..") && !path.isAbsolute(inBuilds) ? inBuilds.split(path.sep)[0] : undefined
  const inUse = buildsInUse(builds)
  // A rebuild of the same release and mods (update --force) goes in a folder
  // of its own when that build may still run: it is never replaced under a
  // running session.
  let name = base
  for (let n = 2; existsSync(path.join(builds, name)) && (name === kept || inUse.has(name)); n++) name = `${base}-r${n}`
  const dest = path.join(builds, name)
  const artifact = artifactPath(h, root)
  const inside = h.keep ? path.relative(artifactPath(h, root, h.keep), artifact) : path.basename(artifact)
  // Copied beside the builds first, then swapped in: a rebuild of the same
  // release and mods replaces the folder the launcher runs, which must stay
  // whole if the copy fails.
  const staging = path.join(builds, `.${name}.${process.pid}`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(builds, { recursive: true })
  try {
    if (h.keep) cpSync(artifactPath(h, root, h.keep), staging, { recursive: true, verbatimSymlinks: true })
    else {
      mkdirSync(staging)
      cpSync(artifact, path.join(staging, inside))
    }
  } catch (e) {
    rmSync(staging, { recursive: true, force: true })
    fail(`could not copy the build to ${dest}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!existsSync(path.join(staging, inside))) {
    rmSync(staging, { recursive: true, force: true })
    fail(`could not copy the build to ${dest}`)
  }
  rmSync(dest, { recursive: true, force: true })
  renameSync(staging, dest)
  // Older builds go, except the one that ran until now and any a running
  // program was started from; another build's staging folder stays while its
  // process runs.
  for (const d of readdirSync(builds)) {
    const pid = /^\..+\.(\d+)$/.exec(d)?.[1]
    if (d !== name && d !== kept && !inUse.has(d) && !(pid && isRunning(Number(pid)))) rmSync(path.join(builds, d), { recursive: true, force: true })
  }
  return path.join(dest, inside)
}

// The build folders that running programs were started from: the launcher
// execs a build by its full path, so it is in the program's command line.
// When ps cannot say, none: the build that ran until now is kept anyway.
function buildsInUse(builds: string): Set<string> {
  const used = new Set<string>()
  let r: ReturnType<typeof Bun.spawnSync>
  try {
    r = Bun.spawnSync(["ps", "-A", "-ww", "-o", "command="])
  } catch {
    return used // no ps on this machine
  }
  if (r.exitCode !== 0) return used
  const prefix = path.resolve(builds) + path.sep
  for (const line of String(r.stdout ?? "").split("\n")) {
    const at = line.indexOf(prefix)
    if (at >= 0) used.add(line.slice(at + prefix.length).split(path.sep)[0]!.split(/\s/)[0]!)
  }
  return used
}

function isRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: it runs, as another user.
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

// ------------------------------------------------------------- switching
//
// ~/.openmods/bin sits first on PATH. A modded build is "on" when its
// symlink is in that folder and "off" when it is not; either way the stock
// binary the harness installed is untouched and takes over when we step aside.

const BIN = path.join(HOME, "bin")
const pretty = (p: string) => p.replace(homedir(), "~")

// The launcher is what `opencode` runs. It starts the modded build at once.
// At a terminal (never for scripts) it also looks for news in the background,
// which never holds the start up, and shows what the previous look found:
// a newer release every mod supports, or a fix for a mod, asked about once
// (a no is final for that offer; anything newer is asked about again); or a
// newer release some mods hold back, said once. It never rebuilds without a yes.
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

// Shell lines that set \`var\` when the user's arguments hold one of \`words\`,
// as the harness reads them: a word without a leading - counts only as the
// command (the first argument that is neither an option nor the value of
// one of the harness's valueOptions); an option counts anywhere. Nothing
// after -- counts. A trailing * matches the start of an argument.
function matchArgsOf(h: Harness, words: string[], variable: string) {
  const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`
  const pattern = (w: string) => (w.endsWith("*") ? `${q(w.slice(0, -1))}*` : q(w))
  const options = words.filter((w) => w.startsWith("-"))
  const commands = words.filter((w) => !w.startsWith("-"))
  const valued = (h.valueOptions ?? []).map(q).join("|")
  return `${variable}=
OPENMODS_CMD= OPENMODS_SKIP=
for a in "$@"; do
  case "$a" in --) break ;; esac
  if [ -n "$OPENMODS_SKIP" ]; then OPENMODS_SKIP=; continue; fi
${options.length ? `  case "$a" in ${options.map(pattern).join("|")}) ${variable}=1 ;; esac
` : ""}  [ -n "$OPENMODS_CMD" ] && continue
  case "$a" in ${valued ? `${valued}) OPENMODS_SKIP=1 ;; ` : ""}-*) ;; *) OPENMODS_CMD=$a ;; esac
done
${commands.length ? `case "$OPENMODS_CMD" in ${commands.map(pattern).join("|")}) ${variable}=1 ;; esac
` : ""}`
}

// Shell lines that put argsUnless's arguments before the user's, unless the
// user's include one of its words. Prepended with \`set --\`, so each stays one
// argument whatever it holds.
function argsUnlessOf(h: Harness) {
  const u = h.argsUnless
  if (!u) return ""
  const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`
  return `${matchArgsOf(h, u.given, "OPENMODS_GIVEN")}[ -z "$OPENMODS_GIVEN" ] && set -- ${u.args.map(q).join(" ")} "$@"
`
}

// The harness's own arguments, quoted for the launcher, with a space after.
function argsOf(h: Harness) {
  const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`
  return (h.args ?? []).map((a) => `${q(a)} `).join("")
}

function launcherOf(h: Harness, e: Pick<State[string], "artifact" | "ref" | "changed">) {
  const artifact = e.artifact
  const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`
  // The openmods of this home (which the installer writes once setup is
  // done), else the CLI writing this.
  const own = path.join(BIN, "openmods")
  const cli = (existsSync(own) || process.env.OPENMODS_RELEASE ? [own] : [process.execPath, path.resolve(import.meta.path)]).map(q).join(" ")
  return `#!/bin/sh
# openmods launcher for ${h.binary}. \`openmods off\` makes it start the stock ${h.name}, which is untouched.
HARNESS=${h.id}
SELF=${q(path.join(BIN, h.binary))}
NOTE=${q(path.join(HOME, "updates", h.id))}
openmods() { ${cli} "$@"; }

# Only at a terminal. (OPENMODS_ASSUME_TTY=1 lets tests drive it without one.)
if { [ -t 0 ] && [ -t 1 ]; } || [ -n "$OPENMODS_ASSUME_TTY" ]; then
  # Look for news for next time, in the background.
  # The whole group is redirected: dash keeps a background function's output
  # open otherwise, and whatever reads this launcher's output would wait.
  [ -z "$OPENMODS_NO_CHECK" ] && ( openmods check-updates "$HARNESS" & ) </dev/null >/dev/null 2>&1
  KEY= ASK= MESSAGE= ESTIMATE=
  [ -f "$NOTE" ] && . "$NOTE"
  if [ -n "$KEY" ] && ! grep -qxF "$KEY" "$NOTE.seen" 2>/dev/null; then
    printf '%s\n' "$KEY" >> "$NOTE.seen"
    printf '%s\n' "$MESSAGE"
    if [ "$ASK" = 1 ]; then
      printf '%s' "Update now? It rebuilds ${h.name}\${ESTIMATE:+ (\$ESTIMATE)}. [y/N] "
      read -r ANSWER
      case "$ANSWER" in
        y|Y|yes|YES)
          # The update replaces this launcher and the old build, so start
          # again from the new launcher.
          if openmods update "$HARNESS"; then exec "$SELF" "$@"; else
            printf '%s\n' "Update failed; starting your current build. \"openmods update $HARNESS\" tries again."
          fi ;;
        *) printf '%s\n' "Not now. You will not be asked about this again; \"openmods update\" does it any time." ;;
      esac
    fi
  fi
fi

${stockWhenOf(h)}${sameReleaseOf(h, e)}${envOf(h)}${argsUnlessOf(h)}exec ${q(artifact)} ${argsOf(h)}"$@"
`
}

// Whether the build's mods change any of \`patterns\` (globs of the harness's
// files). A build from before its changed files were kept counts as changing
// them.
function modsChange(e: Pick<State[string], "changed">, patterns: string[]) {
  if (!e.changed) return true
  const globs = patterns.map((p) => new Bun.Glob(p))
  return e.changed.some((f) => globs.some((g) => g.match(f)))
}

// Shell lines for sameRelease: when the stock harness found is the release
// this build is made from, the uses sameRelease names go to the stock
// harness, its env is set (unless the mods change the files it names), and
// its argsLast go after the user's arguments. The stock harness's version is
// read from its program, never by running it, and kept beside the launcher
// until that program changes.
function sameReleaseOf(h: Harness, e: Pick<State[string], "ref" | "changed">) {
  const same = h.sameRelease
  if (!same) return ""
  const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`
  const seen = path.join(HOME, "stock", h.id)
  const env = same.envUnlessModsChange?.length && modsChange(e, same.envUnlessModsChange) ? {} : (same.env ?? {})
  const exports = Object.entries(env)
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && k !== "PATH")
    .map(([k, v]) => `  export ${k}=${q(v)}\n`)
    .join("")
  const last = same.argsLast
  return `# Your stock ${h.name}, when it is this build's release, ${rel(e.ref)}.
${stockFindOf(h)}OPENMODS_SAME=
if [ -n "$STOCK_BIN" ]; then
  OPENMODS_ID=$(ls -Lli "$STOCK_BIN" 2>/dev/null)
  OPENMODS_SEEN=${q(seen)}
  # Kept while the program is the same file, unchanged since it was read.
  if [ -f "$OPENMODS_SEEN" ] && ! [ "$STOCK_BIN" -nt "$OPENMODS_SEEN" ] && [ "$(sed -n 1p "$OPENMODS_SEEN")" = "$OPENMODS_ID" ]; then
    OPENMODS_V=$(sed -n 2p "$OPENMODS_SEEN")
  else
    OPENMODS_V=$(LC_ALL=C grep -aoE ${q(same.stockVersion)} "$STOCK_BIN" 2>/dev/null | head -n 1 | LC_ALL=C sed -E ${q(`s#${same.stockVersion}#\\1#`)})
    mkdir -p ${q(path.dirname(seen))} 2>/dev/null && printf '%s\n%s\n' "$OPENMODS_ID" "$OPENMODS_V" > "$OPENMODS_SEEN.$$" 2>/dev/null && mv -f "$OPENMODS_SEEN.$$" "$OPENMODS_SEEN" 2>/dev/null
  fi
  [ "$OPENMODS_V" = ${q(rel(e.ref))} ] && OPENMODS_SAME=1
fi
if [ -n "$OPENMODS_SAME" ]; then
${same.stockWhen?.length ? `${indent(matchArgsOf(h, same.stockWhen, "OPENMODS_STOCK"))}  [ -n "$OPENMODS_STOCK" ] && exec "$STOCK_BIN" "$@"
` : ""}${exports}${last?.args.length ? `${indent(matchArgsOf(h, last.unless ?? [], "OPENMODS_GIVEN"))}  if [ -z "$OPENMODS_GIVEN" ]; then
    # After the user's arguments, and before a -- if there is one.
    OPENMODS_N=$# OPENMODS_PUT=
    for a in "$@"; do
      [ -z "$OPENMODS_PUT" ] && [ "$a" = -- ] && set -- "$@" ${last.args.map(q).join(" ")} && OPENMODS_PUT=1
      set -- "$@" "$a"
    done
    [ -n "$OPENMODS_PUT" ] || set -- "$@" ${last.args.map(q).join(" ")}
    shift "$OPENMODS_N"
  fi
` : ""}fi
`
}
const indent = (lines: string) => lines.replace(/^(?=.)/gm, "  ")

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
${toolchain ? `PATH=${q(toolchain)}:"$PATH"; export PATH\n` : ""}${stockWhenOf(h)}${envOf(h)}${argsUnlessOf(h)}${run} ${argsOf(h)}"$@"
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
    if (readFileSync(launcher, "utf8") !== want) writeScript(launcher, want)
    return
  }
  if (!e?.enabled || !e.artifact || revokedIn(reg, h.id, e).length) return
  if (readFileSync(launcher, "utf8") !== launcherOf(h, e)) switchOn(h, e)
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
// In every stopped launcher's first comment, from older openmods too.
const REVOKED_MARK = "build contains a mod removed from OpenMods"
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
function switchOn(h: Harness, e: Pick<State[string], "artifact" | "ref" | "changed">) {
  endDev(h)
  writeLauncher(h, launcherOf(h, e))
}

function switchOff(h: Harness) {
  endDev(h)
  rmSync(path.join(HOME, "updates", h.id), { force: true })
  writeLauncher(h, stockLauncherOf(h))
}

// Writes the launcher. A new one may not be picked up by a shell that already
// ran the stock harness, so when each launcher first appeared is kept, for
// `explainSwitch` to tell a terminal older than that what to do.
const LAUNCHERS_SINCE = path.join(HOME, "launchers.json")
function writeLauncher(h: Harness, script: string) {
  mkdirSync(BIN, { recursive: true })
  const target = path.join(BIN, h.binary)
  if (!existsSync(target)) writeFileSync(LAUNCHERS_SINCE, JSON.stringify({ ...launchersSince(), [h.binary]: Date.now() }) + "\n")
  writeScript(target, script)
}
// A launcher is written whole and moved into place: a launch, or a background
// look in another terminal, never finds it missing or half written.
function writeScript(file: string, script: string) {
  const tmp = `${file}.${process.pid}`
  writeFileSync(tmp, script, { mode: 0o755 })
  renameSync(tmp, file)
}
const launchersSince = (): Record<string, number> => {
  try {
    return JSON.parse(readFileSync(LAUNCHERS_SINCE, "utf8"))
  } catch {
    return {}
  }
}

// When the shell this was run from started, or null when that cannot be told.
// ps gives it to the second, and on Linux can put it up to a second early, so
// a shell counts as older than a launcher only by more than STARTED_WITHIN; a
// terminal that ran the stock harness before the launcher existed is older by
// far more.
const STARTED_WITHIN = 2000
async function shellStarted(): Promise<number | null> {
  const r = await $`ps -o lstart= -p ${process.ppid}`.nothrow().quiet()
  const t = Date.parse(r.stdout.toString().trim())
  return r.exitCode === 0 && !Number.isNaN(t) ? t : null
}

// The launcher while the mods are off: it finds the stock harness on PATH,
// or where its official installer puts it, each time it starts.
// Shell lines that start the stock harness when it is found: on PATH (anything
// that is the launcher itself, however PATH reaches it, is skipped), else
// where its official installer puts it. When it is not found, they go on.
function stockSearchOf(h: Harness) {
  return `${stockFindOf(h)}[ -n "$STOCK_BIN" ] && exec "$STOCK_BIN" "$@"
`
}
// Shell lines that set STOCK_BIN to the stock harness, found the same way,
// or leave it empty.
function stockFindOf(h: Harness) {
  const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`
  const installed = (h.installer?.paths ?? []).map((p) => q(p.replace(/^~(?=\/|$)/, homedir())))
  // Another program of the same name is not the stock harness.
  const marker = h.stockMarker ? ` && LC_ALL=C grep -aqE ${q(h.stockMarker)} "$d/${h.binary}"` : ""
  return `STOCK_BIN=
OLD_IFS=$IFS; IFS=:
for d in $PATH; do
  IFS=$OLD_IFS
  [ -z "$STOCK_BIN" ] && [ -n "$d" ] && [ -f "$d/${h.binary}" ] && [ -x "$d/${h.binary}" ] && ! [ "$d/${h.binary}" -ef ${q(path.join(BIN, h.binary))} ]${marker} && STOCK_BIN=$d/${h.binary}
done
IFS=$OLD_IFS
${installed.length ? `for d in ${installed.join(" ")}; do
  [ -z "$STOCK_BIN" ] && [ -f "$d/${h.binary}" ] && [ -x "$d/${h.binary}" ]${marker} && STOCK_BIN=$d/${h.binary}
done
` : ""}`
}

function stockLauncherOf(h: Harness) {
  const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`
  return `#!/bin/sh
# openmods launcher for ${h.binary}, switched off: it starts your stock ${h.name}.
# \`openmods on\` brings the mods back.
${stockSearchOf(h)}printf '%s\n' ${q(`${h.binary}: your stock ${h.name} was not found. Install it, or run \`openmods on\` for the modded build.`)} >&2
exit 127
`
}

// Shell lines that hand the run to the stock harness when the user's
// arguments include one of stockWhen's words (for uses that share state with
// the stock harness, such as Codex's shared background server). With no stock
// harness to be found, the run stops and says so: the modded build never
// takes those uses.
function stockWhenOf(h: Harness) {
  if (!h.stockWhen?.length) return ""
  const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`
  const install = h.installer?.command ? ` Install it (${h.installer.command}), then run this again.` : " Install it, then run this again."
  return `${matchArgsOf(h, h.stockWhen, "OPENMODS_STOCK")}if [ -n "$OPENMODS_STOCK" ]; then
${stockSearchOf(h)}  printf '%s\n' ${q(`${h.binary}: this runs your stock ${h.name}, which was not found. OpenMods always sends this use to your stock ${h.name}: it manages what stock shares with the modded build (such as a background server or saved sessions), or stock's own install.${install}`)} >&2
  exit 127
fi
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
    if (existsSync(candidate) && isStock(h, candidate)) return candidate
  }
  return null
}
// Whether a program of the harness's name is the harness: it carries the
// stockMarker, when the harness has one. Read, never run.
function isStock(h: Harness, file: string) {
  if (!h.stockMarker) return true
  try {
    return new RegExp(h.stockMarker).test(readFileSync(file).toString("latin1"))
  } catch {
    return false
  }
}

async function versionOf(bin: string | null) {
  if (!bin) return null
  const out = await $`${bin} --version`.nothrow().quiet()
  return out.exitCode === 0 ? out.stdout.toString().trim().split("\n")[0] ?? null : null
}

const pathHasBin = () => (process.env.PATH ?? "").split(path.delimiter).some((d) => d && path.resolve(d) === BIN)

// What `binary` runs in this shell: the first one on its PATH.
// As the shell looks: the first executable file of that name, not a folder.
const firstOnPath = (binary: string) =>
  (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((d) => path.join(path.resolve(d), binary))
    .find((f) => {
      try {
        accessSync(f, constants.X_OK)
        return statSync(f).isFile()
      } catch {
        return false
      }
    }) ?? null

// A line that can put a folder in front of ~/.openmods/bin: one that sets
// PATH, or runs a script that may, as nvm's `\. "$NVM_DIR/nvm.sh"` does.
// zsh's `path=(~/.local/bin $path)` included.
const setsPath = (l: string) => !l.trim().startsWith("#") && /PATH|(^|[\s;&|])path(\+?=|\[)|fish_add_path|shellenv|(^|&&|;|\|\|)\s*\\?(\.|source)\s/.test(l)

// Keeps ~/.openmods/bin at the front of PATH in the user's shell config.
// Adds the line once. If a later line can put something in front of it, such
// as a harness installer that appended its own PATH line, the openmods line
// moves back to the end so modded builds still go first. bash on Linux also
// gets it in the file a login shell (an SSH session, say) reads: that file
// reads ~/.bashrc and may then put folders first, as Ubuntu's ~/.profile
// does with ~/.local/bin, where Codex installs. Returns each file it edited
// and whether it added or moved the line. With no such file, it is ~/.profile:
// bash's login shell reads none, and ~/.bashrc only from one of them.
function setupPath(): PathEdit[] {
  if (has("no-path") || process.platform === "win32") return []
  const shell = path.basename(process.env.SHELL ?? "")
  const home = homedir()
  const files =
    shell === "zsh"
      ? [path.join(home, ".zshrc")]
      : shell === "fish"
        ? [path.join(home, ".config", "fish", "config.fish")]
        : process.platform === "darwin"
          ? [path.join(home, ".bash_profile")]
          : [path.join(home, ".bashrc"), [".bash_profile", ".bash_login"].map((f) => path.join(home, f)).find((f) => existsSync(f)) ?? path.join(home, ".profile")]
  const line =
    shell === "fish"
      ? `fish_add_path --prepend --move ${pretty(BIN).replace("~", "$HOME")}  # openmods`
      : `export PATH="${pretty(BIN).replace("~", "$HOME")}:$PATH"  # openmods`
  const block = `# openmods: modded builds go first; \`openmods off\` steps aside\n${line}\n`
  const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : "")
  const edits: PathEdit[] = []
  // A startup file that cannot be written (read-only, or managed by a tool
  // such as home-manager) is left alone, and the line is shown to add by hand.
  // The new text is written whole beside the file and moved over it, so a
  // write that fails (a full disk, say) never leaves the file cut short; a
  // link to the file (dotfiles kept elsewhere) stays a link.
  const write = (rc: string, text: string, moved: boolean) => {
    try {
      mkdirSync(path.dirname(rc), { recursive: true })
      // A link whose target does not exist yet is written through too.
      const link = (() => {
        try {
          return lstatSync(rc).isSymbolicLink()
        } catch {
          return false
        }
      })()
      const target = existsSync(rc) ? realpathSync(rc) : link ? path.resolve(path.dirname(rc), readlinkSync(rc)) : rc
      const mode = existsSync(target) ? (accessSync(target, constants.W_OK), statSync(target).mode & 0o7777) : 0o644
      const tmp = `${target}.openmods-${process.pid}`
      try {
        writeFileSync(tmp, text, { mode })
        renameSync(tmp, target)
      } finally {
        rmSync(tmp, { force: true })
      }
      edits.push({ rc, moved })
    } catch (e) {
      edits.push({ rc, moved, failed: (e as NodeJS.ErrnoException).code ?? "it could not be written", line })
    }
  }
  for (const rc of files) {
    const current = read(rc)
    const lines = current.split("\n")
    const last = lines.findLastIndex((l) => l.includes("# openmods"))
    if (last >= 0) {
      if (!lines.slice(last + 1).some(setsPath)) continue
      const kept = lines.filter((l) => !l.includes("# openmods")).join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n")
      write(rc, `${kept}\n${block}`, true)
      continue
    }
    // Not when PATH already has it some other way; the login file only
    // alongside ~/.bashrc's line.
    // (Also when ~/.bashrc could not be written: a login shell must still
    // put ~/.openmods/bin first.)
    if (rc === files[0] ? pathHasBin() : !read(files[0]!).includes("# openmods") && !edits.some((e) => e.rc === files[0] && e.failed)) continue
    write(rc, `${current}${current.endsWith("\n") || current === "" ? "" : "\n"}\n${block}`, false)
  }
  return edits
}

// What was edited, and how to have it in the current terminal.
type PathEdit = { rc: string; moved: boolean; failed?: string; line?: string }
function explainPath(edits: PathEdit[]) {
  const added = edits.filter((e) => !e.moved && !e.failed).map((e) => pretty(e.rc))
  const moved = edits.filter((e) => e.moved && !e.failed).map((e) => pretty(e.rc))
  if (added.length) log(`Added ${pretty(BIN)} to the front of PATH in ${added.join(" and ")}.`)
  if (moved.length) log(`Moved the openmods line to the end of ${moved.join(" and ")}, so ${pretty(BIN)} stays first on PATH after a line added later.`)
  for (const e of edits.filter((x) => x.failed))
    log(`Could not edit ${pretty(e.rc)} (${e.failed}). Add this line at the end of your shell's startup file yourself, so ${pretty(BIN)} comes first on PATH:\n  ${e.line}`)
  log(`Open a new terminal, or run this in the current one:`)
  log(`  export PATH="${pretty(BIN).replace("~", "$HOME")}:$PATH"`)
}

async function explainSwitch(h: Harness, entry: State[string]) {
  const stock = stockBinary(h)
  log("")
  if (entry.enabled) {
    const active = entry.mods.filter((m) => !entry.off.includes(m))
    log(`\`${h.binary}\` now runs ${h.name} ${rel(entry.ref)} + ${active.join(" + ")}${entry.off.length ? ` (off: ${entry.off.join(", ")})` : ""}.`)
    if (stock) log(`Your stock ${h.name} is untouched at ${pretty(stock)}. \`openmods off\` switches back to it.`)
  } else {
    log(`\`${h.binary}\` runs your stock ${h.name} again${stock ? ` (${pretty(stock)})` : ""}. \`openmods on\` brings the mods back.`)
  }
  if (!entry.enabled) return
  const edits = setupPath()
  const found = firstOnPath(h.binary)
  const shell = path.basename(process.env.SHELL ?? "")
  if (edits.length) {
    log("")
    explainPath(edits)
  } else if (!pathHasBin()) {
    log("")
    log(`Note: ${pretty(BIN)} is not on PATH in this shell. Open a new terminal, or run:`)
    log(`  export PATH="${pretty(BIN).replace("~", "$HOME")}:$PATH"`)
  } else if (found && path.dirname(found) !== BIN) {
    log("")
    log(`Note: in this terminal \`${h.binary}\` still finds ${pretty(found)} first. Run:`)
    log(`  export PATH="${pretty(BIN).replace("~", "$HOME")}:$PATH"`)
    log(`If a new terminal does the same, move the openmods line in your shell's startup file below the one that adds ${pretty(path.dirname(found))}.`)
  } else if (stock && shell !== "fish" && (launchersSince()[h.binary] ?? 0) - ((await shellStarted()) ?? 0) > STARTED_WITHIN) {
    log("")
    log(`If \`${h.binary}\` still starts your stock ${h.name} in a terminal that ran it before, run \`hash -r\` there once; the shell remembers where it found it.`)
  }
}

// What install.sh runs, and safe to run again: ~/.openmods/bin first on PATH,
// and a launcher in front of each harness installed here that starts the
// stock one until a mod is installed. A shell remembers where it first found
// a command, so with the launcher there before that, installing a mod
// changes what `codex` runs at once, even in a terminal that already ran it.
async function cmdSetup() {
  const reg = await ensureRegistry()
  // The installer runs this from the release it fetched, and names it: the
  // program goes to its own copy, where it runs from then on. Otherwise setup
  // only puts the launchers and PATH right.
  const release = process.env.OPENMODS_RELEASE
  if (release && reg === path.join(HOME, "registry")) {
    if (!RELEASE.test(release)) fail(`OPENMODS_RELEASE must be a version like 1.2.3, not "${release}"`)
    const cli = await installCli(reg, release).catch((e: unknown) => e as Error)
    if (cli instanceof Error) fail(`could not set OpenMods up in ${pretty(CLI_DIR)}: ${cli.message}`)
  }
  const put = allHarnesses(reg).filter((h) => !existsSync(path.join(BIN, h.binary)) && stockBinary(h))
  for (const h of put) writeLauncher(h, stockLauncherOf(h))
  const names = put.map((h) => `\`${h.binary}\``)
  if (put.length)
    log(`${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]} now start${put.length > 1 ? "" : "s"} through ${pretty(BIN)}: the stock build until you install a mod.`)
  const edits = setupPath()
  if (edits.length) explainPath(edits)
}

// `adding` names the mods this rebuild brings in (install, on), so a clash is
// reported as theirs and the advice points at the mods already there.
// The release is `target` when given (update), else the one the user is on
// if every mod has a version for it, else the newest release they all have.
// Nothing else moves the user to another release.
// A shared server the stock harness uses that was set up from one of our
// modded builds: by an older openmods (its version carries our stamp) or a
// copy of the current build. OpenMods never touches it; it says how to give
// it back to the stock harness with the harness's own command.
function moddedServer(h: Harness, e: State[string] | undefined): string | null {
  const s = h.sharedServer
  if (!s) return null
  const home = (s.homeEnv && process.env[s.homeEnv]) || s.home.replace(/^~(?=\/|$)/, homedir())
  const server = path.join(home, s.binary)
  try {
    if (!statSync(server).isFile()) return null
    // Read, never run: the version it was packaged with, which an older
    // openmods stamped with the mods.
    if (s.versionFile) {
      try {
        if (String(readJsonFile(path.join(home, s.versionFile)).version ?? "").includes("+")) return server
      } catch {}
    }
    if (e?.artifact && statSync(e.artifact).size === statSync(server).size) {
      const digest = (f: string) => new Bun.CryptoHasher("sha256").update(readFileSync(f)).digest("hex")
      if (digest(e.artifact) === digest(server)) return server
    }
  } catch {}
  return null
}
function moddedServerNote(h: Harness, e: State[string] | undefined): string | null {
  const server = moddedServer(h, e)
  if (!server) return null
  const stock = stockBinary(h)
  const reset = stock
    ? `run: ${pretty(stock)} ${h.sharedServer!.reset}`
    : `install your stock ${h.name}${h.installer?.command ? ` (${h.installer.command})` : ""}, then run its ${h.binary} with: ${h.sharedServer!.reset}`
  return `note: ${h.name}'s background server (${pretty(server)}) was set up from a modded build, and your stock ${h.name} uses it too. To give it back to your stock ${h.name}, ${reset}`
}

// What the harness command starts now, read from its launcher.
function whatRuns(h: Harness, e: State[string] | undefined) {
  const launcher = path.join(BIN, h.binary)
  let text = ""
  try {
    text = readFileSync(launcher, "utf8")
  } catch {
    return `your stock ${h.name}`
  }
  if (text.includes(REVOKED_MARK)) return `your stock ${h.name}, since your build has a mod removed from OpenMods`
  if (text.startsWith("#!/bin/sh\n# openmods dev:")) return `your clone (openmods dev)`
  const artifact = /^exec '((?:[^']|'\\'')*)'/m.exec(text)?.[1]?.replaceAll("'\\''", "'")
  if (!artifact) return `your stock ${h.name}`
  if (!existsSync(artifact)) return `nothing: its build is missing (\`openmods update --force\` makes it again)`
  return e ? `${h.name} ${rel(e.ref)} + ${e.mods.filter((m) => !e.off.includes(m)).join(" + ")}` : `your modded ${h.name}`
}

// With \`plan\`, it only checks and asks, and changes nothing: an install on
// several harnesses asks every question before it builds any of them. With
// \`asked\`, the questions were answered by such a plan.
async function rebuild(reg: string, harnessId: string, all: Mod[], off: string[] = [], adding: string[] = [], target?: string, opts: { plan?: boolean; asked?: boolean } = {}) {
  const h = loadHarness(reg, harnessId)
  // What the launcher would say next is about the build this replaces.
  rmSync(path.join(HOME, "updates", harnessId), { force: true })
  const root = path.join(HOME, "harnesses", harnessId, "src")
  const state = loadState()
  const ask = opts.asked ? async (_q: string) => {} : askUser
  if (all.length === 0) {
    if (opts.plan) return
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
    log(`Removed the modded ${h.name} build${prev ? ` (${rel(prev.ref)} + ${prev.mods.join(" + ")})` : ""}: its binary and its patched commits are gone.`)
    log(`\`${h.binary}\` runs your stock ${h.name}. The ${h.name} source checkout stays at ${pretty(root)} as a cache; delete it if you want the space back.`)
    return
  }
  const active = all.filter((m) => !off.includes(m.id))
  if (active.length === 0) {
    if (opts.plan) return
    switchOff(h)
    state[harnessId] = { ...(state[harnessId] ?? { ref: all[0]!.upstream.ref, commit: all[0]!.upstream.commit, artifact: "" }), mods: all.map((m) => m.id), off: [...off], hashes: {}, updates: {}, enabled: false }
    saveState(state)
    log(`Every ${h.name} mod is built out (${off.join(", ")}), so \`${h.binary}\` runs your stock ${h.name}. \`openmods install ${off[0]} --${harnessId}\` builds one back in.`)
    return
  }
  // One release for all of them, and each mod's version for it.
  const current = state[harnessId]?.ref
  const set = active
  const shared = sharedReleases(set)
  if (shared.length === 0) {
    // Which of the mods already there leave the new ones no release: the
    // user decides whether to uninstall them, never openmods.
    // Of the releases the new mods share, the one the fewest installed mods
    // lack; those are what would have to go.
    const added = active.filter((m) => adding.includes(m.id))
    const others = active.filter((m) => !adding.includes(m.id))
    const options = added.length ? sharedReleases(added).map((r) => ({ r, blocking: others.filter((m) => !at(m, r)) })) : []
    const best = options.sort((a, b) => a.blocking.length - b.blocking.length)[0]
    const advice = !added.length
      ? ""
      : !best
        ? ` ${added.map((m) => m.id).join(" and ")} have no release in common with each other either.`
        : ` To have ${added.map((m) => m.id).join(" and ")}, uninstall ${best.blocking.map((m) => m.id).join(" and ")} first: openmods uninstall ${best.blocking.map((m) => m.id).join(" ")}`
    fail(`${active.map((m) => m.id).join(" and ")} have no ${h.name} release in common, so they cannot be built together: ${releasesSaid(active)}. Nothing was changed.${advice}`)
  }
  const release = target
    ? shared.includes(target)
      ? target
      : fail(`not every mod has a version for ${h.name} ${rel(target)}: ${releasesSaid(set)}`)
    : current && shared.includes(current)
      ? current
      : shared[0]!
  // Another release than the user expects is asked about first.
  if (current && release !== current && !target) {
    const lacking = set.filter((m) => !at(m, current))
    const who = `${lacking.map((m) => shown(m.id)).join(", ")} ${lacking.length === 1 ? "has" : "have"} no version for ${rel(current)}`
    await ask(
      newerRelease(release, current)
        ? `This also updates ${h.name} from ${rel(current)} to ${rel(release)} for all your mods, since ${who}. Go ahead?`
        : `This moves ${h.name} from ${rel(current)} back to ${rel(release)} for all your mods, since ${who}. Go ahead?`,
    )
  } else if (!current && adding.length) {
    const stock = await versionOf(stockBinary(h))
    const have = stock?.replace(/^[^0-9]*/, "")
    if (have && newerRelease(have, release)) {
      const who = active.map((m) => m.id).join(" and ")
      await ask(
        `${h.name} ${rel(release)} is the newest release ${who} ${active.length === 1 ? "has" : "have"} a version for; your ${h.name} is ${have}. Build ${h.name} ${rel(release)} with ${active.length === 1 ? "it" : "them"}? Your own ${h.name} stays ${have}; sessions and settings from the newer one may not all work in the older build.`,
      )
    }
  }
  // A clone running with openmods dev gives way to the build only on a yes.
  const dev = devOf(harnessId)
  if (dev) await ask(`\`${h.binary}\` runs your clone at ${pretty(dev.path)} (openmods dev). This switches it to the modded build. Go ahead?`)
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
      const ids = clashes.map((c) => c.id)
      fail(
        `${order[j]!.id} does not work with ${clashes.map((c) => `${shown(c.id)} on ${h.name}: ${c.why}`).join("; nor with ")}. ${
          ids.length
            ? `They cannot be on at the same time, so nothing was changed. \`openmods uninstall ${ids.join(" ")}\` makes room.`
            : "Every modded build carries that patch, so this mod cannot be installed until its author moves those lines. Nothing was changed."
        }`,
      )
    }
  }
  if (opts.plan) return
  // Only now that there is something to build: turning mods off or removing
  // them needs none of it.
  await checkRequirements(h)
  holdBuildLock(harnessId, h)
  // If the build fails, nothing is switched: say what still runs, as the
  // launcher has it, and what to do, by the step that failed.
  const runs = whatRuns(h, state[harnessId])
  const failing = adding.length ? `${adding.join(" and ")} could not be built${active.length > adding.length ? ` with your other ${h.name} mods` : ""}.` : `The new ${h.name} build could not be made.`
  failNote = () => {
    const step = progress?.lastStep
    // Fetching the source or dependencies: the progress output already says
    // when that was a download, so nothing is guessed here.
    const advice =
      adding.length && (step === "Patches" || step === "Build")
          ? `If it fails again, \`openmods info ${adding[0]}\` shows who maintains it, to tell them.`
          : ""
    return ["", `${failing} Nothing changed: \`${h.binary}\` still runs ${runs}.`, ...(advice ? [advice] : [])]
  }
  const base = mods[0]!.upstream
  const builds = path.join(HOME, "harnesses", harnessId, "builds")
  const first = !existsSync(builds) || readdirSync(builds).length === 0
  progress = new Progress(live(), harnessId, first, path.join(HOME, "timings.json"), path.join(HOME, "logs"), color)
  const named = mods.map((m) => m.id)
  progress.title(`${h.name} ${rel(base.ref)} + ${named.join(" + ")}`)
  await progress.run("Source", () => ensureCheckout(h, root, base.commit, base.ref))
  await progress.run("Patches", () => applyMods(root, mods))
  buildEnv = {
    OPENMODS_HARNESS: harnessId,
    OPENMODS_REF: base.ref,
    OPENMODS_VERSION: base.ref.replace(/^[^0-9]*/, ""),
    OPENMODS_MODS: stampOf(mods),
  }
  await build(h, root).catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)))
  const was = state[harnessId]?.ref
  const artifact = keepBuild(h, harnessId, root, `${rel(base.ref)}+${stampOf(mods)}`, state[harnessId]?.artifact)
  progress = undefined
  failNote = undefined
  // The files the mods change, for what the launcher does beside the stock
  // harness (sameRelease).
  // Separated by NUL, so git does not quote unusual names.
  const changed = (await $`git -C ${root} diff --name-only -z ${base.commit} HEAD`.quiet()).text().split("\0").filter(Boolean)
  state[harnessId] = {
    ref: base.ref,
    commit: base.commit,
    mods: all.map((m) => m.id),
    off: off.filter((n) => all.some((m) => m.id === n)),
    hashes: Object.fromEntries(mods.map((m) => [m.id, patchHash(m)])),
    updates: Object.fromEntries(mods.map((m) => [m.id, m.update])),
    artifact,
    enabled: true,
    plain: true,
    changed,
  }
  switchOn(h, state[harnessId]!)
  saveState(state)
  // The launcher's note described the build this replaces; cleared again now,
  // in case a look that began before the build wrote one meanwhile.
  rmSync(path.join(HOME, "updates", harnessId), { force: true })
  await tidy(root, base.ref, !!was && was !== base.ref)
  await explainSwitch(h, state[harnessId]!)
}

// One build of a harness at a time: two would check out and patch the same
// checkout at once. Held until this process exits. A lock is someone else's
// only while its process runs and started before the lock was written, so a
// lock left by a killed build is taken over even if its process id has been
// reused since.
function holdBuildLock(harnessId: string, h: Harness) {
  const lock = path.join(HOME, "harnesses", harnessId, "build.lock")
  mkdirSync(path.dirname(lock), { recursive: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" })
      process.on("exit", () => {
        try {
          if (readFileSync(lock, "utf8") === String(process.pid)) rmSync(lock, { force: true })
        } catch {}
      })
      return
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
    }
    let held: string
    let written: number
    try {
      held = readFileSync(lock, "utf8")
      written = lstatSync(lock).mtimeMs
    } catch {
      continue
    }
    const pid = Number(held)
    if (lockOwnerRuns(pid, written)) fail(`another openmods is building ${h.name} right now (process ${pid}). Try again when it finishes.`)
    // Moved aside, not removed: if another openmods took the lock over first,
    // what was moved is its lock, and it goes back.
    const aside = `${lock}.${process.pid}`
    try {
      renameSync(lock, aside)
    } catch {
      continue
    }
    if (readFileSync(aside, "utf8") !== held) {
      try {
        linkSync(aside, lock)
      } catch {}
      rmSync(aside, { force: true })
      fail(`another openmods is building ${h.name} right now. Try again when it finishes.`)
    }
    rmSync(aside, { force: true })
  }
  fail(`could not take the ${h.name} build lock at ${pretty(lock)}`)
}

// Whether a lock's process still runs and is the one that wrote it: it
// started before the lock was written. Without ps to ask, a lock is trusted
// for 12 hours, longer than any build.
// Whether a build of the harness is running now: its lock is held by a live
// process. A lock a killed build left behind does not count.
function building(harnessId: string) {
  const lock = path.join(HOME, "harnesses", harnessId, "build.lock")
  try {
    return lockOwnerRuns(Number(readFileSync(lock, "utf8")), lstatSync(lock).mtimeMs)
  } catch {
    return false
  }
}

function lockOwnerRuns(pid: number, written: number) {
  if (!(pid > 0) || pid === process.pid) return false
  try {
    process.kill(pid, 0)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false
  }
  let r: ReturnType<typeof Bun.spawnSync> | undefined
  try {
    r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)])
  } catch {} // no ps on this machine
  const started = r ? Date.parse(String(r.stdout ?? "").trim()) : Number.NaN
  if (!r || r.exitCode !== 0 || Number.isNaN(started)) return Date.now() - written < 12 * 3_600_000
  // ps gives the second, and on Linux can be a second early.
  return started <= written + 2000
}

// After a build, what this machine no longer needs goes, so disk use stays
// about where one build of each harness puts it, however many updates come.
// `moved` is the release a harness just moved to from another one. A harness's
// own build folder keeps itself in check in its recipe (Codex's does). All of
// it is best-effort: a build that worked never fails for it.
async function tidy(root: string, ref: string, moved: boolean) {
  try {
    // The old releases' tags, and what only they reached. Checked on every
    // build, so a cleanup that failed is tried again; a later build of an
    // older release fetches it again.
    const tags = (await $`git -C ${root} tag`.nothrow().quiet().text()).split("\n").filter((t) => t && t !== ref)
    if (tags.length) {
      await $`git -C ${root} tag -d ${tags}`.nothrow().quiet()
      await $`git -C ${root} reflog expire --expire=now --all`.nothrow().quiet()
      await $`git -C ${root} gc --prune=now --quiet`.nothrow().quiet()
    }
    // Bun's download cache holds the old release's packages too; what the new
    // one uses is installed in the checkout already.
    if (moved && existsSync(path.join(root, "bun.lock"))) rmSync(path.join(HOME, "cache", "bun"), { recursive: true, force: true })
    // Bun versions nothing uses now: kept are the one openmods itself runs on,
    // those the harnesses' releases pin, those a dev clone runs with, and any
    // put there in the last hour, which another openmods may be setting up.
    const dir = path.join(HOME, "toolchains")
    if (!existsSync(dir)) return
    const keep = new Set([`bun-${process.versions.bun}`])
    const own = existsSync(path.join(BIN, "openmods")) ? readFileSync(path.join(BIN, "openmods"), "utf8").match(/toolchains\/(bun-[^/\s]+)\//) : null
    if (own) keep.add(own[1]!)
    // A harness whose pin cannot be read might need any of them: none go.
    for (const id of Object.keys(loadState())) for (const pin of pinnedToolchains(path.join(HOME, "harnesses", id, "src"))) keep.add(pin)
    for (const d of Object.values(loadDev())) if (d.toolchain) keep.add(path.basename(path.dirname(d.toolchain)))
    for (const name of readdirSync(dir)) {
      if (!/^(bun|zig)-/.test(name) || keep.has(name)) continue
      try {
        if (Date.now() - lstatSync(path.join(dir, name)).mtimeMs < 3_600_000) continue
        rmSync(path.join(dir, name), { recursive: true, force: true })
      } catch {}
    }
  } catch {}
}

// ---------------------------------------------------------------- commands

async function cmdList() {
  const reg = await refreshRegistry()
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
  const reg = await refreshRegistry()
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
  const reg = await refreshRegistry()
  let specs = positional.slice(1)
  if (specs.length === 0) fail("install needs a mod, e.g. openmods install shouryamaanjain/space-invaders --opencode. `openmods list` shows what is available.")
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
    declined = `Nothing was installed. Your commits stay packed as the local mod ${packed.owner}/${packed.name} in ${pretty(LOCAL)}.`
    specs = [`${packed.owner}/${packed.name}`]
    flags.set(packed.harness, true)
  }
  const wanted: Mod[] = []
  for (const spec of specs) wanted.push(...(await chooseHarnesses(reg, spec, "Install", { needHarness: true })))
  const state = loadState()
  const plans = [...new Set(wanted.map((m) => m.harness))].map((id) => {
    const current = (state[id]?.mods ?? []).map((n) => resolveMod(reg, n, id))
    const here = wanted.filter((w) => w.harness === id)
    const merged = [...current.filter((c) => !here.some((w) => w.id === c.id)), ...here]
    const off = (state[id]?.off ?? []).filter((n) => !here.some((w) => w.id === n))
    return { id, merged, off, adding: here.map((m) => m.id) }
  })
  // Every check and question first, on every harness, so a no or a refusal
  // leaves all of them as they were.
  // What each harness looked like when asked: if it changed before its turn
  // to build (a dev session started in another terminal, say), it asks again.
  const looked = (id: string) => JSON.stringify([loadState()[id] ?? null, devOf(id) ?? null])
  const seen = new Map<string, string>()
  for (const p of plans) {
    await rebuild(reg, p.id, p.merged, p.off, p.adding, undefined, { plan: true })
    seen.set(p.id, looked(p.id))
  }
  for (const p of plans) await rebuild(reg, p.id, p.merged, p.off, p.adding, undefined, { asked: seen.get(p.id) === looked(p.id) })
}

async function cmdUninstall() {
  const reg = await ensureRegistry()
  const specs = positional.slice(1)
  if (specs.length === 0) fail("uninstall needs a mod, e.g. openmods uninstall shouryamaanjain/space-invaders. `openmods status` shows what is installed.")
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
  // A state file that cannot be read still leaves where things are to say.
  let state: State
  try {
    state = loadState()
  } catch (e) {
    // On stderr, so --json output stays empty and still says why.
    console.error(`error: ${pretty(statePath)} cannot be read (${e instanceof Error ? e.message : String(e)}), so what is installed is not known.`)
    whereFrom(reg)
    process.exit(1)
  }
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
    whereFrom(reg)
    return
  }
  for (const id of ids.filter((i) => !dev[i])) {
    const h = loadHarness(reg, id)
    const e = state[id]!
    const stock = stockBinary(h)
    e.artifact ||= artifactPath(h, path.join(HOME, "harnesses", id, "src"))
    const built = existsSync(e.artifact)
    const onPath = pathHasBin()
    const first = firstOnPath(h.binary)
    const reaches = !!first && path.dirname(first) === BIN
    const runs = e.enabled && built && reaches ? "modded" : "stock"
    log(`${h.binary} → ${runs}`)
    const active = e.mods.filter((m) => !e.off.includes(m))
    log(`  modded  ${h.name} ${rel(e.ref)} + ${active.join(" + ") || "(nothing)"}  ${e.enabled ? "on" : "off (openmods on)"}${built || !active.length ? "" : "  [not built; run openmods update]"}`)
    for (const m of e.off) log(`          ${m} is built out (openmods install ${m} --${id} builds it back in)`)
    log(`  stock   ${stock ? `${(await versionOf(stock)) ?? "?"}  ${pretty(stock)}` : "not found on PATH"}`)
    for (const b of revokedIn(reg, id, e)) log(`  removed ${b.id} was removed from OpenMods: ${b.reason} \`openmods uninstall ${b.id}\``)
    const server = moddedServerNote(h, e)
    if (server) log(`  ${server}`)
    const note = e.enabled ? readNote(id) : null
    if (note?.MESSAGE) log(`  news    ${note.MESSAGE}${note.ASK === "1" ? ` \`openmods update ${id}\` does it.` : ""}`)
    if (e.enabled && !onPath) log(`  note    ${pretty(BIN)} is not on PATH in this shell; open a new terminal or run: export PATH="${pretty(BIN).replace("~", "$HOME")}:$PATH"`)
    else if (e.enabled && !reaches && first) log(`  note    in this terminal \`${h.binary}\` finds ${pretty(first)} first; run: export PATH="${pretty(BIN).replace("~", "$HOME")}:$PATH"`)
  }
  whereFrom(reg)
}

// Where the mods list and OpenMods itself come from, at the end of status:
// the version of the program running now, which an installed copy records
// beside its code; a checkout has none.
function whereFrom(reg: string) {
  let version = ""
  try {
    version = readFileSync(path.join(import.meta.dir, "..", ".version"), "utf8").trim()
  } catch {}
  log("")
  log(`mods list  ${pretty(reg)}${reg === path.join(HOME, "registry") ? "" : " (a registry checkout)"}`)
  log(`openmods   ${version || `run from ${pretty(path.resolve(import.meta.dir, "..", ".."))}`}, home ${pretty(HOME)}`)
}

// \`on\`/\`off\` switch a harness's command between its modded build and the
// stock one, instantly, keeping the build. Adding or removing a mod is
// \`install\` and \`uninstall\`.
// The harness is named as on every other command: `openmods off codex`,
// `--codex` or `--harness codex`; with none named, every harness with mods.
function harnessTarget(reg: string, state: State, arg: string | undefined, verb: "on" | "off"): string[] {
  if (arg?.includes("/"))
    fail(`\`openmods ${verb}\` switches a whole harness between its modded build and your stock one. To ${verb === "on" ? "add" : "remove"} ${arg}: openmods ${verb === "on" ? "install" : "uninstall"} ${arg}`)
  const named = [...new Set([...(arg ? [arg] : []), ...harnessFlags(reg)])]
  for (const id of named) if (!state[id]) fail(`no mods installed for "${id}"; \`openmods status\` lists what is`)
  return named.length ? named : Object.keys(state)
}

async function cmdOn() {
  const reg = await ensureRegistry()
  const state = loadState()
  const ids = harnessTarget(reg, state, positional[1], "on")
  if (ids.length === 0) fail("nothing to switch on; install a mod first")
  for (const id of ids) {
    const e = state[id] ?? fail(`no mods installed for ${id}`)
    const h = loadHarness(reg, id)
    // Mods built out with an older openmods's \`off <mod>\` come back with install.
    if (e.mods.every((m) => e.off.includes(m))) fail(`every ${h.name} mod is built out; \`openmods install ${e.off[0]} --${id}\` builds one back in`)
    e.artifact ||= artifactPath(h, path.join(HOME, "harnesses", id, "src"))
    if (!existsSync(e.artifact)) fail(`the modded ${h.name} build is missing; run: openmods update ${id}`)
    const bad = revokedIn(reg, id, e)
    if (bad.length) fail(`this ${h.name} build has ${bad.map((b) => `${b.id}, which was removed from OpenMods: ${b.reason}`).join("; ")} \`openmods uninstall ${bad.map((b) => b.id).join(" ")}\` removes it.`)
    switchOn(h, e)
    e.enabled = true
    saveState(state)
    await explainSwitch(h, e)
  }
}

async function cmdOff() {
  const reg = await ensureRegistry()
  const state = loadState()
  const ids = harnessTarget(reg, state, positional[1], "off")
  if (ids.length === 0) fail("nothing to switch off")
  for (const id of ids) {
    const e = state[id] ?? fail(`no mods installed for ${id}`)
    const h = loadHarness(reg, id)
    switchOff(h)
    e.enabled = false
    saveState(state)
    await explainSwitch(h, e)
  }
}

async function cmdUpdate() {
  const reg = await refreshRegistry()
  const cli = reg === path.join(HOME, "registry") ? await installCli(reg).catch((e: unknown) => e as Error) : null
  if (cli instanceof Error) console.error(`note: could not update OpenMods itself (${cli.message}); it stays as it is.`)
  else if (cli) log(cli.from ? `OpenMods is updated: ${cli.from} → ${cli.to}. Your next command runs it.` : `OpenMods ${cli.to} is set up in ${pretty(CLI_DIR)}.`)
  const state = loadState()
  const picked = [...new Set([...(positional[1] ? [positional[1]] : []), ...harnessFlags(reg)])]
  const ids = picked.length ? picked : Object.keys(state)
  for (const id of ids) {
    const e = state[id]
    if (!e) {
      log(`No mods are installed for ${loadHarness(reg, id).name}; nothing to update.`)
      continue
    }
    // A revoked mod has nothing to update it to.
    const bad = devOf(id) ? [] : revokedIn(reg, id, e)
    if (bad.length) {
      log(stopRevoked(loadHarness(reg, id), e, bad))
      continue
    }
    const mods = (e?.mods ?? []).map((n) => resolveMod(reg, n, id))
    const active = mods.filter((m) => !e?.off.includes(m.id))
    // The newest release every mod that is on has a version for. A build
    // that still carries OpenMods' old patch is made again without it.
    const target = sharedReleases(active)[0]
    const same =
      e &&
      existsSync(e.artifact) &&
      active.length > 0 &&
      target === e.ref &&
      !carriesBase(e) &&
      active.every((m) => {
        const v = at(m, e.ref)
        return v ? e.hashes[m.id] === patchHash(v) : e.hashes[m.id] === undefined
      })
    if (same && !has("force")) {
      const held = heldBack(loadHarness(reg, id), e, active)
      refreshLauncher(reg, loadHarness(reg, id), e)
      log(`${loadHarness(reg, id).name} ${rel(e.ref)} + ${active.map((m) => m.id).join(" + ")} is already up to date.`)
      if (held) log(held)
      const server = moddedServerNote(loadHarness(reg, id), e)
      if (server) log(server)
      continue
    }
    await rebuild(reg, id, mods, e?.off ?? [], [], target)
    const server = moddedServerNote(loadHarness(reg, id), loadState()[id])
    if (server) log(server)
    const now = loadState()[id]
    const still = now && heldBack(loadHarness(reg, id), now, active)
    if (still) log(still)
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
        writeScript(path.join(BIN, h.binary), revokedLauncherOf(h, bad, stockBinary(h)))
        log(`${bad.map((b) => `${b.id} was removed from OpenMods: ${b.reason}`).join(" ")} \`${h.binary}\` runs your stock ${h.name}; \`openmods uninstall ${bad.map((b) => b.id).join(" ")}\` removes it.`)
      } else if (e?.enabled && e.artifact && existsSync(e.artifact)) {
        switchOn(h, e)
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
  writeScript(path.join(BIN, h.binary), devLauncherOf(h, clone, version, toolchain))
  const back = state[h.id]?.enabled ? "your modded build" : `your stock ${h.name}`
  log("")
  log(`\`${h.binary}\` now runs your clone at ${pretty(clone)} from source, as ${h.name} ${version}.`)
  log(`Edit, then start \`${h.binary}\` again to see the change: nothing to commit, pack or build. \`openmods dev --stop\` switches back to ${back}.`)
  const edits = setupPath()
  if (edits.length) {
    log("")
    explainPath(edits)
  } else if (!pathHasBin()) log(`Note: ${pretty(BIN)} is not on PATH in this shell. Open a new terminal, or run: export PATH="${pretty(BIN).replace("~", "$HOME")}:$PATH"`)
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
  // else the GitHub CLI's login. GitHub handles ignore case; owners are lowercase.
  const detected = (
    (await $`git config --get github.user`.nothrow().quiet().text()).trim() ||
    (await $`gh api user --jq .login`.nothrow().quiet().text()).trim()
  ).toLowerCase()
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
  // Published with the mod: no author's email in them.
  for (const p of patches) writeFileSync(path.join(out, p), withPrivateEmails(readFileSync(path.join(out, p), "utf8"), owner))
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
  // keep what the author filled in, fields pack does not know included.
  const author = (await $`git -C ${checkout} log -1 --format=%an HEAD`.text()).trim()
  const metaFile = path.join(root, "mod.json")
  const existing = existsSync(metaFile) ? readJsonFile(metaFile) : {}
  const meta = {
    ...existing,
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
  // A build or typecheck needs these; found before anything is fetched.
  if (has("build") || has("typecheck")) await checkRequirements(h)
  try {
    await initCheckout(h.repo, root)
    // The default workspace is openmods' own: it follows the recipe if the
    // harness moved to another repository. One given with --workspace is not
    // changed, and must be a clone of the harness's repository. Either way
    // the release's tag is taken as origin has it.
    const origin = (await $`git -C ${root} remote get-url origin`.nothrow().text()).trim()
    if (!sameRepo(origin, h.repo)) {
      if (flag("workspace")) throw new Error(`the workspace ${root} is a clone of ${origin || "nothing"}, not of ${h.repo}`)
      await $`git -C ${root} remote set-url origin ${h.repo}`.quiet()
    }
    await $`git -C ${root} fetch --no-tags --depth 1 --filter=blob:none origin ${`+refs/tags/${ref}:refs/tags/${ref}`}`.quiet()
    await clearApplyState(root)
    await $`git -C ${root} checkout -q --force --detach ${ref}`
    result.commit = (await $`git -C ${root} rev-parse HEAD`.text()).trim()
    // The version is checked as users build it: at the commit it pins, which
    // must be its release's own.
    if (spec && ref === mod.upstream.ref && result.commit !== mod.upstream.commit)
      throw new WrongCommit(`${mod.id} pins ${h.name} ${rel(ref)} as commit ${mod.upstream.commit.slice(0, 12)}, but the tag ${ref} is ${String(result.commit).slice(0, 12)}; a version must pin its release's own commit`)
    const files = mod.patches.map((p) => path.join(mod.dir, p))
    const bases = await fetchBases(root, mod)
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
        .map((f) => ({ name: f, text: withPrivateEmails(readFileSync(path.join(dir, f), "utf8"), mod.id.split("/")[0]!) }))
      rmSync(dir, { recursive: true, force: true })
    }
    if (!result.applies) {
      result.error = (am.stderr.toString() + am.stdout.toString()).trim()
      await clearApplyState(root)
      if (!bases) {
        delete result.applies
        result.unchecked = "could not fetch the release's files the patches were made against"
      }
    }
    if (result.applies && (has("build") || has("typecheck"))) {
      // The stamp must be valid semver build metadata: mod names are, "(stock)" is not.
      buildEnv = { OPENMODS_HARNESS: h.id, OPENMODS_REF: ref, OPENMODS_VERSION: rel(ref), OPENMODS_MODS: mod.patches.length ? mod.name : "stock" }
      if (has("typecheck")) {
        try {
          await typecheck(h, root)
          result.typechecks = true
        } catch (e) {
          if (e instanceof Unchecked) result.unchecked = e.message
          else result.typechecks = false
          result.error = e instanceof Error ? e.message : String(e)
        }
      }
      if (has("build") && result.typechecks !== false && !result.unchecked) {
        try {
          result.artifact = await build(h, root)
          result.builds = true
        } catch (e) {
          if (e instanceof Unchecked) result.unchecked = e.message
          else result.builds = false
          result.error = e instanceof Error ? e.message : String(e)
        }
      }
    }
  } catch (e) {
    // A verdict is only what the checks above found; anything that stopped
    // them (the release could not be fetched, the disk filled up) says
    // nothing about the mod.
    const message = e instanceof Error ? e.message : String(e)
    // Except a version that pins another commit than its release's: that
    // is what the mod is.
    if (e instanceof WrongCommit) result.applies = false
    else result.unchecked = result.applies === undefined ? `could not get ${ref}: ${message}` : `the check stopped: ${message}`
    result.error = message
  }
  if (has("json")) console.log(JSON.stringify(result, null, 2))
  else {
    log(result.stock ? `stock ${mod.harness} at ${rel(ref)} (${String(result.commit ?? "?").slice(0, 12)})` : `${result.mod} (made for ${rel(String(result.madeFor))}) against ${rel(ref)} (${String(result.commit ?? "?").slice(0, 12)})`)
    // Only the verdicts the check reached.
    if (result.applies !== undefined) log(`  applies:    ${result.applies ? "yes" : "NO"}`)
    if (result.typechecks !== undefined) log(`  typechecks: ${result.typechecks ? "yes" : "NO"}`)
    if (result.builds !== undefined) log(`  builds:     ${result.builds ? "yes" : "NO"}`)
    if (result.unchecked) log(`  not checked: ${result.unchecked}. That says nothing about the mod.`)
    if (result.error) log(`  ${String(result.error).split("\n").join("\n  ")}`)
  }
  if (result.unchecked || result.applies !== true || (has("typecheck") && result.typechecks !== true) || (has("build") && result.builds !== true)) process.exit(1)
}

// Whether a launcher's text holds \`mark\`; one that cannot be read does not.
function launcherSays(launcher: string, mark: string) {
  try {
    return readFileSync(launcher, "utf8").includes(mark)
  } catch {
    return false
  }
}

// Every command (asking for help aside), and the launcher's background look,
// keeps the launchers current and stops a revoked mod.
// Commands that pull the registry anyway (aliases included, as they run the
// same function); for them the list of removed mods comes with the pull,
// unless OPENMODS_REVOKED_URL names another list, or the pull failed, or the
// registry's own list cannot be read: then it is fetched on its own.
const pullsFirst = () => [cmdList, cmdInfo, cmdInstall, cmdUpdate, cmdCheckUpdates].includes(commands[positional[0] ?? ""]!)
function registryListReadable(reg: string) {
  try {
    const r = readJsonFile(path.join(reg, "revoked.json")).revoked
    return Array.isArray(r) && r.every(isRevocation)
  } catch {
    return false
  }
}
async function keepCurrent(fetchRevoked: boolean) {
  const reg = await ensureRegistry()
  // Before anything is installed too: install refuses a removed mod.
  let known = false
  if (pullsFirst() && reg === path.join(HOME, "registry") && pullsAllowed && !process.env.OPENMODS_REVOKED_URL) {
    await refreshRegistry()
    known = (await pulled!) && registryListReadable(reg)
  }
  if (!known) known = await fetchRevocations(reg, !fetchRevoked)
  let state: State
  try {
    state = loadState()
  } catch (e) {
    // status reports a state file it cannot read itself; nothing else goes on.
    if (positional[0] === "status") return
    throw e
  }
  for (const [id, e] of Object.entries(state)) {
    if (!existsSync(path.join(reg, "harnesses", `${id}.json`))) continue
    const h = loadHarness(reg, id)
    const bad = devOf(id) ? [] : revokedIn(reg, id, e)
    if (!bad.length) {
      // A build stopped for a removed mod stays stopped while the list
      // cannot be known.
      const launcher = path.join(BIN, h.binary)
      if (known || !launcherSays(launcher, REVOKED_MARK)) {
        try {
          refreshLauncher(reg, h, e)
        } catch (err) {
          // A launcher that could not be brought up to date does not stop
          // status, which is how one finds out; everything else stops.
          if (positional[0] !== "status") throw err
          console.error(`note: could not update ${pretty(path.join(BIN, h.binary))}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      continue
    }
    // Said once, when it stops; status and update say it again.
    const launcher = path.join(BIN, h.binary)
    let now = ""
    try {
      now = readFileSync(launcher, "utf8")
    } catch {}
    const stopped = now === revokedLauncherOf(h, bad, stockBinary(h))
    const said = stopRevoked(h, e, bad)
    if (!stopped && e.enabled) log(said)
  }
}

// The launcher's look for news, run in the background at every start at a
// terminal (keepCurrent has already pulled the registry and stopped any
// removed mod). It reads the mods list the pull brought, which never changes
// OpenMods itself or the build, and leaves a note the launcher shows on its
// next start.
async function cmdCheckUpdates() {
  // Pulled already, by keepCurrent: the registry is the news.
  const reg = await refreshRegistry()
  const state = loadState()
  const known = allHarnesses(reg).map((h) => h.id)
  if (positional[1] && !known.includes(positional[1])) fail(`unknown harness "${positional[1]}". Known: ${known.join(", ")}.`)
  // A harness the registry no longer has gets no news, and loses any old note.
  for (const id of Object.keys(state).filter((x) => !known.includes(x) && ID.test(x))) rmSync(path.join(HOME, "updates", id), { force: true })
  for (const id of positional[1] ? [positional[1]] : Object.keys(state).filter((x) => known.includes(x))) {
    const e = state[id]
    const file = path.join(HOME, "updates", id)
    // Nothing to say for a harness without mods, one running a dev clone, or
    // a build stopped for a removed mod (its launcher says that itself).
    if (!e || !e.enabled || devOf(id) || !existsSync(path.join(reg, "harnesses", `${id}.json`)) || revokedIn(reg, id, e).length) {
      rmSync(file, { force: true })
      continue
    }
    const h = loadHarness(reg, id)
    const n = newsFor(reg, h, e)
    if (!n.key) {
      rmSync(file, { force: true })
      continue
    }
    // A build that started or finished while this looked makes the news
    // stale: the next look says what is true then.
    if (building(id) || JSON.stringify(loadState()[id]) !== JSON.stringify(e)) continue
    const took = lastRebuild(path.join(HOME, "timings.json"), id)
    // The launcher sources this file, so every value is single-quoted; written
    // whole and then moved into place, since a launcher may read it meanwhile.
    const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(`${file}.${process.pid}`, [`KEY=${q(n.key)}`, `ASK=${n.ask ? 1 : 0}`, `MESSAGE=${q(n.message)}`, `ESTIMATE=${q(took === undefined ? "" : roughly(took))}`].join("\n") + "\n")
    renameSync(`${file}.${process.pid}`, file)
    if (has("json")) console.log(JSON.stringify({ harness: id, ...n }))
  }
}

/** The launcher's note for a harness, as check-updates left it. */
function readNote(id: string): Record<string, string> | null {
  let text: string
  try {
    // A background look may remove it at any moment.
    text = readFileSync(path.join(HOME, "updates", id), "utf8")
  } catch {
    return null
  }
  const out: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line)
    if (m) out[m[1]!] = m[2]!.replace(/^'|'$/g, "").replaceAll("'\\''", "'")
  }
  return out
}

/**
 * What to tell a user about one harness: a newer release every mod that is on
 * supports (\`moveTo\`), and fixes of their mods at the release they would be
 * on (\`fixes\`), either one asked about; else a newer release some mods hold
 * back (\`held\`), said once. From the registry, and a local mod from its own
 * folder.
 */
function newsFor(reg: string, h: Harness, e: State[string]) {
  type Rel = { release: string; update: number }
  const mods = listMods(reg, h.id)
  const releasesOf = (id: string): Rel[] => {
    const m = mods.find((x) => x.id === id)
    return m ? m.versions.map((v) => ({ release: rel(v.ref), update: v.update ?? 1 })) : []
  }
  const shared = (list: { releases: Rel[] }[]) =>
    newestFirst(list.reduce<string[]>((acc, m, i) => (i === 0 ? m.releases.map((r) => r.release) : acc.filter((r) => m.releases.some((x) => x.release === r))), []))[0]
  const withBase = e.mods.filter((m) => !e.off.includes(m)).map((id) => ({ id, releases: releasesOf(id) }))
  const current = rel(e.ref)
  const newest = shared(withBase)
  const moveTo = newest && newerRelease(newest, current) ? newest : ""
  const target = moveTo || current
  const fixes = withBase.flatMap((m) => {
    const have = e.updates[m.id]
    const at = m.releases.find((r) => r.release === target)
    return have !== undefined && at && at.update > have ? [{ id: m.id, update: at.update }] : []
  })
  // The newest release known: the one the release watch last checked, and
  // any a mod has a version for.
  const watched = (() => {
    try {
      return readJsonFile(path.join(reg, "status", `${h.id}.json`)).tested as string | undefined
    } catch {
      return undefined
    }
  })()
  const known = [watched ? rel(watched) : "", ...withBase.flatMap((m) => m.releases.map((r) => r.release))].filter(Boolean)
  const latest = newestFirst([current, ...known])[0]!
  const held = newerRelease(latest, target) ? withBase.filter((m) => !m.releases.some((r) => r.release === latest)).map((m) => m.id) : []
  const heldSaid = held.length ? `${h.name} ${latest} is out, but ${held.map(shown).join(", ")} ${held.length === 1 ? "has" : "have"} no version for it yet.` : ""
  const fixesSaid = fixes.map((f) => `${shown(f.id)} update ${f.update}`).join(", ")
  // A build made with OpenMods' old patch: \`update\` makes it again without.
  const old = carriesBase(e) && !moveTo && !fixes.length
  const ask = !!moveTo || fixes.length > 0 || old
  const message = old
    ? `Your ${h.name} build was made before OpenMods stopped changing harness code; updating builds your mods without an OpenMods patch or version stamp.${heldSaid ? ` ${heldSaid}` : ""}`
    : moveTo
    ? `${h.name} ${moveTo} is out, and all your mods support it.${fixesSaid ? ` New in your mods: ${fixesSaid}.` : ""}${heldSaid ? ` ${heldSaid}` : ""}`
    : fixes.length
      ? `New in your ${h.name} mods: ${fixesSaid}.${heldSaid ? ` ${heldSaid}` : ""}`
      : heldSaid
        ? `${heldSaid} You stay on ${current}.`
        : ""
  const key = old ? "update without the base patch" : ask ? `update ${moveTo} ${fixes.map((f) => `${f.id}@${f.update}`).join(",")}` : held.length ? `held ${latest} ${held.join(",")}` : ""
  return { ask, message, key, moveTo, fixes, held, latest }
}

/**
 * A newer release than the one a harness's build is on, when some of its
 * mods have no version for it yet, as a line for \`openmods update\`.
 */
function heldBack(h: Harness, e: State[string], active: Mod[]) {
  const newest = newestFirst([e.ref, ...active.flatMap((m) => m.versions.map((v) => v.ref))])[0]!
  if (!newerRelease(newest, e.ref)) return ""
  const blocked = active.filter((m) => !at(m, newest)).map((m) => m.id)
  if (!blocked.length) return ""
  return `${h.name} ${rel(newest)} is out, but ${blocked.map(shown).join(", ")} ${blocked.length === 1 ? "has" : "have"} no version for it yet, so you stay on ${rel(e.ref)}.`
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
  uninstall: cmdUninstall,
  status: cmdStatus,
  on: cmdOn,
  off: cmdOff,
  update: cmdUpdate,
  pack: async () => void (await cmdPack()),
  dev: cmdDev,
  check: cmdCheck,
  // Hidden: what the launcher runs in the background.
  "check-updates": cmdCheckUpdates,
  setup: cmdSetup,
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
  else {
    // An install from before the program had its own copy runs it from the
    // registry clone: move it out once, so pulls never change it again.
    if (runsFromRegistry()) {
      const moved = await installCli(path.join(HOME, "registry")).catch((e: unknown) => e as Error)
      // Until it has moved, a pull would change the program as it runs.
      if (moved instanceof Error) {
        pullsAllowed = false
        console.error(`note: could not move OpenMods to ${pretty(CLI_DIR)} (${moved.message}); the mods list is not updated until it can.`)
      }
    }
    if (cmd !== "check-updates") markBusy()
    await keepCurrent(true)
    await commands[cmd]!()
  }
} else {
  fail(`unknown command "${cmd}"\n\n${helpText()}`)
}
