import { Service, type Context } from '@deepseek-ai/cordis'
import * as React from 'react'
import type {
  CordisXVisualData,
  CordisXVisualProps,
  CordisXVisualRenderer,
  CordisXVisuals,
  CordisXVisualTheme,
} from '../visual-contracts.js'
import {
  generationVisibilityFromContext,
  type GenerationVisibilityCoordinator,
  type PluginGenerationEffectIdentity,
} from './generation-visibility.js'
import { HostThemeProjection } from './host-theme.js'
import { ownerFromContext } from './ownership.js'
import { assertLocalId, LOCAL_ID_PATTERN } from './validation.js'

interface VisualRegistration {
  readonly sequence: number
  readonly owner: string
  readonly id: string
  readonly renderer: React.ComponentType<CordisXVisualProps>
  readonly generation: PluginGenerationEffectIdentity
}

const registriesByDocument = new WeakMap<Document, VisualRegistry>()

type MutableVisualContainer = CordisXVisualData[] | Record<string, CordisXVisualData>
type VisualCloneTask =
  | { readonly kind: 'freeze'; readonly source: object; readonly target: MutableVisualContainer }
  | { readonly kind: 'value'; readonly source: unknown; readonly target: MutableVisualContainer; readonly key: PropertyKey }

function invalidVisualData(detail: string): TypeError {
  return new TypeError(`visual data must be JSON-compatible: ${detail}`)
}

function cloneVisualContainer(
  source: object,
  clones: WeakMap<object, MutableVisualContainer>,
  visiting: WeakSet<object>,
  stack: VisualCloneTask[],
): MutableVisualContainer {
  if (visiting.has(source)) throw invalidVisualData('cycles are not supported')
  const known = clones.get(source)
  if (known !== undefined) return known
  const array = Array.isArray(source)
  if (!array) {
    const prototype = Object.getPrototypeOf(source)
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidVisualData('objects must use a plain or null prototype')
    }
  }
  const keys = Reflect.ownKeys(source)
  if (keys.some(key => typeof key !== 'string')) throw invalidVisualData('symbol keys are not supported')
  if (array) {
    const itemKeys = keys.filter(key => key !== 'length')
    if (itemKeys.length !== source.length || itemKeys.some((key, index) => key !== String(index))) {
      throw invalidVisualData('arrays must be dense and contain only indexed items')
    }
  }
  const target: MutableVisualContainer = array ? new Array<CordisXVisualData>(source.length) : {}
  clones.set(source, target)
  visiting.add(source)
  stack.push({ kind: 'freeze', source, target })
  const dataKeys = array ? keys.filter(key => key !== 'length') : keys
  for (let index = dataKeys.length - 1; index >= 0; index -= 1) {
    const key = dataKeys[index]!
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw invalidVisualData('properties must be enumerable data properties')
    }
    stack.push({ kind: 'value', source: descriptor.value, target, key })
  }
  return target
}

function cloneVisualValue(
  value: unknown,
  clones: WeakMap<object, MutableVisualContainer>,
  visiting: WeakSet<object>,
  stack: VisualCloneTask[],
): CordisXVisualData {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidVisualData('numbers must be finite')
    return value
  }
  if (typeof value !== 'object') throw invalidVisualData(`${typeof value} is not supported`)
  return cloneVisualContainer(value, clones, visiting, stack)
}

/** Validate, detach, and deeply freeze one provider-owned JSON value. */
export function cloneVisualData(value: unknown): CordisXVisualData {
  const clones = new WeakMap<object, MutableVisualContainer>()
  const visiting = new WeakSet<object>()
  const stack: VisualCloneTask[] = []
  const root = cloneVisualValue(value, clones, visiting, stack)
  while (stack.length > 0) {
    const task = stack.pop()!
    if (task.kind === 'freeze') {
      visiting.delete(task.source)
      Object.freeze(task.target)
      continue
    }
    Object.defineProperty(task.target, task.key, {
      configurable: true,
      enumerable: true,
      value: cloneVisualValue(task.source, clones, visiting, stack),
      writable: true,
    })
  }
  return root
}

/** Owner and generation-aware registry. No product renderer is built in. */
export class VisualRegistry {
  private readonly registrations = new Set<VisualRegistration>()
  private readonly listeners = new Set<() => void>()
  private readonly disconnectVisibility: (() => void) | undefined
  private readonly themeProjection: HostThemeProjection
  private revision = 0
  private sequence = 0
  private disposed = false

  constructor(readonly document: Document, private readonly visibility?: GenerationVisibilityCoordinator) {
    if (registriesByDocument.has(document)) throw new Error('visual registry already exists for this document')
    registriesByDocument.set(document, this)
    this.themeProjection = new HostThemeProjection(document)
    this.disconnectVisibility = visibility?.connect({ notify: () => this.notify() })
  }

  register<Data extends CordisXVisualData>(
    ctx: Context,
    id: string,
    renderer: CordisXVisualRenderer<Data>,
  ): () => void {
    if (this.disposed) throw new Error('visual registry is disposed')
    const owner = ownerFromContext(ctx)
    if (owner === 'host') throw new Error('visual registration requires a plugin owner')
    assertLocalId(id, 'visual provider id')
    if (typeof renderer !== 'function') throw new Error('visual renderer must be a component')
    const generation: PluginGenerationEffectIdentity = this.visibility?.effect(ctx)
      ?? Object.freeze({ pluginId: owner })
    if ([...this.registrations].some(record => record.owner === owner
      && record.id === id
      && record.generation.moduleGeneration === generation.moduleGeneration)) {
      throw new Error(`visual ${owner}:${id} is already registered for this generation`)
    }
    const registration: VisualRegistration = Object.freeze({
      sequence: ++this.sequence,
      owner,
      id,
      renderer: renderer as React.ComponentType<CordisXVisualProps>,
      generation,
    })
    this.registrations.add(registration)
    if (this.visible(registration)) this.notify()
    let active = true
    return () => {
      if (!active) return
      active = false
      const wasVisible = this.visible(registration)
      if (this.registrations.delete(registration) && wasVisible) this.notify()
    }
  }

  registration(owner: string, id: string): VisualRegistration | undefined {
    if (this.disposed || !LOCAL_ID_PATTERN.test(id)) return undefined
    return [...this.registrations].find(registration => registration.owner === owner
      && registration.id === id
      && this.visible(registration))
  }

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  snapshot = (): number => this.revision

  attachTheme(root: HTMLElement): () => void {
    if (this.disposed || root.ownerDocument !== this.document) return () => undefined
    return this.themeProjection.attach(root)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disconnectVisibility?.()
    this.themeProjection.dispose()
    this.registrations.clear()
    registriesByDocument.delete(this.document)
    this.notify()
    this.listeners.clear()
  }

  private visible(registration: VisualRegistration): boolean {
    return this.visibility?.visible(registration.generation) ?? true
  }

  private notify(): void {
    this.revision += 1
    for (const listener of [...this.listeners]) {
      try { listener() } catch (error) { console.error('CordisX visual subscriber failed', error) }
    }
  }
}

export class CordisXVisualService extends Service implements CordisXVisuals {
  readonly registry: VisualRegistry

  constructor(ctx: Context, registry?: VisualRegistry) {
    super(ctx, 'visuals')
    this.registry = registry ?? new VisualRegistry(document, generationVisibilityFromContext(ctx))
    ctx.effect(() => () => this.registry.dispose(), 'cordisx: visual registry')
  }

  register<Data extends CordisXVisualData>(id: string, renderer: CordisXVisualRenderer<Data>): () => void {
    return this.ctx.effect(
      () => this.registry.register(this.ctx, id, renderer),
      `visuals.register(${JSON.stringify(id)})`,
    )
  }
}

interface VisualFailureBoundaryProps extends React.PropsWithChildren {
  readonly resetKey: string
}

class VisualFailureBoundary extends React.Component<VisualFailureBoundaryProps, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }

  componentDidCatch(): void { console.error('CordisX visual renderer failed') }

  componentDidUpdate(previous: VisualFailureBoundaryProps): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false })
  }

  render(): React.ReactNode { return this.state.failed ? null : this.props.children }
}

function useVisualTheme(element: React.RefObject<HTMLElement | null>): CordisXVisualTheme {
  const [theme, setTheme] = React.useState<CordisXVisualTheme>('light')
  React.useLayoutEffect(() => {
    const seat = element.current
    if (seat === null) return
    const update = (): void => setTheme(seat.dataset.cordisxAppTheme === 'dark' ? 'dark' : 'light')
    update()
    const Observer = seat.ownerDocument.defaultView?.MutationObserver
    const observer = Observer === undefined ? undefined : new Observer(update)
    observer?.observe(seat, {
      attributes: true,
      attributeFilter: ['data-cordisx-app-theme'],
    })
    return () => observer?.disconnect()
  }, [element])
  return theme
}

function RegisteredVisual({ registry, owner, id, data, theme, dataRevision }: {
  readonly registry: VisualRegistry
  readonly owner: string
  readonly id: string
  readonly data: CordisXVisualData
  readonly theme: CordisXVisualTheme
  readonly dataRevision: number
}) {
  React.useSyncExternalStore(registry.subscribe, registry.snapshot, registry.snapshot)
  const registration = registry.registration(owner, id)
  if (registration === undefined) return null
  const Renderer = registration.renderer
  return <VisualFailureBoundary resetKey={`${registration.sequence}:${dataRevision}:${theme}`}>
    <Renderer data={data} theme={theme} />
  </VisualFailureBoundary>
}

/** Host-only bounded seat. Providers receive no Context, node, selector, or action authority. */
export function HostVisual({ owner, id, data }: {
  readonly owner: string
  readonly id: string
  readonly data: unknown
}) {
  const element = React.useRef<HTMLSpanElement>(null)
  const [registry, setRegistry] = React.useState<VisualRegistry>()
  const theme = useVisualTheme(element)
  const nextDataRevision = React.useRef(0)
  const projection = React.useMemo(() => {
    try { return { data: cloneVisualData(data), revision: ++nextDataRevision.current } } catch { return undefined }
  }, [data])
  React.useLayoutEffect(() => {
    const seat = element.current
    if (seat === null) return
    const nextRegistry = registriesByDocument.get(seat.ownerDocument)
    if (nextRegistry === undefined) return
    const detachTheme = nextRegistry.attachTheme(seat)
    setRegistry(nextRegistry)
    return detachTheme
  }, [])
  return <span
    ref={element}
    data-cordisx-visual={id}
    aria-hidden="true"
    inert={true}
    style={{ display: 'block', width: '100%', height: '100%', overflow: 'hidden', pointerEvents: 'none' }}
  >
    {registry === undefined || projection === undefined
      ? null
      : <RegisteredVisual
          registry={registry}
          owner={owner}
          id={id}
          data={projection.data}
          dataRevision={projection.revision}
          theme={theme}
        />}
  </span>
}
