import type {} from './browser-globals.d.ts'
import { browser } from '@wdio/globals'
import {
  acknowledgedErrorToastPrefix,
  unacknowledgedErrorToasts,
  UnexpectedErrorToastsError,
  type ErrorToastSnapshot,
} from './error-toast-state.ts'

export function readBrowserErrorToasts(): ErrorToastSnapshot {
  const owner = window.__copseE2e
  let state = window.__copseE2eErrorToastState
  if (!state || state.owner !== owner) {
    state = { owner, generation: crypto.randomUUID(), acknowledged: [] }
    window.__copseE2eErrorToastState = state
  }
  return {
    generation: state.generation,
    dom: [...document.querySelectorAll('.toast-error')].map((el) => el.textContent.trim()),
    ledger: window.__copseE2e?.getErrorToasts().map((message) => message.trim()) ?? [],
    acknowledged: state.acknowledged,
  }
}

/** Serialized by browser.execute; the same callback is exercised by offline boundary tests. */
export function commitBrowserErrorToastAcknowledgment({
  observed,
  expected,
  next,
}: {
  observed: ErrorToastSnapshot
  expected: string[]
  next: string[]
}): void {
  const bridge = window.__copseE2e
  const state = window.__copseE2eErrorToastState
  if (!bridge) throw new Error('The E2E error-toast ledger is unavailable')
  if (!state || state.owner !== bridge || state.generation !== observed.generation) {
    throw new Error('The error-toast document or ledger owner changed before acknowledgment')
  }
  const ledger = bridge.getErrorToasts().map((message) => message.trim())
  if (
    ledger.length !== observed.ledger.length ||
    ledger.some((message, index) => observed.ledger[index] !== message) ||
    state.acknowledged.length !== observed.acknowledged.length ||
    state.acknowledged.some((message, index) => observed.acknowledged[index] !== message) ||
    [...document.querySelectorAll('.toast-error')].some(
      (toast) => !expected.includes(toast.textContent.trim()),
    )
  ) {
    throw new Error('Error toasts changed before their acknowledgment')
  }
  state.acknowledged = next
}

/** Visible `.toast-error` nodes plus any errors recorded for e2e (survives auto-dismiss). */
export async function collectErrorToasts(): Promise<string[]> {
  return unacknowledgedErrorToasts(await browser.execute(readBrowserErrorToasts))
}

/** Call after asserting/capturing a negative case, then await natural toast dismissal. */
export async function acknowledgeExpectedErrorToasts(expected: readonly string[]): Promise<void> {
  const observed = await browser.execute(readBrowserErrorToasts)
  const next = acknowledgedErrorToastPrefix(observed, expected)
  await browser.execute(commitBrowserErrorToastAcknowledgment, {
    observed,
    expected: [...expected],
    next,
  })
}

/** Fail fast when renderer surfaced an unexpected error toast. */
export async function assertNoErrorToasts(context?: string): Promise<void> {
  const toasts = await collectErrorToasts()
  if (toasts.length === 0) return
  throw new UnexpectedErrorToastsError(toasts, context)
}
