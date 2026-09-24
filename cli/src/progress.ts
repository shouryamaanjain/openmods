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

/** How long a rebuild of `harness` took here last time, all steps, in seconds; nothing unless every step was timed. */
export function lastRebuild(file: string, harness: string): number | undefined {
  const t = loadTimings(file)[harness] ?? {}
  const steps = ["Source", "Patches", "Dependencies", "Build"].map((s) => t[s] ?? t[`${s}:first`])
  return steps.some((s) => s === undefined) ? undefined : steps.reduce<number>((a, s) => a + s!, 0)
}

export class Progress {
  readonly log: string
  readonly live: boolean
  private carry = ""
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
    const key = this.first ? `${name}:first` : name
    // Compared with the same kind of build, or else with the other kind.
    const kept = loadTimings(this.timings)[this.harness] ?? {}
    const expect = kept[key] ?? kept[this.first ? name : `${name}:first`]
    this.step = { name, start: Date.now(), expect, output: false }
    this.carry = ""
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

  /** A command's output while a step runs: into the log, and scanned for progress. */
  output(chunk: string) {
    this.append(chunk)
    if (!this.step) return
    this.step.output = true
    // A report can be split across chunks, so the end of the last one is read with this one.
    const text = this.carry + chunk
    this.carry = text.slice(-200)
    let last: RegExpExecArray | undefined
    for (const m of text.matchAll(CARGO_PROGRESS)) last = m as RegExpExecArray
    if (last && Number(last[2]) > 0) this.step.fraction = Number(last[1]) / Number(last[2])
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
    this.stop()
    this.step = undefined
    this.carry = ""
    if (!this.live) return
    process.stdout.write(`  ${this.paint("✗", "31")} ${name.padEnd(13)} ${this.paint(`failed after ${clock(Date.now() - start)}`, "2")}\n`)
    if (!output) return
    let text = ""
    try {
      text = readFileSync(this.log, "utf8")
    } catch {}
    const tail = text.split(/[\r\n]+/).filter((l) => l.trim() && !l.startsWith("== ")).slice(-15)
    process.stdout.write(`${tail.map((l) => `    ${this.paint(l, "2")}`).join("\n")}\n    Full log: ${this.log}\n`)
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
    let left: number | undefined
    if (s.expect !== undefined && s.expect * 1000 > elapsed) left = s.expect - elapsed / 1000
    else if (s.fraction && s.fraction >= 0.15 && s.fraction < 1) left = (elapsed / 1000) * ((1 - s.fraction) / s.fraction)
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

