"""Shared local configuration. Environment overrides files; never log values."""

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_config():
    values = {}
    for file in (ROOT / '.env', ROOT / 'FrontEnd/.env', ROOT / 'FrontEnd/ui/.env'):
        if file.exists():
            for line in file.read_text().splitlines():
                key, separator, value = line.strip().partition('=')
                if separator and key and not key.startswith('#'):
                    values[key] = value.strip().strip("\"'")
    return {**values, **os.environ}
