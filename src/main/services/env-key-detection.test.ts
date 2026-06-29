import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_EXTRA_PROVIDERS } from '@shared/llm/extra-providers.ts'
import {
  PROVIDER_ENV_VARS,
  WELL_KNOWN_ENV_FILES,
  parseEnvAssignments,
  collectDetectedKeys,
  scanEnvForKeys,
  maskSecret,
  type EnvSource,
} from './env-key-detection.ts'

describe('parseEnvAssignments', () => {
  it('parses export, bare, quoted and aliased forms', () => {
    const parsed = parseEnvAssignments(
      [
        '# a comment',
        '',
        'export ANTHROPIC_API_KEY=sk-ant-abc123456',
        'OPENAI_API_KEY="sk-openai-quoted-1"',
        "CURSOR_API_KEY='cur_single_quoted'",
        '   export   MISTRAL_API_KEY=ms-padded-key  ',
      ].join('\n'),
    )
    assert.equal(parsed.get('ANTHROPIC_API_KEY'), 'sk-ant-abc123456')
    assert.equal(parsed.get('OPENAI_API_KEY'), 'sk-openai-quoted-1')
    assert.equal(parsed.get('CURSOR_API_KEY'), 'cur_single_quoted')
    assert.equal(parsed.get('MISTRAL_API_KEY'), 'ms-padded-key')
  })

  it('strips inline comments from unquoted values', () => {
    const parsed = parseEnvAssignments('export OPENAI_API_KEY=sk-bare-value # set at work')
    assert.equal(parsed.get('OPENAI_API_KEY'), 'sk-bare-value')
  })

  it('parses fish and csh export syntax', () => {
    const parsed = parseEnvAssignments(
      ['set -gx ANTHROPIC_API_KEY sk-ant-fish-key1', 'setenv OPENAI_API_KEY sk-csh-key-12'].join(
        '\n',
      ),
    )
    assert.equal(parsed.get('ANTHROPIC_API_KEY'), 'sk-ant-fish-key1')
    assert.equal(parsed.get('OPENAI_API_KEY'), 'sk-csh-key-12')
  })

  it('keeps the last assignment when a var is set twice', () => {
    const parsed = parseEnvAssignments('OPENAI_API_KEY=first-value-1\nOPENAI_API_KEY=second-value2')
    assert.equal(parsed.get('OPENAI_API_KEY'), 'second-value2')
  })
})

describe('collectDetectedKeys', () => {
  it('maps known env vars onto provider slugs', () => {
    const sources: EnvSource[] = [
      {
        source: 'environment',
        vars: {
          ANTHROPIC_API_KEY: 'sk-ant-abcdefgh',
          OPENAI_API_KEY: 'sk-openai-1234',
          HF_TOKEN: 'hf_abcdefghij',
          UNRELATED_VAR: 'ignore-me',
        },
      },
    ]
    const detected = collectDetectedKeys(sources)
    const byProvider = Object.fromEntries(detected.map((d) => [d.provider, d]))
    assert.equal(byProvider['anthropic']?.value, 'sk-ant-abcdefgh')
    assert.equal(byProvider['openai']?.value, 'sk-openai-1234')
    assert.equal(byProvider['huggingface']?.envVar, 'HF_TOKEN')
    assert.equal(byProvider['huggingface']?.provider, 'huggingface')
    assert.equal(
      detected.find((d) => d.provider === 'mistral'),
      undefined,
    )
  })

  it('lets the first source win for a provider (env over files)', () => {
    const sources: EnvSource[] = [
      { source: 'environment', vars: { ANTHROPIC_API_KEY: 'sk-ant-from-env' } },
      { source: '~/.zshrc', vars: { ANTHROPIC_API_KEY: 'sk-ant-from-file' } },
    ]
    const detected = collectDetectedKeys(sources)
    assert.equal(detected.length, 1)
    assert.equal(detected[0]?.value, 'sk-ant-from-env')
    assert.equal(detected[0]?.source, 'environment')
  })

  it('falls back to a file when env lacks the key', () => {
    const sources: EnvSource[] = [
      { source: 'environment', vars: {} },
      { source: '~/.zshrc', vars: parseEnvAssignments('export OPENAI_API_KEY=sk-from-file-1') },
    ]
    const detected = collectDetectedKeys(sources)
    assert.equal(detected[0]?.provider, 'openai')
    assert.equal(detected[0]?.source, '~/.zshrc')
  })

  it('recognises provider aliases', () => {
    const detected = collectDetectedKeys([
      { source: 'environment', vars: { GOOGLE_GENERATIVE_AI_API_KEY: 'AIza-aliased-key' } },
    ])
    assert.equal(detected[0]?.provider, 'gemini')
  })

  it('skips placeholders, shell refs, and too-short values', () => {
    const detected = collectDetectedKeys([
      {
        source: 'environment',
        vars: {
          ANTHROPIC_API_KEY: 'your-key-here',
          OPENAI_API_KEY: '$OPENAI_API_KEY',
          CURSOR_API_KEY: 'short',
          DEEPSEEK_API_KEY: '   ',
        },
      },
    ])
    assert.deepEqual(detected, [])
  })

  it('reports detections in the declared provider order', () => {
    const detected = collectDetectedKeys([
      {
        source: 'environment',
        vars: {
          OPENAI_API_KEY: 'sk-openai-order',
          ANTHROPIC_API_KEY: 'sk-ant-order12',
        },
      },
    ])
    assert.deepEqual(
      detected.map((d) => d.provider),
      ['anthropic', 'openai'],
    )
  })
})

describe('scanEnvForKeys', () => {
  it('reads process.env and only the well-known files that exist', () => {
    const files: Record<string, string> = {
      '/home/u/.zshrc': 'export OPENAI_API_KEY=sk-zshrc-openai1',
      '/home/u/.bashrc': 'export CURSOR_API_KEY=cur_from_bashrc1',
    }
    const detected = scanEnvForKeys({
      env: { ANTHROPIC_API_KEY: 'sk-ant-from-env-1' },
      homeDir: '/home/u',
      fileExists: (p) => p in files,
      readFile: (p) => files[p]!,
    })
    const providers = detected.map((d) => d.provider).sort()
    assert.deepEqual(providers, ['anthropic', 'cursor', 'openai'])
  })

  it('ignores unreadable files without throwing', () => {
    const detected = scanEnvForKeys({
      env: {},
      homeDir: '/home/u',
      fileExists: () => true,
      readFile: () => {
        throw new Error('EACCES')
      },
    })
    assert.deepEqual(detected, [])
  })
})

describe('maskSecret', () => {
  it('hides the middle of a key', () => {
    assert.equal(maskSecret('sk-ant-abcdef1234'), 'sk-…34')
    assert.match(maskSecret('short'), /^•+$/)
  })
})

describe('provider coverage', () => {
  it('includes an env var for every built-in OpenAI-compatible provider', () => {
    for (const provider of BUILTIN_EXTRA_PROVIDERS) {
      if (!provider.envVar) continue
      const names = PROVIDER_ENV_VARS[provider.id] ?? []
      assert.ok(
        names.includes(provider.envVar),
        `expected ${provider.id} detection to cover ${provider.envVar}`,
      )
    }
  })

  it('declares a non-empty, home-relative file allow-list', () => {
    assert.ok(WELL_KNOWN_ENV_FILES.length > 0)
    for (const f of WELL_KNOWN_ENV_FILES) assert.ok(!f.startsWith('/'), `${f} must be relative`)
  })
})
