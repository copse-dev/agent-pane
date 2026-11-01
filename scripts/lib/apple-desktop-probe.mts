import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'

export const APPLE_DESKTOP_PROBE_LABEL = 'dev.copse.desktop-probe'
export const APPLE_DESKTOP_PROBE_UID = 1001

/** No host mounts, sockets, ports, credentials, or network; all mutable state is tmpfs. */
export function appleDesktopProbeArgs(name: string, image: string): string[] {
  if (!/^copse-desktop-probe-[a-f0-9-]{36}$/.test(name)) throw new Error('Invalid probe name')
  if (!image || image.startsWith('-')) throw new Error('Provide an image reference')
  return [
    'create',
    '--name',
    name,
    '--label',
    `${APPLE_DESKTOP_PROBE_LABEL}=${name}`,
    '--init',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--network',
    'none',
    '--user',
    '1001:1001',
    '--memory',
    '4g',
    '--cpus',
    '2',
    '--ulimit',
    'nproc=512:512',
    '--tmpfs',
    '/tmp:rw,exec,nosuid,nodev,size=1g,mode=1777',
    '--env',
    'HOME=/tmp/home',
    '--entrypoint',
    '/usr/bin/setpriv',
    image,
    '--no-new-privs',
    '--',
    '/usr/local/bin/node',
    '--input-type=module',
    '-e',
    APPLE_DESKTOP_GUEST_PROBE,
  ]
}

const inspectSchema = z
  .array(
    z.object({
      configuration: z.object({
        capAdd: z.array(z.string()),
        capDrop: z.array(z.string()),
        readOnly: z.boolean(),
        networks: z.array(z.unknown()),
        useInit: z.boolean(),
        ssh: z.boolean(),
        virtualization: z.boolean(),
        publishedPorts: z.array(z.unknown()),
        publishedSockets: z.array(z.unknown()),
        labels: z.record(z.string(), z.string()),
        resources: z.object({ cpus: z.number(), memoryInBytes: z.number() }),
        initProcess: z.object({
          user: z.object({ raw: z.object({ userString: z.string() }) }),
          rlimits: z.array(z.object({ limit: z.string(), soft: z.number(), hard: z.number() })),
        }),
        mounts: z.array(
          z.object({
            destination: z.string(),
            source: z.string(),
            options: z.array(z.string()),
            type: z.record(z.string(), z.unknown()),
          }),
        ),
      }),
    }),
  )
  .length(1)

export type AppleDesktopProbeConfiguration = z.infer<typeof inspectSchema>[number]['configuration']

/** Refuse before start if the engine did not apply the requested boundary. */
export function appleDesktopProbeShortfall(name: string, json: string): string | null {
  const config = safeJsonParse(json, decodeWithSchema(inspectSchema))?.[0]?.configuration
  if (!config) return 'Apple container inspect is missing required containment fields'
  if (!config.readOnly || !config.useInit) return 'Read-only root and init are required'
  if (config.capAdd.length || !config.capDrop.some((cap) => cap.toUpperCase() === 'ALL'))
    return 'All capabilities must be dropped'
  if (config.networks.length || config.publishedPorts.length || config.publishedSockets.length)
    return 'Network attachments and published ports or sockets are forbidden'
  if (config.ssh || config.virtualization)
    return 'SSH forwarding and nested virtualization are forbidden'
  if (config.labels[APPLE_DESKTOP_PROBE_LABEL] !== name)
    return 'Probe ownership label does not match'
  if (config.initProcess.user.raw.userString !== '1001:1001')
    return 'Unprivileged uid 1001 is required'
  const nproc = config.initProcess.rlimits.filter((limit) => limit.limit === 'RLIMIT_NPROC')
  if (nproc.length !== 1 || nproc[0]?.soft !== 512 || nproc[0].hard !== 512)
    return 'The process limit is missing or ambiguous'
  if (config.resources.cpus !== 2 || config.resources.memoryInBytes !== 4 * 1024 ** 3)
    return 'The CPU or memory limit was not applied'
  const mount = config.mounts[0]
  if (
    config.mounts.length !== 1 ||
    !mount ||
    mount.destination !== '/tmp' ||
    mount.source !== 'tmpfs' ||
    Object.keys(mount.type).length !== 1 ||
    !Object.hasOwn(mount.type, 'tmpfs') ||
    !['rw', 'nosuid', 'nodev'].every((option) => mount.options.includes(option)) ||
    mount.options.includes('ro')
  )
    return 'Only the private /tmp tmpfs mount is allowed; host mounts are forbidden'
  return null
}

const reportSchema = z.object({
  uid: z.literal(1001),
  noNewPrivileges: z.literal(true),
  capabilitiesDropped: z.literal(true),
  rootReadOnly: z.literal(true),
  noHostMounts: z.literal(true),
  scratchWritable: z.literal(true),
  loopbackWorks: z.literal(true),
  externalNetworkDenied: z.literal(true),
  loopbackOnly: z.literal(true),
  noAmbientCredentials: z.literal(true),
})

export function decodeAppleDesktopProbeReport(text: string): z.infer<typeof reportSchema> {
  const report = safeJsonParse(text.trim(), decodeWithSchema(reportSchema))
  if (!report) throw new Error('Guest containment probe failed or returned an invalid report')
  return report
}

export interface AppleDesktopProbeEngine {
  run(args: string[]): Promise<string>
  /** Separate from the run's abort signal: cleanup must still work after cancellation. */
  remove(name: string): Promise<void>
}

/** The engine boundary is injected so refusal and cleanup can be tested without a VM. */
export async function runAppleDesktopProbe(
  name: string,
  image: string,
  engine: AppleDesktopProbeEngine,
): Promise<z.infer<typeof reportSchema>> {
  const args = appleDesktopProbeArgs(name, image)
  const failures: unknown[] = []
  let report: z.infer<typeof reportSchema> | undefined
  try {
    await engine.run(args)
    const shortfall = appleDesktopProbeShortfall(name, await engine.run(['inspect', name]))
    if (shortfall) throw new Error(`Refusing to start the guest: ${shortfall}`)
    report = decodeAppleDesktopProbeReport(await engine.run(['start', '--attach', name]))
  } catch (error) {
    failures.push(error)
  } finally {
    try {
      await engine.remove(name)
    } catch (error) {
      failures.push(
        new Error('Apple desktop probe teardown failed; inspect and remove ' + name, {
          cause: error,
        }),
      )
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      failures.map((error) => (error instanceof Error ? error.message : String(error))).join('; '),
    )
  if (!report) throw new Error('No guest report was produced')
  return report
}

/** Executed only by the guest entrypoint, after the host has checked inspect. */
export const APPLE_DESKTOP_GUEST_PROBE = String.raw`
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { createServer, createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
const status = readFileSync('/proc/self/status', 'utf8');
const mounts = readFileSync('/proc/self/mounts', 'utf8').split('\n').map(line => line.split(' '));
mkdirSync('/tmp/home', {recursive:true, mode:0o700});
const scratch = '/tmp/copse-probe-' + process.pid;
writeFileSync(scratch, 'positive control', {flag:'wx'});
const scratchWritable = readFileSync(scratch, 'utf8') === 'positive control';
unlinkSync(scratch);
const loopbackWorks = await new Promise((resolve, reject) => {
  const server = createServer(socket => socket.end());
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const socket = createConnection({host:'127.0.0.1', port:address.port});
    socket.on('connect', () => {socket.destroy(); server.close(() => resolve(true));});
    socket.on('error', reject);
  });
});
const externalNetworkDenied = await new Promise(resolve => {
  const socket = createConnection({host:'1.1.1.1', port:443});
  socket.setTimeout(1500, () => {socket.destroy(); resolve(false);});
  socket.on('connect', () => {socket.destroy(); resolve(false);});
  socket.on('error', error => resolve(['ENETUNREACH','EHOSTUNREACH'].includes(error.code)));
});
const report = {
  uid:process.getuid(),
  noNewPrivileges:/^NoNewPrivs:\s+1$/m.test(status),
  capabilitiesDropped:['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].every(name =>
    new RegExp('^' + name + ':\\s+0+$', 'm').test(status)),
  rootReadOnly:mounts.some(parts => parts[1] === '/' && parts[3]?.split(',').includes('ro')),
  noHostMounts:!mounts.some(parts => ['virtiofs','9p'].includes(parts[2])),
  scratchWritable, loopbackWorks, externalNetworkDenied,
  loopbackOnly:Object.keys(networkInterfaces()).every(name => name === 'lo'),
  noAmbientCredentials:!Object.keys(process.env).some(name => /API_KEY|TOKEN|SECRET|PASSWORD|SSH_AUTH_SOCK|DOCKER_HOST/i.test(name)),
};
console.log(JSON.stringify(report));
if (Object.entries(report).some(([name,value]) => name === 'uid' ? value !== 1001 : value !== true)) process.exitCode=1;
`
