# OpenMods

Source-level mods for open-source agent harnesses.

Claude Code has Mods: plugins that reach into the harness and change how it behaves and what it shows. Open-source harnesses like [OpenCode](https://github.com/anomalyco/opencode) don't need a plugin API for that. You can clone the repo, change anything, and build. What's missing is a way to share those changes so other people can install them without redoing the work.

OpenMods is that layer. A mod is a set of git patches against a pinned release of a harness. Installing a mod clones the harness, applies the patches, builds it, and gives you a modded binary. Your stock install is never touched.

```sh
curl -fsSL https://raw.githubusercontent.com/shouryamaanjain/open-mods/main/install.sh | sh

open-mods list
open-mods install opencode/<mod>
opencode                            # a real OpenCode release with the mod built in
open-mods off                       # opencode is stock again
open-mods on                        # and back
open-mods off opencode/<mod>        # keep it installed, build it out
open-mods uninstall opencode/<mod>  # gone
```

Your stock OpenCode is never modified. `install` builds a separate modded binary and puts it first on PATH. `off` steps aside so the stock one runs; `on` steps back in. `open-mods status` tells you which one `opencode` runs right now.

The installer clones the registry under `~/.open-mods`, puts an `open-mods` command in `~/.open-mods/bin`, and installs Bun if you do not have it. Working on the registry itself? `bun link ./cli` from a checkout does the same with your working copy. Requirements: `git` and `bun` to run the CLI. Each harness release pins the exact Bun it builds with, and the CLI installs that version under `~/.open-mods/toolchains` for the build, so your own Bun is never changed. The first install of a harness clones and builds it, which takes a few minutes. Later installs reuse the checkout.

## Harnesses

| harness | repo | status |
| --- | --- | --- |
| `opencode` | [anomalyco/opencode](https://github.com/anomalyco/opencode) | supported |
| `codex` | [openai/codex](https://github.com/openai/codex) | supported |
| `fx` | [vercel-labs/fx](https://github.com/vercel-labs/fx) | planned |

Anything open source with a build command can be a harness. See [`harnesses/`](harnesses). Each harness builds with its own toolchain: OpenCode with the Bun version its release pins, which the CLI installs for you; Codex with Rust, where `rustup` picks up the toolchain the release pins on its own. A Codex build from source takes about seventeen minutes the first time, most of it compiling dependencies, and about six minutes for a rebuild after a mod changes. OpenMods builds Codex without link-time optimization, which its own releases use; that costs a few percent of runtime speed and some binary size, and turns a seventeen-minute rebuild into six.

## Mods

The registry lives under [`mods/<harness>/<mod>`](mods). Run `open-mods list` for what is published, or `open-mods info <harness>/<mod>` to see exactly which files a mod touches before you build it.

Mods you are still working on, or do not want to publish, go under `~/.open-mods/local/<harness>/<mod>`. The CLI lists and installs them like registry mods, marked `(local)`.

## How it works

```
mods/opencode/<mod>/
  mod.json          name, license, the harness release it supports (its version)
  patches/0001-…    git format-patch output, applied in order with git am
  README.md
```

`open-mods install` does the mechanical part:

1. Blobless clone of the harness into `~/.open-mods/harnesses/<id>/src`.
2. Check out the commit the mods were written against.
3. `git am -3` each mod's patches, in the order you listed them.
4. Run the harness's own install and build commands, with the exact toolchain version that release pins. Building OpenCode 1.18.31 with Bun 1.4 instead of its pinned 1.3.14 produces a binary that logs errors on every launch, so this is not optional.
5. Write the launcher at `~/.open-mods/bin/<binary>` and, the first time, add that folder to the front of PATH in your shell config. The build is stamped, so `opencode --version` reports the release plus the mods, e.g. `1.18.31+vim-keys`.

`off` removes the launcher, so `opencode` falls through to the stock binary the harness installed. `on` restores it. Neither rebuilds anything. Pass `--no-path` if you would rather manage PATH yourself.

`uninstall` rebuilds without the mod. When the last mod for a harness goes, the launcher, the built binary and the patched commits go with it, and the checkout is reset to the stock release. It is kept only as a cache so the next install does not clone and install dependencies again; delete `~/.open-mods/harnesses/<id>` if you want the space back.

Several mods stack on the same checkout. If two of them edit the same lines, the second one fails to apply and nothing is built.

## When the harness updates

A mod is "for" one harness release, and that release is the mod's version. Harnesses move fast, so the registry follows them without waiting for anyone:

1. A job runs every hour and notices when a harness publishes a new release.
2. The stock harness is built once at that release, to prove the harness definition still works there. If it does not, every mod for it is held where it is until the definition is fixed.
3. Every mod for that harness is applied to the new release and typechecked, one job per mod. A typecheck is the compiler's front half: it verifies every name, type and signature the mod relies on, in minutes, without producing a binary. A full build per mod runs once, on its pull request.
4. A mod that passes gets its release moved forward in `mod.json`. That is the whole version bump; the mod's code did not change.
5. A mod that fails keeps its current release and gets a `status.json` saying which release it does not support. The listing shows it in yellow, and the bot opens an issue that mentions the mod's maintainers with the error and the steps to rebase.

Compiled dependencies are cached between runs, so a check starts from warm.

On your machine, the `opencode` command in `~/.open-mods/bin` is a small launcher. It starts your build immediately and, once a day, refreshes the registry in the background. When a newer release is supported by every mod you have installed, the next launch asks:

```
OpenCode v1.19.0 is out and all your mods support it (tetris, vim-keys). You are on v1.18.31.
Update now? It rebuilds OpenCode, which takes a few minutes. [y/N]
```

`y` rebuilds and launches the new build. Anything else launches your current build and asks again tomorrow. If one of your mods does not support the new release yet, it says so instead and you stay where you are. It never rebuilds on its own, never asks when `opencode` is not at a terminal, and `OPEN_MODS_NO_PROMPT=1` turns the question off.

## The site

`bun run site` builds the site into `site/` from the registry; `bun script/site.ts --local --out site` also includes your unpublished mods from `~/.open-mods/local` for a preview. The output is plain files, so any static host works. The included workflow publishes to GitHub Pages on every push to main; set the `SITE_DOMAIN` repository variable to the site's domain and point its DNS at GitHub Pages.

## Making a mod

```sh
git clone https://github.com/anomalyco/opencode && cd opencode
git checkout v1.18.31            # the release you want to mod
# ... change anything, then commit as many times as you like ...
open-mods pack . --name my-mod --local   # installable now from ~/.open-mods/local, not published
open-mods pack . --name my-mod           # writes mods/opencode/my-mod/ into the registry
open-mods check mods/opencode/my-mod --build
```

Then open a pull request. [CONTRIBUTING.md](CONTRIBUTING.md) has the details.

## Why patches and not forks

A fork is a snapshot. It goes stale silently, it can't be combined with another fork, and reviewing it means diffing two whole repositories. A patch series is small, readable on the listing page, applies to the release it names, and stacks with other patches until two of them disagree. It is the format Debian, Nix, and Homebrew have used for decades for exactly this problem.

## Security

A mod is code that runs with your permissions, like any program you build from source. Before installing one, read its patches. `open-mods info` lists the touched files, and each mod's page shows the diff. Nothing is prebuilt: your machine compiles the harness from its release plus the patches, so what you read is what you run. [SECURITY.md](SECURITY.md) has the details and how to report a problem.

## License

MIT. Each mod carries its own license in `mod.json`; each harness keeps its upstream license.
