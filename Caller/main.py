"""Compatibility entrypoint: all intake now uses the calendar-aware Listener."""

import sys
from pathlib import Path

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'scheduler':
        from scheduler import main
        main()
    else:
        import runpy
        listener = Path(__file__).resolve().parents[1] / 'Listener'
        sys.path.insert(0, str(listener))
        if len(sys.argv) > 1 and sys.argv[1] in ('phone', 'local', 'chat', 'webrtc'):
            sys.argv[1:2] = ['--mode', sys.argv[1]]
        runpy.run_path(str(listener / 'main.py'), run_name='__main__')
