import { cloneAgentAvatarRef, type AgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import { createSeededAvatarDefinition, parseAvatarDefinition, type AvatarDefinition } from '@oneworks/avatar'
import { Avatar as OneWorksAvatar } from '@oneworks/avatar-react'
import avatarVendorCss from '@oneworks/avatar-react/style.css'
import * as React from 'react'
import type { HostAppTheme } from '../../host-theme.js'
import { participantInitials, type AgentConversationParticipant } from './model.js'

export type HostAgentAvatarResolution =
  | Readonly<{ status: 'resolved'; avatar: Extract<AgentAvatarRef, { kind: 'generated' }>; definition: AvatarDefinition }>
  | Readonly<{ status: 'unsupported'; avatar: AgentAvatarRef; code: 'unsupported-provider' | 'reference-unavailable' }>
type HostAgentAvatarResolved = Extract<HostAgentAvatarResolution, { status: 'resolved' }>

function avatarKey(avatar: AgentAvatarRef): string {
  return avatar.kind === 'generated'
    ? `${avatar.algorithm}:${avatar.algorithmVersion}:${avatar.seed}:revision:none`
    : JSON.stringify(avatar)
}

function freeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
  return Object.freeze(value)
}

const AVATAR_STYLE_MARKER = 'oneworks-avatar-react@1.0.0-rc.8'
const vendorAvatarRules = (avatarVendorCss.match(/\.oneworks-avatar[^{}]*\{[^{}]*\}/gu) ?? [])
  .slice(0, 6)
  .map(rule => rule
    .replace(/^\.oneworks-avatar/u, '.cxa-avatar .oneworks-avatar')
    .replace(/,\.oneworks-avatar-editor(?: \*)?/gu, ''))
  .join('\n')
if (avatarVendorCss !== '' && !vendorAvatarRules.includes('.cxa-avatar .oneworks-avatar>.interactive-avatar')) {
  throw new Error('OneWorks Avatar RC.8 style export is incompatible with the Host renderer')
}

function ensureAgentAvatarStyles(document: Document): void {
  if (vendorAvatarRules === '') return
  if (document.querySelector(`style[data-cordisx-agent-avatar-style="${AVATAR_STYLE_MARKER}"]`) !== null) return
  const style = document.createElement('style')
  style.dataset.cordisxAgentAvatarStyle = AVATAR_STYLE_MARKER
  style.textContent = vendorAvatarRules
  ;(document.head ?? document.documentElement).append(style)
}

/** Host-private, bounded LRU. No plugin-provided ref is interpreted as a URL or path. */
export class HostAgentAvatarResolver {
  private readonly cache = new Map<string, HostAgentAvatarResolved>()

  constructor(
    readonly maximumEntries = 256,
    private readonly createDefinition: (seed: string) => AvatarDefinition = seed => createSeededAvatarDefinition({ name: 'CordisX Agent', seed }),
  ) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 4_096) {
      throw new RangeError('Agent avatar cache capacity must be between 1 and 4096')
    }
  }

  resolve(input: AgentAvatarRef): HostAgentAvatarResolution {
    const avatar = cloneAgentAvatarRef(input)
    if (avatar.kind !== 'generated') return Object.freeze({
      status: 'unsupported' as const,
      avatar,
      code: avatar.kind === 'platform' ? 'unsupported-provider' as const : 'reference-unavailable' as const,
    })
    const key = avatarKey(avatar)
    const cached = this.cache.get(key)
    if (cached !== undefined) {
      this.cache.delete(key)
      this.cache.set(key, cached)
      return cached
    }
    const result: HostAgentAvatarResolved = Object.freeze({
      status: 'resolved' as const,
      avatar,
      definition: freeze(parseAvatarDefinition(this.createDefinition(avatar.seed))),
    })
    this.cache.set(key, result)
    while (this.cache.size > this.maximumEntries) this.cache.delete(this.cache.keys().next().value!)
    return result
  }

  get size(): number { return this.cache.size }
  clear(): void { this.cache.clear() }
}

export const defaultHostAgentAvatarResolver = new HostAgentAvatarResolver()

interface FailureBoundaryProps {
  readonly resetKey: string
  readonly fallback: React.ReactNode
  readonly children: React.ReactNode
  readonly onFailure: () => void
}

class AvatarFailureBoundary extends React.Component<FailureBoundaryProps, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  componentDidCatch(): void { this.props.onFailure() }
  componentDidUpdate(previous: FailureBoundaryProps): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false })
  }
  render(): React.ReactNode { return this.state.failed ? this.props.fallback : this.props.children }
}

export interface HostAgentAvatarProps {
  readonly participant: AgentConversationParticipant
  readonly resolver?: HostAgentAvatarResolver
}

/** Decorative Host-owned renderer with deterministic initials fallback. */
export function HostAgentAvatar({ participant, resolver = defaultHostAgentAvatarResolver }: HostAgentAvatarProps) {
  const wrapperRef = React.useRef<HTMLSpanElement>(null)
  const [theme, setTheme] = React.useState<HostAppTheme>('light')
  const [clientReady, setClientReady] = React.useState(false)
  const [renderFailed, setRenderFailed] = React.useState(false)
  const resolution = React.useMemo(
    () => {
      if (participant.avatar === undefined) return undefined
      try { return resolver.resolve(participant.avatar) }
      catch { return undefined }
    },
    [participant.avatar, resolver],
  )
  const key = participant.avatar === undefined ? 'initials' : avatarKey(participant.avatar)
  React.useEffect(() => { setRenderFailed(false) }, [key])
  React.useEffect(() => {
    const wrapper = wrapperRef.current
    if (wrapper === null) return
    const root = wrapper.closest<HTMLElement>('[data-cordisx-app-theme]')
    if (root === undefined || root === null) return
    ensureAgentAvatarStyles(wrapper.ownerDocument)
    const update = (): void => setTheme(root.dataset.cordisxAppTheme === 'dark' ? 'dark' : 'light')
    update()
    setClientReady(true)
    const Observer = root.ownerDocument.defaultView?.MutationObserver
    if (Observer === undefined) return
    const observer = new Observer(update)
    observer.observe(root, { attributes: true, attributeFilter: ['data-cordisx-app-theme'] })
    return () => observer.disconnect()
  }, [])
  const initials = <span className="cxa-avatar-initials">{participantInitials(participant.name)}</span>
  const resolved = resolution?.status === 'resolved' && clientReady && !renderFailed
  const state = resolved ? 'resolved' : 'fallback'
  return <span
    ref={wrapperRef}
    className="cxa-avatar"
    aria-hidden="true"
    inert={true}
    data-avatar-state={state}
    {...(resolution === undefined ? {} : { 'data-avatar-kind': resolution.avatar.kind })}
    {...(resolution?.status === 'unsupported' ? { 'data-avatar-code': resolution.code } : {})}
  >
    {resolved
      ? <AvatarFailureBoundary resetKey={key} fallback={initials} onFailure={() => setRenderFailed(true)}>
          <OneWorksAvatar
            className="cxa-avatar-renderer"
            definition={resolution.definition}
            theme={theme}
            interactive={false}
            autoplay={false}
            animation={null}
            timeline={null}
            onError={() => setRenderFailed(true)}
          />
        </AvatarFailureBoundary>
      : initials}
  </span>
}
