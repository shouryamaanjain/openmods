// The Codex recipe asks rustc for the build target where Codex's
// rust-toolchain.toml is, inside codex-rs. With rustup and no default
// toolchain, rustc outside that folder cannot say, and the build would get an
// empty --target. A fake rustc here answers only next to a toolchain file.
import { afterAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const codex = JSON.parse(readFileSync(path.resolve(import.meta.dir, "../../harnesses/codex.json"), "utf8"))
const dir = mkdtempSync(path.join(tmpdir(), "openmods-codex-recipe-"))
const root = path.join(dir, "codex")
const bin = path.join(dir, "bin")
mkdirSync(path.join(root, "codex-rs"), { recursive: true })
mkdirSync(bin)
writeFileSync(path.join(root, "codex-rs", "rust-toolchain.toml"), '[toolchain]\nchannel = "1.93.0"\n')
writeFileSync(
  path.join(bin, "rustc"),
  "#!/bin/sh\n[ -f rust-toolchain.toml ] || { echo \"error: rustup could not choose a version of rustc to run\" >&2; exit 1; }\necho 'host: aarch64-apple-darwin'\n",
)
chmodSync(path.join(bin, "rustc"), 0o755)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// The --target a command passes, worked out in the folder it runs that part
// from: the command inside its "$(...)" is run by a fixed shell program, as
// its argument.
async function target(command: string, cwd: string) {
  const inner = command.match(/--target "\$\(([^"]*)\)"/)?.[1]
  expect(inner, command).toBeDefined()
  const r = await $`sh -c ${'printf "%s" "$(eval "$1")"'} sh ${inner!}`.cwd(cwd).env({ ...process.env, PATH: `${bin}:${process.env.PATH}` }).nothrow().quiet()
  return r.stdout.toString()
}

describe("the Codex recipe's build target, with no default Rust toolchain", () => {
  test("the build and dev commands ask inside codex-rs, from the checkout's root", async () => {
    expect(await target(codex.build, root)).toBe("aarch64-apple-darwin")
    expect(await target(codex.dev, root)).toBe("aarch64-apple-darwin")
  })
  test("the dependency step asks from codex-rs, where it runs", async () => {
    expect(codex.install.startsWith("cd codex-rs &&")).toBe(true)
    expect(await target(codex.install, path.join(root, "codex-rs"))).toBe("aarch64-apple-darwin")
  })
})
