import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  blockDeviceMappings,
  type CloudHost,
  type FleetTags,
  hasFlag,
  hostPrefix,
  isFatalSshProbeError,
  isScalewayQuotaError,
  isScalewayZoneUnavailableError,
  isTransientSshSessionError,
  option,
  optionWithDefault,
  parseAwsInstances,
  parseOptions,
  parseScalewayServer,
  scalewayJsonArgs,
  scalewayServerFromRecord,
  scalewayTagArgs,
  scalewayTags,
  scalewayTerminateArgs,
  selectScaleDownHosts,
  shellQuote,
  sshCommonArgs,
  sshProbeError,
  sshTarget,
  tagSpecifications,
  userDataScript,
  withScalewayZone,
} from './cloud-hosts.mts'

const SCW_TTL = { secretKey: 'scw-test-secret', zone: 'fr-par-1' }

const TAGS: FleetTags = { kind: 'copse-burst', managedBy: 'copse-burst-runners' }

describe('parseOptions', () => {
  it('parses --key value, --key=value, and bare flags', () => {
    const options = parseOptions(
      ['node', 'script', 'up', '--name', 'fleet', '--ttl-minutes=30', '--serial'],
      3,
    )
    assert.deepEqual(options, { name: 'fleet', 'ttl-minutes': '30', serial: true })
  })

  it('treats a following --option as a flag boundary, not a value', () => {
    const options = parseOptions(['--serial', '--name', 'x'], 0)
    assert.deepEqual(options, { serial: true, name: 'x' })
  })

  it('keeps empty =-values as empty strings', () => {
    assert.deepEqual(parseOptions(['--key-path='], 0), { 'key-path': '' })
  })
})

describe('option helpers', () => {
  it('option returns string values and undefined for absent keys', () => {
    assert.equal(option({ name: 'x' }, 'name'), 'x')
    assert.equal(option({}, 'name'), undefined)
  })

  it('optionWithDefault falls back only when absent', () => {
    assert.equal(optionWithDefault({ name: 'x' }, 'name', 'y'), 'x')
    assert.equal(optionWithDefault({}, 'name', 'y'), 'y')
  })

  it('hasFlag is true only for bare flags, not string values', () => {
    assert.equal(hasFlag({ yes: true }, 'yes'), true)
    assert.equal(hasFlag({ yes: 'true' }, 'yes'), false)
    assert.equal(hasFlag({}, 'yes'), false)
  })
})

describe('selectScaleDownHosts', () => {
  const hosts: CloudHost[] = [
    {
      launchTime: '2026-07-21T08:00:00Z',
      name: 'oldest',
      privateIp: '',
      providerId: 'host-a',
      publicIp: '',
      state: 'running',
    },
    {
      launchTime: '2026-07-21T10:00:00Z',
      name: 'newest-b',
      privateIp: '',
      providerId: 'host-b',
      publicIp: '',
      state: 'running',
    },
    {
      launchTime: '2026-07-21T10:00:00Z',
      name: 'newest-c',
      privateIp: '',
      providerId: 'host-c',
      publicIp: '',
      state: 'running',
    },
  ]

  it('returns the full provider order when no partial count is requested', () => {
    assert.equal(selectScaleDownHosts(hosts, undefined), hosts)
  })

  it('selects newest hosts first with a stable provider-id tie break', () => {
    assert.deepEqual(
      selectScaleDownHosts(hosts, 2).map((host) => host.providerId),
      ['host-b', 'host-c'],
    )
    assert.deepEqual(
      hosts.map((host) => host.providerId),
      ['host-a', 'host-b', 'host-c'],
    )
  })

  it('refuses to turn a partial scale-down into a full fleet teardown', () => {
    assert.throws(() => selectScaleDownHosts(hosts, 3), /would terminate the entire 3-host fleet/)
    assert.throws(() => selectScaleDownHosts(hosts, 4), /would terminate the entire 3-host fleet/)
  })
})

describe('shellQuote', () => {
  it('wraps in single quotes and escapes embedded single quotes', () => {
    assert.equal(shellQuote('plain'), "'plain'")
    assert.equal(shellQuote("it's"), "'it'\\''s'")
  })
})

describe('AWS tagging and launch payloads', () => {
  it('tagSpecifications carries name, ttl, and the fleet ManagedBy tag', () => {
    const spec = tagSpecifications('my-fleet', 90, TAGS)
    assert.equal(
      spec,
      'ResourceType=instance,Tags=[{Key=Name,Value=my-fleet},{Key=CopseBurst,Value=true},{Key=CopseBurstName,Value=my-fleet},{Key=CopseBurstTtlMinutes,Value=90},{Key=ManagedBy,Value=copse-burst-runners}]',
    )
  })

  it('blockDeviceMappings requests a delete-on-termination gp3 root volume', () => {
    assert.deepEqual(JSON.parse(blockDeviceMappings(80)), [
      {
        DeviceName: '/dev/sda1',
        Ebs: { DeleteOnTermination: true, VolumeSize: 80, VolumeType: 'gp3' },
      },
    ])
  })

  it('parseAwsInstances maps describe-instances JSON to CloudHost fields', () => {
    const raw = JSON.stringify([
      {
        InstanceId: 'i-123',
        State: 'running',
        PublicIpAddress: '1.2.3.4',
        PrivateIpAddress: '10.0.0.1',
        LaunchTime: '2026-07-17T00:00:00Z',
        Name: 'copse-burst',
      },
      { InstanceId: 'i-456', State: 'pending', PublicIpAddress: null, Name: null },
    ])
    const hosts = parseAwsInstances(raw)
    assert.equal(hosts.length, 2)
    assert.deepEqual(hosts[0], {
      launchTime: '2026-07-17T00:00:00Z',
      name: 'copse-burst',
      privateIp: '10.0.0.1',
      providerId: 'i-123',
      publicIp: '1.2.3.4',
      state: 'running',
    })
    assert.deepEqual(hosts[1], {
      launchTime: '',
      name: '',
      privateIp: '',
      providerId: 'i-456',
      publicIp: '',
      state: 'pending',
    })
  })

  it('parseAwsInstances rejects non-array and malformed rows', () => {
    assert.throws(() => parseAwsInstances('{}'))
    assert.throws(() => parseAwsInstances(JSON.stringify([{ State: 'running' }])))
  })
})

describe('userDataScript', () => {
  it('schedules a TTL shutdown when ttlMinutes > 0 (AWS)', () => {
    const script = userDataScript(90)
    assert.match(script, /shutdown -h \+90 "Copse burst runner TTL \(90 minutes\) reached"/)
    assert.match(script, /docker\.io/)
    assert.doesNotMatch(script, /ttl-terminate\.sh/)
  })

  it('omits the shutdown when ttlMinutes is 0', () => {
    assert.doesNotMatch(userDataScript(0), /shutdown -h/)
    assert.doesNotMatch(userDataScript(0, 'x', SCW_TTL), /ttl-terminate\.sh/)
  })

  it('labels the shutdown message per fleet kind', () => {
    assert.match(userDataScript(30, 'Copse remote e2e host'), /Copse remote e2e host TTL/)
  })

  it('schedules Scaleway API self-terminate instead of guest shutdown', () => {
    const script = userDataScript(45, 'Copse burst runner', SCW_TTL)
    assert.doesNotMatch(script, /shutdown -h/)
    assert.match(script, /ttl-terminate\.sh/)
    assert.match(script, /"action":"terminate"/)
    assert.match(script, /systemd-run/)
    assert.match(script, /--on-active=45min/)
    assert.match(script, /fr-par-1/)
    assert.match(script, /scw-test-secret/)
    assert.match(script, /\/instance\/v1\/zones\/\$ZONE\/ips\/\$IP_ID/)
    // terminate only detaches SBS; TTL must delete volumes explicitly.
    assert.match(script, /\/block\/v1alpha1\/zones\/\$ZONE\/volumes\//)
  })
})

describe('Scaleway helpers', () => {
  it('recognizes unsupported server types as a zone-local fallback condition', () => {
    assert.equal(
      isScalewayZoneUnavailableError(
        new Error('Server type "BASIC3-X4C-16G" is not available on this zone.'),
      ),
      true,
    )
    assert.equal(isScalewayZoneUnavailableError(new Error('permission denied')), false)
  })

  it('scalewayTags namespaces by kind, name, and managedBy', () => {
    assert.deepEqual(scalewayTags('fleet', TAGS), [
      'copse-burst',
      'copse-burst-fleet',
      'copse-burst-runners',
    ])
    const other: FleetTags = { kind: 'copse-remote-e2e', managedBy: 'copse-remote-e2e-hosts' }
    assert.deepEqual(scalewayTags('dev', other), [
      'copse-remote-e2e',
      'copse-remote-e2e-dev',
      'copse-remote-e2e-hosts',
    ])
  })

  it('scalewayTagArgs produces indexed tag arguments', () => {
    assert.deepEqual(scalewayTagArgs('fleet', TAGS), [
      'tags.0=copse-burst',
      'tags.1=copse-burst-fleet',
      'tags.2=copse-burst-runners',
    ])
  })

  it('scalewayTerminateArgs deletes IP and block volumes in the right zone', () => {
    assert.deepEqual(scalewayTerminateArgs({ zone: 'fr-par-1' }, 'srv-1'), [
      'instance',
      'server',
      'terminate',
      'srv-1',
      'with-ip=true',
      'with-block=true',
      'zone=fr-par-1',
    ])
  })

  it('scalewayJsonArgs appends the zone before the json output flag', () => {
    assert.deepEqual(scalewayJsonArgs({ zone: 'nl-ams-1' }, ['instance', 'server', 'list']), [
      'instance',
      'server',
      'list',
      'zone=nl-ams-1',
      '-o',
      'json',
    ])
  })

  it('isScalewayQuotaError matches quota messages case-insensitively', () => {
    assert.equal(isScalewayQuotaError(new Error('scw: Quota Exceeded for this resource')), true)
    assert.equal(isScalewayQuotaError(new Error('connection refused')), false)
    assert.equal(isScalewayQuotaError('quota exceeded'), true)
  })

  it('parseScalewayServer unwraps the server envelope and nested IPs', () => {
    const raw = JSON.stringify({
      server: {
        id: 'srv-1',
        name: 'copse-burst-x',
        state: 'running',
        creation_date: '2026-07-17T00:00:00Z',
        public_ip: { address: '1.2.3.4' },
        private_ip: { address: '10.0.0.1' },
      },
    })
    assert.deepEqual(parseScalewayServer(raw), {
      launchTime: '2026-07-17T00:00:00Z',
      name: 'copse-burst-x',
      privateIp: '10.0.0.1',
      providerId: 'srv-1',
      publicIp: '1.2.3.4',
      state: 'running',
    })
  })

  it('scalewayServerFromRecord falls back to public_ips arrays and camelCase keys', () => {
    const fromArray = scalewayServerFromRecord({
      id: 'srv-2',
      state: 'starting',
      public_ips: [{ address: '5.6.7.8' }],
    })
    assert.equal(fromArray.publicIp, '5.6.7.8')

    const fromCamel = scalewayServerFromRecord({
      id: 'srv-3',
      state: 'running',
      publicIp: { address: '9.9.9.9' },
      creationDate: '2026-07-17T01:00:00Z',
    })
    assert.equal(fromCamel.publicIp, '9.9.9.9')
    assert.equal(fromCamel.launchTime, '2026-07-17T01:00:00Z')
  })

  it('withScalewayZone stamps the zone without mutating the host', () => {
    const host: CloudHost = {
      launchTime: '',
      name: '',
      privateIp: '',
      providerId: 'srv-1',
      publicIp: '',
      state: 'running',
    }
    const zoned = withScalewayZone(host, 'pl-waw-2')
    assert.equal(zoned.zone, 'pl-waw-2')
    assert.equal(host.zone, undefined)
  })
})

describe('SSH helpers', () => {
  const host: CloudHost = {
    launchTime: '',
    name: 'copse-burst',
    privateIp: '10.0.0.1',
    providerId: 'i-123',
    publicIp: '1.2.3.4',
    state: 'running',
  }

  it('sshTarget picks the requested IP', () => {
    assert.equal(
      sshTarget({ keyPath: '', remoteUser: 'ubuntu', sshHost: 'public' }, host),
      'ubuntu@1.2.3.4',
    )
    assert.equal(
      sshTarget({ keyPath: '', remoteUser: 'root', sshHost: 'private' }, host),
      'root@10.0.0.1',
    )
  })

  it('sshCommonArgs includes the identity only when a key path is set', () => {
    const withKey = sshCommonArgs({ keyPath: '/k.pem', remoteUser: 'u', sshHost: 'public' }, 5)
    assert.deepEqual(withKey.slice(0, 4), ['-i', '/k.pem', '-o', 'IdentitiesOnly=yes'])
    assert.ok(withKey.includes('BatchMode=yes'))
    assert.ok(withKey.includes('ConnectTimeout=5'))
    assert.ok(withKey.includes('ServerAliveInterval=30'))
    assert.ok(withKey.includes('ServerAliveCountMax=4'))

    const withoutKey = sshCommonArgs({ keyPath: '', remoteUser: 'u', sshHost: 'public' }, 15)
    assert.equal(withoutKey.includes('-i'), false)
    assert.ok(withoutKey.includes('ConnectTimeout=15'))
    assert.ok(withoutKey.includes('ServerAliveInterval=30'))
  })

  it('isTransientSshSessionError matches transport drops, not remote command failures', () => {
    assert.equal(
      isTransientSshSessionError(
        new Error('ssh … root@1.2.3.4 bash -lc … failed with exit code 255'),
      ),
      true,
    )
    assert.equal(isTransientSshSessionError(new Error('client_loop: send disconnect: Broken pipe')), true)
    assert.equal(isTransientSshSessionError(new Error('Connection reset by peer')), true)
    assert.equal(
      isTransientSshSessionError(new Error('ssh … failed with exit code 1')),
      false,
    )
    assert.equal(isTransientSshSessionError(new Error('Permission denied (publickey).')), false)
  })

  it('hostPrefix brackets the provider id', () => {
    assert.equal(hostPrefix(host), '[i-123] ')
  })

  it('sshProbeError picks the first informative stderr line', () => {
    const stderr = [
      '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
      'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!',
      'ssh: connect to host 1.2.3.4 port 22: Connection refused',
    ].join('\n')
    assert.equal(sshProbeError(stderr), 'ssh: connect to host 1.2.3.4 port 22: Connection refused')
    assert.equal(sshProbeError(''), 'unknown SSH error')
  })

  it('isFatalSshProbeError flags auth failures but not transient refusals', () => {
    assert.equal(isFatalSshProbeError('root@1.2.3.4: Permission denied (publickey).'), true)
    assert.equal(isFatalSshProbeError('Too many authentication failures'), true)
    assert.equal(isFatalSshProbeError('Connection refused'), false)
    assert.equal(isFatalSshProbeError('Connection timed out'), false)
  })
})
