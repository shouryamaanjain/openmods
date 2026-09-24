// The Bun OpenMods runs and builds with. cli/get-bun.sh puts one exact
// release in a folder and changes nothing else, picking the build for the
// machine: the OS and CPU, musl on Alpine, a baseline build for x86-64 CPUs
// without AVX2, and the Apple silicon build under Rosetta. A harness release
// that pins a Bun gets that version in ~/.openmods/toolchains, and Bun's
// caches go in ~/.openmods/cache unless you set them yourself.
//
// uname, sysctl, ldd and curl are stand-ins here, so every machine can be
// played on any machine and nothing is downloaded.
import { beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cli, createHarness, createMod, release, run, sandbox, setGreeting } from "./harness"

const GET_BUN = path.resolve(import.meta.dir, "../get-bun.sh")
const sb = sandbox("toolchain")
const fakes = path.join(sb.T, "fakes")
const curlLog = path.join(sb.T, "curl.log")

// A package like Bun's own, holding a `bun` that prints its version, or one
// that does not run on this machine.
async function tarball(name: string, bun: string) {
  const dir = path.join(sb.T, `pkg-${name}`)
  mkdirSync(path.join(dir, "package", "bin"), { recursive: true })
  writeFileSync(path.join(dir, "package", "bin", "bun"), bun)
  chmodSync(path.join(dir, "package", "bin", "bun"), 0o755)
  await $`tar -czf ${path.join(sb.T, `${name}.tgz`)} -C ${dir} package`.quiet()
}

function fake(name: string, body: string) {
  writeFileSync(path.join(fakes, name), `#!/bin/sh\n${body}\n`)
  chmodSync(path.join(fakes, name), 0o755)
}

type Machine = { os: string; arch: string; rosetta?: boolean; leaf7?: string; alpine?: boolean; ldd?: string; cpuinfo?: string }

// Runs get-bun.sh as if on `m`, in a fresh folder with a fresh HOME.
async function getBun(m: Machine, opts: { version?: string; tarball?: string; curlFails?: boolean } = {}) {
  const root = path.join(sb.T, "root")
  rmSync(root, { recursive: true, force: true })
  mkdirSync(path.join(root, "etc"), { recursive: true })
  mkdirSync(path.join(root, "proc"), { recursive: true })
  if (m.alpine) writeFileSync(path.join(root, "etc", "alpine-release"), "3.20.0\n")
  writeFileSync(path.join(root, "proc", "cpuinfo"), m.cpuinfo ?? "flags\t: fpu sse2\n")
  const home = path.join(sb.T, "machine-home")
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  const dir = path.join(home, ".openmods", "toolchains", "bun-test")
  rmSync(curlLog, { force: true })
  const p = Bun.spawn(["sh", GET_BUN, opts.version ?? "1.3.14", dir], {
    env: {
      PATH: `${fakes}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      GET_BUN_ROOT: root,
      FAKE_OS: m.os,
      FAKE_ARCH: m.arch,
      FAKE_ROSETTA: m.rosetta ? "1" : "",
      FAKE_LEAF7: m.leaf7 ?? "",
      FAKE_LDD: m.ldd ?? "ldd (GNU libc) 2.39",
      CURL_LOG: curlLog,
      CURL_TARBALL: path.join(sb.T, `${opts.tarball ?? "good"}.tgz`),
      CURL_FAILS: opts.curlFails ? "1" : "",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  const url = existsSync(curlLog) ? readFileSync(curlLog, "utf8").trim() : ""
  return { code: await p.exited, out, err, url, dir, home, target: url.match(/@oven\/bun-([^/]+)\//)?.[1] }
}

beforeAll(async () => {
  mkdirSync(fakes, { recursive: true })
  fake("uname", 'case "$1" in -s) echo "$FAKE_OS" ;; -m) echo "$FAKE_ARCH" ;; esac')
  fake(
    "sysctl",
    'case "$2" in sysctl.proc_translated) [ -n "$FAKE_ROSETTA" ] && echo 1 || exit 1 ;; machdep.cpu.leaf7_features) echo "$FAKE_LEAF7" ;; esac',
  )
  fake("ldd", 'echo "$FAKE_LDD"')
  // curl -fsSL <url> -o <file>
  fake("curl", 'echo "$2" >> "$CURL_LOG"\n[ -n "$CURL_FAILS" ] && exit 22\ncp "$CURL_TARBALL" "$4"')
  await tarball("good", '#!/bin/sh\necho "${FAKE_BUN_VERSION:-1.3.14}"\n')
  await tarball("broken", "#!/bin/sh\nexit 126\n")
})

describe("get-bun.sh picks the build for the machine", () => {
  const AVX2 = "flags\t: fpu sse2 avx avx2\n"
  const machines: [string, Machine, string][] = [
    ["an Apple silicon Mac", { os: "Darwin", arch: "arm64" }, "darwin-aarch64"],
    ["an Intel Mac", { os: "Darwin", arch: "x86_64", leaf7: "RDWRFSGS TSC_THREAD_OFFSET SGX BMI1 AVX2 SMEP" }, "darwin-x64"],
    ["an Intel Mac without AVX2", { os: "Darwin", arch: "x86_64", leaf7: "RDWRFSGS SMEP" }, "darwin-x64-baseline"],
    ["a shell under Rosetta on Apple silicon", { os: "Darwin", arch: "x86_64", rosetta: true }, "darwin-aarch64"],
    ["x86-64 Linux", { os: "Linux", arch: "x86_64", cpuinfo: AVX2 }, "linux-x64"],
    ["x86-64 Linux without AVX2", { os: "Linux", arch: "x86_64" }, "linux-x64-baseline"],
    ["ARM Linux", { os: "Linux", arch: "aarch64" }, "linux-aarch64"],
    ["ARM Linux that says arm64", { os: "Linux", arch: "arm64" }, "linux-aarch64"],
    ["Alpine on x86-64", { os: "Linux", arch: "x86_64", alpine: true, cpuinfo: AVX2 }, "linux-x64-musl"],
    ["Alpine on x86-64 without AVX2", { os: "Linux", arch: "x86_64", alpine: true }, "linux-x64-musl-baseline"],
    ["Alpine on ARM", { os: "Linux", arch: "aarch64", alpine: true }, "linux-aarch64-musl"],
    ["another musl Linux", { os: "Linux", arch: "aarch64", ldd: "musl libc (aarch64)\nVersion 1.2.5" }, "linux-aarch64-musl"],
  ]
  for (const [name, m, target] of machines)
    test(`${name}: ${target}`, async () => {
      const r = await getBun(m)
      expect(r.code, r.err).toBe(0)
      expect(r.target).toBe(target)
      expect(r.url).toBe(`https://registry.npmjs.org/@oven/bun-${target}/-/bun-${target}-1.3.14.tgz`)
    })
  test("a machine Bun does not build for is refused before any download", async () => {
    const r = await getBun({ os: "FreeBSD", arch: "amd64" })
    expect(r.code).toBe(1)
    expect(r.err).toContain("Bun has no build for FreeBSD amd64.")
    expect(r.url).toBe("")
  })
})

describe("get-bun.sh installs", () => {
  test("only <dir>/bin/bun, and nothing else in HOME", async () => {
    const r = await getBun({ os: "Linux", arch: "aarch64" })
    expect(r.code, r.err).toBe(0)
    expect((await $`${path.join(r.dir, "bin", "bun")}`.text()).trim()).toBe("1.3.14")
    expect(readdirSync(r.home)).toEqual([".openmods"])
    expect(readdirSync(path.dirname(r.dir))).toEqual(["bun-test"]) // no download left behind
  })
  test("nothing when the download fails", async () => {
    const r = await getBun({ os: "Linux", arch: "aarch64" }, { curlFails: true })
    expect(r.code).toBe(1)
    expect(r.err).toContain("Could not download Bun 1.3.14 from https://registry.npmjs.org/@oven/bun-linux-aarch64/-/bun-linux-aarch64-1.3.14.tgz")
    expect(existsSync(path.join(r.dir, "bin", "bun"))).toBe(false)
    expect(readdirSync(path.dirname(r.dir))).toEqual([])
  })
  test("nothing when the downloaded Bun does not run on the machine", async () => {
    const r = await getBun({ os: "Linux", arch: "aarch64" }, { tarball: "broken" })
    expect(r.code).toBe(1)
    expect(r.err).toContain("Bun 1.3.14 (linux-aarch64) does not run on this machine.")
    expect(existsSync(path.join(r.dir, "bin", "bun"))).toBe(false)
  })
})

describe("a harness release that pins a Bun", () => {
  const seen = path.join(sb.T, "seen")
  beforeAll(async () => {
    await createHarness(sb)
    await release(sb, "v1.1.0", (dir) => writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.1.0", packageManager: "bun@9.9.9" }, null, 2) + "\n"))
    const def = path.join(sb.reg, "harnesses", "fake.json")
    const install = `echo "bun=$(bun --version) cache=$BUN_INSTALL_CACHE_DIR transpiler=$BUN_RUNTIME_TRANSPILER_CACHE_PATH" > ${seen}`
    writeFileSync(def, JSON.stringify({ ...JSON.parse(readFileSync(def, "utf8")), install }))
    await createMod(sb, "friendly", setGreeting("hello from friendly"), { base: "v1.1.0" })
  })
  const env = () => ({ PATH: `${fakes}:${process.env.PATH}`, CURL_LOG: curlLog, CURL_TARBALL: path.join(sb.T, "good.tgz"), FAKE_BUN_VERSION: "9.9.9", FAKE_OS: "Linux", FAKE_ARCH: "aarch64", FAKE_LDD: "ldd (GNU libc) 2.39" })

  test("builds with that version, from ~/.openmods/toolchains, with Bun's caches in ~/.openmods/cache", async () => {
    const r = await run(sb, { env: env() }, "install", "t/friendly")
    expect(r.code, r.all).toBe(0)
    expect(r.all).toContain("Getting Bun 9.9.9, the version this release builds with")
    expect(existsSync(path.join(sb.om, "toolchains", "bun-9.9.9", "bin", "bun"))).toBe(true)
    expect(readFileSync(seen, "utf8").trim()).toBe(
      `bun=9.9.9 cache=${path.join(sb.om, "cache", "bun")} transpiler=${path.join(sb.om, "cache", "transpiler")}`,
    )
  })
  test("keeps the caches where you put them", async () => {
    await cli(sb, "uninstall", "t/friendly")
    const r = await run(sb, { env: { ...env(), BUN_INSTALL_CACHE_DIR: "/mine/bun", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } }, "install", "t/friendly")
    expect(r.code, r.all).toBe(0)
    expect(readFileSync(seen, "utf8")).toContain("cache=/mine/bun transpiler=0")
  })
})
