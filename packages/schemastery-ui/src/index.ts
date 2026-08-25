/**
 * Framework-neutral core for CordisX's Host-owned Schemastery form renderer.
 *
 * This is intentionally a data/presenter engine. It has no DOM, Manager,
 * plugin lifecycle, storage, or TDesign dependency, so every Host surface can
 * make the same safe presentation decision before its renderer is involved.
 */

export type FormDescriptorKind =
  | 'string' | 'number' | 'natural' | 'boolean' | 'array' | 'object'
  | 'tuple' | 'dict' | 'map' | 'set' | 'union' | 'intersect' | 'literal'
  | 'transform' | 'any' | 'never' | 'unknown'

export type FormPresenterKind =
  | 'choice.select' | 'choice.radio' | 'choice.segmented'
  | 'number.input' | 'number.stepper' | 'number.slider'
  | 'array.scalar-tags' | 'array.scalar-rows'
  | 'array.object-auto' | 'array.object-dialog' | 'array.object-page'

export type FormPrimitive =
  | 'input' | 'textarea' | 'secret' | 'path-input' | 'date-picker'
  | 'time-picker' | 'color-picker' | 'number-input' | 'checkbox' | 'switch'
  | 'select' | 'radio' | 'slider' | 'multi-select' | 'tag-input'
  | 'object-array' | 'json-textarea' | 'unsupported'

export type FormControlLayout = 'fill' | 'compact'

export interface FormPresenterOptions {
  readonly density?: 'compact' | 'regular'
  readonly maxInlineItems?: number
  readonly allowReorder?: boolean
}

export interface FormPresentation {
  readonly version: 1
  readonly kind: FormPresenterKind
  readonly options?: FormPresenterOptions
}

export interface FormChoice {
  readonly label: string
  readonly value: string | number | boolean | null
  readonly description?: string
  readonly disabled?: boolean
}

export interface FormDescriptor {
  readonly path: readonly string[]
  readonly type: FormDescriptorKind
  readonly role?: string
  readonly label?: string
  readonly description?: string
  readonly required?: boolean
  readonly hidden?: boolean
  readonly disabled?: boolean
  readonly readOnly?: boolean
  readonly defaultValue?: unknown
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly choices?: readonly FormChoice[]
  readonly itemType?: FormDescriptorKind
  readonly item?: FormDescriptor
  readonly fields?: readonly FormDescriptor[]
  readonly variants?: readonly FormDescriptor[]
  readonly presentation?: FormPresentation
}

export interface PresenterDiagnostic {
  readonly code: 'unsupported-presenter' | 'unsupported-schema'
  readonly detail: string
}

export interface PresenterResolution {
  readonly primitive: FormPrimitive
  readonly layout: FormControlLayout
  readonly requested?: FormPresentation
  readonly diagnostic?: PresenterDiagnostic
}

export interface FormIssue {
  readonly code: 'required' | 'choice' | 'number' | 'range' | 'step' | 'array'
}

const presenterKinds = new Set<FormPresenterKind>([
  'choice.select', 'choice.radio', 'choice.segmented',
  'number.input', 'number.stepper', 'number.slider',
  'array.scalar-tags', 'array.scalar-rows',
  'array.object-auto', 'array.object-dialog', 'array.object-page',
])

const descriptorKinds = new Set<FormDescriptorKind>([
  'string', 'number', 'natural', 'boolean', 'array', 'object', 'tuple',
  'dict', 'map', 'set', 'union', 'intersect', 'literal', 'transform', 'any',
  'never', 'unknown',
])

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function boundedInteger(value: unknown, lower: number, upper: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= lower && value <= upper
    ? value
    : undefined
}

/** Parse only the closed v1 presentation vocabulary from untrusted metadata. */
export function normalizeFormPresentation(value: unknown): FormPresentation | undefined {
  const input = record(value)
  if (input?.version !== 1 || typeof input.kind !== 'string' || !presenterKinds.has(input.kind as FormPresenterKind)) return undefined
  const rawOptions = record(input.options)
  const options: FormPresenterOptions = {
    ...(rawOptions?.density === 'compact' || rawOptions?.density === 'regular' ? { density: rawOptions.density } : {}),
    ...(boundedInteger(rawOptions?.maxInlineItems, 1, 64) === undefined ? {} : { maxInlineItems: boundedInteger(rawOptions?.maxInlineItems, 1, 64)! }),
    ...(typeof rawOptions?.allowReorder === 'boolean' ? { allowReorder: rawOptions.allowReorder } : {}),
  }
  return {
    version: 1,
    kind: input.kind as FormPresenterKind,
    ...(Object.keys(options).length === 0 ? {} : { options }),
  }
}

/**
 * Normalizes only presentation-safe descriptor facts. Labels and descriptions
 * remain plain data; no renderer, markup, CSS, callback, or arbitrary option
 * crosses this boundary.
 */
export function normalizeFormDescriptor(value: unknown, path: readonly string[] = []): FormDescriptor | undefined {
  const input = record(value)
  if (input === undefined || typeof input.type !== 'string' || !descriptorKinds.has(input.type as FormDescriptorKind)) return undefined
  const readChoices = (value: unknown): readonly FormChoice[] | undefined => Array.isArray(value)
    ? value.flatMap(choice => {
      const item = record(choice)
      if (item === undefined || typeof item.label !== 'string' || !['string', 'number', 'boolean'].includes(typeof item.value) && item.value !== null) return []
      return [{
        label: item.label,
        value: item.value as FormChoice['value'],
        ...(typeof item.description === 'string' ? { description: item.description } : {}),
        ...(typeof item.disabled === 'boolean' ? { disabled: item.disabled } : {}),
      }]
    })
    : undefined
  const fields = Array.isArray(input.fields)
    ? input.fields.flatMap((child, index) => {
      const childInput = record(child)
      const key = typeof childInput?.key === 'string' ? childInput.key : String(index)
      const normalized = normalizeFormDescriptor(child, [...path, key])
      return normalized === undefined ? [] : [normalized]
    })
    : undefined
  const variants = Array.isArray(input.variants)
    ? input.variants.flatMap((child, index) => {
      const normalized = normalizeFormDescriptor(child, [...path, String(index)])
      return normalized === undefined ? [] : [normalized]
    })
    : undefined
  return {
    path,
    type: input.type as FormDescriptorKind,
    ...(typeof input.role === 'string' ? { role: input.role } : {}),
    ...(typeof input.label === 'string' ? { label: input.label } : {}),
    ...(typeof input.description === 'string' ? { description: input.description } : {}),
    ...(typeof input.required === 'boolean' ? { required: input.required } : {}),
    ...(typeof input.hidden === 'boolean' ? { hidden: input.hidden } : {}),
    ...(typeof input.disabled === 'boolean' ? { disabled: input.disabled } : {}),
    ...(typeof input.readOnly === 'boolean' ? { readOnly: input.readOnly } : {}),
    ...('defaultValue' in input ? { defaultValue: input.defaultValue } : {}),
    ...(typeof input.min === 'number' ? { min: input.min } : {}),
    ...(typeof input.max === 'number' ? { max: input.max } : {}),
    ...(typeof input.step === 'number' ? { step: input.step } : {}),
    ...(readChoices(input.choices) === undefined ? {} : { choices: readChoices(input.choices)! }),
    ...(typeof input.itemType === 'string' && descriptorKinds.has(input.itemType as FormDescriptorKind) ? { itemType: input.itemType as FormDescriptorKind } : {}),
    ...(normalizeFormDescriptor(input.item, [...path, '*']) === undefined ? {} : { item: normalizeFormDescriptor(input.item, [...path, '*'])! }),
    ...(fields === undefined ? {} : { fields }),
    ...(variants === undefined ? {} : { variants }),
    ...(normalizeFormPresentation(input.presentation) === undefined ? {} : { presentation: normalizeFormPresentation(input.presentation)! }),
  }
}

function primitiveLayout(primitive: FormPrimitive): FormControlLayout {
  return ['number-input', 'checkbox', 'switch', 'radio', 'slider'].includes(primitive) ? 'compact' : 'fill'
}

function basePrimitive(field: FormDescriptor): FormPrimitive {
  if (field.role === 'secret') return 'secret'
  if (field.type === 'array') {
    if (field.choices !== undefined && field.role === 'multi-select') return 'multi-select'
    if (field.item?.type === 'object') return 'object-array'
    if (field.itemType === 'string' || field.itemType === 'number' || field.itemType === 'boolean') return 'tag-input'
    return 'unsupported'
  }
  if (field.choices !== undefined) return field.role === 'radio' ? 'radio' : 'select'
  if (field.type === 'boolean') return field.role === 'switch' ? 'switch' : 'checkbox'
  if (field.type === 'number' || field.type === 'natural') return field.role === 'slider' ? 'slider' : 'number-input'
  if (field.type === 'string') {
    if (field.role === 'textarea' || field.role === 'multiline' || field.role === 'code' || field.role === 'json') return 'textarea'
    if (field.role === 'path' || field.role === 'file' || field.role === 'directory' || field.role === 'url' || field.role === 'link') return 'path-input'
    if (field.role === 'date' || field.role === 'datetime') return 'date-picker'
    if (field.role === 'time') return 'time-picker'
    if (field.role === 'color') return 'color-picker'
    return 'input'
  }
  if (field.type === 'object' || field.type === 'tuple' || field.type === 'dict' || field.type === 'map' || field.type === 'set' || field.type === 'intersect') return 'json-textarea'
  return 'unsupported'
}

function presentationCompatible(field: FormDescriptor, kind: FormPresenterKind): boolean {
  if (kind.startsWith('choice.')) return field.type !== 'array' && field.choices !== undefined
  if (kind.startsWith('number.')) return field.type === 'number' || field.type === 'natural'
  if (kind.startsWith('array.scalar')) return field.type === 'array' && field.itemType !== undefined
  return field.type === 'array' && field.item?.type === 'object'
}

/** Resolve a closed request once, identically for Manager, dialogs, pages, and Playground. */
export function resolveFormPresenter(field: FormDescriptor): PresenterResolution {
  const fallback = basePrimitive(field)
  const requested = field.presentation
  if (requested === undefined) return { primitive: fallback, layout: primitiveLayout(fallback) }
  if (!presentationCompatible(field, requested.kind)) {
    return {
      primitive: fallback,
      layout: primitiveLayout(fallback),
      requested,
      diagnostic: { code: 'unsupported-presenter', detail: `Presenter ${requested.kind} does not match ${field.type}` },
    }
  }
  const primitive: FormPrimitive = requested.kind === 'choice.select' ? 'select'
    : requested.kind === 'choice.radio' || requested.kind === 'choice.segmented' ? 'radio'
      : requested.kind === 'number.slider' ? 'slider'
        : requested.kind === 'number.input' || requested.kind === 'number.stepper' ? 'number-input'
          : requested.kind === 'array.scalar-tags' || requested.kind === 'array.scalar-rows' ? (field.choices === undefined ? 'tag-input' : 'multi-select')
            : 'object-array'
  return { primitive, layout: primitiveLayout(primitive), requested }
}

/** Stable, copy-free issue codes. The Host maps them to its locale catalog. */
export function validateFormValue(field: FormDescriptor, value: unknown): readonly FormIssue[] {
  const issues: FormIssue[] = []
  if (field.required && (value === undefined || value === null || value === '')) issues.push({ code: 'required' })
  if (field.choices !== undefined && value !== undefined && !field.choices.some(choice => Object.is(choice.value, value))) issues.push({ code: 'choice' })
  if ((field.type === 'number' || field.type === 'natural') && value !== undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value)) issues.push({ code: 'number' })
    else {
      if (field.min !== undefined && value < field.min || field.max !== undefined && value > field.max) issues.push({ code: 'range' })
      if (field.step !== undefined && field.min !== undefined && Math.abs((value - field.min) / field.step - Math.round((value - field.min) / field.step)) > 1e-9) issues.push({ code: 'step' })
    }
  }
  if (field.type === 'array' && value !== undefined) {
    if (!Array.isArray(value) || field.min !== undefined && value.length < field.min || field.max !== undefined && value.length > field.max) issues.push({ code: 'array' })
  }
  return issues
}

export type FormDraftOperation = { readonly kind: 'set'; readonly value: unknown } | { readonly kind: 'unset' }

/** A small immutable-baseline transaction shared by nested Host presenters. */
export class FormDraft {
  readonly #committed: ReadonlyMap<string, unknown>
  readonly #operations = new Map<string, FormDraftOperation>()

  constructor(committed: ReadonlyMap<string, unknown> | Record<string, unknown>) {
    this.#committed = committed instanceof Map ? new Map(committed) : new Map(Object.entries(committed))
  }

  set(path: readonly string[], value: unknown): void { this.#operations.set(path.join('.'), { kind: 'set', value }) }
  unset(path: readonly string[]): void { this.#operations.set(path.join('.'), { kind: 'unset' }) }
  rollback(path: readonly string[]): void { this.#operations.delete(path.join('.')) }
  reset(): void { this.#operations.clear() }
  operation(path: readonly string[]): FormDraftOperation | undefined { return this.#operations.get(path.join('.')) }
  isDirty(path?: readonly string[]): boolean { return path === undefined ? this.#operations.size > 0 : this.#operations.has(path.join('.')) }
  operations(): ReadonlyMap<string, FormDraftOperation> { return new Map(this.#operations) }
  value(path: readonly string[], defaultValue?: unknown): unknown {
    const operation = this.operation(path)
    if (operation?.kind === 'set') return operation.value
    if (operation?.kind === 'unset') return defaultValue
    return this.#committed.get(path.join('.'))
  }
}
