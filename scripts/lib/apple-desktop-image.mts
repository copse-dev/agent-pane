import { existsSync, lstatSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Explicit staging roots: never copy a checkout, host dependencies, profile or credentials. */
export const APPLE_DESKTOP_BUILD_INPUTS = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'packages',
  'patches',
  'dist/main',
  'dist/preload',
  'dist/renderer',
  'dist/assets',
  'dist/resources/bundled-cursor-skills',
] as const

/** Reject links at every depth; cp dereferencing must never import a host profile. */
export function copyAppleDesktopInput(source: string, destination: string): void {
  const stat = lstatSync(source)
  if (stat.isSymbolicLink()) throw new Error(`Desktop build input is a symbolic link: ${source}`)
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true })
    for (const name of readdirSync(source)) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      copyAppleDesktopInput(join(source, name), join(destination, name))
    }
  } else if (stat.isFile()) {
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(source, destination)
  } else throw new Error(`Desktop build input is not a regular file: ${source}`)
}

export function stageAppleDesktopInputs(root: string, context: string): void {
  for (const input of APPLE_DESKTOP_BUILD_INPUTS) {
    const source = join(root, input)
    if (!existsSync(source))
      throw new Error(`Missing desktop build input ${input}; run pnpm run build first`)
    copyAppleDesktopInput(source, join(context, input))
  }
}

/** The base is the trusted worker image already tested by the containment preflight. */
export const APPLE_DESKTOP_DOCKERFILE = `ARG BASE_IMAGE=copse-desktop-probe:local
FROM \${BASE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends xdotool imagemagick dbus-x11 \\
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/copse
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY patches ./patches
# All resolutions and security patches come from the repository lockfile.
# No repository or dependency install lifecycle runs implicitly.
RUN pnpm install --frozen-lockfile --ignore-scripts \\
    && node node_modules/electron/install.js \\
    && pnpm exec electron-rebuild -f -w node-pty
COPY dist ./dist
RUN chmod -R a+rX /opt/copse
COPY desktop-guest.cjs /opt/copse-desktop/guest.cjs
RUN chmod 0644 /opt/copse-desktop/guest.cjs
USER 1001:1001
ENTRYPOINT ["/usr/bin/setpriv", "--no-new-privs", "--", "/usr/local/bin/node", "/opt/copse-desktop/guest.cjs"]
`
