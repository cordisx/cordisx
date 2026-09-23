if (process.platform === 'darwin' && process.env.npm_config_global === 'true') {
  try {
    const { refreshInstalledAppAfterUpgrade } = await import('../dist/src/app-launcher/postinstall.js')
    await refreshInstalledAppAfterUpgrade()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.warn(
      `[cordisx] Existing CordisX.app was not checked during upgrade: ${detail}. Run \`cordisx app\` to repair it.`,
    )
  }
}
