"""Keep Studio-managed MCP subprocesses attached to their owning bridge."""
from __future__ import annotations

import importlib
import json
import os
from contextvars import ContextVar
from typing import Any


def install_studio_mcp_env() -> None:
    raw = os.environ.get("HERMES_AGENT_BRIDGE_STUDIO_MCP_ENV", "")
    if not raw:
        return
    owner = json.loads(raw)
    if not isinstance(owner, dict) or not owner.get("HERMES_WEB_UI_URL"):
        raise RuntimeError("Studio Bridge MCP owner environment is invalid")
    try:
        module = importlib.import_module("tools.mcp_tool_config")
    except ModuleNotFoundError as exc:
        if exc.name != "tools.mcp_tool_config":
            raise
        module = importlib.import_module("tools.mcp_tool")
    original = getattr(module, "_build_safe_env", None)
    if not callable(original):
        raise RuntimeError("Hermes runtime does not expose the MCP launch environment builder")
    if getattr(original, "_studio_bridge_owner", False):
        return

    def build_env(user_env: dict[str, Any] | None) -> dict[str, Any]:
        if isinstance(user_env, dict) and user_env.get("HERMES_WEB_UI_MANAGED_MCP") == "1":
            # Rewrite a copy at launch, including reconnect/reload. Never persist
            # instance routing to the shared profile or alter user-owned servers.
            user_env = {**user_env, **owner}
            user_env["HERMES_WEB_UI_PROFILE"] = os.environ.get("HERMES_AGENT_BRIDGE_WORKER_PROFILE") or "default"
            user_env.pop("HERMES_WEB_UI_TOKEN", None)
            # One shared MCP process can serve concurrent group plan contexts.
            # Select their restricted credential on each request, never in worker state.
            user_env["HERMES_MCP_CONTEXT_CREDENTIALS"] = "1"
        return original(user_env)

    build_env._studio_bridge_owner = True  # type: ignore[attr-defined]
    module._build_safe_env = build_env


# Trusted current-session Cron admission. The authority of one execution (a live chat turn or a
# login dispatch) lives in this ContextVar: set for that execution's thread, inherited by its tool
# threads and by the MCP loop task created from them, never a worker-wide global.
CRON_CAPABILITY: ContextVar[str | None] = ContextVar("studio_cron_capability", default=None)
CRON_CAPABILITY_META = "ekko.studio/cron-capability"
MANAGED_API_SERVER = "ekko-studio-api"
API_REQUEST_TOOL = "ekko_studio_api_request"
CURRENT_SESSION_PATH = "/api/hermes/cron/current-session"


def _managed_api_server(server_name: str, server: Any) -> bool:
    """Studio's own managed API server, verified by name, marker, toolset and launcher."""
    config = getattr(server, "_config", None)
    if server_name != MANAGED_API_SERVER or not isinstance(config, dict):
        return False
    env = config.get("env") if isinstance(config.get("env"), dict) else {}
    args = [str(arg) for arg in config.get("args") or []]
    launcher = os.path.basename(str(config.get("command") or ""))
    return (env.get("HERMES_WEB_UI_MANAGED_MCP") == "1" and env.get("HERMES_MCP_TOOLSET") == "api"
            and bool(args) and args[-1] == "api"
            and (launcher == "ekko-studio-mcp" or any(arg.replace("\\", "/").endswith("bin/ekko-studio-mcp.mjs") for arg in args)))


class _MetaSession:
    """Per-call view of an MCP client session that adds Studio call metadata."""

    def __init__(self, session: Any, meta: dict[str, str]) -> None:
        self._session = session
        self._meta = meta

    def __getattr__(self, name: str) -> Any:
        return getattr(self._session, name)

    def call_tool(self, name: str, arguments: Any = None, *args: Any, **kwargs: Any) -> Any:
        kwargs["meta"] = {**(kwargs.get("meta") or {}), **self._meta}
        return self._session.call_tool(name, arguments, *args, **kwargs)


class _MetaServer:
    """Per-call view of an MCP server task; everything but `session` is the real server."""

    def __init__(self, server: Any, meta: dict[str, str]) -> None:
        self._server = server
        self.session = _MetaSession(server.session, meta)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._server, name)


def install_cron_capability_meta() -> None:
    """Send the current execution's admission authority as `_meta` on Studio's managed API calls only.

    Wraps Hermes' call helper per call, so its locking, progress, cancellation, reconnect and
    uncertain-outcome handling stay the original's; tool registrations are untouched.
    """
    try:
        module = importlib.import_module("tools.mcp_tool_handlers")
    except ModuleNotFoundError:
        return
    original = getattr(module, "_call_tool_racing_stdio_death", None)
    if not callable(original) or getattr(original, "_studio_cron_meta", False):
        return

    async def call(server: Any, server_name: str, tool_name: str, args: dict, progress_callback: Any = None) -> Any:
        capability = CRON_CAPABILITY.get()
        if capability and tool_name == API_REQUEST_TOOL and _managed_api_server(server_name, server):
            server = _MetaServer(server, {CRON_CAPABILITY_META: capability})
        return await original(server, server_name, tool_name, args, progress_callback)

    call._studio_cron_meta = True  # type: ignore[attr-defined]
    module._call_tool_racing_stdio_death = call


def run_cron_admission(capability: str, body: dict[str, Any]) -> str:
    """The fixed model-free admission: Studio's managed API tool, the current-session path, this body."""
    try:
        discovery = importlib.import_module("tools.mcp_tool_discovery")
    except ModuleNotFoundError:
        discovery = importlib.import_module("tools.mcp_tool")
    discovery.discover_mcp_tools([MANAGED_API_SERVER])
    schema = importlib.import_module("tools.mcp_tool_schema")
    tool = schema.mcp_prefixed_tool_name(MANAGED_API_SERVER, API_REQUEST_TOOL)
    handle_function_call = importlib.import_module("model_tools").handle_function_call
    token = CRON_CAPABILITY.set(capability)
    try:
        result = handle_function_call(tool, {"method": "POST", "path": CURRENT_SESSION_PATH, "body": body})
    finally:
        CRON_CAPABILITY.reset(token)
    return result if isinstance(result, str) else json.dumps(result)
