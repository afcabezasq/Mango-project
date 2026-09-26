"""Shared constants for the intake and delivery agents, loaded directly from Supabase Vault."""

import sys
from pathlib import Path

# Add project root to sys.path so Data module can be imported
ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

try:
    from Data.db import get_secret
    AGENT_PHONE_NUMBER = get_secret("GUAVA_AGENT_NUMBER") or get_secret("MANGO_AGENT_NUMBER") or "+14849902853"
    SENDER_NAME = get_secret("SENDER_NAME") or "Andres Felipe"
    ORGANIZATION = get_secret("ORGANIZATION") or "Mango Ai"
except Exception:
    import os
    AGENT_PHONE_NUMBER = os.environ.get("GUAVA_AGENT_NUMBER", "+14849902853")
    SENDER_NAME = os.environ.get("SENDER_NAME", "Andres Felipe")
    ORGANIZATION = os.environ.get("ORGANIZATION", "Mango Ai")