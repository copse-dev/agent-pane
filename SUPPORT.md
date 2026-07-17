# Support policy

## Supported release and platform

Support is limited to the latest published Copse release on:

- macOS 26 or newer;
- Apple Silicon (`arm64`) and Intel (`x64`) Macs.

Linux and Windows may be useful for source development, but they are not
supported general-availability targets. Older Copse releases, prereleases,
development builds, and arbitrary commits from `main` are not supported.

## Getting support and finding known issues

Use the repository's [GitHub Issues](https://github.com/copse-dev/agent-pane/issues)
for support requests, bug reports, and known issues. Search existing issues
before opening a new one. Do not put vulnerabilities or sensitive data in a
public issue; use [SECURITY.md](SECURITY.md) instead.

A useful report includes:

- the Copse version;
- the macOS version and `arm64` or `x64` architecture;
- minimal steps to reproduce the problem;
- expected and actual behavior;
- the exact error text after removing secrets and private data.

GitHub Issues is the canonical known-issues list. A GitHub Release may call out
issues that are especially important for that release, but it does not replace
the issue tracker.

## Diagnostics and exports

Copse has no in-product diagnostic or support-bundle generator and sends no
telemetry or crash reports to the maintainers.

The built-in thread export is a self-contained JSONL transcript, not a redacted
diagnostic. It can include prompts, source code, attachments, file paths, tool
arguments and results, model output, reasoning, and nested subagent transcripts.
Before sharing an export through GitHub or email:

1. Work from a copy and inspect every line.
2. Remove credentials, authorization headers, private URLs, personal data,
   proprietary source, and unrelated conversation history.
3. Re-check tool results and nested subagents; they can contain data that was not
   visible in the final chat response.
4. Prefer a new minimal reproduction over a real workspace export.

Do not share `settings.json`, `config.json`, shell startup files, environment
dumps, browser profiles, or the contents of the Copse user-data directory. Those
locations may contain credentials, provider configuration, repository metadata,
cookies, and conversation data.

Public GitHub issues must contain only non-sensitive material. If the problem is
a vulnerability, use `security@copse.dev` as described in
[SECURITY.md](SECURITY.md).
