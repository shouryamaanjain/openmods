# Codex CLI mods

Codex CLI (github.com/openai/codex, tags `rust-v0.x.y`) is a Rust workspace in `codex-rs/`, with the terminal UI in ratatui. Paths below are from rust-v0.160.0, relative to `codex-rs/`; check them against the release you mod.

## Contents
- Setup and checks
- Where things live
- Adding things
- Conventions the code enforces
- Built-ins (don't rebuild them)
- What not to touch
- Worked example: space-invaders

## Setup and checks

- **Rust:** `codex-rs/rust-toolchain.toml` pins the version (1.95.0 for rust-v0.160.0); rustup picks it up inside `codex-rs`. A build also needs a C compiler and Python 3.11+, plus `pkg-config` and the libcap and OpenSSL headers on Linux. `openmods` names what's missing.
- **Fast feedback** (from `codex-rs`):
  ```sh
  cargo check -p codex-tui          # or -p codex-core, -p codex-cli
  cargo run --bin codex -- --no-daemon
  ```
  `--no-daemon` matters for core and tool changes: without it the TUI can attach to a shared background server running stock code. Pure TUI changes don't care.
- **Tests:** `just test -p codex-tui` (cargo-nextest; `cargo install --locked cargo-nextest`). The repo asks not to use plain `cargo test`.
- **Snapshots:** UI changes need insta snapshots. Run the tests, then `cargo insta pending-snapshots -p codex-tui`, review with `cargo insta show`, and `cargo insta accept -p codex-tui`. Commit the `.snap` files your change legitimately alters. Adding a slash command changes `bottom_pane/snapshots/codex_tui__bottom_pane__command_popup__tests__command_popup_default_items.snap`.
- **Format and lint:** `just fmt`, and `just fix -p codex-tui` (clippy).
- `openmods dev` works for Codex, but rebuilds the package on each start, so `cargo run` is quicker while iterating.
- A full Codex build takes 15–45 minutes the first time. CI only typechecks Codex mods, so run `openmods check … --build` once before the PR.

## Where things live

| Folder (crate `codex-<folder>`) | What it is |
|---|---|
| `tui/` | The interactive UI. Almost every UI mod lives here. |
| `cli/` | The `codex` binary and its subcommands (`cli/src/main.rs`). |
| `core/` | The agent loop, sessions, tool registry (`core/src/tools/`). The repo asks to keep additions here small. |
| `tools/` | `ToolExecutor`, `ToolSpec`. |
| `config/` | `config.toml` types: `config_toml.rs`, `types.rs` (`Tui`), `tui_keymap.rs`. |
| `features/` | Feature flags (`Feature`, `FEATURES`), which drive `/experimental`. |
| `ext/*` | Extension crates built on `ext/extension-api` (`ToolContributor`, `ContextContributor`). |

The repo also asks to put new code in new modules and keep `chatwidget.rs`, `bottom_pane/mod.rs`, `chat_composer.rs` and `app.rs` small. That's exactly what keeps a mod's patch small.

## Adding things

### A slash command
1. `tui/src/slash_command.rs`: add a variant to `enum SlashCommand`. Order is display order ("DO NOT ALPHA-SORT!"); names are kebab-case via strum; aliases with `#[strum(to_string = "mything", serialize = "mt")]`. The compiler then makes you fill in `description()` and `available_during_task()`.
2. `tui/src/chatwidget/slash_dispatch.rs`: the handler arm in `dispatch_command_from_source()`, and an arm in `queued_command_drain_result()` (`QueueDrain::Stop` or `Continue`). For arguments, an arm in `dispatch_prepared_command_with_args()`.
3. Optionally `tui/src/bottom_pane/chat_composer.rs` `parent_owned_command_is_allowed()` (while viewing a child thread).
4. Accept the changed command-popup snapshot.

```rust
SlashCommand::MyThing => {
    self.bottom_pane.show_view(Box::new(crate::bottom_pane::MyThingView::new()));
}
```

### A bottom-pane view (the area where the input box is)
Implement `BottomPaneView` (and `Renderable`) from `tui/src/bottom_pane/bottom_pane_view.rs` in a new file: `handle_key_event`, `on_ctrl_c` (also Esc), `is_complete`, and for animation `pre_draw_tick(now)` and `next_frame_delay()`. Open it with `self.bottom_pane.show_view(Box::new(…))`; it replaces the composer until `is_complete()`. Register the module in `bottom_pane/mod.rs`.

- A list picker: `show_selection_view(SelectionViewParams { title, items: vec![SelectionItem { … }], .. })` (copy `/archive` in `slash_dispatch.rs`).
- A full-screen pager: `Overlay::new_static_with_lines(...)` in `tui/src/pager_overlay.rs` (see `/diff`).
- A message in the transcript: `self.add_info_message(..)`.
- Talking from a view to the app: an `AppEvent` variant (`tui/src/app_event.rs`) handled in `app/event_dispatch.rs`.

### A keybinding
The configurable way (follow `toggle_vim_mode` through these files):
1. `config/src/tui_keymap.rs`: a field on `TuiGlobalKeymap` (or the chat/composer keymap).
2. `tui/src/keymap.rs`: the `AppKeymap` field, `resolve_bindings(...)`, the default in `built_in_defaults()`, and the conflict-check lists.
3. `tui/src/keymap/bindings.rs`: the `define_runtime_action_bindings!` entry.
4. `tui/src/keymap_setup/actions.rs` and `picker.rs`, so it shows in `/keymap`.
5. Handle it in `handle_shared_app_keymap_action()` in `tui/src/app/input.rs`.
6. `just write-config-schema` (updates `core/config.schema.json`; a test fails if it drifts).

That's many files. For a mod, a hard-coded key check in `handle_shared_app_keymap_action` is a far smaller patch.

### A status line item
`StatusLineItem` in `tui/src/bottom_pane/status_line_setup.rs` (plus its preview in `status_surface_preview.rs` and accent in `status_line_style.rs`), and its value in `status_line_value()` in `tui/src/chatwidget/status_surfaces.rs`. Users then add it to `tui.status_line = [...]`.

### A CLI subcommand
In `cli/src/main.rs`: a variant on `enum Subcommand` (its `///` comment is the help), the arm in the main `match subcommand`, and an arm in `unsupported_subcommand_name_for_strict_config()`. Help-output snapshots are in `cli/src/snapshots/`.

### A tool the model can call
Copy `core/src/tools/handlers/current_time.rs`; add it to `core/src/tools/handlers/mod.rs` and register it with `registry.add(MyHandler)` in `add_core_utility_tools()` in `core/src/tools/spec_plan.rs`, usually behind a `Feature` flag (`features/src/lib.rs`). The tool's spec description is what the model sees. Outside core, an `ext/` crate implementing `ToolContributor`, installed in `app-server/src/extensions.rs`, keeps the patch out of core. Test core changes with `--no-daemon`.

### A config key
A field on `ConfigToml` (`config/src/config_toml.rs`) or `Tui` (`config/src/types.rs`), copied onto `Config` in `core/src/config/mod.rs`, then `just write-config-schema`. Prefix mod keys so they can't collide with a future upstream key.

### The system prompt
Base instructions come from `config.base_instructions` (`instructions` / `model_instructions_file`), else the per-model template in `models-manager/models.json` (fallback `models-manager/prompt.md`). The catalog is refreshed from the server and cached, so editing the bundled JSON may not stick. Users can already set `developer_instructions` and use AGENTS.md without a mod. A mod that changes what the agent is told must say so under Permissions.

## Conventions the code enforces

- Clippy denies `unwrap()`, `expect()`, `print!`/`eprint!` in the TUI, and `Color::Rgb`/`Color::Indexed`; use ratatui's `Stylize` helpers (`"x".dim()`, `.cyan()`).
- One `use` per line (`imports_granularity = "Item"`).
- Tests in sibling `*_tests.rs` files: `#[cfg(test)] #[path = "x_tests.rs"] mod tests;`.
- `/*param*/` comments before bare literal arguments; no wildcard match arms.
- If you add `include_str!`, update the crate's `BUILD.bazel`.

## Built-ins (don't rebuild them)

`/vim` and vim mode, `/keymap` (remap keys in the UI), `/statusline`, `/title`, `/theme`, `/pets`, `/side` and `/btw`, `/experimental`, `/hooks`, `/skills`, `/plugins`, `/mcp`, `/memories`, `/goal`, `/plan`, `/agents`, `/review`, `/diff`, `/copy`, `/export`, `/compact`, `/usage`. Prompt control without code: `developer_instructions`, `model_instructions_file`, AGENTS.md.

## What not to touch

- **The shared background server** (`codex app-server`, the daemon under `~/.codex/packages/app-server-daemon`). Stock Codex owns it; modded Codex runs with `--no-daemon`, and OpenMods sends `codex agents`, `--remote`, `app-server`, `remote-control`, `queue`, `update`, `archive`, `unarchive` and `delete` to stock Codex. A mod that needs those commands to run modded code won't get that.
- **`Cargo.lock` and dependencies**, unless the feature truly needs a crate.
- **Large shared files** beyond a hook line (`chatwidget.rs`, `bottom_pane/mod.rs`, `app.rs`): every mod touches them, so every extra line there risks overlapping another mod.

## Worked example: space-invaders

`mods/shouryamaanjain/space-invaders/codex/` in the registry: one patch, 11 files, all in `codex-tui`.

- New: `tui/src/bottom_pane/invaders_game.rs` (game logic, no UI), `invaders_view.rs` (`InvadersView: BottomPaneView`), `invaders_tests.rs` and two snapshots.
- `slash_command.rs`: the `Invaders` variant (`#[strum(to_string = "invaders", serialize = "space-invaders")]`), its description, and `available_during_task => true`.
- `chatwidget/slash_dispatch.rs`: `show_view(Box::new(InvadersView::new()))` and `QueueDrain::Stop`.
- `bottom_pane/chat_composer.rs`: one line in the parent-owned list.
- `bottom_pane/mod.rs`: the module lines, and a render branch that keeps the "Working" status line above the view; `bottom_pane_view.rs` gains a default `keeps_status_visible()` method for it.
- The command-popup snapshot gains `/invaders`.

The view animates with `pre_draw_tick` and `next_frame_delay` (only while running), takes ←/→/space/p in `handle_key_event`, and saves the game on Esc/Ctrl-C in `on_ctrl_c` so `/invaders` resumes it. It's the smallest complete recipe for "a slash command that opens a bottom-pane view".
