import { useId, useState } from 'react'
import { HostDialog, HostDialogAction } from './host-ui/HostDialog.js'
import type { NativeProviderSubmitConfirmation } from './native-provider-selection-client.js'
import css from './native-logical-continuation-dialog.css?inline'

type Mode = 'linked' | 'fork'

/** A choice and a separate history grant are required for this one switch. */
export function NativeLogicalContinuationDialog(input: {
  confirmation: NativeProviderSubmitConfirmation & { logical: NonNullable<NativeProviderSubmitConfirmation['logical']> }
  locale: string
  finish(mode: Mode | undefined, remember?: 'conversation' | 'profile' | 'inherit', channelCode?: string): void
  openSource?(sessionId: string): Promise<'accepted' | 'unavailable'>
}) {
  const zh = input.locale.toLowerCase().startsWith('zh')
  const [mode, setMode] = useState<Mode | undefined>(
    input.confirmation.logical.legacyFreshPreference ? undefined : input.confirmation.logical.recommended,
  )
  const [consent, setConsent] = useState(false)
  const [remember, setRemember] = useState<'once' | 'conversation' | 'profile' | 'inherit'>('once')
  const channelCode = input.confirmation.logical.channelChallenge ?? ''
  const group = useId()
  const available = mode === 'fork'
    ? input.confirmation.logical.forkAvailable
    : mode === 'linked' && input.confirmation.logical.linkedAvailable
  const choose = (next: Mode) => {
    setMode(next)
    setConsent(false)
  }
  return (
    <HostDialog
      open
      className="cxmp-confirm"
      title={zh ? '切换模型服务' : 'Switch model service'}
      description={zh
        ? '选择如何接续这段对话。原对话会保留。'
        : 'Choose how to continue this conversation. The original is kept.'}
      onClose={() => input.finish(undefined)}
      actions={
        <>
          <HostDialogAction onClick={() => input.finish(undefined)}>{zh ? '取消' : 'Cancel'}</HostDialogAction>
          <HostDialogAction
            variant="primary"
            disabled={!available || !consent
              || input.confirmation.logical.channelBound
                && (mode === 'fork' || !/^[A-Za-z0-9_-]{32}$/u.test(channelCode))}
            onClick={() =>
              input.finish(
                mode,
                remember === 'once' ? undefined : remember,
                input.confirmation.logical.channelBound ? channelCode : undefined,
              )}
          >
            {zh ? '继续' : 'Continue'}
          </HostDialogAction>
        </>
      }
    >
      <style>{css}</style>
      <p>
        {zh ? '目标服务：' : 'Target service: '}
        {input.confirmation.target.providerId}
        {' · '}
        {zh ? '模型：' : 'Model: '}
        {input.confirmation.target.model}
      </p>
      {input.confirmation.logical.legacyFreshPreference
        ? (
          <p>
            {zh
              ? '此前保存的空白偏好已不再用于接续。请选择接续方式并授权；旧记录会保留。'
              : 'The saved fresh preference no longer applies to continuation. Choose a mode and authorize it; earlier records are kept.'}
          </p>
        )
        : null}
      {input.confirmation.logical.chain && (input.confirmation.logical.chain.links.length > 0
          || input.confirmation.logical.chain.truncated)
        ? (
          <details>
            <summary>{zh ? '查看已有接续边界' : 'Inspect earlier session boundaries'}</summary>
            <p>{zh ? '会话 ID：来源 → 目标' : 'Session IDs: source → destination'}</p>
            <ol>
              {input.confirmation.logical.chain.links.map(link => (
                <li key={link.destination}>
                  {input.openSource
                    ? (
                      <button
                        type="button"
                        onClick={() => {
                          input.finish(undefined)
                          void input.openSource!(link.source)
                        }}
                      >
                        {link.source}
                      </button>
                    )
                    : link.source} → {link.destination} ({link.mode === 'linked'
                    ? zh ? '按需接续' : 'on demand'
                    : link.mode === 'fork'
                    ? zh ? '完整 fork' : 'full fork'
                    : zh
                    ? '空白'
                    : 'fresh'})
                </li>
              ))}
            </ol>
            {input.confirmation.logical.chain.truncated
              ? <p>{zh ? '更早的关系不可显示。' : 'Earlier relationships are unavailable.'}</p>
              : null}
          </details>
        )
        : null}
      <fieldset>
        <legend>{zh ? '接续方式' : 'Continuation mode'}</legend>
        <label className="cxmp-confirm-choice">
          <input
            type="radio"
            name={group}
            checked={mode === 'fork'}
            disabled={!input.confirmation.logical.forkAvailable}
            onChange={() => choose('fork')}
          />
          {zh ? '完整 fork：继承原生完整历史，包括工具内容' : 'Full fork: inherit all native history, including tools'}
        </label>
        <label className="cxmp-confirm-choice">
          <input
            type="radio"
            name={group}
            checked={mode === 'linked'}
            disabled={!input.confirmation.logical.linkedAvailable}
            onChange={() => choose('linked')}
          />
          {zh
            ? '按需接续：新上下文按需读取获准的来源及接续历史中的用户和助手文本'
            : 'On demand: read authorized user and assistant text from the source and earlier links'}
        </label>
      </fieldset>
      {!input.confirmation.logical.forkAvailable && !input.confirmation.logical.linkedAvailable
        ? (
          <p role="status">
            {zh
              ? '当前无法安全接续。请检查登录、来源对话和相关授权后重试。'
              : 'Continuation is unavailable. Check the account, source conversation and relevant authorization.'}
          </p>
        )
        : null}
      {input.confirmation.logical.channelBound
        ? (
          <div>
            <p>
              {zh
                ? '此对话已绑定 Channel。请让绑定的私聊用户发送当前方式对应的指令，收到授权回复后在此确认；如需更换方式，请重新开始。此路径不传送检查点。'
                : 'This conversation is bound to a Channel. Ask the bound direct-chat user to send the command for this mode, then confirm after their authorization reply. Start again to change mode. This path does not transfer a checkpoint.'}
            </p>
            {mode === 'linked'
              ? (
                <code>
                  /continue-provider authorize-desktop {mode} {input.confirmation.target.providerId}{' '}
                  {input.confirmation.target.model} --history=user-assistant --no-checkpoint --challenge={channelCode}
                </code>
              )
              : null}
          </div>
        )
        : null}
      <label className="cxmp-confirm-preference">
        {zh ? '切换后的偏好' : 'Preference after this switch'}{' '}
        <select value={remember} onChange={event => setRemember(event.currentTarget.value as typeof remember)}>
          <option value="once">{zh ? '仅本次' : 'This switch only'}</option>
          <option value="conversation">{zh ? '此对话' : 'This conversation'}</option>
          <option value="inherit">
            {zh ? '以后此对话跟随默认' : 'This conversation follows the default afterward'}
          </option>
          <option value="profile">
            {zh ? '未单独设置的对话（默认）' : 'Conversations without an override (default)'}
          </option>
        </select>
      </label>
      <p>
        {zh
          ? '保存方式不会保存历史授权，每次切换仍需确认。'
          : 'Saving a mode does not save history authorization; each switch still requires confirmation.'}
      </p>
      <label className="cxmp-confirm-choice">
        <input
          type="checkbox"
          checked={consent}
          disabled={!available}
          onChange={event => setConsent(event.currentTarget.checked)}
        />
        {mode === 'fork'
          ? zh ? '我授权新对话继承完整历史。' : 'I authorize the new conversation to inherit the full history.'
          : zh
          ? '我授权新对话按需读取这些历史文本。'
          : 'I authorize the new conversation to read this history on demand.'}
      </label>
      <p>
        {mode === undefined ? null : mode === 'fork'
          ? zh
            ? '完整历史可能发送给目标服务商；此路径不单独传送检查点。'
            : 'Full history may be sent to the target service; this path does not separately transfer a checkpoint.'
          : zh
          ? '获准历史可能发送给目标服务商；部分形似内部凭据的文本可能被遮蔽，此路径不传送检查点。'
          : 'Authorized history may be sent to the target service; some text resembling internal credentials may be redacted. This path does not transfer a checkpoint.'}
      </p>
    </HostDialog>
  )
}
