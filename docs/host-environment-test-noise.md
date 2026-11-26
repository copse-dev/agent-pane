# Host-environment test noise

Some `npm test` / `pnpm run check` failures come from the local agent sandbox, not from your diff.
They reproduce on an unmodified checkout and the exact set varies run to run, so neither "N
failures" nor a single clean run proves anything about a change on its own. This page is a triage
procedure, not a fixed allowlist — the failing set shifts as the sandbox and host environment
change, and a fully clean run (0 failures) is achievable after a fresh install, so don't treat the
signatures below as a floor to expect every time.

## Known noise signatures

Main-process and `scripts/` suites only; renderer/settings tests are unaffected.

- **Sandbox blocks `/tmp`** (`EPERM: mkdir '/tmp/...'`) — SSH workspace, workspace-index-watcher,
  and subprocess-kill tests that shell out or watch real paths.
- **Sandbox blocks loopback TCP** (`EPERM: listen 127.0.0.1`) — any fixture that binds a real local
  HTTP/TCP server: streamed-provider retry tests, VNC/SSH-forward discovery tests, MCP OAuth
  sign-in tests (these additionally hang to their full timeout waiting on a redirect that never
  arrives).
- **macOS `/tmp` → `/private/tmp` realpath** — workspace-fs, video-attachment-store, and
  static-preview-server tests that assert on a literal `/tmp/...` path.
- **2s hook-dispatch timeouts under suite load** — tests under `src/main/services/hooks/`; both
  which file and which test inside it fails varies run to run.
- **fd exhaustion in fs watchers** (`EMFILE: too many open files, watch`) — execution-root-watcher;
  a host `ulimit -n` ceiling, reproduces in isolation too.
- **A worktree with no `node_modules` of its own** — ACP conformance/adapter tests resolve an SDK
  example path from `process.cwd()`; a `pnpm install` in the worktree clears these.
- **SSH commit-signing tests** — fail with `could not create temporary file` when the host signing
  key/agent isn't set up the way the fixture expects.
- **Root Linux containers** (`apply-seccomp: write /proc/self/uid_map: Operation not permitted`)
  — every real-sandbox test under `src/main/project-sandbox/` when run as root with `bwrap`
  installed. `pnpm test` re-executes as an ordinary user to avoid it; seeing it means the run was
  forced to stay root (`COPSE_ROOT_USERNS=0`) or `unshare -U` is unavailable. See
  [Claude Code cloud sessions](agent-development.md#claude-code-cloud-sessions).
- **GNU-only `stat -c`** — `screenshot-publication.test.ts` fails on macOS
  (`stat: illegal option -- c`).

These macOS host differences fail on every run on an affected Mac, in isolation too. Required CI
runs on Linux, so it never sees them. A local `pnpm test` recognises them: its closing summary lists
every failed test and marks each one that matches an entry in `scripts/lib/host-differences.mts` by
platform, file, test name and error shape. They still fail the run. The advisory
[`macos-unit.yml`](../.github/workflows/macos-unit.yml) workflow runs the suite on a hosted macOS
runner and reads the same summary: it warns about a failure that matches an entry and fails on any
other. When you add a deterministic host difference here, add it there too.

- **macOS `/bin/bash` 3.2** — `ci-workflow-invariants.test.ts` "compares the synthetic checked-out
  protocol against the supplied queue base" runs a `ci.yml` step under `set -u`; bash 3.2 treats an
  empty `"${array[@]}"` as unset (`exclude_head[@]: unbound variable`).
- **`/var` is a symlink** — `screenshot-review.test.ts` (the "screenshot review packets" suite, six
  tests) fails with `Unsafe review directory: /var`. The review CLI refuses any symlinked ancestor of
  its output directory, and macOS `tmpdir()` sits under `/var/folders/…` (`/var` → `private/var`).
- **LibreSSL as `openssl`** — `mobile-certificate.test.ts` "issues an IP-only P-256 server leaf under
  a name-constrained root" expects OpenSSL's `permitted subtree violation`; macOS `/usr/bin/openssl`
  is LibreSSL, whose `openssl verify` rejects the certificate with different wording.
- **System Python 3.9's bundled pip** — `worktree-preparation-python.test.ts` "installs a real
  hash-locked wheel through pip without running source builds" fails preparation validation
  (`Hash-locked Python dependencies: .venv/bin/python failed (2): Usage:`). A venv made by macOS
  `/usr/bin/python3` (3.9.6) gets pip 21.2.4, which predates `pip install --dry-run` (pip 22.2).

## Triage procedure

1. Capture the full log (`npm test > "$TMPDIR/check.log" 2>&1`, not piped through `tail`, which cuts
   the pass/fail totals) and list failing files, not just a count. A local run ends with that list
   (`[run-tests] N tests failed.`), with the known macOS host differences above already marked; the
   rest of this procedure is for the ones under "Need triage".
2. Re-run the same files on a clean checkout (stash the diff, or diff against `HEAD`) in a worktree
   that has had its own `pnpm install`. If the same files fail with the same error shapes there too,
   they are host noise, not your diff.
3. For a file that only fails intermittently, re-run it a few times with the diff applied before
   concluding it is yours — some of the above (hook-dispatch timeouts, spawned-child races) pass
   most runs even on an affected host.
4. A failure outside the signatures above, or one that reproduces with your diff but not without it,
   is a real regression — fix it, don't wave it through.

## Applying this to the mandatory full-check gate

[`AGENTS.md`](../AGENTS.md#before-committing) and
[`testing-strategy.md`](testing-strategy.md#choose-the-local-gate-by-risk) require the full
`pnpm run check` for certain change categories regardless of oracle confidence, because the
oracle's import/selector mapping can't see dynamic dispatch, string-keyed wiring, or generated
artifacts. That requirement is about catching failures the oracle would have missed, not about
forcing a locally-unachievable zero-failure bar on a noisy sandbox.

Run the full check (through `run_background`, since it routinely outruns a foreground shell's
silent-output timeout), triage the result against this page, and record in the PR's Validation
section which you saw: clean, noise-only, or a new failure you fixed. Required PR CI runs this same
full unit suite on a clean runner on every normal PR regardless of oracle output, so a noise-only
local result is not grounds to skip the PR's CI gate — only to stop re-triaging the same known noise
locally before pushing.
