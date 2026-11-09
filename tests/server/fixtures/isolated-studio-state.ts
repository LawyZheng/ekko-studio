// Import first: points Web UI state at a private temporary directory before any Studio module loads,
// so these tests never touch the default ~/.hermes-web-ui and parallel files never share a database.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'studio-test-state-'))
process.env.HERMES_WEB_UI_HOME = dir
process.env.HERMES_WEBUI_STATE_DIR = dir
process.env.UPLOAD_DIR = join(dir, 'upload')
