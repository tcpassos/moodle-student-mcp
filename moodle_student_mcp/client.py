"""Minimal REST client for the Moodle Web Services API.

Authenticates with a token from the official mobile-app service
(`moodle_mobile_app`), acting with the student's own permissions.
"""

from __future__ import annotations

from pathlib import Path

import requests


class MoodleError(RuntimeError):
    """Error returned by the Moodle API (the `exception` field)."""

    def __init__(self, errorcode: str, message: str):
        self.errorcode = errorcode
        self.message = message
        super().__init__(f"[{errorcode}] {message}")


def _flatten(value, parent_key: str = "") -> dict:
    """Encode nested dict/list params the way Moodle expects: a[0][b]=c."""
    items: dict = {}
    if isinstance(value, dict):
        iterator = value.items()
    elif isinstance(value, (list, tuple)):
        iterator = enumerate(value)
    else:
        return {parent_key: value}

    for key, val in iterator:
        new_key = f"{parent_key}[{key}]" if parent_key else str(key)
        if isinstance(val, (dict, list, tuple)):
            items.update(_flatten(val, new_key))
        elif isinstance(val, bool):
            items[new_key] = 1 if val else 0
        elif val is not None:
            items[new_key] = val
    return items


class MoodleClient:
    """Thin wrapper over /webservice/rest/server.php."""

    def __init__(self, base_url: str, token: str, timeout: int = 30):
        base = base_url.rstrip("/")
        if base.endswith("/webservice/rest/server.php"):
            self.endpoint = base
            self.base_url = base[: -len("/webservice/rest/server.php")]
        else:
            self.endpoint = base + "/webservice/rest/server.php"
            self.base_url = base
        self.token = token
        self.timeout = timeout
        self._session = requests.Session()
        self._userid: int | None = None

    def call(self, wsfunction: str, **params):
        """Call a web service function and return the validated JSON."""
        data = {
            "wstoken": self.token,
            "wsfunction": wsfunction,
            "moodlewsrestformat": "json",
        }
        data.update(_flatten(params))
        resp = self._session.post(self.endpoint, data=data, timeout=self.timeout)
        resp.raise_for_status()
        result = resp.json()
        if isinstance(result, dict) and result.get("exception"):
            raise MoodleError(
                result.get("errorcode", "unknown"),
                result.get("message", "unknown error"),
            )
        return result

    def download(self, fileurl: str, dest: Path) -> int:
        """Download a Moodle file (pluginfile URL) to `dest`, returning bytes.

        Moodle file URLs require the token appended as a query param. If the
        server answers with a JSON error instead of the file, raise MoodleError.
        """
        separator = "&" if "?" in fileurl else "?"
        url = f"{fileurl}{separator}token={self.token}"
        resp = self._session.get(url, timeout=self.timeout, stream=True)
        resp.raise_for_status()

        if "application/json" in resp.headers.get("content-type", ""):
            data = resp.json()
            if isinstance(data, dict) and data.get("exception"):
                raise MoodleError(
                    data.get("errorcode", "unknown"),
                    data.get("message", "could not download file"),
                )

        dest.parent.mkdir(parents=True, exist_ok=True)
        total = 0
        with open(dest, "wb") as handle:
            for chunk in resp.iter_content(chunk_size=65536):
                handle.write(chunk)
                total += len(chunk)
        return total

    @property
    def userid(self) -> int:
        """The student's userid (from core_webservice_get_site_info, cached)."""
        if self._userid is None:
            info = self.call("core_webservice_get_site_info")
            self._userid = info["userid"]
        return self._userid
