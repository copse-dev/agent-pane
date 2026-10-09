import type { SettingField } from './fields.ts'
import { DEVELOPER_MODE_SETTING } from '@shared/developer-mode.ts'

export const experimentalMarkup = `
          <section class="settings-section" data-section="experimental">
            <h3>Experimental</h3>
            <p class="settings-section-desc">
              Early, opt-in features that are still being explored. They may change or be removed,
              and are off by default.
            </p>

            <fieldset id="animated-explainers-settings">
              <legend>Animated explainers</legend>
              <p class="field-hint">
                Ask “explain X” in a chat to get a captioned animation. Copse chooses a style,
                writes the captions and checks the result before sharing it. Playback is silent;
                creation can take a few minutes.
              </p>
              <p class="field-hint">
                Turn on Canvas and explainers, then enable Animated explainers in its plugin settings.
              </p>
              <div class="settings-action-row">
                <button type="button" class="ui-btn ui-btn-secondary" id="animated-explainers-manage">
                  Open explainer settings…
                </button>
              </div>
            </fieldset>

            <fieldset>
              <legend>Mobile Companion</legend>
              <p class="field-hint">
                Open your Copse threads from a phone on the same local network. Choose the network
                interface your phone uses, pair phones, or turn sharing off. Copse must stay open
                and this computer must stay awake.
              </p>
              <div class="settings-action-row">
                <button type="button" class="ui-btn ui-btn-secondary" id="mobile-companion-manage">
                  Set up or manage…
                </button>
              </div>
            </fieldset>

            <fieldset>
              <legend>Remote desktop viewer</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="vncEnabled" />
                Show the Desktop pane
              </label>
              <p class="field-hint">
                View a VNC desktop on this machine, on a saved SSH machine, or found nearby on your
                network, plus booted iOS Simulators and Android emulators. Connections start
                view-only; turn on control to send keyboard and pointer input. Clipboard is not
                shared.
              </p>
            </fieldset>

            <fieldset>
              <legend>Next-step tab complete</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="nextStepSuggestionEnabled" />
                Offer an obvious next step in the message box after each turn
              </label>
              <p class="field-hint">
                When a turn ends with one clearly valuable next move, it appears as placeholder
                text in the message box, press Tab to accept it, or just type to ignore it.
                Uses the small-tasks model; most turns show nothing.
              </p>
            </fieldset>

            <fieldset>
              <legend>Concise threads</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="conciseThreadsEnabled" />
                Show only the results of turns from highly capable models
              </label>
              <p class="field-hint">
                For models scoring above 50 on the Artificial Analysis Intelligence Index, the
                thread shows screenshots and the closing summary. Tool calls, reasoning, and the
                tool errors the model recovers from stay hidden; while it works, you see what it
                is doing now. Other models always show the full thread.
              </p>
            </fieldset>

            <fieldset>
              <legend>Deferred worktrees</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="deferredWorktreesEnabled" />
                Create a worktree only when the agent needs to write
              </label>
              <p class="field-hint">
                Applies across Copse to new threads using automatic checkout. Eligible agents
                start by reading your checkout without changing it, then get an isolated worktree
                before writing. Explicit worktree choices and agents installed on this device still create one up front.
                Projects with worktrees disabled and existing threads keep their checkout behavior.
              </p>
            </fieldset>

            <fieldset>
              <legend>Unattended container runs</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="containerRunsEnabled" />
                Let a thread run unattended inside a disposable Docker container
              </label>
              <p class="field-hint">
                Adds "Run unattended in a container" to the message box menu. The run works on a
                snapshot of the thread's checkout with no prompts and brings its commits back for
                you to apply. Its network reaches only its model's origin, plus, when the run
                installs dependencies (on by default, per run), the npm registry, GitHub and
                Electron's download hosts. Needs Docker; the first run builds the worker image. A
                run carries one credential: the model's API key, or, if you opt in per run, your
                Codex or Gemini sign-in copied into the container.
              </p>
            </fieldset>

            <fieldset>
              <legend>Model classifier</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="modelClassifierEnabled" />
                Let the agent get a best-fit model recommendation for a task
              </label>
              <p class="field-hint">
                Lets the agent judge how hard a task is and name a model that suits it, so simple
                work goes to a cheap, fast model and the hard problems get a top one. Advice only:
                it never switches the model you are using.
              </p>
            </fieldset>

            <fieldset>
              <legend>Delegating steps</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="orchestrationStrategyEnabled" />
                Let the agent hand implementation steps to a cheaper model
              </label>
              <p class="field-hint">
                The opposite of the advisor: your chat model plans the work and passes each step,
                with the context it needs, to a cheaper and faster model that does the editing.
                Every step comes back with a report and a summary of what changed, so the chat
                model can review it before moving on.
              </p>
              <label class="field-label" for="orchestrationWorkerModel">Worker model</label>
              <select id="orchestrationWorkerModel" name="orchestrationWorkerModel">
                <option value="">(loading…)</option>
              </select>
              <p class="field-hint">
                How to choose the model that carries out the delegated steps, resolved against
                your configured providers each time a step is handed off. Prefer a rule that lands
                cheaper and faster than your chat model.
              </p>
            </fieldset>

            <fieldset>
              <legend>Developer mode</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="developerMode" />
                Enable developer mode
              </label>
              <p class="field-hint">
                Shows Hooks in Sources, the conversation diagnostics menu, and View &gt; Developer
                Tools. The optional <code>Ctrl+Shift+I</code> shortcut is a separate plugin.
              </p>
            </fieldset>

            <fieldset id="experimental-plugins-fieldset" hidden>
              <legend>Experimental plugins</legend>
              <p class="settings-fieldset-desc">
                Plugins whose behavior and compatibility may change. These are also available
                under Customise. Changes here apply immediately.
              </p>
              <span class="lmstudio-test-status plugins-load-status" role="status"></span>
              <div id="experimental-plugins-list" class="plugins-group">
                <span class="plugins-empty">Loading…</span>
              </div>
            </fieldset>
          </section>
`

export const experimentalFields: readonly SettingField[] = [
  { name: 'vncEnabled', kind: 'checkbox', default: false, save: true },
  { name: 'modelClassifierEnabled', kind: 'checkbox', default: false, save: true },
  { name: 'nextStepSuggestionEnabled', kind: 'checkbox', default: false, save: true },
  { name: 'deferredWorktreesEnabled', kind: 'checkbox', default: false, save: true },
  { name: 'conciseThreadsEnabled', kind: 'checkbox', default: false, save: true },
  { name: 'containerRunsEnabled', kind: 'checkbox', default: false, save: true },
  { name: 'orchestrationStrategyEnabled', kind: 'checkbox', default: false, save: true },
  { name: DEVELOPER_MODE_SETTING, kind: 'checkbox', default: false, save: true },
]
