# Changelog and release notes

The canonical changelog is the set of
[GitHub Releases](https://github.com/copse-dev/agent-pane/releases). Published
release notes are owned and maintained with the GitHub Release; this file records
the release-note process and the current unreleased summary rather than copying
every published entry.

## Unreleased

- Zip archives can be attached to a chat and read. Drop a `.zip` on the composer
  and the agent unpacks it with the new **`read_archive`** tool into the
  conversation's own directory, then reads what is inside with its ordinary file
  tools — so a bundle of logs, a downloaded release, or an exported thread can be
  explored file by file rather than described. Previously a dropped zip was read
  as text and landed in the prompt as binary noise. The extractor refuses path
  traversal, symlinks and zip bombs, and the extraction is deleted with the
  thread. See [docs/read-archive.md](docs/read-archive.md).
- A thread can be exported as its whole folder, not just its transcript. The
  footer overflow menu (Developer mode) keeps **Export conversation (JSONL)** —
  the portable single-file transcript — and adds **Export thread folder (ZIP)**,
  a faithful copy of the thread's directory in the chat store: the event spine,
  message prose, tool-result and image blobs, plans, the provider-history
  sidecar, and any nested subagent sessions.
- Threads can be forked. Right-click a thread in the sidebar and choose **Fork**
  to branch the whole conversation, or hover any prompt in the transcript and
  choose **Fork from here** to branch it as it stood at that point. The fork is a
  new thread — the original is untouched — and it inherits the model context, so
  the agent remembers the conversation the transcript shows. Forking the whole
  thread copies the recorded provider history verbatim; forking from an earlier
  prompt reconstructs it from the transcript, which cannot carry the expanded
  contents of `@`-file / `@`-thread / paste attachments (the app says so when it
  applies).
- The last prompt in a thread can be resent. Hover it and choose **Resend** to
  submit it again as a new turn — useful after a failed run or to get a second
  attempt at the same question. History is appended to, never rewritten, and a
  resend while the agent is running queues behind the current turn. Attachment
  contents are not part of a resend (only the prompt's own words and images).
- Fixed: a project showing fewer threads than one sidebar page pinned its list to
  that size, so the next thread it gained (a new chat or a fork) appeared behind
  "Show more" instead of in the sidebar.
- Fixed SSH password, passphrase, and host-key prompts never appearing. The
  bundled askpass helper was emitted with a duplicate `#!/usr/bin/env node` on
  line 2 — a syntax error — so it crashed on every launch. OpenSSH treats an
  askpass that exits non-zero as "no answer" and moves on, so connecting to a
  password-auth host silently burned through the server's auth attempts and
  failed with `Too many authentication failures` instead of asking for a
  password. The build now syntax-checks that bundle before shipping it.
- ACP agents graduated out of **Settings → Experimental** into their own
  top-level **Settings → ACP agents** section. The panel now follows the
  Providers pattern: a chip row lists each agent (known presets first, then your
  custom ones, then **Add agent**) and reveals only the selected agent's install
  guidance / editor, so agents are hidden away until picked rather than all
  expanded at once. A dot marks the agents you've added.
- Packs: new opt-in `copse.forced-planning` first-party pack. When the model
  running a turn measures below a capability threshold, it requires an explicit
  plan before any other tool call — `update_todos` when that tool is offered, a
  written numbered plan when it is not — so smaller and heavily-quantized models
  can carry longer tasks. Thresholds are configured per scale in Settings →
  Packs (the Artificial Analysis Intelligence Index and the Copse composite are
  not comparable, so each has its own), with a third setting for what to do with
  unmeasured models. See docs/forced-planning.md.
- CI: bounded the retention of every workflow artifact that previously inherited
  the 90-day default (per-shard PR screenshots, coverage report, and the three
  bench result sets), so routine PR runs stop accumulating against the org's
  Actions artifact-storage quota. Screenshots expire in 3 days (only ever
  consumed by `commit-screenshots` within the same run); coverage in 7; bench
  trend data in 14.
- Added general-availability security, support, privacy/data-flow, release, and
  recovery documentation.
- Privacy: OpenRouter requests now route only to zero-data-retention,
  non-training endpoints by default (`provider.zdr` +
  `data_collection: "deny"`, two independent toggles in Settings → Providers
  → OpenRouter — turning ZDR off keeps training excluded unless separately
  allowed); the model picker lists only ZDR-capable OpenRouter models while
  ZDR routing is on, and a model with no compliant endpoint fails fast with
  an actionable message instead of being retried. Direct OpenAI requests
  send `store: false`. Settings → Providers badges each provider's default
  retention/training policy and the model picker flags providers that may
  train on inputs. Privacy-forward hosted endpoints (Groq, Together AI, and
  Fireworks AI) are available directly as provider presets instead of being
  hidden under Other. See docs/provider-data-policies.md.

## Release-note process

For every release:

1. Draft the GitHub Release from the matching `v<version>` tag.
2. Turn merged changes into user-facing notes, grouped into features, fixes,
   security/privacy changes, and developer changes as applicable.
3. State the supported OS and architectures, known issues, data migrations, and
   recovery implications. Copse supports forward fixes only; do not recommend a
   downgrade.
4. Link issues or pull requests that provide important detail without exposing
   confidential security-report information.
5. Review the notes with the artifacts, then publish them as part of the GitHub
   Release.
6. Reset the `Unreleased` section here after publication. Do not mirror the
   published notes into a second historical list in this file.

The complete shipping procedure is in
[docs/release-checklist.md](docs/release-checklist.md).
