---
name: openmods
description: Make, test, package and publish source-level mods for coding-agent harnesses (OpenCode, Codex CLI, fx) with OpenMods. Use whenever someone wants to change a harness's own source code (a new slash command, panel, keybinding, tool, theme, status line or behavior in OpenCode, Codex or fx), try it with openmods dev, pack it with openmods pack, check it, write the mod's README, open a pull request to the OpenMods registry, or update a mod for a new harness release or a conflict issue, even if they never say "mod".
license: MIT
compatibility: Needs git and the openmods CLI (curl -fsSL https://openmods.dev/install.sh | sh). Builds fetch the Bun or Zig a release pins; Codex needs Rust, a C compiler and Python 3.11+.
---

# Making OpenMods mods

A **mod** is a series of git commits on top of one **release tag** of a harness, published as patch files in the OpenMods registry (github.com/shouryamaanjain/openmods). Users run `openmods install <owner>/<mod>`, and OpenMods clones the harness at that release, applies the patches with `git am -3`, builds it with the release's own build commands, and puts a launcher first on PATH. The user's stock install is never touched, and `openmods off` switches back to it.

So a mod can change anything in the harness: UI, commands, tools, prompts, behavior. That is the point of it. It also means a mod is ordinary source code in someone else's project, so it has to be written to survive: other mods are applied next to it, new releases arrive every few days, and a maintainer reviews every line.

## Before you start: is this a mod?

A mod changes the harness's code. If the idea fits in the harness's own extension points without code changes, ship it there instead and say so to the user:

- a skill, an MCP server, or a plugin → that system's channel (skills.sh, npm, the harness config). OpenCode 2 in particular loads TUI plugins from `~/.config/opencode/plugins/<name>/` with the same API its built-in plugins use, so a feature that only *adds* a slash command, panel, keybinding or toast there is a plugin, not a mod ([references/opencode.md](references/opencode.md) says more)
- a theme, an agent definition, a prompt template or a config value that the harness already reads from files → a file in the user's config (each harness reference says which ones exist)

The registry points such submissions elsewhere. Mods are for what those cannot reach.

## The loop

1. **Pick the harness and its newest release.** `openmods list` shows the releases mods are on; `git ls-remote --tags <repo>` or the harness's GitHub releases page shows the newest. Mods are pinned to releases because that is what users have installed and what CI can reproduce; the default branch is not a release.
   - OpenCode: `https://github.com/anomalyco/opencode`, tags like `v2.0.22`
   - Codex CLI: `https://github.com/openai/codex`, tags like `rust-v0.160.0`
   - fx: `https://github.com/vercel-labs/fx`, tags like `v0.0.12`. fx also has older, higher-numbered pre-launch tags (`v0.4.x`); ignore them and take GitHub's "Latest" release.

2. **Clone and branch at the tag.** Clone from GitHub, so `origin` names the harness: OpenMods tells which harness a clone is from its remote.
   ```sh
   git clone https://github.com/anomalyco/opencode && cd opencode
   git checkout -b my-mod v2.0.22
   ```

3. **Make the change.** Read the harness's reference first; it maps where commands, panels, keys and tools live, and the smallest way to hook into each:
   - OpenCode (TypeScript, Bun, SolidJS on opentui): [references/opencode.md](references/opencode.md)
   - Codex CLI (Rust, ratatui): [references/codex.md](references/codex.md)
   - fx (Zig 0.16): [references/fx.md](references/fx.md)

   Follow the rules under "Writing a mod that lasts" below. They decide whether the mod installs next to other mods and keeps applying on new releases.

4. **Try it live.** From the clone:
   ```sh
   openmods dev            # the harness command now runs this clone from source
   openmods dev --stop     # back to the modded build, or stock
   ```
   Start the harness command again after each edit to see it; there is nothing to commit, pack or build in between. OpenCode runs straight from source; fx and Codex rebuild incrementally on each start (Codex's first build is long). Keep the harness's own typecheck and tests passing; each reference gives the commands.

5. **Commit.** Each commit becomes one patch file, and its message is published with the mod, so write meaningful messages (`feat(tui): add /invaders`). One commit is fine for a small mod. Never commit lockfile or dependency churn that a build or install produced: `git status` before each commit.

6. **Try it as users get it**, built and stacked with the user's other mods:
   ```sh
   openmods install .      # packs your commits as a local mod <you>/<branch> and builds it
   ```
   It's a full release build (minutes). Local mods live in `~/.openmods/local` and are never published; while one exists it takes the place of the registry's copy of the same name. `--name` sets the name if the branch name will not do. This needs the stock harness installed (it's what `openmods off` returns to); if it isn't, openmods prints the harness's official installer and stops, or runs it with `--yes`. The first install also adds `~/.openmods/bin` to PATH in the shell's startup file (`--no-path` skips that).

7. **Pack it into a fork of the registry.** Fork `shouryamaanjain/openmods`, clone the fork next to the harness clone, then from the harness clone:
   ```sh
   openmods pack . --name my-mod --registry ../openmods
   ```
   `pack` writes `mods/<owner>/my-mod/` (owner = your GitHub handle, lowercase, read from `git config github.user` or the GitHub CLI; `--owner` sets it): `mod.json`, a README stub, and `<harness>/support.json` with the patches in a folder named after the release. It records the release's commit from its tag, numbers the update, and puts GitHub's private address in the patches' headers. Don't hand-edit `support.json`'s commits or the patch files; pack again instead.

8. **Fill in `mod.json` and the README** (description, license, tags, what it changes, Permissions). See [references/publishing.md](references/publishing.md); the README is what users read before they build it, and the Permissions section is checked.

9. **Check it, then open the pull request.**
   ```sh
   openmods check mods/<you>/my-mod/<harness> --build      # from the registry fork
   ```
   This applies the patches to the release in a temporary clone and builds, as users will. CI only typechecks, so build it yourself before the PR. Then commit only the mod's folder in the fork, on a branch from the registry's `main`. You can run the **standards** check locally before pushing: `bun script/pr-check.ts --base main --head HEAD --author <you>` from the fork. Then open a PR to `shouryamaanjain/openmods`. The **standards** check, CI's apply-and-typecheck, Greptile's code and security review, and a maintainer's approval follow; [references/publishing.md](references/publishing.md) lists what each enforces.

The same mod can support several harnesses: make the change in each harness's clone and `pack` from each into the same registry folder. Users pick with `--opencode`, `--codex` or `--fx`.

## Writing a mod that lasts

These matter more than anything else about the code, because the registry is a place where many mods meet one release, and then the next release.

- **Touch as few upstream lines as you can.** OpenMods refuses to install two mods together when their patches change the same lines, or lines right next to each other, of the same file; two insertions at the same spot count too. Put the feature in **new files** and hook it in with the smallest possible edits to upstream files (one import and one registration line beats reshaping a component). Place each hook next to something it's related to, not at the first or last entry of a list, where every other mod would insert. Each reference shows the least invasive hook for common features. Small hooks also rebase cleanly onto new releases.
- **Don't reformat, reorder or "clean up" upstream code.** Every changed line is a line another mod can't touch and a line that may conflict next release.
- **No dependency or lockfile changes unless the feature truly needs them.** Two mods that both touch a lockfile can never be installed together, and `pack` warns about it. Build files and dependency changes are flagged for reviewers.
- **Don't change what stock shares with the modded build.** Users keep their stock harness next to the modded one, and some state is shared: OpenCode's session database when both are on the same release (so no database migrations or table changes), all of `~/.fx` and fx's background terminal host (so no changes to fx's session format or terminal host), Codex's shared background server. Keep a mod's own state in its own files. The references say exactly what is shared.
- **Keep the harness's tests and typecheck green**, and update snapshot tests your change legitimately affects (Codex's insta snapshots, fx's pinned order and hash tests). CI typechecks every mod version on every release.
- **Say what the mod does.** If it adds network calls, reads or writes files outside what the harness already does, runs commands, or changes what the agent is told, the README's Permissions section must say so. A mod that does something its README doesn't disclose is rejected, and a harmful one is removed from every user's machine.
- **If the agent should know about a new tool or behavior, describe it where the harness describes its built-in tools**, not in a skill beside the mod.

## Updating a mod

- **New harness release:** an hourly job rebases every mod onto the harness's newest release. If the rebased patches still apply and typecheck, and change exactly the lines a maintainer reviewed, a new version is added automatically. Nothing to do.
- **When it doesn't:** CI opens an issue labelled `conflict` that mentions the mod's maintainers, with the exact commands. The short version, in the harness clone:
  ```sh
  git fetch --tags
  git checkout -b my-mod <last-supported-tag>
  git am ../openmods/mods/<you>/my-mod/<harness>/<last-supported-tag>/*.patch
  git rebase --onto <new-tag> <last-supported-tag> my-mod     # resolve, git rebase --continue
  openmods install .                                          # try it
  openmods pack . --name my-mod --registry ../openmods --note "works on <harness> <new release>"
  ```
  `pack` adds a version for the new release and keeps the older ones (users whose other mods are behind still build those).
- **Shipping a change:** edit the commits and pack again, with `--force` if that release already has a version, and `--note "what changed"` (required for a new update; users see it when they're offered the update). `pack` numbers updates itself: same changed lines, same update; different lines, the next one.

## When something goes wrong

- `cannot tell which harness … is`: the clone's `origin` isn't the harness's GitHub repository; set it, or pass `--opencode`/`--codex`/`--fx`.
- `cannot tell who owns this mod`: set `git config github.user <handle>` or pass `--owner`.
- `… does not work with … : both change <file> (line n)`: your patch overlaps another mod's lines. Move your change into a new file, or hook in at a different spot.
- `does not apply cleanly`: the patches were made on another release, or a mod applied before yours changed the same area. Rebase onto the right tag.
- `… as commit …, but its tag … is …` or `a release has one commit`: a version's commit isn't the release's own. Pack again from a clone branched at the release tag.
- A build that fails leaves the user's previous build running; `openmods check … --build` shows the full error, and the log path is printed.

`openmods help <command>` explains every command; the full reference is at https://openmods.dev/cli/.
