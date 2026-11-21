import { pathToFileURL } from 'node:url'
import { readServiceConfigState } from '../config/service-config.js'
import {
  CHANNEL_SERVICE_CONFIG_INITIAL,
  type LocalChannelManagementSnapshot,
  type LocalChannelService,
} from '../launcher/channel-service.js'
import type { CordisXConfigPlugin } from '../launcher/config.js'
import type { ChannelManagerActionResult } from '../launcher/channel-manager-api.js'

const CHANNEL_PERMISSIONS = new Set([
  'channel.events.receive',
  'channel.events.subscribe',
  'channel.messages.send',
  'channel.attachments.read',
])

export function supportsReadonlyConfiguredChannel(plugin: CordisXConfigPlugin): boolean {
  const config = plugin.config
  const manifest = plugin.manifest
  if (
    plugin.id !== 'channel' || !plugin.enabled || plugin.package !== undefined || plugin.development !== undefined
    || config === null || typeof config !== 'object' || Array.isArray(config)
    || (Object.getPrototypeOf(config) !== Object.prototype && Object.getPrototypeOf(config) !== null)
    || Object.keys(config).length !== 0 || manifest?.schemaVersion !== 16 || manifest.startup !== undefined
    || manifest.id !== plugin.id || manifest.capabilities.length !== CHANNEL_PERMISSIONS.size
    || new Set(manifest.capabilities.map(capability => capability.name)).size !== CHANNEL_PERMISSIONS.size
    || manifest.capabilities.some(capability => capability.required || !CHANNEL_PERMISSIONS.has(capability.name))
    || manifest.services?.length !== 1
    || manifest.services[0]?.id !== 'runtime' || manifest.services[0]?.kind !== 'channel-adapter'
  ) return false
  return true
}

/**
 * A read-only view of an already-started Headless Channel. The owner supplies
 * a live, monotonic fence for the renderer's admitted profile, plugin graph,
 * and permission snapshot. A file poll or a browser claim is not such a fence.
 * The caller must separately ensure the renderer cannot obtain any of the
 * plugin's ordinary permissions; this class grants only the service's own
 * account-read capability and exposes no writes or event subscriptions. It
 * does not project plugin documents; the caller must omit them from the bundle.
 *
 * This helper does not install a renderer channel or start another service.
 * Its caller must retire the complete renderer when `retire` is invoked.
 */
export async function openReadonlyHeadlessChannel(input: {
  readonly profileId: string
  readonly configPath: string
  readonly plugin: CordisXConfigPlugin
  readonly service: LocalChannelService
  readonly fence: {
    readonly signal: AbortSignal
    current(): boolean | Promise<boolean>
    retire(): void
  }
}): Promise<
  {
    readonly initial: LocalChannelManagementSnapshot
    snapshot(): Promise<ChannelManagerActionResult>
    close(): void
  } | undefined
> {
  let closed = false
  let initialGeneration: string | undefined
  let initialOwnerGeneration: string | undefined
  let initialConfiguration: string | undefined
  const source = input.plugin.source ?? pathToFileURL(input.plugin.entry).href
  const onAbort = () => retire()
  const retire = () => {
    if (closed) return
    closed = true
    input.fence.signal.removeEventListener('abort', onAbort)
    input.fence.retire()
  }
  if (input.fence.signal.aborted) retire()
  else input.fence.signal.addEventListener('abort', onAbort, { once: true })
  const current = async () => {
    if (closed || input.fence.signal.aborted) return false
    try {
      return await input.fence.current() === true && !closed && !input.fence.signal.aborted
    } catch {
      return false
    }
  }
  const state = async () =>
    await readServiceConfigState({
      profileId: input.profileId,
      pluginId: 'channel',
      serviceId: 'runtime',
      initialConfig: CHANNEL_SERVICE_CONFIG_INITIAL as unknown as Parameters<
        typeof readServiceConfigState
      >[0]['initialConfig'],
    }, input.configPath)
  const read = async (): Promise<LocalChannelManagementSnapshot | undefined> => {
    try {
      if (!supportsReadonlyConfiguredChannel(input.plugin) || !await current()) {
        throw new Error('channel-owner-unavailable')
      }
      const before = await state()
      const fingerprint = JSON.stringify(before)
      if (
        before.candidate !== undefined || before.restartRequired === true || before.revision !== before.lastGoodRevision
        || initialConfiguration !== undefined && initialConfiguration !== fingerprint
      ) throw new Error('channel-owner-unavailable')
      const result = await input.service.readManagementSnapshot({
        configuration: before.config,
        revision: before.revision,
        lastGoodRevision: before.lastGoodRevision,
      })
      const after = await state()
      if (
        !result || fingerprint !== JSON.stringify(after) || !await current()
        || result.owner.source !== source || input.service.generation() !== result.generation
        || input.service.managementOwner()?.serviceGeneration !== result.owner.serviceGeneration
        || initialGeneration !== undefined && initialGeneration !== result.generation
        || initialOwnerGeneration !== undefined && initialOwnerGeneration !== result.owner.serviceGeneration
      ) throw new Error('channel-owner-unavailable')
      initialGeneration ??= result.generation
      initialOwnerGeneration ??= result.owner.serviceGeneration
      initialConfiguration ??= fingerprint
      return result
    } catch {
      retire()
      return undefined
    }
  }
  const initial = await read()
  if (!initial) return undefined
  return {
    initial,
    async snapshot() {
      const next = await read()
      return next
        ? { status: 'applied', projection: next.runtime }
        : { status: 'unavailable', code: 'CHANNEL_OWNER_UNAVAILABLE' }
    },
    close() {
      closed = true
      input.fence.signal.removeEventListener('abort', onAbort)
    },
  }
}
