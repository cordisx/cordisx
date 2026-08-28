import { timingSafeEqual } from 'node:crypto'
import {
  updateHomeConfigAtomic,
  type HomeConfigIconThemePreference,
} from '../config/home-config.js'

export const ICON_THEME_PREFERENCE_BINDING = '__cordisxIconThemePreferenceRequestV1'
export const ICON_THEME_PREFERENCE_RECEIVER = '__cordisxIconThemePreferenceReceiveV1'
export const MAX_ICON_THEME_PREFERENCE_REQUEST_BYTES = 16 * 1024

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const PROVIDER_ID = /^(?:builtin:[a-z0-9][a-z0-9._-]{0,63}|plugin:[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,63})$/
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export interface IconThemePreferenceCandidate {
  readonly providerId: HomeConfigIconThemePreference['providerId']
  readonly namespace: string
  readonly providerVersion: string
  readonly providerGeneration: string
}

export interface IconThemePreferenceBindingRequest {
  readonly requestId: string
  readonly expectedPreferenceRevision: number
  readonly expectedProfileRevision: number
  readonly selectedProfileRevision: number
  readonly candidate: IconThemePreferenceCandidate
}

export interface IconThemePreferencePersistenceContext {
  readonly configPath: string
  readonly appId: string
  readonly profileId: string
  readonly hostGeneration: string
  readonly token: string
}

export class IconThemePreferenceConflictError extends Error {
  constructor(
    readonly actualRevision: number,
    readonly currentPreference: HomeConfigIconThemePreference | undefined,
  ) {
    super(`icon theme preference revision conflict: expected a different revision; actual ${actualRevision}`)
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} shape is invalid`)
  }
}

function sameToken(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function revision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid`)
  return value as number
}

function candidate(value: unknown): IconThemePreferenceCandidate {
  const item = object(value, 'icon theme preference candidate')
  exact(item, ['providerId', 'namespace', 'providerVersion', 'providerGeneration'], 'icon theme preference candidate')
  if (typeof item.providerId !== 'string' || !PROVIDER_ID.test(item.providerId)
    || typeof item.namespace !== 'string' || !ID.test(item.namespace)
    || typeof item.providerVersion !== 'string' || !SEMVER.test(item.providerVersion)
    || typeof item.providerGeneration !== 'string' || !GENERATION.test(item.providerGeneration)) {
    throw new Error('icon theme preference candidate is invalid')
  }
  return {
    providerId: item.providerId as HomeConfigIconThemePreference['providerId'],
    namespace: item.namespace,
    providerVersion: item.providerVersion,
    providerGeneration: item.providerGeneration,
  }
}

export function parseIconThemePreferenceBindingRequest(
  value: unknown,
  context: Omit<IconThemePreferencePersistenceContext, 'configPath'>,
): IconThemePreferenceBindingRequest {
  const request = object(value, 'icon theme preference request')
  exact(request, [
    'version', 'token', 'requestId', 'scope', 'expectedPreferenceRevision',
    'expectedProfileRevision', 'selectedProfileRevision', 'candidate',
  ], 'icon theme preference request')
  if (request.version !== 1) throw new Error('icon theme preference request version is invalid')
  if (typeof request.token !== 'string' || !sameToken(request.token, context.token)) throw new Error('icon theme preference token is invalid')
  if (typeof request.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(request.requestId)) throw new Error('icon theme preference request id is invalid')
  const scope = object(request.scope, 'icon theme preference scope')
  exact(scope, ['appId', 'profileId', 'hostGeneration'], 'icon theme preference scope')
  if (scope.appId !== context.appId || scope.profileId !== context.profileId || scope.hostGeneration !== context.hostGeneration) {
    throw new Error('icon theme preference scope is stale or spoofed')
  }
  const expectedProfileRevision = revision(request.expectedProfileRevision, 'icon theme expected profile revision')
  const selectedProfileRevision = revision(request.selectedProfileRevision, 'icon theme selected profile revision')
  if (selectedProfileRevision !== expectedProfileRevision + 1) throw new Error('icon theme profile revision transition is invalid')
  return {
    requestId: request.requestId,
    expectedPreferenceRevision: revision(request.expectedPreferenceRevision, 'icon theme expected preference revision'),
    expectedProfileRevision,
    selectedProfileRevision,
    candidate: candidate(request.candidate),
  }
}

export async function persistIconThemePreference(
  context: IconThemePreferencePersistenceContext,
  request: IconThemePreferenceBindingRequest,
): Promise<HomeConfigIconThemePreference> {
  let persisted: HomeConfigIconThemePreference | undefined
  await updateHomeConfigAtomic(current => {
    const app = Object.hasOwn(current.apps, context.appId) ? current.apps[context.appId] : undefined
    const profile = app !== undefined && Object.hasOwn(app.profiles, context.profileId) ? app.profiles[context.profileId] : undefined
    if (app === undefined || profile === undefined) throw new Error('icon theme preference profile is unavailable')
    const actualRevision = profile.iconTheme?.revision ?? 0
    if (actualRevision !== request.expectedPreferenceRevision) {
      throw new IconThemePreferenceConflictError(actualRevision, profile.iconTheme)
    }
    persisted = { revision: actualRevision + 1, ...request.candidate }
    return {
      ...current,
      apps: {
        ...current.apps,
        [context.appId]: {
          ...app,
          profiles: {
            ...app.profiles,
            [context.profileId]: { ...profile, iconTheme: persisted },
          },
        },
      },
    }
  }, context.configPath)
  if (persisted === undefined) throw new Error('icon theme preference persistence failed')
  return persisted
}

export function iconThemePreferenceBridgeError(error: unknown): {
  readonly code: string
  readonly error: string
  readonly actualRevision?: number
  readonly currentPreference?: HomeConfigIconThemePreference
} {
  if (error instanceof IconThemePreferenceConflictError) {
    return {
      code: 'conflict', error: error.message, actualRevision: error.actualRevision,
      ...(error.currentPreference === undefined ? {} : { currentPreference: error.currentPreference }),
    }
  }
  return { code: 'rejected', error: error instanceof Error ? error.message : String(error) }
}

/** Host-private fan-out for durable preference convergence within one profile. */
export class IconThemePreferenceBroadcastHub {
  private readonly receivers = new Set<{
    active: boolean
    tail: Promise<void>
    readonly receive: (preference: HomeConfigIconThemePreference) => Promise<void>
  }>()
  private winner: HomeConfigIconThemePreference | undefined

  constructor(
    readonly appId: string,
    readonly profileId: string,
  ) {}

  assertScope(context: Pick<IconThemePreferencePersistenceContext, 'appId' | 'profileId'>): void {
    if (context.appId !== this.appId || context.profileId !== this.profileId) {
      throw new Error('icon theme preference broadcast scope is mismatched')
    }
  }

  async register(receiver: (preference: HomeConfigIconThemePreference) => Promise<void>): Promise<() => void> {
    const entry = { active: true, tail: Promise.resolve(), receive: receiver }
    this.receivers.add(entry)
    if (this.winner !== undefined) await this.enqueue(entry, this.winner)
    return () => {
      entry.active = false
      this.receivers.delete(entry)
    }
  }

  async broadcast(preference: HomeConfigIconThemePreference): Promise<void> {
    if (this.winner !== undefined && preference.revision <= this.winner.revision) return
    this.winner = { ...preference }
    await Promise.all([...this.receivers].map(async entry => await this.enqueue(entry, preference)))
  }

  private async enqueue(
    entry: { active: boolean; tail: Promise<void>; readonly receive: (preference: HomeConfigIconThemePreference) => Promise<void> },
    preference: HomeConfigIconThemePreference,
  ): Promise<void> {
    entry.tail = entry.tail.then(async () => {
      if (!entry.active) return
      await entry.receive({ ...preference })
    }).catch(() => undefined)
    await entry.tail
  }
}
