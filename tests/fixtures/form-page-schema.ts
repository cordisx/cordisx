import Schema from '@deepseek-ai/schemastery'
import { fields } from '../../packages/cli/src/renderer/configuration/form-presentation.js'
import type { SchemaNode } from '../../packages/cli/src/renderer/configuration/model.js'

function item(depth: number): Schema<any> {
  return Schema.object({
    name: Schema.string().default(''),
    choice: Schema.union(['one', 'two']).default('one'),
    ...Object.fromEntries(Array.from({ length: 18 }, (_, index) => [`detail${index}`, Schema.string().default('')])),
    ...(depth === 0 ? {} : {
      children: Schema.array(item(depth - 1)).default([]).extra('extra', {
        cordisxForm: { presenter: { version: 1, kind: 'array.object-page' } },
      }),
    }),
  })
}

export const formPageSchema = Schema.object({
  name: Schema.string().default('initial'),
  ...Object.fromEntries(Array.from({ length: 18 }, (_, index) => [`detail${index}`, Schema.string().default('')])),
  items: Schema.array(item(2)).default([]).extra('extra', {
    cordisxForm: { presenter: { version: 1, kind: 'array.object-page' } },
  }),
})
export const formPageValue = { name: 'initial', items: [] }
export const formPageFields = () =>
  fields(formPageSchema as SchemaNode, formPageValue, formPageValue, 'fixture', 'zh-CN')
