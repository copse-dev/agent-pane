# General release checklist

Use this checklist with [releasing-macos.md](releasing-macos.md). Copse supports
public stable and beta channels on macOS 26 or newer for `arm64` and `x64`.
Releases are forward-fix only; downgrade is not a supported rollback.

## Before tagging

- [ ] Confirm the target commit is on current `main` and required CI is green.
- [ ] Run `npm run check`, `npm run build`, and the release/e2e validation
      appropriate to the changed areas.
- [ ] Choose one supported version shape: `X.Y.Z` for stable or
      `X.Y.Z-beta.N` for beta. Use the exact matching `v<version>` tag.
- [ ] Complete the current security-review ledger, resolve every `ga-blocker`
      or record an explicit bounded waiver, and record the required human
      security reviewer and release-owner sign-off.
- [ ] Review [SECURITY.md](../SECURITY.md), [SUPPORT.md](../SUPPORT.md), and the
      public [privacy summary](../site/privacy.html) against the shipped code.
- [ ] Review the full [privacy/data-flow inventory](privacy-data-flow.md) for any
      new provider, MCP, ACP, remote-agent, browser, credential, telemetry, or
      storage flow.
- [ ] Triage open GitHub issues and identify known issues that must appear in
      this release's notes.
- [ ] Inspect every data migration. Back up representative prerelease data and
      test the forward migration on the release candidate.
- [ ] Confirm [recovery guidance](recovery.md) still matches shipped data
      locations and migration behavior.

## Release notes

- [ ] Update the `Unreleased` section of [CHANGELOG.md](../CHANGELOG.md).
- [ ] Draft the canonical GitHub Release notes according to `CHANGELOG.md`.
- [ ] State the channel, macOS 26+ requirement, `arm64`/`x64` support, and known
      issues.
- [ ] Describe user-visible security/privacy changes and any data migration.
- [ ] Describe recovery implications. Do not recommend or promise a downgrade;
      Copse recovers through a forward corrective release.
- [ ] Keep confidential vulnerability-report details out of public notes.

## Build and publish

- [ ] Confirm anonymous, signed-out access to the public download location. A
      release in a private GitHub repository does not satisfy this check.
- [ ] Confirm the workflow classified the version correctly: beta becomes a
      GitHub prerelease on `beta-mac.yml`; stable becomes a normal/latest release
      on `latest-mac.yml` and also refreshes beta metadata.
- [ ] Let the `Release (macOS)` workflow perform its clean install, package,
      sign, notarize, staple, runtime smoke test, and artifact attestation.
- [ ] Verify the app embeds `LSMinimumSystemVersion=26.0` and both architecture
      artifacts contain matching signed `gortex` helpers.
- [ ] Publish the tested DMGs, zips, blockmaps, channel metadata, checksums, and
      reviewed notes together. Do not rebuild or publish locally.
- [ ] Confirm the published artifacts and release notes identify the same
      version, channel, minimum OS, and architectures.
- [ ] Reset `CHANGELOG.md`'s `Unreleased` section for subsequent work.

## Channel rehearsal

- [ ] Stable old → stable new updates successfully.
- [ ] Stable old does not see a beta-only release.
- [ ] Beta old → beta new updates successfully.
- [ ] Beta old → newer stable updates successfully.
- [ ] No client is offered an older version, even when an older release is
      published later.
- [ ] A fresh user can download and install each DMG without repository
      credentials.

## After publication

- [ ] Verify the expected channel feed is anonymously reachable from a packaged
      build and references the uploaded zip for both architectures.
- [ ] Record newly discovered known issues in GitHub and link important ones
      from the release notes.
- [ ] If the release is bad, preserve affected data, publish the known issue,
      and prepare a corrective newer release. Do not direct users to downgrade.
