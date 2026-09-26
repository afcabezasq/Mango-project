"""Google Calendar access using the account connected in Archery's FrontEnd UI."""

import hashlib
import json
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

FRONTEND = Path(__file__).resolve().parents[1] / "FrontEnd"
if str(FRONTEND.parent) not in sys.path:
    sys.path.insert(0, str(FRONTEND.parent))
from Data.config import load_config
CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar"
API = "https://www.googleapis.com/calendar/v3"


class CalendarError(Exception):
    pass


def timestamp(value):
    result = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("A date, time and UTC offset are required.")
    return result


def _http(url, method="GET", payload=None, headers=None):
    data = json.dumps(payload).encode() if payload is not None else None
    request = Request(url, data=data, method=method,
                      headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urlopen(request, timeout=15) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        return error.code, {}  # Never forward provider bodies, headers or tokens.


class GoogleCalendar:
    """One UI-connected owner per local installation; callers cannot select another account."""

    def __init__(self, token_file=None):
        self.token_file = Path(token_file or FRONTEND / ".mango-data/google_tokens.json")
        self._lock = threading.RLock()
        self._cache = None
        config = load_config()
        self._client_id = config.get("GOOGLE_CLIENT_ID")
        self._client_secret = config.get("GOOGLE_CLIENT_SECRET")

    def _record(self, expected_account=None):
        try:
            record = json.loads(self.token_file.read_text())
            account = record["user"]["sub"]
            if not account or (expected_account and account != expected_account):
                raise CalendarError("The UI account changed. Reconfirm the appointment with the correct account connected.")
            if CALENDAR_SCOPE not in record.get("scopes", "").split():
                raise CalendarError("Reconnect Google in the UI and grant Calendar access.")
            return record
        except CalendarError:
            raise
        except Exception:
            raise CalendarError("Connect Google Calendar through the FrontEnd UI first.") from None

    def account_id(self):
        return self._record()["user"]["sub"]

    def _access_token(self, record, force_refresh=False):
        version = hashlib.sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()
        if self._cache is None or self._cache[0] != version:
            self._cache = [version, record["tokens"].get("access_token"), record.get("expiresAt", 0) / 1000]
        if force_refresh or self._cache[2] <= time.time() + 30:
            if not (record["tokens"].get("refresh_token") and self._client_id and self._client_secret
                    and record.get("clientId") == self._client_id):
                raise CalendarError("Google access expired. Reconnect in the UI or configure its OAuth client for refresh.")
            data = urlencode({"grant_type": "refresh_token", "refresh_token": record["tokens"]["refresh_token"],
                              "client_id": self._client_id, "client_secret": self._client_secret}).encode()
            request = Request("https://oauth2.googleapis.com/token", data=data,
                              headers={"Content-Type": "application/x-www-form-urlencoded"})
            with urlopen(request, timeout=15) as response:
                tokens = json.load(response)
            self._cache = [version, tokens["access_token"], time.time() + tokens["expires_in"]]
        return self._cache[1]

    def _request(self, path, account, method="GET", payload=None):
        record = self._record(account)  # Honor UI disconnect/account changes on every operation.
        for attempt in range(2):
            token = self._access_token(record, force_refresh=attempt == 1)
            status, data = _http(API + path, method, payload, {"Authorization": f"Bearer {token}"})
            if status != 401:
                return status, data
        raise CalendarError("Google access was revoked. Reconnect through the UI.")

    def available(self, start, end, account):
        with self._lock:
            try:
                if timestamp(end) <= timestamp(start):
                    raise CalendarError("The appointment end must be after its start.")
                status, data = self._request("/freeBusy", account, "POST",
                                             {"timeMin": start, "timeMax": end, "items": [{"id": "primary"}]})
                result = data.get("calendars", {}).get("primary", {})
                if status != 200 or result.get("errors") or not isinstance(result.get("busy"), list):
                    raise CalendarError("Calendar availability could not be verified. Do not promise this time.")
                return not result["busy"]
            except CalendarError:
                raise
            except Exception:
                raise CalendarError("Calendar availability could not be verified. Try again later.") from None

    def appointments(self, start, end, account):
        """Owner-side helper; never expose appointment titles to an unverified phone caller."""
        with self._lock:
            try:
                if timestamp(end) <= timestamp(start):
                    raise ValueError()
                query = urlencode({"timeMin": start, "timeMax": end, "singleEvents": "true",
                                   "orderBy": "startTime", "maxResults": 20,
                                   "fields": "items(id,summary,start,end),nextPageToken"})
                status, data = self._request("/calendars/primary/events?" + query, account)
                if status != 200:
                    raise ValueError()
                return data
            except CalendarError:
                raise
            except Exception:
                raise CalendarError("Appointments could not be read. Reconnect Google through the UI if needed.") from None

    def book(self, summary, start, end, request_id, account, *, confirmed=False):
        if confirmed is not True:
            raise CalendarError("The caller must confirm the exact appointment before booking.")
        with self._lock:
            try:
                if not summary.strip() or timestamp(start) <= datetime.now(timezone.utc) or timestamp(end) <= timestamp(start):
                    raise CalendarError("Provide a title and a valid future appointment time.")
                event_id = hashlib.sha256(request_id.encode()).hexdigest()
                path = f"/calendars/primary/events/{event_id}"
                status, event = self._request(path, account)
                if status == 404:
                    if not self.available(start, end, account):
                        raise CalendarError("That time is no longer available. Ask for another time.")
                    status, event = self._request("/calendars/primary/events?sendUpdates=none", account, "POST",
                                                 {"id": event_id, "summary": summary,
                                                  "start": {"dateTime": start}, "end": {"dateTime": end}})
                    if status == 409:
                        status, event = self._request(path, account)
                if (status not in (200, 201) or event.get("status") == "cancelled" or event.get("id") != event_id
                        or event.get("summary") != summary or timestamp(event["start"]["dateTime"]) != timestamp(start)
                        or timestamp(event["end"]["dateTime"]) != timestamp(end)):
                    raise CalendarError("Could not confirm the booking. Check the UI calendar before trying again.")
                return {"id": event_id, "start": start, "end": end}
            except CalendarError:
                raise
            except Exception:
                raise CalendarError("Could not confirm the booking. Check the calendar before retrying.") from None
