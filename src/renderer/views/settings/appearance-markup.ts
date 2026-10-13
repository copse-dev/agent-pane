import type { SettingField } from './fields.ts'

import { APP_ICON_VARIANTS, APP_ICON_VARIANT_LABELS } from '@shared/app-icon-variants.ts'
export const appearanceMarkup = `
          <section class="settings-section" data-section="appearance">
            <h3>Appearance</h3>
            <p class="settings-section-desc">
              Theme, app icon, interface scale, window layout, and alerts.
            </p>

            <fieldset data-testid="settings-alerts">
              <legend>Alerts</legend>
              <p class="settings-fieldset-desc">
                Choose when Copse should get your attention and how it should alert you. Each
                delivery method is independent.
              </p>
              <span class="settings-field-label">Notify me when</span>
              <label class="checkbox-label">
                <input type="checkbox" name="alertOnInteraction" />
                Thread needs interaction
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="alertOnThreadFinished" />
                Thread finishes
              </label>
              <span class="settings-field-label">Alert me with</span>
              <label class="checkbox-label">
                <input type="checkbox" name="alertSystemNotification" />
                System notification
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="alertSound" />
                Sound
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="alertBounce" />
                Dock or taskbar animation
              </label>
            </fieldset>

            <fieldset data-testid="settings-agent-motion">
              <legend>Agent icons</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="animateAgentAvatars" aria-describedby="agent-motion-hint" />
                Animate agent icons
              </label>
              <p class="field-hint" id="agent-motion-hint">
                Subtle motion while a remote or named agent is working. Turn off to keep the
                icons still. Always respects your system's reduced-motion preference.
              </p>
            </fieldset>

            <fieldset>
              <legend>Display</legend>
              <label>
                Interface scale
                <input type="number" name="uiScale" min="0.75" max="1.5" step="0.05" />
              </label>
              <p class="field-hint">
                Scales UI type and spacing (0.75–1.5). Use ⌘+/- (Ctrl+/-) or ⌘0. Pinch zoom is
                temporary.
              </p>
              <label>
                Editor &amp; terminal font size
                <input type="number" name="fontSize" min="12" max="20" step="1" />
              </label>
              <p class="field-hint">
                Monaco and terminal font size in pixels, applied on top of interface scale.
              </p>
              <label>
                Right panel position
                <select name="rightPanelPosition">
                  <option value="auto">Automatic</option>
                  <option value="side">Beside chat</option>
                  <option value="bottom">Below chat</option>
                </select>
              </label>
              <p class="field-hint">
                Choose where Explorer, Terminal, Changes, and Plan live. "Below chat" keeps the
                terminal wide and readable on smaller screens.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="autoPortraitRightPanel" />
                Move the right panel below chat on tall portrait windows
              </label>
              <p class="field-hint">
                Only applies when the position above is "Automatic": splits portrait windows
                horizontally so Projects and chat stay above Explorer, Terminal, Changes, and Plan.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="openLinksInBuiltInBrowser" />
                Open links in the built-in browser
              </label>
              <p class="field-hint">
                When on, links you click in chat, pull requests, and previews open in Copse's own
                browser pane. Turn off to open them in your usual browser instead; external links
                then show an
                <span class="external-link-hint-icon" aria-hidden="true"></span> icon.
              </p>
            </fieldset>

            <fieldset>
              <legend>Interface colours</legend>
              <p class="settings-fieldset-desc">
                Theme, accent colour, and interface tint. Accent colour is used for links, primary
                buttons, selected items, focus indicators, and your chat messages. Interface tint
                adds a separate, subtle wash through neutral surfaces. Both work in light and dark
                themes.
              </p>
              <label>
                Theme
                <select name="theme">
                  <option value="system">System</option>
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </label>
              <!-- Two swatches, one decision each, read side by side: they are
                   the section's only colour choices and comparing them is the
                   whole task. -->
              <div class="settings-swatch-row">
                <label>
                  Accent colour
                  <input type="color" name="uiAccentColor" />
                </label>
                <label>
                  Interface tint colour
                  <input type="color" name="uiTintColor" />
                </label>
              </div>
              <label>
                Interface tint strength
                <span class="slider-row">
                  <input
                    type="range"
                    name="uiTintStrength"
                    min="0"
                    max="3"
                    step="1"
                    list="tint-strength-levels"
                  />
                  <output class="slider-value" for="uiTintStrength">Subtle</output>
                </span>
                <datalist id="tint-strength-levels">
                  <option value="0" label="Off"></option>
                  <option value="1" label="Subtle"></option>
                  <option value="2" label="Medium"></option>
                  <option value="3" label="Strong"></option>
                </datalist>
              </label>
            </fieldset>

            <fieldset>
              <legend>App icon</legend>
              <p class="settings-fieldset-desc">
                Choose the icon shown in the Dock, taskbar, and window title bar.
              </p>
              <div class="app-icon-picker" role="radiogroup" aria-label="App icon">
                ${APP_ICON_VARIANTS.map(
                  (variant) => `
                <label class="app-icon-option">
                  <input type="radio" name="appIconVariant" value="${variant}" />
                  <span class="app-icon-preview">
                    <img src="./icon-previews/${variant}.png" alt="" width="88" height="88" />
                  </span>
                  <span class="app-icon-label">${APP_ICON_VARIANT_LABELS[variant]}</span>
                </label>`,
                ).join('')}
              </div>
            </fieldset>
          </section>
`

export const appearanceFields: readonly SettingField[] = [
  { name: 'openLinksInBuiltInBrowser', kind: 'checkbox', default: true, save: true },
  { name: 'animateAgentAvatars', kind: 'checkbox', default: true, save: true },
  { name: 'alertOnInteraction', kind: 'checkbox', default: true, save: true },
  { name: 'alertOnThreadFinished', kind: 'checkbox', default: true, save: true },
  { name: 'alertSystemNotification', kind: 'checkbox', default: true, save: true },
  { name: 'alertSound', kind: 'checkbox', default: true, save: true },
  { name: 'alertBounce', kind: 'checkbox', default: true, save: true },
]
