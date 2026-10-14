import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { load } from 'js-yaml'
import { z } from 'zod'

const workflowSchema = z.object({
  jobs: z.record(
    z.string(),
    z.object({
      steps: z.array(
        z.object({
          name: z.string().optional(),
          with: z.record(z.string(), z.unknown()).optional(),
        }),
      ),
    }),
  ),
})

describe('trusted screenshot policy sparse checkouts', () => {
  for (const workflow of [
    'publish-screenshot-candidates',
    'screenshot-review-labels',
    'screenshot-review-selection',
  ]) {
    it(`${workflow} loads policy with no install beneath a CommonJS checkout`, () => {
      const document = workflowSchema.parse(
        load(readFileSync(`.github/workflows/${workflow}.yml`, 'utf8')),
      )
      const step = Object.values(document.jobs)
        .flatMap((job) => job.steps)
        .find((step) => step.name === 'Load trusted screenshot storage policy')
      const paths = z
        .string()
        .parse(step?.with?.['sparse-checkout'])
        .trim()
        .split(/\r?\n/)
        .map((path) => path.trim())
      const root = mkdtempSync(join(tmpdir(), 'screenshot-policy-checkout-'))
      try {
        // The publisher's policy directory is nested in the PR checkout, whose
        // package.json declares CommonJS. Missing std metadata inherits that scope.
        writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'commonjs' }))
        const policy = join(root, '.screenshot-policy')
        for (const path of paths) {
          const destination = join(policy, path)
          mkdirSync(dirname(destination), { recursive: true })
          cpSync(path, destination, { recursive: true })
        }
        const output = execFileSync(
          process.execPath,
          [
            '--input-type=commonjs',
            '--eval',
            `
          const manifest = require('./.screenshot-policy/scripts/lib/screenshot-manifest.mts');
          const review = require('./.screenshot-policy/scripts/lib/screenshot-review-manifest.mts');
          const candidates = require('./.screenshot-policy/scripts/screenshot-candidates.mts');
          const storage = require('./.screenshot-policy/scripts/screenshot-storage.mts');
          if (manifest.parseScreenshotManifest('{"version":1,"screenshots":{}}').version !== 1 ||
              typeof review.validateManifestCompare !== 'function' ||
              typeof candidates.prepareScreenshotCandidates !== 'function' ||
              typeof storage.screenshotStorage !== 'function') throw new Error('Policy exports missing');
          process.stdout.write('policy loaded');
        `,
          ],
          { cwd: root, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] },
        )
        assert.equal(output, 'policy loaded')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})
