import type { SettingsSnapshot, SettingsUpdate } from '@shared/settings-contract.ts'
type NamesOf<T> = {
  [K in keyof SettingsSnapshot]-?: Exclude<SettingsSnapshot[K], undefined> extends T ? K : never
}[keyof SettingsSnapshot]
export type SettingField =
  | { name: NamesOf<boolean>; kind: 'checkbox'; default: boolean; save: boolean }
  | { name: NamesOf<string>; kind: 'text'; default: string; save: boolean }
  | { name: NamesOf<number>; kind: 'number'; default: number; save: boolean }

export function loadSimpleFields(
  root: HTMLElement,
  fields: readonly SettingField[],
  snapshot: SettingsSnapshot,
): void {
  for (const field of fields) {
    const input = root.querySelector(`[name="${field.name}"]`)
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) {
      throw new Error(`Settings dialog template is missing ${JSON.stringify(field.name)}`)
    }
    const saved = snapshot[field.name]
    if (field.kind === 'checkbox') {
      if (!(input instanceof HTMLInputElement)) {
        throw new Error(`Settings field ${JSON.stringify(field.name)} must be an input`)
      }
      input.checked = typeof saved === 'boolean' ? saved : field.default
    } else {
      input.value =
        typeof saved === 'string' || typeof saved === 'number'
          ? String(saved)
          : String(field.default)
    }
  }
}

/** Parse a `number`-kind field's form value, clamping to a non-negative integer. */
export function parseNonNegativeInt(value: string, fallback: number): number {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * Keep the strict-deny slider's numeric readout in sync as it moves. Called after
 * the generic field load.
 */
export function wireSafetySliders(form: HTMLFormElement): void {
  const externalDeny = form.elements.namedItem('safetyExternalDenyThreshold')
  if (!(externalDeny instanceof HTMLInputElement)) {
    throw new Error('Settings dialog template is missing "safetyExternalDenyThreshold"')
  }

  const bind = (input: HTMLInputElement): void => {
    const output = form.querySelector<HTMLOutputElement>(`output[for="${input.name}"]`)
    if (!output) return
    const sync = (): void => {
      output.textContent = Number(input.value).toFixed(2)
    }
    input.addEventListener('input', sync)
    sync()
  }
  bind(externalDeny)
}

export function collectSimpleFields(
  fields: readonly SettingField[],
  data: FormData,
  dirtyFieldNames: ReadonlySet<string>,
): SettingsUpdate {
  const values: Record<string, unknown> = {}
  for (const field of fields) {
    if (!field.save || !dirtyFieldNames.has(field.name)) continue
    if (field.kind === 'checkbox') values[field.name] = data.get(field.name) === 'on'
    else if (field.kind === 'number')
      values[field.name] = parseNonNegativeInt(formDataString(data, field.name), field.default)
    else {
      const value = formDataString(data, field.name)
      values[field.name] = field.name === 'customInstructions' ? value.trim() : value
    }
  }
  return values
}

/** Read a text field from FormData, narrowing to string without a cast. */
export function formDataString(data: FormData, key: string): string {
  const value = data.get(key)
  return typeof value === 'string' ? value : ''
}

export function inputControl(form: HTMLFormElement, name: string): HTMLInputElement {
  const control = form.elements.namedItem(name)
  if (!(control instanceof HTMLInputElement)) {
    throw new Error(`Settings dialog template is missing input ${JSON.stringify(name)}`)
  }
  return control
}

export function selectControl(form: HTMLFormElement, name: string): HTMLSelectElement {
  const control = form.elements.namedItem(name)
  if (!(control instanceof HTMLSelectElement)) {
    throw new Error(`Settings dialog template is missing select ${JSON.stringify(name)}`)
  }
  return control
}

export function textareaControl(form: HTMLFormElement, name: string): HTMLTextAreaElement {
  const control = form.elements.namedItem(name)
  if (!(control instanceof HTMLTextAreaElement)) {
    throw new Error(`Settings dialog template is missing textarea ${JSON.stringify(name)}`)
  }
  return control
}

export function parseWebAllowedOrigins(value: FormDataEntryValue | null): string[] {
  const text = typeof value === 'string' ? value : ''
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

export function parseApprovedProviderHosts(value: FormDataEntryValue | null): string[] {
  const text = typeof value === 'string' ? value : ''
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean)
}

/** Render scalar controls from their descriptors, retaining the feature's labels and hints. */
export function renderSimpleFields(root: HTMLElement, fields: readonly SettingField[]): void {
  for (const field of fields) {
    // Security controls keep bespoke sliders and consent handling.
    if (!field.save) continue
    const template = root.querySelector(`[name="${field.name}"]`)
    if (!(template instanceof HTMLInputElement || template instanceof HTMLTextAreaElement)) {
      throw new Error(`Missing Settings control ${field.name}`)
    }
    const input =
      template instanceof HTMLTextAreaElement && field.kind === 'text'
        ? document.createElement('textarea')
        : document.createElement('input')
    for (const attr of template.attributes) input.setAttribute(attr.name, attr.value)
    if (input instanceof HTMLInputElement) {
      input.type =
        field.kind === 'checkbox' ? 'checkbox' : field.kind === 'number' ? 'number' : 'text'
      if (field.kind === 'number') {
        input.min = '0'
        input.step = '1'
      }
    }
    template.replaceWith(input)
  }
}
