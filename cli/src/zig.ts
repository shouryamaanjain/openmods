// Zig for a harness release that pins it (build.zig.zon's
// minimum_zig_version, which such releases build with exactly: Zig changes
// between versions). OpenMods keeps it under ~/.openmods/toolchains/zig-<v>,
// the whole release in bin/, since zig finds its lib folder beside itself.
//
// Which build to trust comes from ziglang.org's download index, read over
// HTTPS: its sha256 for the build. The build itself comes from Zig's
// community mirrors, tried in a random order as Zig asks of tools, then from
// ziglang.org; that sha256 makes any of them as good as the next.
import { $ } from "bun"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

const INDEX = "https://ziglang.org/download/index.json"
const MIRRORS = "https://ziglang.org/download/community-mirrors.txt"

// The Zig a checkout pins, or null when it pins none. Throws when
// build.zig.zon is there but cannot be read.
export function zigPin(root: string): string | null {
  const zon = path.join(root, "build.zig.zon")
  if (!existsSync(zon)) return null
  return readFileSync(zon, "utf8").match(/\.minimum_zig_version\s*=\s*"(\d+\.\d+\.\d+)"/)?.[1] ?? null
}

// Whether a folder holds a Zig of that version that runs here, its lib folder
// beside it.
export async function usableZig(bin: string, want: string): Promise<boolean> {
  if (!existsSync(path.join(bin, "zig")) || !existsSync(path.join(bin, "lib"))) return false
  return (await $`${path.join(bin, "zig")} version`.nothrow().quiet().text()).trim() === want
}

// The name ziglang.org gives this machine's builds, or null when it has none.
export function zigPlatform(): string | null {
  const arch = ({ arm64: "aarch64", x64: "x86_64" } as Record<string, string>)[process.arch]
  const os = ({ darwin: "macos", linux: "linux" } as Record<string, string>)[process.platform]
  return arch && os ? `${arch}-${os}` : null
}

// Puts Zig `want` in `<dir>/bin` and returns that folder. `index` and
// `mirrors` are for the tests; `mirrors: null` tries only the index's own URL.
export async function getZig(want: string, dir: string, opts: { index?: string; mirrors?: string | null } = {}): Promise<string> {
  const bin = path.join(dir, "bin")
  if (await usableZig(bin, want)) return bin
  const platform = zigPlatform()
  if (!platform) throw new Error(`OpenMods cannot get it for ${process.platform} ${process.arch}; install it from https://ziglang.org`)
  const index = await fetch(opts.index ?? INDEX, { signal: AbortSignal.timeout(30_000) }).then((r) =>
    r.ok ? r.json() : Promise.reject(new Error(`ziglang.org answered ${r.status}`)),
  )
  const entry = (index as Record<string, Record<string, { tarball?: string; shasum?: string }>>)[want]?.[platform]
  const url = entry?.tarball
  const shasum = entry?.shasum
  if (!url || !shasum) throw new Error(`ziglang.org lists no ${platform} build of it`)
  const mirrors =
    opts.mirrors === null
      ? []
      : await fetch(opts.mirrors ?? MIRRORS, { signal: AbortSignal.timeout(15_000) })
          .then((r) => (r.ok ? r.text() : ""))
          .catch(() => "")
          .then((t) => t.split("\n").map((l) => l.trim()).filter((l) => /^https:\/\//.test(l)))
  const file = url.split("/").at(-1)!
  const tries = [
    ...mirrors
      .map((m) => ({ m, r: Math.random() }))
      .sort((a, b) => a.r - b.r)
      .slice(0, 3)
      .map(({ m }) => `${m.replace(/\/+$/, "")}/${file}?source=openmods`),
    url,
  ]
  let data: Uint8Array | null = null
  let last = ""
  for (const from of tries) {
    try {
      const got = await download(from)
      const sum = new Bun.CryptoHasher("sha256").update(got).digest("hex")
      if (sum !== shasum) throw new Error(`the download's sha256 is ${sum}, not ${shasum} as ziglang.org lists it`)
      data = got
      break
    } catch (e) {
      last = e instanceof Error ? e.message : String(e)
    }
  }
  if (!data) throw new Error(last)
  const tmp = `${dir}.download.${process.pid}.${Math.random().toString(36).slice(2)}`
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  try {
    writeFileSync(path.join(tmp, "zig.tar.xz"), data)
    const r = await $`tar -xJf ${path.join(tmp, "zig.tar.xz")} -C ${tmp}`.nothrow().quiet()
    if (r.exitCode !== 0) throw new Error(`could not unpack it: ${r.stderr.toString().trim().split("\n").at(-1)}`)
    const top = readdirSync(tmp).find((d) => d.startsWith("zig-") && existsSync(path.join(tmp, d, "zig")))
    if (!top) throw new Error("the download has no zig in it")
    if (!(await usableZig(path.join(tmp, top), want))) throw new Error(`the ${platform} build does not run on this machine`)
    mkdirSync(dir, { recursive: true })
    // Another command may have put one there meanwhile, and may be building
    // with it: a good one is used as it is, never replaced. A bad one, which
    // nothing can be building with, is.
    if (!(await usableZig(bin, want))) {
      rmSync(bin, { recursive: true, force: true })
      try {
        renameSync(path.join(tmp, top), bin)
      } catch {}
    }
    if (!(await usableZig(bin, want))) throw new Error(`could not set it up in ${bin}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  return bin
}

// A download, for as long as it keeps coming: one that sends nothing for 30
// seconds is given up. Mirrors differ a lot in speed, so a slow one that
// works is better than starting again elsewhere.
async function download(url: string): Promise<Uint8Array> {
  const stop = new AbortController()
  let stalled = setTimeout(() => stop.abort(), 30_000)
  const shown = url.replace(/\?.*/, "")
  try {
    const r = await fetch(url, { signal: stop.signal })
    if (!r.ok || !r.body) throw new Error(`${shown} answered ${r.status}`)
    const parts: Uint8Array[] = []
    for await (const part of r.body) {
      clearTimeout(stalled)
      stalled = setTimeout(() => stop.abort(), 30_000)
      parts.push(part)
    }
    return Buffer.concat(parts)
  } catch (e) {
    throw stop.signal.aborted ? new Error(`${shown} sent nothing for 30 seconds`) : e
  } finally {
    clearTimeout(stalled)
  }
}
