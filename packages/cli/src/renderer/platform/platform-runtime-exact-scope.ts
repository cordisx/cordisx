import type { CordisXCapabilityScope, CordisXPlatformCapability } from '../../contracts.js'
import type { RequestedScope } from './platform-permission-store.js'

export type PlatformExecutionPlatform = 'posix' | 'win32'

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu

function validWindowsSegment(value: string): boolean {
  return value !== '' && !/[<>:"|?*]/u.test(value) && !/[. ]$/u.test(value) && !WINDOWS_DEVICE_NAME.test(value)
}

export function normalizeAbsoluteCwd(value: unknown, platform: PlatformExecutionPlatform): string | undefined {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) return undefined
  if (platform === 'posix') {
    if (!value.startsWith('/')) return undefined
    const parts: string[] = []
    for (const part of value.split('/')) {
      if (part === '' || part === '.') continue
      if (part === '..') parts.pop()
      else parts.push(part)
    }
    return `/${parts.join('/')}`
  }
  const slashed = value.replaceAll('/', '\\')
  const drive = /^[A-Za-z]:\\/u.test(slashed)
  const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\|$)/u.exec(slashed)
  const invalidUnc = unc !== null
    && [unc[1], unc[2]].some(segment => segment === '.' || segment === '..' || !validWindowsSegment(segment!))
  if ((!drive && unc === null) || invalidUnc || /^\\\\[?.]\\/u.test(slashed)) return undefined
  const prefix = drive ? `${slashed[0]!.toUpperCase()}:\\` : `\\\\${unc![1]}\\${unc![2]}\\`
  const remainder = drive ? slashed.slice(3) : slashed.slice(prefix.length)
  const parts: string[] = []
  for (const part of remainder.split('\\')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else if (!validWindowsSegment(part)) return undefined
    else parts.push(part)
  }
  return parts.length === 0 ? prefix : `${prefix}${parts.join('\\')}`
}

export function materializeRuntimeExactScope(
  capability: CordisXPlatformCapability,
  requested: RequestedScope,
  platform: PlatformExecutionPlatform,
): CordisXCapabilityScope | undefined {
  if (capability === 'tasks.create') {
    const providerId = requested.model?.providerId
    const cwd = normalizeAbsoluteCwd(requested.cwd, platform)
    return providerId !== undefined && requested.providerId === providerId && cwd !== undefined
      ? { providers: [providerId], cwdRoots: [cwd] }
      : undefined
  }
  if (
    capability === 'tasks.content.read' || capability === 'tasks.control'
    || capability === 'turns.submit' || capability === 'turns.control'
  ) {
    return requested.session !== undefined && requested.providerId === requested.session.providerId
      ? { sessions: [requested.session] }
      : undefined
  }
  return undefined
}

export function materializeValidatedRuntimeExactScope(
  capability: CordisXPlatformCapability,
  requested: RequestedScope,
): CordisXCapabilityScope | undefined {
  if (capability === 'tasks.create') {
    const providerId = requested.model?.providerId
    return providerId !== undefined && requested.providerId === providerId && requested.cwd !== undefined
      ? { providers: [providerId], cwdRoots: [requested.cwd] }
      : undefined
  }
  if (
    capability === 'tasks.content.read' || capability === 'tasks.control'
    || capability === 'turns.submit' || capability === 'turns.control'
  ) {
    return requested.session !== undefined && requested.providerId === requested.session.providerId
      ? { sessions: [requested.session] }
      : undefined
  }
  return undefined
}
