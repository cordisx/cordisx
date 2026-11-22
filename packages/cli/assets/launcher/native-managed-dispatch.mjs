/** Apply the authorized provider selection while retaining user input and native controls. */
export function prepareManagedNativeDispatch(
  message,
  params,
  config,
  dispatch,
  marker,
  { object, configuredOverrides },
) {
  const nextConfig = { ...config }
  delete nextConfig[marker]
  if (dispatch.agentTask && (dispatch.serviceTier === 'priority' || dispatch.serviceTier === null)) {
    params.serviceTier = dispatch.serviceTier
  }
  if (message.method === 'thread/start') {
    params.modelProvider = dispatch.providerId
    params.model = dispatch.model
    params.config = dispatch.providerSource === 'config'
      ? configuredOverrides(nextConfig, dispatch.configOverrides)
      : { ...nextConfig, ...dispatch.configOverrides }
    if (typeof dispatch.reasoningEffort === 'string') params.config.model_reasoning_effort = dispatch.reasoningEffort
  } else {
    params.model = dispatch.model
    if (typeof dispatch.reasoningEffort === 'string') params.effort = dispatch.reasoningEffort
    if (Object.keys(nextConfig).length === 0) delete params.config
    else params.config = nextConfig
    const mode = object(params.collaborationMode)
    if (mode && object(mode.settings)) {
      params.collaborationMode = {
        ...mode,
        settings: {
          ...mode.settings,
          model: dispatch.model,
          ...(typeof dispatch.reasoningEffort === 'string' ? { reasoning_effort: dispatch.reasoningEffort } : {}),
        },
      }
    }
  }
}
