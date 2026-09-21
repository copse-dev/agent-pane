import { containerHostName, type ContainerEngine } from './container-engine.mts'

export function autonomyContainerProviderUrl(
  engine: ContainerEngine,
  env: NodeJS.ProcessEnv,
): string {
  const configured =
    env['COPSE_EVAL_LOCAL_SERVER_URL'] ??
    env['COPSE_EVAL_LM_STUDIO_URL'] ??
    `http://${containerHostName(engine)}:1234/v1`
  return configured.replace(
    /^(https?:\/\/)(?:127\.0\.0\.1|localhost)(?=[:/?#]|$)/i,
    `$1${containerHostName(engine)}`,
  )
}

export function autonomyContainerRunArgs(
  engine: ContainerEngine,
  image: string,
  artifactDir: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const args =
    engine === 'docker'
      ? [
          'run',
          '--rm',
          '--init',
          '--read-only',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          '--security-opt=seccomp=unconfined',
          '--security-opt=apparmor=unconfined',
          '--security-opt=systempaths=unconfined',
          '--pids-limit=256',
          '--memory=4g',
          '--cpus=2',
          '--tmpfs=/tmp:rw,nosuid,nodev,size=1g',
          '--tmpfs=/home/eval:rw,nosuid,nodev,size=512m',
          '--tmpfs=/workspace:rw,nosuid,nodev,mode=1777,size=1g',
          '--tmpfs=/app/dist-test:rw,nosuid,nodev,mode=1777,size=256m',
          '--add-host=host.docker.internal:host-gateway',
        ]
      : [
          'run',
          '--rm',
          '--init',
          '--read-only',
          '--cap-drop',
          'ALL',
          '--masked-path',
          'NONE',
          '--read-only-path',
          'NONE',
          '--ulimit',
          'nproc=256:256',
          '--memory',
          '4g',
          '--cpus',
          '2',
          '--mount',
          'type=tmpfs,target=/tmp,size=1g,mode=1777',
          '--mount',
          'type=tmpfs,target=/home/eval,size=512m,mode=1777',
          '--mount',
          'type=tmpfs,target=/workspace,size=1g,mode=1777',
          '--mount',
          'type=tmpfs,target=/app/dist-test,size=256m,mode=1777',
        ]

  args.push(
    '--volume',
    `${artifactDir}:/artifacts`,
    '--env',
    `COPSE_EVAL_LOCAL_SERVER_URL=${autonomyContainerProviderUrl(engine, env)}`,
    '--env',
    'COPSE_EVAL_WORKSPACE_PARENT=/workspace',
  )

  for (const name of [
    'COPSE_EVAL_IDLE_MS',
    'COPSE_EVAL_MODEL',
    'COPSE_EVAL_PROMPT_VARIANT',
    'COPSE_EVAL_SCENARIO',
    'LM_STUDIO_API_KEY',
    'LM_API_TOKEN',
  ] as const) {
    if (env[name] !== undefined) args.push('--env', name)
  }

  args.push(image)
  return args
}
