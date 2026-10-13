import type { SettingField } from './fields.ts'

import { CURSOR_AGENTS_WEB_URL } from '@shared/remote-agent.ts'
export const generalMarkup = `
          <section class="settings-section active" data-section="general">
            <h3>General</h3>
            <p class="settings-section-desc">
              What Copse detected on this machine, the providers it can send work to, and the
              models it picks by default.
            </p>

            <!-- JS-mounted panels sit in a host <div>. Any such host that holds a
                 top-level panel MUST carry class="settings-mount" so its injected
                 fieldset gets the same inter-panel spacing as inline ones: see the
                 .settings-section > .settings-mount > fieldset rule in settings.css. -->
            <div id="settings-env-detect-host" class="settings-mount"></div>

            <div id="settings-providers-host" class="settings-mount"></div>

            <fieldset id="settings-models-section" data-testid="settings-chat-model">
              <legend>Models</legend>
              <p class="settings-fieldset-desc">
                Choose the main chat model and the models used for background tasks. The defaults
                prefer a model running on this machine, but anything from a provider you have set
                up can be selected.
              </p>
              <label>
                Chat model
                <select name="model"></select>
                <span class="field-hint">
                  Default is <strong>Best value (plan / price)</strong>: each new chat window picks
                  the model that gives the most for what it costs on your plan, and sends the turn
                  to that provider. You can pin a specific model here instead, or from the picker
                  beside the chat box. Picking a cloud agent sends each turn to that provider's
                  machines rather than running it here; set one up under Providers.
                </span>
              </label>
              <label>
                Small tasks
                <select name="smallTasksModel"></select>
                <span class="field-hint">
                  Lightweight prompts such as thread titles and follow-up suggestions. Auto prefers
                  an on-device model, then falls back to the chat model.
                </span>
              </label>
              <div id="settings-model-maker-block-host"></div>
              <div id="settings-model-parameters-host"></div>
              <div id="settings-model-routing-host"></div>
            </fieldset>

            <!-- Cloud-agent pieces the Providers panel relocates into whichever
                 provider offers one. The shared run options move with them but stay
                 inside this form either way, so their values always round-trip. -->
            <div id="settings-cloud-agent-templates" hidden>
              <div id="settings-cursor-panel" class="remote-agent-panel">
                <div id="settings-cursor-key-host"></div>
                <p class="field-hint" data-testid="cursor-agents-list-hint">
                  Runs Copse starts belong to this key, so they stay hidden on
                  <a href="${CURSOR_AGENTS_WEB_URL}" target="_blank" rel="noopener noreferrer">cursor.com/agents</a>
                  until you enable <strong>Filter → Source → API</strong> there. Follow-along links
                  in the chat always open the run directly.
                </p>
              </div>
              <div id="settings-claude-panel" class="remote-agent-panel">
                <div id="settings-claude-agent-key-host"></div>
                <p class="field-hint">
                  The Claude cloud agent needs an Anthropic API key plus a GitHub token. The token
                  is only used to clone the repository and push branches; the agent never sees it.
                </p>
              </div>
              <div id="settings-cloud-agent-options">
                <p class="settings-fieldset-desc remote-agent-common-note">
                  A cloud agent runs the whole turn on the provider's machines. The conversation
                  streams back here as normal, but the work happens there: it runs its own tools and
                  pushes commits to a branch on this project's <code>origin</code> repository,
                  branching from your current branch. It never edits the files in this folder, so
                  review its changes in the branch or pull request it links in the reply.
                </p>
                <label class="checkbox-label">
                  <input type="checkbox" name="remoteAgentAutoCreatePR" />
                  Open a pull request automatically when the cloud agent finishes
                </label>
                <label class="checkbox-label">
                  <input type="checkbox" name="remoteAgentWorkOnCurrentBranch" />
                  Push directly to the current branch instead of a new branch
                </label>
                <label class="checkbox-label">
                  <input type="checkbox" name="preferAcpOverCloudAgent" />
                  Offer to switch to Claude on this machine when the cloud agent can’t run (bad key
                  or no credit)
                </label>
              </div>
            </div>
          </section>
`

export const generalFields: readonly SettingField[] = [
  { name: 'remoteAgentAutoCreatePR', kind: 'checkbox', default: true, save: true },
  { name: 'remoteAgentWorkOnCurrentBranch', kind: 'checkbox', default: false, save: true },
  { name: 'preferAcpOverCloudAgent', kind: 'checkbox', default: true, save: true },
]
