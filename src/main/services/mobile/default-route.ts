import { execFile } from 'node:child_process'

/**
 * The interface carrying the default route: the one a phone on the same Wi-Fi
 * or wired network can usually reach. Virtual-machine bridges and VPN tunnels
 * also hold private addresses, and a name published for one of those is
 * unreachable from the phone.
 */
export function parseDefaultRouteInterface(
  platform: NodeJS.Platform,
  output: string,
): string | null {
  // macOS `route -n get default`: "  interface: en0"
  // Linux `ip route show default`: "default via 192.168.0.1 dev wlan0 proto dhcp …"
  const match =
    platform === 'darwin'
      ? /^\s*interface:\s*(\S+)\s*$/m.exec(output)
      : /^default\b.*?\bdev\s+(\S+)/m.exec(output)
  return match?.[1] ?? null
}

const COMMANDS: Partial<Record<NodeJS.Platform, [string, string[]]>> = {
  darwin: ['/sbin/route', ['-n', 'get', 'default']],
  linux: ['/sbin/ip', ['route', 'show', 'default']],
}

/** `null` when there is no default route, the platform is unsupported, or the lookup fails. */
export function readDefaultRouteInterface(
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const command = COMMANDS[platform]
  if (!command) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(command[0], command[1], { timeout: 2_000, encoding: 'utf8' }, (error, stdout) => {
      resolve(error ? null : parseDefaultRouteInterface(platform, stdout))
    })
  })
}

/**
 * Interfaces a phone on the local network almost never reaches: VM bridges
 * (Apple Virtualization `bridge*`, VMware `vmnet*`, VirtualBox `vboxnet*`,
 * Docker and libvirt), VPN tunnels (`utun*`, `tun*`, `tap*`, `wg*`) and Apple's
 * peer-to-peer links.
 */
const VIRTUAL_INTERFACE =
  /^(?:bridge|vmnet|vboxnet|docker|br-|virbr|veth|utun|tun|tap|wg|ipsec|ppp|awdl|llw|anpi|ap\d)/

export function isVirtualInterface(name: string): boolean {
  return VIRTUAL_INTERFACE.test(name)
}
