#!/usr/bin/env bun
// Release watch, the registry's reaction to a harness release.
//
//   plan  [--harness <id>] [--ref <tag>]   which mods to test against which release (JSON)
//   apply <results-dir> [--issues]         bump the mods that passed, mark the ones that
//                                          failed, open or update an issue for each failure
//
// `plan` looks up the newest release tag of every harness and lists the mods
// that are not yet on it and have not been tested against it. CI runs
// `open-mods check --build --json` for each and hands the results to `apply`.
// A mod that passes gets its upstream ref moved to the new release; that is
// the mod's version, so this is the automatic version bump. A mod that fails
// keeps its ref and gets a status.json saying which release it does not
// support, which the site renders as the yellow state.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { $ } from "bun"

const args = process.argv.slice(2)
const flag = (k: string) => {
  const i = args.indexOf(`--${k}`)
  return i === -1 ? undefined : args[i + 1]
}
const has = (k: string) => args.includes(`--${k}`)
const root = path.resolve(flag("registry") ?? path.resolve(import.meta.dir, ".."))

const rel = (ref: string) => ref.replace(/^[^0-9]*/, "")
const releaseKey = (ref: string) => ref.replace(/^[^0-9]*/, "").split(/[.+-]/).map((x) => Number(x) || 0)
const newer = (a: string, b: string) => {
  const [x, y] = [releaseKey(a), releaseKey(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

const harnesses = () =>
  readdirSync(path.join(root, "harnesses"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(root, "harnesses", f), "utf8")))
    .filter((h) => !flag("harness") || h.id === flag("harness"))

const modDirs = (harness: string) => {
  const dir = path.join(root, "mods", harness)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(dir, d.name, "mod.json")))
    .map((d) => path.join(dir, d.name))
}

const readJson = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined)
const writeJson = (file: string, data: unknown) => writeFileSync(file, JSON.stringify(data, null, 2) + "\n")

// The newest release, not the newest tag: a repo can carry tags for
// prereleases or a next major that nobody is meant to install yet. On GitHub
// the releases API answers that directly; elsewhere fall back to tags.
async function latestTag(h: { repo: string; releaseTagPattern?: string }) {
  const gh = h.repo.match(/github\.com\/([^/]+)\/([^/.]+)/)
  if (gh) {
    const res = await fetch(`https://api.github.com/repos/${gh[1]}/${gh[2]}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) },
    })
    if (res.ok) {
      const tag = ((await res.json()) as { tag_name?: string }).tag_name
      if (tag) return tag
    }
  }
  const out = await $`git ls-remote --tags --refs ${h.repo} ${"refs/tags/" + (h.releaseTagPattern ?? "*")}`.text()
  const tags = out
    .split("\n")
    .map((l) => l.split("\t")[1]?.replace("refs/tags/", ""))
    .filter((t): t is string => !!t && /\d/.test(t))
  return tags.reduce((a, b) => (newer(b, a) ? b : a), tags[0] ?? "")
}

async function plan() {
  const latest: Record<string, string> = {}
  const matrix: { mod: string; harness: string; ref: string }[] = []
  for (const h of harnesses()) {
    const ref = flag("ref") ?? (await latestTag(h))
    if (!ref) continue
    latest[h.id] = ref
    for (const dir of modDirs(h.id)) {
      const mod = readJson(path.join(dir, "mod.json"))
      const status = readJson(path.join(dir, "status.json"))
      if (mod.upstream.ref === ref) continue
      if (status?.tested === ref && !has("retest")) continue
      matrix.push({ mod: path.relative(root, dir), harness: h.id, ref })
    }
  }
  const out = { latest, matrix }
  console.log(JSON.stringify(out, null, 2))
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\nlatest=${JSON.stringify(latest)}\n`, { flag: "a" })
  }
}

function maintainersOf(mod: any): string[] {
  const list: string[] = mod.maintainers ?? (mod.author?.github ? [mod.author.github] : [])
  return list.map((m) => (m.startsWith("@") ? m : `@${m}`))
}

async function issueFor(modPath: string, mod: any, ref: string, error: string) {
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) return
  const harness = readJson(path.join(root, "harnesses", `${mod.harness}.json`))
  const title = `${mod.harness}/${mod.name} does not support ${harness.name} ${rel(ref)}`
  const who = maintainersOf(mod).join(" ")
  const body = [
    `${who} ${harness.name} ${rel(ref)} (tag \`${ref}\`) is out and \`${mod.harness}/${mod.name}\` no longer applies or builds on it. It stays listed for ${rel(mod.upstream.ref)} until this is fixed.`,
    "",
    "To fix it, rebase the patches on the new release and open a PR:",
    "",
    "```sh",
    `git clone ${harness.repo} && cd ${path.basename(harness.repo)}`,
    `git checkout ${ref}`,
    `git am -3 ../open-mods/${modPath}/patches/*.patch   # resolve conflicts if any`,
    `open-mods pack . --name ${mod.name} --force`,
    "```",
    "",
    "What CI saw:",
    "",
    "```",
    error.split("\n").slice(0, 40).join("\n"),
    "```",
  ].join("\n")
  const existing = (await $`gh issue list --repo ${repo} --state open --search ${JSON.stringify(title) + " in:title"} --json number,title`.nothrow().text()).trim()
  const open = existing ? (JSON.parse(existing) as { number: number; title: string }[]).find((i) => i.title === title) : undefined
  if (open) {
    await $`gh issue comment ${String(open.number)} --repo ${repo} --body ${`Still failing on ${rel(ref)} as of ${new Date().toISOString().slice(0, 10)}.`}`.nothrow()
    return `#${open.number} (already open)`
  }
  const url = (await $`gh issue create --repo ${repo} --title ${title} --body ${body} --label conflict`.nothrow().text()).trim()
  return url
}

async function apply() {
  const dir = args[1] ?? "results"
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : []
  const bumped: string[] = []
  const broken: string[] = []
  let harnessName = ""
  let ref = ""
  for (const f of files) {
    const r = readJson(path.join(dir, f))
    if (!r?.mod) continue
    const [harness, name] = (r.mod as string).split("/")
    const modDir = path.join(root, "mods", harness!, name!)
    const modFile = path.join(modDir, "mod.json")
    if (!existsSync(modFile)) continue
    const mod = readJson(modFile)
    const h = readJson(path.join(root, "harnesses", `${harness}.json`))
    harnessName = h?.name ?? harness
    ref = r.ref
    const ok = r.applies === true && r.builds === true
    const checked = new Date().toISOString()
    if (ok) {
      mod.upstream = { ref: r.ref, commit: r.commit }
      writeJson(modFile, mod)
      writeJson(path.join(modDir, "status.json"), { tested: r.ref, supports: r.ref, ok: true, checked })
      bumped.push(name!)
    } else {
      const error = String(r.error ?? (r.applies ? "build failed" : "patches do not apply"))
      writeJson(path.join(modDir, "status.json"), { tested: r.ref, supports: mod.upstream.ref, ok: false, error: error.split("\n").slice(0, 40).join("\n"), checked })
      const issue = has("issues") ? await issueFor(`mods/${harness}/${name}`, mod, r.ref, error) : undefined
      broken.push(`${name}${issue ? ` (${issue})` : ""}`)
    }
  }
  const n = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`
  const title = `${harnessName} ${rel(ref)}: ${n(bumped.length, "mod")} now support${bumped.length === 1 ? "s" : ""} it, ${broken.length} ${broken.length === 1 ? "does" : "do"} not`
  const body = [
    ...(bumped.length ? [`Supports it: ${bumped.join(", ")}`] : []),
    ...(broken.length ? [`Needs a maintainer: ${broken.join(", ")}`] : []),
  ].join("\n")
  const summary = `${title}\n${body.replace(/^/gm, "  ")}`
  console.log(summary)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "COMMIT_MSG"), `${title}\n\n${body}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, "```\n" + summary + "\n```\n", { flag: "a" })
}

const cmd = args[0]
if (cmd === "plan") await plan()
else if (cmd === "apply") await apply()
else {
  console.error("usage: release-watch plan [--harness <id>] [--ref <tag>] [--retest] | apply <results-dir> [--issues]   (--registry <dir> to run against another checkout)")
  process.exit(1)
}
