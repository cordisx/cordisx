/** A projectless target names one directory, not an arbitrary filesystem path. */
export function isProjectlessDirectoryName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && value !== '.' && value !== '..' && !/[\/\\:\u0000-\u001f\u007f]/u.test(value)
}
