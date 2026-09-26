"""Shared configuration; importing this module never fetches remote secrets."""

import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))
from Data.config import load_config

config = load_config()
AGENT_PHONE_NUMBER = config.get('GUAVA_AGENT_NUMBER') or config.get('MANGO_AGENT_NUMBER', '')
SENDER_NAME = config.get('SENDER_NAME', 'Mango')
ORGANIZATION = config.get('ORGANIZATION', 'Mango Industries')
