import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const python = process.platform === 'win32' ? 'python' : 'python3'
const setup = String.raw`
import asyncio, contextvars, json, sys, threading, types
from pathlib import Path
sys.path.insert(0, str(Path('packages/server/src/modules/hermes/services/bridge/python').resolve()))
tools = types.ModuleType('tools')
tools.__path__ = []
sys.modules['tools'] = tools
handlers = types.ModuleType('tools.mcp_tool_handlers')
async def original(server, server_name, tool_name, args, progress_callback=None):
    return await server.session.call_tool(tool_name, arguments=args, progress_callback=progress_callback)
handlers._call_tool_racing_stdio_death = original
sys.modules['tools.mcp_tool_handlers'] = handlers
interrupt = types.ModuleType('tools.interrupt')
interrupt.set_interrupt = lambda active, thread_id=None, **kw: None
sys.modules['tools.interrupt'] = interrupt
import os
# Studio's own launch of its managed API server, passed to every Bridge process.
os.environ['HERMES_AGENT_BRIDGE_STUDIO_MCP_LAUNCH'] = json.dumps({'command': '/usr/bin/node', 'args': ['/opt/ekko/bin/ekko-studio-mcp.mjs', 'api']})
import bridge_mcp

class Session:
    async def call_tool(self, name, arguments=None, read_timeout_seconds=None, progress_callback=None, *, meta=None):
        await asyncio.sleep(0.01)
        return meta

class Server:
    def __init__(self, command, args, toolset='api', managed='1', **extra):
        self._config = {'command': command, 'args': args, 'env': {'HERMES_WEB_UI_MANAGED_MCP': managed, 'HERMES_MCP_TOOLSET': toolset}, **extra}
        self.session = Session()
        self._rpc_lock = 'real-lock'

api = Server('/usr/bin/node', ['/opt/ekko/bin/ekko-studio-mcp.mjs', 'api'])
`

describe('Bridge trusted Cron capability metadata', () => {
  it('attaches the execution authority only to calls of Studio\'s verified managed API tool, per context', () => {
    const output = execFileSync(python, ['-c', setup + String.raw`
bridge_mcp.install_cron_capability_meta()
patched = handlers._call_tool_racing_stdio_death
bridge_mcp.install_cron_capability_meta()
assert handlers._call_tool_racing_stdio_death is patched

async def under(capability, server, name='ekko-studio-api', tool='ekko_studio_api_request'):
    if capability:
        bridge_mcp.CRON_CAPABILITY.set(capability)
    return await patched(server, name, tool, {})

async def main():
    key = 'ekko.studio/cron-capability'
    # Concurrent executions keep their own authority (each task has its own context).
    first, second = await asyncio.gather(asyncio.create_task(under('cap-A', api)), asyncio.create_task(under('cap-B', api)))
    assert (first, second) == ({key: 'cap-A'}, {key: 'cap-B'}), (first, second)
    assert await asyncio.create_task(under(None, api)) is None
    assert await asyncio.create_task(under('cap', api, tool='ekko_studio_update_plan')) is None
    assert await asyncio.create_task(under('cap', Server('/usr/bin/node', ['/opt/ekko/bin/ekko-studio-mcp.mjs', 'plan'], 'plan'), 'ekko-studio-interaction')) is None
    assert await asyncio.create_task(under('cap', Server('/tmp/imposter', ['api']))) is None
    assert await asyncio.create_task(under('cap', Server('/usr/bin/node', ['/opt/ekko/bin/ekko-studio-mcp.mjs', 'api'], managed='0'))) is None
    assert await asyncio.create_task(under('cap', api, name='user-server')) is None
    # Identity is Studio's exact launch, never a marker, a filename suffix or extra execution flags.
    for imposter in (Server('/untrusted/collector', ['/opt/ekko/bin/ekko-studio-mcp.mjs', 'api']),
                     Server('/usr/bin/node', ['/not-studio/bin/ekko-studio-mcp.mjs', 'api']),
                     Server('/usr/bin/node', ['--eval', 'void 0', '/opt/ekko/bin/ekko-studio-mcp.mjs', 'api']),
                     Server('/untrusted/ekko-studio-mcp', ['api']),
                     Server('/usr/bin/node', ['/opt/ekko/bin/ekko-studio-mcp.mjs', 'api'], url='http://127.0.0.1:1/mcp')):
        assert await asyncio.create_task(under('cap', imposter)) is None, imposter._config
    # A reconnect replaces the session; each attempt is wrapped again, on the current session.
    api.session = Session()
    assert await asyncio.create_task(under('cap-again', api)) == {key: 'cap-again'}
asyncio.run(main())

# Hermes hands a tool thread's call to its MCP loop with run_coroutine_threadsafe: the thread's
# context, not the loop thread's, carries the authority.
loop = asyncio.new_event_loop()
threading.Thread(target=loop.run_forever, daemon=True).start()
def tool_thread(capability, out):
    bridge_mcp.CRON_CAPABILITY.set(capability)
    out.append(asyncio.run_coroutine_threadsafe(patched(api, 'ekko-studio-api', 'ekko_studio_api_request', {}), loop).result(5))
results = []
workers = [threading.Thread(target=contextvars.copy_context().run, args=(tool_thread, cap, results)) for cap in ('cap-1', 'cap-2')]
for worker in workers: worker.start()
for worker in workers: worker.join()
assert sorted(item['ekko.studio/cron-capability'] for item in results) == ['cap-1', 'cap-2'], results
assert bridge_mcp.CRON_CAPABILITY.get() is None
print('ok')
`], { encoding: 'utf8' })
    expect(output.trim()).toBe('ok')
  })

  it('runs the fixed model-free admission: only the managed API server, its request tool and the current-session path', () => {
    const output = execFileSync(python, ['-c', setup + String.raw`
discovered = []
discovery = types.ModuleType('tools.mcp_tool_discovery')
discovery.discover_mcp_tools = lambda allowed=None: discovered.append(allowed) or []
sys.modules['tools.mcp_tool_discovery'] = discovery
schema = types.ModuleType('tools.mcp_tool_schema')
schema.mcp_prefixed_tool_name = lambda server, tool: 'mcp__' + server.replace('-', '_') + '__' + tool
sys.modules['tools.mcp_tool_schema'] = schema
calls = []
model_tools = types.ModuleType('model_tools')
def handle_function_call(name, args, **kwargs):
    calls.append((name, args, bridge_mcp.CRON_CAPABILITY.get()))
    return {'result': 'ok'}
model_tools.handle_function_call = handle_function_call
sys.modules['model_tools'] = model_tools
output = bridge_mcp.run_cron_admission('studio_run_scope', {'profile': 'default', 'kind': 'cron_job'})
assert json.loads(output) == {'result': 'ok'}
assert discovered == [['ekko-studio-api']], discovered
assert calls == [('mcp__ekko_studio_api__ekko_studio_api_request',
                  {'method': 'POST', 'path': '/api/hermes/cron/current-session', 'body': {'profile': 'default', 'kind': 'cron_job'}},
                  'studio_run_scope')], calls
assert bridge_mcp.CRON_CAPABILITY.get() is None
print('ok')
`], { encoding: 'utf8' })
    expect(output.trim()).toBe('ok')
  })

  it('bounds a dispatch: the deadline interrupts the native call, and terminal dispatch records are retired', () => {
    const output = execFileSync(python, ['-c', setup + String.raw`
import time
interrupt = types.ModuleType('tools.interrupt')
interrupted = set()
interrupt.set_interrupt = lambda active, thread_id=None, **kw: (interrupted.add if active else interrupted.discard)(thread_id or threading.get_ident())
interrupt.is_interrupted = lambda: threading.get_ident() in interrupted
sys.modules['tools.interrupt'] = interrupt
discovery = types.ModuleType('tools.mcp_tool_discovery')
discovery.discover_mcp_tools = lambda allowed=None: []
sys.modules['tools.mcp_tool_discovery'] = discovery
schema = types.ModuleType('tools.mcp_tool_schema')
schema.mcp_prefixed_tool_name = lambda server, tool: tool
sys.modules['tools.mcp_tool_schema'] = schema
model_tools = types.ModuleType('model_tools')
def slow_call(name, args, **kwargs):
    # Hermes' MCP wait loop honors the calling thread's interrupt flag.
    while not interrupt.is_interrupted():
        time.sleep(0.01)
    return json.dumps({'error': 'MCP call interrupted: user sent a new message'})
model_tools.handle_function_call = slow_call
sys.modules['model_tools'] = model_tools
started = time.monotonic()
try:
    bridge_mcp.run_cron_admission('studio_run_scope', {'kind': 'cron_job'}, deadline_seconds=0.2)
    raise AssertionError('deadline not enforced')
except TimeoutError as error:
    assert str(error) == 'dispatch_deadline'
assert time.monotonic() - started < 5 and not interrupted and bridge_mcp.CRON_CAPABILITY.get() is None

gateway = types.ModuleType('gateway'); gateway.__path__ = []
session_context = types.ModuleType('gateway.session_context')
session_context.set_session_vars = lambda **kw: ['token']
session_context.clear_session_vars = lambda tokens: None
sys.modules['gateway'] = gateway
sys.modules['gateway.session_context'] = session_context
from bridge_pool import AgentPool
pool = AgentPool()
bridge_mcp.run_cron_admission = lambda capability, body, deadline_seconds=None: '{"result": "{}"}'
started = pool.studio_cron_dispatch('chat-1', 'studio_run_scope', {'kind': 'cron_job'}, 'default')
pool._runs[started['run_id']].worker_thread.join(5)
result = pool.get_result(started['run_id'])
assert result['status'] == 'complete', result
try:
    pool.get_result(started['run_id'])
    raise AssertionError('terminal dispatch record retained')
except KeyError:
    pass
assert not [run for run in pool._runs.values() if run.session_id.startswith('cron-dispatch:')]
print('ok')
`], { encoding: 'utf8' })
    expect(output.trim()).toBe('ok')
  })
})
