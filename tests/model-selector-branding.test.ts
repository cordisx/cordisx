import { describe, expect, it } from 'vitest'
import {
  inferModelBrand,
  inferProviderBrand,
  providerBrandFromUrl,
} from '../packages/cli/src/model-selector-branding.js'

describe('model selector branding', () => {
  it.each(
    [
      ['https://api.openai.com/v1', 'openai'],
      ['https://api.anthropic.com/v1', 'anthropic'],
      ['https://openrouter.ai/api/v1', 'openrouter'],
      ['https://opencode.ai/zen/go/v1/messages', 'opencode'],
      ['https://opencode.ai/zen/v1/responses', 'opencode'],
      ['https://bedrock-mantle.us-east-1.api.aws/v1', 'aws-bedrock'],
      ['https://r.openai.azure.com/openai/v1', 'azure-openai'],
      ['https://r.services.ai.azure.com/openai/v1', 'azure-foundry'],
      ['https://us-central1-aiplatform.googleapis.com/v1/projects/p', 'google-vertex'],
      ['https://generativelanguage.googleapis.com/v1beta', 'gemini'],
      ['https://router.huggingface.co/v1/chat/completions', 'huggingface'],
      ['https://ark.cn-beijing.volces.com/api/v3', 'ark'],
      ['https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'dashscope'],
    ] as const,
  )('recognizes an exact structured endpoint %s', (url, brand) => {
    expect(providerBrandFromUrl(url)).toBe(brand)
  })

  it.each([
    'https://api.openai.com.evil.example/v1',
    'https://api.openai.com@evil.example/v1',
    'https://example@api.openai.com/v1',
    'https://api.openai.com.:443/v1',
    'https://api.openai.com:8443/v1',
    'https://openrouter.ai/api/v1evil',
    'https://openrouter.ai/API/v1',
    'https://opencode.ai/zen/gopher/v1',
    'https://proxy.example/?target=https://api.openai.com/v1',
    'https://other.us-east-1.api.aws/v1',
  ])('rejects malformed, spoofed or over-broad endpoint %s', url => {
    expect(providerBrandFromUrl(url)).toBeUndefined()
  })

  it('uses the structured endpoint before bounded name aliases', () => {
    expect(inferProviderBrand({ baseUrl: 'https://openrouter.ai/api/v1', title: 'OpenAI' })).toBe('openrouter')
    expect(inferProviderBrand({ providerId: 'private', title: 'Moonshot AI' })).toBe('moonshot')
    expect(inferProviderBrand({ providerId: 'private-openai-proxy' })).toBeUndefined()
  })

  it.each(
    [
      ['openai/gpt-5.6', 'Gateway label', 'openai'],
      ['anthropic:claude-sonnet-4', 'Other', 'claude'],
      ['google/gemini-2.5-pro', 'Other', 'gemini'],
      ['moonshotai/kimi-k2.5', 'Other', 'kimi'],
      ['x-ai/grok-4', 'Other', 'xai'],
      ['z-ai/glm-5', 'Other', 'zai'],
    ] as const,
  )('uses exact or namespaced model identity before label for %s', (id, label, brand) => {
    expect(inferModelBrand(id, label)).toBe(brand)
  })

  it('uses a display name only when the id carries no stronger identity', () => {
    expect(inferModelBrand('model-42', 'Claude Sonnet 4')).toBe('claude')
    expect(inferModelBrand('openai/custom', 'Claude Sonnet 4')).toBeUndefined()
    expect(inferModelBrand('deployment-west', 'GPT 5')).toBeUndefined()
    expect(inferModelBrand('private', 'Unknown')).toBeUndefined()
  })
})
