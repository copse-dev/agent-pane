import type { SettingsSnapshot, SettingsUpdate } from '@shared/settings-contract.ts'
import type { AppStore } from '@shared/store/store.ts'
import {
  isThemePreference,
  DEFAULT_THEME_PREFERENCE,
  isRightPanelPosition,
} from '@shared/types/state.ts'
import { isAppIconVariant, DEFAULT_APP_ICON_VARIANT } from '@shared/app-icon-variants.ts'
import { clampUiScale, normalizeUiScale } from '@shared/ui-scale.ts'
import { resolveTheme } from '../../dom/theme.ts'
import { applyUiScale } from '../../dom/ui-scale.ts'
import { inputControl, selectControl, formDataString } from './fields.ts'
import {
  applyUiAccent,
  applyUiTint,
  HEX_COLOR,
  TINT_STRENGTH_LABELS,
  tintSliderIndex,
  tintStrengthFromValue,
} from './appearance.ts'
import {
  DEFAULT_ACCENT_COLOR,
  DEFAULT_TINT_COLOR,
  DEFAULT_TINT_STRENGTH,
  isUiTintStrength,
  type UiTintStrength,
} from '@shared/appearance.ts'

interface Preview {
  theme: 'light' | 'dark'
  accentColor: string
  tintColor: string
  tintStrength: UiTintStrength
}
export interface AppearanceSection {
  begin(): void
  load(snapshot: SettingsSnapshot): void
  collect(data: FormData, dirty: ReadonlySet<string>): SettingsUpdate
  commit(changes: SettingsUpdate): void
  rollback(): void
}

export function createAppearanceSection(
  form: HTMLFormElement,
  store: AppStore,
  markDirty: (name: string) => void,
): AppearanceSection {
  let baseline: Preview | null = null
  function current(): Preview {
    const root = document.documentElement
    const accent = root.style.getPropertyValue('--accent-color').trim()
    const tint = root.style.getPropertyValue('--tint-hue').trim()
    const strength = root.dataset['tintStrength']
    return {
      theme: store.getState().theme,
      accentColor: HEX_COLOR.test(accent) ? accent : DEFAULT_ACCENT_COLOR,
      tintColor: HEX_COLOR.test(tint) ? tint : DEFAULT_TINT_COLOR,
      tintStrength: isUiTintStrength(strength) ? strength : DEFAULT_TINT_STRENGTH,
    }
  }
  function apply(value: Preview): void {
    document.documentElement.dataset['theme'] = value.theme
    if (store.getState().theme !== value.theme) {
      store.setState({ theme: value.theme })
      store.emit('theme_changed', value.theme)
    }
    applyUiAccent(value.accentColor)
    applyUiTint(value.tintColor, value.tintStrength)
  }
  function preview(): void {
    const theme = selectControl(form, 'theme').value
    const strength = tintStrengthFromValue(inputControl(form, 'uiTintStrength').value)
    const output = form.querySelector<HTMLOutputElement>('output[for="uiTintStrength"]')
    if (output) output.textContent = TINT_STRENGTH_LABELS[strength]
    apply({
      theme: resolveTheme(isThemePreference(theme) ? theme : DEFAULT_THEME_PREFERENCE),
      accentColor: inputControl(form, 'uiAccentColor').value,
      tintColor: inputControl(form, 'uiTintColor').value,
      tintStrength: strength,
    })
  }
  for (const name of ['theme', 'uiAccentColor', 'uiTintColor', 'uiTintStrength']) {
    const control = form.elements.namedItem(name)
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement))
      throw new Error(`Missing Appearance control ${name}`)
    const onPreview = (): void => {
      markDirty(name)
      preview()
    }
    control.addEventListener('input', onPreview)
    control.addEventListener('change', onPreview)
  }
  return {
    begin(): void {
      baseline = current()
    },
    load(snapshot): void {
      const state = store.getState()
      selectControl(form, 'theme').value = snapshot.theme ?? state.themePreference
      inputControl(form, 'fontSize').value = String(snapshot.fontSize ?? state.fontSize)
      inputControl(form, 'uiScale').value = String(snapshot.uiScale ?? state.uiScale)
      inputControl(form, 'autoPortraitRightPanel').checked =
        snapshot.autoPortraitRightPanel ?? state.autoPortraitRightPanel
      selectControl(form, 'rightPanelPosition').value =
        snapshot.rightPanelPosition ?? state.rightPanelPosition
      inputControl(form, 'uiAccentColor').value = snapshot.uiAccentColor ?? DEFAULT_ACCENT_COLOR
      inputControl(form, 'uiTintColor').value = snapshot.uiTintColor ?? DEFAULT_TINT_COLOR
      const strength = snapshot.uiTintStrength ?? DEFAULT_TINT_STRENGTH
      inputControl(form, 'uiTintStrength').value = String(tintSliderIndex(strength))
      const output = form.querySelector<HTMLOutputElement>('output[for="uiTintStrength"]')
      if (output) output.textContent = TINT_STRENGTH_LABELS[strength]
      const icon = snapshot.appIconVariant ?? DEFAULT_APP_ICON_VARIANT
      const radio = form.querySelector<HTMLInputElement>(
        `input[name="appIconVariant"][value="${icon}"]`,
      )
      if (radio) radio.checked = true
    },
    collect(data, dirty): SettingsUpdate {
      const theme = data.get('theme'),
        panel = data.get('rightPanelPosition'),
        icon = data.get('appIconVariant')
      return {
        ...(dirty.has('theme') && isThemePreference(theme) ? { theme } : {}),
        ...(dirty.has('fontSize') ? { fontSize: Number(formDataString(data, 'fontSize')) } : {}),
        ...(dirty.has('uiScale')
          ? { uiScale: clampUiScale(Number(formDataString(data, 'uiScale'))) }
          : {}),
        ...(dirty.has('autoPortraitRightPanel')
          ? { autoPortraitRightPanel: data.has('autoPortraitRightPanel') }
          : {}),
        ...(dirty.has('rightPanelPosition') && isRightPanelPosition(panel)
          ? { rightPanelPosition: panel }
          : {}),
        ...(dirty.has('uiAccentColor')
          ? { uiAccentColor: formDataString(data, 'uiAccentColor') }
          : {}),
        ...(dirty.has('uiTintColor') ? { uiTintColor: formDataString(data, 'uiTintColor') } : {}),
        ...(dirty.has('uiTintStrength')
          ? { uiTintStrength: tintStrengthFromValue(data.get('uiTintStrength')) }
          : {}),
        ...(dirty.has('appIconVariant') && isAppIconVariant(icon) ? { appIconVariant: icon } : {}),
      }
    },
    commit(changes): void {
      const state = store.getState(),
        rendered = current()
      const themePreference = changes.theme ?? state.themePreference
      const uiScale = changes.uiScale ?? normalizeUiScale(state.uiScale)
      store.setState({
        themePreference,
        theme: resolveTheme(themePreference),
        fontSize: changes.fontSize ?? state.fontSize,
        uiScale,
        autoPortraitRightPanel: changes.autoPortraitRightPanel ?? state.autoPortraitRightPanel,
        rightPanelPosition: changes.rightPanelPosition ?? state.rightPanelPosition,
      })
      apply({
        theme: resolveTheme(themePreference),
        accentColor: changes.uiAccentColor ?? rendered.accentColor,
        tintColor: changes.uiTintColor ?? rendered.tintColor,
        tintStrength: changes.uiTintStrength ?? rendered.tintStrength,
      })
      applyUiScale(uiScale)
      baseline = null
    },
    rollback(): void {
      if (baseline) apply(baseline)
      baseline = null
    },
  }
}
