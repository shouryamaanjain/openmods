#!/usr/bin/env bun
// Registry lint: every mod.json and harness json matches its schema-level
// invariants, every listed patch exists, every commit is 40 hex chars, and
// names match folders. Runs in CI on every PR; `open-mods check` does the
// expensive apply-and-build step per mod.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const errors: string[] = []
const harnesses = new Set(
  readdirSync(path.join(root, "harnesses"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, "")),
)

for (const id of harnesses) {
  const h = JSON.parse(readFileSync(path.join(root, "harnesses", `${id}.json`), "utf8"))
  if (h.id !== id) errors.push(`harnesses/${id}.json: id "${h.id}" does not match file name`)
  for (const k of ["name", "repo", "binary", "install", "build", "artifact"]) {
    if (typeof h[k] !== "string" || !h[k]) errors.push(`harnesses/${id}.json: missing "${k}"`)
  }
}

const modsRoot = path.join(root, "mods")
for (const harness of readdirSync(modsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
  if (!harnesses.has(harness)) errors.push(`mods/${harness}: no harnesses/${harness}.json`)
  for (const name of readdirSync(path.join(modsRoot, harness), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    const dir = path.join(modsRoot, harness, name)
    const rel = `mods/${harness}/${name}`
    const file = path.join(dir, "mod.json")
    if (!existsSync(file)) {
      errors.push(`${rel}: missing mod.json`)
      continue
    }
    const m = JSON.parse(readFileSync(file, "utf8"))
    if (m.name !== name) errors.push(`${rel}: name "${m.name}" does not match folder`)
    if (m.harness !== harness) errors.push(`${rel}: harness "${m.harness}" does not match folder`)
    if (typeof m.description !== "string" || m.description.length === 0 || m.description.length > 200 || m.description.startsWith("TODO"))
      errors.push(`${rel}: description must be 1-200 characters and not a TODO`)
    if (!m.license) errors.push(`${rel}: missing license`)
    if (!/^[0-9a-f]{40}$/.test(m.upstream?.commit ?? "")) errors.push(`${rel}: upstream.commit must be a full sha`)
    if (!m.upstream?.ref) errors.push(`${rel}: missing upstream.ref`)
    if ("version" in m) errors.push(`${rel}: drop "version"; a mod is versioned by the harness release in upstream.ref`)
    if (!Array.isArray(m.patches) || m.patches.length === 0) errors.push(`${rel}: patches must be a non-empty list`)
    for (const p of m.patches ?? []) {
      if (!/^patches\/\d{4}-[A-Za-z0-9._-]+\.patch$/.test(p)) errors.push(`${rel}: bad patch path "${p}"`)
      else if (!existsSync(path.join(dir, p))) errors.push(`${rel}: ${p} does not exist`)
      else if (/^index [0-9a-f]{1,39}\.\./m.test(readFileSync(path.join(dir, p), "utf8")))
        errors.push(`${rel}: ${p} has short blob ids; regenerate it with open-mods pack (git format-patch --full-index)`)
    }
    const onDisk = existsSync(path.join(dir, "patches")) ? readdirSync(path.join(dir, "patches")).filter((f) => f.endsWith(".patch")) : []
    for (const f of onDisk) if (!m.patches?.includes(`patches/${f}`)) errors.push(`${rel}: patches/${f} is not listed in mod.json`)
    if (!existsSync(path.join(dir, "README.md"))) errors.push(`${rel}: missing README.md`)
  }
}

if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`)
  process.exit(1)
}
console.log("registry ok")
