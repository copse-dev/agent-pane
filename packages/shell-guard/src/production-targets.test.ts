import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseProductionTargets, sanitizeProductionTargets } from './production-targets.ts'
import { assessShellHarm } from './shell-harm.ts'

const context = {
  workspaceRoot: '/work/app',
  homeDir: '/home/me',
  // Trusted for ssh, so only the production rule can make it ask.
  trustedSshHosts: ['db.prod.example'],
  productionTargets: ['prod-eu', 'db.prod.example', 'billing-prod'],
}

function decision(command: string, targets = context.productionTargets): string {
  return assessShellHarm(command, { ...context, productionTargets: targets }).action
}

describe('production targets', () => {
  it('parses and sanitizes the list', () => {
    assert.deepEqual(parseProductionTargets('Prod-EU\n# comment\n\nprod-eu\nbad name\n'), [
      'prod-eu',
    ])
    assert.deepEqual(sanitizeProductionTargets(['prod', 3, 'a;b']), ['prod'])
    assert.deepEqual(sanitizeProductionTargets('prod'), [])
  })

  it('makes a read against a production target ask', () => {
    for (const command of [
      'kubectl get pods --context prod-eu',
      'kubectl --context=prod-eu logs api-1',
      'AWS_PROFILE=billing-prod aws s3 ls',
      'gcloud compute instances list --project billing-prod',
      'psql postgres://reader@db.prod.example:5432/app -c "select 1"',
      'ssh deploy@db.prod.example uptime',
    ]) {
      assert.equal(decision(command, []), 'allow', `${command} without targets`)
      const verdict = assessShellHarm(command, context)
      assert.equal(verdict.action, 'prompt', command)
      assert.ok(verdict.reasons.some((reason) => reason.startsWith('reaches a production target')))
    }
  })

  it('matches whole names only, and only for infrastructure programs', () => {
    for (const command of [
      'kubectl get pods --context prod-eu-staging',
      'kubectl get pods --context staging',
      'grep prod-eu deploy/values.yaml',
      'echo db.prod.example',
    ]) {
      assert.equal(decision(command), 'allow', command)
    }
  })
})
