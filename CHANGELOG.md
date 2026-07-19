# Changelog and release notes

The canonical changelog is the set of
[GitHub Releases](https://github.com/copse-dev/agent-pane/releases). Published
release notes are owned and maintained with the GitHub Release; this file records
the release-note process and the current unreleased summary rather than copying
every published entry.

## Unreleased

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
  train on inputs. See docs/provider-data-policies.md.

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
