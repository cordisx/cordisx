import { useMemo } from 'react'
import svg from '../../../assets/illustrations/model-services.svg?raw'
import css from '../../../assets/illustrations/model-services.css?inline'

// Approved Host-owned static assets. Namespace without changing paths or timing.
const markup = svg.replaceAll('ms-', 'cxms-illustration-').replace(
  '<svg ',
  '<svg aria-hidden="true" focusable="false" ',
)
const styles = css.replaceAll('ms-', 'cxms-illustration-')

export function ModelServicesIllustration() {
  // Preserve the trusted SVG DOM across snapshot updates; theme still inherits.
  const scene = useMemo(
    () => <span className="cxms-illustration" aria-hidden="true" dangerouslySetInnerHTML={{ __html: markup }} />,
    [],
  )
  return (
    <>
      <style>{styles}</style>
      {scene}
    </>
  )
}
