import { useLayoutEffect, useRef } from 'react'
import type { ModelBrandChoice, ProviderBrandChoice } from '../../model-selector-branding.js'
import { resolveHostTheme } from '../host-theme.js'
import { HostIcon } from './HostIcon.js'

import awsBedrock from '../../../assets/model-brands/aws-bedrock.svg'
import azureFoundry from '../../../assets/model-brands/azure-foundry.svg'
import azureOpenai from '../../../assets/model-brands/azure-openai.svg'
import cerebras from '../../../assets/model-brands/cerebras.png'
import claude from '../../../assets/model-brands/claude.svg'
import dashscope from '../../../assets/model-brands/dashscope.svg'
import deepseek from '../../../assets/model-brands/deepseek.svg'
import fireworks from '../../../assets/model-brands/fireworks.svg'
import gemini from '../../../assets/model-brands/gemini.png'
import googleVertex from '../../../assets/model-brands/google-vertex.svg'
import huggingface from '../../../assets/model-brands/huggingface.svg'
import kimiDark from '../../../assets/model-brands/kimi-dark.svg'
import kimiLight from '../../../assets/model-brands/kimi-light.svg'
import minimaxDark from '../../../assets/model-brands/minimax-dark.svg'
import minimaxLight from '../../../assets/model-brands/minimax-light.svg'
import moonshotDark from '../../../assets/model-brands/moonshot-dark.svg'
import moonshotLight from '../../../assets/model-brands/moonshot-light.svg'
import opencodeDark from '../../../assets/model-brands/opencode-dark.svg'
import opencodeLight from '../../../assets/model-brands/opencode-light.svg'
import openai from '../../../assets/model-brands/openai.svg'
import openrouterDark from '../../../assets/model-brands/openrouter-dark.svg'
import openrouterLight from '../../../assets/model-brands/openrouter-light.svg'
import siliconflow from '../../../assets/model-brands/siliconflow.png'
import together from '../../../assets/model-brands/together.svg'
import xaiDark from '../../../assets/model-brands/xai-dark.svg'
import xaiLight from '../../../assets/model-brands/xai-light.svg'
import zaiDark from '../../../assets/model-brands/zai-dark.svg'
import zaiLight from '../../../assets/model-brands/zai-light.svg'

type BrandChoice = ProviderBrandChoice | ModelBrandChoice
type BrandAsset = string | Readonly<{ light: string; dark: string }>

const assets: Readonly<Partial<Record<BrandChoice, BrandAsset>>> = Object.freeze({
  'aws-bedrock': awsBedrock,
  'azure-foundry': azureFoundry,
  'azure-openai': azureOpenai,
  cerebras,
  claude,
  dashscope,
  deepseek,
  fireworks,
  gemini,
  'google-vertex': googleVertex,
  huggingface,
  kimi: { light: kimiLight, dark: kimiDark },
  minimax: { light: minimaxLight, dark: minimaxDark },
  moonshot: { light: moonshotLight, dark: moonshotDark },
  opencode: { light: opencodeLight, dark: opencodeDark },
  openai,
  openrouter: { light: openrouterLight, dark: openrouterDark },
  siliconflow,
  together,
  xai: { light: xaiLight, dark: xaiDark },
  zai: { light: zaiLight, dark: zaiDark },
})

function dataUrl(source: string): string {
  return source.startsWith('<svg') ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}` : source
}

export function ModelBrandIcon({ brand, kind }: {
  readonly brand: BrandChoice | undefined
  readonly kind: 'provider' | 'model'
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const asset = brand === undefined || brand === 'generic' ? undefined : assets[brand]
  useLayoutEffect(() => {
    const icon = ref.current
    if (icon === null || asset === undefined) return
    const select = () => {
      const root = icon.closest<HTMLElement>('[data-cordisx-app-theme]')
      const projected = root?.dataset.cordisxAppTheme
      const theme = projected === 'dark' || projected === 'light'
        ? projected
        : resolveHostTheme(icon.ownerDocument).theme
      const source = typeof asset === 'string' ? asset : asset[theme]
      const image = icon.querySelector('img')
      if (image !== null) image.src = dataUrl(source)
    }
    select()
    const root = icon.closest<HTMLElement>('[data-cordisx-app-theme]') ?? icon.ownerDocument.documentElement
    const Observer = icon.ownerDocument.defaultView?.MutationObserver
    if (Observer === undefined) return
    const observer = new Observer(select)
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['class', 'data-cordisx-app-theme', 'data-theme', 'data-color-theme', 'data-color-scheme'],
    })
    return () => observer.disconnect()
  }, [asset])
  if (asset === undefined) return <HostIcon token={kind === 'provider' ? 'action.settings' : 'agent.reasoning'} />
  return (
    <span ref={ref} className="cordisx-host-icon cxmp-brand-icon" data-selector-brand={brand} aria-hidden="true">
      <img src={dataUrl(typeof asset === 'string' ? asset : asset.light)} alt="" aria-hidden="true" draggable={false} />
    </span>
  )
}
