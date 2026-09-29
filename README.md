# OpenMods

Mods for open-source harnesses. A mod changes a harness's own source code: a new command, a different layout, a game to play while it works. OpenMods builds the harness with the mods you pick and puts that build on your PATH, while your stock install stays as it is.

Supported: [OpenCode](https://github.com/anomalyco/opencode) and [Codex CLI](https://github.com/openai/codex), on macOS and Linux.

## Install

```sh
curl -fsSL https://openmods.dev/install.sh | sh
```

This needs `git`, `curl` and `tar`. OpenMods keeps its files in `~/.openmods`: the program, the mods list (a clone of this repository, pulled by `list`, `info`, `install` and `update`, which never changes the program), and the Bun the CLI runs on. Only `openmods update`, or running the installer again, updates OpenMods itself; update says from which version to which. Outside that folder, it adds a PATH line, marked `# openmods`, to your shell's startup file so `~/.openmods/bin` comes first; for bash on Linux, also to the file a login shell reads. In `~/.openmods/bin` it puts a small launcher for each harness you have, which runs your stock one until you install a mod.

## Use

```sh
openmods list                                              # what is published
openmods info shouryamaanjain/space-invaders               # what a mod changes, file by file
openmods install shouryamaanjain/space-invaders --codex    # build it into Codex, and switch to that build
codex                                                      # the modded build

openmods off                                               # back to your stock build
openmods on                                                # and to the modded one
openmods status                                            # which one runs right now
openmods update                                            # move to newer releases and mod updates
openmods uninstall shouryamaanjain/space-invaders --codex
```

A mod is named `<owner>/<mod>` and can support several harnesses; add `--opencode` or `--codex` to pick one, or the CLI asks. You can install several mods on one harness. If two of them change the same lines, the CLI refuses before it builds and names the lines.

Every command is documented at [openmods.dev/cli](https://openmods.dev/cli/) and in `openmods help <command>`.

### Building

Mods are built from source on your machine, nothing is prebuilt. The first build of a harness takes a few minutes; a progress line shows each step and how long it has run, and the time left once it can tell. Later builds reuse what they can.

- **OpenCode** needs nothing more: the CLI fetches the exact Bun version each release pins.
- **Codex CLI** is a large Rust project: around ten minutes on a recent laptop, longer on a smaller machine, and a few GB of build cache. Its Rust crates download to Cargo's usual `~/.cargo`. It needs Rust, a C compiler and Python 3.11+, plus `pkg-config` and the libcap and OpenSSL headers on Linux. If any are missing, the CLI says which, with one command that installs them all when your package manager has them. OpenMods builds Codex with less optimization than its official releases, which roughly halves the build time.

### Updates

When you start `codex` or `opencode` at a terminal, the launcher starts your build at once and, in the background, refreshes the mods list. That look never updates OpenMods or your build; it may refresh its own launchers, and it stops a mod removed from OpenMods. The next time you start it, it tells you what it found: a newer release every mod you have switched on supports, or a fix for one of your mods, with the question "Update now?"; or a newer release some mods hold back, said once. A no is final for that offer, and nothing is rebuilt without a yes. `openmods update` does the same any time, and `OPENMODS_NO_CHECK=1` turns the background look off. Every `openmods` command you run, other than asking for help, also gets the current list of mods removed from OpenMods, so a removed mod stops running.

A build's version names what went into it: `codex --version` prints something like `0.157.0+space-invaders-1`.

## How it works

A mod is a series of git patches against a tagged release of a harness:

```
mods/<owner>/<mod>/
  mod.json              name, description, license
  README.md             what it does, and a Permissions section
  opencode/
    support.json        the releases it supports
    v2.0.18/0001-….patch
  codex/
    support.json
    rust-v0.157.0/0001-….patch
```

`openmods install` clones the harness, checks out a release every one of your mods supports, applies the patches with `git am -3`, and builds it with the harness's own build commands and the toolchain that release pins. The result goes in `~/.openmods/harnesses/<id>/builds`, and `~/.openmods/bin/<binary>` is a small launcher that runs it, or your stock build after `openmods off`.

OpenMods never changes a harness's code: a modded build is the release plus your mods, and `--version` shows the release as stock does. Where a modded build and your stock one would get in each other's way, the launcher passes the harness's own switches when it starts it, for a single run, never in your config. For Codex: `--no-daemon`, so modded Codex does not share stock Codex's background server and every mod, deep changes to tools included, runs in the modded session; `codex agents` and `--remote`, which need that shared server, start your stock Codex, so the server is always stock's; `-c check_for_update_on_startup=false`, since Codex's own update notice would update stock, not the modded build; and `-c feedback.enabled=false`, so `/feedback` does not send logs from a build OpenAI did not ship. For OpenCode, the build uses its own channel, which gives it its own database and background server, and the launcher turns off OpenCode's self-update. Report problems with a modded build to OpenMods or the mod's author, not the upstream project, after checking whether they also happen with `openmods off`.

When a harness publishes a release, a scheduled job applies and typechecks every mod against it. Mods that still apply and typecheck get a version for the new release automatically. For a mod that no longer does, the job opens an issue for its maintainers with the error. If the release changed how the harness builds, the mods wait until a maintainer has built it.

Patches rather than forks: a patch series is small enough to read and review, and it names the release it applies to. It also stacks with other mods, where two forks can't be combined.

## Making a mod

```sh
git clone https://github.com/anomalyco/opencode && cd opencode
git checkout v2.0.18                      # a release, not the default branch
# change anything, and commit
openmods dev                              # `opencode` now runs this clone from source
openmods install .                        # build it as users will get it
openmods pack . --name my-mod --registry ../openmods    # into your fork of this repo
```

Then open a pull request. [CONTRIBUTING.md](CONTRIBUTING.md) walks through it, including Codex and what review checks.

## Security

A mod is code that runs with your permissions, like anything you build from source. Read it before you install it: `openmods info` lists every file a mod touches, each mod's page on [openmods.dev](https://openmods.dev) shows the diff, and its README has a Permissions section saying what it does with the network, files, commands and the agent's instructions. Because your machine builds from the release plus those patches, what you read is what you run. [SECURITY.md](SECURITY.md) explains how mods are reviewed and how to report a problem.

## Uninstalling OpenMods

Delete `~/.openmods` and the `# openmods` lines in your shell's startup files. Your stock harnesses were never changed.

## Development

```sh
bun install
bun run typecheck && bun run validate && bun run test
bun run site                              # build openmods.dev into site/
```

## License

MIT. Each mod has its own license in its `mod.json`, and each harness keeps its upstream license.
