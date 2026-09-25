# The OpenMods base patch

OpenMods applies this patch first in every modded build. Users do not install or remove it, and it is not listed as a mod.

A modded harness still looks like the harness it came from, including the places where it tells people how to report a problem. Without this patch, a crash caused by a mod would open a bug report on the upstream project, and the agent would send feedback there too. The upstream maintainers did not ship the mods, so those reports belong with OpenMods first.

## What it changes

- **OpenCode:** the system prompts' feedback line and the crash screen. Users are asked to check with `openmods off` whether the stock build has the same problem: if it does, they report it to OpenCode; if not, to OpenMods. The crash report opens an OpenMods issue, with the version, which names the mods.
- **Codex CLI:** `/feedback` explains that this is a modded build and where to report instead of uploading logs to OpenAI. Codex's own update notice and prompt are off: they point to the stock install, while a modded build moves to a new release when OpenMods rebuilds it. From Codex 0.156.1, which added a shared background server, a modded build also runs without it, as `--no-daemon` does, so the server stays stock Codex's; only `codex agents` and `--remote`, which need a server, still use one.

## Permissions

- Network: none added. The crash screen links to OpenMods' issue page instead of OpenCode's.
- Files: none
- Commands: none
- Agent instructions: the feedback line in OpenCode's system prompts now points to OpenMods for problems that do not happen in stock OpenCode.
