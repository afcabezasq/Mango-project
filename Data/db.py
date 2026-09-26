"""Supabase Database & Vault Client for Mango Agent.
All secrets and tasks are retrieved directly from Supabase, with ZERO reliance on local .env files.
"""

import json
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

SUPABASE_URL = "https://ddiotzmdaugryfrfdxxr.supabase.co"
SUPABASE_KEY = "sb_publishable_SRljIma0oj5744D5ggKQ7A_3IoLAp6D"

_SECRETS_CACHE: Dict[str, str] = {}


def _request(endpoint: str, method: str = "GET", data: Optional[Dict[str, Any]] = None, extra_headers: Optional[Dict[str, str]] = None) -> Any:
    url = f"{SUPABASE_URL}/rest/v1/{endpoint}"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }
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
    return payload


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
    """Find pending tasks that are due, update their status to in_progress, and return them."""
    now_iso = datetime.now(timezone.utc).isoformat()
    endpoint = f"tasks?select=*&status=eq.pending&date=lte.{urllib.parse.quote(now_iso)}&order=date.asc&limit={limit}"
    due_tasks = _request(endpoint, method="GET")
    
    claimed = []
    if isinstance(due_tasks, list):
        for t in due_tasks:
            update_task_status(t["id"], "in_progress")
            claimed.append({**t, "status": "in_progress"})
    return claimed


def update_task_status(task_id: str, status: str) -> None:
    """Update task status in Supabase tasks table."""
    endpoint = f"tasks?id=eq.{urllib.parse.quote(task_id)}"
    _request(endpoint, method="PATCH", data={"status": status})
