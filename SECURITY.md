# Security policy

## Supported versions

Copse supports only the latest published release. Older releases, prereleases,
development builds, and arbitrary commits from `main` do not receive security
support. Before the first general-availability release is published, there is no
supported release.

| Version                            | Supported |
| ---------------------------------- | --------- |
| Latest published release           | Yes       |
| Every older or unpublished version | No        |

See [SUPPORT.md](SUPPORT.md) for the supported operating systems and the general
support policy.

## Reporting a vulnerability

Email vulnerability reports privately to [security@copse.dev](mailto:security@copse.dev).
Do not open a public GitHub issue for a suspected vulnerability.

Include the affected Copse version, operating system and architecture, a minimal
reproduction, the security impact, and any suggested mitigation. Remove API
keys, access tokens, private source code, personal data, and other secrets before
sending a report. If a sensitive artifact is essential to the report, say what
it contains before attaching it.

There is no guaranteed acknowledgement, update, or remediation SLA. This policy
does not promise support for versions other than the latest published release.

## Security-related diagnostics

Copse does not create a secret-redacted support bundle. Thread exports can
contain prompts, source code, file paths, tool arguments and results, model
output, and nested agent transcripts. Review and redact an export manually
before sharing it. Never attach `settings.json`, `config.json`, shell startup
files, browser profile data, or raw credentials.

For ordinary bugs, follow [SUPPORT.md](SUPPORT.md). For vulnerability reports,
send the smallest redacted reproduction to the private address above.
