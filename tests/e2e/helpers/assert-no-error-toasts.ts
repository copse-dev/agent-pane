import type {} from './browser-globals.d.ts'
import { browser } from '@wdio/globals'
import { UnexpectedErrorToastsError } from './error-toast-guard.ts'

/** Visible `.toast-error` nodes plus any errors recorded for e2e (survives auto-dismiss). */
export async function collectErrorToasts(): Promise<string[]> {
  return browser.execute(() => {
    const dom = [...document.querySelectorAll('.toast-error')].map((el) => el.textContent.trim())
    const ledger = window.__copseE2e?.getErrorToasts().map((message) => message.trim()) ?? []
    return [...new Set([...dom, ...ledger].filter(Boolean))]
  })
}

/** Fail fast when renderer surfaced an unexpected error toast. */
export async function assertNoErrorToasts(context?: string): Promise<void> {
  const toasts = await collectErrorToasts()
  if (toasts.length === 0) return
  throw new UnexpectedErrorToastsError(toasts, context)
}
