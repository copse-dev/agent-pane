import type { SettingField } from './fields.ts'

import {
  SHARE_TERMINAL_HISTORY_ENABLED_SETTING,
  SHARE_TERMINAL_HISTORY_ENABLED_DEFAULT,
} from '@shared/terminal/terminal-history.ts'

import { AUTO_APPROVAL_LEVELS, AUTO_APPROVAL_LEVEL_LABELS } from '@shared/auto-approval.ts'
export const permissionsMarkup = `
          <section class="settings-section" data-section="permissions">
            <h3>Permissions</h3>
            <p class="settings-section-desc">
              What the agent is allowed to do without stopping to ask you.
            </p>

            <fieldset id="tool-permissions-fieldset">
              <legend>Tool permissions</legend>
              <p class="settings-fieldset-desc">
                Choose whether each Copse or MCP tool runs automatically, asks every time, or is
                blocked. These choices apply to future calls; they do not interrupt completed work.
              </p>
              <div id="tool-permissions-host"></div>
            </fieldset>

            <fieldset>
              <legend>Shell commands</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="autoRunSandboxCommands" />
                Run commands without asking when they stay inside the project folder
              </label>
              <label>
                Also run recognised low-risk commands without asking
                <select name="shellAutoApprovalLevel">
                  ${AUTO_APPROVAL_LEVELS.map(
                    (level) =>
                      `<option value="${level}">${AUTO_APPROVAL_LEVEL_LABELS[level]}</option>`,
                  ).join('')}
                </select>
                <span class="field-hint">
                  Matches a fixed list of command shapes exactly, never a model's judgement, and
                  never anything it doesn't recognise. Reads cover local queries plus
                  <code>git fetch</code> and <code>gh pr view</code> against a remote this project
                  already has configured; a URL never qualifies. Higher levels add local commits,
                  then <code>git push</code> and <code>gh pr create</code>. Force pushes, deleting
                  branches, installs, <code>npx</code>, project scripts like <code>npm test</code>,
                  and anything containing <code>$(…)</code> always ask. Only applies in a trusted
                  project with the setting above turned on, and only while the project sandbox is
                  running. Without a sandbox, Windows, or if the sandbox failed to start, every
                  recognised shape still asks. At the two write levels
                  <code>git commit</code>, <code>checkout</code> and <code>push</code> run this
                  project's git hooks; the project sandbox contains those.
                </span>
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="safetyClassifierEnabled" />
                Check commands for danger before running them
              </label>
              <label>
                Block outright above this confidence
                <span class="slider-row">
                  <input
                    type="range"
                    name="safetyExternalDenyThreshold"
                    min="0"
                    max="1"
                    step="0.05"
                  />
                  <output class="slider-value" for="safetyExternalDenyThreshold">1.00</output>
                </span>
                <span class="field-hint">
                  Refuse, with no prompt, any command judged this likely to be both dangerous and
                  aimed outside the project. Leave at 1.00 to always ask instead.
                </span>
              </label>
              <label>
                Trusted commands
                <textarea
                  class="settings-code-input"
                  name="trustedShellCommands"
                  rows="5"
                  spellcheck="false"
                  placeholder="xcodebuild"
                ></textarea>
                <span class="field-hint">
                  One command name per line, for tools that are safe but cannot run inside the
                  project folder (for example <code>xcodebuild</code>). These run with no prompt.
                  A line that also does something destructive or reaches the network still asks.
                  Only applies in a project you trust and while the first option above is on.
                </span>
              </label>
              <label>
                Trusted SSH hosts
                <textarea
                  name="trustedSshHosts"
                  rows="3"
                  spellcheck="false"
                  placeholder="build-box.local"
                ></textarea>
                <span class="field-hint">
                  One host name or <code>~/.ssh/config</code> alias per line. In Guarded YOLO,
                  <code>ssh</code>, <code>scp</code>, and <code>rsync</code> to these hosts run
                  without asking; any other host asks first. A destructive remote command still
                  asks.
                </span>
              </label>
            </fieldset>

            <fieldset>
              <legend>File edits</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="acpAutoApproveEditsWithBackup" />
                Let agents on this machine edit files without asking (a backup is taken first)
              </label>
              <p class="field-hint">
                Copse snapshots your uncommitted work before the agent starts, so if an edit
                overwrites something the Changes panel offers a one-click
                <strong>Restore pre-session changes</strong>. Shell commands and web requests still
                ask. Turn off to review every file edit.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="acpAutoApproveNativeBridgeTools" />
                Let agents on this machine use Copse's own tools without asking
              </label>
              <p class="field-hint">
                Copse's tools (GitHub, code search, changes, browser, web fetch) apply their own
                permission checks each time they run, so the extra prompt only asks twice. Turn off
                to be asked anyway.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="worktreeAutoApproveEdits" />
                Skip approval for deletes, renames, and new folders in an isolated worktree
              </label>
              <p class="field-hint">
                A thread on an isolated worktree edits its own checkout on its own branch, your
                files and branch are never touched, so it applies these straight away instead of
                asking. Threads on the shared checkout keep asking. Copse still asks if the file
                changed underneath it or its work could not be backed up. Turn off to review every
                one.
              </p>
            </fieldset>

            <fieldset>
              <legend>Web and terminals</legend>
              <p class="settings-fieldset-desc">
                The agent can only reach the websites listed here. Anything else needs your
                approval first.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="browserToolsEnabled" />
                Let the agent open and screenshot web pages in Copse
              </label>
              <p class="field-hint">
                Uses the browser built into Copse rather than asking you to install a separate one.
                Pages on this machine load straight away; anything else asks.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="readTerminalEnabled" />
                Let the agent read your open Shells tabs
              </label>
              <p class="field-hint">
                When on (the default), the agent can read a Shells tab open in this chat, and you
                can add one to a message with <code>@shell</code>. Turn off to keep your terminals
                private.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="shareTerminalHistoryEnabled" />
                Share command history across the project
              </label>
              <p class="field-hint">
                When on (the default), Bash and Zsh terminals in this project use the same history
                file, so a command from one thread can be recalled in another. Fish keeps its normal
                shell-managed history. Turn off to keep each terminal's history separate.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="webAllowUserApproval" />
                Ask before allowing a new website
              </label>
              <label>
                Allowed websites
                <textarea
                  class="settings-code-input"
                  name="webAllowedOrigins"
                  rows="6"
                  spellcheck="false"
                  placeholder="https://example.com"
                ></textarea>
                <span class="field-hint">
                  One per line. Whole sites work too, such as
                  <code>https://*.duckduckgo.com</code>. This machine and DuckDuckGo are allowed by
                  default.
                </span>
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="providerAllowUserApproval" />
                Ask before allowing a new provider address
              </label>
              <label>
                Allowed provider addresses
                <textarea
                  class="settings-code-input"
                  name="approvedProviderHosts"
                  rows="4"
                  spellcheck="false"
                  placeholder="api.together.xyz"
                ></textarea>
                <span class="field-hint">
                  Host names only, one per line, that a provider you added yourself may use.
                  Built-in providers and this machine are always allowed. Adding a provider prompts
                  you to approve its address while this is on.
                </span>
              </label>
            </fieldset>

            <fieldset>
              <legend>Commit signing</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="gitCommitSshAgentSocketAccess" />
                Enable scoped SSH signing approvals (macOS)
              </label>
              <p class="field-hint">
                Off by default. Copse asks before its system SSH signer uses your configured key
                through ssh-agent. You can remember the signer, key and socket for this project
                until Copse restarts. Changed configuration requires approval again. Git hooks
                keep their project sandbox; they receive no ssh-agent access. Turning this off
                prevents further ssh-agent signing. With this off, a configured private key file
                can be read and used only after a separate approval for each commit. Key contents
                are never sent to the agent. Custom signing programs run with ordinary project
                access. Scoped signing is macOS only.
              </p>
            </fieldset>
          </section>
`

export const permissionsFields: readonly SettingField[] = [
  { name: 'gitCommitSshAgentSocketAccess', kind: 'checkbox', default: false, save: true },
  { name: 'browserToolsEnabled', kind: 'checkbox', default: true, save: true },
  { name: 'readTerminalEnabled', kind: 'checkbox', default: true, save: true },
  {
    name: SHARE_TERMINAL_HISTORY_ENABLED_SETTING,
    kind: 'checkbox',
    default: SHARE_TERMINAL_HISTORY_ENABLED_DEFAULT,
    save: true,
  },
  { name: 'acpAutoApproveEditsWithBackup', kind: 'checkbox', default: true, save: true },
  { name: 'acpAutoApproveNativeBridgeTools', kind: 'checkbox', default: true, save: true },
  { name: 'worktreeAutoApproveEdits', kind: 'checkbox', default: true, save: true },
  { name: 'safetyClassifierEnabled', kind: 'checkbox', default: true, save: false },
  { name: 'autoRunSandboxCommands', kind: 'checkbox', default: true, save: false },
  { name: 'webAllowUserApproval', kind: 'checkbox', default: true, save: false },
  { name: 'providerAllowUserApproval', kind: 'checkbox', default: true, save: false },
  { name: 'safetyExternalDenyThreshold', kind: 'number', default: 1, save: false },
]
