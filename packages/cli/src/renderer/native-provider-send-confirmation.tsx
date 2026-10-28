import { flushSync } from 'react-dom'
import { HostDialog, HostDialogAction } from './host-ui/HostDialog.js'
import { modelProviderCopy } from './model-provider-copy.js'
import type { ProviderSelectionTransport } from './model-provider-selector.js'
import type { NativeProviderSubmitConfirmation } from './native-provider-selection-client.js'

/** The existing submit admission owns this dialog's exact selection revision. */
export function NativeProviderSendConfirmation({ transport, confirmation, locale, provider, model }: {
  transport: ProviderSelectionTransport
  confirmation: NativeProviderSubmitConfirmation | undefined
  locale: string
  provider: string
  model: string
}) {
  const copy = modelProviderCopy(locale)
  const finish = (confirmed: boolean) => {
    // Remove the modal isolation before admission resumes its native control read.
    flushSync(() => transport.confirmSubmission?.(confirmed))
  }
  return (
    <HostDialog
      open={confirmation !== undefined}
      className="cxmp-confirm"
      title={copy.confirmSwitch}
      description={`${provider} / ${model}`}
      onClose={() => finish(false)}
      actions={
        <>
          <HostDialogAction onClick={() => finish(false)}>{copy.cancel}</HostDialogAction>
          <HostDialogAction variant="primary" onClick={() => finish(true)}>{copy.confirmSend}</HostDialogAction>
        </>
      }
    />
  )
}
