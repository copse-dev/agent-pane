import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  INTERCEPTED_REGISTRY_HOSTS,
  interceptedEcosystem,
  metadataForRequest,
  normalizeHost,
  normalizePythonName,
  packageForDownload,
  packageKey,
  pythonDistribution,
} from './registry-targets.ts'

describe('packageForDownload — npm', () => {
  it('reads name and version from registry tarball URLs', () => {
    assert.deepEqual(packageForDownload('registry.npmjs.org', '/lodash/-/lodash-4.17.21.tgz'), {
      ecosystem: 'npm',
      name: 'lodash',
      version: '4.17.21',
    })
    assert.deepEqual(
      packageForDownload('registry.yarnpkg.com', '/@types/node/-/node-26.6.5.tgz?cache=1'),
      { ecosystem: 'npm', name: '@types/node', version: '26.6.5' },
    )
  })

  it('decodes an encoded scope separator', () => {
    assert.deepEqual(
      packageForDownload('registry.npmjs.org', '/@factiii%2frunner/-/runner-0.28.0.tgz'),
      { ecosystem: 'npm', name: '@factiii/runner', version: '0.28.0' },
    )
  })

  it('keeps a prerelease version intact', () => {
    assert.equal(
      packageForDownload('registry.npmjs.org', '/evil/-/evil-0.0.1-security.tgz')?.version,
      '0.0.1-security',
    )
  })

  it('still names the package when the file name does not carry a version', () => {
    assert.deepEqual(packageForDownload('registry.npmjs.org', '/evil/-/renamed.tgz'), {
      ecosystem: 'npm',
      name: 'evil',
      version: null,
    })
  })

  it('ignores packuments and other metadata', () => {
    for (const path of ['/lodash', '/@types%2fnode', '/-/v1/search?text=x', '/lodash/4.17.21']) {
      assert.equal(packageForDownload('registry.npmjs.org', path), null, path)
    }
  })

  it('treats a malformed escape as metadata rather than throwing', () => {
    assert.equal(packageForDownload('registry.npmjs.org', '/%E0%A4%A/-/x-1.0.0.tgz'), null)
  })
})

describe('packageForDownload — PyPI', () => {
  it('reads wheels and sdists from files.pythonhosted.org', () => {
    assert.deepEqual(
      packageForDownload(
        'files.pythonhosted.org',
        '/packages/d9/5a/e7c31adbe875f2abbb91bd84cf2dc52d792b5a01506781dbcf25c91daf11/six-1.16.0-py2.py3-none-any.whl',
      ),
      { ecosystem: 'PyPI', name: 'six', version: '1.16.0' },
    )
    assert.deepEqual(
      packageForDownload('files.pythonhosted.org', '/packages/aa/bb/Foo_Bar.Baz-2.0.1.tar.gz'),
      { ecosystem: 'PyPI', name: 'foo-bar-baz', version: '2.0.1' },
    )
  })

  it('ignores PEP 658 metadata files and paths outside /packages/', () => {
    assert.equal(
      packageForDownload(
        'files.pythonhosted.org',
        '/packages/aa/six-1.16.0-py3-none-any.whl.metadata',
      ),
      null,
    )
    assert.equal(packageForDownload('files.pythonhosted.org', '/six-1.16.0.tar.gz'), null)
  })

  it('normalises names per PEP 503', () => {
    assert.equal(normalizePythonName('Typing_Extensions'), 'typing-extensions')
    assert.equal(normalizePythonName('zope..interface'), 'zope-interface')
    assert.deepEqual(pythonDistribution('requests_oauthlib-2.0.0-py2.py3-none-any.whl'), {
      ecosystem: 'PyPI',
      name: 'requests-oauthlib',
      version: '2.0.0',
    })
    assert.equal(pythonDistribution('README.txt'), null)
  })
})

describe('packageForDownload — crates.io', () => {
  it('reads every download URL shape cargo uses', () => {
    const expected = { ecosystem: 'crates.io', name: 'itoa', version: '1.0.11' }
    assert.deepEqual(
      packageForDownload('static.crates.io', '/crates/itoa/1.0.11/download'),
      expected,
    )
    assert.deepEqual(
      packageForDownload('static.crates.io', '/crates/itoa/itoa-1.0.11.crate'),
      expected,
    )
    assert.deepEqual(
      packageForDownload('crates.io', '/api/v1/crates/itoa/1.0.11/download'),
      expected,
    )
  })

  it('ignores API metadata', () => {
    assert.equal(packageForDownload('crates.io', '/api/v1/crates/itoa'), null)
    assert.equal(packageForDownload('static.crates.io', '/rss/crates/itoa.xml'), null)
  })
})

describe('intercepted hosts', () => {
  it('classifies nothing outside the intercepted list', () => {
    assert.equal(packageForDownload('registry.example.com', '/lodash/-/lodash-1.0.0.tgz'), null)
    assert.equal(packageForDownload('pypi.example.com', '/packages/aa/six-1.16.0.tar.gz'), null)
  })

  it('reads downloads only from the hosts that serve them', () => {
    assert.equal(packageForDownload('pypi.org', '/packages/aa/six-1.16.0.tar.gz'), null)
    assert.equal(packageForDownload('index.crates.io', '/crates/itoa/itoa-1.0.0.crate'), null)
  })

  it('treats a fully qualified name with trailing dots as the same registry', () => {
    assert.equal(normalizeHost('Registry.NPMJS.org.'), 'registry.npmjs.org')
    assert.equal(normalizeHost('static.crates.io..'), 'static.crates.io')
    assert.equal(interceptedEcosystem('registry.npmjs.org.'), 'npm')
    assert.equal(interceptedEcosystem('files.pythonhosted.org.'), 'PyPI')
    assert.deepEqual(packageForDownload('static.crates.io.', '/crates/itoa/itoa-1.0.11.crate'), {
      ecosystem: 'crates.io',
      name: 'itoa',
      version: '1.0.11',
    })
  })

  it('covers each supported ecosystem', () => {
    assert.deepEqual(
      new Set(INTERCEPTED_REGISTRY_HOSTS.values()),
      new Set(['npm', 'PyPI', 'crates.io']),
    )
  })

  it('keys versionless lookups separately from versioned ones', () => {
    assert.notEqual(
      packageKey({ ecosystem: 'npm', name: 'x', version: null }),
      packageKey({ ecosystem: 'npm', name: 'x', version: '1.0.0' }),
    )
  })
})

describe('metadataForRequest', () => {
  it('names the package of an npm packument, scoped or not', () => {
    assert.deepEqual(metadataForRequest('registry.npmjs.org', '/lodash'), {
      ecosystem: 'npm',
      name: 'lodash',
    })
    assert.deepEqual(metadataForRequest('registry.yarnpkg.com', '/@types%2fnode'), {
      ecosystem: 'npm',
      name: '@types/node',
    })
    assert.deepEqual(metadataForRequest('registry.npmjs.org', '/@types/node'), {
      ecosystem: 'npm',
      name: '@types/node',
    })
  })

  it('leaves other npm endpoints alone', () => {
    for (const path of [
      '/',
      '/lodash/-/lodash-4.17.21.tgz',
      '/lodash/4.17.21',
      '/lodash/latest',
      '/-/v1/search?text=x',
      '/-/npm/v1/security/advisories/bulk',
    ]) {
      assert.equal(metadataForRequest('registry.npmjs.org', path), null, path)
    }
  })

  it('names the project of a PyPI simple index page', () => {
    assert.deepEqual(metadataForRequest('pypi.org', '/simple/Typing_Extensions/'), {
      ecosystem: 'PyPI',
      name: 'typing-extensions',
    })
    assert.deepEqual(metadataForRequest('pypi.org', '/simple/six'), {
      ecosystem: 'PyPI',
      name: 'six',
    })
    assert.equal(metadataForRequest('pypi.org', '/simple/'), null)
    assert.equal(metadataForRequest('pypi.org', '/pypi/six/json'), null)
  })

  it('names the crate of a sparse index file', () => {
    const files = [
      { path: '/1/a', name: 'a' },
      { path: '/2/ab', name: 'ab' },
      { path: '/3/a/abc', name: 'abc' },
      { path: '/se/rd/serde', name: 'serde' },
    ]
    for (const { path, name } of files) {
      assert.deepEqual(metadataForRequest('index.crates.io', path), {
        ecosystem: 'crates.io',
        name,
      })
    }
    assert.equal(metadataForRequest('index.crates.io', '/config.json'), null)
  })

  it('treats a registry named with a trailing dot as the same registry', () => {
    assert.deepEqual(metadataForRequest('pypi.org.', '/simple/six/'), {
      ecosystem: 'PyPI',
      name: 'six',
    })
    assert.deepEqual(metadataForRequest('Registry.NPMJS.org.', '/lodash'), {
      ecosystem: 'npm',
      name: 'lodash',
    })
  })

  it('names nothing on download hosts or unknown hosts', () => {
    assert.equal(metadataForRequest('files.pythonhosted.org', '/simple/six/'), null)
    assert.equal(metadataForRequest('static.crates.io', '/se/rd/serde'), null)
    assert.equal(metadataForRequest('registry.example.com', '/lodash'), null)
  })
})
