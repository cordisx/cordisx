import { createRoot } from 'react-dom/client'
import { PluginConsolePanel, type PluginConsolePanelProps } from './components/PluginConsolePanel.js'

/** Temporary ownership seam while the surrounding Manager shell is migrated. */
export function mountPluginConsolePanel(container: HTMLElement, props: PluginConsolePanelProps): () => void {
  const root = createRoot(container)
  root.render(<PluginConsolePanel {...props} />)
  return () => root.unmount()
}
