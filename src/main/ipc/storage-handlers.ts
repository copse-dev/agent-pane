import type { BrowserWindow } from 'electron'
import { z } from 'zod'
import { resolve } from 'node:path'
import { defineHandler, defineSenderHandler } from './define-handler.ts'
import { assertStorageKey, zNonEmptyString } from './ipc-guards.ts'
import { inspectStorageMaintenance, saveStorageRetention } from '../services/storage-maintenance.ts'
import { containerStorage } from '../services/container-storage.ts'
import { storageCleanup } from '../services/storage-cleanup.ts'
import { storageGet, storageSet } from '../services/storage/storage.ts'
import {
  assertAllowedWorkspaceRoot,
  canonicalWorkspaceRoot,
  normalizeRemoteWorkspacePath,
  registerAllowedWorkspaceRoot,
} from '../services/workspace.ts'
import { localWorkspaceFs } from '../services/workspace-fs/local-workspace-fs.ts'
import { confirmNativeAction } from '../services/native-human-confirmation.ts'
import { authorizeProjectRoots } from './project-root-consent.ts'
import {
  containerStorageActionSchema,
  storageAreaSchema,
  storageRetentionSchema,
} from '../../shared/types/storage-cleanup.ts'

const zStorageKey = zNonEmptyString.max(256)

export function registerStorageHandlers(win: BrowserWindow): void {
  defineHandler(win, 'storage:maintenance', z.tuple([]), () => inspectStorageMaintenance())
  defineHandler(win, 'storage:cleanup', z.tuple([storageAreaSchema]), (area) =>
    storageCleanup().clean(area),
  )
  defineHandler(
    win,
    'storage:container-cleanup',
    z.tuple([containerStorageActionSchema]),
    (action) => containerStorage().clean(action),
  )
  defineHandler(win, 'storage:retention', z.tuple([storageRetentionSchema]), (policy) => {
    saveStorageRetention(policy)
  })
  defineHandler(win, 'storage:get', z.tuple([zStorageKey]), (key) => {
    assertStorageKey(key)
    return storageGet(key)
  })
  // Project roots also need main-owned consent: the renderer's saved sidebar
  // list must not become a way to grant itself a new filesystem root.
  defineSenderHandler(
    win,
    'storage:set',
    z.tuple([zStorageKey, z.unknown()]),
    async (sender, key, value) => {
      assertStorageKey(key)
      let storedValue = value
      if (key === 'projects') {
        storedValue = await authorizeProjectRoots(storageGet(key), value, {
          allowed: (project) => assertAllowedWorkspaceRoot(project.path, project.sshHost),
          canonical: (project) =>
            project.sshHost
              ? Promise.resolve(normalizeRemoteWorkspacePath(project.path))
              : canonicalWorkspaceRoot(project.path, localWorkspaceFs),
          confirm: (project, canonical) => {
            const detail = project.sshHost
              ? `Add remote project path ${JSON.stringify(canonical)} on SSH host ${JSON.stringify(project.sshHost)}?`
              : `Add local project folder ${JSON.stringify(canonical)}? This grants Copse access to files in that folder.${resolve(project.path) === canonical ? '' : `\nRequested as: ${JSON.stringify(project.path)}`}`
            return confirmNativeAction(sender, {
              title: 'Add project folder?',
              detail,
              approveLabel: 'Add folder',
            })
          },
          register: async (project, canonical) => {
            await registerAllowedWorkspaceRoot(canonical, project.sshHost)
          },
        })
      }
      storageSet(key, storedValue)
    },
    { errors: 'per-argument' },
  )
}
