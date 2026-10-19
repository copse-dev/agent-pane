/**
 * The GitHub read capability's shared contract (`docs/plans/thread-in-container.md`,
 * decision A24): what crosses the stdio link between the guest's GitHub bridge
 * (`guest-github-bridge.ts`) and the host's handler (`github-capability.ts`),
 * and the configuration the guest's `gh` and `git` are given so that every
 * GitHub request they make reaches that bridge as plain HTTP.
 *
 * No TLS is intercepted anywhere. `gh` speaks plain HTTP/1.1 to a unix socket
 * because its own `http_unix_socket` setting says so; `git` speaks plain HTTP
 * to a loopback proxy because `url.<base>.insteadOf` rewrites `https://github.com/`
 * to a synthetic `http://github.copse.internal/` and `http.<base>.proxy` names
 * the bridge. The host re-originates HTTPS to the real GitHub and is the only
 * place the user's token exists. The guest holds a per-run placeholder, which
 * satisfies `gh`'s "are you logged in" check and is never forwarded.
 *
 * Dependency-light: it is part of the worker bundle.
 */
import { z } from 'zod'

/** The link target the guest's bridge opens; never dialled, like host inference. */
export const HOST_GITHUB_TARGET = 'github.copse.internal:443'

/**
 * The name `git` in the guest uses for github.com (through `insteadOf`), so
 * `git remote -v` still reads as GitHub and the host knows a request came in
 * through the git path. The host maps it to `github.com`, for git's smart-HTTP
 * fetch paths only.
 */
export const GITHUB_GIT_ALIAS_HOST = 'github.copse.internal'

/** Longest head line either side sends; a request line and headers, not a body. */
export const GITHUB_HEAD_LIMIT = 64 * 1024

/** What the guest bridge sends first on a stream: the request as the client sent it. */
export const githubRequestHeadSchema = z.object({
  method: z.string().min(1).max(32),
  /** The request-target exactly as received: origin-form or absolute-form. */
  target: z
    .string()
    .min(1)
    .max(16 * 1024),
  /** Every header as received, in order, names as sent. */
  headers: z.array(z.tuple([z.string().max(1024), z.string().max(16 * 1024)])).max(200),
})
export type GitHubRequestHead = z.infer<typeof githubRequestHeadSchema>

/** What the host sends first on a stream: the status and headers to give the client. */
export const githubResponseHeadSchema = z.object({
  status: z.number().int().min(100).max(599),
  headers: z.array(z.tuple([z.string(), z.string()])).max(500),
})
export type GitHubResponseHead = z.infer<typeof githubResponseHeadSchema>

/** One JSON line, the head, before the body bytes. */
export function encodeHead(head: GitHubRequestHead | GitHubResponseHead): string {
  return `${JSON.stringify(head)}\n`
}

/**
 * Accumulates bytes until the head line is complete. Returns the line and the
 * bytes after it (the body's start), `null` while incomplete, or throws when
 * the head is over {@link GITHUB_HEAD_LIMIT}.
 */
export class HeadReader {
  private parts: Buffer[] = []
  private bytes = 0

  feed(chunk: Buffer): { line: string; rest: Buffer } | null {
    const newline = chunk.indexOf(0x0a)
    if (newline === -1) {
      this.parts.push(chunk)
      this.bytes += chunk.length
      if (this.bytes > GITHUB_HEAD_LIMIT) throw new Error('head too large')
      return null
    }
    const line = Buffer.concat([...this.parts, chunk.subarray(0, newline)])
    if (line.length > GITHUB_HEAD_LIMIT) throw new Error('head too large')
    this.parts = []
    this.bytes = 0
    return { line: line.toString('utf8'), rest: chunk.subarray(newline + 1) }
  }
}

/**
 * The run's placeholder credential, bound to the thread and the run by its
 * shape (`ghp_copse_t<thread>_r<run>_<random>`). It exists to satisfy `gh`'s
 * login check and to be recognised: the host never forwards it, and finding it
 * anywhere but a request's `Authorization` header is a canary hit.
 */
export function githubPlaceholderToken(
  threadId: string,
  runtimeId: string,
  random: string,
): string {
  const thread = threadId.replace(/[^A-Za-z0-9]/g, '').slice(0, 6) || 'none'
  const run = runtimeId.replace(/^run-/, '').replace(/[^A-Za-z0-9]/g, '')
  return `ghp_copse_t${thread}_r${run}_${random}`
}

export interface GuestGitHubConfig {
  /** File name → contents, written into the directory `GH_CONFIG_DIR` names. */
  ghFiles: Record<'config.yml' | 'hosts.yml', string>
  /** `git config --global` entries, in order. */
  gitConfig: Array<[key: string, value: string]>
  /** Variables the guest's processes are given. */
  env: Record<string, string>
}

/** YAML double-quoted scalar; the inputs here are generated, but quote them anyway. */
function yamlString(value: string): string {
  return JSON.stringify(value)
}

/**
 * What the guest's `gh` and `git` are configured with. `GH_TOKEN` is
 * deliberately absent: an environment is frozen when a process starts, and
 * the placeholder is meant to be rotated later by rewriting `hosts.yml`.
 */
export function guestGitHubConfig(options: {
  configDir: string
  socketPath: string
  gitProxyPort: number
  placeholder: string
}): GuestGitHubConfig {
  const base = `http://${GITHUB_GIT_ALIAS_HOST}/`
  return {
    ghFiles: {
      'config.yml': [
        '# Written by Copse for this container run. Every gh request goes to the',
        "# host's GitHub read capability over this socket; the token lives on the host.",
        `http_unix_socket: ${yamlString(options.socketPath)}`,
        'git_protocol: https',
        'prompt: disabled',
        '',
      ].join('\n'),
      'hosts.yml': [
        'github.com:',
        `    oauth_token: ${yamlString(options.placeholder)}`,
        '    git_protocol: https',
        '',
      ].join('\n'),
    },
    gitConfig: [
      [`url.${base}.insteadOf`, 'https://github.com/'],
      [`http.${base}.proxy`, `http://127.0.0.1:${String(options.gitProxyPort)}`],
    ],
    env: {
      GH_CONFIG_DIR: options.configDir,
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_PROMPT_DISABLED: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  }
}
