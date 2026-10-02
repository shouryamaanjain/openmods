---
name: openmods
description: Make, test, package and publish source-level mods for coding-agent harnesses (OpenCode, Codex CLI, fx) with OpenMods. Use whenever someone wants to change a harness's own source code (a new slash command, panel, keybinding, tool, theme, status line or behavior in OpenCode, Codex or fx), try it with openmods dev, pack it with openmods pack, check it, write the mod's README, open a pull request to the OpenMods registry, or update a mod for a new harness release or a conflict issue, even if they never say "mod".
license: MIT
compatibility: Needs git and the openmods CLI (curl -fsSL https://openmods.dev/install.sh | sh). Builds fetch the Bun or Zig a release pins; Codex needs Rust, a C compiler and Python 3.11+.
---

# Making OpenMods mods

A **mod** is a series of git commits on top of a release of a harness, published as patch files in the OpenMods registry (github.com/shouryamaanjain/openmods). Users run `openmods install <owner>/<mod>`, and OpenMods clones the harness at that release, applies the patches, builds it with the release's own build commands, and puts a launcher first on PATH. The user's stock install is never touched, and `openmods off` switches back to it.

A mod can change anything in the harness: UI, commands, tools, prompts, behavior. Build what the developer wants; combining mods and moving them to new releases is OpenMods' job.

## The loop

1. **Clone the harness and branch at its release tag.** Use the version the developer has installed (`opencode --version`, `codex --version`, `fx --version`), or the newest release. Clone from GitHub, so `origin` names the harness: OpenMods tells which harness a clone is from its remote.
   ```sh
   git clone https://github.com/anomalyco/opencode && cd opencode
   git checkout -b my-mod v2.0.22
   ```
   - OpenCode: `https://github.com/anomalyco/opencode`, tags like `v2.0.22`
   - Codex CLI: `https://github.com/openai/codex`, tags like `rust-v0.160.0`
   - fx: `https://github.com/vercel-labs/fx`, tags like `v0.0.12`

2. **Make the change.** The harness's reference maps where commands, panels, keys, tools, config and the CLI live, how to run its checks, and a complete published mod to learn from:
   - OpenCode (TypeScript, Bun, SolidJS on opentui): [references/opencode.md](references/opencode.md)
   - Codex CLI (Rust, ratatui): [references/codex.md](references/codex.md)
   - fx (Zig 0.16): [references/fx.md](references/fx.md)

3. **Try it live.** From the clone:
   ```sh
   openmods dev            # the harness command now runs this clone from source
   openmods dev --stop     # back to the modded build, or stock
   ```
   Start the harness command again after each edit to see it; there is nothing to commit, pack or build in between. OpenCode runs straight from source; fx and Codex rebuild incrementally on each start (Codex's first build is long). Run the harness's own typecheck and tests as you go; each reference gives the commands.

4. **Commit.** Each commit becomes one patch file, and its message is published with the mod, so write meaningful messages (`feat(tui): add /invaders`). One commit is fine. Check `git status` first, so files a build or install produced don't end up in the mod by accident.

5. **Try it as users get it**, built together with the developer's other mods:
   ```sh
   openmods install .      # packs your commits as a local mod <you>/<branch> and builds it
   ```
   It's a full release build (minutes). Local mods live in `~/.openmods/local` and are never published; while one exists it takes the place of the registry's copy of the same name. `--name` sets the name if the branch name will not do. This needs the stock harness installed (it's what `openmods off` returns to); if it isn't, openmods prints the harness's official installer and stops, or runs it with `--yes`. The first install also adds `~/.openmods/bin` to PATH in the shell's startup file (`--no-path` skips that).

6. **Pack it into a fork of the registry.** Fork `shouryamaanjain/openmods`, clone the fork next to the harness clone, then from the harness clone:
   ```sh
   openmods pack . --name my-mod --registry ../openmods
   ```
   `pack` writes `mods/<owner>/my-mod/` (owner = your GitHub handle, lowercase, read from `git config github.user` or the GitHub CLI; `--owner` sets it): `mod.json`, a README stub, and `<harness>/support.json` with the patches in a folder named after the release. It records the release's commit from its tag, numbers the update, and puts GitHub's private address in the patches' headers. Don't hand-edit `support.json`'s commits or the patch files; pack again instead.

7. **Fill in `mod.json` and the README** (description, license, tags, what it does, Permissions). See [references/publishing.md](references/publishing.md); the README is what users read before they build it, and the Permissions section is checked.

8. **Check it, then open the pull request.**
   ```sh
   openmods check mods/<you>/my-mod/<harness> --build      # from the registry fork
   ```
   This applies the patches to the release in a temporary clone and builds, as users will. CI typechecks the versions a PR changes and builds OpenCode and fx mods, but never builds Codex mods, so build it yourself before the PR. Then commit only the mod's folder in the fork, on a branch from the registry's `main`. You can run the **standards** check locally before pushing, against the registry's current `main`: `git fetch https://github.com/shouryamaanjain/openmods main && bun script/pr-check.ts --base FETCH_HEAD --head HEAD --author <you>` from the fork. Then open a PR to `shouryamaanjain/openmods`. The **standards** check, CI's apply-and-typecheck, Greptile's code and security review, and a maintainer's approval follow; [references/publishing.md](references/publishing.md) lists what each enforces.

The same mod can support several harnesses: make the change in each harness's clone and `pack` from each into the same registry folder. Users pick with `--opencode`, `--codex` or `--fx`.

## What the registry requires

- **The harness's tests and typecheck pass** with the mod applied, and snapshot tests your change affects are updated (Codex's insta snapshots, fx's pinned order, count and hash tests). CI typechecks every version a PR changes; the release watch checks each mod's newest version on every new release.
- **The README says what the mod does.** If it adds network calls, reads or writes files outside what the harness already does, runs commands, or changes what the agent is told, the Permissions section says so. A mod that does something its README doesn't disclose is rejected, and a harmful one is revoked: it stops running on every user's machine (they get their stock harness back until they uninstall it).
- If the agent should know about a new tool or behavior, describe it where the harness describes its built-in tools.

## Updating a mod

- **New harness release:** an hourly job rebases every mod onto the harness's newest release. If the rebased patches still apply and typecheck, and change exactly the lines a maintainer reviewed, a new version is added automatically. Nothing to do.
- **When it doesn't:** CI opens an issue labelled `conflict` that mentions the mod's maintainers, with the exact commands. The short version, in the harness clone:
  ```sh
  git fetch --tags
  git checkout -b my-mod <last-supported-tag>
  git am ../openmods/mods/<owner>/my-mod/<harness>/<last-supported-tag>/*.patch
  git rebase --onto <new-tag> <last-supported-tag> my-mod     # resolve, git rebase --continue
  openmods install . --owner <owner>                          # try it
  openmods pack . --name my-mod --owner <owner> --registry ../openmods --note "works on <harness> <new release>"
  ```
  `--owner` is the mod's owner (the folder under `mods/`), which matters when you're a listed maintainer rather than the owner: without it, pack writes a new mod under your own handle. `pack` adds a version for the new release and keeps the older ones.
- **Shipping a change:** edit the commits and pack again, with `--force` if that release already has a version, and `--note "what changed"` (required for every update after the first; users see it when they're offered the update). `pack` numbers updates itself: same changed lines, same update; different lines, the next one.

## When something goes wrong

- `cannot tell which harness … is`: the clone's `origin` isn't the harness's GitHub repository; set it, or pass `--opencode`/`--codex`/`--fx`.
- `cannot tell who owns this mod`: set `git config github.user <handle>` or pass `--owner`.
- `does not apply cleanly`: the patches were made on another release. Rebase onto that release's tag.
- `… as commit …, but its tag … is …` or `a release has one commit`: a version's commit isn't the release's own. Pack again from a clone branched at the release tag.
- A build that fails leaves the user's previous build running; `openmods check … --build` shows the full error, and the log path is printed.

`openmods help <command>` explains every command; the full reference is at https://openmods.dev/cli/.
