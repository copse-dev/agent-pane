import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { afterEach, before, describe, it } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import type { GhCliStatus, GhPrSummary } from '@shared/types/git.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GitDiffMonaco } from '../monaco/git-diff-viewer.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { githubSamlAuthorizationUrl } from './pr-auth-error.ts'
import { mountPrPane } from './pr-pane.ts'

const SSO_URL =
  'https://github.com/orgs/duckduckgo/sso?authorization_request=secret-authorization-value'
const SAML_ERROR = `GraphQL: Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization: ${SSO_URL}`
const READY: GhCliStatus = {
  installed: true,
  authenticated: true,
  username: 'me',
  message: null,
}
const PR: GhPrSummary = {
  owner: 'duckduckgo',
  repo: 'privacy-configuration',
  number: 6059,
  title: 'privacy-configuration',
  url: 'https://github.com/duckduckgo/privacy-configuration/pull/6059',
  state: 'OPEN',
}
const MONACO_STUB: GitDiffMonaco = {
  KeyCode: { KeyL: 0 },
  Uri: { parse: (value) => ({ toString: () => value }) },
  editor: {
    createDiffEditor: () => {
      throw new Error('unexpected diff editor')
    },
    createModel: () => {
      throw new Error('unexpected diff model')
    },
  },
}

before(() => {
  if (!('ResizeObserver' in globalThis)) {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }
})

afterEach(() => {
  document.body.replaceChildren()
})

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index++) await Promise.resolve()
}

function mount(error: string): {
  list: HTMLElement
  viewer: HTMLElement
  opened: string[]
  dispose: () => void
} {
  const store = createStore({
    activeProjectId: 'project-1',
    filesPaneOpen: true,
    rightPanelMode: 'prs',
  })
  const base = createFakeApi()
  const opened: string[] = []
  const api: ApiClient = {
    ...base,
    gh: {
      ...base.gh,
      status: async () => READY,
      listWorkspaceOpenPrs: async () => [PR],
      listMyOpenPrs: async () => [],
      agentPrLinks: async () => [],
      prDetails: async () => {
        throw new Error(error)
      },
      onListsTick: () => () => {},
    },
    shell: {
      ...base.shell,
      openExternal: async (url) => {
        opened.push(url)
      },
    },
  }
  const list = document.createElement('div')
  const viewer = document.createElement('div')
  document.body.append(list, viewer)
  const dispose = mountPrPane(list, viewer, store, api, MONACO_STUB)
  return { list, viewer, opened, dispose }
}

describe('PR SAML authorization', () => {
  it('accepts only the selected GitHub organization SSO URL', () => {
    assert.equal(githubSamlAuthorizationUrl(SAML_ERROR, 'duckduckgo'), SSO_URL)
    assert.equal(githubSamlAuthorizationUrl(SAML_ERROR, 'other-org'), null)
    assert.equal(
      githubSamlAuthorizationUrl(
        SAML_ERROR.replace('github.com', 'github.com.evil.example'),
        'duckduckgo',
      ),
      null,
    )
    assert.equal(
      githubSamlAuthorizationUrl(SAML_ERROR.replace('github.com', 'github.com:444'), 'duckduckgo'),
      null,
    )
    assert.equal(githubSamlAuthorizationUrl('GraphQL: repository not found', 'duckduckgo'), null)
  })

  it('offers the browser action without showing the authorization token', async () => {
    const { list, viewer, opened, dispose } = mount(SAML_ERROR)
    await settle()
    list.querySelector<HTMLElement>('.pr-list-row')?.click()
    await settle()

    const button = viewer.querySelector<HTMLButtonElement>('.pr-auth-button')
    assert.ok(button)
    assert.equal(button.textContent, 'Sign in with GitHub SSO')
    assert.match(viewer.textContent, /GitHub requires SSO authorization for duckduckgo/)
    assert.equal(viewer.textContent.includes('secret-authorization-value'), false)
    button.click()
    assert.deepEqual(opened, [SSO_URL])
    dispose()
  })

  it('leaves other PR detail failures as errors without an auth action', async () => {
    const { list, viewer, dispose } = mount('GraphQL: repository not found')
    await settle()
    list.querySelector<HTMLElement>('.pr-list-row')?.click()
    await settle()

    assert.match(viewer.textContent, /repository not found/)
    assert.equal(viewer.querySelector('.pr-auth-button'), null)
    dispose()
  })

  it('does not show a token or unsafe button when the SAML link is invalid', async () => {
    const { list, viewer, dispose } = mount(
      SAML_ERROR.replace('github.com/orgs', 'github.com.evil.example/orgs'),
    )
    await settle()
    list.querySelector<HTMLElement>('.pr-list-row')?.click()
    await settle()

    assert.match(viewer.textContent, /GitHub requires SSO authorization/)
    assert.equal(viewer.textContent.includes('secret-authorization-value'), false)
    assert.equal(viewer.querySelector('.pr-auth-button'), null)
    dispose()
  })
})
