import type { HomeConfigIconThemePreference } from '../config/home-config.js'
import { IconThemeRegistry, type RedactedIconThemeProvider } from './icon-theme-registry.js'

export interface IconThemePreferenceWriter {
  persist(
    expectedProfileRevision: number,
    selectedProfileRevision: number,
    candidate: Pick<RedactedIconThemeProvider, 'providerId' | 'namespace' | 'providerVersion' | 'providerGeneration'>,
  ): Promise<HomeConfigIconThemePreference>
  current?(): HomeConfigIconThemePreference | undefined
}

type IconThemeSelectionCandidate = Pick<
  RedactedIconThemeProvider,
  'providerId' | 'namespace' | 'providerVersion' | 'providerGeneration'
>

/** Reproject one durable preference onto this renderer's exact live handle. */
export function reconcileIconThemePreference(
  registry: IconThemeRegistry,
  hostGeneration: string,
  preference: IconThemeSelectionCandidate,
): void {
  const snapshot = registry.redactedSnapshot()
  const target = snapshot.providers.find(provider =>
    provider.providerId === preference.providerId
    && provider.namespace === preference.namespace
    && provider.providerVersion === preference.providerVersion
    && provider.providerGeneration === preference.providerGeneration
    && (provider.status === 'ready' || provider.status === 'active')
  )
    ?? snapshot.providers.find(provider => provider.providerId === 'builtin:reicon')
  if (target === undefined) return
  const selected = snapshot.selected
  if (
    selected.providerId === target.providerId && selected.namespace === target.namespace
    && selected.providerVersion === target.providerVersion
    && selected.providerGeneration === target.providerGeneration
  ) return
  const result = registry.selectProvider(
    `iconresync_${String(Date.now()).padStart(16, '0')}`,
    registry.selection().profileRevision,
    hostGeneration,
    target,
  )
  if (result.outcome === 'applied' || target.providerId === 'builtin:reicon') return
  const builtin = registry.redactedSnapshot().providers.find(provider => provider.providerId === 'builtin:reicon')
  if (builtin !== undefined) {
    registry.selectProvider(
      `iconresync_default_${String(Date.now()).padStart(16, '0')}`,
      registry.selection().profileRevision,
      hostGeneration,
      builtin,
    )
  }
}

/** Host-private selection transaction; public providers never receive persistence authority. */
export async function selectAndPersistIconTheme(
  registry: IconThemeRegistry,
  writer: IconThemePreferenceWriter | undefined,
  hostGeneration: string,
  expectedProfileRevision: number,
  candidate: IconThemeSelectionCandidate,
): Promise<void> {
  const previous = registry.redactedSnapshot().selected
  const result = registry.selectProvider(
    `iconselect_${String(Date.now()).padStart(16, '0')}`,
    expectedProfileRevision,
    hostGeneration,
    candidate,
  )
  if (result.outcome !== 'applied') {
    throw new Error(`icon theme selection failed: ${result.error?.code ?? result.outcome}`)
  }
  if (writer === undefined) return
  try {
    await writer.persist(expectedProfileRevision, result.profileRevision, {
      providerId: candidate.providerId,
      namespace: candidate.namespace,
      providerVersion: candidate.providerVersion,
      providerGeneration: candidate.providerGeneration,
    })
  } catch (error) {
    const durable = writer.current?.()
    if (durable !== undefined) reconcileIconThemePreference(registry, hostGeneration, durable)
    // Persistence is part of the Host-owned selection transaction. Restore
    // the exact previous identity only if no later registry event won.
    const currentRevision = registry.selection().profileRevision
    if (durable === undefined && currentRevision === result.profileRevision) {
      const restored = registry.selectProvider(
        `iconrevert_${String(Date.now()).padStart(16, '0')}`,
        currentRevision,
        hostGeneration,
        previous,
      )
      if (restored.outcome !== 'applied') {
        const builtin = registry.redactedSnapshot().providers.find(provider => provider.providerId === 'builtin:reicon')
        if (builtin !== undefined) {
          registry.selectProvider(
            `icondefault_${String(Date.now()).padStart(16, '0')}`,
            registry.selection().profileRevision,
            hostGeneration,
            builtin,
          )
        }
      }
    }
    throw error
  }
}
