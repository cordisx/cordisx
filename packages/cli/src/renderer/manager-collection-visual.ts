import { cloneAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import { cloneBrandIconV1 } from '@cordisx/protocol/brand-icon/v1'
import type { ManagerCollectionLeadingVisualV2 } from '@cordisx/protocol/manager-collection/v2'
import { CORDISX_HOST_ICON_TOKENS } from './surfaces.js'

function exactKeys(value: object, allowed: readonly string[], label: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label} has unknown fields`)
}

function hostIcon(icon: string): void {
  if (!(CORDISX_HOST_ICON_TOKENS as readonly string[]).includes(icon)) {
    throw new Error('unregistered collection Host icon')
  }
}

/** Shared validator for explicit collection versions; frozen v1 rejects identity payloads. */
export function assertManagerCollectionVisual(
  visual: ManagerCollectionLeadingVisualV2,
  label: string,
  version: 1 | 2,
): void {
  exactKeys(visual, ['kind', 'icon', 'avatar', 'entries'], label)
  if (visual.kind === 'semantic-icon') {
    exactKeys(visual, ['kind', 'icon'], label)
    hostIcon(visual.icon)
  } else if (visual.kind === 'avatar') {
    exactKeys(visual, ['kind', 'avatar'], label)
    cloneAgentAvatarRef(visual.avatar)
  } else if (visual.kind === 'avatar-stack') {
    exactKeys(visual, ['kind', 'entries'], label)
    if (!Array.isArray(visual.entries) || visual.entries.length < 1 || visual.entries.length > 16) {
      throw new Error(`${label} avatar stack is invalid`)
    }
    const ids = new Set<string>()
    for (const entry of visual.entries) {
      exactKeys(entry, ['id', 'avatar'], label)
      if (!/^[A-Za-z0-9._~-]{1,512}$/u.test(entry.id) || ids.has(entry.id)) {
        throw new Error(`${label} avatar id is invalid`)
      }
      ids.add(entry.id)
      cloneAgentAvatarRef(entry.avatar)
    }
  } else if (visual.kind === 'identity' && version === 2) {
    exactKeys(visual, ['kind', 'icon', 'avatar'], label)
    const icon = cloneBrandIconV1(visual.icon)
    if (typeof icon === 'string') hostIcon(icon)
    if (visual.avatar !== undefined) cloneBrandIconV1({ kind: 'raster-image', image: visual.avatar })
  } else throw new Error(`${label} leadingVisual kind is invalid`)
}
