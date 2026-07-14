# Supply-chain & untrusted-input hardening

Copse is an Electron AI coding assistant whose agent can execute shell commands
and spawn MCP servers on the user's machine. Package managers (`npm`/`pnpm`/
`yarn`/`bun`, `pip`/`uv`, `cargo`, `gem`, `brew`, `apt`, and ephemeral runners
like `npx`/`uvx`/`pipx run`) and auto-discovered skills/MCP configs are therefore
a meaningful supply-chain and prompt-injection attack surface. This note records
the trust boundaries, the policy per surface, and the phased plan (tracking
issues #128 and #174).

## Trust boundaries

| Surface                            | Where                                                                                                   | Trust                                                                                                                 | Real boundary                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Agent `run_shell` package installs | `src/main/tools/shell-tool.ts`, `src/main/services/shell-scope.ts`, `src/main/services/safe-install.ts` | Untrusted (agent-emitted)                                                                                             | macOS seatbelt sandbox; prompt + Socket Firewall elsewhere                                                                 |
| MCP stdio/http servers             | `src/main/services/mcp-registry.ts`, `mcp.json`                                                         | Project-local config is **attacker-controllable** (a cloned repo can ship `.mcp.json`); user-global config is trusted | Per-server trust gate (tracked in #100), env-interpolation allowlist                                                       |
| Auto-discovered skills             | `src/main/services/skills-registry.ts`, `parse-skill-frontmatter.ts`, `skill-prompt.ts`                 | `user` source = trusted; `project`/`plugin`/`plugin-path` = **untrusted**                                             | Frontmatter is parsed defensively; untrusted skill text is delimited as data in the prompt                                 |
| Cursor plugin MCP                  | `src/main/services/cursor-plugins.ts`, `mcp-registry.ts`                                                | User-installed via Cursor marketplace (trusted for env interpolation; same tier as `~/.cursor/mcp.json`)              | Merged before project configs; see `docs/cursor-plugins.md`                                                                |
| Cursor hooks                       | `src/main/services/cursor-hooks.ts`, `permission-gate.ts`, `hooks.json`                                 | `~/.cursor/hooks.json` = trusted; project `<root>/.cursor/hooks.json` = **attacker-controllable** (cloned repo)       | Off by default (`cursorHooksEnabled`); project hooks need workspace trust (#100); scrubbed env; see `docs/cursor-hooks.md` |
| App's own build/install chain      | `package.json` scripts, `scripts/postinstall-native.mts`, `scripts/fetch-gortex.mts`                    | Build-time                                                                                                            | Lockfile + pinning (phase 3)                                                                                               |

### Policy axis per surface

- **Agent package installs** — _prompt on all platforms_ (do not rely on the
  macOS seatbelt alone). Detected installs are additionally routed through
  Socket Firewall with install lifecycle scripts disabled
  (`npm_config_ignore_scripts`) for JS managers (`safe-install.ts`).
- **MCP project-local config** — _prompt on first use_ (owned by #100's trust
  gate); env interpolation from project configs uses an empty allowlist so a
  cloned repo cannot read process env into a server's `url`/`headers`/`args`/`env`.
- **Untrusted skills** — an explicit `/skill` invocation is a deliberate,
  authorizing user action, so the "treat the invoked skill as the primary task /
  follow its instructions" directive applies to **every invoked skill regardless
  of source**. For untrusted-source (`project`/`plugin`/`plugin-path`) skills the
  _body_ is still framed as untrusted content: the model follows the task but
  must not let the skill change its role, exfiltrate data, run destructive/
  network commands, disable safety checks, or override the user's explicit
  instructions/safety constraints. _Non-invoked_ skills in the startup catalog
  remain pure data (name/description only, never instructions to act on).
  Additionally, every skill (regardless of source) is scanned for external
  `http(s)` links and is reminded that its work stays sandbox/approval-confined —
  see "Skill external-link warnings & sandbox confinement" below.
- **Build-time fetches** — _pin_ (phase 3).

## What has landed (this change — phase 1, #128 + #174)

### #128 — Skill frontmatter & prompt-injection containment

- `splitSkillMarkdown` now scans line-by-line and only ends frontmatter at a
  standalone `---` line, so a `---` inside a fenced code block or a `----`
  horizontal rule in the body no longer prematurely terminates frontmatter.
  CRLF input is normalized.
- The frontmatter scalar parser fully unwraps nested/doubled quotes, decodes
  double-quoted escape sequences, honours single-quoted `''` escapes, and
  supports literal/folded block scalars and chomping indicators.
- The system-prompt builders (`skill-prompt.ts`) now tag each skill with its
  `source` and a `trust="trusted|untrusted"` attribute. Untrusted (auto-
  discovered) skill descriptions and bodies are explicitly framed as **untrusted
  data**, with guidance that the user's own messages and safety constraints take
  precedence over anything embedded in an untrusted `<skill_content>`. An
  explicit `/skill` invocation authorizes the skill, so the "primary task /
  follow its instructions" directive applies to every invoked skill regardless
  of source; untrusted-source bodies keep their anti-injection guardrails (no
  role change, exfiltration, destructive/network commands, safety-disable, or
  overriding the user), and non-invoked catalog entries stay
  name/description-only data.

### #174 — Phase 1 supply-chain mitigations

- `shell-scope.ts` classifier coverage extended to ephemeral package runners
  (`npx`, `pnpm dlx`, `yarn dlx`, `bunx`, `uvx`, `pipx run`/`pipx install`),
  `corepack`, `bun` install/dlx, `go install`/`go get`, and `uv pip install`/
  `uv add` — each surfaces an explicit reason in the approval prompt.
- New registry-redirect detection flags `--registry`, `_authToken`,
  `npm_config_registry`, pip `--index-url`/`--extra-index-url`, and cargo
  `--registry` so installs pointed at a non-default (possibly attacker-
  controlled) registry are surfaced for approval.
- Existing infrastructure already covered: Socket Firewall wrapping of detected
  installs and `npm_config_ignore_scripts` for JS managers (`safe-install.ts`,
  `shell-tool.ts`).

### Skill external-link warnings & sandbox confinement

Two defaults harden every invoked skill, trusted or not (both toggleable in
**Settings → Skills**):

- **External-link warnings** (`skillExternalLinkWarnings`, default on). At
  registry-load time each `SKILL.md` is scanned for external `http(s)` hosts
  (`extract-skill-links.ts`); the de-duplicated host list rides on
  `SkillMetadata`/`SkillSummary` (`externalLinks`). When the user invokes a skill
  that references external hosts, the renderer surfaces an up-front toast
  (`input-bar.ts`) and the system prompt tags the skill body with an
  `EXTERNAL LINKS:` notice plus guidance that any fetch/install/run-from-network
  step is approval-gated and must not exfiltrate workspace contents or secrets
  (`skill-prompt.ts`).
- **Sandbox confinement reminder** (`skillSandboxGuidance`, default on). The
  invoked-skills block states that skill shell commands run inside the macOS
  project sandbox (no network, no out-of-workspace FS), and — where no OS sandbox
  is active (Linux/Windows, or ASRT init failed) — that the only boundary is
  approval, so network/install/out-of-workspace commands must be surfaced rather
  than auto-run. The live sandbox state is read via a native-free flag
  (`project-sandbox/state.ts`) so the prompt builder doesn't pull the seatbelt/
  pty native modules. This is steering layered on top of the real boundary
  (`decideShellPermission` + the seatbelt sandbox), not a new boundary itself.

## Remaining phased plan

### Phase 2 — Harden MCP server launching (highest RCE severity)

- Require MCP `command`/`args` to be reviewed/approved before first spawn;
  remember per-server approval (mirrors the MCP tool-permission model). _Owned
  by #100 (trust gate)._
- Discourage `npx -y`/`uvx` latest-fetch in `mcp.json.example`; recommend pinned
  versions or pre-installed local binaries.
- Distinguish project-local vs user-global config trust on first use.
- Consider running stdio MCP servers inside the project sandbox where feasible.

### Phase 3 — Harden the app's own build & dependencies

- Enforce `npm ci` (lockfile-exact) in CI; verify `package-lock.json` integrity
  hashes.
- Pin `fetch-gortex` downloads to a SHA-256 checksum (verify after download),
  not just a version tag. The committed gortex hashes are recorded from the
  release's Sigstore-signed `checksums.txt`.
- Replace `npx electron-rebuild` in postinstall with a pinned devDependency
  invocation; audit all lifecycle scripts.
- CI runs `npm audit --audit-level=high` against the lockfile-exact dependency
  tree. CodeQL analyzes JavaScript/TypeScript and the checksum-pinned, open-source
  gitleaks CLI scans repository history on GitHub-hosted runners, including fork
  pull requests without secrets. The CLI path avoids gitleaks-action's separate
  organization-repository license requirement.
  Add Dependabot/Renovate and consider `--ignore-scripts` for CI installs.
- Evaluate npm provenance / `npm audit signatures`.

### Phase 4 — Defense in depth & observability

- Log every agent-initiated install and MCP spawn (package, version, registry,
  exit) to the thread for an audit trail.
- Add an offline / "no new dependencies" mode that hard-blocks package-manager
  network fetches during a session.
- Document residual risk: the heuristic classifier is bypassable, so the seatbelt
  sandbox + network egress controls remain the real boundary on macOS; track an
  equivalent for Linux/Windows.

## Residual risk

`shell-scope.ts` and `safe-install.ts` are best-effort heuristics, **not**
security boundaries — substitution, encoding, and uncommon tools can evade them
(see the file-level docstrings). They reduce obvious silent auto-runs and surface
risky operations for approval; the macOS seatbelt sandbox and network egress
controls remain the real confinement.
