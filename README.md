# OpenMods

Mods for open-source harnesses. A mod changes a harness's own source code: a new command, a different layout, a game to play while it works. OpenMods builds the harness with the mods you pick and puts that build on your PATH, while your stock install stays as it is.

Supported: [OpenCode](https://github.com/anomalyco/opencode) and [Codex CLI](https://github.com/openai/codex), on macOS and Linux.

## Install

```sh
curl -fsSL https://openmods.dev/install.sh | sh
```

This needs `git`, `curl` and `tar`. OpenMods keeps its files in `~/.openmods`, including the Bun the CLI runs on. Outside that folder, it adds a PATH line, marked `# openmods`, to your shell's startup file so `~/.openmods/bin` comes first; for bash on Linux, also to the file a login shell reads. In `~/.openmods/bin` it puts a small launcher for each harness you have, which runs your stock one until you install a mod.

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

The launcher checks for updates once a day in the background. When a newer release is supported by every mod you have switched on, or one of your mods has a new update, it asks once before starting. `openmods update` does the same on demand, and `OPENMODS_NO_PROMPT=1` turns the question off.

A build's version names what went into it: `codex --version` prints something like `0.157.0+space-invaders-1`.

## How it works

A mod is a series of git patches against a tagged release of a harness:

```
mods/<owner>/<mod>/
  mod.json              name, description, license
  README.md             what it does, and a Permissions section
  opencode/
    support.json        the releases it supports
    v1.18.32/0001-….patch
  codex/
    support.json
    rust-v0.157.0/0001-….patch
```

`openmods install` clones the harness, checks out a release every one of your mods supports, applies the patches with `git am -3`, and builds it with the harness's own build commands and the toolchain that release pins. The result goes in `~/.openmods/harnesses/<id>/builds`, and `~/.openmods/bin/<binary>` is a small launcher that runs it, or your stock build after `openmods off`.

The OpenMods base patch ([`mods/openmods/base`](mods/openmods/base)) goes into every modded build, for each release it has a version for. It points feedback and crash reports at OpenMods rather than the upstream project, which did not ship the mods. For Codex it also turns off Codex's own update notice, since OpenMods does the updating, and keeps modded Codex off the background server stock Codex shares.

When a harness publishes a release, a scheduled job applies and typechecks every mod against it. Mods that still apply and typecheck get a version for the new release automatically. For a mod that no longer does, the job opens an issue for its maintainers with the error. If the release changed how the harness builds, the mods wait until a maintainer has built it.

Patches rather than forks: a patch series is small enough to read and review, and it names the release it applies to. It also stacks with other mods, where two forks can't be combined.

## Making a mod

```sh
git clone https://github.com/anomalyco/opencode && cd opencode
git checkout v1.18.32                     # a release, not the default branch
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
