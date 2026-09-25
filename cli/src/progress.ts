// How a build looks in a terminal. Each step gets one line with its time,
// the step running gets a live line (a bar when the build says how far it
// is, and the time left from this machine's last build), and the build's own
// output goes to a log file, shown only when a step fails. Outside a terminal
// nothing changes: the output streams as it always has.
//
//   Codex CLI 0.156.1 + shouryamaanjain/space-invaders
//     ✓ Source         0:06
//     ✓ Patches        0:01
//     ⠼ Build          ██████████░░░░░░░░░░  48%  4:21 · ~5 min left
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
const KEEP_LOGS = 5
// A compiler's or build tool's error line: "error: …", "error[E0425]: …", a panic.
const ERROR = /(^|\s)error(\[E\d+\])?:|panicked at /
// Shown: the first and the last of the error lines, so a later error is not lost.
const ERROR_LINES = 12
// Where an error's own lines end: cargo waiting on other jobs, or a wrapper's
// traceback, after which nothing is the build's own.
const AFTER_ERROR = /^warning: build failed/
const TRACEBACK = /^Traceback \(most recent call last\)/
// Cargo reports progress even into a pipe when asked to (see `buildEnv`).
const CARGO_PROGRESS = /Building \[[^\]]*\]\s+(\d+)\/(\d+)/g

export type Timings = Record<string, Record<string, number>>

export const clock = (ms: number) => {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/** "about 2 min", or "under a minute", from seconds. */
export const roughly = (seconds: number) => (seconds < 60 ? "under a minute" : `about ${Math.round(seconds / 60)} min`)

export function loadTimings(file: string): Timings {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return {}
  }
}

/**
 * How long a rebuild of `harness` took here last time, all steps, in seconds;
 * nothing unless every step of a rebuild was timed. A first build, several
 * times longer, says nothing about a rebuild.
 */
export function lastRebuild(file: string, harness: string): number | undefined {
  const t = loadTimings(file)[harness] ?? {}
  const steps = ["Source", "Patches", "Dependencies", "Build"].map((s) => t[s])
  return steps.some((s) => s === undefined) ? undefined : steps.reduce<number>((a, s) => a + s!, 0)
}

export class Progress {
  readonly log: string
  readonly live: boolean
  private carry = ""
  // The end of the step's output, kept here too, so a failure can show it even if the log cannot be written.
  private recent = ""
  // The build's own error lines and what follows each, so a failure shows
  // the cause rather than the last lines, often a wrapper's traceback.
  private errors: string[] = []
  private partial = ""
  private following = 0
  private wrapped = false
  private step: { name: string; start: number; fraction?: number; expect?: number; output: boolean } | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private frame = 0

  /**
   * `live`: a terminal to draw in. `first`: nothing was built for this
   * harness before, so the time it takes is compared with other first builds.
   */
  constructor(
    live: boolean,
    private readonly harness: string,
    private readonly first: boolean,
    private readonly timings: string,
    logs: string,
    private readonly color: boolean,
  ) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    this.log = path.join(logs, `${harness}-${stamp}-${process.pid}.log`)
    // The log is where the output goes, so without one it streams as before.
    try {
      mkdirSync(logs, { recursive: true })
      const old = readdirSync(logs)
        .filter((f) => f.startsWith(`${harness}-`) && f.endsWith(".log"))
        .sort()
      for (const f of old.slice(0, Math.max(0, old.length - (KEEP_LOGS - 1)))) rmSync(path.join(logs, f), { force: true })
      writeFileSync(this.log, "")
      this.live = live
    } catch {
      this.live = false
    }
  }

  get running() {
    return this.step !== undefined
  }

  title(text: string) {
    if (this.live) process.stdout.write(`${this.paint(text, "1")}\n`)
  }

  /** Runs one step; in a terminal it gets its line, and its time is kept for next time. */
  async run<T>(name: string, fn: () => Promise<T>): Promise<T> {
    // Compared only with the same kind of build: a first build can take
    // several times as long as a rebuild.
    const key = this.first ? `${name}:first` : name
    this.step = { name, start: Date.now(), expect: loadTimings(this.timings)[this.harness]?.[key], output: false }
    this.carry = ""
    this.recent = ""
    this.errors = []
    this.partial = ""
    this.following = 0
    this.wrapped = false
    this.note(`== ${name}`)
    if (this.live) {
      this.draw()
      this.timer = setInterval(() => this.draw(), 120)
    }
    let result: T
    try {
      result = await fn()
    } catch (e) {
      this.failed()
      throw e
    }
    const took = Date.now() - this.step.start
    this.stop()
    if (this.live) process.stdout.write(`  ${this.paint("✓", "32")} ${name.padEnd(13)} ${this.paint(clock(took), "2")}\n`)
    // Kept for next time when it can be; a build never fails for it.
    try {
      const all = loadTimings(this.timings)
      all[this.harness] = { ...all[this.harness], [key]: Math.round(took / 1000) }
      writeFileSync(this.timings, JSON.stringify(all, null, 2) + "\n")
    } catch {}
    this.step = undefined
    return result
  }

  /** A new command in the step (a retry, say): its errors count again after an earlier traceback. */
  command() {
    if (this.partial) this.scan(this.partial)
    this.wrapped = false
    this.partial = ""
    this.following = 0
  }

  /** A command's output while a step runs: into the log, and scanned for progress. */
  output(chunk: string) {
    this.append(chunk)
    if (!this.step) return
    this.step.output = true
    // A report can be split across chunks, so the end of the last one is read with this one.
    this.recent = (this.recent + chunk).slice(-8000)
    const lines = (this.partial + chunk).split(/\r\n|\n|\r/)
    this.partial = lines.pop() ?? ""
    for (const line of lines) this.scan(line)
    const text = this.carry + chunk
    this.carry = text.slice(-200)
    let last: RegExpExecArray | undefined
    for (const m of text.matchAll(CARGO_PROGRESS)) last = m as RegExpExecArray
    if (last && Number(last[2]) > 0) this.step.fraction = Number(last[1]) / Number(last[2])
  }

  // An error line starts a dozen lines worth showing; a traceback ends them.
  private scan(line: string) {
    if (this.wrapped) return
    if (TRACEBACK.test(line)) {
      this.wrapped = true
      return
    }
    if (ERROR.test(line)) this.following = 12
    else if (AFTER_ERROR.test(line)) this.following = 0
    if (this.following > 0 && line.trim()) {
      this.errors.push(line)
      if (this.errors.length > 400) this.errors.splice(ERROR_LINES, this.errors.length - 400 + ERROR_LINES)
      this.following--
    }
  }

  /** A message that would have been printed: kept in the log instead. */
  note(msg: string) {
    this.append(`${msg}\n`)
  }

  private append(text: string) {
    try {
      appendFileSync(this.log, text)
    } catch {}
  }

  /** The step running failed: says so, with the end of its output when it had any. */
  failed() {
    if (!this.step) return
    const { name, start, output } = this.step
    // Output that ended without a newline still counts.
    if (this.partial) this.scan(this.partial)
    this.stop()
    this.step = undefined
    this.carry = ""
    const recent = this.recent
    const errors = this.errors
    this.recent = ""
    this.errors = []
    this.partial = ""
    if (!this.live) return
    process.stdout.write(`  ${this.paint("✗", "31")} ${name.padEnd(13)} ${this.paint(`failed after ${clock(Date.now() - start)}`, "2")}\n`)
    if (!output) return
    const shown = errors.length > 2 * ERROR_LINES ? [...errors.slice(0, ERROR_LINES), "…", ...errors.slice(-ERROR_LINES)] : errors
    const tail = shown.length ? shown : recent.split(/[\r\n]+/).filter((l) => l.trim() && !l.startsWith("== ")).slice(-15)
    // A compiler command line can run to thousands of characters.
    const short = (l: string) => (l.length > 200 ? `${l.slice(0, 199)}…` : l)
    // The system killed the compiler: out of memory, most likely.
    const killed = /signal: 9, SIGKILL|Killed signal terminated program/.test(recent + errors.join("\n"))
    process.stdout.write(`${tail.map((l) => `    ${this.paint(short(l), "2")}`).join("\n")}\n`)
    if (killed) process.stdout.write("    The compiler was killed, most likely for running out of memory. Close other programs, or build with fewer jobs at once: CARGO_BUILD_JOBS=2\n")
    process.stdout.write(`    Full log: ${this.log}\n`)
  }

  private stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.live) process.stdout.write("\r\x1b[2K")
  }

  private draw() {
    const s = this.step
    if (!s) return
    const elapsed = Date.now() - s.start
    // From the last build of this kind, and from how far the build says it
    // is; with both, the lower, so the estimate never outlasts the bar.
    const byHistory = s.expect !== undefined && s.expect * 1000 > elapsed ? s.expect - elapsed / 1000 : undefined
    const byBar = s.fraction && s.fraction >= 0.15 && s.fraction < 1 ? (elapsed / 1000) * ((1 - s.fraction) / s.fraction) : undefined
    const left = byHistory === undefined ? byBar : byBar === undefined ? byHistory : Math.min(byHistory, byBar)
    const bar =
      s.fraction === undefined
        ? ""
        : `${"█".repeat(Math.round(s.fraction * 20))}${"░".repeat(20 - Math.round(s.fraction * 20))}  ${String(Math.floor(s.fraction * 100)).padStart(3)}%  `
    // Only a wait worth knowing about: a minute or more.
    const eta = left === undefined || left < 60 ? "" : ` · ~${Math.round(left / 60)} min left`
    const spin = FRAMES[this.frame++ % FRAMES.length]
    const line = `  ${this.paint(spin!, "36")} ${s.name.padEnd(13)} ${bar}${this.paint(`${clock(elapsed)}${eta}`, "2")}`
    process.stdout.write(`\r\x1b[2K${line}`)
  }

  private paint(text: string, code: string) {
    return this.color ? `\x1b[${code}m${text}\x1b[0m` : text
  }
}

