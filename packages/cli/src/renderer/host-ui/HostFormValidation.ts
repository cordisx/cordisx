import { type FormDescriptor, validateFormValue } from '@cordisx/schemastery-ui'
import type { CordisXConfigFieldSnapshot } from '../../contracts.js'
import { managerCopy, productLocale } from '../ui-copy.js'

/** Invalid text stays in the draft so validation can reject it without losing the user's entry. */
export function hostFormTagValues(
  itemType: string | undefined,
  values: readonly (string | number)[],
): readonly unknown[] {
  return values.map(value => {
    const text = String(value)
    if (itemType === 'string') return text
    if (itemType === 'boolean') {
      if (text.trim() === 'true') return true
      if (text.trim() === 'false') return false
      return text
    }
    if ((itemType === 'number' || itemType === 'natural') && text.trim() !== '') {
      const number = Number(text)
      if (Number.isFinite(number)) return number
    }
    return value
  })
}

/** Host validation supplements schema constraints with the supported role formats. */
export function hostFormValidationIssueText(
  field: CordisXConfigFieldSnapshot,
  value: unknown,
  locale: string,
): string | undefined {
  const empty = value === undefined || value === null || value === '' || Array.isArray(value) && value.length === 0
  if (field.required && empty) return managerCopy(locale, 'form.required')
  if (value === undefined || value === null || value === '') return undefined
  if (field.type === 'object' && typeof value === 'string') return managerCopy(locale, 'form.json-invalid')
  if (
    field.type === 'array' && Array.isArray(value) && value.some(item => {
      if (field.arrayItemType === 'string' || field.arrayItemType === 'boolean') {
        return typeof item !== field.arrayItemType
      }
      if (field.arrayItemType === 'number' || field.arrayItemType === 'natural') {
        return typeof item !== 'number' || !Number.isFinite(item)
          || field.arrayItemType === 'natural' && (!Number.isInteger(item) || item < 0)
      }
      return false
    })
  ) return managerCopy(locale, 'form.array-invalid')
  const chinese = productLocale(locale) === 'zh-CN'
  if (field.type === 'number' || field.type === 'natural') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return managerCopy(locale, 'form.number-invalid')
    if (field.type === 'natural' && (!Number.isInteger(value) || value < 0)) {
      return managerCopy(locale, 'form.natural-invalid')
    }
    if (field.min !== undefined && value < field.min) {
      return chinese
        ? `不能小于 ${field.min}`
        : `Must be at least ${field.min}`
    }
    if (field.max !== undefined && value > field.max) {
      return chinese
        ? `不能大于 ${field.max}`
        : `Must be at most ${field.max}`
    }
    if (field.step !== undefined && field.step > 0) {
      const steps = (value - (field.min ?? 0)) / field.step
      if (Math.abs(steps - Math.round(steps)) > 1e-9) {
        return chinese
          ? `请按 ${field.step} 的步长输入`
          : `Use increments of ${field.step}`
      }
    }
  }
  if (field.role === 'date' && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value))) {
    return chinese ? '请输入有效日期' : 'Enter a valid date'
  }
  if (
    field.role === 'datetime'
    && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u.test(value))
  ) {
    return chinese ? '请输入有效日期和时间' : 'Enter a valid date and time'
  }
  if (field.role === 'time' && (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value))) {
    return chinese ? '请输入有效时间' : 'Enter a valid time'
  }
  if (field.role === 'color' && (typeof value !== 'string' || !/^#[\da-fA-F]{6}$/u.test(value))) {
    return chinese ? '请输入有效 HEX 颜色' : 'Enter a valid HEX color'
  }
  const issue = validateFormValue({
    ...field,
    type: field.type as FormDescriptor['type'],
    ...(field.arrayItemType === undefined ? {} : { itemType: field.arrayItemType }),
  }, value)[0]
  if (issue?.code === 'required') return managerCopy(locale, 'form.required')
  if (issue?.code === 'choice') return managerCopy(locale, 'form.choice-invalid')
  if (issue?.code === 'length') return managerCopy(locale, 'form.string-length-invalid')
  if (issue?.code === 'array') {
    if (Array.isArray(value)) {
      if (field.min !== undefined && value.length < field.min) {
        return chinese
          ? `至少选择 ${field.min} 项`
          : `Choose at least ${field.min}`
      }
      if (field.max !== undefined && value.length > field.max) {
        return chinese
          ? `最多选择 ${field.max} 项`
          : `Choose at most ${field.max}`
      }
    }
    return managerCopy(locale, 'form.array-invalid')
  }
  return undefined
}
