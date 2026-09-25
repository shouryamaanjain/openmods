#!/usr/bin/env bun
// Builds the OpenMods site from the registry: one static page per mod and
// per harness, plus the home page and the "make a mod" guide. No backend;
// CI regenerates it on every push to main and publishes it to openmods.dev.
//
//   bun script/site.ts [--registry <dir>] [--out <dir>] [--offline] [--local]
//
// --local also lists the unpublished mods under ~/.openmods/local, marked as
// such, for previewing the site with content that is not in the registry.
// SITE_URL=https://openmods.dev sets canonical and Open Graph URLs.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { marked } from "marked"
import { footprint, incompatibility, type Footprint } from "../cli/src/overlap"
import { COMMANDS, ENVIRONMENT, FILES, GLOBAL_FLAGS, INTRO } from "../cli/src/reference"

const args = process.argv.slice(2)
const flag = (k: string) => {
  const i = args.indexOf(`--${k}`)
  return i === -1 ? undefined : args[i + 1]
}
const root = path.resolve(flag("registry") ?? path.join(import.meta.dir, ".."))
const out = path.resolve(flag("out") ?? path.join(root, "site"))
const REPO = process.env.SITE_REPO ?? "shouryamaanjain/openmods"
const SITE_NAME = "OpenMods"
const SITE_URL = (process.env.SITE_URL ?? "").replace(/\/$/, "")

type Harness = { id: string; name: string; repo: string; homepage?: string; language?: string; binary: string; releaseTagPattern?: string; latest?: string }
// One mod on one harness: mods/<owner>/<name>/<harness>/, with the shared
// mod.json fields. An Entry groups a mod's harnesses under its owner/name.
type Mod = {
  owner: string
  name: string
  id: string
  harness: string
  description: string
  author?: { name?: string; github?: string }
  maintainers?: string[]
  license: string
  tags?: string[]
  upstream: { ref: string; commit: string }
  patches: string[]
  // Every version, one per release, newest first; upstream and patches are the newest.
  versions: { ref: string; commit: string; patches: string[]; update?: number; note?: string }[]
  conflicts?: string[]
  dir: string
  readme: string
  status?: { tested: string; supports: string; ok: boolean; error?: string; checked: string }
  files: { path: string; added: number; removed: number; isNew: boolean }[]
  diff: string
  local?: boolean
}
type Entry = { id: string; owner: string; name: string; description: string; license: string; tags?: string[]; author?: Mod["author"]; maintainers?: string[]; readme: string; local: boolean; variants: Mod[] }

const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"))
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
const rel = (ref: string) => ref.replace(/^[^0-9]*/, "")
const releaseKey = (ref: string) => ref.replace(/^[^0-9]*/, "").split(/[.+-]/).map((x) => Number(x) || 0)
const newer = (a: string, b: string) => {
  const [x, y] = [releaseKey(a), releaseKey(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

// ------------------------------------------------------------------ data

async function latestRelease(h: Harness, mods: Mod[]) {
  const fallback = mods.map((m) => m.upstream.ref).reduce((a, b) => (newer(b, a) ? b : a), "")
  if (args.includes("--offline")) return fallback
  const gh = h.repo.match(/github\.com\/([^/]+)\/([^/.]+)/)
  if (!gh) return fallback
  try {
    const res = await fetch(`https://api.github.com/repos/${gh[1]}/${gh[2]}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) },
    })
    if (res.ok) return ((await res.json()) as { tag_name?: string }).tag_name ?? fallback
  } catch {}
  return fallback
}

function parsePatches(dir: string, patches: string[]) {
  const files = new Map<string, { path: string; added: number; removed: number; isNew: boolean }>()
  let diff = ""
  for (const p of patches) {
    const text = readFileSync(path.join(dir, p), "utf8")
    const body = text.slice(text.indexOf("\ndiff --git") + 1)
    diff += body + "\n"
    let current: string | undefined
    for (const line of body.split("\n")) {
      const m = line.match(/^diff --git a\/(.+?) b\//)
      if (m) {
        current = m[1]!
        if (!files.has(current)) files.set(current, { path: current, added: 0, removed: 0, isNew: false })
        continue
      }
      if (!current) continue
      const f = files.get(current)!
      if (line.startsWith("--- /dev/null")) f.isNew = true
      else if (line.startsWith("+") && !line.startsWith("+++")) f.added++
      else if (line.startsWith("-") && !line.startsWith("---")) f.removed++
    }
  }
  return { files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)), diff: diff.trim() }
}

const harnesses: Harness[] = readdirSync(path.join(root, "harnesses"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => readJson(path.join(root, "harnesses", f)))

function modsIn(base: string, local: boolean): Mod[] {
  const dirs = (p: string) => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [])
  return dirs(base).flatMap((owner) =>
    dirs(path.join(base, owner))
      .filter((name) => existsSync(path.join(base, owner, name, "mod.json")))
      .flatMap((name) => {
        const root = path.join(base, owner, name)
        const meta = readJson(path.join(root, "mod.json"))
        // The OpenMods base patch goes into every build; it is not a mod to list.
        if (meta.internal) return []
        const readme = existsSync(path.join(root, "README.md")) ? readFileSync(path.join(root, "README.md"), "utf8") : ""
        return dirs(root)
          .filter((h) => harnesses.some((x) => x.id === h) && existsSync(path.join(root, h, "support.json")))
          .map((h) => {
            const dir = path.join(root, h)
            const support = readJson(path.join(dir, "support.json"))
            const status = existsSync(path.join(dir, "status.json")) ? readJson(path.join(dir, "status.json")) : undefined
            const versions = (support.versions as Mod["versions"]).slice().sort((a, b) => (newer(a.ref, b.ref) ? -1 : newer(b.ref, a.ref) ? 1 : 0))
            const newest = versions[0]!
            return {
              ...meta,
              conflicts: support.conflicts,
              owner,
              name,
              id: `${owner}/${name}`,
              harness: h,
              upstream: { ref: newest.ref, commit: newest.commit },
              patches: newest.patches,
              versions,
              dir,
              readme,
              status,
              local,
              ...parsePatches(dir, newest.patches),
            } as Mod
          })
      }),
  )
}

const published = modsIn(path.join(root, "mods"), false)
const mods: Mod[] = args.includes("--local")
  ? [...published, ...modsIn(path.join(process.env.OPENMODS_HOME ?? path.join(homedir(), ".openmods"), "local"), true).filter((l) => !published.some((p) => p.id === l.id && p.harness === l.harness))]
  : published

// Which mods cannot be installed together with which, per harness: the same
// rule the CLI applies before it builds, at the newest release both have a
// version for.
const footprints = new Map<string, Footprint>()
const versionAt = (m: Mod, ref: string) => {
  const v = m.versions.find((x) => x.ref === ref)!
  const key = `${m.dir}@${ref}`
  if (!footprints.has(key)) footprints.set(key, footprint(v.patches.map((p) => readFileSync(path.join(m.dir, p), "utf8"))))
  return { mod: { id: m.id, conflicts: m.conflicts, upstream: { commit: v.commit } }, fp: footprints.get(key)! }
}
const clashOf = (a: Mod, b: Mod) => {
  const shared = a.versions.map((v) => v.ref).filter((r) => b.versions.some((v) => v.ref === r))
  const x = versionAt(a, shared[0] ?? a.upstream.ref)
  const y = versionAt(b, shared[0] ?? b.upstream.ref)
  return incompatibility(x.mod, x.fp, y.mod, y.fp)
}
const clashes = new Map<Mod, { mod: Mod; why: string }[]>(
  mods.map((m) => [
    m,
    mods
      .filter((o) => o.harness === m.harness && o.id !== m.id)
      .flatMap((o) => {
        const why = clashOf(m, o)
        return why ? [{ mod: o, why }] : []
      }),
  ]),
)

const entries: Entry[] = [...new Set(mods.map((m) => m.id))].sort().map((id) => {
  const variants = mods.filter((m) => m.id === id).sort((a, b) => harnesses.findIndex((h) => h.id === a.harness) - harnesses.findIndex((h) => h.id === b.harness))
  const m = variants[0]!
  return { id, owner: m.owner, name: m.name, description: m.description, license: m.license, tags: m.tags, author: m.author, maintainers: m.maintainers, readme: m.readme, local: variants.some((v) => v.local), variants }
})

for (const h of harnesses) h.latest = await latestRelease(h, mods.filter((m) => m.harness === h.id))

const PLANNED = [
  { id: "codex", name: "Codex CLI", repo: "https://github.com/openai/codex" },
  { id: "fx", name: "fx", repo: "https://github.com/vercel-labs/fx" },
].filter((p) => !harnesses.some((h) => h.id === p.id))

// ------------------------------------------------------------------ html

const WORDMARK = `\
 ██████  ██████  ███████ ███    ██     ███    ███  ██████  ██████  ███████
██    ██ ██   ██ ██      ████   ██     ████  ████ ██    ██ ██   ██ ██
██    ██ ██████  █████   ██ ██  ██     ██ ████ ██ ██    ██ ██   ██ ███████
██    ██ ██      ██      ██  ██ ██     ██  ██  ██ ██    ██ ██   ██      ██
 ██████  ██      ███████ ██   ████     ██      ██  ██████  ██████  ███████`

const CSS = `
:root{--bg:#fff;--fg:#111;--muted:#666;--line:#e6e6e6;--soft:#f6f6f6;--green:#1a7f37;--green-bg:#dafbe1;--yellow:#7a5b00;--yellow-bg:#fff4c2;--red:#b42318;--red-bg:#fde8e6;--link:#0a58ca;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}
@media(prefers-color-scheme:dark){:root{--bg:#0b0b0b;--fg:#ececec;--muted:#9a9a9a;--line:#262626;--soft:#161616;--green:#3fb950;--green-bg:#12261a;--yellow:#e3b341;--yellow-bg:#2b2410;--red:#f85149;--red-bg:#2c1414;--link:#6cb6ff}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 var(--sans)}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
code,pre,kbd{font-family:var(--mono);font-size:.92em}
.wrap{max-width:1040px;margin:0 auto;padding:0 20px}
header{border-bottom:1px solid var(--line)}
header .wrap{display:flex;align-items:center;gap:22px;height:56px;overflow-x:auto}
header .brand{font-family:var(--mono);font-weight:700;color:var(--fg);letter-spacing:.02em;white-space:nowrap}
header nav{display:flex;gap:16px;margin-left:auto;white-space:nowrap}header nav a{color:var(--muted)}header nav a:hover,header nav a.on{color:var(--fg);text-decoration:none}
.hero{padding:44px 0 28px}
.hero pre{font-family:var(--mono);font-size:6px;line-height:1.05;margin:0 0 18px;overflow:hidden;color:var(--fg)}
@media(min-width:480px){.hero pre{font-size:9px}}@media(min-width:720px){.hero pre{font-size:12px}}
.hero h1{font-size:26px;margin:0 0 8px;letter-spacing:-.01em}
.hero p{color:var(--muted);max-width:640px;margin:0 0 18px;font-size:16px}
.cmd{display:inline-flex;align-items:center;gap:10px;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:11px 14px;font-family:var(--mono);font-size:14px;white-space:nowrap;overflow-x:auto;max-width:100%}
.cmd .dollar{color:var(--muted)}.cmd.block{display:flex}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:22px 0 0}
.chip{border:1px solid var(--line);border-radius:999px;padding:5px 12px;font-size:13px;color:var(--fg)}
.chip.dim{color:var(--muted);border-style:dashed}
h2{font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:34px 0 12px;font-weight:600}
.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.toolbar input{flex:1;min-width:200px;border:1px solid var(--line);border-radius:8px;padding:9px 12px;font:inherit;background:var(--bg);color:var(--fg)}
.tabs{display:flex;gap:4px}.tabs button{border:1px solid var(--line);background:var(--bg);color:var(--muted);border-radius:8px;padding:7px 11px;font:inherit;cursor:pointer}.tabs button.on{color:var(--fg);background:var(--soft)}
.table{overflow-x:auto;-webkit-overflow-scrolling:touch}table{width:100%;border-collapse:collapse}
@media(max-width:600px){.hide-sm{display:none}}
th{text-align:left;font-size:12px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.06em;padding:8px 10px;border-bottom:1px solid var(--line)}
td{padding:12px 10px;border-bottom:1px solid var(--line);vertical-align:top}
tr.mod:hover td{background:var(--soft)}
td.name a{font-family:var(--mono);font-weight:600;color:var(--fg)}td.name .desc{color:var(--muted);margin-top:3px}
td.num{text-align:right;white-space:nowrap;color:var(--muted);font-family:var(--mono)}
.badge{display:inline-block;border-radius:6px;padding:2px 8px;font-family:var(--mono);font-size:12px;white-space:nowrap}
.badge.ok{background:var(--green-bg);color:var(--green)}.badge.behind{background:var(--yellow-bg);color:var(--yellow)}.badge.local{background:var(--soft);color:var(--muted)}
.empty{color:var(--muted);padding:28px 10px;border:1px dashed var(--line);border-radius:8px;text-align:center}
.page{display:grid;grid-template-columns:1fr;gap:34px;padding:34px 0}
@media(min-width:880px){.page{grid-template-columns:minmax(0,1fr) 260px}}
.crumbs{color:var(--muted);font-family:var(--mono);font-size:13px;margin-bottom:8px}.crumbs a{color:var(--muted)}
.title{font-size:30px;margin:0 0 6px;font-family:var(--mono);letter-spacing:-.01em}
.lead{color:var(--muted);font-size:16px;margin:0 0 18px;max-width:640px}
.stats{display:flex;gap:26px;flex-wrap:wrap;margin:22px 0 6px}
.stat b{display:block;font-size:20px;font-weight:600}.stat span{color:var(--muted);font-size:13px}
.notice{border-radius:8px;padding:12px 14px;margin:18px 0;border:1px solid}
.notice.behind{background:var(--yellow-bg);border-color:transparent;color:var(--yellow)}.notice.ok{background:var(--green-bg);border-color:transparent;color:var(--green)}
.notice a{color:inherit;text-decoration:underline}
.releases{color:var(--muted);font-size:14px;margin:10px 0 0}
.notice.clash{background:var(--soft);border-color:var(--line);color:var(--muted)}.notice.clash b{color:var(--fg)}.notice.clash ul{margin:6px 0 0;padding-left:18px}
.md{max-width:70ch}.md h1{font-size:22px}.md h2{text-transform:none;letter-spacing:0;font-size:18px;color:var(--fg);margin:26px 0 8px}.md h3{font-size:16px}
.md pre{background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow-x:auto}.md code{background:var(--soft);padding:1px 5px;border-radius:4px}.md pre code{background:none;padding:0}
.md table{margin:10px 0;display:block;overflow-x:auto}.md td,.md th{padding:6px 8px}.md img{max-width:100%}
.files{border:1px solid var(--line);border-radius:8px;overflow:hidden}
.files div{display:flex;justify-content:space-between;gap:12px;padding:8px 12px;border-top:1px solid var(--line);font-family:var(--mono);font-size:13px}.files div:first-child{border-top:0}
.files .plus{color:var(--green)}.files .minus{color:var(--red)}
details{border:1px solid var(--line);border-radius:8px;margin-top:14px}summary{cursor:pointer;padding:10px 14px;font-weight:600}
.diff{margin:0;padding:12px 14px;border-top:1px solid var(--line);overflow-x:auto;font-size:12.5px;line-height:1.45;background:var(--soft)}
.diff .a{color:var(--green)}.diff .d{color:var(--red)}.diff .h{color:var(--link)}.diff .f{color:var(--muted);font-weight:600}
aside h3{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 8px}
aside section{margin-bottom:26px}aside ul{list-style:none;padding:0;margin:0}aside li{padding:4px 0}
aside .kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:14px}aside .kv span{color:var(--muted)}
.cli h2{margin-top:40px}.cmdref{margin:26px 0 34px}.cmdref h3{font-size:18px;margin:0 0 8px;font-family:var(--mono)}.cmdref h3 code{background:none;padding:0}
.cmdref p{max-width:70ch;margin:8px 0}
pre.usage,pre.examples{background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:10px 14px;overflow-x:auto;font-size:13px;margin:8px 0}
pre.examples .dollar{color:var(--muted)}pre.examples .note{color:var(--muted)}
.flags{border:1px solid var(--line);border-radius:8px;margin:10px 0;overflow:hidden}
.flags div{display:grid;grid-template-columns:minmax(150px,220px) 1fr;gap:12px;padding:8px 12px;border-top:1px solid var(--line);font-size:14px}.flags div:first-child{border-top:0}
.flags code{white-space:nowrap;background:none;padding:0;font-size:13px}.flags span{color:var(--fg)}
@media(max-width:600px){.flags div{grid-template-columns:1fr}}
.hb{display:inline-flex;align-items:center;gap:6px;margin:0 10px 4px 0;font-size:13px;color:var(--muted);white-space:nowrap}
td.harnesses{min-width:220px}
.variant{border-top:1px solid var(--line);margin-top:30px;padding-top:6px}.variant h2{text-transform:none;letter-spacing:0;color:var(--fg);font-size:20px;display:flex;align-items:center;gap:10px}
footer{border-top:1px solid var(--line);margin-top:50px;padding:26px 0;color:var(--muted);font-size:13px}
footer .wrap{display:flex;gap:18px;flex-wrap:wrap}
`

const JS = `
const q=document.querySelector('#q'),tabs=[...document.querySelectorAll('.tabs button')],rows=[...document.querySelectorAll('tr.mod')];
let harness='all';
function apply(){const t=(q?.value||'').toLowerCase();let n=0;for(const r of rows){const ok=(harness==='all'||r.dataset.harness.split(' ').includes(harness))&&r.dataset.text.includes(t);r.hidden=!ok;if(ok)n++}const e=document.querySelector('#none');if(e)e.hidden=n>0}
q?.addEventListener('input',apply);
for(const b of tabs)b.addEventListener('click',()=>{harness=b.dataset.harness;tabs.forEach(x=>x.classList.toggle('on',x===b));apply()});
`

function layout(opts: { title: string; depth: number; nav: string; body: string; js?: boolean; description?: string; path?: string }) {
  const rel = "../".repeat(opts.depth) || "./"
  const link = (p: string) => rel + p
  const on = (k: string) => (opts.nav === k ? ' class="on"' : "")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description ?? "Source-level mods for open-source harnesses.")}">
${SITE_URL ? `<link rel="canonical" href="${SITE_URL}/${opts.path ?? ""}">\n<meta property="og:title" content="${esc(opts.title)}">\n<meta property="og:description" content="${esc(opts.description ?? "Source-level mods for open-source harnesses.")}">\n<meta property="og:url" content="${SITE_URL}/${opts.path ?? ""}">` : ""}
<link rel="stylesheet" href="${link("style.css")}">
</head>
<body>
<header><div class="wrap">
<a class="brand" href="${link("")}">openmods</a>
<nav>
<a href="${link("")}#mods"${on("mods")}>Mods</a>
<a href="${link("harnesses/")}"${on("harnesses")}>Harnesses</a>
<a href="${link("make-a-mod/")}"${on("make")}>Make a mod</a>
<a href="${link("cli/")}"${on("cli")}>CLI</a>
<a href="https://github.com/${REPO}">GitHub</a>
</nav>
</div></header>
${opts.body}
<footer><div class="wrap">
<span>${SITE_NAME} is open source under MIT.</span>
<a href="https://github.com/${REPO}">Source on GitHub</a>
<a href="https://github.com/${REPO}/issues">Issues</a>
<span>Each mod carries its own license; each harness keeps its upstream license.</span>
</div></footer>
${opts.js ? `<script>${JS}</script>` : ""}
</body>
</html>
`
}

const harnessOf = (id: string) => harnesses.find((h) => h.id === id)!
const behind = (m: Mod) => {
  const latest = harnessOf(m.harness).latest
  return !!latest && latest !== m.upstream.ref && newer(latest, m.upstream.ref)
}
const badge = (m: Mod) => {
  const latest = harnessOf(m.harness).latest ?? ""
  return behind(m)
    ? `<span class="badge behind" title="Latest ${esc(harnessOf(m.harness).name)} is ${esc(rel(latest))}">${esc(rel(m.upstream.ref))} · behind</span>`
    : `<span class="badge ok" title="Latest ${esc(harnessOf(m.harness).name)} release">${esc(rel(m.upstream.ref))}</span>`
}
const maintainers = (e: Entry) => e.maintainers ?? (e.author?.github ? [e.author.github] : [])
const modUrl = (e: Entry, depth: number) => `${"../".repeat(depth)}mods/${e.owner}/${e.name}/`
const harnessBadges = (e: Entry) => e.variants.map((m) => `<span class="hb">${esc(harnessOf(m.harness).name)} ${badge(m)}</span>`).join(" ")

function renderDiff(diff: string) {
  return diff
    .split("\n")
    .map((l) => {
      const e = esc(l)
      if (l.startsWith("diff --git")) return `<span class="f">${e}</span>`
      if (l.startsWith("@@")) return `<span class="h">${e}</span>`
      if (l.startsWith("+") && !l.startsWith("+++")) return `<span class="a">${e}</span>`
      if (l.startsWith("-") && !l.startsWith("---")) return `<span class="d">${e}</span>`
      return e
    })
    .join("\n")
}

// ------------------------------------------------------------------ pages

function home() {
  const rows = entries
    .map(
      (e) => `<tr class="mod" data-harness="${e.variants.map((m) => m.harness).join(" ")}" data-text="${esc(`${e.id} ${e.description} ${(e.tags ?? []).join(" ")} ${e.variants.map((m) => m.harness).join(" ")}`.toLowerCase())}">
<td class="name"><a href="${modUrl(e, 0)}">${esc(e.id)}</a><div class="desc">${esc(e.description)}</div></td>
<td class="harnesses">${harnessBadges(e)}${e.local ? ' <span class="badge local" title="Unpublished; from ~/.openmods/local on this machine">local</span>' : ""}</td>
</tr>`,
    )
    .join("\n")
  const tabs = [`<button class="on" data-harness="all">All</button>`, ...harnesses.map((h) => `<button data-harness="${h.id}">${esc(h.name)}</button>`)].join("")
  const body = `
<section class="hero"><div class="wrap">
<pre aria-hidden="true">${WORDMARK}</pre>
<h1>Source-level mods for open-source harnesses.</h1>
<p>A mod is a set of patches to a harness like OpenCode or Codex, made against one of its releases. Install one and your <code>opencode</code> becomes that release with the mod built in. Your stock install is never touched, and you can switch back any time.</p>
<div class="cmd"><span class="dollar">$</span><span>curl -fsSL https://openmods.dev/install.sh | sh</span></div>
<p style="margin:10px 0 0;color:var(--muted);font-size:14px">Installs the <code>openmods</code> command. Then <code>openmods install &lt;owner&gt;/&lt;mod&gt;</code>, and pick the harness. <a href="install.sh">Read the script first</a> if you like; it is short.</p>
<div class="chips">
${harnesses.map((h) => `<a class="chip" href="harnesses/${h.id}/">${esc(h.name)} · ${esc(rel(h.latest ?? ""))}</a>`).join("")}
${PLANNED.map((p) => `<span class="chip dim" title="Planned">${esc(p.name)} · planned</span>`).join("")}
</div>
</div></section>
<section class="wrap" id="mods">
<h2>Mods</h2>
<div class="toolbar"><input id="q" type="search" placeholder="Search mods" aria-label="Search mods"><div class="tabs">${tabs}</div></div>
${
  entries.length
    ? `<div class="table"><table><thead><tr><th>Mod</th><th>Harnesses and releases</th></tr></thead><tbody>${rows}</tbody></table></div><div id="none" class="empty" hidden>No mods match.</div>`
    : `<div class="empty">No mods published yet. <a href="make-a-mod/">Make the first one.</a></div>`
}
<h2>How it works</h2>
<div class="md"><p>A mod is named <code>owner/mod</code> and supports one or more harnesses, each with its own patches made against one of that harness's releases. <code>openmods install</code> clones that release, applies the patches, builds it with the exact toolchain the release pins, and puts the result first on your PATH. <code>openmods off</code> steps aside so the stock binary runs again.</p>
<p>When a harness ships a new release, CI applies and typechecks every mod for it. A mod that still works has its release moved forward here automatically. A mod that does not stays on its last working release, shows as <span class="badge behind">behind</span>, and its maintainers get an issue with the error and the steps to rebase.</p></div>
</section>`
  return layout({ title: `${SITE_NAME} · source-level mods for open-source harnesses`, depth: 0, nav: "mods", body, js: true, path: "" })
}

// The mods this one cannot be installed together with on a harness.
function clash(m: Mod) {
  const list = clashes.get(m) ?? []
  if (!list.length) return ""
  const h = harnessOf(m.harness)
  return `<div class="notice clash"><b>Cannot be installed together with</b> these ${esc(h.name)} mods; openmods refuses the combination:<ul>${list
    .map((c) => `<li><a href="../../../mods/${esc(c.mod.owner)}/${esc(c.mod.name)}/#${esc(m.harness)}">${esc(c.mod.id)}</a>: ${esc(c.why)}</li>`)
    .join("")}</ul></div>`
}

function modPage(e: Entry) {
  const issues = `https://github.com/${REPO}/issues?q=${encodeURIComponent(`is:issue is:open "${e.id} does not support"`)}`
  const section = (m: Mod) => {
    const h = harnessOf(m.harness)
    const added = m.files.reduce((n, f) => n + f.added, 0)
    const removed = m.files.reduce((n, f) => n + f.removed, 0)
    const notice = behind(m)
      ? `<div class="notice behind">On ${esc(h.name)} this mod is for <b>${esc(rel(m.upstream.ref))}</b>. The latest release is <b>${esc(rel(h.latest ?? ""))}</b>${m.status && !m.status.ok && m.status.tested === h.latest ? `, and CI found it no longer applies or typechecks there` : ""}. Installing it builds ${esc(rel(m.upstream.ref))}, which still works. <a href="${issues}">Open issues</a> · <a href="../../../make-a-mod/#updating-a-mod-for-a-new-release">How to rebase it</a></div>`
      : `<div class="notice ok">Works on the latest ${esc(h.name)} release, ${esc(rel(m.upstream.ref))}.</div>`
    const files = m.files
      .map((f) => `<div><span>${esc(f.path)}${f.isNew ? ' <span class="badge local">new</span>' : ""}</span><span><span class="plus">+${f.added}</span> <span class="minus">−${f.removed}</span></span></div>`)
      .join("")
    return `<section class="variant" id="${m.harness}">
<h2>${esc(h.name)} ${badge(m)}</h2>
<div class="cmd block"><span class="dollar">$</span><span>openmods install ${esc(e.id)} --${esc(m.harness)}</span></div>
<div class="stats">
<div class="stat"><b>${esc(rel(m.upstream.ref))}</b><span>${esc(h.name)} release</span></div>
<div class="stat"><b>${m.files.length}</b><span>file${m.files.length === 1 ? "" : "s"} touched</span></div>
<div class="stat"><b><span class="plus">+${added}</span> <span class="minus">−${removed}</span></b><span>lines</span></div>
<div class="stat"><b>${m.patches.length}</b><span>patch${m.patches.length === 1 ? "" : "es"}</span></div>
<div class="stat"><b>${m.versions[0]!.update ?? 1}</b><span>update</span></div>
</div>
${m.versions[0]!.note ? `<p class="releases">Update ${m.versions[0]!.update ?? 1}: ${esc(m.versions[0]!.note!)}</p>` : ""}
${m.versions.length > 1 ? `<p class="releases">Has a version for ${esc(h.name)} ${m.versions.map((v) => `${esc(rel(v.ref))} (update ${v.update ?? 1})`).join(", ")}. openmods builds the newest one all your mods share; the files and diff below are for ${esc(rel(m.upstream.ref))}.</p>` : ""}
${notice}
${clash(m)}
<div class="files">${files}</div>
<details><summary>Full diff for ${esc(h.name)}</summary><pre class="diff">${renderDiff(m.diff)}</pre></details>
</section>`
  }
  const body = `
<div class="wrap page">
<main>
<div class="crumbs"><a href="../../../">mods</a> / ${esc(e.owner)} / ${esc(e.name)}</div>
<h1 class="title">${esc(e.id)}</h1>
<p class="lead">${esc(e.description)}</p>
<div class="cmd block"><span class="dollar">$</span><span>openmods install ${esc(e.id)}</span></div>
<p style="color:var(--muted);font-size:14px;margin-top:-4px">Supports ${e.variants.map((m) => `<a href="#${m.harness}">${esc(harnessOf(m.harness).name)}</a>`).join(" and ")}. ${e.variants.length > 1 ? "Without a harness flag, openmods asks which one." : ""}</p>
<article class="md">${marked.parse(e.readme.replace(/^# .*\n/, "")) as string}</article>
${e.variants.map(section).join("\n")}
</main>
<aside>
<section><h3>Details</h3><div class="kv">
<span>Owner</span><div><a href="https://github.com/${esc(e.owner)}">@${esc(e.owner)}</a></div>
<span>License</span><div>${esc(e.license)}</div>
<span>Maintainer${maintainers(e).length === 1 ? "" : "s"}</span><div>${maintainers(e).map((u) => `<a href="https://github.com/${esc(u)}">@${esc(u)}</a>`).join(", ") || esc(e.author?.name ?? "—")}</div>
${e.tags?.length ? `<span>Tags</span><div>${e.tags.map(esc).join(", ")}</div>` : ""}
</div></section>
<section><h3>Harnesses</h3><div class="kv">
${e.variants.map((m) => `<span>${esc(harnessOf(m.harness).name)}</span><div>${badge(m)}${m.upstream.commit ? ` <a href="${esc(harnessOf(m.harness).repo)}/commit/${esc(m.upstream.commit)}"><code>${esc(m.upstream.ref)}</code></a>` : ""}</div>`).join("\n")}
</div></section>
<section><h3>Links</h3><ul>
<li><a href="https://github.com/${REPO}/tree/main/mods/${e.owner}/${e.name}">Source in the registry</a></li>
<li><a href="${issues}">Issues for this mod</a></li>
</ul></section>
<section><h3>Switch</h3><ul>
<li><code>openmods off</code> stock harness again</li>
<li><code>openmods on</code> mods back</li>
<li><code>openmods uninstall ${esc(e.id)}</code></li>
</ul></section>
</aside>
</div>`
  return layout({ title: `${e.id} · ${SITE_NAME}`, depth: 3, nav: "mods", body, description: e.description, path: `mods/${e.owner}/${e.name}/` })
}

function harnessIndex() {
  const rows = [
    ...harnesses.map(
      (h) => `<tr class="mod"><td class="name"><a href="${h.id}/">${esc(h.name)}</a><div class="desc">${esc(h.language ?? "")}</div></td><td><span class="badge ok">${esc(rel(h.latest ?? ""))}</span></td><td class="num">${entries.filter((e) => e.variants.some((m) => m.harness === h.id)).length}</td></tr>`,
    ),
    ...PLANNED.map((p) => `<tr><td class="name"><a href="${esc(p.repo)}">${esc(p.name)}</a><div class="desc">Planned. Open source, so it can be a harness; it needs a definition and one mod.</div></td><td><span class="badge local">planned</span></td><td class="num">0</td></tr>`),
  ].join("")
  const body = `<div class="wrap"><section><h2>Harnesses</h2>
<p class="lead">Anything open source with a build command can be a harness. Each one is a JSON file in the registry naming its repo, its install and build commands, and where the built executable ends up.</p>
<div class="table"><table><thead><tr><th>Harness</th><th>Latest release</th><th style="text-align:right">Mods</th></tr></thead><tbody>${rows}</tbody></table></div></section></div>`
  return layout({ title: `Harnesses · ${SITE_NAME}`, depth: 1, nav: "harnesses", body, path: "harnesses/" })
}

function harnessPage(h: Harness) {
  const list = entries.filter((e) => e.variants.some((m) => m.harness === h.id))
  const rows = list
    .map((e) => `<tr class="mod"><td class="name"><a href="../../mods/${e.owner}/${e.name}/#${h.id}">${esc(e.id)}</a><div class="desc">${esc(e.description)}</div></td><td>${badge(e.variants.find((m) => m.harness === h.id)!)}</td></tr>`)
    .join("")
  const body = `<div class="wrap page"><main>
<div class="crumbs"><a href="../">harnesses</a> / ${esc(h.id)}</div>
<h1 class="title">${esc(h.name)}</h1>
<p class="lead">${esc(h.language ?? "")}. Latest release <b>${esc(rel(h.latest ?? ""))}</b> (tag <code>${esc(h.latest ?? "")}</code>).</p>
<div class="cmd block"><span class="dollar">$</span><span>openmods install &lt;owner&gt;/&lt;mod&gt; --${esc(h.id)}</span></div>
<h2>Mods for ${esc(h.name)}</h2>
${list.length ? `<div class="table"><table><tbody>${rows}</tbody></table></div>` : `<div class="empty">No mods yet. <a href="../../make-a-mod/">Make the first one.</a></div>`}
</main><aside>
<section><h3>Links</h3><ul><li><a href="${esc(h.repo)}">Repository</a></li>${h.homepage ? `<li><a href="${esc(h.homepage)}">Website</a></li>` : ""}<li><a href="https://github.com/${REPO}/blob/main/harnesses/${h.id}.json">Harness definition</a></li></ul></section>
<section><h3>What a mod can change</h3><p style="color:var(--muted);margin:0">Anything. A mod is a patch to the source, so the interface, the prompts, the tools and the agent loop are all in reach. That is also why every mod's diff is on its page.</p></section>
</aside></div>`
  return layout({ title: `${h.name} · ${SITE_NAME}`, depth: 2, nav: "harnesses", body, path: `harnesses/${h.id}/` })
}

function cliPage() {
  const group = (title: string, audience: "users" | "authors") => {
    const list = COMMANDS.filter((c) => c.audience === audience)
    return `<h2 id="${audience}">${esc(title)}</h2>
<div class="table"><table><tbody>${list.map((c) => `<tr class="mod"><td class="name"><a href="#${c.name}">${esc(c.name)}</a></td><td>${esc(c.summary)}</td></tr>`).join("")}</tbody></table></div>
${list
  .map(
    (c) => `<section class="cmdref" id="${c.name}">
<h3><code>${esc(c.name)}</code>${c.aliases?.length ? ` <span class="badge local">also ${c.aliases.map(esc).join(", ")}</span>` : ""}</h3>
<pre class="usage">${c.usage.split("\n").map(esc).join("\n")}</pre>
${c.description.map((d) => `<p>${esc(d)}</p>`).join("")}
${c.flags?.length ? `<div class="flags">${c.flags.map((f) => `<div><code>${esc(f.flag)}</code><span>${esc(f.description)}</span></div>`).join("")}</div>` : ""}
${c.examples?.length ? `<pre class="examples">${c.examples.map((e) => `<span class="dollar">$ </span>${esc(e.command)}${e.note ? `   <span class="note"># ${esc(e.note)}</span>` : ""}`).join("\n")}</pre>` : ""}
</section>`,
  )
  .join("")}`
  }
  const kv = (title: string, id: string, list: typeof GLOBAL_FLAGS) =>
    `<h2 id="${id}">${esc(title)}</h2><div class="flags">${list.map((f) => `<div><code>${esc(f.flag)}</code><span>${esc(f.description)}</span></div>`).join("")}</div>`
  const body = `<div class="wrap page"><main class="cli">
<h1 class="title">openmods</h1>
<p class="lead">${esc(INTRO)}</p>
<div class="cmd block"><span class="dollar">$</span><span>curl -fsSL https://openmods.dev/install.sh | sh</span></div>
<p style="color:var(--muted);font-size:14px">Every command also answers <code>openmods help &lt;command&gt;</code>. This page and that text come from the same source.</p>
${group("Commands", "users")}
${group("For mod authors", "authors")}
${kv("Options", "options", GLOBAL_FLAGS)}
${kv("Environment", "environment", ENVIRONMENT)}
${kv("Files", "files", FILES)}
</main>
<aside><section><h3>On this page</h3><ul>${COMMANDS.map((c) => `<li><a href="#${c.name}"><code>${esc(c.name)}</code></a></li>`).join("")}<li><a href="#options">options</a></li><li><a href="#environment">environment</a></li><li><a href="#files">files</a></li></ul></section></aside>
</div>`
  return layout({ title: `CLI reference · ${SITE_NAME}`, depth: 1, nav: "cli", body, path: "cli/", description: "Every openmods command, option, environment variable and file." })
}

function makePage() {
  const md = readFileSync(path.join(root, "CONTRIBUTING.md"), "utf8")
  const html = (marked.parse(md, { renderer: headingIds() }) as string).replace(/<h1>.*?<\/h1>/, "")
  const body = `<div class="wrap page"><main><h1 class="title">Make a mod</h1><p class="lead">Clone the harness, change what you want, commit, pack. The registry does the rest.</p><article class="md">${html}</article></main>
<aside><section><h3>Commands</h3><ul><li><code>openmods pack . --name my-mod --local</code></li><li><code>openmods install you/my-mod --opencode</code></li><li><code>openmods check mods/you/my-mod/opencode --build</code></li></ul></section>
<section><h3>Links</h3><ul><li><a href="https://github.com/${REPO}/blob/main/CONTRIBUTING.md">This guide on GitHub</a></li><li><a href="https://github.com/${REPO}/blob/main/schema/mod.schema.json">mod.json schema</a></li></ul></section></aside></div>`
  return layout({ title: `Make a mod · ${SITE_NAME}`, depth: 1, nav: "make", body, path: "make-a-mod/" })
}

function headingIds() {
  const r = new marked.Renderer()
  r.heading = ({ text, depth }) => {
    const id = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
    return `<h${depth} id="${id}">${text}</h${depth}>\n`
  }
  return r
}

// ------------------------------------------------------------------ write

const write = (rel: string, html: string) => {
  const file = path.join(out, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, html)
}
write("style.css", CSS.trim() + "\n")
write("index.html", home())
write("harnesses/index.html", harnessIndex())
for (const h of harnesses) write(`harnesses/${h.id}/index.html`, harnessPage(h))
for (const e of entries) write(`mods/${e.owner}/${e.name}/index.html`, modPage(e))
write("make-a-mod/index.html", makePage())
write("cli/index.html", cliPage())
write(".nojekyll", "")
// The CLI installer, served at /install.sh so `curl -fsSL https://openmods.dev/install.sh | sh` works.
const installer = path.join(root, "install.sh")
if (existsSync(installer)) write("install.sh", readFileSync(installer, "utf8"))
write("404.html", layout({ title: `Not found · ${SITE_NAME}`, depth: 0, nav: "", body: `<div class="wrap"><section class="hero"><h1>Not found</h1><p>There is no page here. <a href="./">Back to the mods.</a></p></section></div>`, path: "404" }))
if (process.env.SITE_DOMAIN) write("CNAME", process.env.SITE_DOMAIN.trim() + "\n")
write("index.json", JSON.stringify({ generated: new Date().toISOString(), harnesses: harnesses.map((h) => ({ id: h.id, name: h.name, latest: rel(h.latest ?? ""), tag: h.latest })), mods: entries.map((e) => ({ id: e.id, owner: e.owner, name: e.name, description: e.description, harnesses: Object.fromEntries(e.variants.map((m) => [m.harness, { for: rel(m.upstream.ref), tag: m.upstream.ref, behind: behind(m), files: m.files.length, update: m.versions[0]!.update ?? 1, releases: m.versions.map((v) => ({ release: rel(v.ref), update: v.update ?? 1 })), incompatible: (clashes.get(m) ?? []).map((c) => c.mod.id) }])) })) }, null, 2))
console.log(`site: ${entries.length} mod${entries.length === 1 ? "" : "s"}, ${harnesses.length} harness${harnesses.length === 1 ? "" : "es"} → ${path.relative(process.cwd(), out) || "."}`)
