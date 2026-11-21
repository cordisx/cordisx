import { Button } from 'tdesign-react'
import { managerCopy } from '../ui-copy.js'
import { HostSurfaceIcon } from './HostSurfaceIcon.js'

export type HostFormState = 'pristine' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error'

export function HostFormActions(input: {
  readonly locale: string
  readonly state: HostFormState
  readonly visibleState: HostFormState
  readonly dirty: boolean
  readonly saving: boolean
  readonly writable: boolean
  readonly stale: boolean
  readonly undo: () => void
}) {
  return (
    <div className="cxf-form-actions">
      <div className="cxf-status" data-state={input.visibleState} role="status">
        {!input.dirty || input.state === 'saved'
          ? ''
          : input.state === 'saving'
          ? managerCopy(input.locale, 'form.saving')
          : `${managerCopy(input.locale, 'form.dirty-prefix')} · ${managerCopy(input.locale, 'form.apply-live')}`}
      </div>
      <div className="cxf-form-action-buttons">
        <Button
          tag="button"
          type="reset"
          variant="outline"
          icon={<HostSurfaceIcon token="host:reset" />}
          disabled={input.saving || !input.dirty || input.state === 'saved'}
          onClick={input.undo}
        >
          {managerCopy(input.locale, 'form.undo-changes')}
        </Button>
        <Button
          tag="button"
          type="submit"
          theme="primary"
          icon={<HostSurfaceIcon token="host:save" />}
          loading={input.saving}
          disabled={input.saving || !input.writable || !input.dirty || input.state === 'saved' || input.stale}
        >
          {managerCopy(input.locale, 'form.save-configuration')}
        </Button>
      </div>
    </div>
  )
}
