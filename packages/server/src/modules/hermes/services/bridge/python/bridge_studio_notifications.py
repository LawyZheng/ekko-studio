"""Studio-owned session notifications for Hermes cron results and terminal completions.

Cron: Studio binds a native job to a session only through its explicit binding API. This
module never wraps or replaces a registered Hermes tool, its availability check or any
cached tool definition.

Observation reads the native execution ledger and the canonical admission result of
each fire (``cron_request_id(job, execution_id)``); it never correlates output files
by name or time.

Terminal: ``notify_on_complete`` completions owned by a loaded Studio session are
drained with Hermes' own ``drain_notifications`` and handed to Studio as typed
machine events. Consumption by wait/log is rechecked at dispatch.
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from typing import Any

_TERMINAL_EXECUTION_STATES = {"completed", "failed", "unknown"}
_OBSERVE_PAGE = 50


# --- owner session generations -------------------------------------------------------------------

# Owner session generations declared by Studio with each bridge turn, in declaration order
# (session id -> [(declared_at, generation or None)]). A producer started during a turn belongs to
# the generation declared for that turn, even if a later turn declares a new one. Repeated
# declarations of an unchanged generation are coalesced into the first one, so only real
# generation changes use the bounded history and ordinary turns never evict a live owner.
_session_generations: dict[str, list[tuple[float, str | None]]] = {}
_generation_lock = threading.Lock()
_GENERATION_HISTORY_MAX = 32


def set_session_generation(session_id: str, generation: str | None) -> None:
    with _generation_lock:
        history = _session_generations.setdefault(session_id, [])
        declared = str(generation) if generation else None
        if history and history[-1][1] == declared:
            return
        history.append((time.time(), declared))
        del history[:-_GENERATION_HISTORY_MAX]


def session_generation(session_id: str) -> str | None:
    with _generation_lock:
        history = _session_generations.get(session_id) or []
        return history[-1][1] if history else None


def generation_at(session_id: str, started_at: Any) -> str | None:
    """The owner generation declared most recently at or before ``started_at``."""
    try:
        moment = float(started_at)
    except (TypeError, ValueError):
        return None
    with _generation_lock:
        declared = [generation for at, generation in _session_generations.get(session_id) or [] if at <= moment]
    return declared[-1] if declared else None


# --- cron observation ----------------------------------------------------------------------------

def _iso_seconds(value: Any) -> float | None:
    if not value:
        return None
    from datetime import datetime
    try:
        return datetime.fromisoformat(str(value)).timestamp()
    except ValueError:
        return None


def _admission_receipt(session_db: Any, job_id: str, execution_id: str) -> dict[str, Any] | None:
    """The canonical admission ``{session_id, admission_id}`` of one agent-backed fire."""
    try:
        from cron.scheduler_authority import journal_path
        journal = journal_path(job_id, execution_id)
        if journal.exists():
            record = json.loads(journal.read_text(encoding="utf-8-sig"))
            receipt = record.get("receipt")
            if isinstance(receipt, dict) and receipt.get("admission_id"):
                return {"admission_id": str(receipt["admission_id"]), "session_id": str(receipt.get("session_id") or "")}
    except Exception:
        pass
    if session_db is None:
        return None
    try:
        from hermes_state_keys import CRON_PRINCIPAL_ID, cron_request_id
        with session_db._read_ctx() as conn:
            row = conn.execute(
                "SELECT admission_id, target_session_id FROM session_admissions WHERE request_id=? AND principal_id=?",
                (cron_request_id(job_id, execution_id), CRON_PRINCIPAL_ID),
            ).fetchone()
        if row is not None:
            return {"admission_id": str(row[0]), "session_id": str(row[1] or "")}
    except Exception:
        return None
    return None


def _exact_result(session_db: Any, receipt: dict[str, Any]) -> list[Any] | None:
    try:
        from gateway.session_results import admission_result
        saved = admission_result(session_db, receipt["admission_id"])
    except Exception:
        return None
    if not isinstance(saved, dict) or not isinstance(saved.get("result"), dict):
        return None
    result = saved["result"].get("cron_result")
    return list(result) if isinstance(result, (list, tuple)) and len(result) >= 4 else None


def observe_cron_jobs(jobs: list[dict[str, Any]], session_db: Any) -> dict[str, Any]:
    """Terminal executions of bound jobs with their exact native result when available."""
    from cron.executions import list_executions
    from cron.jobs import get_job
    try:
        from cron.scheduler import _is_cron_silence_response
    except Exception:
        _is_cron_silence_response = None

    observed: list[dict[str, Any]] = []
    states: list[dict[str, Any]] = []
    for item in jobs or []:
        job_id = str((item or {}).get("job_id") or "").strip()
        if not job_id:
            continue
        since = float((item or {}).get("since") or 0)
        job = get_job(job_id)
        if job is None:
            states.append({"job_id": job_id, "state": "missing"})
            continue
        states.append({
            "job_id": job_id,
            "state": "present",
            "name": job.get("name"),
            "deliver": job.get("deliver"),
            "failure_deliver": job.get("failure_deliver"),
            "no_agent": bool(job.get("no_agent")),
        })
        page = list_executions(job_id=job_id, limit=_OBSERVE_PAGE)
        rows = list(page)
        before = str((item or {}).get("before") or "").strip() or None
        # Bounded progress through older retained executions: at most one older page per pass,
        # continuing from the cursor Studio stored on the previous pass.
        if before:
            older = list_executions(job_id=job_id, limit=_OBSERVE_PAGE, before_claimed_at=before)
            rows.extend(older)
            tail = older
        else:
            tail = page
        oldest = _iso_seconds(tail[-1].get("claimed_at")) if tail else None
        states[-1]["older_before"] = (
            str(tail[-1].get("claimed_at")) if len(tail) == _OBSERVE_PAGE and oldest is not None and oldest >= since
            else None)
        seen_ids: set[str] = set()
        for row in rows:
            if str(row.get("id") or "") in seen_ids:
                continue
            seen_ids.add(str(row.get("id") or ""))
            status = str(row.get("status") or "")
            if status not in _TERMINAL_EXECUTION_STATES:
                continue
            claimed = _iso_seconds(row.get("claimed_at"))
            if claimed is not None and claimed < since:
                continue
            execution_id = str(row.get("id") or "")
            entry: dict[str, Any] = {
                "job_id": job_id,
                "job_name": job.get("name"),
                "execution_id": execution_id,
                "source": row.get("source"),
                "scheduled_instant": row.get("scheduled_instant"),
                "status": status,
                "finished_at": row.get("finished_at"),
                "error": row.get("error"),
                "delivery_outcome": row.get("delivery_outcome"),
                "no_agent": bool(job.get("no_agent")),
                "receipt": "unavailable",
            }
            if status != "unknown" and not job.get("no_agent"):
                receipt = _admission_receipt(session_db, job_id, execution_id)
                result = _exact_result(session_db, receipt) if receipt else None
                if result is not None:
                    success, _output, answer, error = result[:4]
                    answer_text = str(answer or "")
                    entry.update({
                        "receipt": "exact",
                        "success": bool(success),
                        "answer": answer_text,
                        "result_error": error,
                        "silent": bool(_is_cron_silence_response and answer_text.strip()
                                       and _is_cron_silence_response(answer_text)),
                    })
            observed.append(entry)
    return {"executions": observed, "jobs": states}


# --- terminal completions ------------------------------------------------------------------------

def process_producer_key(profile: str | None, event: dict[str, Any]) -> str:
    return f"hermes-process:{profile or 'default'}:{event.get('session_id') or ''}:{event.get('started_at') or ''}"


def drain_owned_completions(loaded_session_ids: set[str]) -> list[tuple[dict[str, Any], str]]:
    """Owned ``type=completion`` events via the native drain (other types stay queued)."""
    if not loaded_session_ids:
        return []
    from tools.process_registry import process_registry

    def owns(evt: dict[str, Any]) -> bool:
        return evt.get("type") == "completion" and str(evt.get("session_key") or "") in loaded_session_ids

    try:
        return list(process_registry.drain_notifications(owns_event=owns, skip_poll_observed=False))
    except TypeError:
        return []


IMMEDIATE_EXIT_GRACE_SECONDS = 1.0


def _unrecovered_exits(loaded_session_ids: set[str], emitted_keys: set[str], republished_keys: set[str],
                       profile: str | None):
    """Exited, flagged, unconsumed records of loaded sessions whose completion was never emitted."""
    from tools.process_registry import process_registry
    if not callable(getattr(process_registry, "_publish_finished", None)):
        return
    for session_id in loaded_session_ids:
        try:
            entries = process_registry.list_sessions(session_key=session_id)
        except Exception:
            continue
        for entry in entries or []:
            if not isinstance(entry, dict) or entry.get("status") != "exited" or not entry.get("notify_on_complete"):
                continue
            proc = process_registry.get(str(entry.get("session_id") or ""))
            if proc is None or str(getattr(proc, "session_key", "") or "") != session_id:
                continue
            key = process_producer_key(profile, {"session_id": proc.id, "started_at": proc.started_at})
            if key in emitted_keys or key in republished_keys or completion_consumed(proc.id):
                continue
            yield session_id, proc, key


def republish_missed_completions(loaded_session_ids: set[str], emitted_keys: set[str],
                                 republished_keys: set[str], profile: str | None) -> int:
    """Recover the immediate-exit race from live registry records.

    The terminal tool flags ``notify_on_complete`` on the record after spawning, so a process
    that exits first is finished without a completion event. An exited, flagged, unconsumed
    record that was never emitted is republished once through the registry's own publisher;
    any duplicate with the same producer key is dropped before it reaches Studio.
    """
    if not loaded_session_ids:
        return 0
    from tools.process_registry import process_registry
    now = time.time()
    republished = 0
    for _session_id, proc, key in list(_unrecovered_exits(loaded_session_ids, emitted_keys, republished_keys, profile)):
        if now - float(getattr(proc, "exited_at", None) or now) < IMMEDIATE_EXIT_GRACE_SECONDS:
            continue
        republished_keys.add(key)
        process_registry._publish_finished(proc, True)
        republished += 1
    return republished


def completion_consumed(process_id: str) -> bool:
    from tools.process_registry import process_registry
    checker = getattr(process_registry, "is_completion_consumed", None)
    return bool(checker(process_id)) if callable(checker) else False


def notify_pending_session_ids(loaded_session_ids: set[str], emitted_keys: set[str] = frozenset(),
                               republished_keys: set[str] = frozenset(), profile: str | None = None) -> list[str]:
    """Loaded sessions with a live ``notify_on_complete`` process, a pending watcher, or an
    immediate exit still awaiting recovery (until it is republished, emitted or consumed)."""
    if not loaded_session_ids:
        return []
    try:
        from tools.process_registry import process_registry
    except Exception:
        return []
    pending: set[str] = set()
    for session_id in loaded_session_ids:
        try:
            entries = process_registry.list_sessions(session_key=session_id)
        except Exception:
            entries = []
        for entry in entries or []:
            if isinstance(entry, dict) and entry.get("notify_on_complete") and entry.get("status") == "running":
                pending.add(session_id)
    for watcher in list(getattr(process_registry, "pending_watchers", []) or []):
        key = str((watcher or {}).get("session_key") or "")
        if key not in loaded_session_ids or not (watcher or {}).get("notify_on_complete"):
            continue
        # The bridge never drains Gateway watcher descriptors; only a still-running process is pending.
        proc = process_registry.get(str((watcher or {}).get("session_id") or ""))
        if proc is not None and not getattr(proc, "exited", False):
            pending.add(key)
    for session_id, _proc, _key in _unrecovered_exits(loaded_session_ids, emitted_keys, republished_keys, profile):
        pending.add(session_id)
    return sorted(pending)


def new_claim_id() -> str:
    return f"studio-process:{os.getpid()}:{uuid.uuid4().hex}"
