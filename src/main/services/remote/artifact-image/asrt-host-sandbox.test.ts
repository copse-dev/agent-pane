import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { asrtHostSandbox } from './asrt-host-sandbox.ts'
import { downloaderSandboxConfig } from './host.ts'

describe('artifact-image ASRT adapter', () => {
  it(
    'fails closed when initialization resolves without enabling sandboxing',
    { skip: process.platform === 'win32' },
    async (t) => {
      t.mock.method(SandboxManager, 'isSupportedPlatform', () => true)
      t.mock.method(SandboxManager, 'initialize', async () => {})
      t.mock.method(SandboxManager, 'isSandboxingEnabled', () => false)
      await assert.rejects(
        asrtHostSandbox.initialize(
          downloaderSandboxConfig({
            proxyPort: 1234,
            allowedHosts: ['cloud-agent-artifacts.s3.us-east-1.amazonaws.com'],
            downloaderPath: '/tmp/downloader.cjs',
            runtimeReadPaths: [],
          }),
        ),
        /sandbox did not enable/,
      )
    },
  )
})
