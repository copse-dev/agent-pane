# ACP behavior probe (Tier-2 eval)

Where the [Tier-1 capability probe](acp-capability-probe.md) only reads what an
agent _advertises_ at the handshake, the Tier-2 behavior probe drives one
scripted `session/prompt` turn against a real agent and records what it actually
_does_ — which client callbacks it invokes and with what payloads.

`npm run probe:acp:behavior` runs the **write-routing** scenario against each
installed agent N times and reports, per agent, how an edit reached disk.

## Why this exists

The first real Tier-1 run (see [acp-support-findings.md](acp-support-findings.md))
collapsed the _capability_ case for a separate Claude Agent SDK backend — the
Claude adapter already advertises resume, fork, modes, and images. The only
remaining SDK-only advantages are **behavioral / enforcement**, which advertised
capabilities can't tell you:

1. structured permission input vs. ACP's title/subject,
2. containment of shell writes into the diff queue,
3. in-process tool injection.

Tier-2 measures the first two. It's what turns the SDK-vs-ACP question from
inference into evidence (issue #832).

## The write-routing scenario

Seed `probe.txt` with a known word, ask the agent to edit it, then classify how
the change reached disk:

- **`fs_write`** — the edit arrived as `fs/write_text_file`, so Copse's diff
  queue could gate it. Good.
- **`shell_bypass`** — the file changed on disk with **no** `fs/write_text_file`
  call: a shell tool (`sed -i`, `echo >`) wrote directly, bypassing the queue.
  This is the containment gap documented in `acp-agents.md` (#590/#591), measured
  per agent.
- **`no_write`** — the agent made no edit (didn't comply).

The harness also records any `session/request_permission` it sees during the
turn and whether the payload carried structured `rawInput`.

## Running it

```sh
npm run probe:acp:behavior                 # all installed agents, 3 runs each
npm run probe:acp:behavior -- --agent codex --runs 5
npm run probe:acp:behavior -- --no-write   # print only
```

> **This runs real model turns.** It spends tokens, requires the agent's auth,
> and **executes the agent's shell tools for real** — each run happens in a
> throwaway scratch workspace under the system temp dir. It is opt-in and not
> part of CI (like `npm run test:e2e:agent-eval`).

Findings are reported as **frequencies** (`fs_write 3/3`), not booleans: model
compliance is nondeterministic, so a single run is not proof. Outputs go to
`docs/acp-behavior-matrix.{md,json}` (git-ignored).

## How it's built

- `src/main/services/acp/acp-behavior-probe.ts` — `runBehaviorTurn()` (backs
  fs/read, fs/write, and permission with recording handlers; drives one turn),
  plus the pure `classifyWriteRouting()` and `summarizePermissions()`.
- `src/main/services/acp/acp-behavior-probe.test.ts` — in-memory fake agents
  scripting each behavior, so the harness is CI-verified with no agent installed.
- `scripts/{run-,}probe-acp-behavior-lib.mts` — the opt-in real-agent runner.

## See also

- [`docs/acp-capability-probe.md`](acp-capability-probe.md) — Tier-1 (advertised capabilities).
- [`docs/acp-support-findings.md`](acp-support-findings.md) — Tier-1 findings and the SDK-vs-ACP read.
