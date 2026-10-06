#!/usr/bin/env python3
"""The bot's home screen and app launcher, served on this computer at 127.0.0.1:7600.

Chrome's new-tab page points here (see bops-desktop), so every new tab on a bot's screen opens
its branded home screen: mascot, clock, and the computer's real apps. Clicking an app launches it
on the screen it was clicked from: each screen's Chrome has its own profile (/root/profiles/sNNN),
so the requesting process tells us the display. Bops can also launch apps over the tailnet with
an explicit ?display=.
"""
import configparser, glob, json, os, re, subprocess, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = "/opt/bops/desktop"
# Settings panels, helpers, and second entries for the same app (xfce aliases) don't belong on a home screen.
SKIP = re.compile(r"settings|preferences|handler|bulk-rename|mimeinfo|python|yad|web-browser|mail-reader|com\.google\.Chrome|^plank$|xfce4-file-manager|xfce4-terminal-emulator|bops-browser|startcenter|xsltfilter|libreoffice-math|libreoffice-base|display-im6|xdg-|gcr-|org\.gnome\.Evince-previewer", re.I)
# Chrome opens in the screen's own profile, so it lands as a window on that screen.
BROWSER = {"google-chrome", "bops-browser"}


def find_icon(name):
    if not name:
        return None
    if name.startswith("/") and os.path.exists(name):
        return name
    for pattern in (
        f"/usr/share/icons/hicolor/scalable/apps/{name}.svg",
        f"/usr/share/icons/hicolor/256x256/apps/{name}.png",
        f"/usr/share/icons/hicolor/128x128/apps/{name}.png",
        f"/usr/share/icons/hicolor/64x64/apps/{name}.png",
        f"/usr/share/icons/hicolor/48x48/apps/{name}.png",
        f"/usr/share/icons/*/scalable/apps/{name}.svg",
        f"/usr/share/icons/*/48x48/apps/{name}.png",
        f"/usr/share/icons/*/*/apps/{name}.svg",
        f"/usr/share/icons/*/*/apps/{name}.png",
        f"/usr/share/pixmaps/{name}.png",
        f"/usr/share/pixmaps/{name}.svg",
        f"/usr/share/pixmaps/{name}.xpm",
    ):
        hits = glob.glob(pattern)
        if hits:
            return hits[0]
    return None


def apps():
    out = []
    for path in sorted(glob.glob("/usr/share/applications/*.desktop")):
        app_id = os.path.basename(path)[:-8]
        if SKIP.search(app_id):
            continue
        cp = configparser.RawConfigParser(strict=False)
        try:
            cp.read(path, encoding="utf-8")
            e = cp["Desktop Entry"]
        except Exception:
            continue
        if e.get("NoDisplay", "false") == "true" or e.get("Type", "Application") != "Application" or "Settings" in e.get("Categories", ""):
            continue
        out.append({"id": app_id, "name": e.get("Name", app_id), "icon": bool(find_icon(e.get("Icon")))})
    return out


def display_of(port):
    """The X display of the Chrome that opened this connection, from its profile directory."""
    try:
        line = subprocess.run(["ss", "-tnpH", f"sport = :{port}"], capture_output=True, text=True).stdout
        pid = re.search(r"pid=(\d+)", line).group(1)
        cmd = open(f"/proc/{pid}/cmdline", "rb").read().decode(errors="ignore")
        m = re.search(r"profiles/s(\d+)", cmd)
        if m:
            return f":{m.group(1)}"
        env = open(f"/proc/{pid}/environ", "rb").read().decode(errors="ignore")
        m = re.search(r"DISPLAY=(:\d+)", env)
        return m.group(1) if m else None
    except Exception:
        return None


def launch(app_id, display):
    if app_id in BROWSER:
        n = display.lstrip(":")
        cmd = ["google-chrome-stable", "--no-sandbox", f"--user-data-dir=/root/profiles/s{n}", "--class=BopsBrowser", "--new-window"]
    else:
        path = f"/usr/share/applications/{app_id}.desktop"
        if not os.path.exists(path):
            return False
        cmd = ["gio", "launch", path] if os.path.exists("/usr/bin/gio") else ["sh", "-c", f"exec $(grep -m1 '^Exec=' {path} | cut -d= -f2- | sed 's/ %[a-zA-Z]//g')"]
    env = dict(os.environ, DISPLAY=display)
    subprocess.Popen(cmd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    return True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path in ("/", "/home"):
            return self.send(200, open(f"{ROOT}/home.html", "rb").read(), "text/html; charset=utf-8")
        if u.path == "/apps":
            return self.send(200, json.dumps(apps()))
        if u.path == "/icon":
            app_id = q.get("id", [""])[0]
            cp = configparser.RawConfigParser(strict=False)
            cp.read(f"/usr/share/applications/{os.path.basename(app_id)}.desktop", encoding="utf-8")
            icon = find_icon(cp["Desktop Entry"].get("Icon") if cp.has_section("Desktop Entry") else None)
            if not icon:
                return self.send(404, "{}")
            ctype = "image/svg+xml" if icon.endswith(".svg") else "image/png"
            return self.send(200, open(icon, "rb").read(), ctype)
        if u.path == "/pointer":
            # Where the pointer is on one screen, streamed as it moves, so Bops can draw the bot's cursor.
            display = q.get("display", [":100"])[0]
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            env = dict(os.environ, DISPLAY=display)
            geo = subprocess.run(["xdotool", "getdisplaygeometry"], env=env, capture_output=True, text=True).stdout.split()
            last = None
            try:
                while True:
                    out = subprocess.run(["xdotool", "getmouselocation", "--shell"], env=env, capture_output=True, text=True).stdout
                    m = dict(line.split("=", 1) for line in out.split() if "=" in line)
                    pos = (m.get("X"), m.get("Y"))
                    if pos != last:
                        last = pos
                        self.wfile.write(f"data: {json.dumps({'x': int(pos[0] or 0), 'y': int(pos[1] or 0), 'w': int(geo[0]), 'h': int(geo[1])})}\n\n".encode())
                        self.wfile.flush()
                    time.sleep(0.12)
            except (BrokenPipeError, ConnectionResetError):
                return
        if u.path == "/activity":
            # When an agent last clicked, typed or scrolled on each screen (screen_mcp notes it), streamed
            # as it happens, so Bops can show the screen being worked on. Times are sent as "seconds ago"
            # so the two clocks never need to agree.
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            seen, quiet = {}, 0.0
            try:
                while True:
                    for path in glob.glob("/root/.bops/activity/[0-9]*"):
                        try:
                            stamp, what = open(path).read().split(" ", 1)
                        except (OSError, ValueError):
                            continue
                        if seen.get(path) != stamp:
                            seen[path] = stamp
                            ago = max(0.0, time.time() - float(stamp))
                            self.wfile.write(f"data: {json.dumps({'display': int(os.path.basename(path)), 'ago': round(ago, 2), 'what': what.strip()})}\n\n".encode())
                            self.wfile.flush()
                    quiet += 0.2
                    if quiet >= 15:
                        quiet = 0.0
                        self.wfile.write(b": still here\n\n")
                        self.wfile.flush()
                    time.sleep(0.2)
            except (BrokenPipeError, ConnectionResetError):
                return
        if u.path == "/launch":
            display = q.get("display", [None])[0] or display_of(self.client_address[1])
            ok = bool(display) and launch(os.path.basename(q.get("id", [""])[0]), display)
            return self.send(200 if ok else 400, json.dumps({"ok": ok, "display": display}))
        path = os.path.realpath(f"{ROOT}{u.path}")
        # The extension's signing key never leaves this computer.
        if path.startswith(ROOT) and os.path.isfile(path) and not path.endswith(".pem"):
            ctype = {"png": "image/png", "svg": "image/svg+xml", "css": "text/css", "js": "text/javascript", "crx": "application/x-chrome-extension", "xml": "text/xml", "html": "text/html; charset=utf-8"}.get(path.rsplit(".", 1)[-1], "application/octet-stream")
            return self.send(200, open(path, "rb").read(), ctype)
        self.send(404, "{}")


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 7600), Handler).serve_forever()
