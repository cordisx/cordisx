import type { Context } from '@deepseek-ai/cordis'
import { createContext, defineReactPage, useContext, useState } from 'cordisx/react'
import { Button, defineDialog, Dialog, DialogProvider, HoverCard, Stack, useDialog } from 'cordisx/ui'
import { CORDISX_PAGE_SCHEMA_V3, CORDISX_PLUGIN_MANIFEST_SCHEMA_V1, CORDISX_ROUTE_SCHEMA_V2 } from 'cordisx/contracts'
export const name = 'dialogs-demo'
export const inject = ['dialogs', 'notifications', 'i18n', 'pages', 'routes', 'slots']
export const manifest = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  schemaVersion: 1,
  id: name,
  name: 'Dialog demo',
  capabilities: [],
}
const RoomContext = createContext('missing')
const text = (key: string, fallback: string) => ({ namespace: name, key, fallback })
export function apply(ctx: Context) {
  ctx.i18n.define({
    namespace: name,
    locale: 'en',
    messages: {
      'page.title': 'Dialog demo',
      'page.description': 'Exercise Host chrome and interactive JSX.',
      'route.title': 'Dialog demo',
      'route.description': 'Open the shared dialog demonstration.',
    },
  })
  ctx.i18n.define({
    namespace: name,
    locale: 'zh-CN',
    messages: {
      'page.title': '弹窗演示',
      'page.description': '验证统一弹窗外壳与复杂 JSX 交互。',
      'route.title': '弹窗演示',
      'route.description': '打开通用弹窗交互演示。',
    },
  })
  const unregister = ctx.dialogs.register(
    'details',
    defineDialog(({ props }) => (
      <Stack gap="medium">
        <p>Registered room: {String(props.roomId)}</p>
        <textarea aria-label="Notes" defaultValue="Editable JSX body" />
        <Button onClick={() => ctx.notifications.show({ kind: 'demo.saved', type: 'info', message: 'Draft saved' })}>
          Save draft
        </Button>
      </Stack>
    )),
  )
  ctx.effect(() => unregister)
  function RoomBody() {
    const room = useContext(RoomContext)
    const [players, setPlayers] = useState(2)
    const handle = useDialog()
    return (
      <Stack gap="medium">
        <p data-dialog-context={room}>五子棋 · 规则练习对手 · {players}/4 人</p>
        <Button data-dialog-counter="true" onClick={() => setPlayers(value => value + 1)}>添加参与者</Button>
        <label>
          房间备注<textarea
            aria-label="房间备注"
            defaultValue="这里可以编辑备注，React 状态和上下文会保留。"
            style={{ display: 'block', width: '100%', minHeight: 90 }}
          />
        </label>
        <HoverCard trigger={<Button>玩法说明</Button>} content={<p>15×15 棋盘，连成至少五子获胜。</p>} />
        <Button
          data-dialog-child="true"
          onClick={() => {
            void ctx.dialogs.confirm({
              kind: 'room.reset',
              title: '重置本局？',
              confirmLabel: '重置',
              tone: 'danger',
              parent: handle,
              run: () => setPlayers(2),
            })
          }}
        >
          子级确认
        </Button>
        <details>
          <summary>技术详情</summary>
          <pre>source: local practice service</pre>
        </details>
      </Stack>
    )
  }
  function Page() {
    const [open, setOpen] = useState(false)
    return (
      <RoomContext.Provider value="room-context">
        <DialogProvider service={ctx.dialogs}>
          <Stack gap="medium">
            <Button data-dialog-demo="jsx" onClick={() => setOpen(true)}>打开复杂 JSX 弹窗</Button>
            <Button
              data-dialog-demo="registered"
              onClick={() =>
                ctx.dialogs.open({
                  kind: 'room.details',
                  instanceKey: 'room-42',
                  title: 'Registered room',
                  content: { id: 'details', props: { roomId: '42' } },
                })}
            >
              打开注册视图
            </Button>
            <Button
              data-dialog-demo="form"
              onClick={() => {
                void ctx.dialogs.form({
                  kind: 'room.create',
                  title: '创建房间',
                  submitLabel: '创建',
                  fields: [{ id: 'name', type: 'string', label: '房间名称', required: true }],
                  submit: async () => {},
                })
              }}
            >
              打开表单
            </Button>
          </Stack>
          <Dialog
            open={open}
            onOpenChange={setOpen}
            title="五子棋 · 房间详情"
            size="medium"
            headerActions={[
              {
                id: 'share',
                icon: 'share',
                label: '分享',
                onAction: () => {
                  ctx.notifications.show({ kind: 'room.shared', type: 'success', message: '邀请已准备好' })
                },
              },
              { id: 'refresh', icon: 'refresh', label: '刷新', onAction: () => {} },
              { id: 'help', icon: 'help', label: '帮助', onAction: () => {} },
            ]}
            footer={{
              status: '规则练习 · 本地试玩服务',
              secondaryActions: [{ id: 'cancel', label: '关闭', onAction: () => setOpen(false) }],
              primaryAction: {
                id: 'join',
                label: '加入房间',
                onAction: async () => {
                  throw new Error('Simulated operation failure')
                },
              },
            }}
          >
            <RoomBody />
          </Dialog>
        </DialogProvider>
      </RoomContext.Provider>
    )
  }
  ctx.pages.register({
    $schema: CORDISX_PAGE_SCHEMA_V3,
    schemaVersion: 3,
    id: 'main',
    title: text('page.title', 'Dialog demo'),
    description: text('page.description', 'Exercise Host chrome and interactive JSX.'),
  }, defineReactPage(Page))
  ctx.routes.register({
    $schema: CORDISX_ROUTE_SCHEMA_V2,
    schemaVersion: 2,
    id: 'main',
    path: '/dialogs-demo',
    outlet: 'app',
    page: 'main',
    title: text('route.title', 'Dialog demo'),
    description: text('route.description', 'Open the shared dialog demonstration.'),
  })
  ctx.slots.register({ name: 'sidebar.navigation.items', id: name, order: -100 }, {
    label: text('route.title', 'Dialog demo'),
    icon: 'host:info',
    route: { id: 'main' },
  })
}
