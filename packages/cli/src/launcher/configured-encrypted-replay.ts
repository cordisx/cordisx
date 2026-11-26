import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'smol-toml'
import type { HomeConfigProvider } from '../config/home-config.js'
import { modelServiceRuntimeOwnership } from './model-service-codex-options-projection.js'
import { servicesForApp } from './model-service-projection.js'
import type { ResponsesReplayRouteOptions } from './responses-encrypted-replay.js'
import { accountRouting } from '../../assets/launcher/native-responses-recovery.mjs'
import {
  CODEX_RUNTIME_OPTION_KEYS,
  MODEL_SERVICE_OPTIONS_AUTHORITY,
  modelServiceCodexProvider,
} from './model-service-runtime.js'

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Use only routing read from the same native account; never infer a workspace or region. */
function nativeOpenAiRecovery(
  config: Readonly<Record<string, unknown>>,
  value: unknown,
  route: (url: string, options?: ResponsesReplayRouteOptions) => string,
  verifyAccount?: (snapshot: string) => Promise<boolean>,
): Readonly<Record<string, unknown>> {
  const account = object(accountRouting(value))
  const explicit = typeof config.openai_base_url === 'string' && config.openai_base_url !== ''
    ? config.openai_base_url
    : undefined
  if (account?.type === 'apiKey') {
    return explicit && verifyAccount
      ? {
        openai_base_url: route(explicit, {
          nativeOpenAi: true,
          nativeStreamIdlePolicy: true,
          accountSnapshot: JSON.stringify(account),
          verifyAccount,
        }),
      }
      : {}
  }
  if (account?.type !== 'chatgpt' || !verifyAccount) return {}
  const routing = object(account.workspaceRouting)
  const workspaceDigest = routing?.workspaceDigest, ownerDigest = routing?.ownerDigest
  const override = routing?.accountRoutingOverride
  if (
    typeof workspaceDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(workspaceDigest)
    || typeof ownerDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(ownerDigest)
    || typeof routing?.backendOrigin !== 'string'
    || (override !== 'NO_CONSTRAINT' && override !== 'us' && override !== 'us_cr')
  ) return {}
  const workspace = new URL(routing.backendOrigin)
  if (
    workspace.protocol !== 'https:' || workspace.username || workspace.password || workspace.pathname !== '/'
    || workspace.search || workspace.hash
  ) return {}
  const base = new URL(explicit ?? 'https://chatgpt.com/backend-api/codex')
  const bootstrap = new URL(
    typeof config.chatgpt_base_url === 'string'
      ? config.chatgpt_base_url
      : 'https://chatgpt.com/backend-api/',
  )
  const workspaceBound = !explicit || base.origin === bootstrap.origin || base.origin === workspace.origin
  if (workspaceBound) {
    base.protocol = workspace.protocol
    base.host = workspace.host
  }
  return {
    openai_base_url: route(base.href, {
      nativeOpenAi: true,
      nativeStreamIdlePolicy: true,
      expectedAccountDigest: workspaceDigest,
      accountSnapshot: JSON.stringify(account),
      verifyAccount,
      ...(workspaceBound ? { accountRoutingOverride: override } : {}),
    }),
  }
}

export function configuredEncryptedReplay(
  codexHome: string,
  route: (url: string, options?: ResponsesReplayRouteOptions) => string,
  declarations: readonly HomeConfigProvider[] = [],
  verifyAccount?: (snapshot: string) => Promise<boolean>,
) {
  const applicable = servicesForApp(declarations, 'codex')
  return async (providerId?: string, nativeAccount?: unknown): Promise<Readonly<Record<string, unknown>>> => {
    const filename = path.join(codexHome, 'config.toml')
    let raw = ''
    try {
      if ((await stat(filename)).size > 4 * 1024 * 1024) throw new Error('Provider configuration unavailable')
      raw = await readFile(filename, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const config = parse(raw)
    // Codex selects its built-in provider when no root provider is configured.
    const selected = providerId ?? config.model_provider ?? 'openai'
    if (typeof selected !== 'string') return {}
    if (selected === 'openai') {
      return nativeOpenAiRecovery(config, nativeAccount, route, verifyAccount)
    }
    const declared = applicable.find(item => item.id === selected)
    const ownership = modelServiceRuntimeOwnership(raw).get(selected)
    const authoritative = declared?.runtimeOptions !== undefined || ownership !== undefined
    const providers = config.model_providers
    const provider =
      providers && typeof providers === 'object' && !Array.isArray(providers) && Object.hasOwn(providers, selected)
        ? (providers as Record<string, unknown>)[selected]
        : undefined
    const native = provider && typeof provider === 'object' && !Array.isArray(provider)
      ? provider as Record<string, unknown>
      : undefined
    const mapped = declared?.runtimeOptions === undefined ? undefined : modelServiceCodexProvider(declared)
    const projected: Record<string, unknown> = { ...native }
    // A cleared provider uses its current native file, so an intentional later
    // native edit survives. The caller's old options cannot override that file.
    if (mapped !== undefined || ownership === 'source') {
      for (const key of CODEX_RUNTIME_OPTION_KEYS) delete projected[key]
      Object.assign(projected, mapped)
    }
    const authority = authoritative ? { [MODEL_SERVICE_OPTIONS_AUTHORITY]: [selected] } : {}
    if (projected.wire_api !== undefined && projected.wire_api !== 'responses') return authority
    if (typeof projected.base_url !== 'string') return authority
    const websocket = projected.supports_websockets === true
    const nativeStreamIdlePolicy = typeof projected.stream_idle_timeout_ms === 'number'
    const baseUrl = websocket || nativeStreamIdlePolicy
      ? route(projected.base_url, { websocket, nativeStreamIdlePolicy })
      : route(projected.base_url)
    return {
      ...authority,
      [`model_providers.${selected}`]: {
        ...projected,
        wire_api: 'responses',
        base_url: baseUrl,
      },
    }
  }
}
