import '../../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PairedMachine } from '@shared/machines.ts'
import {
  describePairedMachine,
  describeSshMachine,
  machineSummaryElement,
  type SshMachineContext,
} from './machine-capabilities.ts'

const HOST = { id: 'studio', label: 'Studio', host: 'studio.internal' }
const NONE: SshMachineContext = {
  states: [],
  agentsOnRemote: false,
  desktop: false,
  trustedHosts: [],
}

describe('describeSshMachine', () => {
  it('lists files and shell for every SSH machine, and more as features are on', () => {
    assert.deepEqual(describeSshMachine(HOST, NONE).capabilities, ['Files and shell'])
    assert.deepEqual(
      describeSshMachine(HOST, {
        ...NONE,
        agentsOnRemote: true,
        desktop: true,
        trustedHosts: ['STUDIO.internal'],
      }).capabilities,
      ['Files and shell', 'Agents', 'Desktop', 'Trusted for auto-approval'],
    )
  })

  it('reports the live connection, and a lost one as lost', () => {
    const state = (
      status: 'connected' | 'connecting' | 'disconnected' | 'error',
    ): SshMachineContext => ({
      ...NONE,
      states: [{ hostId: 'studio', status, label: 'Studio', target: 'studio.internal' }],
    })
    assert.deepEqual(
      [
        describeSshMachine(HOST, NONE),
        describeSshMachine(HOST, state('connected')),
        describeSshMachine(HOST, state('connecting')),
        describeSshMachine(HOST, state('disconnected')),
        describeSshMachine(HOST, state('error')),
      ].map(({ status, tone }) => [status, tone]),
      [
        ['Not connected', 'idle'],
        ['Connected', 'ok'],
        ['Connecting…', 'idle'],
        ['Connection lost', 'warn'],
        ['Could not connect', 'warn'],
      ],
    )
  })

  it('says why a connect failed when it knows', () => {
    const summary = describeSshMachine(HOST, {
      ...NONE,
      states: [
        {
          hostId: 'studio',
          status: 'error',
          label: 'Studio',
          target: 'studio.internal',
          lastError: 'Permission denied (publickey)',
        },
      ],
    })
    assert.equal(summary.status, 'Could not connect: Permission denied (publickey)')
  })
})

describe('describePairedMachine', () => {
  const machine = (models: number, status: PairedMachine['status']): PairedMachine => ({
    id: '6f1c9e1e-8f62-4a0e-9a3c-2f0f6f9b6c11',
    name: 'Model computer',
    address: '192.168.1.20',
    status,
    detail: '',
    models: Array.from({ length: models }, (_, index) => ({
      id: `m${String(index)}`,
      label: `Model ${String(index)}`,
      model: 'system-one',
      timeoutMs: 1000,
    })),
  })

  it('counts its shared models and reports its connection', () => {
    assert.deepEqual(describePairedMachine(machine(1, 'connected')), {
      status: 'Connected',
      tone: 'ok',
      capabilities: ['1 shared model'],
    })
    assert.deepEqual(describePairedMachine(machine(3, 'reconnecting')).capabilities, [
      '3 shared models',
    ])
    assert.equal(describePairedMachine(machine(0, 'unavailable')).tone, 'warn')
  })
})

describe('machineSummaryElement', () => {
  it('renders the status and one list item per capability', () => {
    const node = machineSummaryElement({
      status: 'Connected',
      tone: 'ok',
      capabilities: ['Files and shell', 'Desktop'],
    })
    assert.equal(node.querySelector('.machine-summary-ok')?.textContent, 'Connected')
    assert.deepEqual(
      [...node.querySelectorAll('.machine-capability')].map((item) => item.textContent),
      ['Files and shell', 'Desktop'],
    )
  })
})
