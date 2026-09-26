import hashlib
import io
import json
import subprocess
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from calendar_service import GoogleCalendar, CalendarError, CALENDAR_SCOPE
from main import Listener, build_agent
from supabase_tasks import queue_message

START = (datetime.now(timezone.utc) + timedelta(days=2)).replace(microsecond=0).isoformat()
END = (datetime.now(timezone.utc) + timedelta(days=2, hours=1)).replace(microsecond=0).isoformat()
PROFILE = {"kind": "business", "organization": "Mango Industries", "approvedFacts": [], "instructions": "Confirm details."}


class FakeCall:
    def __init__(self, kind="message"):
        self.id, self.variables = "synthetic-call", {}
        self.call_info = SimpleNamespace(from_number="+12025550111")
        self.fields = {"request_kind": kind}
        for name in ("set_task", "add_info", "retry_task", "hangup"):
            setattr(self, name, Mock())

    def get_variable(self, key, default=None):
        return self.variables.get(key, default)

    def set_variable(self, key, value):
        self.variables[key] = value

    def get_field(self, key):
        return self.fields.get(key)


class ListenerTests(unittest.TestCase):
    def setUp(self):
        self.save, self.calendar = Mock(return_value="saved-row"), Mock()
        self.calendar.account_id.return_value = "google-owner"
        self.calendar.available.return_value = True
        self.booking, self.access = Mock(), Mock()
        self.listener = Listener(PROFILE, self.calendar, self.save, save_booking=self.booking, access=self.access)

    def collect(self, kind="message"):
        call = FakeCall(kind)
        self.listener.start(call)
        self.listener.complete(call, "intent")
        call.fields.update({"recipient_name_1": "Test Recipient", "recipient_phone_1": "+12025550123",
                            "message_1": "Synthetic message", "scheduled_at_1": START,
                            "title_1": "Consultation", "name_1": "Test Visitor", "start_1": START, "end_1": END,
                            "reminder_at_1": "event_start"})
        self.listener.complete(call, "details_1")
        return call

    def test_confirmed_message_is_queued_once_and_never_dials(self):
        call = self.collect()
        self.save.assert_not_called()
        call.fields["confirmed_1"] = "yes"
        self.listener.complete(call, "confirm_1")
        self.listener.complete(call, "details_1")
        self.listener.complete(call, "confirm_1")
        self.save.assert_called_once()
        task = self.save.call_args.args[0]
        self.assertEqual(task["requested_by"], "+12025550111")
        with patch("supabase_tasks.add_task", return_value={"id": "saved-row"}) as add:
            self.assertEqual(queue_message(task), "saved-row")
        payload = add.call_args.kwargs
        self.assertEqual(payload["status"], "pending")
        self.assertEqual(payload["scheduled_date"], START)
        self.assertEqual(json.loads(payload["task"])["recipient_phone"], "+12025550123")
        self.calendar.book.assert_not_called()

    def test_decline_and_hangup_never_save(self):
        call = self.collect()
        call.fields["confirmed_1"] = "no"
        self.listener.complete(call, "confirm_1")
        self.assertEqual(call.get_variable("round"), 2)
        self.listener.ended(call, None)
        self.save.assert_not_called()

    def test_appointment_checks_availability_then_requires_confirmation(self):
        call = self.collect("appointment")
        self.calendar.available.assert_called_once_with(START, END, "google-owner")
        self.calendar.book.assert_not_called()
        call.fields["confirmed_1"] = "yes"
        self.listener.complete(call, "confirm_1")
        self.booking.assert_called_once()
        self.assertEqual(self.booking.call_args.kwargs['reminder']['scheduled_at'], START)
        self.save.assert_not_called()  # Booking uses the held-row workflow, not an immediately pending message.

    def test_invalid_date_reasks_and_busy_time_cannot_reach_confirmation(self):
        call = self.collect()
        call.fields["scheduled_at_1"] = "2026-02-30T12:00:00-05:00"
        self.listener.complete(call, "details_1")
        call.retry_task.assert_called_once()
        self.calendar.available.return_value = False
        appointment = self.collect("appointment")
        appointment.retry_task.assert_called_once()
        self.calendar.book.assert_not_called()

    def test_database_failure_never_claims_success_or_retries(self):
        call = self.collect()
        self.save.side_effect = RuntimeError("private provider details")
        call.fields["confirmed_1"] = "yes"
        self.listener.complete(call, "confirm_1")
        self.listener.complete(call, "confirm_1")
        self.save.assert_called_once()
        self.assertIn("could not verify", call.hangup.call_args.args[0])
        self.assertNotIn("private provider details", call.hangup.call_args.args[0])

    def test_real_sdk_can_register_handlers_without_starting_a_channel(self):
        self.assertIsNotNone(build_agent(PROFILE, calendar=self.calendar, save_message=self.save))


class CalendarTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.file = Path(temporary.name) / "google_tokens.json"
        self.record = {"user": {"sub": "google-owner", "email": "owner@gmail.com"}, "clientId": "test-client",
                       "tokens": {"access_token": "fake-access", "refresh_token": "fake-refresh"},
                       "scopes": CALENDAR_SCOPE, "expiresAt": (time.time() + 3600) * 1000}
        self.file.write_text(json.dumps(self.record))
        self.calendar = GoogleCalendar(self.file)
        self.calendar._client_id, self.calendar._client_secret = "test-client", "fake-client-secret"
        self.network = patch("calendar_service._http")
        self.http = self.network.start()
        self.addCleanup(self.network.stop)
        # Fail closed on unexpected real network calls, including token refresh.
        transport = patch("calendar_service.urlopen", side_effect=AssertionError("Unexpected network"))
        self.transport = transport.start()
        self.addCleanup(transport.stop)
        self.event_id = hashlib.sha256(b"confirmed-request").hexdigest()
        self.event = {"id": self.event_id, "summary": "Consultation", "start": {"dateTime": START}, "end": {"dateTime": END}}

    def book(self, confirmed=True):
        return self.calendar.book("Consultation", START, END, "confirmed-request", "google-owner", confirmed=confirmed)

    def test_ui_tokens_create_one_confirmed_booking_with_no_email_invites(self):
        self.http.side_effect = [(404, {}), (200, {"calendars": {"primary": {"busy": []}}}), (200, self.event)]
        with self.assertRaises(CalendarError):
            self.book(False)
        self.http.assert_not_called()
        self.assertEqual(self.book()["id"], self.event_id)
        insert = self.http.call_args_list[-1].args
        self.assertEqual(insert[1], "POST")
        self.assertNotIn("attendees", insert[2])
        self.assertIn("sendUpdates=none", insert[0])
        self.assertEqual(insert[3]["Authorization"], "Bearer fake-access")
        self.http.side_effect = [(200, self.event)]
        self.assertEqual(self.book()["id"], self.event_id)  # Recover the same event, without another insert.

    def test_busy_or_unverifiable_availability_never_inserts(self):
        for result in ({"busy": [{"start": START, "end": END}]}, {"errors": [{"reason": "forbidden"}]}):
            self.http.side_effect = [(404, {}), (200, {"calendars": {"primary": result}})]
            with self.assertRaises(CalendarError):
                self.book()
        self.assertFalse(any("/events?" in c.args[0] for c in self.http.call_args_list))

    def test_ui_disconnect_account_switch_and_missing_scope_fail_closed(self):
        for change in ({"user": {"sub": "different-owner"}}, {"scopes": "openid email"}):
            self.file.write_text(json.dumps({**self.record, **change}))
            with self.assertRaises(CalendarError):
                self.book()
        self.file.unlink()
        with self.assertRaises(CalendarError):
            self.book()
        self.http.assert_not_called()

    def test_expired_ui_token_refreshes_without_changing_ui_file(self):
        self.record["expiresAt"] = 0
        self.file.write_text(json.dumps(self.record))
        self.transport.side_effect = None
        self.transport.return_value.__enter__.return_value = io.BytesIO(b'{"access_token":"fake-new-access","expires_in":3600}')
        self.http.return_value = (200, {"calendars": {"primary": {"busy": []}}})
        self.assertTrue(self.calendar.available(START, END, "google-owner"))
        self.assertEqual(self.http.call_args.args[3]["Authorization"], "Bearer fake-new-access")
        self.assertEqual(json.loads(self.file.read_text()), self.record)

    def test_google_failure_does_not_expose_provider_details(self):
        self.http.side_effect = RuntimeError("fake-access and private response")
        with self.assertRaises(CalendarError) as caught:
            self.book()
        self.assertNotIn("fake-access", str(caught.exception))

    def test_calendar_reads_expand_recurring_events_and_preserve_all_day_dates(self):
        data = {"items": [{"id": "event", "summary": "All day", "start": {"date": "2030-01-01"},
                           "end": {"date": "2030-01-02"}}], "nextPageToken": "next"}
        self.http.return_value = (200, data)
        self.assertEqual(self.calendar.appointments(START, END, "google-owner"), data)
        url, method = self.http.call_args.args[:2]
        self.assertIn("singleEvents=true", url)
        self.assertIn("orderBy=startTime", url)
        self.assertEqual(method, "GET")

    def test_actual_frontend_writer_produces_a_connection_python_can_use(self):
        helper = Path(__file__).resolve().parents[2] / "FrontEnd/ui/google-connection.js"
        source = """
          const {connectionRecord, saveConnection} = await import(process.argv[1]);
          saveConnection(process.argv[2], connectionRecord(
            {access_token:'fake-ui-access', expires_in:3600, scope:'https://www.googleapis.com/auth/calendar'},
            {sub:'google-owner',email:'owner@gmail.com',email_verified:true}, 'test-client'));
        """
        subprocess.run(["node", "--input-type=module", "-e", source, helper.as_uri(), str(self.file)], check=True, capture_output=True)
        self.http.return_value = (200, {"calendars": {"primary": {"busy": []}}})
        self.assertTrue(self.calendar.available(START, END, self.calendar.account_id()))
        self.assertEqual(self.http.call_args.args[3]["Authorization"], "Bearer fake-ui-access")


if __name__ == "__main__":
    unittest.main()
