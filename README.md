# OpenMods

Source-level mods for open-source agent harnesses.

Claude Code has Mods: plugins that reach into the harness and change how it behaves and what it shows. Open-source harnesses like [OpenCode](https://github.com/anomalyco/opencode) don't need a plugin API for that. You can clone the repo, change anything, and build. What's missing is a way to share those changes so other people can install them without redoing the work.

OpenMods is that layer. A mod is a set of git patches against a pinned release of a harness. Installing a mod clones the harness, applies the patches, builds it, and gives you a modded binary. Your stock install is never touched.

```sh
curl -fsSL https://openmods.dev/install.sh | sh

openmods list
openmods install <owner>/<mod> --opencode
opencode                            # a real OpenCode release with the mod built in
openmods off                       # opencode is stock again
openmods on                        # and back
openmods off <owner>/<mod>         # keep it installed, build it out
openmods uninstall <owner>/<mod>   # gone
```

A mod is named after its author, like `shouryamaanjain/tetris`, and can support several harnesses. `--opencode` or `--codex` says which one to install it on. Leave the flag out and the CLI asks, listing only the harnesses that mod supports and marking the ones you do not have; a mod for a single harness needs no flag. Picking a harness you do not have offers its official installer, such as `curl -fsSL https://opencode.ai/install | bash`, and runs it only if you say yes.

Your stock OpenCode is never modified. `install` builds a separate modded binary and puts it first on PATH. `off` steps aside so the stock one runs; `on` steps back in. `openmods status` tells you which one `opencode` runs right now.

The installer clones the registry under `~/.openmods`, puts an `openmods` command in `~/.openmods/bin`, and installs Bun if you do not have it. Working on the registry itself? `bun link ./cli` from a checkout does the same with your working copy. Requirements: `git` and `bun` to run the CLI. Each harness release pins the exact Bun it builds with, and the CLI installs that version under `~/.openmods/toolchains` for the build, so your own Bun is never changed. The first install of a harness clones and builds it, which takes a few minutes. Later installs reuse the checkout.

## Harnesses

| harness | repo | status |
| --- | --- | --- |
| `opencode` | [anomalyco/opencode](https://github.com/anomalyco/opencode) | supported |
| `codex` | [openai/codex](https://github.com/openai/codex) | supported |
| `fx` | [vercel-labs/fx](https://github.com/vercel-labs/fx) | planned |

Anything open source with a build command can be a harness. See [`harnesses/`](harnesses). Each harness builds with its own toolchain: OpenCode with the Bun version its release pins, which the CLI installs for you; Codex with Rust, where `rustup` picks up the toolchain the release pins on its own. A Codex build from source takes about seventeen minutes the first time, most of it compiling dependencies, and about six minutes for a rebuild after a mod changes. OpenMods builds Codex without link-time optimization, which its own releases use; that costs a few percent of runtime speed and some binary size, and turns a seventeen-minute rebuild into six.

## Mods

The registry lives under [`mods/<owner>/<mod>`](mods). Run `openmods list` for what is published, or `openmods info <owner>/<mod>` to see exactly which files a mod touches on each harness before you build it. Every command is documented at [openmods.dev/cli](https://openmods.dev/cli/) and in `openmods help <command>`.

Mods you are still working on, or do not want to publish, go under `~/.openmods/local/<owner>/<mod>`, in the same layout. The CLI lists and installs them like registry mods, marked `(local)`.

## How it works

```
mods/<owner>/<mod>/
  mod.json            owner, name, description, license: shared by every harness
  README.md
  opencode/
    support.json      its versions on OpenCode: one per release, newest first
    v1.18.32/0001-…   the patches for OpenCode 1.18.32, applied in order with git am
    v1.18.31/0001-…   the patches for 1.18.31, kept after the mod moved on
  codex/
    support.json      the same for Codex, against Codex releases
    rust-v0.155.1/0001-…
```

A mod's version is the harness release it works on, and it keeps a version for every release it has worked on. Mods move to new releases at different speeds. Keeping the old versions means you can still build a set of mods together at a release they all have.

`openmods install` does the mechanical part:

1. Blobless clone of the harness into `~/.openmods/harnesses/<id>/src`.
2. Pick one release for all the mods on that harness: the one you are on, if every mod has a version for it, else the newest release they all have a version for. Mods that share no release are refused, with the releases each one has. Then check out that release.
3. `git am -3` each mod's patches for that release, in the order you listed them.
4. Run the harness's own install and build commands, with the exact toolchain version that release pins. Building OpenCode 1.18.31 with Bun 1.4 instead of its pinned 1.3.14 produces a binary that logs errors on every launch, so this is not optional.
5. Write the launcher at `~/.openmods/bin/<binary>` and, the first time, add that folder to the front of PATH in your shell config. The build is stamped, so `opencode --version` reports the release plus the mods, e.g. `1.18.31+vim-keys`.

`off` removes the launcher, so `opencode` falls through to the stock binary the harness installed. `on` restores it. Neither rebuilds anything. Pass `--no-path` if you would rather manage PATH yourself.

`uninstall` rebuilds without the mod. When the last mod for a harness goes, the launcher, the built binary and the patched commits go with it, and the checkout is reset to the stock release. It is kept only as a cache so the next install does not clone and install dependencies again; delete `~/.openmods/harnesses/<id>` if you want the space back.

Several mods stack on the same checkout. Some mods cannot be combined: two mods that change the same lines of a release, or lines right next to each other, would not merge. The CLI works this out from the patches before it builds. It refuses the combination, names the mods and the lines they share, and leaves your current build running. `openmods info` and each mod's page on the site list the mods it cannot be installed with, and the selector marks a harness where it clashes with a mod you have.

## When the harness updates

A mod is "for" one harness release, and that release is the mod's version. Harnesses move fast, so the registry follows them without waiting for anyone:

1. A job runs every hour and notices when a harness publishes a new release.
2. The lines our build recipe depends on (the harness's `recipe` list: its build script, its toolchain pin, and so on) are compared between the last release it was checked at and the new one. If any changed, every mod for that harness is held where it is and one issue asks a person to run the manual **harness build** workflow; a successful build lifts the hold. CI never builds a harness on its own.
3. Otherwise every mod for that harness is applied to the new release and typechecked, one job per mod. The apply is a three-way merge, which fails exactly when the release changed the mod's own lines. The typecheck is the compiler's front half: it verifies every name, type and signature the mod relies on, in minutes, without producing a binary, and only for the packages the mod touches.
4. A mod that passes gets a new version for the new release in that harness's `support.json`, with its patches saved as they apply there. The mod's code does not change, but the new version's patches match the new release, so installing it needs no merge and the next release is compared against it. Its older versions stay.
5. A mod that fails keeps its current release and gets a `status.json` saying which release it does not support. The recipe check's result is kept in `status/<harness>.json`. The listing shows it in yellow, and the bot opens an issue that mentions the mod's maintainers with the error and the steps to rebase.

Compiled dependencies are cached between runs, so a check starts from warm.

On your machine, the `opencode` command in `~/.openmods/bin` is a small launcher. It starts your build immediately and, once a day, refreshes the registry in the background. It asks only when there is something to update: a newer release that every mod you have supports, or a new update of one of your mods. Both go into one question:

```
OpenCode 1.19.0 is out, and all your mods support it. New in your mods: shouryamaanjain/tetris update 8 (fixes the resize crash).
Update now? It rebuilds OpenCode, which takes a few minutes. [y/N]
```

`y` rebuilds and launches the new build. Anything else launches your current build, and that offer is never shown again: the launcher asks next time there is something new, such as another release or another mod update. `openmods status` shows a pending update if there is one, and `openmods update` does the same rebuild on demand: it moves you to the newest release every mod you have on has a version for, with each mod's latest update for it. If one of your mods has no version for a newer release yet, the launcher says so once and you stay where you are.

A mod's updates are numbered: every time its author packs changed code, it becomes the next update. The number shows in the build's version, e.g. `opencode --version` prints `1.19.0+tetris-8.vim-keys-3`, so a bug report says exactly what was built. Nothing else moves you to another release, except installing a mod that has no version for the one you are on; then the CLI builds the newest release all your mods share and says so. It never rebuilds on its own, never asks when `opencode` is not at a terminal, and `OPENMODS_NO_PROMPT=1` turns the question off.

## The site

`bun run site` builds the site into `site/` from the registry; `bun script/site.ts --local --out site` also includes your unpublished mods from `~/.openmods/local` for a preview. The output is plain files, so any static host works. The included workflow publishes it to [openmods.dev](https://openmods.dev) on every push to main, as a Cloudflare Worker serving static assets; `wrangler.toml` binds the domain, and the deploy needs the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets.

## Making a mod

```sh
git clone https://github.com/anomalyco/opencode && cd opencode
git checkout v1.18.31            # the release you want to mod
# ... change anything, then commit as many times as you like ...
openmods pack . --name my-mod --local   # installable now from ~/.openmods/local, not published
openmods pack . --name my-mod           # writes mods/<you>/my-mod/opencode/ into the registry
openmods check mods/<you>/my-mod/opencode --build   # build it yourself; CI only typechecks
```

`pack` names the mod after your GitHub handle, from `git config github.user` or the GitHub CLI; `--owner` sets it. Packing the same name from a Codex checkout adds `codex/` to the same mod.

Then open a pull request. [CONTRIBUTING.md](CONTRIBUTING.md) has the details.

## Why patches and not forks

A fork is a snapshot. It goes stale silently, it can't be combined with another fork, and reviewing it means diffing two whole repositories. A patch series is small, readable on the listing page, applies to the release it names, and stacks with other patches until two of them disagree. It is the format Debian, Nix, and Homebrew have used for decades for exactly this problem.

## Security

A mod is code that runs with your permissions, like any program you build from source. Before installing one, read its patches. `openmods info` lists the touched files, and each mod's page shows the diff. Nothing is prebuilt: your machine compiles the harness from its release plus the patches, so what you read is what you run. [SECURITY.md](SECURITY.md) has the details and how to report a problem.

## License

MIT. Each mod carries its own license in `mod.json`; each harness keeps its upstream license.
