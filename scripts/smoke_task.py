import json
import sys
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


payload = {
    "agent": "claude",
    "profileId": "default",
    "cwd": "/home/ubuntu/projects",
    "title": "deploy smoke test",
    "project": "smoke",
    "prompt": "Reply with exactly: profile deepseek ok",
}

created = request_json("http://127.0.0.1:3000/api/tasks", payload)
task_id = created["id"]
print(f"task {task_id}")

last_status = None
task = None
for _ in range(60):
    data = request_json(f"http://127.0.0.1:3000/api/tasks/{task_id}")
    task = data["task"]
    if task["status"] != last_status:
        print(f"status {task['status']}")
        last_status = task["status"]
    if task["status"] not in ("queued", "running"):
        break
    time.sleep(2)

if task is None:
    print("task was not read", file=sys.stderr)
    sys.exit(1)

stdout = (task.get("stdout") or "").strip()
stderr = (task.get("stderr") or "").strip()
print(f"final {task['status']} exit {task.get('exitCode')}")
print("stdout", stdout[-500:])
print("stderr", stderr[-500:])

if task["status"] != "succeeded" or "profile deepseek ok" not in stdout:
    sys.exit(1)
