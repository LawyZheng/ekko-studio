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
import bridge_mcp

class Session:
    async def call_tool(self, name, arguments=None, read_timeout_seconds=None, progress_callback=None, *, meta=None):
        await asyncio.sleep(0.01)
        return meta

class Server:
    def __init__(self, command, args, toolset='api', managed='1'):
        self._config = {'command': command, 'args': args, 'env': {'HERMES_WEB_UI_MANAGED_MCP': managed, 'HERMES_MCP_TOOLSET': toolset}}
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
    assert await asyncio.create_task(under('cap', Server('ekko-studio-mcp', ['api']))) == {key: 'cap'}
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
})
