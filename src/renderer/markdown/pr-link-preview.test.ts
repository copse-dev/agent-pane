import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { bindPrLinkPreviews } from './pr-link-preview.ts'
import { rememberPrTitle } from './pr-title-cache.ts'
import type { GhPrDetails } from '@shared/types/git.ts'

function makeDetails(number: number, title: string): GhPrDetails {
  return {
    owner: 'copse-dev',
    repo: 'agent-pane',
    number,
    title,
    url: `https://github.com/copse-dev/agent-pane/pull/${String(number)}`,
    state: 'OPEN',
    body: '',
    files: [],
    isDraft: true,
  }
}

function linkedRoot(number: number): { root: HTMLElement; link: HTMLAnchorElement } {
  const root = document.createElement('div')
  const link = document.createElement('a')
  link.href = `https://github.com/copse-dev/agent-pane/pull/${String(number)}`
  link.textContent = `PR #${String(number)}`
  root.append(link)
  document.body.append(root)
  return { root, link }
}

function focus(link: HTMLAnchorElement): void {
  link.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }))
}

function blur(link: HTMLAnchorElement): void {
  link.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }))
}

describe('GitHub PR link previews', () => {
  it('shows a title already learned by the PR pane without a details request', () => {
    const number = 989001
    rememberPrTitle({ owner: 'COPSE-DEV', repo: 'agent-pane', number }, 'Cached PR title')
    const { root, link } = linkedRoot(number)
    let calls = 0
    const unbind = bindPrLinkPreviews(root, {
      prDetails: async () => {
        calls++
        return makeDetails(number, 'Unexpected lookup')
      },
    })

    focus(link)
    const card = document.querySelector<HTMLElement>('.pr-link-preview')
    assert.ok(card)
    assert.equal(card.hidden, false)
    assert.equal(card.querySelector('.pr-link-preview-title')?.textContent, 'Cached PR title')
    assert.equal(link.getAttribute('aria-describedby'), card.id)
    assert.equal(calls, 0)

    blur(link)
    assert.equal(card.hidden, true)
    assert.equal(link.hasAttribute('aria-describedby'), false)

    focus(link)
    link.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
    assert.equal(card.hidden, true)
    focus(link)
    assert.equal(card.hidden, true)
    root.dispatchEvent(new window.Event('pointermove', { bubbles: true }))
    focus(link)
    assert.equal(card.hidden, false)
    unbind()
    root.remove()
  })

  it('loads once, escapes the title as text, and reuses it on later focus', async () => {
    const number = 989002
    const { root, link } = linkedRoot(number)
    const unsafeTitle = '<img src=x onerror=alert(1)> Fix hover preview'
    let calls = 0
    const unbind = bindPrLinkPreviews(root, {
      prDetails: async () => {
        calls++
        return makeDetails(number, unsafeTitle)
      },
    })

    focus(link)
    const card = document.querySelector<HTMLElement>('.pr-link-preview')
    assert.ok(card)
    assert.equal(card.querySelector('.pr-link-preview-title')?.textContent, 'Loading title…')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(card.querySelector('.pr-link-preview-title')?.textContent, unsafeTitle)
    assert.equal(card.querySelector('img'), null)
    assert.equal(card.querySelector('.pr-link-preview-draft')?.textContent, 'Draft')
    assert.equal(calls, 1)

    blur(link)
    focus(link)
    assert.equal(card.querySelector('.pr-link-preview-title')?.textContent, unsafeTitle)
    assert.equal(calls, 1)
    unbind()
    root.remove()
  })

  it('ignores non-PR links and late results after focus leaves', async () => {
    const number = 989003
    const { root, link } = linkedRoot(number)
    const ordinary = document.createElement('a')
    ordinary.href = 'https://github.com/copse-dev/agent-pane/issues/989003'
    ordinary.textContent = 'Issue'
    root.append(ordinary)
    let resolveDetails: ((details: GhPrDetails) => void) | undefined
    const unbind = bindPrLinkPreviews(root, {
      prDetails: () =>
        new Promise<GhPrDetails>((resolve) => {
          resolveDetails = resolve
        }),
    })

    focus(ordinary)
    assert.equal(document.querySelector('.pr-link-preview'), null)
    focus(link)
    const card = document.querySelector<HTMLElement>('.pr-link-preview')
    assert.ok(card)
    blur(link)
    resolveDetails?.(makeDetails(number, 'Late PR title'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(card.hidden, true)
    assert.equal(link.hasAttribute('aria-describedby'), false)
    unbind()
    root.remove()
  })
})
