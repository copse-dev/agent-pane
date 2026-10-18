import type { SettingField } from './fields.ts'

import {
  GIT_ATTRIBUTION_SETTING,
  DEFAULT_GIT_ATTRIBUTION_ENABLED,
} from '@shared/git/commit-attribution.ts'
import {
  GIT_THREAD_LINK_SETTING,
  DEFAULT_GIT_THREAD_LINK_ENABLED,
} from '@shared/git/thread-link.ts'

export const agentMarkup = `
          <section class="settings-section" data-section="agent">
            <h3>Agent</h3>
            <p class="settings-section-desc">
              Standing instructions for every conversation, the helpers the agent leans on, and the
              skills it can run.
            </p>

            <fieldset>
              <legend>Instructions</legend>
              <label>
                Custom instructions
                <textarea
                  name="customInstructions"
                  rows="4"
                  placeholder="Always-on guidance added to every conversation (e.g. preferred style, conventions)."
                ></textarea>
                <span class="field-hint">
                  Added to every conversation, in every project. A project
                  <code>AGENT.md</code>, <code>AGENTS.md</code>, or <code>CLAUDE.md</code> adds
                  instructions for that project on top of this.
                </span>
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="externalApiSafety" />
                Steer the agent toward safe API usage
              </label>
              <p class="field-hint">
                Reminds the agent to pick compatible dependency versions and never hardcode or log
                secrets when it adds an API call.
              </p>
            </fieldset>

            <fieldset>
              <legend>Helpers</legend>
              <p class="settings-fieldset-desc">
                Extra models the agent can hand work to, so the main model stays focused on the
                task and cheap work stays cheap.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="subagentsEnabled" />
                Hand reading and searching to an exploration helper
              </label>
              <p class="field-hint">
                When on, the main model asks a helper to explore the code and report back a
                summary. When off (the default) it reads and searches the files itself, which
                keeps more detail in view.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="localSubagentsEnabled" />
                Use a model on this machine for exploration when the chat model is in the cloud
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="localTodoItemsEnabled" />
                Use a model on this machine for to-do items marked as local
              </label>
              <label>
                Skip the post-turn review below this many changed lines (1 = only skip an empty
                change, 0 = always review)
                <input
                  type="number"
                  name="postTurnReviewMinChangedLines"
                  min="0"
                  step="1"
                  class="settings-number-input"
                />
              </label>
              <p class="field-hint">
                Turn the review itself on or off under <strong>Plugins</strong>. If it runs on a paid
                model you are asked to approve the spend once per chat; choose a model on this
                machine to review for free.
              </p>
            </fieldset>

            <fieldset>
              <legend>Skills</legend>
              <p class="settings-fieldset-desc">
                Reusable workflows you invoke with <code>/skill-name</code> in the chat input.
                Copse ships a set of them, and each project can add its own.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="bundledCursorSkillsEnabled" />
                Include the skills that ship with Copse (CI, code review, verification, and more)
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="skillExternalLinkWarnings" />
                Warn before running a skill that points at the web
              </label>
              <p class="field-hint">
                When a skill you invoke links to a website, say so up front and require approval
                before the agent fetches, installs, or runs anything from it.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="skillSandboxGuidance" />
                Keep a skill's commands inside the project
              </label>
              <p class="field-hint">
                Reminds the agent that a skill's commands stay inside the project folder, or need
                approval where that cannot be enforced, rather than quietly reaching the network or
                the rest of your machine.
              </p>
            </fieldset>

            <fieldset data-testid="git-attribution-settings">
              <legend>Git attribution</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="${GIT_ATTRIBUTION_SETTING}" />
                Credit Copse on commits and pull requests
              </label>
              <p class="field-hint">
                Adds Copse as a co-author and lists the models used when Copse creates a commit or
                pull request. On by default. Turn off to keep your message and description as written.
              </p>
            </fieldset>

            <div id="settings-gh-cli-host" class="settings-mount"></div>
            <fieldset data-testid="git-thread-link-settings">
              <legend>Thread links</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="${GIT_THREAD_LINK_SETTING}" />
                Link commits and pull requests back to their Copse thread
              </label>
              <p class="field-hint">
                Adds a public link containing an opaque thread ID, independently of attribution.
                The conversation stays on your device. Links only open where that thread exists.
                Off by default.
              </p>
            </fieldset>
          </section>
`

export const agentFields: readonly SettingField[] = [
  { name: 'customInstructions', kind: 'text', default: '', save: true },
  { name: 'externalApiSafety', kind: 'checkbox', default: false, save: true },
  {
    name: GIT_ATTRIBUTION_SETTING,
    kind: 'checkbox',
    default: DEFAULT_GIT_ATTRIBUTION_ENABLED,
    save: true,
  },
  {
    name: GIT_THREAD_LINK_SETTING,
    kind: 'checkbox',
    default: DEFAULT_GIT_THREAD_LINK_ENABLED,
    save: true,
  },
  { name: 'localSubagentsEnabled', kind: 'checkbox', default: true, save: true },
  {
    name: 'subagentsEnabled',
    kind: 'checkbox',
    default: false,
    save: true,
  },
  { name: 'localTodoItemsEnabled', kind: 'checkbox', default: true, save: true },
  { name: 'postTurnReviewMinChangedLines', kind: 'number', default: 1, save: true },
  { name: 'bundledCursorSkillsEnabled', kind: 'checkbox', default: true, save: true },
  { name: 'skillExternalLinkWarnings', kind: 'checkbox', default: true, save: true },
  { name: 'skillSandboxGuidance', kind: 'checkbox', default: true, save: true },
]
