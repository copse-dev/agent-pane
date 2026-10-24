# Package firewall

**Status: Implemented (phase 1).** Replaces the third-party Socket Firewall (`sfw`) with a
package firewall written in this repository. It runs under the app's own runtime, checks every
package download against public malware advisories, and needs no global install, account or
vendor branding.

## Problem

Every agent-initiated package install, every ACP adapter install and every automatic worktree
preparation ran through `sfw`, a closed-source binary fetched from npm:

1. **A third-party binary guarded every install.** `sfw` was itself installed unscanned
   (`npm install -g --ignore-scripts sfw@<pin>`), and it downloaded a further firewall binary
   at first run. That binary was the root of trust for every later install.
2. **It needed its own consent flow.** Users were asked "Install Socket Firewall?" before their
   first install, and again before an ACP adapter update. Declining blocked installs entirely.
3. **The verdicts came from one vendor's private API.** Package names and versions went to
   Socket. We could not inspect, extend or reproduce the verdicts.
4. **Its branding ran through our approval copy.** Socket's product name appeared in approval
   dialogs, tool descriptions and output banners.

## Goals

- Block downloads of packages that public advisories list as malicious, for npm (npm, pnpm,
  Yarn), PyPI (pip, uv) and crates.io (cargo). These are the managers `safe-install.ts` detects.
- Use only code in this repository plus public, freely licensed data. Add no new npm dependency.
- Keep the existing integration shape: a command wrapper that every caller already uses
  (`<firewall> <command…>`).
- Remove the bootstrap install and its approval prompts. Remove Socket branding from all UI copy.

## Non-goals

- Vulnerability (CVE) blocking. Only confirmed-malicious packages (`MAL-` advisories) are
  blocked. Vulnerable-but-legitimate packages stay the job of `npm audit` and similar tools.
- Private registries and mirrors. Traffic to hosts other than the public registries is tunnelled
  unchanged (this matches `sfw`'s free tier).
- Git, URL and path dependencies, `curl | sh` installers, `go install`, `gem` and `brew`.
- Remote (SSH) installs, which run on another machine. Their approval copy still discloses that
  the firewall does not cover them.

## Architecture

```
run_shell / ACP auto-setup / worktree preparation
        │  ELECTRON_RUN_AS_NODE=1 <Copse> dist/main/package-firewall.js <cmd…>
        ▼
package-firewall.js  (standalone bundle, Electron-as-Node)
  1. mint an ephemeral, name-constrained CA in memory (EC P-256, 7-day validity)
  2. start an authenticated HTTP CONNECT proxy on 127.0.0.1:<random>
  3. write the CA *certificate* (never the key) to a private temp dir
  4. spawn <cmd…> with proxy + CA environment, wait, exit with its status
        │
        ├─ CONNECT registry.npmjs.org / registry.yarnpkg.com / files.pythonhosted.org /
        │  static.crates.io / crates.io  → terminate TLS with a leaf cert from the CA,
        │  parse <ecosystem, name, version> from each tarball URL, ask the advisory
        │  checker, then forward upstream or answer 403
        └─ CONNECT anything else → plain TCP tunnel (unchanged bytes)
```

Modules live in `src/main/services/security/package-firewall/`:

| Module                   | Responsibility                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `x509.ts`                | Minimal DER encoder plus CA and leaf issuance on `node:crypto`. No certificate library.                             |
| `registry-targets.ts`    | Intercepted hosts. Tarball URL parsers for npm, PyPI and crates.io. PEP 503 name normalisation.                     |
| `advisories.ts`          | Verdict engine. Batched OSV.dev queries, the cached DataDog feed and an in-memory cache.                            |
| `upstream.ts`            | Outbound connections that honour the user's own `HTTPS_PROXY` / `NO_PROXY`.                                         |
| `proxy.ts`               | CONNECT proxy, proxy authentication, selective TLS interception, request forwarding.                                |
| `child-env.ts`           | Proxy and CA variables for every supported manager. `NO_PROXY` entries that would bypass the firewall are stripped. |
| `firewall-cli.ts`        | Wrapper entry: wires the above together, forwards signals, reports refused downloads.                               |
| `../package-firewall.ts` | Main-process facade: bundle path, the wrapped shell string, the global npm install used by ACP auto-setup.          |

## Data sources

| Source                                                                                                                  | Coverage                                                                                                                                                                                     | How it is used                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [OSV.dev](https://osv.dev) `POST /v1/querybatch`                                                                        | OpenSSF [Malicious Packages](https://github.com/ossf/malicious-packages) and GitHub malware advisories, as `MAL-` ids. npm, PyPI, crates.io and more. About 223k npm entries (October 2026). | Live lookup per downloaded package version. Requests are micro-batched (20 ms window, up to 500 queries). Results are cached for the life of the wrapper. |
| [DataDog malicious-software-packages-dataset](https://github.com/DataDog/malicious-software-packages-dataset) manifests | npm and PyPI, by package name with optional version lists. About 1.7 MB for npm.                                                                                                             | Downloaded into `~/.copse/cache/package-firewall/feeds/` at most once a day. Checked offline, so it still protects when OSV is unreachable.               |

OSV's bulk export (`npm/all.zip`, 219 MB) is too large to refresh on a desktop, so it is not
used. Sources are combined with OR: a package is blocked if any source lists it.

## Decisions

1. **Wrapper process, not an in-app proxy.** Proxying hundreds of megabytes of tarballs on the
   Electron main thread would compete with IPC. A wrapper also keeps today's call shape and
   lifetime: one firewall per command, gone when the command exits.
2. **Hand-written X.509, no dependency.** About 200 lines of DER on `node:crypto`. Verified in
   tests by Node's own `X509Certificate`, real TLS handshakes, and manually against OpenSSL
   `verify -x509_strict`, Python 3.13 (strict verification), pip, uv and cargo.
3. **The CA key never touches disk, and the CA is name-constrained.** Each invocation mints a
   new CA whose `nameConstraints` permit only the intercepted registry hosts. Even a leaked key
   could not sign a certificate for any other site. Only children of that invocation trust it.
4. **The proxy requires a per-invocation token.** Sandboxed agents may reach loopback ports. An
   unauthenticated forward proxy would give them an egress path that bypasses the sandbox's
   network policy. Credentials travel in the proxy URL, which every supported manager sends as
   preemptive Basic auth.
5. **Fail open when no source can answer.** If OSV cannot be reached, the package is still
   checked against the cached feed. If neither can give a verdict, the download proceeds without
   comment. Failing closed would break every install during an OSV outage or behind a filtering
   proxy. Revisit if we add a strict mode.
6. **Strip interception bypasses from `NO_PROXY`.** Corporate and CI environments often list
   registries in `NO_PROXY`. Those entries are removed for the intercepted hosts only.
7. **Block at the tarball, not the metadata.** Packuments and indexes pass through. Resolution
   is unchanged, and a blocked package fails the install with a 403 that names the advisory.
8. **Fail closed inside a contained sandbox.** On macOS, a sandboxed `npx` cannot bind loopback.
   The wrapper then runs the command with every proxy variable pointing at a closed port, so an
   installed binary (`npx tsx`) still runs and any download fails rather than going unchecked. On
   Linux, the proxy binds inside a private network namespace but reaches nothing upstream. Both
   cases print a `[safe-install]` line that `sandbox-denial-signatures.ts` turns into the
   usual unsandboxed-retry approval. That retry still runs behind the firewall.
9. **Offline preparation skips the wrapper.** With network blocked by kernel isolation, nothing
   can be downloaded, so there is nothing to check, and no loopback port to bind.
10. **SSH workspaces are not wrapped.** Their commands run on the remote host, which this
    machine's firewall cannot reach. The install banner and the remote ACP install approval say
    so.
11. **No product name and no promises in the UI.** The firewall is plumbing, not a feature
    with a name. Approval dialogs, banners and the changelog state only facts that always hold,
    such as "install lifecycle scripts are disabled". They never say packages are scanned or
    safe. A blocklist catches known-bad packages and nothing more; advertising it would invite
    users to expect guarantees it cannot give. The wrapper prints nothing for clean or
    unverifiable downloads, only the line for a refused one. Its output shares the shell tool's
    `[safe-install]` tag. The one exception is the SSH remote-install approval, which says its
    downloads are not checked, because that is a gap the user should know about.

## Acceptance criteria

- `npm install`, `pip install`, `uv pip install` and `cargo fetch` succeed through the wrapper
  with each tool's default TLS verification. Exercised manually against the live registries.
- A tarball whose package version is listed by a source is answered with 403. The wrapper's
  blocked line names the package and advisory id. (Unit test against a stub OSV server.)
- A wrong or missing proxy token gets 407 and no tunnel. (Unit test.)
- Non-registry CONNECT targets are tunnelled byte-for-byte. (Unit test.)
- No UI copy, tool description, banner or e2e expectation mentions Socket or `sfw`, names the
  firewall, or claims that packages are scanned (decision 11).
- The "Install Socket Firewall?" prompts and their code paths are gone. ACP adapter updates no
  longer need a bootstrap approval.

## Follow-ups

- Bun (`bun install`, `bunx`) and RubyGems detection in `safe-install.ts`, so they get wrapped.
- Optional strict mode (fail closed) as a setting.
- A packument-level filter that hides malicious versions, so resolution picks a safe one rather
  than failing.
- An audit-log line per blocked package (supply-chain doc, phase 4).
