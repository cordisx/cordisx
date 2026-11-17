import { IconButton } from '../../host-ui/IconButton.js'
import type { ManagerRouter } from '../model/routes.js'

/** General chat defaults are a Model services detail, independent of any Channel settings destination. */
export function ChatCreationDefaultsAction({ router, locale }: { router: ManagerRouter; locale: string }) {
  return (
    <IconButton
      icon="turns-control"
      label={locale.startsWith('zh') ? '新建对话默认配置' : 'New chat defaults'}
      data-chat-creation-defaults-action="true"
      onClick={() => router.openDetail({ kind: 'primary', page: 'model-services' }, { kind: 'chat-execution' })}
    />
  )
}
