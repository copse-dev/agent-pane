/**
 * An in-process code-cell "container" for unit tests: the real guest
 * (`serveCodeCells`) on one end of the real link, the real host container
 * class on the other, joined by in-memory streams instead of an engine.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { EgressLink } from '../container-runtime/egress-link.ts'
import type {
  AttachedProcess,
  CodeCellContainerDependencies,
  CodeCellContainerSpec,
} from './code-cell-container.ts'
import { serveCodeCells } from './code-cell-guest.ts'

export interface InProcessEngine {
  deps: CodeCellContainerDependencies
  /** Every argv the container asked the engine to run. */
  engineCalls: string[][]
  /** Runtime ids torn down, in order. */
  tornDown: string[]
  /** The guest's link of the most recent attach, to act as a misbehaving guest. */
  guestLink: () => EgressLink
}

export function inProcessEngine(options: { inspect?: string } = {}): InProcessEngine {
  const engineCalls: string[][] = []
  const tornDown: string[] = []
  let lastGuest: EgressLink | null = null
  const attach = (): AttachedProcess => {
    const toGuest = new PassThrough()
    const toHost = new PassThrough()
    const stderr = new PassThrough()
    const events = new EventEmitter()
    let exitCode: number | null = null
    const exit = (code: number): void => {
      if (exitCode !== null) return
      exitCode = code
      toHost.end()
      events.emit('exit')
    }
    const guest = new EgressLink(
      toGuest,
      {
        write: (chunk): boolean => toHost.write(chunk),
        on: (event, listener): void => {
          toHost.on(event, listener)
        },
      },
      {
        onClose: (): void => {
          exit(0)
        },
      },
    )
    lastGuest = guest
    void serveCodeCells(guest, { nodeVersion: process.version }).finally(() => {
      exit(0)
    })
    return {
      stdin: toGuest,
      stdout: toHost,
      stderr,
      get exitCode(): number | null {
        return exitCode
      },
      once: (event, listener): unknown => events.once(event, listener),
      kill: (): boolean => {
        exit(137)
        return true
      },
    }
  }
  return {
    engineCalls,
    tornDown,
    guestLink: (): EgressLink => {
      if (lastGuest === null) throw new Error('no container has been attached')
      return lastGuest
    },
    deps: {
      runEngine: (_engine, args): Promise<string> => {
        engineCalls.push(args)
        return Promise.resolve(args[0] === 'inspect' ? (options.inspect ?? '') : '')
      },
      attach,
      teardown: (runtimeId): Promise<void> => {
        tornDown.push(runtimeId)
        return Promise.resolve()
      },
    },
  }
}

export function testSpec(overrides: Partial<CodeCellContainerSpec> = {}): CodeCellContainerSpec {
  return {
    engine: 'docker',
    image: 'copse-code-cell:test',
    runtimeId: 'cell-test-1',
    memoryLimit: '512m',
    cpus: 1,
    pidsLimit: 64,
    ...overrides,
  }
}
