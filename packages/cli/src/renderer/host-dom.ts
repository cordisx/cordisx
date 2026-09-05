import type {
  BoundHostDomClient,
  HostDomAttributeValue,
  HostDomBridgeRequest,
  HostDomBridgeResult,
  HostDomHandle,
  HostDomModifyOperation,
  HostDomNodeRef,
  HostDomReadableAttribute,
  HostDomReadOperation,
  HostDomReadProjection,
  HostDomRootCatalog,
  HostDomStructuredChild,
  LocalizedText,
} from '@cordisx/protocol/host-dom/v1'
import type { HostDomPermissionAccessDecision } from './platform.js'

const REQUEST_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/host-dom-bridge-request.v1.schema.json'
const RESULT_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/host-dom-bridge-result.v1.schema.json'
const CATALOG_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/host-dom-root-catalog.v1.schema.json'
const CONTRACT = 'cordisx.bound-host-dom/v1'
const MAX_REQUEST_BYTES = 64 * 1024
const MAX_TEXT = 16 * 1024
const MAX_TEXT_VISITED_NODES = 4096
const MAX_WRITE_TEXT = 4 * 1024
const MAX_STRUCTURE_NODES = 200
const MAX_STRUCTURE_DEPTH = 8
const MAX_HANDLES_PER_CLIENT = 32
const MAX_NODE_REFS_PER_CLIENT = 512
const MAX_MODIFY_HANDLE_LIFETIME_MS = 60_000
const PROHIBITED_ELEMENT_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'])
const READ_ATTRIBUTES = Object.freeze(
  [
    'aria-label',
    'aria-description',
    'aria-expanded',
    'aria-selected',
    'aria-pressed',
    'aria-current',
    'aria-disabled',
    'role',
    'title',
    'value',
    'checked',
    'disabled',
    'hidden',
    'tabindex',
  ] as const satisfies readonly HostDomReadableAttribute[],
)
const MUTABLE_ATTRIBUTES: ReadonlySet<HostDomReadableAttribute> = new Set(
  READ_ATTRIBUTES.filter(attribute => attribute !== 'role'),
)
const READ_OPERATIONS = new Set<HostDomReadOperation>([
  'inspect-structure',
  'read-text',
  'read-attributes',
  'read-state',
])
const MODIFY_OPERATIONS = new Set<HostDomModifyOperation>([
  'set-text',
  'set-attribute',
  'insert-owned-structured-child',
  'remove-owned-child',
  'focus',
])

export const HOST_DOM_ROOT_CATALOG_VERSION = '2026-08-31'

export interface HostDomRootDefinition {
  readonly rootId: string
  readonly name: LocalizedText
  readonly description: LocalizedText
  readonly sensitivity: 'general' | 'sensitive' | 'high-risk'
  readonly readOperations: readonly HostDomReadOperation[]
  readonly modifyOperations: readonly HostDomModifyOperation[]
  readonly resolve: () => Element | undefined
}

export interface HostDomAuthorityOptions {
  readonly hostGeneration: string
  readonly currentHostGeneration?: () => string
  /** Paired with currentHostGeneration so generation replacement actively revokes handles. */
  readonly subscribeHostGenerationInvalidation?: (listener: () => void) => () => void
  /** Must be true only when the plugin has no ambient Document/window/private renderer access. */
  readonly isolatedPluginBoundary: boolean
  readonly roots: readonly HostDomRootDefinition[]
  readonly resolveText?: (value: LocalizedText) => string
}

export interface HostDomClientBinding {
  readonly ownerKey: string
  readonly profileId: string
  readonly identity: Readonly<{ source: string; pluginId: string }>
  readonly runtimeGeneration: string
  readonly moduleGeneration: string
  readonly state: () => 'active' | 'disabled' | 'uninstalled' | 'generation-replaced'
  readonly authorize: (
    capability: 'ui.host-dom.read' | 'ui.host-dom.modify',
    rootId: string,
    operations: readonly string[],
  ) => Promise<HostDomPermissionAccessDecision>
  readonly leaseActive: (leaseId: string) => boolean
  /** Required lifecycle signal: revocation must rollback mutations without waiting for another request. */
  readonly subscribeInvalidation: (listener: () => void) => () => void
  readonly invokeCommand?: (
    commandId: string,
    args?: Readonly<Record<string, HostDomAttributeValue>>,
  ) => void | Promise<void>
}

interface HandleRecord {
  readonly id: HostDomHandle
  readonly ownerKey: string
  readonly moduleGeneration: string
  readonly rootId: string
  readonly root: Element
  readonly capability: 'ui.host-dom.read' | 'ui.host-dom.modify'
  readonly operations: ReadonlySet<string>
  readonly leaseId: string
  readonly rollback: (() => void)[]
  expiryTimer?: ReturnType<typeof setTimeout>
}

interface NodeRecord {
  readonly ownerKey: string
  readonly moduleGeneration: string
  readonly rootId: string
  readonly element: Element
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function localId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(value) && value.length <= 96
}

function reference(value: unknown): value is string {
  return typeof value === 'string'
    && /^[a-z0-9][a-z0-9._-]{0,95}(?::[a-z0-9][a-z0-9._-]{0,95})?$/u.test(value)
}

function requestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
}

function opaqueId(value: unknown, prefix: 'hdh' | 'hdn'): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]{16,128}$`, 'u').test(value)
}

function attributeValueInput(value: unknown): value is HostDomAttributeValue {
  return value === null || typeof value === 'boolean'
    || (typeof value === 'string' && value.length <= MAX_WRITE_TEXT)
    || (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000_000)
}

function serializableSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function immutableSnapshot<Value>(value: Value): Value | undefined {
  try {
    const snapshot = structuredClone(value)
    const freeze = (candidate: unknown): void => {
      if (candidate === null || typeof candidate !== 'object' || Object.isFrozen(candidate)) return
      for (const child of Object.values(candidate)) freeze(child)
      Object.freeze(candidate)
    }
    freeze(snapshot)
    return snapshot
  } catch {
    return undefined
  }
}

function base(request: Pick<HostDomBridgeRequest, 'requestId'>, hostGeneration: string) {
  return Object.freeze(
    {
      $schema: RESULT_SCHEMA,
      contract: CONTRACT,
      schemaVersion: 1 as const,
      requestId: request.requestId,
      hostGeneration,
    } as const,
  )
}

function unavailable(
  request: Pick<HostDomBridgeRequest, 'requestId' | 'type'>,
  hostGeneration: string,
  code: Extract<HostDomBridgeResult, { status: 'unavailable' }>['code'],
): HostDomBridgeResult {
  return { ...base(request, hostGeneration), type: request.type, status: 'unavailable', code }
}

function denied(
  request: Pick<HostDomBridgeRequest, 'requestId' | 'type'>,
  hostGeneration: string,
  code: Extract<HostDomBridgeResult, { status: 'denied' }>['code'],
): HostDomBridgeResult {
  return { ...base(request, hostGeneration), type: request.type, status: 'denied', code }
}

function stateUnavailable(
  state: ReturnType<HostDomClientBinding['state']>,
): Extract<HostDomBridgeResult, { status: 'unavailable' }>['code'] | undefined {
  return state === 'active'
    ? undefined
    : state === 'disabled'
    ? 'plugin-disabled'
    : state === 'uninstalled'
    ? 'plugin-uninstalled'
    : 'generation-replaced'
}

function elementKind(element: Element): Extract<HostDomReadProjection, { kind: 'structure' }>['nodes'][number]['kind'] {
  const role = element.getAttribute('role')
  if (role === 'status') return 'status'
  if (role === 'list') return 'list'
  if (role === 'listitem') return 'list-item'
  if (role === 'region') return 'region'
  if (role === 'group') return 'group'
  if (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName) || role === 'button') return 'control'
  return element.children.length === 0 ? 'text' : 'group'
}

function privateElement(element: Element): boolean {
  return element.matches('input[type="password"], [data-cordisx-private="true"], [data-cordisx-sensitive="true"]')
    || element.closest('[data-cordisx-private="true"], [data-cordisx-sensitive="true"]') !== null
}

function hiddenElement(element: Element): boolean {
  for (let candidate: Element | null = element; candidate !== null; candidate = candidate.parentElement) {
    if (candidate.hasAttribute('hidden') || candidate.getAttribute('aria-hidden') === 'true') return true
    try {
      const style = candidate.ownerDocument.defaultView?.getComputedStyle(candidate)
      if (style?.display === 'none' || style?.visibility === 'hidden') return true
    } catch {
      return true
    }
  }
  return false
}

function redactedSubtree(element: Element): boolean {
  return privateElement(element) || hiddenElement(element)
    || [...PROHIBITED_ELEMENT_TAGS].some(tag => element.closest(tag.toLowerCase()) !== null)
}

function boundedText(element: Element): Extract<HostDomReadProjection, { kind: 'text' }> {
  if (redactedSubtree(element)) return { kind: 'text', text: '', truncated: false, redacted: true }
  let text = ''
  let truncated = false
  let redacted = false
  let visited = 0
  const visit = (node: Node): void => {
    visited += 1
    if (visited > MAX_TEXT_VISITED_NODES) {
      truncated = true
      return
    }
    if (node.nodeType === 3) {
      const value = node.nodeValue ?? ''
      const remaining = MAX_TEXT - text.length
      if (value.length > remaining) {
        text += value.slice(0, Math.max(remaining, 0))
        truncated = true
      } else text += value
      return
    }
    if (node.nodeType !== 1) return
    const child = node as Element
    if (child !== element && redactedSubtree(child)) {
      redacted = true
      return
    }
    for (const entry of child.childNodes) {
      if (truncated) return
      visit(entry)
    }
  }
  visit(element)
  return { kind: 'text', text, truncated, redacted }
}

function attributeValue(element: Element, attribute: HostDomReadableAttribute): HostDomAttributeValue {
  if (attribute === 'checked' || attribute === 'disabled' || attribute === 'hidden') {
    return element.hasAttribute(attribute)
  }
  if (attribute === 'tabindex') {
    const value = element.getAttribute(attribute)
    if (value === null) return null
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : value.slice(0, MAX_WRITE_TEXT)
  }
  return element.getAttribute(attribute)?.slice(0, MAX_WRITE_TEXT) ?? null
}

function normalizeAttributeValue(value: HostDomAttributeValue): string | null {
  if (value === null || value === false) return null
  return value === true ? '' : String(value)
}

function localized(value: LocalizedText, resolve?: (input: LocalizedText) => string): string {
  const result = resolve?.(value) ?? value.fallback ?? value.key
  return result.slice(0, MAX_WRITE_TEXT)
}

function validLocalized(value: unknown): value is LocalizedText {
  const input = record(value)
  if (
    input === undefined || !exact(input, ['namespace', 'key', 'params', 'fallback'])
    || !localId(input.key)
    || (input.namespace !== undefined && !reference(input.namespace))
    || (input.fallback !== undefined && (typeof input.fallback !== 'string'
      || input.fallback.length < 1 || input.fallback.length > 4000))
  ) return false
  const params = input.params === undefined ? undefined : record(input.params)
  if (params === undefined) return input.params === undefined
  return Object.keys(params).length <= 16
    && Object.keys(params).every(key => /^[a-z][a-zA-Z0-9]*$/u.test(key))
    && Object.values(params).every(attributeValueInput)
}

function validStructuredChild(value: unknown): value is HostDomStructuredChild {
  const child = record(value)
  if (child === undefined || !localId(child.id)) return false
  if (child.kind === 'text') return exact(child, ['id', 'kind', 'text']) && validLocalized(child.text)
  if (
    child.kind !== 'action' || !exact(child, ['id', 'kind', 'label', 'command', 'disabled'])
    || !validLocalized(child.label)
  ) return false
  const command = record(child.command)
  if (command === undefined || !exact(command, ['id', 'arguments']) || !localId(command.id)) return false
  const args = command.arguments === undefined ? undefined : record(command.arguments)
  if (
    args !== undefined && (Object.keys(args).length > 16
      || Object.keys(args).some(key => !/^[a-z][a-zA-Z0-9]*$/u.test(key))
      || Object.values(args).some(item => !attributeValueInput(item)))
  ) return false
  if (child.disabled === undefined) return true
  const disabled = record(child.disabled)
  return disabled !== undefined && exact(disabled, ['value', 'reason']) && typeof disabled.value === 'boolean'
    && (disabled.reason === undefined || validLocalized(disabled.reason))
}

function makeOpaque(prefix: 'hdh' | 'hdn', sequence: number): `${typeof prefix}_${string}` {
  const random = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID().replaceAll('-', '')
    : `${Date.now().toString(36)}${sequence.toString(36)}${Math.random().toString(36).slice(2)}`
  return `${prefix}_${random}`
}

/**
 * Host-owned implementation of the public bounded DOM contract. It is not a
 * renderer-global bridge and must only be bound into an isolated plugin realm.
 */
export class HostDomAuthority {
  private readonly roots: ReadonlyMap<string, HostDomRootDefinition>
  private readonly clientDisposers = new Set<() => void>()
  private readonly activeModifyRoots = new Map<HostDomHandle, Element>()
  private readonly pendingModifyRoots = new Set<Element>()
  private sequence = 0
  private disposed = false

  constructor(private readonly options: HostDomAuthorityOptions) {
    if (options.hostGeneration.length < 1 || options.hostGeneration.length > 200) {
      throw new Error('Host DOM generation is invalid')
    }
    if ((options.currentHostGeneration === undefined) !== (options.subscribeHostGenerationInvalidation === undefined)) {
      throw new Error('Host DOM generation read and invalidation signals must be provided together')
    }
    const roots = new Map<string, HostDomRootDefinition>()
    for (const root of options.roots) {
      if (!localId(root.rootId) || roots.has(root.rootId)) {
        throw new Error(`Host DOM root id is invalid or duplicated: ${root.rootId}`)
      }
      if (!validLocalized(root.name) || !validLocalized(root.description)) {
        throw new Error(`Host DOM root ${root.rootId} has invalid localized metadata`)
      }
      if (
        root.readOperations.some(operation => !READ_OPERATIONS.has(operation))
        || root.modifyOperations.some(operation => !MODIFY_OPERATIONS.has(operation))
      ) {
        throw new Error(`Host DOM root ${root.rootId} declares an unknown operation`)
      }
      const requiredSensitivity = root.modifyOperations.length > 0
        ? 'high-risk'
        : root.readOperations.length > 0
        ? 'sensitive'
        : 'general'
      if (root.sensitivity !== requiredSensitivity) {
        throw new Error(`Host DOM root ${root.rootId} must use ${requiredSensitivity} sensitivity`)
      }
      roots.set(
        root.rootId,
        Object.freeze({
          ...root,
          readOperations: Object.freeze([...new Set(root.readOperations)]),
          modifyOperations: Object.freeze([...new Set(root.modifyOperations)]),
        }),
      )
    }
    this.roots = roots
  }

  bind(binding: HostDomClientBinding): BoundHostDomClient {
    if (this.disposed) throw new Error('Host DOM authority is disposed')
    if (
      binding.ownerKey.length < 1 || binding.ownerKey.length > 512
      || binding.moduleGeneration.length < 1 || binding.moduleGeneration.length > 200
    ) {
      throw new Error('Host DOM client binding is invalid')
    }
    const handles = new Map<HostDomHandle, HandleRecord>()
    const nodes = new Map<HostDomNodeRef, NodeRecord>()
    const elementRefs = new WeakMap<Element, Map<string, HostDomNodeRef>>()
    const seenRequests = new Set<string>()
    let pendingHandles = 0
    let clientDisposed = false

    const currentGeneration = () => this.options.currentHostGeneration?.() ?? this.options.hostGeneration
    const deleteNodeRef = (element: Element, rootId: string) => {
      const refs = elementRefs.get(element)
      refs?.delete(rootId)
      if (refs?.size === 0) elementRefs.delete(element)
    }
    const rollback = (handle: HandleRecord) => {
      handles.delete(handle.id)
      this.activeModifyRoots.delete(handle.id)
      if (handle.expiryTimer !== undefined) clearTimeout(handle.expiryTimer)
      delete handle.expiryTimer
      for (const action of [...handle.rollback].reverse()) {
        try {
          action()
        } catch { /* cleanup is best effort and never restores a broader node */ }
      }
      handle.rollback.length = 0
    }
    const reconcile = () => {
      for (const handle of [...handles.values()]) {
        if (
          clientDisposed || this.disposed || currentGeneration() !== this.options.hostGeneration
          || binding.state() !== 'active' || !binding.leaseActive(handle.leaseId)
        ) rollback(handle)
      }
      for (const [node, entry] of nodes) {
        const root = this.roots.get(entry.rootId)?.resolve()
        if (
          root === undefined || !entry.element.isConnected || (entry.element !== root && !root.contains(entry.element))
        ) {
          nodes.delete(node)
          deleteNodeRef(entry.element, entry.rootId)
        }
      }
    }
    const detachInvalidation = binding.subscribeInvalidation(reconcile)
    const detachHostGenerationInvalidation = this.options.subscribeHostGenerationInvalidation?.(reconcile)
      ?? (() => undefined)

    const catalog = async (): Promise<HostDomRootCatalog> => {
      const hostGeneration = currentGeneration()
      const generationCurrent = hostGeneration === this.options.hostGeneration
      return {
        $schema: CATALOG_SCHEMA,
        schemaVersion: 1,
        authority: 'host',
        catalogVersion: HOST_DOM_ROOT_CATALOG_VERSION,
        hostGeneration,
        roots: [...this.roots.values()].map(root => {
          const mounted = root.resolve() !== undefined
          const available = !this.disposed && !clientDisposed && generationCurrent
            && this.options.isolatedPluginBoundary && binding.state() === 'active' && mounted
          return Object.freeze({
            rootId: root.rootId,
            name: root.name,
            description: root.description,
            sensitivity: root.sensitivity,
            availability: available ? 'available' as const : 'unavailable' as const,
            ...(available ? {} : {
              unavailableReason: !generationCurrent
                ? 'generation-replaced' as const
                : !this.options.isolatedPluginBoundary
                ? 'unsupported' as const
                : !mounted
                ? 'not-mounted' as const
                : 'profile-unavailable' as const,
            }),
            readOperations: root.readOperations,
            modifyOperations: root.modifyOperations,
          })
        }),
      }
    }

    const nodeRef = (element: Element, rootId: string): HostDomNodeRef | undefined => {
      const existing = elementRefs.get(element)?.get(rootId)
      if (existing !== undefined) return existing
      if (nodes.size >= MAX_NODE_REFS_PER_CLIENT) return undefined
      const id = makeOpaque('hdn', ++this.sequence) as HostDomNodeRef
      const refs = elementRefs.get(element) ?? new Map<string, HostDomNodeRef>()
      refs.set(rootId, id)
      elementRefs.set(element, refs)
      nodes.set(id, { ownerKey: binding.ownerKey, moduleGeneration: binding.moduleGeneration, rootId, element })
      return id
    }

    const validateHandle = (
      request: HostDomBridgeRequest,
      expected: 'ui.host-dom.read' | 'ui.host-dom.modify',
    ): HandleRecord | HostDomBridgeResult => {
      const handleId = 'handle' in request ? request.handle : undefined
      const handle = handleId === undefined ? undefined : handles.get(handleId)
      if (handle === undefined) return unavailable(request, currentGeneration(), 'stale-handle')
      if (handle.ownerKey !== binding.ownerKey || handle.moduleGeneration !== binding.moduleGeneration) {
        rollback(handle)
        return denied(request, currentGeneration(), 'owner-mismatch')
      }
      const stateCode = stateUnavailable(binding.state())
      if (stateCode !== undefined || currentGeneration() !== this.options.hostGeneration) {
        rollback(handle)
        return unavailable(request, currentGeneration(), stateCode ?? 'generation-replaced')
      }
      if (!binding.leaseActive(handle.leaseId)) {
        rollback(handle)
        return unavailable(request, currentGeneration(), 'stale-handle')
      }
      if (handle.capability !== expected) return denied(request, currentGeneration(), 'operation-denied')
      const resolved = this.roots.get(handle.rootId)?.resolve()
      if (resolved === undefined || resolved !== handle.root || !resolved.isConnected) {
        rollback(handle)
        return unavailable(request, currentGeneration(), 'not-mounted')
      }
      return handle
    }

    const resolveNode = (handle: HandleRecord, node?: HostDomNodeRef): Element | undefined => {
      if (node === undefined) return handle.root
      const candidate = nodes.get(node)
      if (
        candidate === undefined || candidate.ownerKey !== binding.ownerKey
        || candidate.moduleGeneration !== binding.moduleGeneration || candidate.rootId !== handle.rootId
        || !candidate.element.isConnected
        || (candidate.element !== handle.root && !handle.root.contains(candidate.element))
      ) return undefined
      return candidate.element
    }

    const inspect = (handle: HandleRecord, target: Element): HostDomReadProjection => {
      const entries: Extract<HostDomReadProjection, { kind: 'structure' }>['nodes'][number][] = []
      let truncated = false
      let redacted = false
      const visit = (element: Element, depth: number) => {
        if (entries.length >= MAX_STRUCTURE_NODES || depth > MAX_STRUCTURE_DEPTH) {
          truncated = true
          return
        }
        const hidden = redactedSubtree(element)
        redacted ||= hidden
        if (hidden && element !== target) return
        const node = nodeRef(element, handle.rootId)
        if (node === undefined) {
          truncated = true
          return
        }
        entries.push({
          node,
          kind: element === handle.root ? 'root' : elementKind(element),
          depth,
          childCount: hidden ? 0 : Math.min(element.children.length, 1000),
          owned: element.getAttribute('data-cordisx-host-dom-owner') === binding.ownerKey,
        })
        if (hidden) return
        for (const child of element.children) visit(child, depth + 1)
      }
      visit(target, 0)
      return { kind: 'structure', nodes: entries, truncated, redacted }
    }

    const read = (request: Extract<HostDomBridgeRequest, { type: 'read' }>): HostDomBridgeResult => {
      const checked = validateHandle(request, 'ui.host-dom.read')
      if (!('leaseId' in checked)) return checked
      if (!checked.operations.has(request.operation)) return denied(request, currentGeneration(), 'operation-denied')
      const target = resolveNode(checked, request.node)
      if (target === undefined) return denied(request, currentGeneration(), 'scope-denied')
      if (PROHIBITED_ELEMENT_TAGS.has(target.tagName)) return denied(request, currentGeneration(), 'scope-denied')
      let projection: HostDomReadProjection
      if (request.operation === 'inspect-structure') projection = inspect(checked, target)
      else if (request.operation === 'read-text') {
        projection = boundedText(target)
      } else if (request.operation === 'read-attributes') {
        if (
          new Set(request.attributes).size !== request.attributes.length
          || request.attributes.some(attribute => !READ_ATTRIBUTES.includes(attribute))
        ) {
          return denied(request, currentGeneration(), 'operation-denied')
        }
        const redacted = redactedSubtree(target)
        projection = {
          kind: 'attributes',
          attributes: redacted ? [] : request.attributes.map(name => ({ name, value: attributeValue(target, name) })),
          redacted,
        }
      } else {
        const view = target.ownerDocument.defaultView
        const style = view?.getComputedStyle(target)
        const redacted = redactedSubtree(target)
        projection = redacted
          ? {
            kind: 'state',
            visible: false,
            enabled: false,
            focused: false,
            expanded: null,
            selected: null,
            pressed: null,
            redacted: true,
          }
          : {
            kind: 'state',
            visible: style?.display !== 'none' && style?.visibility !== 'hidden' && !target.hasAttribute('hidden'),
            enabled: !target.hasAttribute('disabled') && target.getAttribute('aria-disabled') !== 'true',
            focused: target.ownerDocument.activeElement === target,
            expanded: target.hasAttribute('aria-expanded') ? target.getAttribute('aria-expanded') === 'true' : null,
            selected: target.hasAttribute('aria-selected') ? target.getAttribute('aria-selected') === 'true' : null,
            pressed: target.hasAttribute('aria-pressed') ? target.getAttribute('aria-pressed') === 'true' : null,
            redacted: false,
          }
      }
      return {
        ...base(request, currentGeneration()),
        type: 'read',
        status: 'accepted',
        code: 'allowed',
        handle: checked.id,
        capability: 'ui.host-dom.read',
        rootId: checked.rootId,
        operation: request.operation,
        projection,
      }
    }

    const createChild = (handle: HandleRecord, child: HostDomStructuredChild): Element | undefined => {
      if (!localId(child.id)) return undefined
      const element = handle.root.ownerDocument.createElement(child.kind === 'action' ? 'button' : 'span')
      element.setAttribute('data-cordisx-host-dom-owner', binding.ownerKey)
      element.setAttribute('data-cordisx-host-dom-child', child.id)
      if (child.kind === 'text') element.textContent = localized(child.text, this.options.resolveText)
      else {
        if (!localId(child.command.id)) return undefined
        element.textContent = localized(child.label, this.options.resolveText)
        ;(element as HTMLButtonElement).type = 'button'
        ;(element as HTMLButtonElement).disabled = child.disabled?.value === true
        element.addEventListener('click', () => {
          const root = this.roots.get(handle.rootId)?.resolve()
          if (
            !handles.has(handle.id) || !binding.leaseActive(handle.leaseId) || binding.state() !== 'active'
            || currentGeneration() !== this.options.hostGeneration || root !== handle.root || !handle.root.isConnected
            || !element.isConnected || (element !== handle.root && !handle.root.contains(element))
          ) return
          void Promise.resolve(binding.invokeCommand?.(child.command.id, child.command.arguments)).catch(() =>
            undefined
          )
        })
      }
      return element
    }

    const modify = (request: Extract<HostDomBridgeRequest, { type: 'modify' }>): HostDomBridgeResult => {
      const checked = validateHandle(request, 'ui.host-dom.modify')
      if (!('leaseId' in checked)) return checked
      if (!checked.operations.has(request.operation)) return denied(request, currentGeneration(), 'operation-denied')
      const target = resolveNode(checked, request.node)
      if (target === undefined || privateElement(target) || ['SCRIPT', 'STYLE'].includes(target.tagName)) {
        return denied(request, currentGeneration(), 'scope-denied')
      }
      let changed = false
      let ownedChild: string | undefined
      if (request.operation === 'set-text') {
        if (
          typeof request.text !== 'string' || request.text.length > MAX_WRITE_TEXT
          || (target.children.length > 0 && target.getAttribute('data-cordisx-host-dom-owner') !== binding.ownerKey)
        ) {
          return denied(request, currentGeneration(), 'operation-denied')
        }
        const before = target.textContent
        if (before !== request.text) {
          target.textContent = request.text
          changed = true
          checked.rollback.push(() => {
            if (target.textContent === request.text) target.textContent = before
          })
        }
      } else if (request.operation === 'set-attribute') {
        if (
          !MUTABLE_ATTRIBUTES.has(request.attribute)
          || (typeof request.value === 'string' && request.value.length > 512)
        ) {
          return denied(request, currentGeneration(), 'operation-denied')
        }
        const before = target.getAttribute(request.attribute)
        const next = normalizeAttributeValue(request.value)
        if (before !== next) {
          if (next === null) target.removeAttribute(request.attribute)
          else target.setAttribute(request.attribute, next)
          changed = true
          checked.rollback.push(() => {
            if (target.getAttribute(request.attribute) !== next) return
            if (before === null) target.removeAttribute(request.attribute)
            else target.setAttribute(request.attribute, before)
          })
        }
      } else if (request.operation === 'insert-owned-structured-child') {
        const duplicate = [
          ...checked.root.querySelectorAll('[data-cordisx-host-dom-owner][data-cordisx-host-dom-child]'),
        ]
          .find(element =>
            element.getAttribute('data-cordisx-host-dom-owner') === binding.ownerKey
            && element.getAttribute('data-cordisx-host-dom-child') === request.child.id
          )
        const child = duplicate === undefined ? createChild(checked, request.child) : undefined
        if (child === undefined) return denied(request, currentGeneration(), 'operation-denied')
        target.append(child)
        changed = true
        ownedChild = request.child.id
        checked.rollback.push(() => {
          if (child.parentElement !== null) child.remove()
        })
      } else if (request.operation === 'remove-owned-child') {
        if (!localId(request.childId)) return denied(request, currentGeneration(), 'operation-denied')
        const children = [...target.children]
        const child = children.find(element =>
          element.getAttribute('data-cordisx-host-dom-owner') === binding.ownerKey
          && element.getAttribute('data-cordisx-host-dom-child') === request.childId
        )
        if (child !== undefined) {
          child.remove()
          changed = true
          nodes.forEach((entry, key) => {
            if (entry.element !== child && !child.contains(entry.element)) return
            nodes.delete(key)
            deleteNodeRef(entry.element, entry.rootId)
          })
        }
      } else {
        const focusTarget = target as HTMLElement
        if (typeof focusTarget.focus !== 'function') return denied(request, currentGeneration(), 'operation-denied')
        focusTarget.focus({ preventScroll: true })
        changed = target.ownerDocument.activeElement === target
      }
      return {
        ...base(request, currentGeneration()),
        type: 'modify',
        status: 'accepted',
        code: 'allowed',
        handle: checked.id,
        capability: 'ui.host-dom.modify',
        rootId: checked.rootId,
        operation: request.operation,
        changed,
        ...(ownedChild === undefined ? {} : { ownedChild }),
      }
    }

    const acquire = async (
      request: Extract<HostDomBridgeRequest, { type: 'acquire' }>,
    ): Promise<HostDomBridgeResult> => {
      reconcile()
      if (!this.options.isolatedPluginBoundary) return unavailable(request, currentGeneration(), 'unsupported')
      const stateCode = stateUnavailable(binding.state())
      if (stateCode !== undefined) return unavailable(request, currentGeneration(), stateCode)
      if (currentGeneration() !== this.options.hostGeneration) {
        return unavailable(request, currentGeneration(), 'generation-replaced')
      }
      const definition = this.roots.get(request.rootId)
      if (definition === undefined) return unavailable(request, currentGeneration(), 'unknown-root')
      const root = definition.resolve()
      if (root === undefined || !root.isConnected) return unavailable(request, currentGeneration(), 'not-mounted')
      const allowedOperations = request.capability === 'ui.host-dom.read'
        ? definition.readOperations
        : definition.modifyOperations
      if (
        request.operations.length < 1 || new Set(request.operations).size !== request.operations.length
        || request.operations.some(operation => !allowedOperations.includes(operation as never))
      ) {
        return denied(request, currentGeneration(), 'operation-denied')
      }
      if (handles.size + pendingHandles >= MAX_HANDLES_PER_CLIENT) {
        return denied(request, currentGeneration(), 'permission-denied')
      }
      const modify = request.capability === 'ui.host-dom.modify'
      const overlaps = (candidate: Element) =>
        candidate === root || candidate.contains(root) || root.contains(candidate)
      if (
        modify && ([...this.activeModifyRoots.values()].some(overlaps) || [...this.pendingModifyRoots].some(overlaps))
      ) {
        return denied(request, currentGeneration(), 'operation-denied')
      }
      if (modify) this.pendingModifyRoots.add(root)
      pendingHandles += 1
      try {
        const decision = await binding.authorize(request.capability, request.rootId, request.operations)
        if (clientDisposed || this.disposed) return unavailable(request, currentGeneration(), 'disposed')
        const postState = stateUnavailable(binding.state())
        if (postState !== undefined || currentGeneration() !== this.options.hostGeneration) {
          return unavailable(request, currentGeneration(), postState ?? 'generation-replaced')
        }
        if (!decision.authorized || decision.lease === undefined) {
          return denied(
            request,
            currentGeneration(),
            decision.reason === 'permission.denied-persistent' ? 'persistent-deny' : 'permission-denied',
          )
        }
        const lease = decision.lease
        const currentRoot = definition.resolve()
        if (
          currentRoot === undefined || currentRoot !== root || !currentRoot.isConnected
          || !binding.leaseActive(lease.leaseId)
          || lease.runtimeGeneration !== binding.runtimeGeneration
          || lease.moduleGeneration !== binding.moduleGeneration
          || lease.key.profileId !== binding.profileId
          || lease.key.identity.source !== binding.identity.source
          || lease.key.identity.pluginId !== binding.identity.pluginId
          || lease.key.capability !== request.capability
          || !lease.key.scope.rootIds?.includes(request.rootId)
          || request.operations.some(operation => !lease.key.scope.operations?.includes(operation as never))
        ) {
          return denied(request, currentGeneration(), 'permission-denied')
        }
        const handle = makeOpaque('hdh', ++this.sequence) as HostDomHandle
        const record: HandleRecord = {
          id: handle,
          ownerKey: binding.ownerKey,
          moduleGeneration: binding.moduleGeneration,
          rootId: request.rootId,
          root,
          capability: request.capability,
          operations: new Set(request.operations),
          leaseId: lease.leaseId,
          rollback: [],
        }
        handles.set(handle, record)
        if (modify) {
          this.activeModifyRoots.set(handle, root)
          record.expiryTimer = setTimeout(() => rollback(record), MAX_MODIFY_HANDLE_LIFETIME_MS)
          ;(record.expiryTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
        }
        if (request.capability === 'ui.host-dom.read') {
          return {
            ...base(request, currentGeneration()),
            type: 'acquire',
            status: 'accepted',
            code: 'allowed',
            handle,
            capability: request.capability,
            rootId: request.rootId,
            operations: request.operations,
          }
        }
        return {
          ...base(request, currentGeneration()),
          type: 'acquire',
          status: 'accepted',
          code: 'allowed',
          handle,
          capability: request.capability,
          rootId: request.rootId,
          operations: request.operations,
        }
      } finally {
        pendingHandles -= 1
        if (modify) this.pendingModifyRoots.delete(root)
      }
    }

    const parse = (value: HostDomBridgeRequest): HostDomBridgeRequest | undefined => {
      const snapshot = immutableSnapshot(value)
      const input = record(snapshot)
      if (
        input === undefined || serializableSize(snapshot) > MAX_REQUEST_BYTES
        || input.$schema !== REQUEST_SCHEMA || input.contract !== CONTRACT || input.schemaVersion !== 1
        || !requestId(input.requestId) || !['acquire', 'read', 'modify', 'release'].includes(String(input.type))
      ) return undefined
      const common = ['$schema', 'contract', 'schemaVersion', 'requestId', 'type']
      if (input.type === 'acquire') {
        if (
          !exact(input, [...common, 'capability', 'rootId', 'operations']) || !localId(input.rootId)
          || (input.capability !== 'ui.host-dom.read' && input.capability !== 'ui.host-dom.modify')
          || !Array.isArray(input.operations)
          || input.operations.length < 1 || new Set(input.operations).size !== input.operations.length
          || input.operations.some(operation => typeof operation !== 'string')
          || (input.capability === 'ui.host-dom.read'
            ? input.operations.some(operation => !READ_OPERATIONS.has(operation as HostDomReadOperation))
            : input.operations.some(operation => !MODIFY_OPERATIONS.has(operation as HostDomModifyOperation)))
        ) return undefined
      } else if (input.type === 'release') {
        if (!exact(input, [...common, 'handle']) || !opaqueId(input.handle, 'hdh')) return undefined
      } else if (input.type === 'read') {
        const keys = input.operation === 'read-attributes'
          ? [...common, 'handle', 'operation', 'node', 'attributes']
          : [...common, 'handle', 'operation', 'node']
        if (
          !exact(input, keys) || !opaqueId(input.handle, 'hdh')
          || !READ_OPERATIONS.has(input.operation as HostDomReadOperation)
          || (input.node !== undefined && !opaqueId(input.node, 'hdn'))
          || (input.operation === 'read-attributes' && (!Array.isArray(input.attributes)
            || input.attributes.length < 1 || input.attributes.length > 16
            || new Set(input.attributes).size !== input.attributes.length
            || input.attributes.some(attribute =>
              typeof attribute !== 'string' || !READ_ATTRIBUTES.includes(attribute as HostDomReadableAttribute)
            )))
        ) return undefined
      } else {
        const operation = input.operation as HostDomModifyOperation
        const extra = operation === 'set-text' ? ['text'] : operation === 'set-attribute'
          ? ['attribute', 'value']
          : operation === 'insert-owned-structured-child'
          ? ['child']
          : operation === 'remove-owned-child'
          ? ['childId']
          : []
        if (
          !exact(input, [...common, 'handle', 'node', 'operation', ...extra]) || !opaqueId(input.handle, 'hdh')
          || (input.node !== undefined && !opaqueId(input.node, 'hdn')) || !MODIFY_OPERATIONS.has(operation)
        ) return undefined
        if (operation === 'set-text' && (typeof input.text !== 'string' || input.text.length > 16_384)) return undefined
        if (
          operation === 'set-attribute' && (!MUTABLE_ATTRIBUTES.has(input.attribute as HostDomReadableAttribute)
            || !attributeValueInput(input.value))
        ) return undefined
        if (operation === 'insert-owned-structured-child' && !validStructuredChild(input.child)) return undefined
        if (operation === 'remove-owned-child' && !localId(input.childId)) return undefined
      }
      return snapshot
    }

    const request = async (untrusted: HostDomBridgeRequest): Promise<HostDomBridgeResult> => {
      const parsed = parse(untrusted)
      if (parsed === undefined) {
        const fallback = record(untrusted)
        const safeRequest = {
          requestId: requestId(fallback?.requestId) ? fallback.requestId : 'invalid-request',
          type: ['acquire', 'read', 'modify', 'release'].includes(String(fallback?.type))
            ? fallback!.type as HostDomBridgeRequest['type']
            : 'acquire' as const,
        }
        return denied(safeRequest, currentGeneration(), 'operation-denied')
      }
      if (clientDisposed || this.disposed) return unavailable(parsed, currentGeneration(), 'disposed')
      reconcile()
      if (seenRequests.has(parsed.requestId)) return denied(parsed, currentGeneration(), 'operation-denied')
      seenRequests.add(parsed.requestId)
      if (seenRequests.size > 1024) seenRequests.delete(seenRequests.values().next().value!)
      if (parsed.type === 'acquire') return await acquire(parsed)
      if (parsed.type === 'read') return read(parsed)
      if (parsed.type === 'modify') return modify(parsed)
      const handle = handles.get(parsed.handle)
      if (handle === undefined) return unavailable(parsed, currentGeneration(), 'stale-handle')
      if (handle.ownerKey !== binding.ownerKey) return denied(parsed, currentGeneration(), 'owner-mismatch')
      rollback(handle)
      return { ...base(parsed, currentGeneration()), type: 'release', status: 'accepted', code: 'released' }
    }

    const disposeClient = () => {
      if (clientDisposed) return
      clientDisposed = true
      detachInvalidation()
      detachHostGenerationInvalidation()
      for (const handle of [...handles.values()]) rollback(handle)
      nodes.clear()
      seenRequests.clear()
      this.clientDisposers.delete(disposeClient)
    }
    this.clientDisposers.add(disposeClient)
    return Object.freeze({
      catalog,
      request,
      dispose: disposeClient,
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const dispose of [...this.clientDisposers]) dispose()
    this.clientDisposers.clear()
    this.activeModifyRoots.clear()
    this.pendingModifyRoots.clear()
  }
}

/** Canonical Host roots. Selectors remain inside Host code and never enter plugin scope. */
export function createCordisXHostDomRootDefinitions(document: Document): readonly HostDomRootDefinition[] {
  const allRead = Object.freeze([...READ_OPERATIONS])
  const allModify = Object.freeze([...MODIFY_OPERATIONS])
  return Object.freeze([
    Object.freeze({
      rootId: 'app.shell',
      name: Object.freeze({ key: 'host-dom.root.app-shell.name', fallback: 'App shell' }),
      description: Object.freeze({
        key: 'host-dom.root.app-shell.description',
        fallback: 'The visible Codex application shell.',
      }),
      sensitivity: 'high-risk' as const,
      readOperations: allRead,
      modifyOperations: allModify,
      resolve: () =>
        document.querySelector<HTMLElement>('#root, [data-testid="app-shell"]') ?? document.body ?? undefined,
    }),
    Object.freeze({
      rootId: 'manager.surface',
      name: Object.freeze({ key: 'host-dom.root.manager.name', fallback: 'CordisX Manager' }),
      description: Object.freeze({
        key: 'host-dom.root.manager.description',
        fallback: 'The Host-owned CordisX Manager surface.',
      }),
      sensitivity: 'high-risk' as const,
      readOperations: allRead,
      modifyOperations: allModify,
      resolve: () => document.querySelector<HTMLElement>('[data-cordisx-react-manager="true"]') ?? undefined,
    }),
    Object.freeze({
      rootId: 'composer.surface',
      name: Object.freeze({ key: 'host-dom.root.composer.name', fallback: 'Composer' }),
      description: Object.freeze({
        key: 'host-dom.root.composer.description',
        fallback: 'The Host-owned message composer surface.',
      }),
      sensitivity: 'high-risk' as const,
      readOperations: allRead,
      modifyOperations: Object.freeze(['focus'] as const),
      resolve: () =>
        document.querySelector<HTMLElement>('[data-testid="composer"], [data-cordisx-host-composer]') ?? undefined,
    }),
  ])
}
