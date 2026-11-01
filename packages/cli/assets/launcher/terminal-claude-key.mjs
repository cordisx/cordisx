// Only the selected CLI child receives this value. No key is passed in argv.
const key = process.env.CORDISX_TERMINAL_SERVICE_KEY
if (!key || key.includes('\0')) process.exit(1)
process.stdout.write(key)
