# Changelog and release notes

The canonical changelog is the set of
[GitHub Releases](https://github.com/copse-dev/agent-pane/releases). Published
release notes are owned and maintained with the GitHub Release; this file records
the release-note process and the current unreleased summary rather than copying
every published entry.

## Unreleased

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
