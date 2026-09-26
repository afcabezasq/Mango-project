"""Offline contract tests: confirmed intake through scheduled delivery."""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

from test_python_listener import FakeCall, PROFILE, START, END
from main import Listener
from calendar_access import CalendarAccess
from Data import db

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'Caller'))
from task_store import TaskStore, MessageTask
from scheduler import poll_once, run_task
from delivery_agent import build_delivery_agent


class MemoryPostgrest:
    """Implement the client's actual REST filters under a transaction lock."""
    def __init__(self):
        self.rows = {}
        self.lock = threading.Lock()

    def __call__(self, endpoint, method='GET', data=None, extra_headers=None):
        with self.lock:
            query = parse_qs(urlsplit(endpoint).query)
            if method == 'POST':
                row = {**data, 'id': str(len(self.rows) + 1)}
                self.rows[row['id']] = row
                return [dict(row)]
            rows = list(self.rows.values())
            for key, values in query.items():
                if key in ('id', 'status'):
                    rows = [r for r in rows if str(r[key]) == values[0].removeprefix('eq.')]
                if key == 'date':
                    bound = datetime.fromisoformat(values[0].removeprefix('lte.'))
                    rows = [r for r in rows if datetime.fromisoformat(r['date']) <= bound]
            if method == 'PATCH':
                for row in rows:
                    row.update(data)
            return [dict(r) for r in rows]


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.transport = MemoryPostgrest()
        network = patch('Data.db._request', side_effect=self.transport)
        network.start()
        self.addCleanup(network.stop)
        self.calendar = Mock()
        self.calendar.account_id.return_value = 'owner'
        self.calendar.available.return_value = True
        def book(**kw):
            self.assertEqual(self.transport.rows['1']['status'], 'awaiting_calendar')
            return {'id': hashlib.sha256(kw['request_id'].encode()).hexdigest()}
        self.calendar.book.side_effect = book
        self.listener = Listener(PROFILE, self.calendar)
        self.call = FakeCall('appointment')
        self.listener.complete(self.call, 'intent')
        self.call.fields.update({'title_1':'Review', 'name_1':'Test Person', 'start_1':START, 'end_1':END,
                                'recipient_phone_1':'+12025550123', 'reminder_at_1':'event_start'})

    def confirm(self):
        self.listener.complete(self.call, 'details_1')
        self.call.fields['confirmed_1'] = 'yes'
        self.listener.complete(self.call, 'confirm_1')

    def test_booking_is_saved_before_google_and_calls_only_when_due(self):
        self.listener.complete(self.call, 'details_1')
        self.assertFalse(self.transport.rows)
        self.confirm()
        self.listener.complete(self.call, 'confirm_1')
        self.assertEqual(len(self.transport.rows), 1)
        row = self.transport.rows['1']
        self.assertEqual((row['status'], row['date']), ('pending', START))
        self.assertEqual(json.loads(row['task'])['calendar']['account'], 'owner')
        store = TaskStore()
        self.assertEqual(store.claim_due(), [])
        row['date'] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        tasks = store.claim_due()
        self.assertEqual(len(tasks), 1)
        fake_agent = Mock()
        def build(task, outcome):
            outcome.update(delivered=True, result='delivered')
            return fake_agent
        with patch.dict(os.environ, {'DELIVERY_MODE':'call'}), patch('delivery_agent.AGENT_PHONE_NUMBER', '+12025550100'), patch('delivery_agent.build_delivery_agent', side_effect=build):
            run_task(store, tasks[0])
        fake_agent.call_phone.assert_called_once_with(from_number='+12025550100', to_number='+12025550123')
        self.assertEqual(row['status'], 'done')
        self.assertEqual(json.loads(row['task'])['result'], 'delivered')
        self.assertEqual(store.claim_due(), [])

    def test_custom_reminder_time_is_used_not_event_start(self):
        chosen = (datetime.fromisoformat(START) - timedelta(hours=1)).isoformat()
        self.call.fields['reminder_at_1'] = chosen
        self.confirm()
        self.assertEqual(self.transport.rows['1']['date'], chosen)

    def test_decline_writes_nothing(self):
        self.listener.complete(self.call, 'details_1')
        self.call.fields['confirmed_1'] = 'no'
        self.listener.complete(self.call, 'confirm_1')
        self.assertFalse(self.transport.rows)
        self.calendar.book.assert_not_called()

    def test_google_failure_leaves_held_row_not_deliverable(self):
        self.calendar.book.side_effect = RuntimeError('private details')
        self.confirm()
        self.assertEqual(self.transport.rows['1']['status'], 'awaiting_calendar')
        self.assertEqual(TaskStore().claim_due(), [])
        self.assertIn('could not verify', self.call.hangup.call_args.args[0])
        self.assertNotIn('private details', self.call.hangup.call_args.args[0])

    def test_failed_insert_never_touches_google(self):
        with patch('supabase_tasks.add_task', side_effect=RuntimeError('DB unavailable')):
            self.confirm()
        self.calendar.book.assert_not_called()

    def test_failed_activation_does_not_claim_success_or_retry_booking(self):
        with patch('supabase_tasks.update_task_status', return_value=[]):
            self.confirm()
        self.listener.complete(self.call, 'confirm_1')
        self.calendar.book.assert_called_once()
        self.assertEqual(self.transport.rows['1']['status'], 'awaiting_calendar')
        self.assertIn('could not verify', self.call.hangup.call_args.args[0])

    def test_two_schedulers_only_one_claims_a_due_task(self):
        self.confirm()
        self.transport.rows['1']['date'] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        barrier = threading.Barrier(2)
        def concurrent_request(endpoint, **kwargs):
            result = self.transport(endpoint, **kwargs)
            if kwargs.get('method', 'GET') == 'GET':
                barrier.wait(timeout=3)
            return result
        with patch('Data.db._request', side_effect=concurrent_request), ThreadPoolExecutor(2) as pool:
            counts = list(pool.map(lambda _: len(db.claim_due_tasks()), range(2)))
        self.assertEqual(sorted(counts), [0, 1])

    def test_preview_never_claims_finishes_or_calls(self):
        store, submit = Mock(), Mock()
        store.due_preview.return_value = [{'id':'1'}]
        self.assertEqual(poll_once(store, submit, dry_run=True), 1)
        store.claim_due.assert_not_called()
        store.finish.assert_not_called()
        submit.assert_not_called()

    def test_delivery_sdk_registers_handlers_without_starting_a_call(self):
        task = MessageTask('Test Recipient', '+12025550123', 'Synthetic reminder', START)
        self.assertIsNotNone(build_delivery_agent(task, {}))

    def test_malformed_tasks_never_fall_back_to_now_or_caller_phone(self):
        for date in ('nonsense', '2030-01-01T00:00:00'):
            with self.assertRaises(ValueError):
                MessageTask('Name', '+12025550123', 'message', date)
        db.add_task('+12025550123', 'not JSON', '2020-01-01T00:00:00+00:00')
        self.assertEqual(TaskStore().claim_due(), [])
        self.assertEqual(self.transport.rows['1']['status'], 'failed')


class AccessTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.file = Path(temporary.name) / 'access.json'
        helper = Path(__file__).resolve().parents[2] / 'FrontEnd/ui/google-connection.js'
        subprocess.run(['node', '--input-type=module', '-e',
                        "const {calendarAccessRecord,saveConnection}=await import(process.argv[1]); saveConnection(process.argv[2],calendarAccessRecord('owner','12345678'));",
                        helper.as_uri(), str(self.file)], check=True, capture_output=True)
        self.access = CalendarAccess(self.file)
        self.calendar = Mock()
        self.calendar.account_id.return_value = 'owner'
        self.calendar.appointments.return_value = {'items':[{'summary':'Private appointment','start':{'date':'2030-01-01'},'end':{'date':'2030-01-02'}}], 'nextPageToken':'next'}
        self.listener = Listener(PROFILE, self.calendar, access=self.access)

    def read(self, code):
        call = FakeCall('read_calendar')
        self.listener.complete(call, 'intent')
        call.fields.update({'start_1':START, 'end_1':END, 'access_code_1':code})
        self.listener.complete(call, 'details_1')
        return call

    def test_real_ui_hash_is_verified_and_bound_to_google_account(self):
        self.assertTrue(self.access.verify('owner', '12345678'))
        self.assertFalse(self.access.verify('someone-else', '12345678'))
        self.assertNotIn('12345678', self.file.read_text())

    def test_wrong_code_never_reads_and_account_limit_applies_across_calls(self):
        for _ in range(5):
            self.read('87654321')
        self.read('12345678')
        self.calendar.appointments.assert_not_called()

    def test_verified_read_includes_all_day_events_and_pagination_without_code(self):
        call = self.read('12345678')
        self.calendar.appointments.assert_called_once_with(START, END, 'owner')
        returned = call.add_info.call_args.args[1]
        self.assertTrue(returned['more_available'])
        self.assertEqual(returned['events'][0]['start'], {'date':'2030-01-01'})
        self.assertNotIn('12345678', json.dumps(returned))
        fields = call.set_task.call_args.kwargs['checklist']
        self.assertTrue(next(f for f in fields if f.key == 'access_code_1').sensitive)
