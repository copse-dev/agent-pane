# copse-remote-watcher

The streaming file watcher Copse uploads to an SSH workspace host so external
edits (a `git pull` in a remote terminal, another editor) surface live instead
of on the polling floor. Client counterpart: `src/main/services/ssh-workspace/remote-native-watcher.ts`.

## Protocol (NDJSON over stdio, protocol 1)

One JSON object per line. Commands arrive on stdin, events leave on stdout.

Commands:

| command | shape                                                                                  |
| ------- | -------------------------------------------------------------------------------------- |
| watch   | `{"op":"watch","path":"/abs/file"}` — non-recursive; `"recursive":true` watches a tree |
| unwatch | `{"op":"unwatch","path":"/abs/file"}`                                                  |
| ping    | `{"op":"ping"}`                                                                        |

Events:

| event        | shape                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------- |
| ready        | `{"event":"ready","protocol":1,"version":"0.1.0"}` — first line after start                        |
| watching     | `{"event":"watching","path":…,"backend":"native"\|"poll"}` — ack per watch                         |
| watch-failed | `{"event":"watch-failed","path":…}` — both backends refused; the client must poll this path itself |
| change       | `{"event":"change","path":…,"kind":"create"\|"modify"\|"remove"\|"other","size":123\|null}`        |
| error        | `{"event":"error","message":…}`                                                                    |
| pong         | `{"event":"pong"}`                                                                                 |

## Contracts

- **Exits on stdin EOF, immediately.** A closed SSH channel always delivers
  EOF; nothing else is guaranteed to arrive (sshd sessions can survive a
  dropped connection). This is what keeps watcher processes from accumulating
  on shared hosts.
- Non-recursive subscriptions watch the **parent directory** and filter, so
  write-temp-then-rename saves (vim, VS Code) keep reporting after the first
  replacement.
- Platform-native watching (inotify/FSEvents/kqueue) first; per-path fallback
  to an in-process polling backend when registration fails (e.g.
  `fs.inotify.max_user_watches`); `watch-failed` only when both refuse.
- The client accepts GNU `base64 -d` and BSD/macOS `base64 -D` when installing
  the binary, then verifies the uploaded SHA-256 before executing it.

## Building

Built by `.github/workflows/remote-watcher-build.yml` for
`{x86_64,aarch64}-unknown-linux-musl` and `{aarch64,x86_64}-apple-darwin`.
The macOS release workflow invokes that build, verifies its combined checksum
manifest, and packages all four targets so the helper matches the remote host,
not the desktop architecture.
Locally, `pnpm run build:remote-watcher` builds for the current host and stages
the result under `vendor/remote-watcher/<target>/`, where `scripts/build.mts`
picks it up.
