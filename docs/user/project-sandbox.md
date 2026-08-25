---
title: The project sandbox
description: What the project sandbox contains, where it runs, and what stays outside it.
---

# The project sandbox

When the sandbox is up, agent `run_shell` commands that stay in the project
run inside an OS jail: **no network** and **no files outside the workspace**.
That is the containment boundary. A fuzzy “this looks safe” classifier is not.

## Where it runs

| Platform                        | Sandbox                                                     |
| ------------------------------- | ----------------------------------------------------------- |
| macOS                           | ASRT seatbelt. This is the original, supported containment. |
| Linux                           | bubblewrap. Same contained / external matrix once it is up. |
| Windows                         | None. Every agent command prompts.                          |
| Any platform after init failure | None. Same as Windows: prompt, do not auto-run.             |

**You should see** local commands (`npm test`, `git status`) run without a
dialog on macOS and Linux. A `curl` or `git push` either asks first or, if you
approved it, runs _outside_ the sandbox.

## What is not the sandbox

- **Your Shells tab.** User-directed terminals spawn unsandboxed and do not
  prompt where a sandbox is active. The agent cannot type into that tab. This
  is a product choice (GA residual N2), not a bug in the closed #662 gate.
- **Approved external commands.** After you click “Run outside sandbox?”, that
  one command has host privileges.
- **SSH workspaces.** The seatbelt does not follow you onto the remote account.
- **Managed remote agents.** Isolation belongs to Cursor or Anthropic, not to
  Copse’s local jail.

## Windows and init failure

Without a sandbox there is no jail to stay inside, so Copse asks. Write-level
auto-approval is also refused (git hooks would run on the host). See
[Permission tiers](auto-approval.md).

If a command fails _because_ the sandbox blocked it, you get the same
“Run outside sandbox?” question after the failure. That is the retry, not a
second product.

Contributor contract: [docs/shell-permissions.md](../shell-permissions.md).
