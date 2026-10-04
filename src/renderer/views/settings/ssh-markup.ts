import type { SettingField } from './fields.ts'

export const sshMarkup = `
          <section class="settings-section" data-section="ssh">
            <h3>SSH</h3>
            <p class="settings-section-desc">
              Work on a remote Linux machine over SSH. Commands, git, search, and files all run
              there while Copse stays on your desktop.
            </p>
            <div id="settings-ssh-workspace-host" class="settings-mount"></div>

            <fieldset>
              <legend>Agents on the remote machine</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="acpOverSshEnabled" />
                Run agents on the remote machine (experimental)
              </label>
              <p class="field-hint">
                When a project is on a remote machine, start the agent there, next to the code,
                instead of leaving it unavailable. If the agent is not installed there, Copse asks
                before installing it; you sign in on that machine yourself.
              </p>
            </fieldset>
          </section>
`

export const sshFields: readonly SettingField[] = [
  { name: 'acpOverSshEnabled', kind: 'checkbox', default: false, save: true },
]
