---
title: Approvals
description: What each permission dialog is asking, and which button grants what.
---

# Approvals: what the dialog is asking

Copse stops and asks when a tool would leave the project, talk to the network,
or run something it cannot contain. The title is the question. The buttons are
different grants — they are not synonyms.

## Common dialogs

| Title                                         | What a Yes does                                                                                                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Run outside sandbox?**                      | This command runs on the host, not inside the project sandbox. Use it when the agent needs network or files outside the project.                            |
| **Allow read access outside of the project?** | The primary button grants _this read shape_ for the rest of the thread, in memory only. **Approve this command** allows one invocation and stores no grant. |
| **Guarded YOLO safety check**                 | You turned on an explicit high-autonomy mode. The host still computed a harm verdict; this dialog is that verdict asking you to proceed.                    |
| A custom-tool or MCP prompt                   | That tool or server runs once, or is remembered, according to the checkbox on the dialog.                                                                   |

A read-outside grant never authorizes a write, a shell escape, or a different
path. Credential-shaped targets (`.env*`, `~/.ssh`, `~/.aws`, and similar) and
paths as broad as `~` or `/` are not eligible.

**You should see** the command or path in the dialog body, and after you
approve, the tool card in the thread shows that it ran. If you decline, the
agent is told no and should try another approach.

## What does _not_ ask

- Commands that stay inside the [project sandbox](project-sandbox.md), when
  “Run commands without asking when they stay inside the project folder” is on.
- [Recognised low-risk shapes](auto-approval.md) at your configured level, in a
  trusted project, while the sandbox is in a state that level allows.
- Your own **Shells** tab. That is a user-directed terminal. It opens without a
  prompt and runs outside the sandbox. The agent’s `run_shell` tool is a
  different path and still goes through this page.

## If you are surprised

- An untrusted project prompts for almost everything. Trust is a project
  setting, not a global override.
- Turning off auto-run in Settings → Permissions makes every sandbox-contained
  command ask too.
- A sandbox block after a command already started is the same “Run outside
  sandbox?” question, moved to after the failure.

The durable contract (for contributors) is
[docs/shell-permissions.md](../shell-permissions.md).
