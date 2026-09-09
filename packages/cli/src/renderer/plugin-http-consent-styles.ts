export const PLUGIN_HTTP_CONSENT_STYLES = `
  .cxp-http-dialog { width: min(520px, 100%); }
  .cxp-http-description { margin: 14px 0 0; color: var(--cx-muted); font-size: 13px; line-height: 1.5; }
  .cxp-http-details { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 5px 12px; margin: 16px 0 0; font-size: 13px; }
  .cxp-http-details dt, .cxp-http-details dd { min-width: 0; margin: 0; }
  .cxp-http-details dt { color: var(--cx-muted); }
  .cxp-http-details dd { overflow-wrap: anywhere; }
  .cxp-http-credential { display: grid; gap: 7px; margin-top: 18px; font-size: 13px; font-weight: 600; }
  .cxp-http-credential .t-input { background: var(--cx-surface-raised); color: var(--cx-text); }
  .cxp-http-credential .t-input__inner { color: var(--cx-text); }
  .cxp-http-credential .t-input:focus-within { box-shadow: 0 0 0 2px var(--cx-focus); }
  .cxp-http-credential-hint { margin: 8px 0 0; color: var(--cx-muted); font-size: 12px; line-height: 1.45; }
  .cxp-http-credential, .cxp-http-credential input { -webkit-app-region: no-drag; }
  @media (max-width: 560px) { .cxp-http-details { grid-template-columns: 1fr; gap: 3px; } .cxp-http-details dd + dt { margin-top: 7px; } }
`
