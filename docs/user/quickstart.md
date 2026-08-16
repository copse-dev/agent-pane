---
title: Quickstart
description: Open a project, pick a model, and send a first prompt you can verify.
---

# Quickstart

## Fastest path

1. [Install](install.md) Copse and launch it.
2. Open a project folder — a Git checkout you are happy to let the agent read.
3. [Connect a model](connect-a-model.md), or skip this and use the built-in mock
   agent to explore the UI.
4. Trust the project when Copse asks. An untrusted checkout does not get
   auto-run or project MCP servers.
5. Type a concrete request, for example “explain how authentication works” or
   “show me the failing tests.”

**You should see** your message in the thread, then either a reply or a tool
card (read, search, or a command). That is success.

If the composer stays empty or the model picker has no entries, go to
[Connect a model](connect-a-model.md). If a dialog interrupts a command you
expected to run, read [Approvals](approvals.md).

## What “in control” looks like

- File edits appear as diffs you can review before they land.
- Commands that leave the [project sandbox](project-sandbox.md) ask first,
  unless they match a [recognised auto-approval shape](auto-approval.md).
- The integrated **Shells** tab is your terminal. It is not the agent’s
  `run_shell` tool and it is not sandboxed. That is intentional.

Next: [Approvals: what the dialog is asking](approvals.md).
