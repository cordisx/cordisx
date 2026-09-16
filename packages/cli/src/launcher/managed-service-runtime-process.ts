import type { ManagedServiceDefinitionV1 } from '@cordisx/protocol/managed-service-runtime/v1'
import type { ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  assertManagedServiceEnvironmentBindings,
  readManagedRuntimeResource,
  resolveManagedRuntimeResource,
} from './managed-service-runtime-files.js'
import type { ManagedServiceRecord } from './managed-service-runtime-record.js'
import { managedServiceGenerationDirectory } from './managed-service-process.js'
import type { ManagedServiceChildTerminationTimeouts } from './managed-service-process.js'
import {
  readManagedContainedFile,
  readManagedResponseBody,
  setManagedPointer,
} from './managed-service-runtime-support.js'

const MAX_HEALTH_BODY_BYTES = 64 * 1024
const MAX_PORT_FILE_BYTES = 32

export interface ManagedServiceRuntimeProcessOptions {
  readonly fetch: typeof globalThis.fetch
  readonly spawn: typeof nodeSpawn
  readonly childTerminationTimeouts?: ManagedServiceChildTerminationTimeouts
  readonly invalidateExitedChild: (record: ManagedServiceRecord, child: ChildProcess) => void
}

export class ManagedServiceRuntimeProcess {
  constructor(private readonly options: ManagedServiceRuntimeProcessOptions) {}

  async writeConfiguration(record: ManagedServiceRecord): Promise<string | undefined> {
    const configuration = record.definition.configuration
    if (configuration === undefined) return undefined
    const templatePath = await resolveManagedRuntimeResource(record, configuration.template, 'data')
    const source = await readFile(templatePath, 'utf8')
    const value = configuration.format === 'json' ? JSON.parse(source) as unknown : parseYaml(source) as unknown
    for (const binding of record.definition.protectedBindings) {
      if (binding.target !== 'configuration' || binding.source === 'composition') continue
      const resolved = binding.source === 'host-assigned-loopback'
        ? this.serializeAssignedLoopback(record, binding.serialization)
        : record.secrets.get(binding.slot)
      if (resolved === undefined) throw new Error('managed service configuration binding is missing')
      setManagedPointer(value, binding.pointer, resolved)
    }
    for (const binding of record.selectedMaterialization?.values ?? []) {
      if (binding.pointer !== undefined) setManagedPointer(value, binding.pointer, binding.value)
    }
    const directory = managedServiceGenerationDirectory(record.serviceHome, record.binding.serviceGeneration)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(directory, 0o700)
    const file = path.join(directory, configuration.format === 'json' ? 'config.json' : 'config.yaml')
    const bytes = configuration.format === 'json' ? `${JSON.stringify(value, null, 2)}\n` : stringifyYaml(value)
    await writeFile(file, bytes, { mode: 0o600 })
    return file
  }

  async discoverExisting(record: ManagedServiceRecord, signal?: AbortSignal): Promise<string | undefined> {
    let port: number | undefined
    if (record.definition.discovery.kind === 'fixed-loopback') port = record.definition.discovery.port
    if (record.definition.discovery.kind === 'restricted-port-file') port = await this.readRestrictedPort(record)
    if (port === undefined) return undefined
    const origin = `http://127.0.0.1:${port}`
    return await this.healthy(record, origin, signal).catch(() => false) ? origin : undefined
  }

  async launch(
    record: ManagedServiceRecord,
    configurationPath: string | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    assertManagedServiceEnvironmentBindings(record)
    const port = record.definition.discovery.kind === 'host-assigned-loopback'
      ? record.assignedPort
      : record.definition.discovery.kind === 'fixed-loopback'
      ? record.definition.discovery.port
      : undefined
    const executable = await this.resolveExecutable(record, record.definition.launch.executable)
    const arguments_ = record.definition.launch.arguments.map(argument => {
      if (typeof argument === 'string') return argument
      if (port === undefined) throw new Error('managed service port is not assigned')
      if (argument.serialization === 'port') return String(port)
      if (argument.serialization === 'authority') return `127.0.0.1:${port}`
      return `http://127.0.0.1:${port}`
    })
    if (configurationPath !== undefined && record.definition.configuration !== undefined) {
      arguments_.push(record.definition.configuration.delivery.argument, configurationPath)
    }
    for (const binding of record.definition.protectedBindings) {
      if (binding.target !== 'environment') continue
      const value = record.secrets.get(binding.slot)
      if (typeof value !== 'string') throw new Error('managed service environment binding must be a string')
      record.environment[binding.variable] = value
    }
    const child = this.options.spawn(executable, arguments_, {
      cwd: record.access.artifactDirectory,
      env: record.environment,
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    })
    record.child = child
    let childError: Error | undefined
    child.on('error', error => {
      childError = error
      this.options.invalidateExitedChild(record, child)
    })
    child.once('exit', () => this.options.invalidateExitedChild(record, child))
    const deadline = Date.now() + record.definition.launch.startupTimeoutMs
    while (Date.now() < deadline) {
      this.assertActive(record, signal)
      if (childError !== undefined) throw childError
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('managed service exited during startup')
      const discoveredPort = port ?? await this.readRestrictedPort(record)
      if (discoveredPort !== undefined) {
        const origin = `http://127.0.0.1:${discoveredPort}`
        if (await this.healthy(record, origin, signal).catch(() => false)) {
          this.assertActive(record, signal)
          if (childError !== undefined || record.child !== child) {
            throw childError ?? new Error('managed service exited')
          }
          return origin
        }
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))))
    }
    throw new Error('managed service startup timed out')
  }

  async resolveExecutable(
    record: ManagedServiceRecord,
    executable: ManagedServiceDefinitionV1['launch']['executable'],
  ): Promise<string> {
    if (executable.kind === 'named-command') return executable.command
    const file = await resolveManagedRuntimeResource(record, executable.path, 'executable')
    await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return file
  }

  async healthy(record: ManagedServiceRecord, origin: string, signal?: AbortSignal): Promise<boolean> {
    const timeout = AbortSignal.timeout(record.definition.health.timeoutMs)
    const response = await this.options.fetch(new URL(record.definition.health.path, origin), {
      method: 'GET',
      headers: this.authorizationHeaders(record),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    })
    const healthy = response.ok
    await readManagedResponseBody(response, MAX_HEALTH_BODY_BYTES)
    return healthy
  }

  async ensureServiceHome(record: ManagedServiceRecord): Promise<void> {
    await mkdir(record.serviceHome, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(record.serviceHome, 0o700)
  }

  async removeGenerationDirectory(record: ManagedServiceRecord): Promise<void> {
    const directory = managedServiceGenerationDirectory(record.serviceHome, record.binding.serviceGeneration)
    await rm(directory, { recursive: true, force: true })
  }

  private serializeAssignedLoopback(
    record: ManagedServiceRecord,
    serialization: 'origin' | 'authority' | 'host' | 'port',
  ): string | number {
    const port = record.assignedPort
    if (port === undefined) throw new Error('managed service loopback port is not assigned')
    if (serialization === 'port') return port
    if (serialization === 'host') return '127.0.0.1'
    if (serialization === 'authority') return `127.0.0.1:${port}`
    return `http://127.0.0.1:${port}`
  }

  private async readRestrictedPort(record: ManagedServiceRecord): Promise<number | undefined> {
    if (record.definition.discovery.kind !== 'restricted-port-file') return undefined
    const bytes = await (record.definition.discovery.root === 'package'
      ? readManagedRuntimeResource(record, record.definition.discovery.file, 'data', MAX_PORT_FILE_BYTES)
      : readManagedContainedFile(record.serviceHome, record.definition.discovery.file, MAX_PORT_FILE_BYTES)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined
          throw error
        },
      )
    if (bytes === undefined) return undefined
    const port = Number(bytes.toString('utf8').trim())
    return Number.isSafeInteger(port) && port > 0 && port < 65_536 ? port : undefined
  }

  private authorizationHeaders(record: ManagedServiceRecord): Record<string, string> {
    if (record.definition.httpAuthentication.mode === 'none') return {}
    const value = record.secrets.get(record.definition.httpAuthentication.slot)
    if (value === undefined) throw new Error('managed service authorization is unavailable')
    return { Authorization: `${record.definition.httpAuthentication.scheme} ${value}` }
  }

  private assertActive(record: ManagedServiceRecord, signal: AbortSignal): void {
    if (record.disposed || signal.aborted) throw signal.reason ?? new Error('managed service operation cancelled')
  }
}
