# Terminal file links — follow-up improvements

This documents two improvements layered on top of the initial terminal
file-link feature (cmd/ctrl-click a file path in a shell to open it in the
viewer). The first — `:line:col` navigation — **ships with the initial
feature**; it's documented here so its edge cases and the second improvement
(cwd-aware resolution) live together. The second is **deferred** because doing
it well needs cross-platform main-process work; the notes below capture the
design so it can be picked up later.

## Current behaviour (baseline)

`installTerminalFileLinks` (`src/renderer/views/terminal-file-links.ts`)
registers an xterm link provider per terminal. Detection and resolution are
shared with the chat linker:

- **Detect** — `fileReferenceMatches` (`src/shared/fs/file-reference.ts`) finds
  path-shaped tokens in each row, including an optional `:line` / `:line:col`
  suffix.
- **Resolve** — candidates are sent to `api.index.resolveFileReferences`, which
  matches them against the workspace file index (exact path or unique
  basename). Only resolved paths become links, so arbitrary words never light
  up. Results are cached and kept warm from terminal output.
- **Activate** — cmd/ctrl-click calls `openWorkspaceFile(store, api, path,
reveal)`. Paths are resolved **relative to the workspace root** (the shell's
  starting cwd).

## 1. Line/column navigation (shipped)

Compilers, linters, grep and stack traces print `path:line` and
`path:line:col`. The matcher captures these as `match.line` / `match.column`,
the link text spans the whole `path:line:col`, and `openWorkspaceFile` carries
an optional `reveal: { line, column }` into `OpenFile`. The Monaco file viewer
(`src/renderer/views/context-panel.ts`) calls `revealLineInCenter` +
`setPosition`, once per distinct open so unrelated re-renders don't yank the
user's scroll. The same `reveal` flows from chat links, so
`see src/foo.ts:42` in an assistant message also jumps to line 42.

### Known limitations / possible refinements

- **No range selection.** We position the caret at `line:col` but don't select
  a range. Editors often print `path:line:col-line:col`; capturing the end of
  the range and calling `setSelection` would be a small extension to the
  matcher and the `reveal` shape.
- **Wide glyphs.** Cell offsets are treated as 1:1 with string offsets, so a
  CJK/emoji glyph earlier on the row shifts the underline by a cell. Paths are
  effectively ASCII, so this is cosmetic. A precise fix walks
  `IBufferLine.getCell` to map string index → cell `x`.
- **Wrapped paths.** Only the single buffer row under the cursor is scanned, so
  a path that soft-wraps at the right margin won't link. Handling it means
  reconstructing the logical line across `isWrapped` rows and mapping offsets
  back to per-row `(x, y)` — the approach `@xterm/addon-web-links` takes.

## 2. cwd-aware resolution (deferred)

### Problem

Links resolve relative to the **workspace root**, because that's where the
shell starts (`sessionCwd()` in `src/main/services/terminal-service.ts`). Once
the user `cd`s into a subdirectory and a command prints a path relative to the
_new_ cwd, resolution is wrong:

```
$ cd packages/app
$ npm test
  FAIL  src/button.test.ts          # actually packages/app/src/button.test.ts
```

`src/button.test.ts` either fails to resolve or, worse, resolves to a
same-named file elsewhere in the repo. The unique-basename fallback masks some
of this, but it's not correct.

### Why it isn't trivial

The renderer can't know the pty's cwd. Two ways to obtain it, both with costs:

1. **OSC 7 / shell integration.** Many shells can emit
   `ESC ] 7 ; file://host/path BEL` on each prompt, and VS Code-style shell
   integration emits cwd markers too. xterm can parse these via
   `parser.registerOscHandler(7, …)`. **But it's off by default** — it needs
   the user's shell rc (or an injected integration script) to emit it.
   Reliable only when we own the shell init.

2. **Query the OS by pid.** The main process owns the pty pid, so it can read
   the cwd directly: `/proc/<pid>/cwd` (Linux), `lsof -a -p <pid> -d cwd` or
   `proc_pidinfo` (macOS), and a separate path on Windows. Robust and shell
   independent, but platform-specific, needs a new IPC channel, and polling vs.
   on-demand has trade-offs.

### Proposed design

- Track per-session cwd in the main process, preferring OSC 7 when present and
  falling back to a pid-based lookup (`/proc/<pid>/cwd` on Linux, `lsof` on
  macOS) resolved on demand when a link is activated — cheaper than polling.
- Expose the current cwd to the renderer (extend the `terminal` IPC surface,
  or pass it through with output), and thread it into the link provider.
- Extend `resolveFileReferences` (or add a sibling) to accept a base directory:
  try `join(cwd, candidate)` against the index first, then fall back to the
  current root-relative + unique-basename behaviour.
- Keep the resolution cache keyed by `(cwd, candidate)` since the same token
  can mean different files in different directories.

### Effort / risk

Medium. The renderer plumbing is small; the cost is the cross-platform cwd
lookup and a new IPC path. Worth doing once users notice links breaking after
`cd`. Until then, root-relative resolution + unique-basename covers the common
case where commands are run from the repo root.
