# space-invaders

Adds a `/invaders` slash command (also `/space-invaders`) that opens Space Invaders while the agent keeps working.

- **OpenCode:** the game takes the right half of the session screen, in place of the sidebar. The conversation keeps the left half, and its messages rewrap to fit.
- **Codex CLI:** the game opens in the bottom pane, in place of the input box. The conversation keeps going above it, and the status line that shows what Codex is doing stays just above the game. Codex prints the conversation into your terminal's scrollback, so the game cannot sit beside it.

## How to play

| key | while the game is open |
| --- | --- |
| `←` `→` | move |
| `space` | fire (hold it to keep firing), or play again after game over |
| `p` | pause and resume |
| `esc` | close the game (`ctrl-c` too, in Codex); it pauses, and `/invaders` brings it back where it left off |

Five rows of invaders march across and down, faster as they thin out, and drop bombs. You can have three shots in the air at once. A mystery ship crosses the top now and then for bonus points. You start with three lives and earn another every 1500 points, up to five; clear a wave and the next starts lower. The field fits the space it gets, and starts the current wave again if you resize the terminal.

While the game is open it has the keyboard, so playing never types into your prompt. In OpenCode the prompt stays in view; in Codex the input box comes back when you close the game.

## Permissions

- Network: none
- Files: none
- Commands: none
- Agent instructions: unchanged

## What it changes

OpenCode:

| file | change |
| --- | --- |
| `packages/tui/src/component/invaders.tsx` | New. The game and its panel. |
| `packages/tui/src/app.tsx` | Registers the `/invaders` command. |
| `packages/tui/src/routes/session/index.tsx` | Gives the right half of the session screen to the game while it is open. |

Codex CLI:

| file | change |
| --- | --- |
| `codex-rs/tui/src/bottom_pane/invaders_game.rs` | New. The game. |
| `codex-rs/tui/src/bottom_pane/invaders_view.rs` | New. Draws the game in the bottom pane and takes its keys. |
| `codex-rs/tui/src/bottom_pane/invaders_tests.rs` and two `snapshots/…invaders…` files | New. Tests. |
| `codex-rs/tui/src/bottom_pane/bottom_pane_view.rs`, `bottom_pane/mod.rs` | Lets a view keep the status line above it. |
| `codex-rs/tui/src/slash_command.rs`, `chatwidget/slash_dispatch.rs`, `bottom_pane/chat_composer.rs` | Registers `/invaders`, available while Codex works. |
| `codex-rs/tui/src/bottom_pane/snapshots/…command_popup_default_items.snap` | The command list now includes `/invaders`. |

## Install

```sh
openmods install shouryamaanjain/space-invaders --opencode
openmods install shouryamaanjain/space-invaders --codex
```
