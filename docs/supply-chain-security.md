# Supply-chain & untrusted-input hardening

Copse is an Electron AI coding assistant whose agent can execute shell commands
and spawn MCP servers on the user's machine. Package managers (`npm`/`pnpm`/
`yarn`/`bun`, `pip`/`uv`, `cargo`, `gem`, `brew`, `apt`, and ephemeral runners
like `npx`/`uvx`/`pipx run`) and auto-discovered skills/MCP configs are therefore
a meaningful supply-chain and prompt-injection attack surface. This note records
the trust boundaries, the policy per surface, and the phased plan (tracking
issues #128 and #174).

## Trust boundaries

| Surface                            | Where                                                                                                   | Trust                                                                                                                 | Real boundary                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Agent `run_shell` package installs | `src/main/tools/shell-tool.ts`, `src/main/services/shell-scope.ts`, `src/main/services/safe-install.ts` | Untrusted (agent-emitted)                                                                                             | macOS seatbelt sandbox; prompt + Socket Firewall elsewhere                                 |
| MCP stdio/http servers             | `src/main/services/mcp-registry.ts`, `mcp.json`                                                         | Project-local config is **attacker-controllable** (a cloned repo can ship `.mcp.json`); user-global config is trusted | Per-server trust gate (tracked in #100), env-interpolation allowlist                       |
| Auto-discovered skills             | `src/main/services/skills-registry.ts`, `parse-skill-frontmatter.ts`, `skill-prompt.ts`                 | `user` source = trusted; `project`/`plugin`/`plugin-path` = **untrusted**                                             | Frontmatter is parsed defensively; untrusted skill text is delimited as data in the prompt |
| App's own build/install chain      | `package.json` scripts, `scripts/postinstall-native.mts`, `scripts/fetch-codesearch.mts`                | Build-time                                                                                                            | Lockfile + pinning (phase 3)                                                               |

### Policy axis per surface

- **Agent package installs** — _prompt on all platforms_ (do not rely on the
  macOS seatbelt alone). Detected installs are additionally routed through
  Socket Firewall with install lifecycle scripts disabled
  (`npm_config_ignore_scripts`) for JS managers (`safe-install.ts`).
- **MCP project-local config** — _prompt on first use_ (owned by #100's trust
  gate); env interpolation from project configs uses an empty allowlist so a
  cloned repo cannot read process env into a server's `url`/`headers`/`args`/`env`.
- **Untrusted skills** — _delimit as data, never as authoritative instructions_;
  the "treat the invoked skill as the primary task / follow its instructions"
  directive is scoped to **trusted** (user-installed) skills only.
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
  precedence over anything embedded in an untrusted `<skill_content>`. The
  blanket "follow its instructions" directive applies only to trusted skills.

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
- Pin `fetch-codesearch` downloads to a SHA-256 checksum (verify after
  download), not just a version tag.
- Replace `npx electron-rebuild` in postinstall with a pinned devDependency
  invocation; audit all lifecycle scripts.
- Add a CI gate: `npm audit --audit-level=high` (or `osv-scanner`/`socket`),
  Dependabot/Renovate, and consider `--ignore-scripts` for CI installs.
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
