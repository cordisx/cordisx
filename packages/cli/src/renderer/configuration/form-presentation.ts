import type { SchemaNode } from './model.js'
import type {
  CordisXConfigFieldPath,
  CordisXConfigFieldSnapshot,
  CordisXConfigFormActionIcons,
  CordisXConfigFormGroupSnapshot,
  CordisXConfigFormIcon,
  CordisXConfigFormPresenter,
  CordisXConfigFormSchemaNode,
  CordisXJsonScalar,
  CordisXJsonValue,
} from '../../contracts.js'
import { normalizeFormPresentation } from '@cordisx/schemastery-ui'
import type {
  ManagerContentPluginConfigFormFieldV2,
  ManagerContentPluginConfigFormPresentationV2,
  ManagerContentPluginConfigLocalizedChoiceV2,
} from '@cordisx/protocol/manager-content-navigation/v5'
import { assertLocalId, assertLocalizedText } from '../validation.js'
import { assertPath, hasOwnPath, immutable, isReservedConfigRole, ownValue } from './values.js'
import { formSchemaDefaultValue } from '../form-schema-defaults.js'

function localizedText(
  value: string | Readonly<Record<string, string>> | undefined,
  locale: string,
): string | undefined {
  if (typeof value === 'string') return value
  if (value === undefined) return undefined
  const candidates = [locale, locale.split('-')[0], '', 'en']
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    const result = value[candidate]
    if (typeof result === 'string' && result.trim() !== '') return result
  }
  return Object.values(value).find(item => typeof item === 'string' && item.trim() !== '')
}

function choices(
  schema: SchemaNode,
): readonly { readonly label: string; readonly value: CordisXJsonScalar }[] | undefined {
  if (schema.type !== 'union' || schema.list === undefined) return undefined
  const result: { label: string; value: CordisXJsonScalar }[] = []
  for (const item of schema.list) {
    if (item.type !== 'const' || !['string', 'number', 'boolean'].includes(typeof item.value) && item.value !== null) {
      return undefined
    }
    result.push({ label: String(item.value), value: item.value as CordisXJsonScalar })
  }
  return result
}

function assertOnlyKeys(value: object, keys: readonly string[], label: string): void {
  const unknown = Object.keys(value).find(key => !keys.includes(key))
  if (unknown !== undefined) throw new Error(`${label} has unknown field ${unknown}`)
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function scalarValue(value: unknown, label: string): CordisXJsonScalar {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string' && value.length <= 4096) return value
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000_000) return value
  throw new Error(`${label} must be a bounded JSON scalar`)
}

function sameScalar(left: CordisXJsonScalar, right: CordisXJsonScalar): boolean {
  return Object.is(left, right) || left === right
}

function schemaNodeAtPath(schema: SchemaNode | undefined, path: CordisXConfigFieldPath): SchemaNode | undefined {
  let node = schema
  for (const segment of path) {
    if (node?.type !== 'object' || node.dict === undefined || !Object.hasOwn(node.dict, segment)) return undefined
    node = node.dict[segment]
  }
  return node
}

function assertFormText(value: unknown, label: string): void {
  if (typeof value === 'string') {
    if (value.trim() === '' || value.length > 400) throw new Error(`${label} must be a bounded non-empty string`)
    return
  }
  const record = objectValue(value, label)
  if (
    Object.keys(record).length === 0 || Object.keys(record).length > 32
    || Object.keys(record).some(locale => !/^[A-Za-z0-9-]{2,32}$/u.test(locale))
    || Object.values(record).some(item => typeof item !== 'string' || item.trim() === '' || item.length > 400)
  ) {
    throw new Error(`${label} must contain bounded locale strings`)
  }
}

function normalizedFormPresenter(value: unknown, label: string): CordisXConfigFormPresenter {
  const presenter = objectValue(value, label)
  assertOnlyKeys(presenter, ['version', 'kind', 'options'], label)
  if (presenter.options !== undefined) {
    const options = objectValue(presenter.options, `${label}.options`)
    assertOnlyKeys(options, ['density', 'maxInlineItems', 'allowReorder'], `${label}.options`)
  }
  const normalized = normalizeFormPresentation(presenter)
  if (normalized === undefined) throw new Error(`${label} is invalid`)
  const options = presenter.options as Record<string, unknown> | undefined
  if (options?.density !== undefined && options.density !== 'compact' && options.density !== 'regular') {
    throw new Error(`${label}.options.density is invalid`)
  }
  if (
    options?.maxInlineItems !== undefined
    && (!Number.isInteger(options.maxInlineItems) || (options.maxInlineItems as number) < 1
      || (options.maxInlineItems as number) > 64)
  ) {
    throw new Error(`${label}.options.maxInlineItems is invalid`)
  }
  if (options?.allowReorder !== undefined && typeof options.allowReorder !== 'boolean') {
    throw new Error(`${label}.options.allowReorder is invalid`)
  }
  return normalized as CordisXConfigFormPresenter
}

function normalizedFormGroup(value: unknown): ManagerContentPluginConfigFormFieldV2['group'] {
  if (value === undefined) return undefined
  const group = objectValue(value, 'manager config form group')
  assertOnlyKeys(group, ['id', 'title', 'description', 'icon'], 'manager config form group')
  if (typeof group.id !== 'string') throw new Error('manager config form group id is required')
  assertLocalId(group.id, 'manager config form group id')
  if (group.title !== undefined) assertFormText(group.title, 'manager config form group title')
  if (group.description !== undefined) assertFormText(group.description, 'manager config form group description')
  const icon = group.icon === undefined ? undefined : formIcon(group.icon)
  if (group.icon !== undefined && icon === undefined) throw new Error('manager config form group icon is invalid')
  return immutable({
    id: group.id,
    ...(group.title === undefined ? {} : { title: group.title }),
    ...(group.description === undefined ? {} : { description: group.description }),
    ...(icon === undefined ? {} : { icon }),
  }) as ManagerContentPluginConfigFormFieldV2['group']
}

function localizedChoices(
  value: unknown,
  node: SchemaNode,
  label: string,
): readonly ManagerContentPluginConfigLocalizedChoiceV2[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new Error(`${label} must contain 1 to 100 choices`)
  }
  const expected = choices(node)?.map(choice => choice.value)
  if (expected === undefined || expected.length === 0) throw new Error(`${label} requires a finite scalar enum field`)
  const result: ManagerContentPluginConfigLocalizedChoiceV2[] = []
  for (const [index, item] of value.entries()) {
    const choice = objectValue(item, `${label}[${index}]`)
    assertOnlyKeys(choice, ['value', 'label'], `${label}[${index}]`)
    if (!Object.hasOwn(choice, 'value')) throw new Error(`${label}[${index}].value is required`)
    const scalar = scalarValue(choice.value, `${label}[${index}].value`)
    if (result.some(candidate => sameScalar(candidate.value as CordisXJsonScalar, scalar))) {
      throw new Error(`${label} contains a duplicate value`)
    }
    assertLocalizedText(choice.label, `${label}[${index}].label`)
    if (choice.label.params !== undefined && Object.keys(choice.label.params).length > 32) {
      throw new Error(`${label}[${index}].label.params has too many fields`)
    }
    if (
      typeof choice.label.fallback !== 'string' || choice.label.fallback.trim() === ''
      || choice.label.fallback.length > 4000
    ) {
      throw new Error(`${label}[${index}].label.fallback is required`)
    }
    result.push(immutable({ value: scalar, label: choice.label }) as ManagerContentPluginConfigLocalizedChoiceV2)
  }
  if (
    result.length !== expected.length
    || expected.some(candidate => !result.some(choice => sameScalar(choice.value as CordisXJsonScalar, candidate)))
  ) {
    throw new Error(`${label} must exactly cover the field scalar enum`)
  }
  return Object.freeze(result)
}

function managerContentFormPresentationV2(
  schema: SchemaNode | undefined,
): ManagerContentPluginConfigFormPresentationV2 | undefined {
  const value = schema?.meta?.extra?.cordisxForm
  if (value === undefined) return undefined
  const root = objectValue(value, 'manager config form presentation')
  if (root.version !== 2) throw new Error('manager config form presentation has an unsupported version')
  assertOnlyKeys(root, ['version', 'fields', 'actions'], 'manager config form presentation')
  if (!Array.isArray(root.fields) || root.fields.length > 100) {
    throw new Error('manager config form presentation fields are invalid')
  }
  const seenPaths = new Set<string>()
  const projected: ManagerContentPluginConfigFormFieldV2[] = []
  for (const [index, item] of root.fields.entries()) {
    const field = objectValue(item, `manager config form field ${index}`)
    assertOnlyKeys(field, ['path', 'icon', 'group', 'presenter', 'choices'], `manager config form field ${index}`)
    assertPath(field.path as CordisXConfigFieldPath)
    const path = field.path as CordisXConfigFieldPath
    const pathKey = JSON.stringify(path)
    if (seenPaths.has(pathKey)) {
      throw new Error(`manager config form presentation has duplicate field path ${path.join('.')}`)
    }
    seenPaths.add(pathKey)
    const node = schemaNodeAtPath(schema, path)
    if (node === undefined) {
      throw new Error(`manager config form field path ${path.join('.')} is not in the Schemastery schema`)
    }
    const icon = field.icon === undefined ? undefined : formIcon(field.icon)
    if (field.icon !== undefined && icon === undefined) {
      throw new Error(`manager config form field ${path.join('.')} icon is invalid`)
    }
    const group = normalizedFormGroup(field.group)
    const presenter = field.presenter === undefined
      ? undefined
      : normalizedFormPresenter(field.presenter, `manager config form field ${path.join('.')} presenter`)
    const fieldChoices = localizedChoices(field.choices, node, `manager config form field ${path.join('.')} choices`)
    projected.push(immutable({
      path,
      ...(icon === undefined ? {} : { icon }),
      ...(group === undefined ? {} : { group }),
      ...(presenter === undefined ? {} : { presenter }),
      ...(fieldChoices === undefined ? {} : { choices: fieldChoices }),
    }) as ManagerContentPluginConfigFormFieldV2)
  }
  let actions: ManagerContentPluginConfigFormPresentationV2['actions']
  if (root.actions !== undefined) {
    const rawActions = objectValue(root.actions, 'manager config form actions')
    assertOnlyKeys(rawActions, ['save', 'reset'], 'manager config form actions')
    const save = rawActions.save === undefined ? undefined : formIcon(rawActions.save)
    const reset = rawActions.reset === undefined ? undefined : formIcon(rawActions.reset)
    if (
      (rawActions.save !== undefined && save === undefined) || (rawActions.reset !== undefined && reset === undefined)
    ) {
      throw new Error('manager config form actions contain an invalid icon')
    }
    actions = { ...(save === undefined ? {} : { save }), ...(reset === undefined ? {} : { reset }) }
  }
  return immutable({ version: 2, fields: projected, ...(actions === undefined ? {} : { actions }) })
}

function arrayChoices(
  schema: SchemaNode | undefined,
  locale: string,
): readonly { readonly label: string; readonly value: CordisXJsonScalar }[] | undefined {
  const literalChoices = schema === undefined ? undefined : choices(schema)
  if (literalChoices !== undefined) return literalChoices
  if (schema?.type !== 'boolean') return undefined
  const zh = locale.toLowerCase().startsWith('zh')
  return [
    { label: zh ? '开启' : 'Enabled', value: true },
    { label: zh ? '关闭' : 'Disabled', value: false },
  ]
}

const FORM_ICONS = new Set<CordisXConfigFormIcon>([
  'host:calendar',
  'host:clock',
  'host:palette',
  'host:tags',
  'host:folder',
  'host:key',
  'host:settings',
  'host:info',
  'host:files',
  'host:save',
  'host:reset',
])

function formIcon(value: unknown): CordisXConfigFormIcon | undefined {
  return typeof value === 'string' && FORM_ICONS.has(value as CordisXConfigFormIcon)
    ? value as CordisXConfigFormIcon
    : undefined
}

function formGroup(schema: SchemaNode, locale: string): CordisXConfigFormGroupSnapshot | undefined {
  const group = schema.meta?.extra?.cordisxForm?.group
  if (group?.id === undefined || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(group.id)) return undefined
  const title = localizedText(group.title, locale)
  const description = localizedText(group.description, locale)
  const icon = formIcon(group.icon)
  return {
    id: group.id,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(icon === undefined ? {} : { icon }),
  }
}

function actionIcons(schema: SchemaNode | undefined): CordisXConfigFormActionIcons | undefined {
  const actions = schema?.meta?.extra?.cordisxForm?.actions
  const save = formIcon(actions?.save)
  const reset = formIcon(actions?.reset)
  return save === undefined && reset === undefined ? undefined : {
    ...(save === undefined ? {} : { save }),
    ...(reset === undefined ? {} : { reset }),
  }
}

function formPresenter(schema: SchemaNode): CordisXConfigFormPresenter | undefined {
  const normalized = normalizeFormPresentation(schema.meta?.extra?.cordisxForm?.presenter)
  return normalized as CordisXConfigFormPresenter | undefined
}

function formSchemaNode(schema: SchemaNode, locale: string): CordisXConfigFormSchemaNode {
  const role = schema.meta?.role
  const sensitive = role !== undefined && isReservedConfigRole(role)
  const hasDefault = Object.hasOwn(schema.meta ?? {}, 'default') && !sensitive
  const label = localizedText(schema.meta?.extra?.label, locale)
  const description = localizedText(schema.meta?.description, locale)
  const fieldChoices = choices(schema)
  const nestedArrayChoices = schema.type === 'array' ? arrayChoices(schema.inner, locale) : undefined
  const nodeChoices = fieldChoices ?? nestedArrayChoices
  const arrayItemType =
    schema.type === 'array' && ['string', 'number', 'natural', 'boolean'].includes(schema.inner?.type ?? '')
      ? schema.inner?.type as 'string' | 'number' | 'natural' | 'boolean'
      : undefined
  const nested = schema.type === 'object' && schema.dict !== undefined
    ? Object.entries(schema.dict).map(([key, child]) => ({ key, schema: formSchemaNode(child, locale) }))
    : undefined
  const item = schema.type === 'array' && schema.inner !== undefined ? formSchemaNode(schema.inner, locale) : undefined
  const presenter = formPresenter(schema)
  return {
    type: schema.type ?? 'unknown',
    ...(role === undefined ? {} : { role }),
    ...(label === undefined ? {} : { label }),
    ...(description === undefined ? {} : { description }),
    ...(hasDefault ? { hasDefault: true, defaultValue: immutable(schema.meta?.default) as CordisXJsonValue } : {}),
    disabled: schema.meta?.disabled === true,
    required: schema.meta?.required === true,
    ...(schema.meta?.min === undefined ? {} : { min: schema.meta.min }),
    ...(schema.meta?.max === undefined ? {} : { max: schema.meta.max }),
    ...(schema.meta?.step === undefined ? {} : { step: schema.meta.step }),
    ...(nodeChoices === undefined ? {} : { choices: nodeChoices }),
    ...(arrayItemType === undefined ? {} : { arrayItemType }),
    ...(presenter === undefined ? {} : { presenter }),
    ...(nested === undefined ? {} : { fields: nested }),
    ...(item === undefined ? {} : { item }),
  }
}

function fields(
  schema: SchemaNode | undefined,
  raw: unknown,
  resolved: unknown,
  namespace: string,
  locale: string,
  path: CordisXConfigFieldPath = [],
): CordisXConfigFieldSnapshot[] {
  if (schema === undefined || schema.meta?.hidden === true) return []
  if (schema.type === 'object' && schema.dict !== undefined) {
    return Object.entries(schema.dict).flatMap(([key, child]) =>
      fields(child, raw, resolved, namespace, locale, [...path, key])
    )
  }
  if (path.length === 0) return []
  const role = schema.meta?.role
  const sensitive = role !== undefined && isReservedConfigRole(role)
  const label = localizedText(schema.meta?.extra?.label, locale)
  const description = localizedText(schema.meta?.description, locale)
  const fieldChoices = choices(schema)
  const nestedArrayChoices = schema.type === 'array' ? arrayChoices(schema.inner, locale) : undefined
  const fieldOptions = fieldChoices ?? nestedArrayChoices
  const arrayItemType =
    schema.type === 'array' && ['string', 'number', 'natural', 'boolean'].includes(schema.inner?.type ?? '')
      ? schema.inner?.type as 'string' | 'number' | 'natural' | 'boolean'
      : undefined
  const icon = formIcon(schema.meta?.extra?.cordisxForm?.icon)
  const group = formGroup(schema, locale)
  const presenter = formPresenter(schema)
  const arrayItemSchema = schema.type === 'array' && schema.inner?.type === 'object'
    ? formSchemaNode(schema.inner, locale)
    : undefined
  const arrayItemDefault = arrayItemSchema === undefined ? undefined : formSchemaDefaultValue(arrayItemSchema)
  const hasDefault = Object.hasOwn(schema.meta ?? {}, 'default')
  const defaultValue = hasDefault && !sensitive ? immutable(ownValue(resolved, path)) : undefined
  return [{
    namespace,
    path,
    type: schema.type ?? 'unknown',
    ...(role === undefined ? {} : { role }),
    ...(label === undefined ? {} : { label }),
    ...(description === undefined ? {} : { description }),
    value: sensitive ? undefined : immutable(hasOwnPath(raw, path) ? ownValue(raw, path) : ownValue(resolved, path)),
    ...(hasDefault ? { hasDefault: true } : {}),
    ...(hasDefault && !sensitive ? { defaultValue } : {}),
    disabled: schema.meta?.disabled === true || sensitive,
    required: schema.meta?.required === true,
    ...(schema.meta?.min === undefined ? {} : { min: schema.meta.min }),
    ...(schema.meta?.max === undefined ? {} : { max: schema.meta.max }),
    ...(schema.meta?.step === undefined ? {} : { step: schema.meta.step }),
    ...(fieldOptions === undefined ? {} : { choices: fieldOptions }),
    ...(arrayItemType === undefined ? {} : { arrayItemType }),
    ...(presenter === undefined ? {} : { presenter }),
    ...(arrayItemSchema === undefined ? {} : { arrayItemSchema }),
    ...(arrayItemDefault === undefined ? {} : { arrayItemDefault }),
    ...(icon === undefined ? {} : { icon }),
    ...(group === undefined ? {} : { group }),
  }]
}

export { actionIcons, fields, localizedText, managerContentFormPresentationV2 }
