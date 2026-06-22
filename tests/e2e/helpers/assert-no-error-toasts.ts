import { browser } from '@wdio/globals'

/** Visible `.toast-error` nodes plus any errors recorded for e2e (survives auto-dismiss). */
export async function collectErrorToasts(): Promise<string[]> {
  return browser.execute(() => {
    const dom = [...document.querySelectorAll('.toast-error')].map(
      (el) => el.textContent?.trim() ?? '',
    )
    const e2e = window as unknown as {
      __copseE2e?: { getErrorToasts?: () => string[] }
    }
    const ledger = e2e.__copseE2e?.getErrorToasts?.().map((s) => s.trim()) ?? []
    return [...new Set([...dom, ...ledger].filter(Boolean))]
  })
}

/** Fail fast when renderer surfaced an unexpected error toast. */
export async function assertNoErrorToasts(context?: string): Promise<void> {
  const toasts = await collectErrorToasts()
  if (toasts.length === 0) return
  const prefix = context ? `${context}: ` : ''
  throw new Error(`${prefix}Unexpected error toast(s): ${toasts.join(' | ')}`)
}
