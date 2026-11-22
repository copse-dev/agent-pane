/**
 * The code-cell image: Node and the bundled guest runner, nothing else.
 *
 * It is deliberately not the thread-container worker image. That one carries
 * a toolchain, an Electron runtime and the sandbox runtime for a whole agent
 * loop; a cell needs only Node, so this image builds from the same pinned base
 * in seconds and holds nothing a cell could use beyond the runner itself.
 *
 * The same hardening rules apply as for the worker image: the runner starts
 * under no-new-privileges from the entrypoint (Apple container has no flag for
 * it), setuid and setgid bits are stripped at build time, and the container
 * runs as an unprivileged uid with no network and a read-only root.
 */
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { copseDataRoot } from '@copse/store-kit/copse-paths.ts'
import { markAppleImageUsed } from '../container-runtime/apple-container-activity.ts'
import {
  containerBuildCommand,
  runContainerImageBuild,
  type ThreadContainerEngine,
} from '../container-runtime/container-engine.ts'
import {
  appleImageLabel,
  FINGERPRINT_LABEL,
  runEngine,
  WORKER_UID,
} from '../container-runtime/thread-container.ts'
import { WORKER_BASE_IMAGE } from '../container-runtime/worker-image-files.ts'

export const CODE_CELL_IMAGE = 'copse-code-cell:local'
export const CODE_CELL_UID = WORKER_UID

/**
 * The base image override the container worker's tooling already honours, for
 * sandboxes that cannot reach Docker Hub (a mirror or a locally built base).
 * The default is the worker image's pinned base.
 */
export const CODE_CELL_BASE_IMAGE_ENV = 'COPSE_WORKER_BASE_IMAGE'

export const CODE_CELL_DOCKERFILE = `# The Copse code-cell image (src/main/services/code-mode/code-cell-image.ts).
#
# Node and the bundled cell runner only: no toolchain, no package manager use,
# no credentials. The base image must provide Node 24 (for its built-in
# TypeScript type stripping) and util-linux's setpriv.
ARG BASE_IMAGE=${WORKER_BASE_IMAGE}
FROM \${BASE_IMAGE}
ARG CELL_UID=${String(CODE_CELL_UID)}

RUN useradd --no-create-home --uid "\${CELL_UID}" --shell /usr/sbin/nologin copse-cell

WORKDIR /app
COPY --chown=root:root runner.cjs entrypoint.sh ./
RUN chmod 0644 /app/runner.cjs && chmod 0755 /app/entrypoint.sh

# No-new-privileges comes from the entrypoint (setpriv), not only the engine:
# Apple container has no such flag. Setuid and setgid bits come off as well,
# so the image carries nothing to escalate through even without it.
RUN command -v setpriv >/dev/null \\
    && find / -xdev -type f -perm /6000 -exec chmod ug-s {} + \\
    && test -z "$(find / -xdev -type f -perm /6000 -print -quit)"

USER \${CELL_UID}:\${CELL_UID}
WORKDIR /tmp
ENTRYPOINT ["/app/entrypoint.sh"]
`

export const CODE_CELL_ENTRYPOINT_SH = `#!/bin/sh
# Guest entrypoint for a Copse code-cell container. The container's stdin and
# stdout are the link to the host; the runner exits when the host closes it.
set -eu
exec setpriv --no-new-privs -- node --disable-warning=ExperimentalWarning /app/runner.cjs
`

/** Where the build leaves the guest runner; see `scripts/main-bundles.mts`. */
export function defaultCodeCellRunnerPath(): string {
  return join(__dirname, 'code-cell-runner.cjs')
}

export function codeCellBaseImage(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[CODE_CELL_BASE_IMAGE_ENV]?.trim()
  return configured !== undefined && configured.length > 0 ? configured : WORKER_BASE_IMAGE
}

export interface CodeCellImageOptions {
  runner?: string
  baseImage?: string
  image?: string
}

/**
 * Identity of the image a build would produce. An image is reused only when
 * its fingerprint label matches, so an app upgrade that changes the runner
 * rebuilds it instead of running the previous one.
 */
export function codeCellImageFingerprint(options: CodeCellImageOptions = {}): string {
  const hash = createHash('sha256')
  hash.update('copse-code-cell-image-v1\n')
  hash.update(`uid:${String(CODE_CELL_UID)}\n`)
  hash.update(`base:${options.baseImage ?? codeCellBaseImage()}\n`)
  hash.update(CODE_CELL_DOCKERFILE)
  hash.update(CODE_CELL_ENTRYPOINT_SH)
  hash.update(readFileSync(options.runner ?? defaultCodeCellRunnerPath()))
  return hash.digest('hex')
}

async function imageFingerprint(
  engine: ThreadContainerEngine,
  image: string,
): Promise<string | null> {
  try {
    if (engine === 'apple') {
      return appleImageLabel(
        await runEngine('apple', ['image', 'inspect', image]),
        FINGERPRINT_LABEL,
      )
    }
    const label = await runEngine('docker', [
      'image',
      'inspect',
      '--format',
      `{{index .Config.Labels "${FINGERPRINT_LABEL}"}}`,
      image,
    ])
    return label.length > 0 && label !== '<no value>' ? label : null
  } catch {
    return null
  }
}

/**
 * Build the code-cell image. The context holds the runner, the entrypoint and
 * the Dockerfile only. Apple container's builder drops nested files from a
 * context under `/private`, so Apple builds stage under the profile instead,
 * as the worker image does.
 */
export async function buildCodeCellImage(
  engine: ThreadContainerEngine,
  options: CodeCellImageOptions = {},
): Promise<string> {
  const image = options.image ?? CODE_CELL_IMAGE
  const runner = options.runner ?? defaultCodeCellRunnerPath()
  if (!existsSync(runner)) {
    throw new Error(
      `Code-cell runner missing at ${runner}; run \`pnpm run build\` (it is a standalone main bundle)`,
    )
  }
  const baseImage = options.baseImage ?? codeCellBaseImage()
  const fingerprint = codeCellImageFingerprint({ runner, baseImage })
  const prefix =
    engine === 'apple'
      ? join(copseDataRoot(), 'cache', 'code-cell-context')
      : join(tmpdir(), 'copse-code-cell-context')
  mkdirSync(dirname(prefix), { recursive: true })
  const context = mkdtempSync(`${prefix}-`)
  try {
    cpSync(runner, join(context, 'runner.cjs'))
    writeFileSync(join(context, 'entrypoint.sh'), CODE_CELL_ENTRYPOINT_SH, { mode: 0o755 })
    writeFileSync(join(context, 'Dockerfile'), CODE_CELL_DOCKERFILE)
    const build = containerBuildCommand(engine, {
      file: join(context, 'Dockerfile'),
      tag: image,
      context,
      labels: { [FINGERPRINT_LABEL]: fingerprint },
      buildArgs: { BASE_IMAGE: baseImage, CELL_UID: String(CODE_CELL_UID) },
    })
    if (engine === 'apple') await markAppleImageUsed(image)
    await runContainerImageBuild(engine, () =>
      runEngine(engine, build.args, { timeoutMs: 15 * 60_000 }),
    )
    return image
  } finally {
    rmSync(context, { recursive: true, force: true })
  }
}

const preparing = new Map<string, Promise<string>>()

/**
 * The code-cell image for `engine`, built when it is missing or stale. One
 * preparation per engine and image is shared by the callers that overlap it.
 */
export function ensureCodeCellImage(
  engine: ThreadContainerEngine,
  options: CodeCellImageOptions = {},
): Promise<string> {
  const image = options.image ?? CODE_CELL_IMAGE
  const key = `${engine}\u0000${image}`
  const existing = preparing.get(key)
  if (existing !== undefined) return existing
  const preparation = (async (): Promise<string> => {
    const runner = options.runner ?? defaultCodeCellRunnerPath()
    if (!existsSync(runner)) {
      throw new Error(
        `Code-cell runner missing at ${runner}; run \`pnpm run build\` (it is a standalone main bundle)`,
      )
    }
    const wanted = codeCellImageFingerprint(options)
    if ((await imageFingerprint(engine, image)) === wanted) return image
    return await buildCodeCellImage(engine, { ...options, image })
  })()
  preparing.set(key, preparation)
  // Shared while in flight only: an image removed later (a prune) is noticed
  // and rebuilt by the next start, at the cost of one inspect.
  const forget = (): void => {
    if (preparing.get(key) === preparation) preparing.delete(key)
  }
  preparation.then(forget, forget)
  return preparation
}
