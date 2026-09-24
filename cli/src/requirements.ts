// What a build needs on the machine, and one line that installs whatever is
// missing. A requirement names its package for each package manager, or a
// command that installs it (rustup, say); the line puts every package in one
// install with the package manager found here, then those commands.
//
//   error: building Codex CLI needs Rust, a C compiler and pkg-config. Install them with:
//
//     sudo apt update && sudo apt install -y build-essential pkg-config && curl … | sh -s -- -y && . "$HOME/.cargo/env"

export type Requirement = {
  command?: string
  check?: string
  os?: string
  /** What it is, for the summary: "a C compiler". */
  name?: string
  /** Its package, per package manager. */
  packages?: Partial<Record<Manager, string>>
  /** A command that installs it, when it is not a package. */
  install?: string
  /** Said when there is no line to give. */
  hint: string
}

export type Manager = "apt" | "dnf" | "brew"

const INSTALL: Record<Manager, (packages: string, root: boolean) => string> = {
  // A fresh system may never have fetched apt's package lists.
  apt: (p, root) => `${root ? "" : "sudo "}apt update && ${root ? "" : "sudo "}apt install -y ${p}`,
  dnf: (p, root) => `${root ? "" : "sudo "}dnf install -y ${p}`,
  brew: (p) => `brew install ${p}`,
}

/** The package manager this machine installs with, if it is one we know. */
export function managerHere(platform: string, has: (command: string) => boolean): Manager | undefined {
  if (platform === "darwin") return has("brew") ? "brew" : undefined
  if (has("apt-get")) return "apt"
  if (has("dnf")) return "dnf"
  return undefined
}

const listed = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`

/**
 * The error for what is missing: one install line when it covers all of it,
 * else what each one needs, as a list.
 */
export function missingMessage(harness: string, missing: Requirement[], manager: Manager | undefined, root: boolean): string {
  const packaged = (r: Requirement) => (manager ? r.packages?.[manager] : undefined)
  if (!missing.every((r) => packaged(r) || r.install)) return `building ${harness} needs:\n${missing.map((r) => `  - ${r.hint}`).join("\n")}`
  const packages = [...new Set(missing.flatMap((r) => packaged(r)?.split(/\s+/) ?? []))]
  const commands = [...new Set(missing.flatMap((r) => (packaged(r) ? [] : [r.install!])))]
  const line = [...(packages.length ? [INSTALL[manager!](packages.join(" "), root)] : []), ...commands].join(" && ")
  const names = [...new Set(missing.map((r) => r.name ?? r.hint))]
  return `building ${harness} needs ${listed(names)}. Install ${names.length === 1 ? "it" : "them"} with:\n\n  ${line}\n`
}
