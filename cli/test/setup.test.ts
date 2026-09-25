// `openmods setup`, which the installer runs: the launchers go in front of
// the harnesses before any mod, so an install takes effect at once in a
// terminal that already ran the harness, and ~/.openmods/bin goes first on
// PATH wherever the shell reads it, login shells included.
import { beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { CLI, createHarness, createMod, run, sandbox, setGreeting } from "./harness"

const sb = sandbox("setup")
const bin = () => path.join(sb.om, "bin")
const stockDir = () => path.join(sb.home, ".greet", "bin")
const ours = () => `\n# openmods: modded builds go first; \`openmods off\` steps aside\nexport PATH="${sb.om}/bin:$PATH"  # openmods\n`

// One bash session, sharing bash's memory of where it found each command.
async function bash(lines: string[]) {
  const script = ['openmods() { bun "$OM_CLI" --registry "$OM_REG" --no-path "$@"; }', ...lines].join("\n")
  const p = Bun.spawn(["bash", "--norc", "--noprofile", "-c", script], {
    env: {
      HOME: sb.home,
      OPENMODS_HOME: sb.om,
      OPENMODS_NO_CHECK: "1",
      OPENMODS_NO_PROMPT: "1",
      OM_CLI: CLI,
      OM_REG: sb.reg,
      PATH: [bin(), stockDir(), path.dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out, err }
}

beforeAll(async () => {
  await createHarness(sb)
  await createMod(sb, "friendly", setGreeting("hello from friendly"))
})

describe("the launchers", () => {
  test("none for a harness that is not installed", async () => {
    renameSync(stockDir(), `${stockDir()}.away`)
    try {
      const r = await run(sb, {}, "setup")
      expect(r.code, r.all).toBe(0)
    } finally {
      renameSync(`${stockDir()}.away`, stockDir())
    }
    expect(existsSync(path.join(bin(), "greet"))).toBe(false)
  })
  test("one in front of each installed harness, which starts the stock one", async () => {
    const r = await run(sb, {}, "setup")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("`greet` now starts through")
    const again = await run(sb, {}, "setup")
    expect(again.out).not.toContain("now starts")
  })
  test("so an install takes effect at once in a terminal that already ran the harness", async () => {
    const r = await bash(["greet", "openmods install t/friendly | grep -c 'hash -r'", "greet"])
    // The terminal opened after the launcher appeared, so it needs no `hash -r`.
    expect(r.out.trim().split("\n"), r.err).toEqual(["stock greet", "0", "hello from friendly"])
  })
})

describe("PATH", () => {
  test("a terminal that finds another one first is told so", async () => {
    await run(sb, {}, "install", "t/friendly")
    const r = await run(sb, { env: { PATH: `${stockDir()}:${bin()}:${process.env.PATH}` } }, "on")
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain("in this terminal `greet` still finds ~/.greet/bin/greet first")
    const status = await run(sb, { env: { PATH: `${stockDir()}:${bin()}:${process.env.PATH}` } }, "status")
    expect(status.out).toContain("greet → stock")
    expect(status.out).toContain("in this terminal `greet` finds ~/.greet/bin/greet first")
  })
  test("a later line that can put a folder first, like nvm's or zsh's path=(...), moves it to the end", async () => {
    const rc = path.join(sb.home, ".zshrc")
    for (const later of ['export NVM_DIR="$HOME/.nvm"\n[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"  # This loads nvm', "path=(~/.local/bin $path)"]) {
      writeFileSync(rc, `${ours()}\n${later}\n`)
      const r = await run(sb, { path: true, env: { SHELL: "/bin/zsh" } }, "setup")
      expect(r.out).toContain("Moved the openmods line to the end of ~/.zshrc")
      expect(readFileSync(rc, "utf8").trim().split("\n").at(-1)).toContain("# openmods")
    }
  })
  test.skipIf(process.platform !== "linux")("bash on Linux also gets it where a login shell reads it, after ~/.local/bin", async () => {
    const profile = path.join(sb.home, ".profile")
    const ubuntu = `if [ -n "$BASH_VERSION" ]; then\n    if [ -f "$HOME/.bashrc" ]; then\n\t. "$HOME/.bashrc"\n    fi\nfi\nif [ -d "$HOME/.local/bin" ] ; then\n    PATH="$HOME/.local/bin:$PATH"\nfi\n`
    writeFileSync(profile, ubuntu)
    // Where Codex's installer puts it, which that ~/.profile puts first.
    mkdirSync(path.join(sb.home, ".local", "bin"), { recursive: true })
    writeFileSync(path.join(sb.home, ".local", "bin", "greet"), "#!/bin/sh\necho stock greet\n", { mode: 0o755 })
    const r = await run(sb, { path: true, env: { SHELL: "/bin/bash" } }, "setup")
    expect(r.out).toContain("to the front of PATH in ~/.bashrc and ~/.profile")
    expect(readFileSync(profile, "utf8").trim().split("\n").at(-1)).toContain("# openmods")
    expect(readFileSync(path.join(sb.home, ".bashrc"), "utf8")).toContain("# openmods")
    // A login shell finds the launcher first.
    const login = await Bun.$`bash -lc 'command -v greet'`.env({ HOME: sb.home, PATH: `${stockDir()}:/usr/bin:/bin` }).nothrow().quiet()
    expect(login.stdout.toString().trim()).toBe(path.join(bin(), "greet"))
    const again = await run(sb, { path: true, env: { SHELL: "/bin/bash" } }, "setup")
    expect(again.out).not.toContain("PATH")
  })
  test.skipIf(process.platform !== "linux")("with no file for a login shell to read, bash on Linux gets ~/.profile", async () => {
    for (const f of [".bashrc", ".profile", ".bash_profile", ".bash_login"]) rmSync(path.join(sb.home, f), { force: true })
    const r = await run(sb, { path: true, env: { SHELL: "/bin/bash" } }, "setup")
    expect(r.out).toContain("to the front of PATH in ~/.bashrc and ~/.profile")
    const login = await Bun.$`bash -lc 'command -v greet'`.env({ HOME: sb.home, PATH: `${stockDir()}:/usr/bin:/bin` }).nothrow().quiet()
    expect(login.stdout.toString().trim()).toBe(path.join(bin(), "greet"))
  })
})
