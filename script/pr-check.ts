#!/usr/bin/env bun
// The standards a pull request must meet, checked in CI before Greptile and a
// maintainer review it, and the labels that say what kind of change it is.
//
// A pull request that adds or updates a mod:
//
//   - it changes one mod, and nothing outside that mod's folder
//   - its author owns the mod: the owner, or a maintainer listed before this
//     pull request (a new mod's owner is its author's GitHub handle)
//   - the README says what the mod may do, under "## Permissions"
//   - every new update says what changed (openmods pack --note)
//   - its patches carry no binary files and no minified or generated code
//
// Changes to dependencies or build files in the harness are allowed, but
// listed so reviewers look at them first.
//
// A pull request that proposes or changes a harness:
//
//   - it changes one harness definition, harnesses/<id>.json, and at most
//     the README's list of harnesses
//   - the definition has what a supported harness needs: a public GitHub
//     repository, a license, its official installer, and the install, build
//     and artifact settings and build recipe
//   - only maintainers change a harness that is already supported, because
//     its commands run on every user's machine
//
// Anything else is a change to OpenMods itself (product) or its docs.
//
// Everything is read from git at --head, never from the working tree, so the
// check can run from the base branch without running the pull request's code.
//
//   bun script/pr-check.ts --base <sha> [--head <sha>] --author <github login> [--admins a,b] [--registry <dir>]
import { $ } from "bun"
import { writeFileSync } from "node:fs"
import path from "node:path"

const args = process.argv.slice(2)
const flag = (k: string) => {
  const i = args.indexOf(`--${k}`)
  return i === -1 ? undefined : args[i + 1]
}
const root = path.resolve(flag("registry") ?? path.join(import.meta.dir, ".."))
const base = flag("base") ?? fail("--base <ref> is required")
const head = flag("head") ?? "HEAD"
const author = (flag("author") ?? fail("--author <login> is required")).toLowerCase()
// Registry maintainers may change any mod, e.g. to remove a harmful one.
const admins = (flag("admins") ?? "").split(",").map((a) => a.trim().toLowerCase()).filter(Boolean)

function fail(msg: string): never {
  console.error(msg)
  process.exit(2)
}

const git = (...a: string[]) => $`git -C ${root} ${a}`.quiet().nothrow()
const at = async (ref: string, file: string) => {
  const r = await git("show", `${ref}:${file}`)
  return r.exitCode === 0 ? r.stdout.toString() : undefined
}
const atBase = (file: string) => at(base, file)
const atHead = (file: string) => at(head, file)
const json = (text: string | undefined) => (text === undefined ? undefined : JSON.parse(text))

const changed = (await git("diff", "--name-only", `${base}...${head}`)).stdout.toString().split("\n").filter(Boolean)
const problems: string[] = []
const notes: string[] = []
const labels = new Set<string>()

const modFiles = changed.filter((f) => f.startsWith("mods/") && f !== "mods/.gitkeep")
const harnessFiles = changed.filter((f) => f.startsWith("harnesses/"))
let ok = "Nothing here needs the mod or harness standards."
if (modFiles.length) await modStandards()
else if (harnessFiles.length) await harnessStandards()
else labels.add(changed.every((f) => f.endsWith(".md")) ? "docs" : "product")
// Revoking a mod stops it running on users' machines: maintainers only.
if (changed.includes("revoked.json") && !admins.includes(author))
  problems.push("revoked.json lists mods removed for doing harm, and only registry maintainers change it. To report a harmful mod, open an issue titled \"Harmful mod: <owner>/<mod>\".")

report(problems.length ? "" : ok)
process.exit(problems.length ? 1 : 0)

async function modStandards() {
  ok = "Meets the mod standards."
  // One mod per pull request, and nothing else in it.
  const roots = [...new Set(modFiles.map((f) => f.split("/").slice(0, 3).join("/")))]
  if (roots.length > 1) problems.push(`A pull request changes one mod. This one changes ${roots.map((r) => r.slice(5)).join(", ")}.`)
  const outside = changed.filter((f) => !f.startsWith("mods/"))
  if (outside.length) problems.push(`A mod's pull request changes only that mod's folder. This one also changes ${outside.join(", ")}.`)

  // Harness files that decide what gets installed or run at build time.
  const SENSITIVE = /(^|\/)(package\.json|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|turbo\.json|Cargo\.toml|Cargo\.lock|build\.rs|go\.mod|go\.sum|Makefile|Dockerfile|[^/]*\.sh)$|^\.github\//

  for (const modRoot of roots) {
    const id = modRoot.slice(5)
    const [owner] = id.split("/") as [string]
    const before = json(await atBase(`${modRoot}/mod.json`))
    labels.add(before ? "mod: update" : "mod: new")

    // Who may change it: decided by the mod as it was before this pull request,
    // so a pull request cannot add its own author as a maintainer.
    const allowed: string[] = before ? [...new Set([before.owner, ...(before.maintainers ?? [])].map((a: string) => String(a).toLowerCase()))] : [owner]
    if (!admins.includes(author) && !allowed.includes(author))
      problems.push(
        before
          ? `${id} belongs to ${allowed.map((a) => `@${a}`).join(", ")}; @${author} cannot change it. Ask its owner to add you to "maintainers" first.`
          : `A new mod's owner is its author's GitHub handle: @${author} can add mods under mods/${author}/, not mods/${owner}/.`,
      )

    // Only the files OpenMods reads. status.json is written by CI.
    for (const f of modFiles.filter((f) => f.startsWith(`${modRoot}/`))) {
      const inside = f.slice(modRoot.length + 1)
      if (!/^(mod\.json|README\.md|[^/]+\/(support|status)\.json|[^/]+\/[^/]+\/\d{4}-[A-Za-z0-9._-]+\.patch)$/.test(inside))
        problems.push(`${f} is not a file a mod may contain. A mod's folder holds mod.json, README.md, and per harness support.json and its patches.`)
      else if (/\/status\.json$/.test(inside) && !admins.includes(author)) problems.push(`${f} is written by CI; a pull request does not change it.`)
    }

    if ((await atHead(`${modRoot}/mod.json`)) === undefined) {
      notes.push(`${id} is removed.`)
      continue
    }

    // The README says what the mod may do.
    const readme = (await atHead(`${modRoot}/README.md`)) ?? ""
    const permissions = /^## Permissions\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(readme)?.[1] ?? ""
    if (!permissions.trim()) problems.push(`${id}: README.md needs a "## Permissions" section saying what the mod does with the network, files, commands and the agent's instructions.`)
    else {
      const missing = ["network", "files", "commands", "instructions"].filter((w) => !permissions.toLowerCase().includes(w))
      if (missing.length) problems.push(`${id}: the Permissions section does not cover ${missing.join(", ")}. Say "none" where the mod does not touch it.`)
      if (/TODO/.test(permissions)) problems.push(`${id}: the Permissions section still has a TODO.`)
    }

    // Every new update says what it changed.
    const entries = (await git("ls-tree", "--name-only", head, `${modRoot}/`)).stdout.toString().split("\n").filter(Boolean)
    for (const entry of entries) {
      const support = await atHead(`${entry}/support.json`)
      if (support === undefined) continue
      const harness = path.basename(entry)
      const now = JSON.parse(support).versions ?? []
      const was = json(await atBase(`${modRoot}/${harness}/support.json`))?.versions ?? []
      const latest = Math.max(0, ...was.map((v: { update?: number }) => v.update ?? 1))
      for (const v of now as { ref: string; update?: number; note?: string }[])
        if ((v.update ?? 1) > latest && latest > 0 && !v.note) problems.push(`${id}: update ${v.update} on ${harness} needs a note saying what changed (openmods pack --note "...").`)
    }

    // The patches: readable source only.
    for (const file of modFiles.filter((f) => f.startsWith(`${modRoot}/`) && f.endsWith(".patch"))) {
      const text = await atHead(file)
      if (text === undefined) continue
      if (text.length > 1_000_000) problems.push(`${file} is over 1 MB. Split the change, or leave generated files out of the mod.`)
      if (/^(GIT binary patch|Binary files )/m.test(text)) problems.push(`${file} carries a binary file. Mods are readable source only.`)
      const long = text.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++") && l.length > 1000)
      if (long.length) problems.push(`${file} adds ${long.length} line${long.length === 1 ? "" : "s"} over 1000 characters. Minified or generated code cannot be reviewed; add the source instead.`)
      const touched = [...text.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]!)
      const sensitive = touched.filter((f) => SENSITIVE.test(f))
      if (sensitive.length) {
        notes.push(`${file} changes ${sensitive.join(", ")} in the harness: dependencies and build files get a closer look.`)
        labels.add("build files")
      }
    }
  }
}

// A new harness, or a change to one: its definition decides what runs on
// users' machines when they build, so it is checked field by field.
async function harnessStandards() {
  ok = "Meets the harness standards."
  labels.add("harness")
  const ids = [...new Set(harnessFiles.map((f) => path.basename(f).replace(/\.json$/, "")))]
  const outside = changed.filter((f) => !f.startsWith("harnesses/") && f !== "README.md")
  // Maintainers change harness definitions along with OpenMods itself; a
  // proposal from anyone else is one definition on its own.
  if (admins.includes(author)) {
    if (outside.some((f) => !f.endsWith(".md"))) labels.add("product")
  } else {
    if (ids.length > 1) problems.push(`A pull request proposes or changes one harness. This one changes ${ids.join(", ")}.`)
    if (outside.length) problems.push(`A harness's pull request changes only its definition in harnesses/, and at most the README's list of harnesses. This one also changes ${outside.join(", ")}.`)
  }
  for (const id of ids) {
    const file = `harnesses/${id}.json`
    const before = await atBase(file)
    const now = await atHead(file)
    if (before && !admins.includes(author))
      problems.push(`${file} is a supported harness; only registry maintainers change it, because its commands run on every user's machine. Open an issue describing the change instead.`)
    if (now === undefined) {
      notes.push(`${file} is removed.`)
      continue
    }
    let h: Record<string, any>
    try {
      h = JSON.parse(now)
    } catch {
      problems.push(`${file} is not valid JSON.`)
      continue
    }
    const need = (ok: boolean, what: string) => ok || problems.push(`${file}: ${what}`)
    need(h.id === id, `"id" must be "${id}", the file's name.`)
    need(typeof h.name === "string" && h.name.length > 0, `needs a "name".`)
    need(/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(h.repo ?? ""), `"repo" must be the harness's public GitHub repository, https://github.com/<owner>/<repo>. OpenMods supports open-source harnesses only.`)
    need(typeof h.license === "string" && h.license.length > 0, `needs its "license", e.g. MIT or Apache-2.0.`)
    need(typeof h.binary === "string" && h.binary.length > 0, `needs the "binary" users run.`)
    need(typeof h.installer?.command === "string" && h.installer.command.length > 0, `needs "installer.command", the install command from the harness's own docs, offered to users who do not have it.`)
    for (const k of ["install", "typecheck", "build", "artifact", "releaseTagPattern"]) need(typeof h[k] === "string" && h[k].length > 0, `needs "${k}".`)
    need(Array.isArray(h.recipe) && h.recipe.length > 0, `needs a "recipe": the files, or lines of files, its install and build commands depend on.`)
    notes.push(`${file}: its installer, install, typecheck and build commands run on users' machines and in CI; read each one.`)
  }
}

function report(ok: string) {
  const lines = [
    "### Standards",
    "",
    ...(problems.length ? ["Not yet:", "", ...problems.map((p) => `- ${p}`)] : [ok]),
    ...(notes.length ? ["", "For reviewers:", "", ...notes.map((n) => `- ${n}`)] : []),
    "",
    `Labels: ${[...labels].join(", ")}`,
    "",
  ]
  console.log(lines.join("\n"))
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n", { flag: "a" })
  // The kind labels, for the workflow to set on the pull request.
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `labels=${[...labels].join(",")}\n`, { flag: "a" })
}
