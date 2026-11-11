// Deterministic Worker for the task-lifecycle producer protocol: writes one artifact, reports its digest on
// stdout and exits with the requested code. It never talks to Studio; its trusted launcher does.
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const [out, code = '0', delayMs = '50'] = process.argv.slice(2)
await new Promise(resolve => setTimeout(resolve, Number(delayMs)))
const body = `# Report\n\nrows: 3\n`
writeFileSync(out, body)
process.stdout.write(JSON.stringify({ artifact: out, sha256: createHash('sha256').update(body).digest('hex') }) + '\n')
process.exit(Number(code))
