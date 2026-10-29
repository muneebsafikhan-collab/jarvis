"""
JARVIS - personal voice assistant for Windows.

Runs a small local server (only on this computer) and opens the JARVIS
screen in Chrome. Uses only Python's built-in libraries - nothing to install.

Start it with:  python server.py   (or double-click start_jarvis.bat)
"""

import json
import os
import platform
import re
import shutil
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import io
import socket
import zipfile

HOST = "127.0.0.1"
PORT = 8765
GITHUB_REPO = "muneebsafikhan-collab/jarvis"
GITHUB_BRANCH = "main"
RESTART_CODE = 3  # start_jarvis.bat starts JARVIS again when it exits with this code

# Some networks have broken IPv6, which makes Python hang. Try IPv4 first.
_getaddrinfo = socket.getaddrinfo
def _ipv4_first(*args, **kwargs):
    return sorted(_getaddrinfo(*args, **kwargs), key=lambda r: r[0] != socket.AF_INET)
socket.getaddrinfo = _ipv4_first
BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"
# Settings live in your user folder, so updating JARVIS never loses your key.
DATA_DIR = Path.home() / ".jarvis"
DATA_DIR.mkdir(exist_ok=True)
CONFIG_FILE = DATA_DIR / "config.json"
REMINDERS_FILE = DATA_DIR / "reminders.json"
for _name in ("config.json", "reminders.json"):  # move files from older versions
    if (BASE_DIR / _name).exists() and not (DATA_DIR / _name).exists():
        try:
            os.replace(BASE_DIR / _name, DATA_DIR / _name)
        except OSError:
            pass
IS_WINDOWS = sys.platform.startswith("win")

PROVIDERS = {
    "gemini": {
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "model": "gemini-flash-lite-latest",
        "backup": ["gemini-flash-latest", "gemini-3.5-flash-lite"],
    },
    "openrouter": {
        "base_url": "https://openrouter.ai/api/v1",
        "model": "openrouter/auto",
    },
    "openai": {
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-4o-mini",
    },
}

DEFAULT_CONFIG = {
    "name": "Muneeb",
    "provider": "gemini",
    "api_key": "",
    "base_url": PROVIDERS["gemini"]["base_url"],
    "model": PROVIDERS["gemini"]["model"],
    "language": "en-US",
}

lock = threading.Lock()


# ---------------------------------------------------------------- storage

def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(path, data):
    tmp = Path(str(path) + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def get_config():
    cfg = dict(DEFAULT_CONFIG)
    cfg.update(load_json(CONFIG_FILE, {}))
    return cfg


# ---------------------------------------------------------------- actions

HOME = Path.home()
FOLDERS = {
    "desktop": HOME / "Desktop",
    "downloads": HOME / "Downloads",
    "documents": HOME / "Documents",
    "pictures": HOME / "Pictures",
    "music": HOME / "Music",
    "videos": HOME / "Videos",
    "home": HOME,
    "c": Path("C:/"),
    "d": Path("D:/"),
    "e": Path("E:/"),
}

APPS = {
    "notepad": "notepad.exe",
    "calculator": "calc.exe",
    "paint": "mspaint.exe",
    "explorer": "explorer.exe",
    "file explorer": "explorer.exe",
    "cmd": "cmd.exe",
    "command prompt": "cmd.exe",
    "task manager": "taskmgr.exe",
    "settings": "ms-settings:",
    "control panel": "control.exe",
    "chrome": "chrome",
    "edge": "msedge",
    "word": "winword",
    "excel": "excel",
    "powerpoint": "powerpnt",
    "outlook": "outlook",
    "vlc": "vlc",
    "whatsapp": "whatsapp:",
    "camera": "microsoft.windows.camera:",
    "calendar": "outlookcal:",
    "store": "ms-windows-store:",
}

SITES = {
    "youtube": "https://www.youtube.com",
    "google": "https://www.google.com",
    "gmail": "https://mail.google.com",
    "github": "https://github.com",
    "facebook": "https://www.facebook.com",
    "tiktok": "https://www.tiktok.com",
    "whatsapp web": "https://web.whatsapp.com",
    "chatgpt": "https://chatgpt.com",
    "claude": "https://claude.ai",
    "railway": "https://railway.app",
    "maps": "https://maps.google.com",
}


def _start(target):
    if IS_WINDOWS:
        os.startfile(target)  # noqa: works only on Windows
    else:
        webbrowser.open(str(target))


def run_action(action):
    """Run one allowed action. Returns a short result text (English)."""
    if not isinstance(action, dict):
        return None
    kind = str(action.get("type", "")).strip()
    value = str(action.get("value", "")).strip()
    try:
        if kind == "open_site":
            url = SITES.get(value.lower())
            if not url:
                if not re.match(r"^https?://", value):
                    value = "https://" + value
                url = value
            webbrowser.open(url)
            return f"Opened {url}"
        if kind == "search_youtube":
            webbrowser.open("https://www.youtube.com/results?search_query=" + urllib.parse.quote(value))
            return f"Searched YouTube for {value}"
        if kind == "search_google":
            webbrowser.open("https://www.google.com/search?q=" + urllib.parse.quote(value))
            return f"Searched Google for {value}"
        if kind == "open_folder":
            key = value.lower().rstrip(":\\/ ").replace(" drive", "")
            path = FOLDERS.get(key)
            if path is None or not path.exists():
                return f"Folder not found: {value}"
            _start(str(path))
            return f"Opened folder {path}"
        if kind == "open_app":
            exe = APPS.get(value.lower())
            if not exe:
                return f"I don't know the app: {value}"
            _start(exe)
            return f"Opened {value}"
        if kind == "add_reminder":
            minutes = float(action.get("minutes", 0) or 0)
            text = str(action.get("text", value) or "Reminder")
            if minutes <= 0:
                return "Reminder time missing"
            due = time.time() + minutes * 60
            with lock:
                items = load_json(REMINDERS_FILE, [])
                items.append({"id": int(time.time() * 1000), "text": text, "due": due, "done": False})
                save_json(REMINDERS_FILE, items)
            return f"Reminder set for {datetime.fromtimestamp(due):%H:%M}: {text}"
    except Exception as e:  # keep JARVIS running whatever happens
        return f"Could not do that: {e}"
    return None


# ---------------------------------------------------------------- AI brain

history = []


def system_prompt(cfg):
    now = datetime.now()
    return (
        "You are JARVIS, a smart, friendly personal voice assistant running on "
        f"{cfg.get('name') or 'the user'}'s Windows desktop computer. "
        f"Current local time: {now:%A %d %B %Y, %H:%M}. "
        "Always reply in the SAME language the user spoke (English, Persian/Dari, Urdu, Hindi, Pashto...). "
        "Keep spoken answers short: 1-3 sentences, no markdown, no emojis, no lists. "
        "You can control the computer. Reply with ONLY a JSON object, nothing else:\n"
        '{"say": "what to say out loud", "actions": [ ... ]}\n'
        "Allowed actions (use [] if none):\n"
        '{"type":"open_site","value":"youtube|google|gmail|github|facebook|tiktok|whatsapp web|chatgpt|claude|railway|maps or a full URL"}\n'
        '{"type":"search_youtube","value":"search words"}\n'
        '{"type":"search_google","value":"search words"}\n'
        '{"type":"open_folder","value":"desktop|downloads|documents|pictures|music|videos|home|c|d|e"}\n'
        '{"type":"open_app","value":"' + "|".join(APPS.keys()) + '"}\n'
        '{"type":"add_reminder","minutes":10,"text":"what to remind"}\n'
        "For a reminder at a clock time, compute minutes from the current time. "
        "Never invent other action types."
    )


def ai_request(text, cfg):
    """Build the AI request. Chrome sends it (Python can be blocked by some networks)."""
    messages = [{"role": "system", "content": system_prompt(cfg)}] + history[-10:] + [
        {"role": "user", "content": text}
    ]
    return {
        "url": cfg["base_url"].rstrip("/") + "/chat/completions",
        "key": cfg["api_key"],
        "body": {"model": cfg["model"], "messages": messages, "temperature": 0.4},
        "backup": [m for m in PROVIDERS.get(cfg.get("provider"), {}).get("backup", []) if m != cfg["model"]],
    }


def parse_reply(content):
    content = content.strip()
    content = re.sub(r"^```(?:json)?|```$", "", content, flags=re.M).strip()
    m = re.search(r"\{.*\}", content, flags=re.S)
    if m:
        try:
            obj = json.loads(m.group(0))
            say = str(obj.get("say", "")).strip()
            actions = obj.get("actions") or []
            if isinstance(actions, dict):
                actions = [actions]
            return say, [a for a in actions if isinstance(a, dict)]
        except ValueError:
            pass
    return content, []


# Simple commands that work even without an AI key.
def quick_command(text):
    t = text.lower().strip()
    now = datetime.now()
    if re.search(r"\b(what time|time is it|current time)\b", t) or t in {"time", "ساعت", "ساعت چند است", "ساعت چنده"}:
        return f"It is {now:%H:%M}.", []
    if re.search(r"\b(what.?s the date|today.?s date|what day)\b", t) or t in {"date", "تاریخ"}:
        return f"Today is {now:%A, %d %B %Y}.", []
    m = re.match(r"^(?:search|play)\s+(.+?)\s+on\s+youtube$", t)
    if m:
        return f"Searching YouTube for {m.group(1)}.", [{"type": "search_youtube", "value": m.group(1)}]
    m = re.match(r"^(?:open|launch|start)\s+(.+)$", t)
    if m:
        name = m.group(1).strip().removesuffix(" folder").strip()
        if name in SITES:
            return f"Opening {name}.", [{"type": "open_site", "value": name}]
        if name in APPS:
            return f"Opening {name}.", [{"type": "open_app", "value": name}]
        if name in FOLDERS or name.replace(" drive", "") in FOLDERS:
            return f"Opening {name}.", [{"type": "open_folder", "value": name}]
    for name in SITES:
        if name in t and ("باز" in t or "کھول" in t or "खोल" in t):
            return "", [{"type": "open_site", "value": name}]
    if "یوتیوب" in t or "یوٹیوب" in t:
        return "", [{"type": "open_site", "value": "youtube"}]
    return None


def remember(text, say):
    history.extend([{"role": "user", "content": text}, {"role": "assistant", "content": say}])
    del history[:-20]


def finish(text, say, actions):
    results = [r for r in (run_action(a) for a in actions[:5]) if r]
    if not say and results:
        say = "Done."
    remember(text, say)
    return {"say": say, "results": results}


def handle_command(text):
    cfg = get_config()
    text = text.strip()
    if not text:
        return {"say": "", "results": []}
    quick = quick_command(text)
    if quick and quick[0]:
        return finish(text, *quick)
    if cfg.get("api_key"):
        return {"ask_ai": ai_request(text, cfg), "fallback": quick[1] if quick else []}
    if quick:
        return finish(text, *quick)
    return finish(text, (
        "I can open apps, sites and folders and tell the time now. "
        "To talk about anything, add an AI key in Settings."
    ), [])


def handle_ai_reply(text, content, fallback):
    say, actions = parse_reply(str(content or ""))
    if not actions and isinstance(fallback, list):
        actions = [a for a in fallback if isinstance(a, dict)]
    return finish(text, say, actions)


# ---------------------------------------------------------------- system info

cpu_percent = 0.0
weather_cache = {"time": 0, "data": None}


def _cpu_sampler():
    global cpu_percent
    if not IS_WINDOWS:
        return
    import ctypes
    from ctypes import wintypes

    def times():
        idle, kernel, user = wintypes.FILETIME(), wintypes.FILETIME(), wintypes.FILETIME()
        ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user))
        f = lambda ft: (ft.dwHighDateTime << 32) | ft.dwLowDateTime
        return f(idle), f(kernel), f(user)

    prev = times()
    while True:
        time.sleep(2)
        cur = times()
        idle = cur[0] - prev[0]
        total = (cur[1] - prev[1]) + (cur[2] - prev[2])
        if total > 0:
            cpu_percent = round(max(0.0, min(100.0, (1 - idle / total) * 100)), 1)
        prev = cur


def memory_info():
    if IS_WINDOWS:
        import ctypes

        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("sullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        s = MEMORYSTATUSEX()
        s.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(s))
        return s.dwMemoryLoad, round(s.ullTotalPhys / 1024**3, 1)
    try:
        info = {}
        for line in open("/proc/meminfo"):
            k, v = line.split(":")
            info[k] = int(v.split()[0])
        used = 100 - info["MemAvailable"] * 100 / info["MemTotal"]
        return round(used), round(info["MemTotal"] / 1024**2, 1)
    except Exception:
        return 0, 0


def system_status():
    mem, total = memory_info()
    disks = []
    for letter in ("C", "D", "E"):
        root = f"{letter}:\\" if IS_WINDOWS else ("/" if letter == "C" else None)
        if root and os.path.exists(root):
            u = shutil.disk_usage(root)
            disks.append({"name": letter, "percent": round(u.used * 100 / u.total), "free_gb": round(u.free / 1024**3)})
    return {
        "cpu": cpu_percent,
        "memory": mem,
        "memory_total_gb": total,
        "disks": disks,
        "computer": platform.node(),
        "os": f"{platform.system()} {platform.release()}",
    }


def weather():
    if time.time() - weather_cache["time"] < 900 and weather_cache["data"]:
        return weather_cache["data"]
    try:
        req = urllib.request.Request("https://wttr.in/?format=j1", headers={"User-Agent": "curl/8"})
        with urllib.request.urlopen(req, timeout=10) as r:
            d = json.loads(r.read().decode("utf-8"))
        cur = d["current_condition"][0]
        area = d.get("nearest_area", [{}])[0]
        data = {
            "temp": cur.get("temp_C"),
            "feels": cur.get("FeelsLikeC"),
            "humidity": cur.get("humidity"),
            "desc": cur.get("weatherDesc", [{}])[0].get("value", ""),
            "city": area.get("areaName", [{}])[0].get("value", ""),
        }
        weather_cache.update(time=time.time(), data=data)
        return data
    except Exception:
        return weather_cache["data"] or {}


def due_reminders():
    now = time.time()
    with lock:
        items = load_json(REMINDERS_FILE, [])
        due = [r for r in items if not r.get("done") and r.get("due", 0) <= now]
        if due:
            for r in due:
                r["done"] = True
            items = [r for r in items if not r.get("done") or r.get("due", 0) > now - 86400]
            save_json(REMINDERS_FILE, items)
        upcoming = sorted((r for r in items if not r.get("done")), key=lambda r: r["due"])
    return {
        "due": [{"text": r["text"]} for r in due],
        "upcoming": [{"text": r["text"], "at": datetime.fromtimestamp(r["due"]).strftime("%H:%M")} for r in upcoming[:5]],
    }


# ---------------------------------------------------------------- updates

def local_version():
    try:
        return int((BASE_DIR / "version.txt").read_text().strip())
    except (OSError, ValueError):
        return 0


def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": "JARVIS-updater", "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def check_update():
    url = f"https://raw.githubusercontent.com/{GITHUB_REPO}/{GITHUB_BRANCH}/version.txt?t={int(time.time())}"
    try:
        latest = int(fetch(url, 15).decode().strip())
    except Exception as e:
        return {"current": local_version(), "latest": None, "available": False, "error": str(e)[:200]}
    return {"current": local_version(), "latest": latest, "available": latest > local_version()}


SKIP_ON_UPDATE = {"start_jarvis.bat", ".gitignore"}  # the .bat is running, never overwrite it


def apply_update():
    data = fetch(f"https://codeload.github.com/{GITHUB_REPO}/zip/refs/heads/{GITHUB_BRANCH}", 60)
    changed = 0
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = [n for n in z.namelist() if not n.endswith("/")]
        prefix = names[0].split("/")[0] + "/" if names else ""
        for name in names:
            rel = name[len(prefix):]
            if not rel or rel in SKIP_ON_UPDATE or rel.startswith(".github/"):
                continue
            target = (BASE_DIR / rel).resolve()
            if BASE_DIR != target and BASE_DIR not in target.parents:
                continue  # never write outside the JARVIS folder
            content = z.read(name)
            if target.exists() and target.read_bytes() == content:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            tmp = target.with_name(target.name + ".new")
            tmp.write_bytes(content)
            os.replace(tmp, target)
            changed += 1
    return changed


def restart_soon():
    def _go():
        time.sleep(0.8)
        print("Restarting JARVIS with the new version...")
        os._exit(RESTART_CODE)
    threading.Thread(target=_go, daemon=True).start()


# ---------------------------------------------------------------- web server

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # keep the black window quiet

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 100_000:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except ValueError:
            return {}

    def _same_origin(self):
        # Only the JARVIS page itself may send commands (blocks other websites).
        origin = self.headers.get("Origin")
        return origin in (None, f"http://{HOST}:{PORT}", f"http://localhost:{PORT}") and self.headers.get("X-Jarvis") == "1"

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/status":
            return self._json({"system": system_status(), "reminders": due_reminders()})
        if path == "/api/update":
            return self._json(check_update())
        if path == "/api/weather":
            return self._json(weather())
        if path == "/api/config":
            cfg = get_config()
            key = cfg.get("api_key", "")
            cfg["api_key"] = ""
            cfg["has_key"] = bool(key)
            cfg["key_hint"] = ("…" + key[-4:]) if len(key) > 8 else ""
            cfg["providers"] = PROVIDERS
            return self._json(cfg)
        if path == "/":
            path = "/index.html"
        file = (WEB_DIR / path.lstrip("/")).resolve()
        if WEB_DIR not in file.parents or not file.is_file():
            self.send_error(404)
            return
        data = file.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(file.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if not self._same_origin():
            return self._json({"error": "forbidden"}, 403)
        path = urllib.parse.urlparse(self.path).path
        data = self._body()
        if path == "/api/command":
            return self._json(handle_command(str(data.get("text", ""))[:2000]))
        if path == "/api/ai-reply":
            return self._json(handle_ai_reply(str(data.get("text", ""))[:2000], data.get("content"), data.get("fallback")))
        if path == "/api/config":
            cfg = get_config()
            for k in ("name", "provider", "base_url", "model", "language", "voice_rtl", "voice_en"):
                if k in data and isinstance(data[k], str):
                    cfg[k] = data[k].strip()
            if isinstance(data.get("api_key"), str) and data["api_key"].strip():
                cfg["api_key"] = data["api_key"].strip()
            if data.get("clear_key"):
                cfg["api_key"] = ""
            save_json(CONFIG_FILE, cfg)
            return self._json({"ok": True})
        if path == "/api/update":
            try:
                changed = apply_update()
            except Exception as e:
                return self._json({"ok": False, "error": str(e)[:300]})
            restart_soon()
            return self._json({"ok": True, "changed": changed, "version": local_version()})
        if path == "/api/clear":
            history.clear()
            return self._json({"ok": True})
        self._json({"error": "not found"}, 404)


def make_shortcuts():
    """Put a JARVIS icon on the Desktop and in the Start menu (Windows)."""
    if not IS_WINDOWS:
        return
    import subprocess

    q = lambda p: "'" + str(p).replace("'", "''") + "'"
    bat, ico = BASE_DIR / "start_jarvis.bat", WEB_DIR / "jarvis.ico"
    ps = (
        "$w = New-Object -ComObject WScript.Shell; "
        "foreach ($f in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) { "
        "$s = $w.CreateShortcut((Join-Path $f 'JARVIS.lnk')); "
        f"$s.TargetPath = {q(bat)}; $s.WorkingDirectory = {q(BASE_DIR)}; "
        f"$s.IconLocation = {q(str(ico) + ',0')}; $s.WindowStyle = 7; "
        "$s.Description = 'JARVIS voice assistant'; $s.Save() }"
    )
    try:
        subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
            capture_output=True, timeout=30, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception as e:
        print("Could not create the desktop icon:", e)


def main():
    threading.Thread(target=make_shortcuts, daemon=True).start()
    threading.Thread(target=_cpu_sampler, daemon=True).start()
    threading.Thread(target=weather, daemon=True).start()
    server = None
    for _ in range(10):  # after an update the old copy may need a moment to close
        try:
            server = ThreadingHTTPServer((HOST, PORT), Handler)
            break
        except OSError:
            time.sleep(0.5)
    if server is None:
        print("JARVIS is already running. Opening it...")
        webbrowser.open(f"http://{HOST}:{PORT}")
        return
    url = f"http://{HOST}:{PORT}"
    print("=" * 50)
    print(f"  JARVIS (version {local_version()}) is running at", url)
    print("  Keep this window open. Close it to stop JARVIS.")
    print("=" * 50)
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
