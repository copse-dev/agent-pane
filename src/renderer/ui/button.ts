import { el } from '../dom/helpers.ts'
import { cx } from './cx.ts'

export type UiButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export interface UiButtonOptions {
  label: string
  variant?: UiButtonVariant
  type?: 'button' | 'submit' | 'reset'
  /** Extra classes for migration / screen-specific hooks. */
  className?: string
  disabled?: boolean
  ariaLabel?: string
}

/**
 * Native button styled by the UI kit. Kept as a real `<button>` (not a custom
 * element) so form submit, focus, and disabled semantics stay honest.
 */
export function uiButton(opts: UiButtonOptions): HTMLButtonElement {
  const variant = opts.variant ?? 'secondary'
  const button = el(
    'button',
    {
      type: opts.type ?? 'button',
      class: cx('ui-btn', `ui-btn-${variant}`, opts.className),
      disabled: opts.disabled === true ? true : undefined,
      'aria-label': opts.ariaLabel,
    },
    opts.label,
  )
  return button
}
