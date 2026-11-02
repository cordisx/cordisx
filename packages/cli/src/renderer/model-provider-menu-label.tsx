import { useRef } from 'react'
import type { ModelProviderV1 } from '@cordisx/protocol/model-providers/v1'
export function providerMenuLabel(provider: Pick<ModelProviderV1, 'providerId' | 'title'>): string {
  if (provider.providerId === 'modelhub' && provider.title === 'ModelHub (Native Direct)') return 'ModelHub'
  if (provider.providerId === 'openrouter' && provider.title === 'OpenRouter (Native Responses)') return 'OpenRouter'
  return provider.title ?? provider.providerId
}

export function ProviderMenuLabel({ provider }: { readonly provider: Pick<ModelProviderV1, 'providerId' | 'title'> }) {
  const label = providerMenuLabel(provider)
  const viewport = useRef<HTMLSpanElement>(null)
  const text = useRef<HTMLSpanElement>(null)
  const measureOverflow = () => {
    const viewportNode = viewport.current
    const textNode = text.current
    if (viewportNode === null || textNode === null) return
    const overflow = Math.max(0, textNode.scrollWidth - viewportNode.clientWidth)
    viewportNode.dataset.overflow = overflow > 0 ? 'true' : 'false'
    viewportNode.style.setProperty('--cxmp-label-overflow', `${overflow}px`)
  }
  return (
    <span
      ref={viewport}
      className="cxmp-provider-label"
      title={label}
      onMouseEnter={measureOverflow}
      onMouseLeave={measureOverflow}
    >
      <span ref={text} className="cxmp-provider-label-text">{label}</span>
    </span>
  )
}
