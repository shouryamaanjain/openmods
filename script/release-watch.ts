#!/usr/bin/env bun
// Release watch, the registry's reaction to a harness release.
//
//   plan   [--harness <id>] [--ref <tag>]    what to check against which release (JSON)
//   apply  <results-dir> [--recipe <json>] [--issues]
//                                            bump the mods that passed, mark the ones
//                                            that failed, hold a harness whose recipe
//                                            changed, open or update issues
//   verify <harness> <ref>                   record that a person built the harness at
//                                            <ref> after its recipe changed: lifts the hold
//
// Nothing here builds a harness. For each harness with a new release, `plan`
// first compares the lines our build recipe depends on (the harness's
// `recipe` list: its build script, toolchain pin, and so on) between the last
// release it was checked at and the new one. If any changed, the harness is
// held: no mod is checked or bumped, and one issue asks a person to run the
// manual harness build. If none changed, `plan` lists the mods not yet on the
// new release, CI applies and typechecks each one (`open-mods check
// --typecheck --json`), and `apply` bumps the ones that pass and marks the
// ones that fail, which the site shows in yellow.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

// A mod on one harness is the folder mods/<owner>/<name>/<harness>, holding
// support.json (the release it is for, its patches) and status.json.
const modDirs = (harness: string) => {
  const base = path.join(root, "mods")
  const dirs = (p: string) => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [])
  return dirs(base).flatMap((owner) =>
    dirs(path.join(base, owner))
      .map((name) => path.join(base, owner, name, harness))
      .filter((d) => existsSync(path.join(d, "support.json"))),
  )
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

type RecipeEntry = { file: string; lines?: string }
type RecipeCheck = { harness: string; name: string; from: string; to: string; state: "unchanged" | "changed" | "held"; changes: string[] }

const statusFile = (harness: string) => path.join(root, "status", `${harness}.json`)

// The lines of the harness's recipe files that differ between two releases.
// A recipe entry watches a whole file, or only its lines matching `lines`
// (a regex): package.json changes every release, its packageManager line
// almost never. Only trees and the few watched files are fetched.
async function recipeChanges(h: { id: string; repo: string; recipe?: RecipeEntry[] }, from: string, to: string): Promise<string[]> {
  if (!h.recipe?.length || from === to) return []
  const dir = path.join((process.env.RUNNER_TEMP ?? "/tmp"), `open-mods-recipe-${h.id}-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  await $`git -C ${dir} init -q`.quiet()
  await $`git -C ${dir} remote add origin ${h.repo}`.quiet()
  await $`git -C ${dir} config remote.origin.promisor true`.quiet()
  await $`git -C ${dir} config remote.origin.partialclonefilter blob:none`.quiet()
  await $`git -C ${dir} fetch -q --no-tags --depth 1 --filter=blob:none origin ${"refs/tags/" + from + ":refs/tags/" + from} ${"refs/tags/" + to + ":refs/tags/" + to}`.quiet()
  const changes: string[] = []
  const show = async (ref: string, file: string) => {
    const r = await $`git -C ${dir} show ${ref + ":" + file}`.nothrow().quiet()
    return r.exitCode === 0 ? r.stdout.toString() : null
  }
  for (const entry of h.recipe) {
    if (!entry.lines) {
      // A whole file: any changed line counts, and so does the file going away.
      const diff = await $`git -C ${dir} diff -U0 ${from} ${to} -- ${entry.file}`.nothrow().quiet().text()
      for (const line of diff.split("\n")) if (/^[-+]/.test(line) && !/^(---|\+\+\+) /.test(line)) changes.push(`${entry.file}: ${line}`)
      continue
    }
    // Only the matching lines, compared by what they say: whitespace and a
    // trailing comma (a JSON key added after this one) do not count.
    const match = new RegExp(entry.lines)
    const pick = (text: string | null) =>
      (text ?? "").split("\n").filter((l) => match.test(l)).map((l) => l.trim().replace(/,$/, ""))
    const [a, b] = [pick(await show(from, entry.file)), pick(await show(to, entry.file))]
    if (a.join("\n") === b.join("\n")) continue
    for (const l of a.filter((x) => !b.includes(x))) changes.push(`${entry.file}: -${l}`)
    for (const l of b.filter((x) => !a.includes(x))) changes.push(`${entry.file}: +${l}`)
  }
  rmSync(dir, { recursive: true, force: true })
  return changes
}

async function plan() {
  const latest: Record<string, string> = {}
  const matrix: { mod: string; harness: string; ref: string }[] = []
  const recipe: RecipeCheck[] = []
  for (const h of harnesses()) {
    const ref = flag("ref") ?? (await latestTag(h))
    if (!ref) continue
    latest[h.id] = ref
    const mods = modDirs(h.id).map((dir) => ({ dir, mod: readJson(path.join(dir, "support.json")), status: readJson(path.join(dir, "status.json")) }))
    const pending = mods.filter(({ mod, status }) => mod.upstream.ref !== ref && (status?.tested !== ref || has("retest")))
    if (!pending.length) continue
    // Where the recipe was last known to work: the last release this harness
    // was checked at, else the newest release any of its mods is on.
    const st = readJson(statusFile(h.id))
    if (st?.tested === ref && st.recipe === "changed") {
      recipe.push({ harness: h.id, name: h.name, from: st.from, to: ref, state: "held", changes: st.changes ?? [] })
      continue
    }
    const from = st?.tested && st.tested !== ref ? st.tested : mods.map(({ mod }) => mod.upstream.ref).reduce((a, b) => (newer(b, a) ? b : a))
    const changes = st?.tested === ref ? [] : await recipeChanges(h, from, ref)
    recipe.push({ harness: h.id, name: h.name, from, to: ref, state: changes.length ? "changed" : "unchanged", changes })
    if (changes.length) continue
    for (const { dir } of pending) matrix.push({ mod: path.relative(root, dir), harness: h.id, ref })
  }
  const out = { latest, matrix, recipe }
  console.log(JSON.stringify(out, null, 2))
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\nrecipe=${JSON.stringify(recipe.filter((r) => r.state !== "held"))}\nlatest=${JSON.stringify(latest)}\n`, { flag: "a" })
  }
}

function maintainersOf(mod: any): string[] {
  const list: string[] = mod.maintainers ?? (mod.author?.github ? [mod.author.github] : [])
  return list.map((m) => (m.startsWith("@") ? m : `@${m}`))
}

async function issueFor(id: string, harnessId: string, meta: any, support: any, ref: string, error: string) {
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) return
  const harness = readJson(path.join(root, "harnesses", `${harnessId}.json`))
  const title = `${id} does not support ${harness.name} ${rel(ref)}`
  const who = maintainersOf(meta).join(" ")
  const body = [
    `${who} ${harness.name} ${rel(ref)} (tag \`${ref}\`) is out and \`${id}\` no longer applies or typechecks on it. It stays listed for ${harness.name} ${rel(support.upstream.ref)} until this is fixed.`,
    "",
    "To fix it, rebase the patches on the new release and open a PR:",
    "",
    "```sh",
    `git clone ${harness.repo} && cd ${path.basename(harness.repo)}`,
    `git checkout ${ref}`,
    `git am -3 ../open-mods/mods/${id}/${harnessId}/patches/*.patch   # resolve conflicts if any`,
    `open-mods pack . --name ${id.split("/")[1]} --owner ${id.split("/")[0]} --force`,
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

async function recipeIssue(r: RecipeCheck) {
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) return
  const title = `${r.name} ${rel(r.to)} changed the OpenMods build recipe`
  const body = [
    `${r.name} ${rel(r.to)} (tag \`${r.to}\`) changed lines our build recipe for it depends on, since ${rel(r.from)}. Mods for ${r.name} are held on the releases they are on until someone confirms the recipe still works.`,
    "",
    "What changed:",
    "",
    "```diff",
    ...r.changes.slice(0, 60),
    "```",
    "",
    `To confirm, run the **harness build** workflow with harness \`${r.harness}\` and ref \`${r.to}\`. If it builds, it records that and the next hourly check picks the mods up. If not, fix \`harnesses/${r.harness}.json\` first.`,
  ].join("\n")
  const existing = (await $`gh issue list --repo ${repo} --state open --search ${JSON.stringify(title) + " in:title"} --json number,title`.nothrow().text()).trim()
  if (existing && (JSON.parse(existing) as { title: string }[]).some((i) => i.title === title)) return
  await $`gh issue create --repo ${repo} --title ${title} --body ${body} --label harness`.nothrow()
}

async function apply() {
  const dir = args[1] ?? "results"
  const recipe: RecipeCheck[] = JSON.parse(flag("recipe") ?? process.env.RECIPE ?? "[]")
  mkdirSync(path.join(root, "status"), { recursive: true })
  const recipeLines: string[] = []
  for (const r of recipe) {
    const checked = new Date().toISOString()
    if (r.state === "changed") {
      writeJson(statusFile(r.harness), { tested: r.to, from: r.from, recipe: "changed", changes: r.changes, checked })
      if (has("issues")) await recipeIssue(r)
      recipeLines.push(`${r.name} ${rel(r.to)} changed the build recipe; its mods are held until someone runs the harness build`)
    } else if (r.state === "unchanged") {
      writeJson(statusFile(r.harness), { tested: r.to, from: r.from, recipe: "unchanged", checked })
    }
  }
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : []
  const bumped: string[] = []
  const broken: string[] = []
  let harnessName = recipe[0]?.name ?? ""
  let ref = recipe[0]?.to ?? ""
  for (const f of files) {
    const r = readJson(path.join(dir, f))
    if (!r?.mod || r.stock) continue
    const id = r.mod as string
    const harness = r.harness as string
    const modDir = path.join(root, "mods", ...id.split("/"), harness)
    const modFile = path.join(modDir, "support.json")
    if (!existsSync(modFile)) continue
    const mod = readJson(modFile)
    const meta = readJson(path.join(modDir, "..", "mod.json")) ?? {}
    const h = readJson(path.join(root, "harnesses", `${harness}.json`))
    harnessName = h?.name ?? harness
    ref = r.ref
    const ok = r.applies === true && (r.builds === true || r.typechecks === true)
    const checked = new Date().toISOString()
    if (ok) {
      // Save the patches as they apply to the new release, when CI sent them.
      if (Array.isArray(r.patches) && r.patches.length) {
        const pdir = path.join(modDir, "patches")
        for (const f of readdirSync(pdir)) if (f.endsWith(".patch")) rmSync(path.join(pdir, f))
        for (const patch of r.patches as { name: string; text: string }[]) writeFileSync(path.join(pdir, patch.name), patch.text)
        mod.patches = (r.patches as { name: string }[]).map((patch) => `patches/${patch.name}`)
      }
      mod.upstream = { ref: r.ref, commit: r.commit }
      writeJson(modFile, mod)
      writeJson(path.join(modDir, "status.json"), { tested: r.ref, supports: r.ref, ok: true, checked })
      bumped.push(id)
    } else {
      const error = String(r.error ?? (r.applies ? "typecheck failed" : "patches do not apply"))
      writeJson(path.join(modDir, "status.json"), { tested: r.ref, supports: mod.upstream.ref, ok: false, error: error.split("\n").slice(0, 40).join("\n"), checked })
      const issue = has("issues") ? await issueFor(id, harness, meta, mod, r.ref, error) : undefined
      broken.push(`${id}${issue ? ` (${issue})` : ""}`)
    }
  }
  const n = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`
  const title =
    bumped.length || broken.length
      ? `${harnessName} ${rel(ref)}: ${n(bumped.length, "mod")} now support${bumped.length === 1 ? "s" : ""} it, ${broken.length} ${broken.length === 1 ? "does" : "do"} not`
      : `${harnessName} ${rel(ref)}: build recipe changed, mods held`
  const body = [
    ...(bumped.length ? [`Supports it: ${bumped.join(", ")}`] : []),
    ...(broken.length ? [`Needs a maintainer: ${broken.join(", ")}`] : []),
    ...recipeLines,
  ].join("\n")
  const summary = `${title}\n${body.replace(/^/gm, "  ")}`
  console.log(summary)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "COMMIT_MSG"), `${title}\n\n${body}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, "```\n" + summary + "\n```\n", { flag: "a" })
}

// A person ran the harness build at `ref` and it worked: the recipe is
// confirmed for that release and the hold is lifted.
async function verify() {
  const [harness, ref] = [args[1], args[2]]
  if (!harness || !ref) throw new Error("usage: release-watch verify <harness> <ref> [--issues]")
  mkdirSync(path.join(root, "status"), { recursive: true })
  const prev = readJson(statusFile(harness))
  writeJson(statusFile(harness), { tested: ref, from: prev?.from, recipe: "verified", checked: new Date().toISOString() })
  console.log(`${harness} ${rel(ref)}: recipe verified by a build`)
  // Close the issue that asked for this build.
  const repo = process.env.GITHUB_REPOSITORY
  if (!has("issues") || !repo) return
  const name = readJson(path.join(root, "harnesses", `${harness}.json`))?.name ?? harness
  const title = `${name} ${rel(ref)} changed the OpenMods build recipe`
  const list = (await $`gh issue list --repo ${repo} --state open --label harness --json number,title`.nothrow().text()).trim()
  for (const issue of list ? (JSON.parse(list) as { number: number; title: string }[]) : [])
    if (issue.title === title)
      await $`gh issue close ${String(issue.number)} --repo ${repo} --comment ${`A harness build at ${rel(ref)} succeeded, so the recipe still works. Mods are checked again on the next hourly run.`}`.nothrow()
}

const cmd = args[0]
if (cmd === "plan") await plan()
else if (cmd === "apply") await apply()
else if (cmd === "verify") await verify()
else {
  console.error("usage: release-watch plan [--harness <id>] [--ref <tag>] [--retest] | apply <results-dir> [--recipe <json>] [--issues] | verify <harness> <ref>   (--registry <dir> to run against another checkout)")
  process.exit(1)
}
