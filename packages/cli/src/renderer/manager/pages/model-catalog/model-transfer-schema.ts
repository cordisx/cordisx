import type { SchemaFormSourceV1 } from '@cordisx/protocol/schema-form/v1'
import Schema from '@deepseek-ai/schemastery'

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u
const WITHOUT_NUL = /^[^\0]*$/u

const labels = (en: string, zh: string) => ({ en, 'zh-CN': zh })

function variableSchema(includeEnabled: boolean, includeGenerator = false) {
  return Schema.object({
    name: Schema.string().required().max(128).pattern(ENVIRONMENT_NAME)
      .extra('extra', { label: labels('Name', '名称') }),
    value: Schema.string().max(16_384).pattern(WITHOUT_NUL).role('password')
      .extra('extra', { label: labels('Value', '值') }),
    description: Schema.string().max(512).pattern(WITHOUT_NUL)
      .extra('extra', { label: labels('Description', '描述') }),
    ...(includeGenerator
      ? {
        generatorScript: Schema.string().max(16_384).pattern(WITHOUT_NUL).role('textarea')
          .extra('extra', {
            label: labels('Shell generator', 'Shell 生成脚本'),
            description: labels(
              'Runs locally through /bin/sh. It is not sandboxed and may have side effects.',
              '脚本通过本机 /bin/sh 运行，不受沙箱保护，可能产生副作用。',
            ),
          }),
      }
      : {}),
    ...(includeEnabled
      ? {
        enabled: Schema.boolean().default(true)
          .extra('extra', { label: labels('Enabled', '启用') }),
      }
      : {}),
  })
}

function variablesSchema(includeEnabled: boolean, includeGenerator = false) {
  return Schema.array(variableSchema(includeEnabled, includeGenerator)).default([]).max(128).extra('extra', {
    label: labels('Environment variables', '环境变量'),
    cordisxForm: {
      presenter: {
        version: 1,
        kind: 'array.object-page',
        options: { allowReorder: false },
      },
    },
  })
}

function formSchema(schema: unknown): SchemaFormSourceV1 {
  return schema as SchemaFormSourceV1
}

export const modelTransferExportVariablesSchema = formSchema(Schema.object({
  variables: variablesSchema(false),
  includeValues: Schema.boolean().default(false)
    .extra('extra', {
      label: labels('Include values (exported text is not encrypted)', '包含变量值（导出文本未加密）'),
    }),
}))

export const modelTransferExportWithoutVariablesSchema = formSchema(Schema.object({}))

export const modelTransferImportSchema = formSchema(Schema.object({
  variables: variablesSchema(true, true),
}))

export const modelTransferEnvironmentSchema = formSchema(Schema.object({
  variables: variablesSchema(true),
}))
