import '../../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createGhCliSection } from './gh-cli-section.ts'
import { createFakeApi } from '../../fake-api.test-support.ts'

describe('GitHub CLI settings section', () => {
  it('names the token gh reads for each kind of host as the API fallback', () => {
    const section = createGhCliSection(createFakeApi(), { deferOrdinaryWrites: true })
    const help = [...section.root.querySelectorAll('.settings-fieldset-desc')].at(-1)
    assert.equal(
      help?.textContent,
      'Choose how Copse reaches GitHub. Automatic uses the gh CLI when it is signed in, ' +
        'otherwise the GitHub REST/GraphQL API with your gh login or a token: GH_TOKEN or ' +
        'GITHUB_TOKEN for github.com, or GH_ENTERPRISE_TOKEN when GH_HOST names a GitHub ' +
        'Enterprise server.',
    )
  })
})
