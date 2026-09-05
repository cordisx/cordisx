import { describe, expect, it } from 'vitest'
import {
  FormDraft,
  normalizeFormDescriptor,
  normalizeFormPresentation,
  resolveFormPresenter,
  validateFormValue,
} from '../packages/schemastery-ui/src/index.js'

describe('@cordisx/schemastery-ui', () => {
  it('normalizes only the closed v1 presenter vocabulary', () => {
    expect(
      normalizeFormPresentation({
        version: 1,
        kind: 'choice.segmented',
        options: { density: 'compact', maxInlineItems: 4 },
      }),
    ).toEqual({
      version: 1,
      kind: 'choice.segmented',
      options: { density: 'compact', maxInlineItems: 4 },
    })
    expect(normalizeFormPresentation({ version: 2, kind: 'choice.segmented' })).toBeUndefined()
    expect(normalizeFormPresentation({ version: 1, kind: 'plugin.dom', options: { className: 'unsafe' } }))
      .toBeUndefined()
  })

  it('uses one catalog decision for compatible presenters and a deterministic fallback otherwise', () => {
    const segmented = resolveFormPresenter({
      path: ['approval'],
      type: 'string',
      choices: [{ label: 'Manual', value: 'manual' }],
      presentation: { version: 1, kind: 'choice.segmented' },
    })
    expect(segmented).toMatchObject({ primitive: 'radio', layout: 'compact' })
    const incompatible = resolveFormPresenter({
      path: ['title'],
      type: 'string',
      presentation: { version: 1, kind: 'number.slider' },
    })
    expect(incompatible).toMatchObject({ primitive: 'input', diagnostic: { code: 'unsupported-presenter' } })
  })

  it('normalizes recursive descriptors without transporting renderer authority', () => {
    const descriptor = normalizeFormDescriptor({
      type: 'array',
      item: { type: 'object', fields: [{ key: 'title', type: 'string', label: 'Title' }] },
      presentation: { version: 1, kind: 'array.object-dialog' },
      renderer: '<unsafe>',
    }, ['rules'])
    expect(descriptor).toMatchObject({
      path: ['rules'],
      type: 'array',
      item: { type: 'object', fields: [{ path: ['rules', '*', 'title'] }] },
      presentation: { version: 1, kind: 'array.object-dialog' },
    })
    expect(JSON.stringify(descriptor)).not.toContain('unsafe')
  })

  it('keeps nested presenters in one draft transaction and exposes copy-free validation codes', () => {
    const draft = new FormDraft({ 'rules.opaque-id.title': 'Saved' })
    draft.set(['rules', 'opaque-id', 'title'], 'Draft')
    expect(draft.isDirty(['rules', 'opaque-id', 'title'])).toBe(true)
    expect(draft.value(['rules', 'opaque-id', 'title'])).toBe('Draft')
    draft.rollback(['rules', 'opaque-id', 'title'])
    expect(draft.value(['rules', 'opaque-id', 'title'])).toBe('Saved')
    draft.unset(['rules', 'opaque-id', 'title'])
    expect(draft.value(['rules', 'opaque-id', 'title'], 'Default')).toBe('Default')
    expect(validateFormValue({ path: ['count'], type: 'number', required: true, min: 1, max: 4 }, 7)).toEqual([{
      code: 'range',
    }])
    expect(validateFormValue({ path: ['name'], type: 'string', min: 3, max: 8 }, 'ab')).toEqual([{ code: 'length' }])
    expect(validateFormValue({ path: ['name'], type: 'string', min: 3, max: 8 }, 'valid')).toEqual([])
  })

  it('validates bounded array choices item by item instead of treating the array as a scalar choice', () => {
    const field = {
      path: ['audiences'],
      type: 'array' as const,
      itemType: 'string' as const,
      choices: [{ label: 'Design', value: 'design' }, { label: 'Research', value: 'research' }],
    }
    expect(validateFormValue(field, ['design', 'research'])).toEqual([])
    expect(validateFormValue(field, ['design', 'unknown'])).toEqual([{ code: 'choice' }])
  })
})
