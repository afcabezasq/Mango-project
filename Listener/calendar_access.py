"""Verify the UI-created calendar access code without storing plaintext codes."""

import hashlib
import hmac
import json
import re
import threading
import time
from pathlib import Path

from calendar_service import FRONTEND


class CalendarAccess:
    def __init__(self, file=None):
        self.file = Path(file or FRONTEND / '.mango-data/calendar_access.json')
        self.failures = {}
        self.lock = threading.Lock()

    def verify(self, account, code):
        # Account-wide limit also stops repeated calls from evading a per-call limit.
        with self.lock:
            now = time.monotonic()
            attempts = [t for t in self.failures.get(account, []) if now - t < 900]
            if len(attempts) >= 5:
                return False
            valid = False
            try:
                record = json.loads(self.file.read_text())
                if record['account'] == account and re.fullmatch(r'[0-9]{8,12}', code):
                    candidate = hashlib.pbkdf2_hmac('sha256', code.encode(), bytes.fromhex(record['salt']), 210000).hex()
                    valid = hmac.compare_digest(candidate, record['hash'])
            except (OSError, ValueError, KeyError, TypeError):
                pass
            self.failures[account] = [] if valid else [*attempts, now]
            return valid
