"""Supabase Database & Vault Client for Mango Agent.
Configuration comes from the shared root .env or environment; values are never logged.
"""

import json
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .config import load_config

config = load_config()
SUPABASE_URL = config.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = (config.get("SUPABASE_SERVICE_ROLE_KEY") or config.get("SUPABASE_SECRET_KEY")
                or config.get("SUPABASE_PUBLISHABLE_KEY") or config.get("SUPABASE_ANON_KEY", ""))

_SECRETS_CACHE: Dict[str, str] = {}


def _request(endpoint: str, method: str = "GET", data: Optional[Dict[str, Any]] = None, extra_headers: Optional[Dict[str, str]] = None) -> Any:
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("Configure SUPABASE_URL and a server-side Supabase key.")
    url = f"{SUPABASE_URL}/rest/v1/{endpoint}"
    headers = {
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
    }
    if SUPABASE_KEY.startswith("eyJ"):
        headers["Authorization"] = f"Bearer {SUPABASE_KEY}"
    if extra_headers:
        headers.update(extra_headers)

    body_bytes = json.dumps(data).encode("utf-8") if data is not None else None
    req = urllib.request.Request(url, data=body_bytes, headers=headers, method=method)
    
    with urllib.request.urlopen(req, timeout=15) as resp:
        content = resp.read()
        if not content:
            return None
        return json.loads(content.decode("utf-8"))


# ============================================================================
# Secrets Management (From Supabase Vault via RPC)
# ============================================================================

def get_all_secrets(force_refresh: bool = False) -> Dict[str, str]:
    """Retrieve all secrets directly from Supabase Vault."""
    global _SECRETS_CACHE
    if _SECRETS_CACHE and not force_refresh:
        return _SECRETS_CACHE

    res = _request("rpc/get_all_secrets", method="POST", data={})
    if isinstance(res, list):
        _SECRETS_CACHE = {row["name"]: row["secret"] for row in res}
    return _SECRETS_CACHE


def get_secret(name: str, default: Optional[str] = None) -> Optional[str]:
    """Retrieve a single secret by name directly from Supabase Vault."""
    secrets = get_all_secrets()
    return secrets.get(name, default)


# ============================================================================
# Tasks Database Operations (Single table: public.tasks)
# ============================================================================

def add_task(caller: str, task: str, scheduled_date: Optional[str] = None, status: str = "pending") -> Dict[str, Any]:
    """Insert a new task into the single Supabase tasks table (caller, date, task, status)."""
    if not scheduled_date:
        scheduled_date = datetime.now(timezone.utc).isoformat()
    
    payload = {
        "caller": caller,
        "date": scheduled_date,
        "task": task,
        "status": status,
    }
    res = _request("tasks", method="POST", data=payload, extra_headers={"Prefer": "return=representation"})
    if isinstance(res, list) and len(res) > 0:
        return res[0]
    raise RuntimeError("Supabase did not confirm a saved task ID.")


def get_tasks(status: Optional[str] = None, limit: int = 50) -> List[Dict[str, Any]]:
    """Retrieve tasks from the single Supabase tasks table."""
    params = ["select=*"]
    if status:
        params.append(f"status=eq.{urllib.parse.quote(status)}")
    params.append(f"limit={limit}")
    params.append("order=date.desc")
    
    endpoint = f"tasks?{'&'.join(params)}"
    res = _request(endpoint, method="GET")
    return res if isinstance(res, list) else []


def claim_due_tasks(limit: int = 10) -> List[Dict[str, Any]]:
    """Compare-and-set each due row; only the winning scheduler receives it."""
    now_iso = urllib.parse.quote(datetime.now(timezone.utc).isoformat())
    due_tasks = _request(f"tasks?select=*&status=eq.pending&date=lte.{now_iso}&order=date.asc&limit={int(limit)}")
    claimed = []
    for task in due_tasks or []:
        task_id = urllib.parse.quote(str(task["id"]), safe="")
        rows = _request(f"tasks?id=eq.{task_id}&status=eq.pending&date=lte.{now_iso}",
                        method="PATCH", data={"status": "in_progress"},
                        extra_headers={"Prefer": "return=representation"})
        if rows:
            claimed.extend(rows)
    return claimed


def update_task_status(task_id: str, status: str, *, expected_status=None, task=None):
    """Return changed rows, permitting conditional state transitions."""
    endpoint = f"tasks?id=eq.{urllib.parse.quote(str(task_id), safe='')}"
    if expected_status:
        endpoint += f"&status=eq.{urllib.parse.quote(expected_status, safe='')}"
    data = {"status": status}
    if task is not None:
        data["task"] = task
    return _request(endpoint, method="PATCH", data=data,
                    extra_headers={"Prefer": "return=representation"}) or []
