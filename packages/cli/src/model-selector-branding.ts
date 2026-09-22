export const PROVIDER_BRAND_KEYS = [
  'anthropic',
  'ark',
  'aws-bedrock',
  'azure-foundry',
  'azure-openai',
  'cerebras',
  'dashscope',
  'deepseek',
  'fireworks',
  'gemini',
  'google-vertex',
  'groq',
  'huggingface',
  'minimax',
  'mistral',
  'moonshot',
  'opencode',
  'openai',
  'openrouter',
  'siliconflow',
  'together',
  'xai',
  'zai',
  'zhipu',
] as const

export const MODEL_BRAND_KEYS = [
  'claude',
  'deepseek',
  'gemini',
  'kimi',
  'minimax',
  'mistral',
  'openai',
  'xai',
  'zai',
] as const

export type ProviderBrandKey = typeof PROVIDER_BRAND_KEYS[number]
export type ModelBrandKey = typeof MODEL_BRAND_KEYS[number]
export type ProviderBrandChoice = ProviderBrandKey | 'generic'
export type ModelBrandChoice = ModelBrandKey | 'generic'

export interface ModelSelectorIconOverrides {
  readonly providers: Readonly<Record<string, ProviderBrandChoice>>
  readonly models: Readonly<Record<string, Readonly<Record<string, ModelBrandChoice>>>>
}

export interface ProviderBrandProjection {
  readonly brand: ProviderBrandChoice
  readonly source: 'inferred' | 'override'
}

export function isProviderBrandChoice(value: unknown): value is ProviderBrandChoice {
  return value === 'generic' || PROVIDER_BRAND_KEYS.includes(value as ProviderBrandKey)
}

export function isModelBrandChoice(value: unknown): value is ModelBrandChoice {
  return value === 'generic' || MODEL_BRAND_KEYS.includes(value as ModelBrandKey)
}

const PROVIDER_ALIASES: Readonly<Record<string, ProviderBrandKey>> = Object.freeze({
  anthropic: 'anthropic',
  bedrock: 'aws-bedrock',
  'amazon bedrock': 'aws-bedrock',
  'aws bedrock': 'aws-bedrock',
  'azure openai': 'azure-openai',
  'microsoft foundry': 'azure-foundry',
  foundry: 'azure-foundry',
  ark: 'ark',
  'volcengine ark': 'ark',
  cerebras: 'cerebras',
  dashscope: 'dashscope',
  deepseek: 'deepseek',
  fireworks: 'fireworks',
  'fireworks ai': 'fireworks',
  groq: 'groq',
  groqcloud: 'groq',
  huggingface: 'huggingface',
  'hugging face': 'huggingface',
  minimax: 'minimax',
  mistral: 'mistral',
  moonshot: 'moonshot',
  'moonshot ai': 'moonshot',
  'opencode go': 'opencode',
  'opencode zen': 'opencode',
  openai: 'openai',
  openrouter: 'openrouter',
  siliconflow: 'siliconflow',
  together: 'together',
  'together ai': 'together',
  vertex: 'google-vertex',
  'vertex ai': 'google-vertex',
  'gemini developer api': 'gemini',
  xai: 'xai',
  'z.ai': 'zai',
  zai: 'zai',
  bigmodel: 'zhipu',
  zhipu: 'zhipu',
})

function normalizedName(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 256 || /[\0\r\n]/u.test(value)) return undefined
  const normalized = value.trim().toLowerCase().replace(/[._-]+/gu, ' ').replace(/\s+/gu, ' ')
  return normalized || undefined
}

const pathPrefix = (pathname: string, prefix: string): boolean =>
  pathname === prefix || pathname.startsWith(`${prefix}/`)

export function providerBrandFromUrl(value: string | undefined): ProviderBrandKey | undefined {
  if (value === undefined || value.length > 4_096 || /[\0\r\n\\]/u.test(value)) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hostname.endsWith('.')) {
    return undefined
  }
  const host = url.hostname.toLowerCase()
  const pathname = url.pathname
  if (host === 'api.openai.com') return 'openai'
  if (host === 'api.anthropic.com') return 'anthropic'
  if (host === 'api.deepseek.com') return 'deepseek'
  if (host === 'api.x.ai') return 'xai'
  if (host === 'api.moonshot.ai' || host === 'api.moonshot.cn') return 'moonshot'
  if (host === 'api.minimax.io' || host === 'api.minimax.cn') return 'minimax'
  if (['api.mistral.ai', 'api.eu.mistral.ai', 'api.us.mistral.ai'].includes(host)) return 'mistral'
  if (host === 'open.bigmodel.cn') return 'zhipu'
  if (host === 'api.z.ai') return 'zai'
  if (host === 'api.together.ai') return 'together'
  if (host === 'api.groq.com') return 'groq'
  if (host === 'api.fireworks.ai' && pathPrefix(pathname, '/inference/v1')) return 'fireworks'
  if (host === 'api.siliconflow.com' || host === 'api.siliconflow.cn') return 'siliconflow'
  if (host === 'api.cerebras.ai') return 'cerebras'
  if (host === 'router.huggingface.co' && pathPrefix(pathname, '/v1')) return 'huggingface'
  if (host === 'openrouter.ai' && pathPrefix(pathname, '/api/v1')) return 'openrouter'
  if (host === 'opencode.ai' && pathPrefix(pathname, '/zen/go/v1')) return 'opencode'
  if (host === 'opencode.ai' && pathPrefix(pathname, '/zen/v1')) return 'opencode'
  if (/^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/u.test(host)) return 'aws-bedrock'
  if (/^bedrock-mantle\.[a-z0-9-]+\.api\.aws$/u.test(host)) return 'aws-bedrock'
  if (/^[a-z0-9-]+-aiplatform\.googleapis\.com$/u.test(host)) return 'google-vertex'
  if (host === 'generativelanguage.googleapis.com') return 'gemini'
  if (/^[a-z0-9-]+\.openai\.azure\.com$/u.test(host) && pathPrefix(pathname, '/openai')) return 'azure-openai'
  if (/^[a-z0-9-]+\.services\.ai\.azure\.com$/u.test(host) && pathPrefix(pathname, '/openai')) {
    return 'azure-foundry'
  }
  if (host === 'ark.cn-beijing.volces.com' && pathPrefix(pathname, '/api/v3')) return 'ark'
  if (
    ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com'].includes(host)
    || host === 'cn-hongkong.dashscope.aliyuncs.com'
    || /^[a-z0-9-]+\.[a-z0-9-]+\.maas\.aliyuncs\.com$/u.test(host)
  ) return 'dashscope'
  return undefined
}

export function inferProviderBrand(input: {
  readonly baseUrl?: string
  readonly providerId?: string
  readonly title?: string
}): ProviderBrandKey | undefined {
  const fromUrl = providerBrandFromUrl(input.baseUrl)
  if (fromUrl !== undefined) return fromUrl
  for (const value of [input.title, input.providerId]) {
    const alias = normalizedName(value)
    if (alias !== undefined && Object.hasOwn(PROVIDER_ALIASES, alias)) return PROVIDER_ALIASES[alias]
  }
  return undefined
}

const MODEL_RULES: readonly [ModelBrandKey, RegExp][] = [
  ['claude', /^(?:anthropic[/:])?claude(?:[-_.]|$)/u],
  ['gemini', /^(?:google[/:])?gemini(?:[-_.]|$)/u],
  ['deepseek', /^(?:deepseek[/:])?deepseek(?:[-_.]|$)/u],
  ['kimi', /^(?:moonshotai[/:]|moonshot[/:])?kimi(?:[-_.]|$)/u],
  ['minimax', /^(?:minimax[/:])?minimax(?:[-_.]|$)/u],
  ['mistral', /^(?:mistralai[/:]|mistral[/:])?(?:mistral|codestral|ministral|pixtral)(?:[-_.]|$)/u],
  ['openai', /^(?:openai[/:])?(?:gpt|o[134])(?:[-_.]|$)/u],
  ['xai', /^(?:x-ai[/:]|xai[/:])?grok(?:[-_.]|$)/u],
  ['zai', /^(?:z-ai[/:]|zai[/:])?glm(?:[-_.]|$)/u],
]

export function inferModelBrand(id: string, displayName?: string): ModelBrandKey | undefined {
  const exact = id.trim().toLowerCase()
  if (!exact || exact.length > 512 || /[\0\r\n\\]/u.test(exact)) return undefined
  for (const [brand, rule] of MODEL_RULES) if (rule.test(exact)) return brand
  if (/[/:]/u.test(exact) || /(?:deployment|endpoint|route|slot|proxy)/u.test(exact)) return undefined
  const label = normalizedName(displayName)?.replace(/ /gu, '-')
  if (label !== undefined) { for (const [brand, rule] of MODEL_RULES) if (rule.test(label)) return brand }
  return undefined
}
