"""Obtain the Moodle Web Services token (official mobile-app service).

Two flows:

1) SSO (Microsoft/Google) — e.g. Unisinos. There is no local password, so we
   use the browser flow (launch.php): the script opens a browser, you log in
   normally, and it captures the `moodlemobile://token=...` redirect.

2) Local password — only if your account has a password directly in Moodle:
   --username and --password.

It then validates the token and writes MOODLE_URL/MOODLE_TOKEN into .env.

Modes:
  --browser   automatic capture via Playwright (recommended for SSO)
  --paste     decode a moodlemobile://token=... URL you already captured
  (default)   print the launch.php link and read the pasted URL from stdin
"""

from __future__ import annotations

import argparse
import base64
import re
import sys
from pathlib import Path

import requests

# The Windows console is often cp1252 and cannot print emoji/accents — force UTF-8.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass

LAUNCH_PATH = (
    "/admin/tool/mobile/launch.php"
    "?service=moodle_mobile_app&passport=1&urlscheme=moodlemobile"
)

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_ENV = _PROJECT_ROOT / ".env"


def decode_token(pasted: str) -> str:
    """Extract the token from a moodlemobile://token=BASE64 URL (or raw base64).

    Moodle returns base64 of 'signature:::TOKEN[:::PRIVATETOKEN]'. If the input
    already looks like a bare token, it is returned as-is.
    """
    s = pasted.strip()
    s = re.sub(r"^moodlemobile://token=", "", s, flags=re.IGNORECASE).strip()

    try:
        padded = s + "=" * (-len(s) % 4)
        raw = base64.b64decode(padded).decode("utf-8", "replace")
        if ":::" in raw:
            return raw.split(":::")[1]
    except Exception:
        pass
    return s


def password_flow(base: str, username: str, password: str) -> str:
    """Get the token via /login/token.php (works only with a local password)."""
    url = base.rstrip("/") + "/login/token.php"
    resp = requests.get(
        url,
        params={
            "username": username,
            "password": password,
            "service": "moodle_mobile_app",
        },
        timeout=30,
    )
    data = resp.json()
    if "token" in data:
        return data["token"]
    raise SystemExit(
        f"Failed ({data.get('errorcode', '?')}): {data.get('error', data)}\n"
        "If your account is SSO (Microsoft/Google), use the browser flow "
        "(run with --browser, or without --username/--password)."
    )


def browser_flow(base: str, timeout: int = 300) -> str:
    """Open a browser, let you log in (SSO) and capture the token automatically.

    Intercepts the `moodlemobile://token=...` redirect that launch.php emits at
    the end, via several channels (Location header, request URL, navigation and
    page content). Returns the captured string for decode_token to handle.
    Requires Playwright (`pip install -e ".[browser]"`).
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise SystemExit(
            "Playwright is not installed. Run:\n"
            '  pip install -e ".[browser]"\n'
            "  python -m playwright install chromium"
        )

    launch_url = base.rstrip("/") + LAUNCH_PATH
    pattern = re.compile(r"moodlemobile://token=([A-Za-z0-9+/=_-]+)")
    captured = {"url": None}

    def grab(text):
        if not text or captured["url"]:
            return
        match = pattern.search(text)
        if match:
            captured["url"] = "moodlemobile://token=" + match.group(1)

    def on_response(response):
        try:
            grab(response.headers.get("location", ""))
            grab(response.url)
        except Exception:
            pass

    print("\nOpening the browser... log in normally with your institution")
    print("(Microsoft, with MFA if any). The token is captured automatically.\n")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=False)
        context = browser.new_context()
        context.on("response", on_response)
        context.on("request", lambda r: grab(r.url))
        context.on("requestfailed", lambda r: grab(r.url))

        page = context.new_page()
        page.on("framenavigated", lambda frame: grab(frame.url))

        try:
            page.goto(launch_url, wait_until="commit")
        except Exception:
            pass  # the custom-scheme redirect may throw — that's fine

        for _ in range(max(1, int(timeout / 0.7))):
            if captured["url"]:
                break
            try:
                grab(page.url)
                grab(page.content())
            except Exception:
                pass
            try:
                page.wait_for_timeout(700)
            except Exception:
                break  # window closed by the user

        try:
            browser.close()
        except Exception:
            pass

    if not captured["url"]:
        raise SystemExit(
            "Could not capture the token (timed out or login not completed).\n"
            'Try again, or use the manual flow: --paste "moodlemobile://token=..."'
        )
    print("Token captured!")
    return captured["url"]


def verify(base: str, token: str) -> dict:
    """Confirm the token by calling core_webservice_get_site_info."""
    endpoint = base.rstrip("/") + "/webservice/rest/server.php"
    resp = requests.post(
        endpoint,
        data={
            "wstoken": token,
            "wsfunction": "core_webservice_get_site_info",
            "moodlewsrestformat": "json",
        },
        timeout=30,
    )
    data = resp.json()
    if isinstance(data, dict) and data.get("exception"):
        raise SystemExit(
            f"Invalid token: [{data.get('errorcode')}] {data.get('message')}"
        )
    return data


def write_env(base: str, token: str, path: Path) -> None:
    content = f"MOODLE_URL={base.rstrip('/')}\nMOODLE_TOKEN={token}\n"
    path.write_text(content, encoding="utf-8")


def _prompt_browser_flow(base: str) -> str:
    print("\n=== SSO flow (Microsoft/Google) ===")
    print("1) Open this link in your browser (already logged in at your school):\n")
    print("   " + base.rstrip("/") + LAUNCH_PATH + "\n")
    print("2) Log in normally. At the end the browser will TRY to open a link")
    print("   'moodlemobile://token=...'. You may see an 'open app' prompt or an")
    print("   error — that's fine. To capture the link:")
    print("     - Chrome/Edge: press F12 > Network tab > tick 'Preserve log',")
    print("       redo step 1, find the 'launch.php' request and copy its")
    print("       response 'Location' (starts with moodlemobile://token=).")
    print("     - Or, if the browser shows the link in the address bar, copy it.\n")
    return input("3) Paste the moodlemobile://token=... here (or just the token): ").strip()


def main():
    parser = argparse.ArgumentParser(
        description="Fetch and save the Moodle token (official mobile-app service)."
    )
    parser.add_argument(
        "--url",
        required=True,
        help="Moodle base URL, e.g. https://www.moodle.unisinos.br",
    )
    parser.add_argument(
        "--browser",
        action="store_true",
        help="Automatic capture via Playwright (opens a browser; best for SSO)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=300,
        help="(--browser) seconds to wait for the login (default 300)",
    )
    parser.add_argument("--username", help="(local password) Moodle username")
    parser.add_argument("--password", help="(local password) Moodle password")
    parser.add_argument(
        "--paste",
        help="A moodlemobile://token=... URL (or the token), if you already have it",
    )
    parser.add_argument(
        "--env",
        default=str(_DEFAULT_ENV),
        help=f"Where to save it (default: {_DEFAULT_ENV})",
    )
    args = parser.parse_args()
    base = args.url

    if args.username and args.password:
        token = password_flow(base, args.username, args.password)
    elif args.browser:
        token = decode_token(browser_flow(base, timeout=args.timeout))
    else:
        pasted = args.paste or _prompt_browser_flow(base)
        if not pasted:
            raise SystemExit("Nothing pasted. Aborting.")
        token = decode_token(pasted)

    info = verify(base, token)
    env_path = Path(args.env)
    write_env(base, token, env_path)

    print(f"\n✅ Token OK! Logged in as: {info.get('fullname')} ({info.get('username')})")
    print(f"   Site: {info.get('sitename')}  |  Moodle {info.get('release')}")
    print(f"   Functions available to your token: {len(info.get('functions', []))}")
    print(f"   Saved to: {env_path}")


if __name__ == "__main__":
    main()
