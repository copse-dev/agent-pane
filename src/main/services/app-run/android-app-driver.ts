import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { access, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import type {
  AppRunAction,
  AppRunApp,
  AppRunDevice,
  AppRunSelection,
  AppRunSetupInput,
  AppRunSetupOptions,
} from '@shared/types/app-run.ts'
import { spawnInProjectSandbox } from '../../project-sandbox/spawn.ts'
import { terminateProcessTree } from '../exec/subprocess-kill.ts'
import { discoverAndroidEndpoints } from '../android-desktop/android-discovery.ts'
import type {
  AppRunDriver,
  AppRunDriverDiscovery,
  AppRunDriverResult,
  AppRunProgress,
} from './app-run-driver.ts'
import { containedPath, runAppProcess } from './app-run-process.ts'

const moduleSchema = z.object({
  path: z.string(),
  name: z.string(),
  directory: z.string(),
  buildDirectory: z.string(),
  variants: z.array(z.string()),
  minimumSdks: z.record(z.string(), z.number()).optional(),
})
const metadataSchema = z.array(moduleSchema).max(100)
type AndroidModule = z.infer<typeof moduleSchema>
const apkMetadataSchema = z.object({
  applicationId: z.string().regex(/^[a-zA-Z][\w]*(?:\.[\w]+)+$/),
  variantName: z.string(),
  elements: z.array(z.object({ outputFile: z.string(), filters: z.array(z.unknown()).optional() })),
})
const IGNORE = new Set(['.git', 'node_modules', 'build', '.gradle', '.copse', 'Pods', 'vendor'])
const DESCRIBE_TASK = 'copseDescribeApplications'
const INIT_SCRIPT = `gradle.projectsEvaluated {
  rootProject.tasks.register('${DESCRIBE_TASK}') {
    doLast {
      def apps = rootProject.allprojects.findAll { it.plugins.hasPlugin('com.android.application') }.collect { p ->
        def variants = p.tasks.names.findAll { it.startsWith('assemble') && it.length() > 8 && !it.endsWith('Test') }.collect { it.substring(8) }
        def minimumSdks = [:]
        def android = p.extensions.findByName('android')
        if (android.hasProperty('applicationVariants')) {
          variants = android.applicationVariants.collect { v ->
            minimumSdks[v.name.toLowerCase()] = v.mergedFlavor.minSdkVersion?.apiLevel ?: 1
            v.name.substring(0, 1).toUpperCase() + v.name.substring(1)
          }
        }
        [path:p.path, name:p.name, directory:p.projectDir.absolutePath, buildDirectory:p.layout.buildDirectory.get().asFile.absolutePath, variants:variants, minimumSdks:minimumSdks]
      }
      println('COPSE_ANDROID_APPS=' + groovy.json.JsonOutput.toJson(apps))
    }
  }
}`
export interface AndroidToolchain {
  sdk: string
  adb: string
  emulator: string
  javaHome: string | undefined
  avdmanager: string | null
  sdkmanager: string | null
}
interface AndroidProject {
  wrapper: string
  directory: string
  module: AndroidModule
  tools: AndroidToolchain
}
const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  )

async function findWrappers(root: string): Promise<string[]> {
  const found: string[] = []
  let visited = 0
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 4 || ++visited > 512 || found.length >= 20) return
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    if (entries.some((e) => e.isFile() && e.name === 'gradlew')) {
      found.push(join(directory, 'gradlew'))
      return
    }
    for (const entry of entries)
      if (entry.isDirectory() && !IGNORE.has(entry.name) && !entry.name.startsWith('.'))
        await walk(join(directory, entry.name), depth + 1)
  }
  await walk(root, 0)
  return found
}
async function toolchain(root: string): Promise<AndroidToolchain | null> {
  const properties = await readFile(join(root, 'local.properties'), 'utf8').catch(() => '')
  const configured = /^sdk\.dir=(.+)$/m
    .exec(properties)?.[1]
    ?.replaceAll('\\:', ':')
    .replaceAll('\\\\', '\\')
    .trim()
  const candidates = [
    configured,
    process.env['ANDROID_HOME'],
    process.env['ANDROID_SDK_ROOT'],
    join(homedir(), 'Library/Android/sdk'),
  ]
  const sdk = await (async (): Promise<string | null> => {
    for (const path of candidates)
      if (path && (await exists(join(path, 'platform-tools/adb')))) return realpath(path)
    return null
  })()
  if (!sdk) return null
  const versions = await readdir(join(sdk, 'cmdline-tools')).catch((): string[] => [])
  const commands = versions.includes('latest')
    ? 'latest'
    : versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]
  const command = async (name: string): Promise<string | null> => {
    for (const path of [
      commands ? join(sdk, 'cmdline-tools', commands, 'bin', name) : '',
      join(sdk, 'tools/bin', name),
    ])
      if (path && (await exists(path))) return path
    return null
  }
  const studioJava = '/Applications/Android Studio.app/Contents/jbr/Contents/Home'
  const javaHome =
    process.env['JAVA_HOME'] ??
    ((await exists(join(studioJava, 'bin/java'))) ? studioJava : undefined)
  return {
    sdk,
    adb: join(sdk, 'platform-tools/adb'),
    emulator: join(sdk, 'emulator/emulator'),
    javaHome,
    avdmanager: await command('avdmanager'),
    sdkmanager: await command('sdkmanager'),
  }
}
function environment(tools: AndroidToolchain): NodeJS.ProcessEnv {
  return {
    ANDROID_HOME: tools.sdk,
    ANDROID_SDK_ROOT: tools.sdk,
    ...(tools.javaHome ? { JAVA_HOME: tools.javaHome } : {}),
  }
}
async function availablePort(port = 0): Promise<number> {
  const server = createServer()
  return new Promise((resolvePort, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not allocate emulator port.'))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolvePort(address.port)
      })
    })
  })
}

export interface AndroidAppDriverDependencies {
  run?: typeof runAppProcess
  tools?: typeof toolchain
  wrappers?: typeof findWrappers
  endpoints?: typeof discoverAndroidEndpoints
  spawn?: typeof spawnInProjectSandbox
}
export class AndroidAppDriver implements AppRunDriver {
  private readonly run: typeof runAppProcess
  private readonly resolveTools: typeof toolchain
  private readonly wrappers: typeof findWrappers
  private readonly endpoints: typeof discoverAndroidEndpoints
  private readonly spawn: typeof spawnInProjectSandbox
  constructor(dependencies: AndroidAppDriverDependencies = {}) {
    this.run = dependencies.run ?? runAppProcess
    this.resolveTools = dependencies.tools ?? toolchain
    this.wrappers = dependencies.wrappers ?? findWrappers
    this.endpoints = dependencies.endpoints ?? discoverAndroidEndpoints
    this.spawn = dependencies.spawn ?? spawnInProjectSandbox
  }
  private readonly projects = new Map<string, Map<string, AndroidProject>>()
  private readonly sessions = new Map<string, { adb: string; serial: string; packageId: string }>()
  private readonly starting = new Map<string, Promise<{ serial: string; desktopId: string }>>()
  detect(root: string): Promise<boolean> {
    return this.wrappers(root).then((paths) => paths.length > 0)
  }
  async discover(root: string, signal: AbortSignal): Promise<AppRunDriverDiscovery> {
    const wrappers = await this.wrappers(root)
    const projects = new Map<string, AndroidProject>()
    const result: AppRunDriverDiscovery = { apps: [], devices: [], issues: [] }
    for (const wrapper of wrappers) {
      signal.throwIfAborted()
      const directory = dirname(await containedPath(root, wrapper))
      const tools = await this.resolveTools(directory)
      if (!tools) {
        result.issues.push({
          platform: 'android',
          message: 'Install Android Studio and its Android SDK to build this app.',
          action: 'open-android-studio',
          label: 'Set up Android Studio',
        })
        continue
      }
      const scratch = await mkdtemp(join(tmpdir(), 'copse-app-run-'))
      const script = join(scratch, 'describe-android.gradle')
      await writeFile(script, INIT_SCRIPT, { mode: 0o600 })
      try {
        const output = await this.run(
          '/bin/sh',
          [
            wrapper,
            '--init-script',
            script,
            DESCRIBE_TASK,
            '--quiet',
            '--console=plain',
            '--no-daemon',
          ],
          directory,
          signal,
          { env: environment(tools), timeoutMs: 180_000 },
        )
        const line = output.split(/\r?\n/).find((l) => l.startsWith('COPSE_ANDROID_APPS='))
        const modules = safeJsonParse(
          line?.slice('COPSE_ANDROID_APPS='.length) ?? '',
          decodeWithSchema(metadataSchema),
        )
        if (!modules) throw new Error('Gradle did not return Android application modules.')
        for (const module of modules) {
          await containedPath(root, module.directory)
          const id = `android:${relative(root, wrapper)}:${module.path}`
          const variants = module.variants
            .filter((v) => /^[A-Za-z][A-Za-z0-9_]*$/.test(v))
            .sort((a, b) => (a === 'Debug' ? -1 : b === 'Debug' ? 1 : a.localeCompare(b)))
          if (!variants.length) continue
          projects.set(id, { wrapper, directory, module, tools })
          result.apps.push({
            id,
            platform: 'android',
            name: module.name,
            location: relative(root, module.directory) || '.',
            variants,
          })
        }
        const devices = await this.listDevices(directory, tools, signal)
        for (const device of devices)
          if (!result.devices.some((d) => d.id === device.id)) result.devices.push(device)
        if (!(await exists(tools.emulator)))
          result.issues.push({
            platform: 'android',
            message: 'Install Android Emulator in Android Studio’s SDK Manager.',
            action: 'open-android-studio',
            label: 'Open Android Studio',
          })
      } catch (error) {
        signal.throwIfAborted()
        result.issues.push({
          platform: 'android',
          message: error instanceof Error ? error.message : String(error),
          action: 'open-android-studio',
          label: 'Open Android Studio',
        })
      } finally {
        await rm(scratch, { recursive: true, force: true })
      }
    }
    this.projects.set(root, projects)
    return result
  }
  private async listDevices(
    root: string,
    tools: AndroidToolchain,
    signal: AbortSignal,
    minimumSdk = 1,
  ): Promise<AppRunDevice[]> {
    if (!(await exists(tools.emulator))) return []
    const avds = (
      await this.run(tools.emulator, ['-list-avds'], root, signal, { env: environment(tools) })
    )
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^[\w.-]+$/.test(s))
    const running = await this.runningDevices(root, tools, signal)
    const avdHome =
      process.env['ANDROID_AVD_HOME'] ??
      join(process.env['ANDROID_USER_HOME'] ?? join(homedir(), '.android'), 'avd')
    return Promise.all(
      avds.map(async (id): Promise<AppRunDevice> => {
        const record = await readFile(join(avdHome, `${id}.ini`), 'utf8').catch(() => '')
        const directory = /^path=(.+)$/m.exec(record)?.[1]?.trim() ?? join(avdHome, `${id}.avd`)
        const config = await readFile(join(directory, 'config.ini'), 'utf8').catch(() => '')
        const api = Number(/(?:android-|android\/)(\d+)/.exec(config + '\n' + record)?.[1])
        const incompatible = Number.isFinite(api) && api < minimumSdk
        return {
          id: `android-avd:${id}`,
          platform: 'android',
          name: id.replaceAll('_', ' '),
          runtime: Number.isFinite(api) ? `Android API ${String(api)}` : 'Android Emulator',
          state: incompatible
            ? 'unavailable'
            : running.some((device) => device.avd === id)
              ? 'running'
              : 'stopped',
          ...(incompatible
            ? { detail: `This variant requires Android API ${String(minimumSdk)} or newer.` }
            : {}),
        }
      }),
    )
  }

  private async runningDevices(
    root: string,
    tools: AndroidToolchain,
    signal: AbortSignal,
  ): Promise<{ avd: string; serial: string }[]> {
    const output = await this.run(tools.adb, ['devices'], root, signal, { env: environment(tools) })
    const rows: { avd: string; serial: string }[] = []
    for (const line of output.split(/\r?\n/)) {
      const serial = /^(emulator-\d+)\s+device\b/.exec(line)?.[1]
      if (!serial) continue
      const name = await this.run(
        tools.adb,
        ['-s', serial, 'emu', 'avd', 'name'],
        root,
        signal,
      ).catch(() => '')
      const avd = name.split(/\r?\n/).find((s) => s && s !== 'OK')
      if (avd) rows.push({ avd, serial })
    }
    return rows
  }
  async devices(
    root: string,
    app: AppRunApp,
    signal: AbortSignal,
    variant = app.variants[0],
  ): Promise<AppRunDevice[]> {
    const project = this.projects.get(root)?.get(app.id)
    return project
      ? this.listDevices(
          project.directory,
          project.tools,
          signal,
          project.module.minimumSdks?.[variant?.toLowerCase() ?? ''] ?? 1,
        )
      : []
  }
  private async startDevice(
    root: string,
    tools: AndroidToolchain,
    avd: string,
    signal: AbortSignal,
  ): Promise<{ serial: string; desktopId: string }> {
    if (this.starting.has(avd))
      throw new Error('This emulator is already being started by another operation.')
    const start = async (): Promise<{ serial: string; desktopId: string }> => {
      const running = (await this.runningDevices(root, tools, signal)).find((d) => d.avd === avd)
      let serial = running?.serial
      let child: ChildProcess | undefined
      if (!serial) {
        let consolePort: number | undefined
        for (let port = 5554; port <= 5682; port += 2) {
          if (
            (await availablePort(port).then(
              () => true,
              () => false,
            )) &&
            (await availablePort(port + 1).then(
              () => true,
              () => false,
            ))
          ) {
            consolePort = port
            break
          }
        }
        if (!consolePort) throw new Error('No local emulator console port is available.')
        const grpcPort = await availablePort()
        child = await this.spawn(
          tools.emulator,
          [
            '-avd',
            avd,
            '-no-window',
            '-no-audio',
            '-no-snapshot-save',
            '-port',
            String(consolePort),
            '-grpc',
            String(grpcPort),
            '-grpc-use-token',
          ],
          { cwd: root, env: environment(tools), stdio: 'pipe', unsandboxed: true },
        )
        // Emulator diagnostics can contain credentials; consume rather than forwarding them.
        child.stdout?.resume()
        child.stderr?.resume()
        await new Promise<void>((resolveSpawn, reject) => {
          if (child?.pid !== undefined) resolveSpawn()
          else {
            child?.once('spawn', resolveSpawn)
            child?.once('error', reject)
          }
        })
        child.on('error', () => {})
        serial = `emulator-${String(consolePort)}`
      }
      try {
        const started = Date.now()
        while (Date.now() - started < 180_000) {
          signal.throwIfAborted()
          if (child && child.exitCode !== null)
            throw new Error(
              'Android Emulator exited during startup. Check the selected AVD in Android Studio.',
            )
          const boot = await this.run(
            tools.adb,
            ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'],
            root,
            signal,
            { timeoutMs: 5000 },
          ).catch(() => '')
          if (boot.trim() === '1') {
            const endpoints = await this.endpoints()
            const endpoint = endpoints.find(
              (e) =>
                e.avdId === avd ||
                e.device.name === avd ||
                e.device.name === avd.replaceAll('_', ' '),
            )
            if (endpoint?.token) {
              child?.unref()
              return { serial, desktopId: endpoint.device.udid }
            }
            if (running)
              throw new Error(
                'This emulator is running without a supported Desktop connection. Stop it in Android Studio, then Run again so Copse can start it with authenticated display access.',
              )
          }
          await delay(500, undefined, { signal })
        }
        throw new Error('The Android emulator did not become ready within three minutes.')
      } catch (error) {
        if (child) terminateProcessTree(child)
        throw error
      }
    }
    const promise = start()
    this.starting.set(avd, promise)
    try {
      return await promise
    } finally {
      this.starting.delete(avd)
    }
  }
  async execute(
    root: string,
    app: AppRunApp,
    selection: AppRunSelection,
    action: AppRunAction,
    _operationId: string,
    progress: AppRunProgress,
    signal: AbortSignal,
  ): Promise<AppRunDriverResult> {
    const project = this.projects.get(root)?.get(app.id)
    if (!project || !app.variants.includes(selection.variant))
      throw new Error('Reload the Android app and variant before running.')
    await containedPath(root, project.wrapper)
    const prefix = project.module.path === ':' ? ':' : `${project.module.path}:`
    progress.stage(action === 'test' ? 'testing' : 'building')
    await this.run(
      '/bin/sh',
      [
        project.wrapper,
        `${prefix}${action === 'test' ? 'test' : 'assemble'}${selection.variant}${action === 'test' ? 'UnitTest' : ''}`,
        '--console=plain',
        '--no-daemon',
      ],
      project.directory,
      signal,
      { env: environment(project.tools), log: progress.log, timeoutMs: 30 * 60 * 1000 },
    )
    if (action !== 'run') return {}
    const devices = await this.devices(root, app, signal, selection.variant)
    if (!devices.some((d) => d.id === selection.deviceId && d.state !== 'unavailable'))
      throw new Error('The selected Android emulator is no longer available.')
    const metadata = await this.findApk(root, project.module.buildDirectory, selection.variant)
    progress.stage('starting-device')
    const device = await this.startDevice(
      project.directory,
      project.tools,
      selection.deviceId.slice('android-avd:'.length),
      signal,
    )
    progress.stage('installing')
    await this.run(
      project.tools.adb,
      ['-s', device.serial, 'install', '-r', '-t', metadata.apk],
      root,
      signal,
      { log: progress.log },
    )
    progress.stage('launching')
    const activity = await this.run(
      project.tools.adb,
      [
        '-s',
        device.serial,
        'shell',
        'cmd',
        'package',
        'resolve-activity',
        '--brief',
        '-a',
        'android.intent.action.MAIN',
        '-c',
        'android.intent.category.LAUNCHER',
        metadata.packageId,
      ],
      root,
      signal,
    )
    const component = activity
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /^[\w.$]+\/[\w.$]+$/.test(l))
    if (!component || !component.startsWith(`${metadata.packageId}/`))
      throw new Error('The installed app has no launcher activity for this variant.')
    const launched = await this.run(
      project.tools.adb,
      ['-s', device.serial, 'shell', 'am', 'start', '-W', '-n', component],
      root,
      signal,
      { log: progress.log },
    )
    if (!/^Status:\s*ok\s*$/m.test(launched))
      throw new Error(`Android did not confirm app launch: ${launched.slice(-4000)}`)
    const sessionId = randomUUID()
    this.sessions.set(sessionId, {
      adb: project.tools.adb,
      serial: device.serial,
      packageId: metadata.packageId,
    })
    return { desktopId: device.desktopId, appSessionId: sessionId }
  }
  private async findApk(
    root: string,
    buildDirectory: string,
    variant: string,
  ): Promise<{ apk: string; packageId: string }> {
    const output = await containedPath(root, join(buildDirectory, 'outputs/apk'))
    const matches: { apk: string; packageId: string }[] = []
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 5) return
      for (const entry of (await readdir(directory, { withFileTypes: true })).slice(0, 200)) {
        if (entry.isDirectory()) await walk(join(directory, entry.name), depth + 1)
        if (!entry.isFile() || entry.name !== 'output-metadata.json') continue
        const content = await readFile(join(directory, entry.name), 'utf8')
        const parsed =
          content.length < 1_000_000
            ? safeJsonParse(content, decodeWithSchema(apkMetadataSchema))
            : null
        if (!parsed || parsed.variantName.toLowerCase() !== variant.toLowerCase()) continue
        const universal = parsed.elements.filter((e) => !e.filters?.length)
        const element =
          universal.length === 1
            ? universal[0]
            : parsed.elements.length === 1
              ? parsed.elements[0]
              : undefined
        if (!element)
          throw new Error(
            'This variant produces multiple split APKs. Configure a universal debug APK to run it here.',
          )
        const apk = await containedPath(output, join(directory, element.outputFile))
        matches.push({ apk, packageId: parsed.applicationId })
      }
    }
    await walk(output, 0)
    if (matches.length !== 1)
      throw new Error('Gradle did not produce one unambiguous APK for the selected variant.')
    const result = matches[0]
    if (!result) throw new Error('The built APK was not found.')
    return result
  }
  async stop(root: string, sessionId: string, signal: AbortSignal): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('That Android app is no longer tracked by Copse.')
    await this.run(
      session.adb,
      ['-s', session.serial, 'shell', 'am', 'force-stop', session.packageId],
      root,
      signal,
    )
    this.sessions.delete(sessionId)
  }
  async setupOptions(root: string, signal: AbortSignal): Promise<AppRunSetupOptions> {
    const tools =
      this.projects.get(root)?.values().next().value?.tools ?? (await this.resolveTools(root))
    if (!tools?.sdkmanager || !tools.avdmanager)
      throw new Error(
        'Install Android SDK Command-line Tools in Android Studio’s SDK Manager first.',
      )
    const packages = await this.run(tools.sdkmanager, ['--list', '--verbose'], root, signal, {
      env: environment(tools),
      timeoutMs: 60_000,
    })
    const abi = process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64'
    const ids = [
      ...new Set(
        packages.match(/system-images;android-\d+;(?:google_apis|default);(?:arm64-v8a|x86_64)/g) ??
          [],
      ),
    ]
      .filter((id) => id.endsWith(`;${abi}`))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .slice(0, 30)
    const runtimes = await Promise.all(
      ids.map(async (id) => ({
        id,
        name: id.replaceAll(';', ' · '),
        installed: await exists(join(tools.sdk, ...id.split(';'), 'source.properties')),
      })),
    )
    const devices = await this.run(tools.avdmanager, ['list', 'device', '-c'], root, signal, {
      env: environment(tools),
    })
    return {
      runtimes,
      deviceTypes: devices
        .split(/\r?\n/)
        .filter((id) => /^[\w.-]+$/.test(id))
        .map((id) => ({ id, name: id.replaceAll('_', ' ') })),
    }
  }
  async setup(
    root: string,
    input: AppRunSetupInput,
    progress: AppRunProgress,
    signal: AbortSignal,
  ): Promise<void> {
    const tools =
      this.projects.get(root)?.values().next().value?.tools ?? (await this.resolveTools(root))
    if (!tools?.sdkmanager || !tools.avdmanager)
      throw new Error('Install Android SDK Command-line Tools first.')
    const options = await this.setupOptions(root, signal)
    const runtime = options.runtimes.find((r) => r.id === input.runtimeId)
    if (!runtime) throw new Error('Choose an available Android system image.')
    if (input.action === 'install-android-image') {
      // Do not pipe yes: unaccepted license agreements must be handled explicitly in SDK Manager.
      await this.run(tools.sdkmanager, [runtime.id], root, signal, {
        env: environment(tools),
        log: progress.log,
        timeoutMs: 2 * 60 * 60 * 1000,
      })
      if (!(await exists(join(tools.sdk, ...runtime.id.split(';'), 'source.properties'))))
        throw new Error(
          'The image was not installed. Review any license agreement in Android Studio’s SDK Manager, then retry.',
        )
      return
    }
    if (
      input.action !== 'create-device' ||
      !runtime.installed ||
      !input.name ||
      !options.deviceTypes.some((d) => d.id === input.deviceTypeId)
    )
      throw new Error('Choose an installed image, device type, and name.')
    const name = `Copse_${input.name.replace(/[^A-Za-z0-9_.-]/g, '_')}`
    await this.run(
      tools.avdmanager,
      [
        'create',
        'avd',
        '--name',
        name,
        '--package',
        runtime.id,
        '--device',
        input.deviceTypeId ?? '',
      ],
      root,
      signal,
      { env: environment(tools), input: 'no\n', log: progress.log },
    )
  }
}
export const androidAppDriverInternals = {
  findWrappers,
  metadataSchema,
  apkMetadataSchema,
  INIT_SCRIPT,
}
