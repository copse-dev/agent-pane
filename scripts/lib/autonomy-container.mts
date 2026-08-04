export function autonomyContainerProviderUrl(env: NodeJS.ProcessEnv): string {
  const configured =
    env['COPSE_EVAL_LOCAL_SERVER_URL'] ??
    env['COPSE_EVAL_LM_STUDIO_URL'] ??
    'http://host.docker.internal:1234/v1'
  return configured.replace(
    /^(https?:\/\/)(?:127\.0\.0\.1|localhost)(?=[:/?#]|$)/i,
    '$1host.docker.internal',
  )
}

export function autonomyContainerRunArgs(
  image: string,
  artifactDir: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const args = [
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
    '--volume',
    `${artifactDir}:/artifacts`,
    '--env',
    `COPSE_EVAL_LOCAL_SERVER_URL=${autonomyContainerProviderUrl(env)}`,
    '--env',
    'COPSE_EVAL_WORKSPACE_PARENT=/workspace',
  ]

  for (const name of [
    'COPSE_EVAL_IDLE_MS',
    'COPSE_EVAL_MODEL',
    'COPSE_EVAL_PROMPT_VARIANT',
    'LM_STUDIO_API_KEY',
    'LM_API_TOKEN',
  ] as const) {
    if (env[name] !== undefined) args.push('--env', name)
  }

  args.push(image)
  return args
}
