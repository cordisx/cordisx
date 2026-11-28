import { Button } from 'tdesign-react'
import { managerCopy } from '../ui-copy.js'

/** Keep the original draft visible until a newer configuration is reviewed. */
export function HostFormMessage(input: {
  readonly locale: string
  readonly message?: string | undefined
  readonly saved: boolean
  readonly incompatible: boolean
  readonly review?: { readonly enabled: boolean; readonly run: () => void } | undefined
}) {
  if (input.message === undefined) return null
  return (
    <div className="cxr-notice cxf-alert" data-tone={input.saved ? 'info' : 'error'} role="status">
      {input.message}
      {!input.incompatible ? null : <p>{managerCopy(input.locale, 'form.conflict-incompatible')}</p>}
      {input.review === undefined ? null : (
        <>
          <Button
            tag="button"
            type="button"
            variant="outline"
            disabled={!input.review.enabled}
            onClick={input.review.run}
          >
            {managerCopy(input.locale, 'form.review-latest')}
          </Button>
        </>
      )}
    </div>
  )
}
