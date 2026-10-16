# Main-process synchronous read audit

Copse's Electron main process currently contains **39** `readFileSync` call sites in **24**
production files. This register makes that debt explicit and shrink-only: the unit invariant in
[`scripts/main-sync-read-invariants.test.ts`](../scripts/main-sync-read-invariants.test.ts) rejects a
new call, a new file, an aliased import that could evade counting, or a stale baseline after a call is
removed.

The baseline is not an endorsement. Synchronous disk I/O blocks Electron's main event loop, so new
code must use asynchronous I/O. Existing reads remain temporarily where converting a single call
would require changing a synchronous store or security contract rather than merely swapping APIs.

## Audit result

| Class                                             | Calls | Disposition                                                                                                            |
| ------------------------------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------- |
| Short-lived startup, worker, or preparation paths |    18 | Bounded and outside steady-state interaction. Keep last in the migration order, but retain size/input bounds.          |
| Serialized durable stores                         |    14 | Preserve their single-writer and fail-closed semantics while moving the store contract to async I/O.                   |
| Interactive/configuration reads                   |     7 | Highest priority: provider/SSH/Git configuration, attachments, and served assets can run while the app is interactive. |

The exact per-file counts and reasons live beside the executable baseline so code review cannot let
the prose and enforcement diverge. The largest concentrations are container lifecycle code (nine
calls across its host/worker files), knowledge storage (five), supervisor stores (four), and Git
security helpers (four).

## Migration order

1. Convert interactive configuration and attachment reads where the surrounding API is already
   asynchronous. These offer the clearest responsiveness win with the smallest ordering risk.
2. Move the knowledge, supervisor, approval, and roadmap stores behind async read contracts one store
   at a time. Keep serialization, atomic replacement, schema decoding, and fail-closed corruption
   behavior intact.
3. Convert preparation and container-host reads when their lifecycle APIs next change. Do not move a
   blocking read into a promise callback and call that an async migration; the filesystem operation
   itself must use `node:fs/promises` or an isolated worker.
4. Leave truly one-shot, bounded worker/bootstrap reads until last. They still count as debt and the
   ratchet prevents their pattern spreading back into interactive code.

When a call is removed, lower or delete its baseline entry and update the totals above in the same
change. The invariant intentionally fails on improvements until that bookkeeping is done.
