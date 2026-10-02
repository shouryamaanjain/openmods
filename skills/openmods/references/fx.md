# fx mods

fx (github.com/vercel-labs/fx, tags `vX.Y.Z`) is Vercel's coding agent in Zig 0.16, with an inline, shell-like terminal UI. Paths below are from v0.0.12; check them against the release you mod. The repo's `AGENTS.md` and `CONTRIBUTING.md` have its own rules.

Ignore the older pre-launch tags `v0.3.73` and `v0.4.x`: they sort above the real releases. Take GitHub's "Latest" release.

## Contents
- Setup and checks
- Where things live
- Adding things
- What not to touch (shared with stock fx)
- Why fx mods conflict easily

## Setup and checks

- **Zig:** exactly the version in `build.zig.zon` (`minimum_zig_version = "0.16.0"`; fx's CI pins it). `openmods dev` and builds fetch it into `~/.openmods/toolchains`; to get it before you have a mod, run `openmods check --harness fx --ref <tag> --typecheck` once. Then use `~/.openmods/toolchains/zig-0.16.0/bin/zig` (with `ZIG_GLOBAL_CACHE_DIR=~/.openmods/cache/zig` to share OpenMods' cache), or install 0.16.0 from ziglang.org. An older Zig (Homebrew's, say) won't build fx.
- **Build and run:**
  ```sh
  zig build -Doptimize=Debug          # binary in ./zig-out/bin/fx
  zig build run -- <args>
  ```
  Run `./zig-out/bin/fx`, not bare `fx` (which is your stock or modded install).
- **Tests:** `zig build test` runs the whole suite (about 3 minutes); `build.zig` has no filter. A self-contained new file's tests run alone with `zig test -lc <file>`. Unit tests live inside each source file, and a new file's tests only run in the suite if you add it to the `test { _ = @import(...) }` block near the end of `src/main.zig`.
- **A few tests can fail on stock fx** on some machines: on macOS, shell tests pick up Apple Terminal's "Saving session…" (run them with `env -u TERM_PROGRAM -u TERM_SESSION_ID SHELL_SESSIONS_DISABLE=1`), and one OSC 8 test fails on v0.0.12. Run the suite on the stock tag too (`git stash`) and compare before chasing a failure.
- **Format:** `zig fmt src/` (CI runs `zig fmt --check src/`).
- What fx's own CI checks, worth mirroring: `zig fmt --check`, `zig build -Doptimize=ReleaseSafe`, `zig build test`, and `./scripts/check-public-surface.sh` (fails on `/Users/<name>/` paths and internal ids in tracked files, so keep them out of your patch).
- OpenMods' typecheck for fx is a Debug build (about 30 s warm); the release build takes a few minutes and up to about 3 GB of memory.

## Where things live

| Path | What it is |
|---|---|
| `src/main.zig` | Composition root and the test import list. No feature logic. |
| `src/builtins/` | The product tables: `commands.zig` (CLI and slash specs), `tools.zig`, `hooks.zig`, `skills.zig`, `providers.zig`, `context.zig` (embeds `system_prompt.md`). |
| `src/core/` | Runtimes: `app/` (including `app_commands.zig`, `app_input_runtime.zig`, `app_render_runtime.zig`), `cli/`, `slash_commands/`, `config/`, `session/`, `tooling/`, `agent/`, `terminal/`, `shared/` (`theme.zig`, `profile_paths.zig`). |
| `src/ui/` | The inline renderer: `render.zig` (status line), `footer/` (composer, hint row, menus), `input/` (keys, `visual_layout.zig`), `render_engine/`. |
| `src/tools/` | Tool implementations. |
| `src/gateway/` | Model providers. |

Every extension point is a compile-time table or switch; there is no plugin system.

## Adding things

### A slash command (five places)
1. `src/core/slash_commands/command_specs.zig`: a value on `SlashKind`.
2. `src/builtins/commands.zig`: a spec in `slash_specs`:
   ```zig
   .{ .kind = .mything, .command = "/mything", .help_entry = "/mything", .completion_description = "do my thing", .presentation_category = .general },
   ```
   (`.has_args = true, .accepts_payload = true` for arguments.)
3. `src/core/slash_commands/command_router.zig`: a `ParsedCommand` variant, a case in `parsedCommand()`, a pointer in `CommandHandlers`, and a case in `route()`.
4. `src/core/app/app_commands.zig`: wire it in `commandHandlers()` and write the handler:
   ```zig
   fn commandMyThing(ctx: *anyopaque) !void {
       const app: *App = @ptrCast(@alignCast(ctx));
       try app.writeDomainNotice(.{ .topic = "mything", .tone = .neutral, .body = "hello" }, true);
   }
   ```
5. Update the tests that pin the command list: "built-in slash commands register exact active order" (`src/builtins/commands.zig`), "help catalog groups visible commands…" (`src/core/slash_commands/command_specs.zig`, which counts all commands and those per category), and "slash main page renders header…" (`src/ui/resize_tests.zig`, which expects "Commands <n> · type to filter"). Keep the handler itself in a new file (it can be generic over `App`), so `app_commands.zig` gets only an import and the wiring.

### A keybinding
Keys are hard-coded. App-level actions: a variant on `Action` (`src/core/input/input_action.zig`), mapped in `src/ui/input/escape_parser.zig` (`controlByteFeatureAction`), handled in `routeResolvedEscapeAction` (`src/core/app/app_input_runtime.zig`). Composer edits: `fromControlByte()` in `src/ui/input/shortcuts.zig`. Check that the key isn't already taken.

### UI elements
- **Status line:** `StatuslineItems` (`src/ui/render.zig`), filled in `buildStatuslineItems` (`src/core/app/app_render_runtime.zig`); segments are appended in `appendSessionStatusSegments`.
- **Prompt prefix:** `inputPrefix` in `src/ui/input/visual_layout.zig`; keep `cell_width` exact, the cursor math depends on it.
- **A small inline menu or panel:** follow the compact-menu pattern: a variant on `CompactCommandMenuProjection` (`src/ui/footer/render_input.zig`), rows in `compact_command_menu_presentation.zig`, state through `RenderContext`. A full-screen surface goes through `AlternateScreenOwner` (`src/ui/shell_runtime.zig`).
- **A notice in the transcript:** `app.writeDomainNotice(.{ .topic, .tone, .body }, true)`.

### A tool the agent can call
1. The implementation in `src/tools/<area>/<name>.zig`, exporting `decode`, `validate`, `call`, `readsOnly` and `isIrreversible` (signatures in `src/core/tooling/tool_dispatch.zig`).
2. A `ToolSpec` in `src/builtins/tools.zig` (copy `glob_files`), added to `all` and `advertisement_order` (and `read_only_tool_names` if it only reads).
3. Update the pinned tests, including "built-in model-facing tool contract stays byte exact", which hashes every tool schema: any tool change changes that hash.
4. Anything sensitive goes through `src/core/permissions/permissions.zig`. Disclose it under Permissions.

### Lifecycle hooks
`PreToolUse`, `Stop`, `PostTurnEnd` and `AttentionRequired` (`src/core/hooks/`); register like `src/builtins/hooks.zig`. Each surface registers separately (interactive in `src/main.zig`, `fx ask` in `src/core/cli/cli_ask.zig`, ACP in `src/acp/server.zig`).

### A CLI subcommand
A `TopLevelKind` value (`command_specs.zig`), a `TopLevelSpec` in `src/builtins/commands.zig`, and in `src/core/cli/cli_surface.zig` a `Command` variant, a branch in `parse()` and a dispatch arm (copy `.replay`). Text and `--json` output come from one snapshot in `src/core/output/output_contracts.zig`.

### A theme or setting
- Themes need no mod: `~/.fx/themes/<name>.json`, picked with `FX_THEME` or the `theme` setting. To build one in: a `Theme` const in `src/core/shared/theme.zig`.
- A setting: a field on `Settings` (`src/core/config/config_runtime.zig`), parsed in `parseSettingsJson`, merged, and (if writable) in `settings_store.zig`. Stock fx ignores unknown keys, but prefix mod keys (`mod_…`) so a future upstream key of another type can't clash.

## What not to touch (shared with stock fx)

Users keep stock fx next to the modded one, and fx has no switch to separate them:

- **Everything in `~/.fx`** (settings, logins, sessions, history, skills, themes) is shared.
- **Session files are strict.** Stock fx rejects a session manifest with any extra key and an event it doesn't know (`src/core/session/`). Never add fields or event types to session files; keep a mod's state in its own file.
- **The background terminal host** (`src/core/terminal/`, socket under `~/.fx/terminal-host-v7`) runs the shell tool's sessions, and whichever fx binary starts it serves both stock and modded fx while it lives. A mod that changes host-side code changes stock fx's behavior too, and one that changes the wire protocol breaks the other binary. Leave it alone unless the mod is about it, and then say so plainly in the README.
- **Auto-upgrade:** OpenMods runs modded fx with `FX_AUTO_UPGRADE=0` and sends `fx upgrade` to stock fx. Don't change the upgrader; a mod that turned it back on would replace itself with stock.

## Why fx mods conflict easily

Almost every fx feature touches the same few files: `command_specs.zig`, `command_router.zig`, `app_commands.zig`, `builtins/commands.zig`, `builtins/tools.zig`, `main.zig`, plus pinned tests (command order and counts, tool order, the tool-schema hash). OpenMods refuses two mods whose patches change the same or adjacent lines, so:

- insert each registration next to an entry it's related to, not at the start or end of a table, where every mod would insert and so overlap (insertions at the same spot count as the same lines);
- keep the feature itself in new files;
- don't reformat neighbouring lines.

Two fx mods that each add a slash command still collide on the pinned command counts and order tests, so they can't be installed together on the same release: publishing the first doesn't remove that overlap. Say so in the README (and list the other mod under `conflicts` if you know of it).
