import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The real lifecycle-guard launch (`defaultNativeLifecycleGuard` -> Hermes interpreter -> shipped helper) against a
// synthetic Hermes checkout whose third-party dependency is importable only after `hermes_bootstrap` activates it,
// as with a Hermes install whose dependencies live in its managed generation rather than in the selected interpreter.
const PYTHON = process.env.SCRIPT_REPORT_TEST_PYTHON || 'python3'
let root: string
let agent: string
let home: string

function checkout(bootstrap: 'activates' | 'absent' | 'fails', depsOnPath = false) {
  agent = join(root, `agent-${bootstrap}-${depsOnPath}`)
  mkdirSync(join(agent, 'cron'), { recursive: true })
  mkdirSync(join(root, 'deps'), { recursive: true })
  writeFileSync(join(root, 'deps', 'thirdparty_dep.py'), 'VALUE = 1\n')
  writeFileSync(join(agent, 'run_agent.py'), '')
  writeFileSync(join(agent, 'cron', '__init__.py'), 'import thirdparty_dep  # like cron.jobs -> ruamel\n')
  writeFileSync(join(agent, 'cron', 'lifecycle_guard.py'), [
    'import os, thirdparty_dep',
    'class GatewayLifecycleBlocked(ValueError):',
    '    pass',
    'def check_gateway_lifecycle(prompt, script=None):',
    '    text = open(os.path.join(os.environ["HERMES_HOME"], "scripts", script)).read()',
    '    if "gateway restart" in text:',
    '        raise GatewayLifecycleBlocked("Blocked: gateway lifecycle command")',
    '',
  ].join('\n'))
  if (bootstrap === 'activates') writeFileSync(join(agent, 'hermes_bootstrap.py'), `import sys\nsys.path.insert(0, ${JSON.stringify(join(root, 'deps'))})\n`)
  if (bootstrap === 'fails') writeFileSync(join(agent, 'hermes_bootstrap.py'), 'raise RuntimeError("dependency activation failed")\n')
  vi.stubEnv('HERMES_AGENT_ROOT', agent)
  vi.stubEnv('HERMES_AGENT_BRIDGE_PYTHON', PYTHON)
  // The child sees only the checkout on its path: an interpreter that already has the dependency is modelled there.
  if (depsOnPath) writeFileSync(join(agent, 'thirdparty_dep.py'), 'VALUE = 1\n')
}

beforeEach(() => {
  vi.resetModules()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-guard-')))
  home = join(root, 'home')
  mkdirSync(join(home, 'scripts'), { recursive: true })
  writeFileSync(join(home, 'scripts', 'ok.py'), 'print("ok")\n')
  writeFileSync(join(home, 'scripts', 'bad.py'), 'import os\nos.system("hermes gateway restart")\n')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

const guard = async () => (await import('../../packages/server/src/modules/hermes/services/script-reports/native-guard')).defaultNativeLifecycleGuard

describe('native lifecycle guard launch', () => {
  it('activates the Hermes checkout like every Hermes entry point before importing the guard (formal 503 native_guard_unavailable)', async () => {
    checkout('activates')
    const check = await guard()
    expect(await check(home, 'ok.py')).toEqual({ ok: true })
    expect(await check(home, 'bad.py')).toMatchObject({ ok: false, refused: true, reason: expect.stringContaining('Blocked') })
  })

  it('still runs on an older Hermes without hermes_bootstrap when the interpreter already provides the dependencies', async () => {
    checkout('absent', true)
    expect(await (await guard())(home, 'ok.py')).toEqual({ ok: true })
  })

  it('stays unavailable, never allowed, when activation fails or the dependencies are missing', async () => {
    checkout('fails')
    expect(await (await guard())(home, 'ok.py')).toMatchObject({ ok: false, refused: false })
    vi.resetModules()
    checkout('absent')
    expect(await (await guard())(home, 'ok.py')).toMatchObject({ ok: false, refused: false })
  })
})
