import type { CordisXDataMode } from './parse.js'
import {
  type HomeConfig,
  type HomeConfigProfile,
  updateHomeConfigAtomic,
} from '../config/home-config.js'

export interface ResolvedProfileSelection {
  readonly config: HomeConfig
  readonly appId: string
  readonly profileId: string
  readonly profile: HomeConfigProfile
  readonly dataMode: CordisXDataMode
  readonly created: boolean
}

export interface ResolveProfileSelectionInput {
  readonly config: HomeConfig
  readonly configPath: string
  readonly appId?: string
  readonly profileId?: string
  readonly dataMode?: CordisXDataMode
}

function displayName(profileId: string): string {
  return profileId.replaceAll(/[._-]+/g, ' ').replace(/^./, character => character.toUpperCase())
}

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

/** Resolve CLI/profile precedence and atomically persist a new named profile. */
export async function resolveProfileSelection(
  input: ResolveProfileSelectionInput,
): Promise<ResolvedProfileSelection> {
  const appId = input.appId ?? input.config.defaultApp
  const app = ownValue(input.config.apps, appId)
  if (app === undefined) throw new Error(`host app is not configured: ${appId}`)
  const profileId = input.profileId ?? app.defaultProfile
  const existing = ownValue(app.profiles, profileId)
  if (existing !== undefined) {
    return {
      config: input.config,
      appId,
      profileId,
      profile: existing,
      dataMode: input.dataMode ?? existing.dataMode,
      created: false,
    }
  }
  if (input.profileId === undefined) {
    throw new Error(`default profile is not configured for ${appId}: ${profileId}`)
  }

  const profile: HomeConfigProfile = {
    displayName: displayName(profileId),
    dataMode: input.dataMode ?? 'shared',
  }
  const config = await updateHomeConfigAtomic((current) => {
    const currentApp = ownValue(current.apps, appId)
    if (currentApp === undefined) throw new Error(`host app is not configured: ${appId}`)
    const raced = ownValue(currentApp.profiles, profileId)
    if (raced !== undefined) return current
    return {
      ...current,
      apps: {
        ...current.apps,
        [appId]: {
          ...currentApp,
          profiles: {
            ...currentApp.profiles,
            [profileId]: profile,
          },
        },
      },
    }
  }, input.configPath)
  const persistedApp = ownValue(config.apps, appId)
  const persisted = persistedApp === undefined ? undefined : ownValue(persistedApp.profiles, profileId)
  if (persisted === undefined) throw new Error(`failed to persist profile: ${appId}/${profileId}`)
  return {
    config,
    appId,
    profileId,
    profile: persisted,
    dataMode: input.dataMode ?? persisted.dataMode,
    created: true,
  }
}
