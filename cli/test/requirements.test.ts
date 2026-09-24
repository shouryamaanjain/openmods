// The one line that installs what a build needs, from the real harness
// definitions: every package in one install with the package manager found,
// then the commands for what is not a package. When the line cannot cover
// everything missing, each requirement's own hint is listed instead.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { managerHere, missingMessage, type Requirement } from "../src/requirements"

const codex = (JSON.parse(readFileSync(path.resolve(import.meta.dir, "../../harnesses/codex.json"), "utf8")).requirements as Requirement[])
// Codex's requirements on one OS, picked by name ("Rust" is rustup and cargo).
const on = (os: string, ...names: string[]) => codex.filter((r) => (!r.os || r.os === os) && names.includes(r.name!))
const RUST = `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && . "$HOME/.cargo/env"`

describe("the install line", () => {
  test("on Ubuntu without Rust or build tools, puts every package in one apt install, then rustup", () => {
    const missing = on("linux", "Rust", "a C compiler", "pkg-config", "libcap's development files")
    expect(missingMessage("Codex CLI", missing, "apt", false)).toBe(
      `building Codex CLI needs Rust, a C compiler, pkg-config and libcap's development files. Install them with:\n\n  sudo apt update && sudo apt install -y build-essential pkg-config libcap-dev && ${RUST}\n`,
    )
  })
  test("leaves out sudo for root, and uses dnf's package names on Fedora", () => {
    const missing = on("linux", "a C compiler", "pkg-config", "libcap's development files")
    expect(missingMessage("Codex CLI", missing, "dnf", true)).toBe(
      "building Codex CLI needs a C compiler, pkg-config and libcap's development files. Install them with:\n\n  dnf install -y gcc make pkgconf libcap-devel\n",
    )
  })
  test("a python3 older than 3.11 has no apt package to fix it, so its hint is given", () => {
    const missing = on("linux", "Python 3.11 or newer", "pkg-config")
    expect(missingMessage("Codex CLI", missing, "apt", false)).toBe(`building Codex CLI needs:\n${missing.map((r) => `  - ${r.hint}`).join("\n")}`)
  })
  test("on a Mac, uses Homebrew and Xcode's installer", () => {
    const missing = on("darwin", "Python 3.11 or newer", "a C compiler")
    expect(missingMessage("Codex CLI", missing, "brew", false)).toBe(
      "building Codex CLI needs Python 3.11 or newer and a C compiler. Install them with:\n\n  brew install python && xcode-select --install\n",
    )
  })
  test("a single missing thing is 'it'", () => {
    expect(missingMessage("Codex CLI", on("linux", "libcap's development files"), "apt", false)).toBe(
      "building Codex CLI needs libcap's development files. Install it with:\n\n  sudo apt update && sudo apt install -y libcap-dev\n",
    )
  })
  test("without a package manager it knows, lists each requirement's hint", () => {
    const missing = on("linux", "Rust", "pkg-config")
    expect(missingMessage("Codex CLI", missing, undefined, false)).toBe(`building Codex CLI needs:\n${missing.map((r) => `  - ${r.hint}`).join("\n")}`)
  })
})

describe("the package manager", () => {
  test("is apt or dnf on Linux and Homebrew on a Mac, when installed", () => {
    const only = (...present: string[]) => (c: string) => present.includes(c)
    expect([
      managerHere("linux", only("apt-get", "dnf")),
      managerHere("linux", only("dnf")),
      managerHere("linux", only()),
      managerHere("darwin", only("brew", "apt-get")),
      managerHere("darwin", only()),
    ]).toEqual(["apt", "dnf", undefined, "brew", undefined])
  })
})
