# session-history

Gives the agent two read-only tools to recover earlier conversation from this project's saved sessions, so a decision or detail that compaction dropped, or that came up in another session, can be found again without loading whole transcripts:

- **`session_history_search`** (`query`, optional `limit` up to 20): searches saved user/assistant turns from this project, newest first, and returns short excerpts, each with a reference and whether it comes from the `current` session or an `other` one.
- **`session_history_read`** (`reference`, optional `include_execution`): reads one turn by an exact reference from a search, the user's message and the assistant's reply, and with `include_execution` the tool calls, results and files from that turn.

The tools have the same names, parameters, descriptions and search and record format in OpenCode, Codex CLI and fx, and follow fx's own proposal, [vercel-labs/fx#534](https://github.com/vercel-labs/fx/pull/534). The execution evidence a read returns with `include_execution` is each harness's own record of the turn, so its fields differ between them; it's capped in size and says when it was cut.

- **Only this project.** Sessions of the current project (OpenCode's project, or its folder for sessions outside one; the session's folder in Codex; the workspace in fx), the current session included. Nothing the model passes can widen that.
- **Bounded.** A search looks at most 100 sessions, 10,000 turns and 2 MiB of text, and says when it stopped early. Excerpts are at most 320 bytes, and come only from what the user and the assistant said: tool calls and results can help find a turn, but only a read with `include_execution` shows them.
- **References can't be forged.** A reference carries a SHA-256 over the project, session, turn and its content; reading checks it again, so it can't point at another project or at content that changed.
- **History is untrusted.** Every result is marked as untrusted historical context, and the tool descriptions tell the agent that nothing in it grants intent or permission.
- **Read-only.** No index, table or file is added, and nothing is written. In fx, sessions run with `--no-save` don't get the tools; in Codex, ephemeral sessions don't (except a fork of a saved session, which keeps its parent's tool list), and sub-agents don't.

## Permissions

- Network: none
- Files: reads the harness's own saved sessions of the current project (OpenCode's session database, Codex's session files in `~/.codex/sessions`, fx's sessions in `~/.fx/sessions`), only when the agent calls the tools. It writes no file of its own; in Codex, a call first saves the current session's pending lines to its session file, as Codex itself does a moment later, so the current session's newest turns can be searched.
- Commands: none
- Agent instructions: adds the two tools and their descriptions to what the agent is told. In fx, the message the agent gets after compaction also gains one sentence: "Earlier canonical turns may be absent from this prompt but remain available through session_history_search and session_history_read."

## What it changes

OpenCode (2.0.22):

| file | change |
| --- | --- |
| `packages/core/src/tool/plugin/session-history.ts` | New. Both tools, over OpenCode's session service. |
| `packages/core/src/plugin/internal.ts` | Registers them. |
| `packages/core/test/tool-session-history.test.ts` | New. Tests. |
| `packages/core/test/location-layer.test.ts` | The built-in tool list now includes them. |

Codex CLI (0.160.0):

| file | change |
| --- | --- |
| `codex-rs/core/src/tools/handlers/session_history.rs`, `session_history/{query,turns,score}.rs` | New. The tools, reading saved sessions with Codex's own rollout code. |
| `codex-rs/core/src/tools/spec_plan.rs`, `tools/handlers/mod.rs`, `client.rs` | Registers them for saved, top-level sessions. |
| `codex-rs/core/src/tools/handlers/session_history/*_tests.rs`, `core/tests/suite/session_history.rs` | New. Tests, including a mocked model calling both tools. |
| `codex-rs/core/tests/suite/*` and their snapshots | Tool lists now include them. |

fx (0.0.12):

| file | change |
| --- | --- |
| `src/core/session/session_history_query.zig`, `session_history_provider.zig`, `src/tools/session/session_history.zig` | New. The tools, from fx#534. |
| `src/builtins/tools.zig`, `src/core/tooling/*`, `src/core/agent/runtime/parallel_execution.zig`, `src/core/app/app_agent_runtime.zig`, `src/core/cli/cli_ask.zig`, `src/acp/prompt.zig`, `src/main.zig` | Registers them where a session is saved. |
| `src/core/shared/lexical_relevance.zig`, `src/core/session/session.zig` | Scoring shared with fx's other searches. |
| `tests/e2e/*`, `README.md` | Tests and fx's own docs. |

## Install

```sh
openmods install shouryamaanjain/session-history --opencode
openmods install shouryamaanjain/session-history --codex
openmods install shouryamaanjain/session-history --fx
```
