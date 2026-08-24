import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'

export const Config = Schema.object({
  endpoint: Schema.string().default('local').description('Service endpoint'),
})

export const configApplies = 'service-restart'

export function apply(_ctx: Context, _config: { endpoint: string }): void {}
