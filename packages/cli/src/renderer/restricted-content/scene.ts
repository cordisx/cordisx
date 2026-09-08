import { encodeRestrictedJson, RESTRICTED_LIMITS, type RestrictedJson } from './json.js'

export type RestrictedSceneNode =
  | { readonly type: 'text'; readonly text: string; readonly tone?: 'default' | 'muted' | 'accent' }
  | {
    readonly type: 'stack'
    readonly direction?: 'vertical' | 'horizontal'
    readonly children: readonly RestrictedSceneNode[]
  }
  | { readonly type: 'grid'; readonly columns: number; readonly children: readonly RestrictedSceneNode[] }
  | {
    readonly type: 'button'
    readonly label: string
    readonly ariaLabel?: string
    readonly action: RestrictedJson
    readonly disabled?: boolean
  }
  | {
    readonly type: 'number-action'
    readonly label: string
    readonly min: number
    readonly max: number
    readonly step: number
    readonly value: number
    readonly action: { [key: string]: RestrictedJson }
    readonly valueKey: string
  }

export interface RestrictedScene {
  readonly version: 1
  readonly root: RestrictedSceneNode
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected scene object')
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key))) throw new Error('Missing scene field')
  if (Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new Error('Unknown scene field')
  }
}

function text(value: unknown): void {
  if (typeof value !== 'string' || value.length > RESTRICTED_LIMITS.textLength) throw new Error('Invalid scene text')
}

/** Strict schema; also returns a detached JSON copy so later caller mutation cannot change actions. */
export function validateRestrictedScene(value: unknown): RestrictedScene {
  // Scene JSON nesting includes children arrays as well as nodes; schema depth
  // below is the tighter node-depth limit. JSON depth is checked independently
  // for each action, not for the outer scene representation.
  const encoded = encodeScene(value)
  const scene = record(JSON.parse(encoded))
  exactKeys(scene, ['version', 'root'])
  if (scene.version !== 1) throw new Error('Unsupported scene version')
  let nodes = 0
  function node(value: unknown, depth: number): void {
    if (++nodes > RESTRICTED_LIMITS.sceneNodes || depth > RESTRICTED_LIMITS.depth) {
      throw new Error('Scene complexity limit')
    }
    const item = record(value)
    switch (item.type) {
      case 'text':
        exactKeys(item, ['type', 'text'], ['tone'])
        text(item.text)
        if (Object.hasOwn(item, 'tone') && !['default', 'muted', 'accent'].includes(item.tone as string)) {
          throw new Error('Invalid tone')
        }
        return
      case 'button':
        exactKeys(item, ['type', 'label', 'action'], ['disabled', 'ariaLabel'])
        text(item.label)
        if (Object.hasOwn(item, 'ariaLabel')) text(item.ariaLabel)
        if (Object.hasOwn(item, 'disabled') && typeof item.disabled !== 'boolean') {
          throw new Error('Invalid disabled flag')
        }
        encodeRestrictedJson(item.action, RESTRICTED_LIMITS.actionBytes)
        return
      case 'number-action':
        exactKeys(item, ['type', 'label', 'min', 'max', 'step', 'value', 'action', 'valueKey'])
        text(item.label)
        if (!['min', 'max', 'step', 'value'].every(key => Number.isSafeInteger(item[key]))) {
          throw new Error('Invalid numeric bounds')
        }
        if (
          !validRestrictedNumber(
            item as unknown as Extract<RestrictedSceneNode, { type: 'number-action' }>,
            item.value as number,
          )
        ) throw new Error('Invalid numeric value')
        if (!Number.isSafeInteger((item.max as number) - (item.min as number))) throw new Error('Numeric range limit')
        if (
          typeof item.valueKey !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(item.valueKey)
          || ['__proto__', 'prototype', 'constructor'].includes(item.valueKey)
        ) throw new Error('Invalid numeric action key')
        record(item.action)
        encodeRestrictedJson(item.action, RESTRICTED_LIMITS.actionBytes)
        // Reserve for the longest possible integer string within the range.
        for (const bound of [item.min, item.max]) {
          encodeRestrictedJson({ ...record(item.action), [item.valueKey]: bound }, RESTRICTED_LIMITS.actionBytes)
        }
        return
      case 'stack':
        exactKeys(item, ['type', 'children'], ['direction'])
        if (Object.hasOwn(item, 'direction') && !['vertical', 'horizontal'].includes(item.direction as string)) {
          throw new Error('Invalid direction')
        }
        break
      case 'grid':
        exactKeys(item, ['type', 'columns', 'children'])
        if (!Number.isInteger(item.columns) || (item.columns as number) < 1 || (item.columns as number) > 19) {
          throw new Error('Invalid grid columns')
        }
        break
      default:
        throw new Error('Unknown scene node')
    }
    if (!Array.isArray(item.children) || item.children.length > RESTRICTED_LIMITS.children) {
      throw new Error('Invalid scene children')
    }
    for (const child of item.children) node(child, depth + 1)
  }
  node(scene.root, 1)
  return scene as unknown as RestrictedScene
}

export function validRestrictedNumber(node: { min: number; max: number; step: number }, value: number): boolean {
  return Number.isSafeInteger(value) && node.step > 0 && value >= node.min && value <= node.max
    && Number.isSafeInteger(value - node.min) && (value - node.min) % node.step === 0
}

function encodeScene(value: unknown): string {
  return encodeRestrictedJson(value, RESTRICTED_LIMITS.sceneBytes, 2 * RESTRICTED_LIMITS.depth + 20)
}
