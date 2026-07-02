import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { bindBrowserLinkClicks } from './browser-links.ts'
import { hydrateRemoteArtifactImages } from './remote-artifact-images.ts'
import { renderMarkdown } from '@copse/streaming-markdown'
import { qsRequired } from '../dom/helpers.ts'

describe('markdown browser links', () => {
  it('opens HTTP links in the browser panel', () => {
    const root = document.createElement('div')
    root.innerHTML = '<a href="https://example.com/docs" target="_blank">docs</a>'
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    const requested: string[] = []
    store.on('browser_url_requested', (url) => requested.push(url))
    const unbind = bindBrowserLinkClicks(root, store)

    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })
    qsRequired(root, 'a').dispatchEvent(event)

    unbind()
    assert.equal(event.defaultPrevented, true)
    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(store.getState().rightPanelMode, 'browser')
    assert.deepEqual(requested, ['https://example.com/docs'])
  })

  it('opens remote agent launch notice links in the browser panel', () => {
    const href = 'https://cursor.com/agents/bc-f048baf8-bbc6-4def-b722-4f12008284be'
    const root = document.createElement('div')
    root.innerHTML = renderMarkdown(`_Running on Cursor Cloud Agent — follow along at ${href}_`)
    assert.ok(root.querySelector('em a'))
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    const requested: string[] = []
    store.on('browser_url_requested', (url) => requested.push(url))
    const unbind = bindBrowserLinkClicks(root, store)

    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })
    qsRequired(root, 'a').dispatchEvent(event)

    unbind()
    assert.equal(event.defaultPrevented, true)
    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(store.getState().rightPanelMode, 'browser')
    assert.deepEqual(requested, [href])
  })

  it('leaves workspace markdown links to the workspace link handler', () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<a href="/docs/foo.md" class="workspace-markdown-link" data-workspace-link="true">guide</a>'
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    let requested = false
    store.on('browser_url_requested', () => (requested = true))
    const unbind = bindBrowserLinkClicks(root, store)

    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })
    qsRequired(root, 'a').dispatchEvent(event)

    unbind()
    assert.equal(event.defaultPrevented, false)
    assert.equal(requested, false)
  })

  it('leaves generated file reference links to the file link handler', () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<a href="#" data-file-reference-path="src/main/index.ts">src/main/index.ts</a>'
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    let requested = false
    store.on('browser_url_requested', () => (requested = true))
    const unbind = bindBrowserLinkClicks(root, store)

    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })
    qsRequired(root, 'a').dispatchEvent(event)

    unbind()
    assert.equal(event.defaultPrevented, false)
    assert.equal(requested, false)
  })

  it('resolves remote artifact links before opening the browser panel', async () => {
    const href =
      'https://api.cursor.com/v1/agents/bc-00000000-0000-0000-0000-000000000001/artifacts/download?path=artifacts%2Fscreenshot.png'
    const root = document.createElement('div')
    root.innerHTML = `<a href="${href}">Open</a>`
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    const requested: string[] = []
    store.on('browser_url_requested', (url) => requested.push(url))
    const unbind = bindBrowserLinkClicks(root, store, {
      remoteAgent: {
        downloadArtifact: async (agentId, path) => {
          assert.equal(agentId, 'bc-00000000-0000-0000-0000-000000000001')
          assert.equal(path, 'artifacts/screenshot.png')
          return 'https://cloud-agent-artifacts.s3.us-east-1.amazonaws.com/screenshot.png'
        },
      },
    })

    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })
    qsRequired(root, 'a').dispatchEvent(event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    unbind()
    assert.equal(event.defaultPrevented, true)
    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(store.getState().rightPanelMode, 'browser')
    assert.deepEqual(requested, [
      'https://cloud-agent-artifacts.s3.us-east-1.amazonaws.com/screenshot.png',
    ])
  })

  it('opens GitHub PR links in the PR panel when gh is ready', async () => {
    const href = 'https://github.com/org/repo/pull/42'
    const root = document.createElement('div')
    root.innerHTML = `<a href="${href}">PR</a>`
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    const browserRequested: string[] = []
    const prRequested: Array<{ owner: string; repo: string; number: number }> = []
    store.on('browser_url_requested', (url) => browserRequested.push(url))
    store.on('pr_open_requested', (owner, repo, number) =>
      prRequested.push({ owner, repo, number }),
    )
    const unbind = bindBrowserLinkClicks(root, store, {
      remoteAgent: { downloadArtifact: async () => 'https://example.com' },
      gh: {
        status: async () => ({
          installed: true,
          authenticated: true,
          username: 'dev',
          message: null,
        }),
      },
    })

    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })
    qsRequired(root, 'a').dispatchEvent(event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    unbind()
    assert.equal(event.defaultPrevented, true)
    assert.equal(store.getState().rightPanelMode, 'prs')
    assert.deepEqual(prRequested, [{ owner: 'org', repo: 'repo', number: 42 }])
    assert.deepEqual(browserRequested, [])
  })

  it('falls back to browser panel for GitHub PR links when gh is unavailable', async () => {
    const href = 'https://github.com/org/repo/pull/42'
    const root = document.createElement('div')
    root.innerHTML = `<a href="${href}">PR</a>`
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    const requested: string[] = []
    store.on('browser_url_requested', (url) => requested.push(url))
    const unbind = bindBrowserLinkClicks(root, store, {
      remoteAgent: { downloadArtifact: async () => 'https://example.com' },
      gh: {
        status: async () => ({
          installed: false,
          authenticated: false,
          username: null,
          message: 'missing',
        }),
      },
    })

    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })
    qsRequired(root, 'a').dispatchEvent(event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    unbind()
    assert.equal(store.getState().rightPanelMode, 'browser')
    assert.deepEqual(requested, [href])
  })

  it('hydrates remote artifact image tags from the thread agent link', async () => {
    const root = document.createElement('div')
    root.className = 'messages-list'
    root.innerHTML = [
      renderMarkdown(
        '_Running on Cursor Cloud Agent — follow along at https://cursor.com/agents/bc-00000000-0000-0000-0000-000000000001_',
      ),
      renderMarkdown(
        '<img alt="C-S-S rendered" src="/opt/cursor/artifacts/screenshots/css-new-tab.png" />',
      ),
    ].join('\n')

    hydrateRemoteArtifactImages(root, {
      remoteAgent: {
        artifactImageDataUrl: async (agentId, path) => {
          assert.equal(agentId, 'bc-00000000-0000-0000-0000-000000000001')
          assert.equal(path, 'artifacts/screenshots/css-new-tab.png')
          return 'data:image/png;base64,abc123'
        },
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const img = qsRequired<HTMLImageElement>(root, 'img')
    assert.equal(img.dataset['remoteArtifactState'], 'loaded')
    assert.equal(img.src, 'data:image/png;base64,abc123')
  })

  it('retries artifact image hydration after restored messages attach to the thread', async () => {
    const finalMessage = document.createElement('div')
    finalMessage.innerHTML = renderMarkdown(
      '<img alt="C-S-S rendered" src="/opt/cursor/artifacts/screenshots/css-new-tab.png" />',
    )
    const calls: Array<{ agentId: string; path: string }> = []
    const api = {
      remoteAgent: {
        artifactImageDataUrl: async (agentId: string, path: string): Promise<string> => {
          calls.push({ agentId, path })
          return 'data:image/png;base64,abc123'
        },
      },
    }

    hydrateRemoteArtifactImages(finalMessage, api)
    assert.equal(
      qsRequired<HTMLImageElement>(finalMessage, 'img').dataset['remoteArtifactState'],
      'missing-agent',
    )

    const root = document.createElement('div')
    root.className = 'messages-list'
    root.innerHTML = renderMarkdown(
      '_Running on Cursor Cloud Agent — follow along at https://cursor.com/agents/bc-00000000-0000-0000-0000-000000000001_',
    )
    root.append(finalMessage)
    hydrateRemoteArtifactImages(root, api)
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.deepEqual(calls, [
      {
        agentId: 'bc-00000000-0000-0000-0000-000000000001',
        path: 'artifacts/screenshots/css-new-tab.png',
      },
    ])
    assert.equal(
      qsRequired<HTMLImageElement>(finalMessage, 'img').dataset['remoteArtifactState'],
      'loaded',
    )
  })
})
