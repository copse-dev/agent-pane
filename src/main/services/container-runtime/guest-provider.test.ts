import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIProvider } from '@copse/llm/openai-provider.ts'
import {
  buildProviderFromDescription,
  type ProviderDescription,
} from '../providers/provider-description.ts'
import { HOST_LOCAL_ALIAS } from './egress-rules.ts'
import { buildGuestProvider } from './guest-provider.ts'

/** LM Studio on the desktop's loopback, as `resolveContainerProvider` hands it to the guest. */
function hostLocal(url: string, local = true): ProviderDescription {
  return {
    kind: 'openai-compatible',
    model: 'qwen3',
    apiKeySlug: 'lmstudio',
    url,
    label: 'LM Studio',
    local,
    includeUsage: true,
    apiStyle: null,
    extraBody: null,
    params: {},
  }
}

describe('buildGuestProvider', () => {
  it('builds a plain-http client for the host-local alias', () => {
    // The alias reaches nothing but the host broker, over the container's
    // stdio, and the broker dials the host's loopback; so it is loopback here.
    const provider = buildGuestProvider(hostLocal(`http://${HOST_LOCAL_ALIAS}:1234/v1`), null)
    assert.ok(provider instanceof OpenAIProvider)
  })

  it('carries a key to the alias as it would to the desktop loopback', () => {
    const provider = buildGuestProvider(
      hostLocal(`http://${HOST_LOCAL_ALIAS}:443/v1`, false),
      'sk-run-key',
    )
    assert.ok(provider instanceof OpenAIProvider)
  })

  it('still refuses plain http to any other host', () => {
    for (const url of [
      'http://api.acme.example/v1',
      `http://${HOST_LOCAL_ALIAS}.attacker.example/v1`,
      'http://copse.internal/v1',
      'http://10.0.0.5:1234/v1',
    ]) {
      assert.throws(
        () => buildGuestProvider(hostLocal(url), 'sk-run-key'),
        /may only use http: for loopback hosts/,
        url,
      )
    }
  })

  it('is the guest alone that reads the alias as loopback', () => {
    // The desktop builds from the same description without the alias option,
    // and its credential-URL rule is unchanged.
    assert.throws(
      () =>
        buildProviderFromDescription(hostLocal(`http://${HOST_LOCAL_ALIAS}:1234/v1`), {
          apiKey: null,
          approvedHosts: [HOST_LOCAL_ALIAS],
        }),
      /may only use http: for loopback hosts/,
    )
  })
})
