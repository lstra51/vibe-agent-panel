import json
import os
import signal
import time
import urllib.request


def request_json(url, payload=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST" if payload is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


created = request_json("http://127.0.0.1:3000/api/profiles/default/codex-login/start", {})
session_id = created["sessionId"]
pid = created.get("pid")
time.sleep(3)
session = request_json(f"http://127.0.0.1:3000/api/profiles/default/codex-login/{session_id}")["session"]
print(json.dumps({"sessionId": session_id, "pid": pid, "status": session.get("status"), "outputPreview": session.get("output", "")[:220]}))

if pid:
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass

if not session_id or session.get("status") not in ("running", "succeeded", "finished"):
    raise SystemExit(1)
