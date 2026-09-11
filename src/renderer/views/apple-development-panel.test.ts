import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import type { AppleDestination, AppleProjectState } from '@shared/types/apple-development.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { createAppleDevelopmentPanel } from './apple-development-panel.ts'

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function stateWithUnavailableScheme(): AppleProjectState {
  return {
    pluginEnabled: true,
    enrolled: true,
    supportedHost: true,
    toolchain: {
      developerDir: '/Applications/Xcode.app/Contents/Developer',
      version: 'Xcode 26.6',
    },
    candidates: [
      {
        id: 'apple-browsers/DuckDuckGo.xcodeproj',
        name: 'apple-browsers/DuckDuckGo',
        kind: 'project',
        schemes: [],
        metadataError: 'Xcode could not load schemes for this target (exit 74).',
      },
    ],
    destinations: [
      {
        id: 'platform=macOS',
        name: 'This Mac',
        platform: 'macOS',
        supported: true,
      },
    ],
    metadataRequiresExecution: false,
    selection: null,
    operations: [],
    setupMessage: 'Choose a workspace or project, scheme, configuration, and destination.',
  }
}

function stateWithRunningBuild(): AppleProjectState {
  return {
    pluginEnabled: true,
    enrolled: true,
    supportedHost: true,
    toolchain: {
      developerDir: '/Applications/Xcode.app/Contents/Developer',
      version: 'Xcode 26.6',
    },
    candidates: [
      {
        id: 'apple-browsers/DuckDuckGo.xcodeproj',
        name: 'apple-browsers/DuckDuckGo',
        kind: 'project',
        schemes: ['macOS Browser Alpha'],
      },
    ],
    destinations: [
      {
        id: 'platform=macOS',
        name: 'This Mac',
        platform: 'macOS',
        supported: true,
      },
    ],
    metadataRequiresExecution: false,
    selection: {
      candidateId: 'apple-browsers/DuckDuckGo.xcodeproj',
      schemeId: 'macOS Browser Alpha',
      configuration: 'Debug',
      destinationId: 'platform=macOS',
      revision: 4,
    },
    operations: [
      {
        id: 'run-active',
        action: 'run',
        status: 'running',
        target: {
          candidateId: 'apple-browsers/DuckDuckGo.xcodeproj',
          schemeId: 'macOS Browser Alpha',
          configuration: 'Debug',
          destinationId: 'platform=macOS',
          revision: 4,
        },
        createdAt: Date.now() - 65_000,
        updatedAt: Date.now(),
        outcome: null,
      },
    ],
    setupMessage: null,
  }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('Apple Development target selection', () => {
  it('shows only scheme-compatible destinations and prefers a booted simulator', async () => {
    const base = createFakeApi()
    const state = stateWithRunningBuild()
    const simulator: AppleDestination = {
      id: 'platform=iOS Simulator,id=BOOTED-17',
      name: 'iPhone 17 Pro',
      platform: 'iOS Simulator',
      supported: true,
      booted: true,
    }
    const api = {
      ...base,
      appleDevelopment: {
        ...base.appleDevelopment,
        state: async (): Promise<AppleProjectState> => ({
          ...state,
          selection: null,
          operations: [],
          destinations: [
            {
              id: 'platform=macOS',
              name: 'This Mac',
              platform: 'macOS',
              supported: true,
            },
            simulator,
          ],
        }),
        destinations: async (): Promise<AppleDestination[]> => [simulator],
      },
    } satisfies ApiClient
    const store = createStore({ activeProjectId: 'project', activeThreadId: 'thread' })
    const panel = createAppleDevelopmentPanel(store, api, { allowEnrollment: false })
    document.body.append(panel)
    await tick()
    await tick()

    const destination = panel.querySelector<HTMLSelectElement>('[aria-label="Destination"]')
    const save = Array.from(panel.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Use target',
    )
    assert.ok(destination)
    assert.ok(save)
    assert.equal(destination.disabled, false)
    assert.equal(destination.options.length, 1)
    assert.equal(destination.value, simulator.id)
    assert.equal(destination.textContent, 'iPhone 17 Pro · iOS Simulator')
    assert.equal(save.disabled, false)
  })

  it('explains an unavailable scheme and prevents an empty configure request', async () => {
    const base = createFakeApi()
    const configureCalls: unknown[] = []
    const api = {
      ...base,
      appleDevelopment: {
        ...base.appleDevelopment,
        state: async (): Promise<AppleProjectState> => stateWithUnavailableScheme(),
        configure: async (...args): Promise<never> => {
          configureCalls.push(args)
          throw new Error('configure should not be called')
        },
      },
    } satisfies ApiClient
    const store = createStore({ activeProjectId: 'project', activeThreadId: 'thread' })
    const panel = createAppleDevelopmentPanel(store, api, { allowEnrollment: false })
    document.body.append(panel)
    await tick()

    const scheme = panel.querySelector<HTMLSelectElement>('[aria-label="Scheme"]')
    const save = Array.from(panel.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Use target',
    )
    assert.ok(scheme)
    assert.ok(save)
    assert.equal(scheme.value, '')
    assert.equal(scheme.disabled, true)
    assert.equal(scheme.textContent, 'No schemes available')
    assert.equal(save.disabled, true)
    assert.match(panel.textContent, /Xcode could not load schemes.*exit 74/)
    save.click()
    assert.deepEqual(configureCalls, [])
  })

  it('shows progress while target metadata is loading', async () => {
    let finishDiscovery: ((state: AppleProjectState) => void) | undefined
    const discovery = new Promise<AppleProjectState>((resolve) => {
      finishDiscovery = resolve
    })
    const base = createFakeApi()
    const state = stateWithUnavailableScheme()
    const api = {
      ...base,
      appleDevelopment: {
        ...base.appleDevelopment,
        state: async (): Promise<AppleProjectState> => state,
        discover: async (): Promise<AppleProjectState> => discovery,
      },
    } satisfies ApiClient
    const store = createStore({ activeProjectId: 'project', activeThreadId: 'thread' })
    const panel = createAppleDevelopmentPanel(store, api, { allowEnrollment: false })
    document.body.append(panel)
    await tick()

    const refresh = panel.querySelector<HTMLButtonElement>('.apple-development-discover')
    assert.ok(refresh)
    refresh.click()
    assert.equal(refresh.textContent, 'Loading targets…')
    assert.equal(refresh.getAttribute('aria-busy'), 'true')
    assert.equal(refresh.disabled, true)

    finishDiscovery?.(state)
    await tick()
  })

  it('uses compact controls and explains an active run', async () => {
    const base = createFakeApi()
    const state = stateWithRunningBuild()
    let active = true
    const api = {
      ...base,
      appleDevelopment: {
        ...base.appleDevelopment,
        state: async (): Promise<AppleProjectState> =>
          active ? state : { ...state, operations: [] },
      },
    } satisfies ApiClient
    const store = createStore({ activeProjectId: 'project', activeThreadId: 'thread' })
    const panel = createAppleDevelopmentPanel(store, api, { allowEnrollment: false })
    document.body.append(panel)
    await tick()

    const refresh = panel.querySelector<HTMLButtonElement>('.apple-development-discover')
    const picker = panel.querySelector<HTMLDetailsElement>('.apple-development-target-picker')
    const operation = panel.querySelector<HTMLElement>('[data-operation-id="run-active"]')
    assert.ok(refresh)
    assert.ok(picker)
    assert.ok(operation)
    assert.equal(refresh.getAttribute('aria-label'), 'Refresh targets')
    assert.ok(refresh.querySelector('svg'))
    assert.equal(picker.open, false)
    assert.match(operation.textContent, /Running · 1m/)
    assert.match(operation.textContent, /Xcode is building the app before launch/)
    assert.equal(operation.querySelector('button')?.textContent, 'Cancel')
    assert.ok(
      Array.from(
        panel.querySelectorAll<HTMLButtonElement>('.apple-development-actions button'),
      ).every((button) => button.disabled),
    )

    active = false
    await new Promise((resolve) => setTimeout(resolve, 1_600))
  })

  it('uses friendly saved-target labels and shows history for that target', async () => {
    const base = createFakeApi()
    const savedTarget = {
      candidateId: 'ios/DemoApp.xcworkspace',
      schemeId: 'DemoApp',
      configuration: 'Debug',
      destinationId: 'platform=iOS Simulator,id=IPHONE-17',
      revision: 5,
    }
    const operation = {
      id: 'ios-test',
      action: 'test' as const,
      status: 'failed' as const,
      target: savedTarget,
      createdAt: 1_000,
      updatedAt: 2_000,
      outcome: {
        operationId: 'ios-test',
        status: 'failed' as const,
        reason: 'One test failed.',
        exitCode: 65,
        diagnostics: [],
        testSummary: null,
        logArtifactId: 'apple-log:ios-test',
        outputTruncated: false,
      },
    }
    const state: AppleProjectState = {
      ...stateWithRunningBuild(),
      candidates: [],
      destinations: [],
      selection: savedTarget,
      setupMessage: 'Discover the installed Xcode and project targets to continue.',
      operations: [
        {
          ...operation,
          id: 'mac-build',
          action: 'build',
          status: 'succeeded',
          target: {
            ...savedTarget,
            destinationId: 'platform=macOS',
            revision: 4,
          },
          outcome: { ...operation.outcome, operationId: 'mac-build', status: 'succeeded' },
        },
        operation,
      ],
    }
    const api = {
      ...base,
      appleDevelopment: {
        ...base.appleDevelopment,
        state: async (): Promise<AppleProjectState> => state,
      },
    } satisfies ApiClient
    const store = createStore({ activeProjectId: 'project', activeThreadId: 'thread' })
    const panel = createAppleDevelopmentPanel(store, api, { allowEnrollment: false })
    document.body.append(panel)
    await tick()

    const target = panel.querySelector<HTMLElement>('.apple-development-target')
    assert.ok(target)
    assert.match(target.textContent, /DemoApp/)
    assert.match(target.textContent, /iOS Simulator/)
    assert.doesNotMatch(target.textContent, /IPHONE-17/)
    assert.doesNotMatch(panel.textContent, /Discover the installed Xcode/)
    assert.ok(panel.querySelector('[data-operation-id="ios-test"]'))
    assert.equal(panel.querySelector('[data-operation-id="mac-build"]'), null)
  })
})
