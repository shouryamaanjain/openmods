#!/usr/bin/env bun
// Builds the OpenMods site from the registry: one static page per mod and
// per harness, plus the home page and the "make a mod" guide. No backend;
// CI regenerates it on every push to main and publishes it to GitHub Pages.
//
//   bun script/site.ts [--registry <dir>] [--out <dir>] [--offline] [--local]
//
// --local also lists the unpublished mods under ~/.open-mods/local, marked as
// such, for previewing the site with content that is not in the registry.
// SITE_DOMAIN=mods.example.com writes a CNAME file for GitHub Pages.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { marked } from "marked"

const args = process.argv.slice(2)
const flag = (k: string) => {
  const i = args.indexOf(`--${k}`)
  return i === -1 ? undefined : args[i + 1]
}
const root = path.resolve(flag("registry") ?? path.join(import.meta.dir, ".."))
const out = path.resolve(flag("out") ?? path.join(root, "site"))
const REPO = process.env.SITE_REPO ?? "shouryamaanjain/open-mods"
const SITE_NAME = "OpenMods"

type Harness = { id: string; name: string; repo: string; homepage?: string; language?: string; binary: string; releaseTagPattern?: string; latest?: string }
type Mod = {
  name: string
  harness: string
  description: string
  author?: { name?: string; github?: string }
  maintainers?: string[]
  license: string
  tags?: string[]
  upstream: { ref: string; commit: string }
  patches: string[]
  dir: string
  readme: string
  status?: { tested: string; supports: string; ok: boolean; error?: string; checked: string }
  files: { path: string; added: number; removed: number; isNew: boolean }[]
  diff: string
  local?: boolean
}

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

function modsIn(base: string, h: Harness, local: boolean): Mod[] {
  const dir = path.join(base, h.id)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(dir, d.name, "mod.json")))
    .map((d) => {
      const mdir = path.join(dir, d.name)
      const mod = readJson(path.join(mdir, "mod.json"))
      const status = existsSync(path.join(mdir, "status.json")) ? readJson(path.join(mdir, "status.json")) : undefined
      const readme = existsSync(path.join(mdir, "README.md")) ? readFileSync(path.join(mdir, "README.md"), "utf8") : ""
      return { ...mod, dir: mdir, readme, status, local, ...parsePatches(mdir, mod.patches) } as Mod
    })
}

const mods: Mod[] = harnesses.flatMap((h) => {
  const published = modsIn(path.join(root, "mods"), h, false)
  if (!args.includes("--local")) return published
  const local = modsIn(path.join(process.env.OPEN_MODS_HOME ?? path.join(homedir(), ".open-mods"), "local"), h, true).filter(
    (l) => !published.some((p) => p.name === l.name),
  )
  return [...published, ...local]
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
footer{border-top:1px solid var(--line);margin-top:50px;padding:26px 0;color:var(--muted);font-size:13px}
footer .wrap{display:flex;gap:18px;flex-wrap:wrap}
`

const JS = `
const q=document.querySelector('#q'),tabs=[...document.querySelectorAll('.tabs button')],rows=[...document.querySelectorAll('tr.mod')];
let harness='all';
function apply(){const t=(q?.value||'').toLowerCase();let n=0;for(const r of rows){const ok=(harness==='all'||r.dataset.harness===harness)&&r.dataset.text.includes(t);r.hidden=!ok;if(ok)n++}const e=document.querySelector('#none');if(e)e.hidden=n>0}
q?.addEventListener('input',apply);
for(const b of tabs)b.addEventListener('click',()=>{harness=b.dataset.harness;tabs.forEach(x=>x.classList.toggle('on',x===b));apply()});
`

function layout(opts: { title: string; depth: number; nav: string; body: string; js?: boolean; description?: string }) {
  const rel = "../".repeat(opts.depth) || "./"
  const link = (p: string) => rel + p
  const on = (k: string) => (opts.nav === k ? ' class="on"' : "")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description ?? "Source-level mods for open-source coding agents.")}">
<link rel="stylesheet" href="${link("style.css")}">
</head>
<body>
<header><div class="wrap">
<a class="brand" href="${link("")}">open-mods</a>
<nav>
<a href="${link("")}#mods"${on("mods")}>Mods</a>
<a href="${link("harnesses/")}"${on("harnesses")}>Harnesses</a>
<a href="${link("make-a-mod/")}"${on("make")}>Make a mod</a>
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
const maintainers = (m: Mod) => m.maintainers ?? (m.author?.github ? [m.author.github] : [])
const modUrl = (m: Mod, depth: number) => `${"../".repeat(depth)}mods/${m.harness}/${m.name}/`
const installCmd = (m: Mod) => `open-mods install ${m.harness}/${m.name}`

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
  const sorted = [...mods].sort((a, b) => a.harness.localeCompare(b.harness) || a.name.localeCompare(b.name))
  const rows = sorted
    .map(
      (m) => `<tr class="mod" data-harness="${m.harness}" data-text="${esc(`${m.harness}/${m.name} ${m.description} ${(m.tags ?? []).join(" ")}`.toLowerCase())}">
<td class="name"><a href="${modUrl(m, 0)}">${esc(m.harness)}/${esc(m.name)}</a><div class="desc">${esc(m.description)}</div></td>
<td>${badge(m)}${m.local ? ' <span class="badge local" title="Unpublished; from ~/.open-mods/local on this machine">local</span>' : ""}</td>
<td class="num hide-sm">${m.files.length} file${m.files.length === 1 ? "" : "s"}</td>
<td class="num hide-sm"><span class="plus">+${m.files.reduce((n, f) => n + f.added, 0)}</span> <span class="minus">−${m.files.reduce((n, f) => n + f.removed, 0)}</span></td>
</tr>`,
    )
    .join("\n")
  const tabs = [`<button class="on" data-harness="all">All</button>`, ...harnesses.map((h) => `<button data-harness="${h.id}">${esc(h.name)}</button>`)].join("")
  const body = `
<section class="hero"><div class="wrap">
<pre aria-hidden="true">${WORDMARK}</pre>
<h1>Source-level mods for open-source coding agents.</h1>
<p>A mod is a set of patches against a release of a harness like OpenCode. Install one and your <code>opencode</code> becomes that release with the mod built in. Your stock install is never touched, and you can switch back any time.</p>
<div class="cmd"><span class="dollar">$</span><span>open-mods install &lt;harness&gt;/&lt;mod&gt;</span></div>
<div class="chips">
${harnesses.map((h) => `<a class="chip" href="harnesses/${h.id}/">${esc(h.name)} · ${esc(rel(h.latest ?? ""))}</a>`).join("")}
${PLANNED.map((p) => `<span class="chip dim" title="Planned">${esc(p.name)} · planned</span>`).join("")}
</div>
</div></section>
<section class="wrap" id="mods">
<h2>Mods</h2>
<div class="toolbar"><input id="q" type="search" placeholder="Search mods" aria-label="Search mods"><div class="tabs">${tabs}</div></div>
${
  mods.length
    ? `<div class="table"><table><thead><tr><th>Mod</th><th>For release</th><th class="hide-sm" style="text-align:right">Touches</th><th class="hide-sm" style="text-align:right">Lines</th></tr></thead><tbody>${rows}</tbody></table></div><div id="none" class="empty" hidden>No mods match.</div>`
    : `<div class="empty">No mods published yet. <a href="make-a-mod/">Make the first one.</a></div>`
}
<h2>How it works</h2>
<div class="md"><p>Every mod is a git patch series made against one release of its harness. <code>open-mods install</code> clones that release, applies the patches, builds it with the exact toolchain the release pins, and puts the result first on your PATH. <code>open-mods off</code> steps aside so the stock binary runs again.</p>
<p>When the harness ships a new release, CI applies and builds every mod against it. A mod that still works has its release moved forward here automatically. A mod that does not stays on its last working release, shows as <span class="badge behind">behind</span>, and its maintainers get an issue with the error and the steps to rebase.</p></div>
</section>`
  return layout({ title: `${SITE_NAME} · source-level mods for open-source coding agents`, depth: 0, nav: "mods", body, js: true })
}

function modPage(m: Mod) {
  const h = harnessOf(m.harness)
  const added = m.files.reduce((n, f) => n + f.added, 0)
  const removed = m.files.reduce((n, f) => n + f.removed, 0)
  const issues = `https://github.com/${REPO}/issues?q=${encodeURIComponent(`is:issue is:open "${m.harness}/${m.name} does not support"`)}`
  const notice = behind(m)
    ? `<div class="notice behind">This mod is for ${esc(h.name)} <b>${esc(rel(m.upstream.ref))}</b>. The latest release is <b>${esc(rel(h.latest ?? ""))}</b>${m.status && !m.status.ok && m.status.tested === h.latest ? `, and CI found it no longer applies or builds there` : ""}. Installing it builds ${esc(rel(m.upstream.ref))}, which still works. <a href="${issues}">Open issues</a> · <a href="../../../make-a-mod/#updating-a-mod-for-a-new-release">How to rebase it</a></div>`
    : `<div class="notice ok">Works on the latest ${esc(h.name)} release, ${esc(rel(m.upstream.ref))}.</div>`
  const files = m.files
    .map((f) => `<div><span>${esc(f.path)}${f.isNew ? ' <span class="badge local">new</span>' : ""}</span><span><span class="plus">+${f.added}</span> <span class="minus">−${f.removed}</span></span></div>`)
    .join("")
  const body = `
<div class="wrap page">
<main>
<div class="crumbs"><a href="../../../">mods</a> / <a href="../../../harnesses/${h.id}/">${esc(h.id)}</a> / ${esc(m.name)}</div>
<h1 class="title">${esc(m.name)}</h1>
<p class="lead">${esc(m.description)}</p>
<div class="cmd block"><span class="dollar">$</span><span>${esc(installCmd(m))}</span></div>
<div class="stats">
<div class="stat"><b>${esc(rel(m.upstream.ref))}</b><span>${esc(h.name)} release</span></div>
<div class="stat"><b>${m.files.length}</b><span>file${m.files.length === 1 ? "" : "s"} touched</span></div>
<div class="stat"><b><span class="plus">+${added}</span> <span class="minus">−${removed}</span></b><span>lines</span></div>
<div class="stat"><b>${m.patches.length}</b><span>patch${m.patches.length === 1 ? "" : "es"}</span></div>
</div>
${notice}
<article class="md">${marked.parse(m.readme.replace(/^# .*\n/, "")) as string}</article>
<h2>What it touches</h2>
<div class="files">${files}</div>
<details><summary>Full diff</summary><pre class="diff">${renderDiff(m.diff)}</pre></details>
</main>
<aside>
<section><h3>Details</h3><div class="kv">
<span>License</span><div>${esc(m.license)}</div>
<span>Maintainer${maintainers(m).length === 1 ? "" : "s"}</span><div>${maintainers(m).map((u) => `<a href="https://github.com/${esc(u)}">@${esc(u)}</a>`).join(", ") || esc(m.author?.name ?? "—")}</div>
${m.upstream.commit ? `<span>Tag</span><div><code>${esc(m.upstream.ref)}</code></div>
<span>Commit</span><div><a href="${esc(h.repo)}/commit/${esc(m.upstream.commit)}"><code>${esc(m.upstream.commit.slice(0, 10))}</code></a></div>` : ""}
${m.tags?.length ? `<span>Tags</span><div>${m.tags.map(esc).join(", ")}</div>` : ""}
</div></section>
<section><h3>Links</h3><ul>
<li><a href="https://github.com/${REPO}/tree/main/mods/${m.harness}/${m.name}">Source in the registry</a></li>
<li><a href="${esc(h.repo)}">${esc(h.name)} on GitHub</a></li>
<li><a href="${issues}">Issues for this mod</a></li>
</ul></section>
<section><h3>Switch</h3><ul>
<li><code>open-mods off</code> stock ${esc(h.binary)} again</li>
<li><code>open-mods on</code> mods back</li>
<li><code>open-mods uninstall ${esc(m.harness)}/${esc(m.name)}</code></li>
</ul></section>
</aside>
</div>`
  return layout({ title: `${m.harness}/${m.name} · ${SITE_NAME}`, depth: 3, nav: "mods", body, description: m.description })
}

function harnessIndex() {
  const rows = [
    ...harnesses.map(
      (h) => `<tr class="mod"><td class="name"><a href="${h.id}/">${esc(h.name)}</a><div class="desc">${esc(h.language ?? "")}</div></td><td><span class="badge ok">${esc(rel(h.latest ?? ""))}</span></td><td class="num">${mods.filter((m) => m.harness === h.id).length}</td></tr>`,
    ),
    ...PLANNED.map((p) => `<tr><td class="name"><a href="${esc(p.repo)}">${esc(p.name)}</a><div class="desc">Planned. Open source, so it can be a harness; it needs a definition and one mod.</div></td><td><span class="badge local">planned</span></td><td class="num">0</td></tr>`),
  ].join("")
  const body = `<div class="wrap"><section><h2>Harnesses</h2>
<p class="lead">Anything open source with a build command can be a harness. Each one is a JSON file in the registry naming its repo, its install and build commands, and where the built executable ends up.</p>
<div class="table"><table><thead><tr><th>Harness</th><th>Latest release</th><th style="text-align:right">Mods</th></tr></thead><tbody>${rows}</tbody></table></div></section></div>`
  return layout({ title: `Harnesses · ${SITE_NAME}`, depth: 1, nav: "harnesses", body })
}

function harnessPage(h: Harness) {
  const list = mods.filter((m) => m.harness === h.id)
  const rows = list
    .map((m) => `<tr class="mod"><td class="name"><a href="../../mods/${m.harness}/${m.name}/">${esc(m.name)}</a><div class="desc">${esc(m.description)}</div></td><td>${badge(m)}</td></tr>`)
    .join("")
  const body = `<div class="wrap page"><main>
<div class="crumbs"><a href="../">harnesses</a> / ${esc(h.id)}</div>
<h1 class="title">${esc(h.name)}</h1>
<p class="lead">${esc(h.language ?? "")}. Latest release <b>${esc(rel(h.latest ?? ""))}</b> (tag <code>${esc(h.latest ?? "")}</code>).</p>
<div class="cmd block"><span class="dollar">$</span><span>open-mods install ${esc(h.id)}/&lt;mod&gt;</span></div>
<h2>Mods for ${esc(h.name)}</h2>
${list.length ? `<div class="table"><table><tbody>${rows}</tbody></table></div>` : `<div class="empty">No mods yet. <a href="../../make-a-mod/">Make the first one.</a></div>`}
</main><aside>
<section><h3>Links</h3><ul><li><a href="${esc(h.repo)}">Repository</a></li>${h.homepage ? `<li><a href="${esc(h.homepage)}">Website</a></li>` : ""}<li><a href="https://github.com/${REPO}/blob/main/harnesses/${h.id}.json">Harness definition</a></li></ul></section>
<section><h3>What a mod can change</h3><p style="color:var(--muted);margin:0">Anything. A mod is a patch to the source, so the interface, the prompts, the tools and the agent loop are all in reach. That is also why every mod's diff is on its page.</p></section>
</aside></div>`
  return layout({ title: `${h.name} · ${SITE_NAME}`, depth: 2, nav: "harnesses", body })
}

function makePage() {
  const md = readFileSync(path.join(root, "CONTRIBUTING.md"), "utf8")
  const html = (marked.parse(md, { renderer: headingIds() }) as string).replace(/<h1>.*?<\/h1>/, "")
  const body = `<div class="wrap page"><main><h1 class="title">Make a mod</h1><p class="lead">Clone the harness, change what you want, commit, pack. The registry does the rest.</p><article class="md">${html}</article></main>
<aside><section><h3>Commands</h3><ul><li><code>open-mods pack . --name my-mod --local</code></li><li><code>open-mods install opencode/my-mod</code></li><li><code>open-mods check mods/opencode/my-mod --build</code></li></ul></section>
<section><h3>Links</h3><ul><li><a href="https://github.com/${REPO}/blob/main/CONTRIBUTING.md">This guide on GitHub</a></li><li><a href="https://github.com/${REPO}/blob/main/schema/mod.schema.json">mod.json schema</a></li></ul></section></aside></div>`
  return layout({ title: `Make a mod · ${SITE_NAME}`, depth: 1, nav: "make", body })
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
for (const m of mods) write(`mods/${m.harness}/${m.name}/index.html`, modPage(m))
write("make-a-mod/index.html", makePage())
write(".nojekyll", "")
if (process.env.SITE_DOMAIN) write("CNAME", process.env.SITE_DOMAIN.trim() + "\n")
write("index.json", JSON.stringify({ generated: new Date().toISOString(), harnesses: harnesses.map((h) => ({ id: h.id, name: h.name, latest: rel(h.latest ?? ""), tag: h.latest })), mods: mods.map((m) => ({ harness: m.harness, name: m.name, description: m.description, for: rel(m.upstream.ref), tag: m.upstream.ref, behind: behind(m), files: m.files.length })) }, null, 2))
console.log(`site: ${mods.length} mod${mods.length === 1 ? "" : "s"}, ${harnesses.length} harness${harnesses.length === 1 ? "" : "es"} → ${path.relative(process.cwd(), out) || "."}`)
