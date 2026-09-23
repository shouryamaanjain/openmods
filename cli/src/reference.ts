// The one description of the CLI. `openmods help` renders it in the
// terminal and the site renders it as the reference page, so neither can
// drift from the other. Plain data, no imports, safe for the site to load.

export type Flag = { flag: string; description: string }
export type Example = { command: string; note?: string }
export type Command = {
  name: string
  aliases?: string[]
  usage: string
  /** A shorter usage line for the one-screen help; defaults to `usage`. */
  short?: string
  summary: string
  description: string[]
  flags?: Flag[]
  examples?: Example[]
  audience: "users" | "authors"
}

export const INTRO = "Source-level mods for open-source coding agents. Your stock harness is never modified: the modded build lives under ~/.openmods and its launcher sits first on PATH, so `opencode` runs the modded build while it is on and the stock one otherwise."

export const COMMANDS: Command[] = [
  {
    name: "list",
    usage: "openmods list [--<harness>]",
    summary: "Mods in the registry: every harness each one supports, and the release it is for there.",
    description: [
      "Reads the registry as it is on disk; no network. One line per mod, owner/name, then each harness it supports with the release its patches are for; an asterisk marks where you have it installed. Unpublished mods from ~/.openmods/local are listed too, marked (local).",
    ],
    flags: [
      { flag: "--<harness>", description: "Only mods that support this harness, e.g. --codex." },
      { flag: "--json", description: "Print the mods as JSON, one entry per mod and harness." },
    ],
    examples: [{ command: "openmods list" }, { command: "openmods list --codex", note: "only mods for Codex" }],
    audience: "users",
  },
  {
    name: "info",
    usage: "openmods info <owner>/<mod> [--<harness>]",
    summary: "A mod's details, and for each harness it supports: the release, the patches, and every file it touches.",
    description: [
      "Read this before installing. The touched-files list comes from the patches themselves, not from the README.",
      "Also lists, per harness, the mods it cannot be installed together with: ones that change the same lines of the release or lines right next to them, and ones its author marked as conflicting.",
    ],
    flags: [
      { flag: "--<harness>", description: "Only this harness." },
      { flag: "--json", description: "Machine-readable output, including the touched files." },
    ],
    examples: [{ command: "openmods info shouryamaanjain/tetris" }, { command: "openmods info shouryamaanjain/tetris --codex" }],
    audience: "users",
  },
  {
    name: "install",
    aliases: ["add"],
    usage: "openmods install <owner>/<mod> [<owner>/<mod> ...] [--<harness> ...]\nopenmods install <path to a harness clone> [--name <mod>]",
    short: "openmods install <owner>/<mod> [--<harness>]",
    summary: "Build a harness with these mods and switch it on.",
    description: [
      "Which harness: name it with a flag, --opencode or --codex, or --harness <id>; several flags install on several harnesses. Without one, a mod that supports a single harness uses it, and a mod that supports several asks with a selector that lists only the harnesses it supports, and which of them you have. With no terminal to ask at, it prints the flags to choose from.",
      "If you do not have the harness, it says so: the selector marks it as not installed, and a mod for that harness alone gets a notice. It then shows the harness's official installer (for OpenCode, curl -fsSL https://opencode.ai/install | bash) and asks before running it. No leaves everything as it was; with no terminal it prints the command instead. Your stock harness is what `openmods off` switches back to.",
      "Picks one release for all your mods on that harness: the one you are on if every mod has a version for it, else the newest release they all have a version for (it says so when that changes your release). Mods that share no release are refused. Then it clones the harness once (blobless), checks out that release, applies each mod's version for it in order, builds with the exact toolchain that release pins, copies the build aside, and writes the launcher to ~/.openmods/bin. The first time, that folder is added to the front of PATH in your shell config, and if a harness installer later adds its own PATH line after it, the openmods line is moved back to the end so modded builds stay first.",
      "Mods stack on one checkout. Two mods that change the same lines of the release, or lines right next to each other, cannot be combined: that is worked out from the patches before anything is built, and the install is refused with the mods and lines named. Your current build keeps running. A mod that still fails to apply, or a build that fails, also leaves the previous build in place.",
      "Installing a mod that is already installed reinstalls it. A mod that was switched off comes back on.",
      "Given the path of a harness clone instead, it packs your commits on top of the release as a local mod, named after the branch unless --name says otherwise, and installs that: the way an author tries a mod exactly as users will run it.",
      "Every modded build also carries the OpenMods base patch, applied first. It sends feedback and crash reports from the modded build to OpenMods instead of the upstream project, which did not ship the mods.",
    ],
    flags: [
      { flag: "--no-path", description: "Do not edit your shell config to put ~/.openmods/bin on PATH." },
      { flag: "--registry <dir|url>", description: "Use another registry checkout or git URL." },
    ],
    examples: [
      { command: "openmods install shouryamaanjain/tetris", note: "asks which harness" },
      { command: "openmods install shouryamaanjain/tetris --opencode" },
      { command: "openmods install shouryamaanjain/tetris shouryamaanjain/hello-placeholder --codex", note: "two mods, one build" },
      { command: "openmods install .", note: "in your OpenCode clone: try your commits as a mod" },
    ],
    audience: "users",
  },
  {
    name: "uninstall",
    aliases: ["remove", "rm"],
    usage: "openmods uninstall <owner>/<mod> [<owner>/<mod> ...] [--<harness> ...]",
    short: "openmods uninstall <owner>/<mod> [--<harness>]",
    summary: "Remove mods and rebuild without them.",
    description: [
      "When the mod is installed on several harnesses and none is named with a flag, it asks which, listing only the ones it is installed on.",
      "When the last mod for a harness is removed, the launcher, the built binary and the patched commits are removed too, and the checkout is reset to the stock release. The checkout itself stays as a cache so the next install does not clone and install dependencies again; delete ~/.openmods/harnesses/<id> to reclaim the space.",
    ],
    examples: [{ command: "openmods uninstall shouryamaanjain/tetris" }, { command: "openmods uninstall shouryamaanjain/tetris --codex" }],
    audience: "users",
  },
  {
    name: "status",
    aliases: ["installed"],
    usage: "openmods status",
    summary: "Which build your command runs right now, per harness.",
    description: [
      "Shows the modded build (release plus mods, on or off), the stock binary it would fall back to, and any mod that is installed but built out. Says so if ~/.openmods/bin is not on PATH in the current shell.",
    ],
    flags: [{ flag: "--json", description: "The state file as JSON." }],
    examples: [{ command: "openmods status" }],
    audience: "users",
  },
  {
    name: "on",
    usage: "openmods on [harness | <owner>/<mod> [--<harness>]]",
    summary: "Make your command run the modded build again, or build one mod back in.",
    description: [
      "With no argument, or a harness id: writes the launcher back into ~/.openmods/bin. Instant, nothing is rebuilt.",
      "With a mod: rebuilds the harness with that mod included again, after an `off <owner>/<mod>`. Asks which harness if it is installed on several.",
    ],
    examples: [{ command: "openmods on" }, { command: "openmods on shouryamaanjain/tetris --opencode" }],
    audience: "users",
  },
  {
    name: "off",
    usage: "openmods off [harness | <owner>/<mod> [--<harness>]]",
    summary: "Make your command run the stock build again, or build one mod out.",
    description: [
      "With no argument, or a harness id: removes the launcher, so `opencode` falls through to the stock binary. Instant, and the modded build is kept for `on`.",
      "With a mod: rebuilds the harness without that mod. It stays installed and listed in status as off.",
    ],
    examples: [{ command: "openmods off" }, { command: "openmods off codex", note: "just Codex" }, { command: "openmods off shouryamaanjain/tetris --codex" }],
    audience: "users",
  },
  {
    name: "update",
    usage: "openmods update [harness]",
    summary: "Pull the registry and rebuild if anything you have installed changed.",
    description: [
      "Moves you to the newest release that every mod you have on has a version for, using each mod's version for it. The registry's release check adds those versions when a mod still applies and typechecks on a new harness release. A rebuild happens only when that release, or a mod's patches for it, changed; otherwise it says the build is already up to date. This is also what the launcher runs when you answer yes to its update prompt.",
    ],
    flags: [{ flag: "--force", description: "Rebuild even if nothing changed." }],
    examples: [{ command: "openmods update" }, { command: "openmods update codex --force" }],
    audience: "users",
  },
  {
    name: "check-updates",
    usage: "openmods check-updates [harness]",
    summary: "What the launcher does once a day: is there anything to update?",
    description: [
      "Pulls the registry, compares the versions of your installed mods with your build, and writes a note the launcher reads on the next launch. On offer: a newer release every mod has a version for, and new updates of your mods. The launcher shows each offer once; after a no it stays quiet until there is something new. A newer release that some mods hold back is mentioned once, naming them. Safe to run by hand.",
    ],
    flags: [{ flag: "--json", description: "The comparison as JSON." }],
    examples: [{ command: "openmods check-updates opencode --json" }],
    audience: "users",
  },
  {
    name: "pack",
    usage: "openmods pack <harness-checkout> --name <mod> --registry <your registry fork> [--owner <you>] [--note <what changed>] [--harness <id>] [--base <tag>] [--force]\nopenmods pack <harness-checkout> --name <mod> --local",
    short: "openmods pack <checkout> --name <mod> --registry <fork>",
    summary: "Turn your commits on top of a harness release into a mod folder.",
    description: [
      "Run it against your clone of the harness. It finds the release tag below your commits, runs git format-patch, and writes the mod as owner/name: a shared mod.json and README under mods/<owner>/<name>, and the harness's own folder, mods/<owner>/<name>/<harness>, with support.json and the patches. Pack again from another harness's clone to add support for that harness to the same mod. The release becomes a version of the mod on that harness, with its patches in a folder named after the release tag. Packing at another release adds a version and keeps the others; packing at a release it already has needs --force and replaces only that version.",
      "Each version records which update of the mod it holds. Pack numbers it: the next update when the changed lines differ from the latest update, the same one when they do not, so a rebase onto another release is not a new update. --note says what the update changed; users see it when they are offered the update.",
      "It writes into the registry you name with --registry, your fork's checkout, and refuses to write into the copy in ~/.openmods that the CLI updates itself from.",
      "Warns if a patch touches a lockfile, which is usually a build side effect and would make the mod conflict with every other mod that does the same.",
    ],
    flags: [
      { flag: "--name <mod>", description: "Mod name: lowercase letters, digits and hyphens." },
      { flag: "--owner <you>", description: "Your GitHub handle. Defaults to git's github.user, then the GitHub CLI's login." },
      { flag: "--local", description: "Write to ~/.openmods/local instead: installable now, published never." },
      { flag: "--harness <id>", description: "Which harness, when the clone's remote does not say." },
      { flag: "--base <tag>", description: "The release tag to diff against, when there are several below HEAD." },
      { flag: "--out <dir>", description: "Write somewhere else entirely." },
      { flag: "--force", description: "Replace the version for this release if the mod already has one." },
      { flag: "--note <text>", description: "One line on what this update changed, shown to users." },
    ],
    examples: [
      { command: "openmods pack . --name my-mod --registry ../openmods", note: "from your harness clone, into your fork of the registry" },
      { command: "openmods pack . --name my-mod --registry ../openmods --force --note \"fixes the resize crash\"", note: "an update" },
    ],
    audience: "authors",
  },
  {
    name: "check",
    usage: "openmods check <mod-folder | owner/mod --<harness>> [--ref <tag>] [--typecheck | --build] [--json]\nopenmods check --harness <id> --ref <tag> [--typecheck | --build] [--json]",
    short: "openmods check <owner>/<mod> --<harness> [--typecheck | --build]",
    summary: "Does a mod apply, typecheck, or build against a release?",
    description: [
      "Clones the harness into a temporary workspace, checks out the release, and applies the patches. --typecheck then runs the harness's typecheck (minutes); --build runs its full build (long). CI runs the typecheck, on pull requests and against each new harness release; authors run the build themselves before opening a pull request.",
      "With --harness and no mod, it builds the stock harness: what the manual harness build workflow runs to prove a harness definition, or to confirm it after a release changed the build recipe. Exits non-zero on any failure.",
    ],
    flags: [
      { flag: "--ref <tag>", description: "Release to test against; defaults to the one the version is for." },
      { flag: "--at <tag>", description: "Check the mod's version for this release instead of its newest." },
      { flag: "--typecheck", description: "Run the harness's typecheck after applying." },
      { flag: "--build", description: "Run the harness's full build after applying." },
      { flag: "--harness <id>", description: "Check the stock harness with no mod." },
      { flag: "--workspace <dir>", description: "Reuse this checkout instead of a temporary one." },
      { flag: "--json", description: "Result as JSON, for CI." },
    ],
    examples: [
      { command: "openmods check you/my-mod --opencode --build" },
      { command: "openmods check mods/you/my-mod/opencode --ref v1.19.0 --typecheck" },
      { command: "openmods check --harness codex --ref rust-v0.156.0 --build" },
    ],
    audience: "authors",
  },
  {
    name: "registry",
    usage: "openmods registry",
    summary: "Which registry checkout and home folder the CLI is using.",
    description: ["When run from a checkout of the registry, the CLI uses that checkout and never pulls; otherwise it uses the clone under ~/.openmods/registry."],
    examples: [{ command: "openmods registry" }],
    audience: "authors",
  },
]

export const GLOBAL_FLAGS: Flag[] = [
  { flag: "--registry <dir|url>", description: "Registry to use. Default: the checkout you run from, else ~/.openmods/registry, cloned from github.com/shouryamaanjain/openmods on first use." },
  { flag: "--json", description: "Machine-readable output, where a command supports it." },
  { flag: "--help", description: "This text. `openmods help <command>` shows one command." },
]

export const ENVIRONMENT: Flag[] = [
  { flag: "OPENMODS_HOME", description: "Where everything lives. Default ~/.openmods." },
  { flag: "OPENMODS_REGISTRY", description: "Registry directory or git URL, same as --registry." },
  { flag: "OPENMODS_NO_PROMPT=1", description: "The launcher never asks about updates." },
  { flag: "OPENMODS_NO_CHECK=1", description: "The launcher never checks for updates." },
]

export const FILES: Flag[] = [
  { flag: "~/.openmods/bin/<binary>", description: "The launcher for a harness; present only while on." },
  { flag: "~/.openmods/harnesses/<id>/src", description: "The harness checkout, patched, kept as a cache." },
  { flag: "~/.openmods/harnesses/<id>/builds", description: "The current modded build, kept until a newer one succeeds." },
  { flag: "~/.openmods/toolchains/", description: "The exact toolchain each harness release pins." },
  { flag: "~/.openmods/local/<owner>/<mod>", description: "Your own unpublished mods, laid out like the registry." },
  { flag: "~/.openmods/updates/<id>", description: "The launcher's daily note." },
  { flag: "~/.openmods/state.json", description: "What is installed, and on, per harness." },
]
