import '../../../tests/setup-dom.ts'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { showToast, showErrorToast } from './toast.ts'

afterEach(() => {
  document.getElementById('toast-host')?.remove()
})

describe('toast (#119 surface IPC errors)', () => {
  it('appends a toast to a shared host and returns a dismiss fn', () => {
    const dismiss = showToast('hello', { durationMs: 100000 })
    const host = document.getElementById('toast-host')!
    assert.ok(host)
    assert.equal(host.querySelectorAll('.toast').length, 1)
    assert.equal(host.querySelector('.toast')!.textContent, 'hello')
    dismiss()
    assert.equal(host.querySelectorAll('.toast').length, 0)
  })

  it('reuses the same host for multiple toasts', () => {
    showToast('a', { durationMs: 100000 })
    showToast('b', { durationMs: 100000 })
    assert.equal(document.querySelectorAll('#toast-host').length, 1)
    assert.equal(document.querySelectorAll('.toast').length, 2)
  })

  it('renders error messages as text (no HTML injection)', () => {
    showErrorToast('Failed to save', new Error('<img src=x onerror=alert(1)>'))
    const toast = document.querySelector('.toast-error')!
    assert.equal(document.querySelectorAll('#toast-host img').length, 0)
    assert.match(toast.textContent ?? '', /Failed to save: <img src=x onerror=alert\(1\)>/)
  })

  it('normalizes non-Error rejection reasons', () => {
    showErrorToast('Oops', 'plain string reason')
    assert.match(
      document.querySelector('.toast-error')!.textContent ?? '',
      /Oops: plain string reason/,
    )
  })

  it('extracts a readable message from an ErrorEvent (not "[object ErrorEvent]")', () => {
    showErrorToast('Unexpected error', new ErrorEvent('error', { message: 'Worker boom' }))
    const text = document.querySelector('.toast-error')!.textContent ?? ''
    assert.match(text, /Unexpected error: Worker boom/)
    assert.doesNotMatch(text, /\[object ErrorEvent\]/)
  })

  it('prefers the nested Error message on an ErrorEvent', () => {
    showErrorToast(
      'Unexpected error',
      new ErrorEvent('error', { error: new Error('nested cause') }),
    )
    assert.match(
      document.querySelector('.toast-error')!.textContent ?? '',
      /Unexpected error: nested cause/,
    )
  })

  it('appends the source location to an ErrorEvent message', () => {
    showErrorToast(
      'Unexpected error',
      new ErrorEvent('error', {
        message: 'Failed to fetch module',
        filename: 'file:///app/ts.worker.js',
        lineno: 12,
        colno: 5,
      }),
    )
    assert.match(
      document.querySelector('.toast-error')!.textContent ?? '',
      /Unexpected error: Failed to fetch module \(file:\/\/\/app\/ts\.worker\.js:12:5\)/,
    )
  })

  it('describes a message-less ErrorEvent by its source location', () => {
    showErrorToast(
      'Unexpected error',
      new ErrorEvent('error', { filename: 'file:///app/ts.worker.js', lineno: 3 }),
    )
    const text = document.querySelector('.toast-error')!.textContent ?? ''
    assert.match(text, /Unexpected error: script error at file:\/\/\/app\/ts\.worker\.js:3/)
    assert.doesNotMatch(text, /\[object ErrorEvent\]/)
  })

  it('describes a resource-load Event by the element that failed', () => {
    const img = document.createElement('img')
    img.setAttribute('src', 'https://example.com/missing.png')
    document.body.append(img)
    let captured: Event | null = null
    img.addEventListener('error', (e) => {
      captured = e
    })
    img.dispatchEvent(new Event('error'))
    showErrorToast('Unexpected error', captured)
    img.remove()
    assert.match(
      document.querySelector('.toast-error')!.textContent ?? '',
      /Unexpected error: failed to load <img> https:\/\/example\.com\/missing\.png/,
    )
  })

  it('collapses identical error bursts into a single toast', () => {
    showErrorToast('Unexpected error', new ErrorEvent('error', { message: 'Worker boom' }))
    showErrorToast('Unexpected error', new ErrorEvent('error', { message: 'Worker boom' }))
    showErrorToast('Unexpected error', new ErrorEvent('error', { message: 'Worker boom' }))
    assert.equal(document.querySelectorAll('.toast-error').length, 1)
  })
})
