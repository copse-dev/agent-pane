import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AppState } from '@shared/types/state.ts'
import { DEFAULT_LAYOUT } from '@shared/types/layout.ts'
import {
  captureProjectViewState,
  DEFAULT_PROJECT_VIEW_STATE,
  forgetProjectViewState,
  recordProjectViewState,
  resolveProjectViewState,
  type ProjectViewStateRegistry,
} from './project-view-state.ts'

function stateWith(partial: Partial<AppState>): AppState {
  return {
    workspaceRoot: '/proj',
    projects: [],
    activeProjectId: 'p1',
    expandedProjectId: 'p1',
    threads: [],
    activeThreadId: null,
    panelTab: 'file',
    openFile: null,
    activeDiff: null,
    stagedDiffs: [],
    filesPaneOpen: false,
    rightPanelMode: 'explorer',
    layout: { ...DEFAULT_LAYOUT },
    theme: 'dark',
    fontSize: 14,
    autoPortraitRightPanel: true,
    ...partial,
  }
}

test('captureProjectViewState snapshots the panel slice of AppState', () => {
  const view = captureProjectViewState(
    stateWith({ filesPaneOpen: true, rightPanelMode: 'terminal', panelTab: 'diff' }),
  )
  assert.deepEqual(view, { filesPaneOpen: true, rightPanelMode: 'terminal', panelTab: 'diff' })
})

test('resolveProjectViewState returns the recorded state for a known project', () => {
  const registry: ProjectViewStateRegistry = new Map()
  recordProjectViewState(registry, 'p1', {
    filesPaneOpen: true,
    rightPanelMode: 'changes',
    panelTab: 'file',
  })
  assert.deepEqual(resolveProjectViewState(registry, 'p1'), {
    filesPaneOpen: true,
    rightPanelMode: 'changes',
    panelTab: 'file',
  })
})

test('resolveProjectViewState falls back to the closed default for an unknown project', () => {
  const registry: ProjectViewStateRegistry = new Map()
  assert.deepEqual(resolveProjectViewState(registry, 'never-seen'), DEFAULT_PROJECT_VIEW_STATE)
  // The default must be a fresh copy callers can't mutate into the shared constant.
  const resolved = resolveProjectViewState(registry, 'never-seen')
  resolved.filesPaneOpen = true
  assert.equal(DEFAULT_PROJECT_VIEW_STATE.filesPaneOpen, false)
})

test('recordProjectViewState ignores a null project id', () => {
  const registry: ProjectViewStateRegistry = new Map()
  recordProjectViewState(registry, null, {
    filesPaneOpen: true,
    rightPanelMode: 'terminal',
    panelTab: 'file',
  })
  assert.equal(registry.size, 0)
})

test('forgetProjectViewState drops a project so it resolves to the default again', () => {
  const registry: ProjectViewStateRegistry = new Map()
  recordProjectViewState(registry, 'p1', {
    filesPaneOpen: true,
    rightPanelMode: 'terminal',
    panelTab: 'file',
  })
  forgetProjectViewState(registry, 'p1')
  assert.deepEqual(resolveProjectViewState(registry, 'p1'), DEFAULT_PROJECT_VIEW_STATE)
})
