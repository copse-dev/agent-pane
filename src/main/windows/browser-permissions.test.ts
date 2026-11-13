import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Session } from 'electron'
import {
  configureBrowserPermissions,
  isBrowserPermissionAllowed,
  type BrowserPermissionProfile,
} from './browser-permissions.ts'

type RequestHandler = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>
type CheckHandler = NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>

// Exhaustive for the installed Electron version: upgrades require reviewing new names.
const permissions = {
  ar: false,
  'automatic-fullscreen': false,
  'background-fetch': false,
  'background-sync': false,
  'captured-surface-control': false,
  'clipboard-read': false,
  'clipboard-sanitized-write': false,
  'deprecated-sync-clipboard-read': false,
  'display-capture': false,
  fileSystem: false,
  fullscreen: false,
  geolocation: false,
  'geolocation-approximate': false,
  'hand-tracking': false,
  hid: false,
  'idle-detection': false,
  keyboardLock: false,
  'local-fonts': false,
  'local-network': false,
  'local-network-access': false,
  'loopback-network': false,
  media: false,
  mediaKeySystem: false,
  midi: false,
  midiSysex: false,
  nfc: false,
  notifications: false,
  openExternal: false,
  'payment-handler': false,
  'periodic-background-sync': false,
  'persistent-storage': false,
  pointerLock: false,
  'screen-wake-lock': false,
  sensors: false,
  serial: false,
  'smart-card': false,
  'speaker-selection': false,
  'storage-access': false,
  'system-wake-lock': false,
  'top-level-storage-access': false,
  usb: false,
  vr: false,
  'web-app-installation': false,
  'web-printing': false,
  'window-management': false,
  unknown: false,
} satisfies Record<Parameters<RequestHandler>[1], false>

function installedHandlers(profile: BrowserPermissionProfile): {
  request: RequestHandler
  check: CheckHandler
} {
  const registered: { request?: RequestHandler; check?: CheckHandler } = {}
  configureBrowserPermissions(
    {
      setPermissionRequestHandler: (handler) => {
        assert.ok(handler)
        registered.request = handler
      },
      setPermissionCheckHandler: (handler) => {
        assert.ok(handler)
        registered.check = handler
      },
    },
    profile,
  )
  assert.ok(registered.request)
  assert.ok(registered.check)
  return { request: registered.request, check: registered.check }
}

function expectDecision(
  profile: BrowserPermissionProfile,
  permission: string,
  expected: boolean,
): void {
  assert.equal(isBrowserPermissionAllowed(permission, profile), expected, permission)
  const { request, check } = installedHandlers(profile)
  for (const isMainFrame of [true, false]) {
    const details = { requestingUrl: 'https://example.com/', isMainFrame }
    const replies: boolean[] = []
    Reflect.apply(request, undefined, [
      {},
      permission,
      (value: boolean): void => {
        replies.push(value)
      },
      details,
    ])
    assert.deepEqual(replies, [expected], `request ${permission}`)
    for (const contents of [{}, null]) {
      assert.equal(
        Reflect.apply(check, undefined, [contents, permission, 'https://example.com', details]),
        expected,
        `check ${permission}`,
      )
    }
  }
}

describe('browser permissions', () => {
  it('denies every current permission and future, malformed or prototype-like names', () => {
    const names = [
      ...Object.keys(permissions satisfies Record<Parameters<CheckHandler>[1], false>),
      'future-chromium-permission',
      '',
      '__proto__',
      'constructor',
      'toString',
      'fileSystem ',
      'FULLSCREEN',
      'display-capture\n',
    ]
    for (const permission of names) {
      expectDecision('restricted', permission, false)
    }
  })

  it('allows only user-gesture copy and fullscreen in the interactive profile', () => {
    for (const permission of ['clipboard-sanitized-write', 'fullscreen']) {
      expectDecision('interactive', permission, true)
      expectDecision('restricted', permission, false)
    }
    for (const permission of [
      'clipboard-read',
      'automatic-fullscreen',
      'future-chromium-permission',
      'FULLSCREEN',
      '__proto__',
    ]) {
      expectDecision('interactive', permission, false)
    }
  })

  it('closes the old allow-by-omission decisions rather than just retaining its denials', () => {
    const previouslyDenied = new Set([
      'media',
      'geolocation',
      'notifications',
      'midi',
      'midiSysex',
      'pointerLock',
      'openExternal',
      'hid',
      'serial',
      'usb',
      'clipboard-read',
    ])
    for (const permission of [
      'display-capture',
      'fileSystem',
      'unknown',
      'future-chromium-permission',
    ]) {
      assert.equal(!previouslyDenied.has(permission), true, `negative control ${permission}`)
      assert.equal(isBrowserPermissionAllowed(permission, 'restricted'), false, permission)
      assert.equal(isBrowserPermissionAllowed(permission, 'interactive'), false, permission)
    }
  })
})
