// Which mods overlap: change the same lines of a harness release, or lines
// right next to each other. Git cannot merge such changes, so the mods cannot
// be built together. Worked out from the patch text alone, without the
// harness's source, so the CLI can refuse a combination before it builds and
// the site can list it.
//
// A mod's footprint is every place it changes, in the line numbers of the
// release it is for. A mod with several patches is followed patch by patch:
// a later patch that edits lines an earlier one added counts as a change at
// the place those lines were added.

/**
 * Changed lines of one file, as half-open ranges of the release's line
 * numbers: [5, 6] is line 5, [5, 5] is an insertion just before line 5, and
 * [0, Infinity] is the whole file (created, deleted, renamed or binary).
 */
export type Range = [number, number]
export type Footprint = Map<string, Range[]>

const WHOLE: Range = [0, Infinity]

// The file as the patches so far have left it: runs of the release's lines,
// and runs of lines the mod added, each anchored where it was inserted.
type Run = { orig: true; start: number; len: number } | { orig: false; anchor: number; len: number }

// `at` is where the edit lands in the release. A deletion of a line the mod
// itself added (`ours`) changes no release line, only that insertion point.
type Edit = { del: true; line: number; at: number; ours: boolean } | { del: false; before: number; count: number; at: number }

/** The footprint of a mod from its patches, in the order they apply. */
export function footprint(patches: string[]): Footprint {
  const changed: Footprint = new Map()
  const runs = new Map<string, Run[]>()
  const added = new Set<string>() // files the mod created: changed as a whole already
  const mark = (file: string, r: Range) => changed.set(file, [...(changed.get(file) ?? []), r])

  for (const text of patches) {
    for (const section of text.split(/^(?=diff --git )/m).filter((s) => s.startsWith("diff --git "))) {
      const header = section.slice(0, section.search(/^@@ /m) === -1 ? section.length : section.search(/^@@ /m))
      const names = /^diff --git a\/(.+?) b\/(.+)$/m.exec(section)
      if (!names) continue
      const from = /^rename from (.+)$/m.exec(header)?.[1] ?? names[1]!
      const to = /^rename to (.+)$/m.exec(header)?.[1] ?? names[2]!
      if (from !== to) {
        // A rename moves the whole file: nothing else can change either path.
        for (const f of [from, to]) if (!added.has(f)) mark(f, WHOLE)
        added.add(to)
        continue
      }
      const file = to
      if (added.has(file)) continue
      if (/^(new file mode|deleted file mode)/m.test(header) || /^--- \/dev\/null$/m.test(header) || /^(Binary files|GIT binary patch)/m.test(section)) {
        mark(file, WHOLE)
        added.add(file)
        continue
      }
      const state = runs.get(file) ?? [{ orig: true, start: 1, len: Infinity }]
      runs.set(file, state)
      const edits = hunkEdits(section, state)
      for (const e of edits) mark(file, [e.at, e.del && !e.ours ? e.at + 1 : e.at])
      // Bottom up, so the line numbers of edits not yet applied stay valid.
      // On the same line the deletion goes first, so inserted lines take its place.
      edits.sort((a, b) => lineOf(b) - lineOf(a) || (a.del === b.del ? 0 : a.del ? -1 : 1))
      for (const e of edits) {
        if (e.del) {
          split(state, e.line)
          split(state, e.line + 1)
          state.splice(indexAt(state, e.line), 1)
        } else {
          split(state, e.before)
          state.splice(indexAt(state, e.before), 0, { orig: false, anchor: e.at, len: e.count })
        }
      }
    }
  }
  return changed
}

const lineOf = (e: Edit) => (e.del ? e.line : e.before)

// The deletions and insertions of one file's hunks, in the line numbers of
// the file before this patch, each with where it lands in the release.
function hunkEdits(section: string, state: Run[]): Edit[] {
  const edits: Edit[] = []
  const lines = section.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(lines[i]!)
    if (!h) continue
    // The header says how many old and new lines the hunk has; read exactly
    // those, so what follows (the next hunk, the "-- " signature) is not read
    // as part of it.
    let old = Number(h[2] ?? "1")
    let neu = Number(h[3] ?? "1")
    // With no old lines, the hunk inserts after line n, i.e. before n + 1.
    let pos = old === 0 ? Number(h[1]) + 1 : Number(h[1])
    while ((old > 0 || neu > 0) && i + 1 < lines.length) {
      const l = lines[++i]!
      if (l.startsWith("\\")) continue // "\ No newline at end of file"
      if (l.startsWith("-")) {
        const o = origin(state, pos)
        edits.push({ del: true, line: pos, at: o.at, ours: o.ours })
        pos++
        old--
      } else if (l.startsWith("+")) {
        const last = edits.at(-1)
        if (last && !last.del && last.before === pos) last.count++
        else edits.push({ del: false, before: pos, count: 1, at: origin(state, pos).at })
        neu--
      } else {
        pos++ // context; an empty line is a context line whose space was trimmed
        old--
        neu--
      }
    }
  }
  return edits
}

// Where line n of the current file sits in the release: its own number for a
// release line, the insertion point for a line the mod added.
function origin(state: Run[], n: number): { at: number; ours: boolean } {
  let seen = 0
  for (const r of state) {
    if (n <= seen + r.len) return r.orig ? { at: r.start + (n - seen - 1), ours: false } : { at: r.anchor, ours: true }
    seen += r.len
  }
  return { at: Infinity, ours: false }
}

function indexAt(state: Run[], n: number): number {
  let seen = 0
  for (let i = 0; i < state.length; i++) {
    if (seen + 1 === n) return i
    seen += state[i]!.len
  }
  return state.length
}

// Makes line n of the current file start a run.
function split(state: Run[], n: number) {
  let seen = 0
  for (let i = 0; i < state.length; i++) {
    const r = state[i]!
    if (n === seen + 1) return
    if (n <= seen + r.len) {
      const k = n - seen - 1
      const [a, b]: [Run, Run] = r.orig
        ? [{ orig: true, start: r.start, len: k }, { orig: true, start: r.start + k, len: r.len - k }]
        : [{ orig: false, anchor: r.anchor, len: k }, { orig: false, anchor: r.anchor, len: r.len - k }]
      state.splice(i, 1, a, b)
      return
    }
    seen += r.len
  }
}

/**
 * Where two footprints overlap: per file, the first release line where both
 * change it or next to it. Empty when the mods can be built together.
 */
export function overlaps(a: Footprint, b: Footprint): { file: string; line: number | null }[] {
  const found: { file: string; line: number | null }[] = []
  for (const [file, ra] of a) {
    const rb = b.get(file)
    if (!rb) continue
    let line: number | null | undefined
    for (const x of ra)
      for (const y of rb)
        if (y[0] <= x[1] && x[0] <= y[1]) {
          const at = Math.max(x[0], y[0])
          const n = Number.isFinite(at) && at > 0 ? at : null
          if (line === undefined || (n !== null && (line === null || n < line))) line = n
        }
    if (line !== undefined) found.push({ file, line })
  }
  return found.sort((x, y) => x.file.localeCompare(y.file))
}

/** "greet.sh (line 2), README.md" */
export const describeOverlaps = (list: { file: string; line: number | null }[]) =>
  list.map((o) => (o.line === null ? o.file : `${o.file} (line ${o.line})`)).join(", ")

/** What `incompatibility` needs to know about a mod on one harness. */
export type Comparable = { id: string; conflicts?: string[]; upstream: { commit: string } }

/**
 * Why two mods cannot be on together on one harness, or null when they can:
 * they change the same lines of the release (or lines right next to each
 * other, which git cannot merge either), or their authors said so. Mods for
 * different releases are not compared; the build finds out.
 */
export function incompatibility(a: Comparable, fa: Footprint, b: Comparable, fb: Footprint): string | null {
  if (a.conflicts?.includes(b.id) || b.conflicts?.includes(a.id)) return "their authors marked them as not working together"
  if (a.upstream.commit !== b.upstream.commit) return null
  const found = overlaps(fa, fb)
  return found.length ? `both change ${describeOverlaps(found)}` : null
}
