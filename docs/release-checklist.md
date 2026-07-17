# General release checklist

Use this checklist with [releasing-macos.md](releasing-macos.md). Copse general
availability supports only the latest release on macOS 26 or newer, for `arm64`
and `x64`. Releases are forward-fix only; downgrade is not a supported rollback.

## Before tagging

- [ ] Confirm the target commit is based on current `main` and required CI is
      green.
- [ ] Run `npm run check`, `npm run build`, and the release/e2e validation
      appropriate to the changed areas.
- [ ] Bump `package.json` to the release version and use the matching
      `v<version>` tag.
- [ ] Review [SECURITY.md](../SECURITY.md), [SUPPORT.md](../SUPPORT.md), and the
      public [privacy summary](../site/privacy.html) against the shipped code.
- [ ] Review the full [privacy/data-flow inventory](privacy-data-flow.md) for any
      new provider, MCP, ACP, remote-agent, browser, credential, telemetry, or
      storage flow.
- [ ] Triage open GitHub Issues and identify the known issues that must be called
      out in this release.
- [ ] Inspect every data migration. Back up representative pre-release data and
      test the forward migration on the release candidate.
- [ ] Confirm [recovery guidance](recovery.md) still matches the shipped data
      locations and migration behavior.

## Release notes

- [ ] Update the `Unreleased` section of [CHANGELOG.md](../CHANGELOG.md).
- [ ] Draft the canonical GitHub Release notes according to the process in
      `CHANGELOG.md`.
- [ ] State macOS 26+, `arm64`/`x64`, latest-release-only support, and known
      issues.
- [ ] Describe user-visible security/privacy changes and any data migration.
- [ ] Describe recovery implications. Do not recommend or promise a downgrade;
      Copse recovers through a forward corrective release.
- [ ] Keep confidential vulnerability-report details out of public notes.

## Build and publish

- [ ] Run the `Release (macOS)` workflow's unpublished path first. Its clean
      install gate must pass before packaging begins.
- [ ] Verify both architecture artifacts, signing, notarization, and stapling as
      described in [releasing-macos.md](releasing-macos.md).
- [ ] Smoke-test a fresh install and the update prompt on macOS 26.
- [ ] Publish the signed DMG/zip/update feed and reviewed notes together through
      the GitHub Release process.
- [ ] Confirm the published artifacts and release notes identify the same
      version and architectures.
- [ ] Reset `CHANGELOG.md`'s `Unreleased` section for subsequent work.

## After publication

- [ ] Verify the latest-release update feed is reachable from a packaged build.
- [ ] Record newly discovered known issues in GitHub Issues and link important
      ones from the GitHub Release notes.
- [ ] If the release is bad, preserve affected data, publish the known issue, and
      prepare a corrective newer release. Do not direct users to downgrade.
