// Static markup for the settings dialog. Kept separate from settings-dialog.ts
// so that file stays focused on load/save behavior and event wiring. Selects are
// populated and inputs are filled at runtime; this is just the structure.
export const SETTINGS_DIALOG_HTML = `
    <div class="settings-shell">
      <header class="settings-header">
        <h2>Settings</h2>
        <button type="button" class="settings-close-btn" id="settings-close" aria-label="Close settings">✕</button>
      </header>

      <div class="settings-body">
        <nav class="settings-nav" aria-label="Settings sections">
          <button type="button" class="settings-nav-btn active" data-section="general">General</button>
          <button type="button" class="settings-nav-btn" data-section="local-models">Local models</button>
          <button type="button" class="settings-nav-btn" data-section="appearance">Appearance</button>
        </nav>

        <form class="settings-content">
          <section class="settings-section active" data-section="general">
            <h3>General</h3>
            <p class="settings-section-desc">Cloud API keys and the default chat model for new conversations.</p>

            <fieldset>
              <legend>API Keys</legend>
              <label>
                Anthropic API key
                <input type="password" name="anthropicKey" placeholder="sk-ant-…" autocomplete="off" />
                <span class="key-status" data-key="anthropic"></span>
              </label>
              <label>
                OpenAI API key
                <input type="password" name="openaiKey" placeholder="sk-…" autocomplete="off" />
                <span class="key-status" data-key="openai"></span>
              </label>
            </fieldset>

            <fieldset>
              <legend>Chat model</legend>
              <label>
                Default model
                <select name="model"></select>
              </label>
            </fieldset>
          </section>

          <section class="settings-section" data-section="local-models">
            <h3>Local models</h3>
            <p class="settings-section-desc">
              Connect to an LM Studio (or other OpenAI-compatible) server and route different tasks to
              specific local models.
            </p>

            <fieldset>
              <legend>Server connection</legend>
              <label>
                Server URL
                <input type="text" name="lmStudioUrl" placeholder="http://localhost:1234/v1" autocomplete="off" />
              </label>
              <label>
                API key (only if your server requires one)
                <input type="password" name="lmStudioKey" placeholder="leave blank if disabled" autocomplete="off" />
                <span class="key-status" data-key="lmstudio"></span>
              </label>
              <div class="lmstudio-test-row">
                <button type="button" id="lmstudio-test-btn">Test connection</button>
                <span class="lmstudio-test-status" id="lmstudio-test-status"></span>
              </div>
              <p class="field-hint">
                Agent history trimming uses each loaded model’s context length when LM Studio reports it
                via the models API; otherwise 8192 tokens.
              </p>
            </fieldset>

            <fieldset>
              <legend>Model routing</legend>
              <p class="settings-fieldset-desc">
                Choose which loaded model handles each task. Leave a route on “auto” to use the first model
                the server reports.
              </p>
              <label>
                Default local model
                <select name="lmStudioModel"></select>
                <span class="field-hint">Fallback when a local model is selected in chat but not specified</span>
              </label>
              <label>
                Small tasks model
                <select name="lmStudioSmallTasksModel"></select>
                <span class="field-hint">Thread title generation and other lightweight prompts</span>
              </label>
              <label>
                Instruct / safety model
                <select name="lmStudioSafetyModel"></select>
                <span class="field-hint">Classifies shell commands when the OS sandbox is off</span>
              </label>
            </fieldset>

            <fieldset>
              <legend>Routing behavior</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="lmStudioForSmallTasks" />
                Use local models for small tasks (e.g. naming threads)
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="lmStudioSafetyEnabled" />
                Use instruct model to classify shell commands (when OS sandbox is off)
              </label>
              <label>
                Safety confidence threshold
                <input
                  type="number"
                  name="lmStudioSafetyConfidenceThreshold"
                  min="0"
                  max="1"
                  step="0.05"
                />
                <span class="field-hint">Auto-allow sandbox-scoped commands at or above this confidence (0–1)</span>
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="autoRunSandboxCommands" />
                Auto-run shell commands contained within the sandbox
              </label>
            </fieldset>
          </section>

          <section class="settings-section" data-section="appearance">
            <h3>Appearance</h3>
            <p class="settings-section-desc">Theme and editor font size.</p>

            <fieldset>
              <legend>Display</legend>
              <label>
                Theme
                <select name="theme">
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </label>
              <label>
                Font size
                <input type="number" name="fontSize" min="12" max="20" step="1" />
              </label>
            </fieldset>
          </section>

          <div class="settings-buttons">
            <button type="submit">Save</button>
            <button type="button" id="settings-cancel">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  `
