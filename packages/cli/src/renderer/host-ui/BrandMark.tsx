import cordisxMarkDark from '../../../assets/brand/cordisx-mark-dark.svg'
import cordisxMarkLight from '../../../assets/brand/cordisx-mark-light.svg'

const darkUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cordisxMarkDark)}`
const lightUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cordisxMarkLight)}`

/** Host-owned adaptive CordisX mark using the repository's approved artwork. */
export function BrandMark({ className }: { readonly className?: string }) {
  return <span className={['cxr-brand-mark', className].filter(Boolean).join(' ')} aria-hidden="true">
    <img className="cxr-brand-mark-dark" src={darkUri} alt="" draggable={false} />
    <img className="cxr-brand-mark-light" src={lightUri} alt="" draggable={false} />
  </span>
}
