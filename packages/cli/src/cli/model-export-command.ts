import { randomUUID } from 'node:crypto'
import { link, lstat, open, rename, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadHomeConfig, resolveHomeConfigPath } from '../config/home-config.js'
import { codexConfigModelProviders } from '../launcher/codex-config-model-providers.js'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from '../launcher/management-rpc.js'
import { type CliModelExportResult, exportCliModelCatalog } from '../launcher/model-catalog/cli-export.js'
import {
  CompositeCatalogManagement,
  NativeCatalogManagement,
} from '../launcher/model-catalog/native-catalog-management.js'
import { MODEL_EXPORT_HELP, type ModelExportInvocation, type ModelExportRequest } from './model-export-parse.js'
import type { CordisXCliRuntime } from './run-runtime.js'
import { hasMatchingProcessIdentity } from './supervisor-state.js'

/** Atomic no-clobber publication; --force replaces the entry and never follows its symlink. */
export async function writeModelExport(file: string, text: string, force: boolean): Promise<void> {
  const existing = await lstat(file).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (existing && (!force || !existing.isFile() || existing.isSymbolicLink())) {
    throw new Error('Output already exists or is not a regular file; use a new path, or --force for a regular file')
  }
  const temporary = path.join(path.dirname(file), `.cordisx-model-export-${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.chmod(0o600)
      await handle.writeFile(`${text}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (force) await rename(temporary, file)
    else await link(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/u.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'"
}

function exportWithValuesCommand(invocation: ModelExportInvocation, profileId: string, file?: string): string {
  const args = ['cordisx', 'model', 'export', '--profile', profileId]
  if (invocation.all) args.push('--all')
  for (const service of invocation.services) args.push('--service', service)
  for (const model of invocation.modelIds) args.push('--model', model)
  args.push('--include-values', '--output', file === undefined ? '-' : `${file}.with-values`)
  return args.map(shellArgument).join(' ')
}

export async function runModelExportCommand(
  invocation: ModelExportInvocation,
  runtime: CordisXCliRuntime,
): Promise<void> {
  const stdout = runtime.stdout ?? console.log
  const stderr = runtime.stderr ?? process.stderr
  if (invocation.help) {
    stdout(MODEL_EXPORT_HELP)
    return
  }
  const environment = runtime.env ?? process.env
  const configPath = resolveHomeConfigPath({
    env: environment,
    ...(runtime.homedir === undefined ? {} : { homedir: runtime.homedir }),
  })
  const config = await loadHomeConfig(configPath)
  const appId = config.defaultApp
  if (appId !== 'codex') throw new Error('Model export currently supports Codex profiles only')
  const app = config.apps[appId]
  const profileId = invocation.profile ?? app?.defaultProfile
  const profile = profileId === undefined || !Object.hasOwn(app?.profiles ?? {}, profileId)
    ? undefined
    : app!.profiles[profileId]
  if (!profile || profileId === undefined) throw new Error('Profile does not exist; export never creates profiles')
  const request: ModelExportRequest = {
    list: invocation.list,
    all: invocation.all,
    services: invocation.services,
    modelIds: invocation.modelIds,
    includeValues: invocation.includeValues,
  }
  const homeDir = path.dirname(configPath)
  const paths = pluginManagementRpcPaths(homeDir, appId, profileId)
  const endpoint = await readPluginManagementRpcEndpoint(paths)
  let result: CliModelExportResult
  if (
    endpoint !== undefined && endpoint.appId === appId && endpoint.profileId === profileId
    && path.resolve(endpoint.configPath) === path.resolve(configPath)
    && await hasMatchingProcessIdentity(endpoint.pid, endpoint.processStartedAt)
  ) {
    // Never fall back to an inactive snapshot after a live owner rejects/fails.
    result = await requestPluginManagementRpc(paths, endpoint, {
      kind: 'model-export',
      request,
    }) as CliModelExportResult
  } else {
    const codexHome = profile.dataMode === 'host-isolated'
      ? path.join(homeDir, 'apps', appId, 'profiles', profileId, 'codex-home')
      : environment.CODEX_HOME
      ? path.resolve(environment.CODEX_HOME)
      : path.join(environment.HOME ?? runtime.homedir ?? os.homedir(), '.codex')
    const projection = await codexConfigModelProviders(codexHome, profile.configModelCatalogs, profile.selectorIcons)
    if (projection.sourceAvailable === false || projection.diagnostics.length > 0) {
      throw new Error(
        'Offline Codex catalog is unavailable or incomplete; check config.toml and configured local catalogs',
      )
    }
    const native = await NativeCatalogManagement.open({ load: async () => projection })
    const authority = new CompositeCatalogManagement(native)
    try {
      result = await exportCliModelCatalog(authority, request, config.environmentVariables, false)
    } finally {
      authority.close()
    }
    stderr.write(
      'Offline config-only inventory; managed/plugin services and live discovery are unavailable. --all requires an active compatible runtime.\n',
    )
  }
  if (result.kind === 'list') {
    stdout(JSON.stringify(result, null, 2))
    return
  }
  if (result.kind !== 'export' || typeof result.text !== 'string') throw new Error('Invalid model export response')
  const file = invocation.output === undefined || invocation.output === '-'
    ? undefined
    : path.resolve(runtime.cwd ?? process.cwd(), invocation.output)
  if (file === undefined) stdout(result.text)
  else await writeModelExport(file, result.text, invocation.force)
  stderr.write(`Exported ${result.services} service(s), ${result.models} model(s) to ${file ?? 'stdout'}.\n`)
  if (invocation.includeValues) {
    stderr.write(
      'UNENCRYPTED portable text: --include-values includes only saved, enabled user variables referenced by these services. Store and share privately.\n',
    )
  }
  stderr.write('Copy the complete portable text into the target CordisX Manager > Model services > Import.\n')
  if (result.missingVariables.length) {
    stderr.write(
      `[cordisx] WARNING: Variable values ${
        invocation.includeValues ? 'are still missing after --include-values' : 'were not included'
      }: ${result.missingVariables.join(', ')}.\n`
        + 'The target machine cannot use services requiring these variables until their values are completed in the target Import dialog.\n',
    )
    if (!invocation.includeValues) {
      stderr.write('To re-export the same profile and selection with saved values, run:\n')
      stderr.write(`${exportWithValuesCommand(invocation, profileId, file)}\n`)
      if (file !== undefined) {
        stderr.write(
          'This uses a different output file. If it already exists, choose another path or explicitly add --force to replace a regular file. The original export is not overwritten.\n',
        )
      }
      stderr.write(
        '--include-values includes only saved, enabled user variables referenced by these services. The portable text is UNENCRYPTED; values unavailable there still need completing on the target.\n',
      )
    }
  }
  stderr.write(
    'Review and confirm Import, then verify the imported service names and exact model IDs in the model list. Plugin-managed services require installing their plugin and logging in on the target machine.\n',
  )
}
