"""Screen MCP: lets an Agents API session see and drive exactly one Orgo screen.

Runs inside the Orgo computer next to `codex exec-server`, one process per screen,
with DISPLAY pinned to that screen (:99 is the boot screen, :100-:102 are extras).
The agent gets its screen back as an image after every action, which mirrors the
native `computer` tool loop. A thread works on its own screen; with multi-agent on, it can claim
free screens for helpers (subagents), who pass their screen number to every tool. The screen
ledger (bops-screens) makes sure no two agents ever drive the same screen.

Usage (stdio, started by the executor):
    DISPLAY=:100 python3 screen_mcp.py stdio --session <bops session id> [--bot <bops bot id>]
"""

import json
import os
import subprocess
import urllib.request
import sys
import tempfile
import time

from mcp.server.fastmcp import FastMCP, Image

DISPLAY = os.environ.get("DISPLAY", ":100")
SETTLE_SECONDS = 0.6
# Screens are numbered 1-4 for agents (displays :100, :101, :102, :99), matching what the user sees in Bops.
SCREEN_DISPLAYS = {1: ":100", 2: ":101", 3: ":102", 4: ":99"}
HOME = next((n for n, d in SCREEN_DISPLAYS.items() if d == DISPLAY), 1)
SESSION = next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--session" and i + 1 < len(sys.argv)), "")
# The bot this thread works for. On a computer it shares with the main bot, its apps secret is its own file.
BOT = next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--bot" and i + 1 < len(sys.argv)), "")

server = FastMCP(f"screen{DISPLAY.replace(':', '-')}")


def _ledger(*args: str) -> str:
    r = subprocess.run(["bops-screens", *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise ValueError(r.stderr.strip() or "screen ledger error")
    return r.stdout.strip()


def _display(screen: int | None) -> str:
    """The display for a screen this thread (or one of its helpers) holds. Defaults to the thread's own."""
    if screen is None or screen == HOME:
        return DISPLAY
    if screen not in SCREEN_DISPLAYS:
        raise ValueError("screens are numbered 1 to 4")
    owner = _ledger("owner", str(screen))
    if not SESSION or owner not in (f"thread:{SESSION}", f"helper:{SESSION}"):
        raise ValueError(f"screen {screen} isn't yours. Use your own screen, or claim_screen to get a free one for a helper.")
    return SCREEN_DISPLAYS[screen]


ACTIVITY = "/root/.bops/activity"


def _xdotool(display: str, *args: str) -> None:
    subprocess.run(["xdotool", *args], check=True, env={**os.environ, "DISPLAY": display})
    _acted(display, args[0])


def _acted(display: str, what: str) -> None:
    """Note that an agent just acted on this screen, so Bops can follow the action (see /activity in bops-home)."""
    try:
        os.makedirs(ACTIVITY, exist_ok=True)
        tmp = f"{ACTIVITY}/.{display.lstrip(':')}.{os.getpid()}"
        with open(tmp, "w") as f:
            f.write(f"{time.time()} {what}")
        os.replace(tmp, f"{ACTIVITY}/{display.lstrip(':')}")
    except OSError:
        pass


def _capture(display: str) -> Image:
    time.sleep(SETTLE_SECONDS)
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        path = f.name
    subprocess.run(["scrot", "--overwrite", path], check=True, env={**os.environ, "DISPLAY": display})
    with open(path, "rb") as f:
        data = f.read()
    os.unlink(path)
    return Image(data=data, format="png")


SCREEN_DOC = " screen: which screen (1-4) to act on; leave it out for your own screen. Helpers always pass the screen they were given."


@server.tool(description="Capture a screen. Coordinates in every other tool use this image's pixels." + SCREEN_DOC)
def screenshot(screen: int | None = None) -> Image:
    return _capture(_display(screen))


@server.tool(description="Click at (x, y). button: left, right or middle. Returns the screen afterwards." + SCREEN_DOC)
def click(x: int, y: int, button: str = "left", double: bool = False, screen: int | None = None) -> Image:
    d = _display(screen)
    code = {"left": "1", "middle": "2", "right": "3"}[button]
    _xdotool(d, "mousemove", str(x), str(y))
    _xdotool(d, "click", "--repeat", "2" if double else "1", code)
    return _capture(d)


@server.tool(description="Move the pointer to (x, y) without clicking, for hover menus." + SCREEN_DOC)
def move(x: int, y: int, screen: int | None = None) -> Image:
    d = _display(screen)
    _xdotool(d, "mousemove", str(x), str(y))
    return _capture(d)


@server.tool(description="Press at the start point, drag to the end point, release." + SCREEN_DOC)
def drag(start_x: int, start_y: int, end_x: int, end_y: int, screen: int | None = None) -> Image:
    d = _display(screen)
    _xdotool(d, "mousemove", str(start_x), str(start_y), "mousedown", "1")
    _xdotool(d, "mousemove", "--sync", str(end_x), str(end_y), "mouseup", "1")
    return _capture(d)


@server.tool(description="Type text into the focused field." + SCREEN_DOC)
def type_text(text: str, screen: int | None = None) -> Image:
    d = _display(screen)
    _xdotool(d, "type", "--delay", "12", "--", text)
    return _capture(d)


@server.tool(description="Press a key or chord in xdotool syntax, e.g. Return, ctrl+l, ctrl+shift+t." + SCREEN_DOC)
def key(keys: str, screen: int | None = None) -> Image:
    d = _display(screen)
    _xdotool(d, "key", "--", keys)
    return _capture(d)


@server.tool(description="Scroll at (x, y). direction: up, down, left or right. amount: wheel clicks." + SCREEN_DOC)
def scroll(x: int, y: int, direction: str = "down", amount: int = 3, screen: int | None = None) -> Image:
    d = _display(screen)
    code = {"up": "4", "down": "5", "left": "6", "right": "7"}[direction]
    _xdotool(d, "mousemove", str(x), str(y))
    _xdotool(d, "click", "--repeat", str(amount), code)
    return _capture(d)


@server.tool(description="Wait for the page to settle, then look again." + SCREEN_DOC)
def wait(seconds: float = 1.0, screen: int | None = None) -> Image:
    time.sleep(min(max(seconds, 0), 10))
    return _capture(_display(screen))


@server.tool()
def claim_screen(task: str = "") -> str:
    """Claim a free screen on this computer for a helper (subagent) and get its number. Call this before creating each helper that needs to use the computer, then tell that helper its screen number and that it must pass screen=<number> to every screen tool. Returns an error if every screen is busy: then do that part yourself or wait for a helper to finish.

    task: what this helper will do, in 2-5 plain words the user will see next to it (e.g. "Gold price on Kitco", "Chicago forecast")."""
    if not SESSION:
        raise ValueError("helpers aren't available in this session")
    n = _ledger("claim", f"helper:{SESSION}")
    display = SCREEN_DISPLAYS[int(n)]
    _note_task(n, task)
    # Make sure the screen has a browser open for the helper.
    probe = subprocess.run(["xdotool", "search", "--onlyvisible", "--classname", "google-chrome"], capture_output=True, env={**os.environ, "DISPLAY": display})
    if not probe.stdout.strip():
        subprocess.run(["bops-chrome", display.lstrip(":")], capture_output=True)
        time.sleep(3)
    return f"Screen {n} is yours to give to one helper. Tell the helper: 'Your screen is {n}. Pass screen={n} to every screen tool; never touch another screen.'"


TASKS = "/root/.bops/screen-tasks.json"
WATCHES = "/root/.bops/watches.json"


def _read(path: str) -> dict:
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}


def _note_task(screen: str, task: str) -> None:
    """Remember what a helper's screen is for, so list_screens can say."""
    tasks = _read(TASKS)
    tasks[str(screen)] = task.strip()[:80]
    with open(TASKS + ".tmp", "w") as f:
        json.dump(tasks, f)
    os.replace(TASKS + ".tmp", TASKS)


def _page(display: str) -> str:
    """The page a screen's browser shows, from its DevTools port (9200 + display number)."""
    try:
        port = 9200 + int(display.lstrip(":"))
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=1.5) as r:
            pages = [t for t in json.load(r) if t.get("type") == "page" and not t.get("url", "").startswith("devtools://")]
    except Exception:
        return "no browser open"
    if not pages:
        return "no page open"
    url, title = pages[0].get("url", ""), pages[0].get("title", "")
    if url.startswith(("chrome://newtab", "chrome-extension:", "http://127.0.0.1:7600")):
        return "the home screen"
    return f'"{title[:70]}" ({url[:90]})' if title else url[:90]


@server.tool()
def list_screens() -> str:
    """What every screen on this computer is doing right now: yours, a helper's (and its job), a screen the user keeps watched (leave it alone), or free, and what page each one shows. Check this before using a screen that isn't yours."""
    claims = json.loads(_ledger("list") or "{}")
    tasks, watches = _read(TASKS), _read(WATCHES)
    lines = []
    for n, display in SCREEN_DISPLAYS.items():
        owner = claims.get(str(n), "")
        if n == HOME and SESSION:
            who = "yours (this thread)"
        elif owner == f"helper:{SESSION}":
            job = " ({})".format(tasks[str(n)]) if tasks.get(str(n)) else ""
            who = "your helper's" + job
        elif owner.startswith("helper:"):
            job = " ({})".format(tasks[str(n)]) if tasks.get(str(n)) else ""
            who = "a helper of another thread" + job + ": leave it alone"
        elif owner.startswith("thread:"):
            who = "another thread's: leave it alone"
        elif owner.startswith("watch:"):
            w = watches.get(str(n), {})
            about = " ({}, for {})".format(w.get("site"), w.get("lookFor")) if w else ""
            who = "watched for the user" + about + ": keep it as it is, don't use it"
        else:
            who = "free"
        lines.append(f"Screen {n}: {who}. Showing {_page(display)}.")
    return "\n".join(lines)


@server.tool()
def release_screen(screen: int) -> str:
    """Give back a screen a helper was using, once that helper has finished, so other work can use it."""
    if screen == HOME:
        return "That's your own screen; it's released when your task ends."
    _ledger("release", f"helper:{SESSION}", str(screen))
    return f"Screen {screen} released."


# The user's apps (Gmail, Calendar, Linear…), through Bops on their Mac. Bops holds the accounts and asks
# the user before anything that sends or changes something; this computer only has the bot's own secret.
APPS = "/opt/bops/apps.json"
if BOT and os.path.exists(f"/opt/bops/apps-{BOT}.json"):
    APPS = f"/opt/bops/apps-{BOT}.json"
TAILSCALE = "/opt/bops/tailscale/tailscale"


def _apps(tool: str, args: dict) -> str:
    try:
        cfg = _read(APPS)
        host, port = cfg["bops"].rsplit(":", 1)
        body = json.dumps({"session": SESSION, "tool": tool, "args": args}).encode()
        head = (
            f"POST /api/apps/call HTTP/1.0\r\nHost: bops\r\nContent-Type: application/json\r\n"
            f"x-bops-key: {cfg['key']}\r\nContent-Length: {len(body)}\r\n\r\n"
        ).encode()
        # The tailnet here is userspace, so the request goes through tailscale's own nc. Stdin stays
        # open until Bops answers (an approval can take the user a while).
        p = subprocess.Popen(
            [TAILSCALE, "--socket=/run/tailscale/tailscaled.sock", "nc", host, port],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
        p.stdin.write(head + body)
        p.stdin.flush()
        # Read until Bops closes the connection; closing our side first would end the request early.
        out = b""
        deadline = time.time() + 20 * 60
        while time.time() < deadline:
            chunk = os.read(p.stdout.fileno(), 65536)
            if not chunk:
                break
            out += chunk
        p.kill()
        status, _, rest = out.partition(b"\r\n\r\n")
        text = rest.decode("utf-8", "replace")
        return text if b" 200 " in status.split(b"\r\n")[0] else f"Bops refused: {text[:200]}"
    except Exception as e:  # noqa: BLE001
        return f"Couldn't reach Bops for apps: {e}"


if os.path.exists(APPS):

    @server.tool()
    def find_app_actions(query: str) -> str:
        """Find the actions you can take in the user's apps (the ones you have access to) for a job, with their exact names and inputs. Call this before use_app."""
        return _apps("find_app_actions", {"query": query})

    @server.tool()
    def use_app(action: str, arguments: dict, account: str = "") -> str:
        """Run one action in the user's apps, e.g. GMAIL_FETCH_EMAILS. Reading runs at once. Anything that sends, creates, changes or pays waits for the user to approve it in Bops. When you have more than one account in that app, set account to its label or name (e.g. "Work")."""
        return _apps("use_app", {"action": action, "arguments": arguments, "account": account or None})


if __name__ == "__main__":
    server.run(transport=sys.argv[1] if len(sys.argv) > 1 else "stdio")
