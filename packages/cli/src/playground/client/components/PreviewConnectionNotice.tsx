export type PlaygroundPreviewConnectionState = 'disconnected' | 'reconnecting' | 'failed'

interface PreviewConnectionNoticeProps {
  readonly state: PlaygroundPreviewConnectionState
  readonly locale: 'zh-CN' | 'en'
  readonly onRefresh: () => void
}

export function PreviewConnectionNotice(props: PreviewConnectionNoticeProps) {
  const en = props.locale === 'en'
  const title = en
    ? props.state === 'disconnected' ? 'Local preview service disconnected' : props.state === 'failed' ? 'Local preview runtime failed' : 'Local preview is reconnecting'
    : props.state === 'disconnected' ? '本地预览服务已断开' : props.state === 'failed' ? '本地预览运行时未能启动' : '本地预览正在恢复'
  const detail = en
    ? props.state === 'disconnected'
      ? 'Refresh this page or wait for the preview service to restart.'
      : props.state === 'failed'
        ? 'Refresh this page or wait for the runtime to be repaired.'
        : 'Wait for the runtime generation to finish. Refresh if it does not recover.'
    : props.state === 'disconnected'
      ? '请刷新页面或等待预览服务重启。'
      : props.state === 'failed'
        ? '请刷新页面或等待运行时修复。'
        : '请等待运行时 generation 完成；若未恢复，请刷新页面。'

  return <main
    className="pg-preview-connection-notice"
    data-playground-preview-connection={props.state}
    role="alert"
    aria-live="assertive"
  >
    <section>
      <span>{en ? 'Playground · Local preview' : 'Playground · 本地预览'}</span>
      <h1>{title}</h1>
      <p>{detail}</p>
      <button type="button" onClick={props.onRefresh}>{en ? 'Refresh' : '刷新'}</button>
    </section>
  </main>
}
