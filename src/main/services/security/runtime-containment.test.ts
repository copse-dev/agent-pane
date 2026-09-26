import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ContainerRuntimeAttestation } from '@shared/types/unattended-run.ts'
import {
  clearRuntimeContainmentForTests,
  containerAttestationShortfall,
  declareContainerRuntime,
  guestContainmentShortfall,
  parseContainerRuntimeAttestation,
  parseGuestContainment,
  runtimeContainmentTier,
  type GuestContainmentObservation,
  upNetworkInterfaces,
} from './runtime-containment.ts'

afterEach(() => {
  clearRuntimeContainmentForTests()
})

const COMMON = {
  runtimeId: 'run-test',
  image: 'copse-worker:local',
  user: 1001,
  readOnlyRootfs: true,
  capDropAll: true,
  noNewPrivileges: true,
  pidsLimit: 512,
  memoryLimit: '4g',
  network: 'brokered',
  perCommandNetwork: 'token-gated',
  egressAllowlist: ['api.anthropic.com:443'],
  hostMounts: ['/run/copse', '/run/copse/state', '/run/copse/out'],
} satisfies ContainerRuntimeAttestation

/** What `buildAttestation` writes for a Docker run. */
function docker(overrides: Partial<ContainerRuntimeAttestation> = {}): ContainerRuntimeAttestation {
  return {
    ...COMMON,
    engine: 'docker',
    isolation: 'shared-kernel',
    securityProfiles: 'default',
    processLimit: 'cgroup-pids',
    ...overrides,
  }
}

/** What `buildAttestation` writes for an Apple container run. */
function apple(overrides: Partial<ContainerRuntimeAttestation> = {}): ContainerRuntimeAttestation {
  return {
    ...COMMON,
    engine: 'apple',
    isolation: 'vm',
    securityProfiles: 'none',
    processLimit: 'rlimit-nproc',
    ...overrides,
  }
}

function contained(
  overrides: Partial<GuestContainmentObservation> = {},
): GuestContainmentObservation {
  return {
    uid: 1001,
    capabilitySets: { inheritable: 0n, permitted: 0n, effective: 0n, bounding: 0n, ambient: 0n },
    noNewPrivileges: true,
    upNetworkInterfaces: ['lo'],
    rootMountOptions: ['ro', 'relatime'],
    ...overrides,
  }
}

describe('the attestation bar, per engine', () => {
  it('accepts what each engine attests', () => {
    assert.equal(containerAttestationShortfall(docker()), null)
    assert.equal(containerAttestationShortfall(apple()), null)
  })

  it('reads a Docker record written before engines were named as Docker', () => {
    const legacy: ContainerRuntimeAttestation = { ...COMMON, securityProfiles: 'default' }
    assert.equal(containerAttestationShortfall(legacy), null)
  })

  it('holds a shared-kernel container to its default seccomp and AppArmor profiles', () => {
    for (const securityProfiles of ['unconfined', 'none', undefined] as const) {
      const attestation = docker()
      if (securityProfiles === undefined) delete attestation.securityProfiles
      else attestation.securityProfiles = securityProfiles
      assert.match(
        containerAttestationShortfall(attestation) ?? '',
        /shared-kernel container needs its default seccomp and AppArmor/,
      )
    }
  })

  it('refuses an Apple container attestation missing any required property', () => {
    const cases: Array<[string, ContainerRuntimeAttestation, RegExp]> = [
      ['root worker', apple({ user: 0 }), /worker runs as root/],
      ['writable root', apple({ readOnlyRootfs: false }), /root filesystem is writable/],
      ['capabilities kept', apple({ capDropAll: false }), /capabilities were not dropped/],
      ['no-new-privileges off', apple({ noNewPrivileges: false }), /no-new-privileges is not set/],
      [
        'allowlist without a broker',
        apple({ network: 'none', egressAllowlist: ['x:1'] }),
        /allowlist declared without a broker/,
      ],
      [
        'a host path mounted',
        apple({ hostMounts: ['/run/copse', '/Users/me'] }),
        /host path mounted into the guest: \/Users\/me/,
      ],
      [
        'a shared kernel',
        apple({ isolation: 'shared-kernel' }),
        /apple cannot provide shared-kernel/,
      ],
      ['a faked seccomp claim', apple({ securityProfiles: 'default' }), /VM guest has no seccomp/],
      [
        'a cgroup pids limit it does not have',
        apple({ processLimit: 'cgroup-pids' }),
        /rlimit-nproc, not cgroup-pids/,
      ],
    ]
    for (const [label, attestation, reason] of cases) {
      assert.match(containerAttestationShortfall(attestation) ?? '', reason, label)
      assert.throws(
        () => {
          declareContainerRuntime(attestation, contained())
        },
        /Refusing to declare container containment/,
        label,
      )
      assert.notEqual(runtimeContainmentTier(), 'container', label)
    }
  })

  it('never defaults an Apple container field it did not state', () => {
    const { isolation: _isolation, ...noIsolation } = apple()
    const { securityProfiles: _profiles, ...noProfiles } = apple()
    const { processLimit: _limit, ...noLimit } = apple()
    for (const attestation of [noIsolation, noProfiles, noLimit]) {
      assert.notEqual(containerAttestationShortfall(attestation), null)
    }
  })

  it('refuses Docker claiming a VM of its own', () => {
    assert.match(
      containerAttestationShortfall(docker({ isolation: 'vm' })) ?? '',
      /docker cannot provide vm isolation/,
    )
  })

  it('round-trips an Apple container attestation and rejects an unknown engine', () => {
    assert.deepEqual(parseContainerRuntimeAttestation(JSON.stringify(apple())), apple())
    assert.equal(
      parseContainerRuntimeAttestation(JSON.stringify({ ...apple(), engine: 'podman' })),
      null,
    )
  })
})

// `/proc/self/status` and `/proc/self/mounts` as the worker uid saw them in an
// Apple container 1.4.1 guest started with the product's flags (the probe
// recorded in `docs/plans/thread-in-container.md`), trimmed to what is read.
const APPLE_GUEST_STATUS = [
  'Name:\tnode',
  'Uid:\t1001\t1001\t1001\t1001',
  'Gid:\t1001\t1001\t1001\t1001',
  'CapInh:\t0000000000000000',
  'CapPrm:\t0000000000000000',
  'CapEff:\t0000000000000000',
  'CapBnd:\t0000000000000000',
  'CapAmb:\t0000000000000000',
  'NoNewPrivs:\t1',
  'Seccomp:\t0',
].join('\n')
const APPLE_GUEST_MOUNTS = [
  '/dev/vdb / ext4 ro,relatime 0 0',
  'tmpfs /tmp tmpfs rw,nosuid,nodev,relatime,size=1048576k 0 0',
  '/dev/vdc /workspace ext4 rw,relatime 0 0',
  'virtiofs /run/copse virtiofs ro,relatime 0 0',
].join('\n')

describe('the guest checking itself', () => {
  it('reads what an Apple container guest sees and finds it contained', () => {
    const observed = parseGuestContainment({
      status: APPLE_GUEST_STATUS,
      mounts: APPLE_GUEST_MOUNTS,
      upNetworkInterfaces: ['lo'],
      uid: 1001,
    })
    assert.ok(typeof observed !== 'string')
    assert.deepEqual(observed, contained())
    assert.equal(guestContainmentShortfall(apple(), observed), null)
    declareContainerRuntime(apple(), observed)
    assert.equal(runtimeContainmentTier(), 'container')
  })

  it('counts the devices that are up, not the ones that exist', () => {
    // /sys/class/net in a Docker Desktop guest started with --network none:
    // the tunnel drivers' fallback devices, all down, and a control file.
    const dockerNone = [
      { name: 'bonding_masters', isFile: true, flags: null },
      { name: 'erspan0', isFile: false, flags: '0x1002\n' },
      { name: 'gre0', isFile: false, flags: '0x80\n' },
      { name: 'sit0', isFile: false, flags: '0x80\n' },
      { name: 'tunl0', isFile: false, flags: '0x80\n' },
      { name: 'lo', isFile: false, flags: '0x9\n' },
    ]
    assert.deepEqual(upNetworkInterfaces(dockerNone), ['lo'])
    // The same guest on a network: eth0 is up, and refused.
    assert.deepEqual(
      upNetworkInterfaces([...dockerNone, { name: 'eth0', isFile: false, flags: '0x1003\n' }]),
      ['lo', 'eth0'],
    )
    // Flags it cannot read count as up.
    assert.deepEqual(upNetworkInterfaces([{ name: 'eth0', isFile: false, flags: null }]), ['eth0'])
  })

  it('reads the last mount at / as the one in effect', () => {
    const observed = parseGuestContainment({
      status: APPLE_GUEST_STATUS,
      mounts: `rootfs / rootfs rw 0 0\noverlay / overlay ro,relatime,lowerdir=/x 0 0`,
      upNetworkInterfaces: ['lo'],
      uid: 1001,
    })
    assert.ok(typeof observed !== 'string')
    assert.deepEqual(observed.rootMountOptions, ['ro', 'relatime', 'lowerdir=/x'])
  })

  it('refuses to vouch for what it cannot read', () => {
    assert.equal(
      parseGuestContainment({
        status: APPLE_GUEST_STATUS.replace('CapBnd:\t0000000000000000', 'CapBnd:\tgarbage'),
        mounts: APPLE_GUEST_MOUNTS,
        upNetworkInterfaces: ['lo'],
        uid: 1001,
      }),
      'cannot read the capability sets',
    )
    assert.equal(
      parseGuestContainment({
        status: APPLE_GUEST_STATUS.replace('NoNewPrivs:\t1', ''),
        mounts: APPLE_GUEST_MOUNTS,
        upNetworkInterfaces: ['lo'],
        uid: 1001,
      }),
      'cannot read NoNewPrivs',
    )
    assert.throws(() => {
      declareContainerRuntime(apple(), 'cannot observe the guest: ENOENT')
    }, /Refusing to declare container containment: cannot observe the guest/)
  })

  it('refuses a declaration the guest contradicts', () => {
    const cases: Array<[string, GuestContainmentObservation, RegExp]> = [
      ['root', contained({ uid: 0 }), /runs as root/],
      ['another uid', contained({ uid: 1000 }), /uid 1000, not the attested 1001/],
      [
        'a bounding set left',
        contained({ capabilitySets: { ...contained().capabilitySets, bounding: 0x20n } }),
        /still holds bounding capabilities/,
      ],
      [
        'an ambient set left',
        contained({ capabilitySets: { ...contained().capabilitySets, ambient: 1n } }),
        /still holds ambient capabilities/,
      ],
      [
        'no-new-privileges off (Apple container without the entrypoint)',
        contained({ noNewPrivileges: false }),
        /no-new-privileges is off/,
      ],
      ['a writable root', contained({ rootMountOptions: ['rw'] }), /not mounted read-only/],
      [
        'a network device (Apple container on its default network)',
        contained({ upNetworkInterfaces: ['eth0', 'lo'] }),
        /network interface up: eth0/,
      ],
    ]
    for (const [label, observed, reason] of cases) {
      for (const attestation of [docker(), apple()]) {
        assert.match(guestContainmentShortfall(attestation, observed) ?? '', reason, label)
        assert.throws(
          () => {
            declareContainerRuntime(attestation, observed)
          },
          reason,
          label,
        )
      }
    }
    assert.notEqual(runtimeContainmentTier(), 'container')
  })
})
