"""
HTTP run-trigger for the TEE agent — the auto-trigger path.

aa-backend calls POST /v1/runs with {"consentId": ...} the moment a
consent goes ACTIVE, instead of someone SSHing into the TEE VM and running
agent.py by hand. Shaped like pfm-fiu-backend's Airlock client (POST
/v1/runs, GET /v1/runs/:id, poll until status is completed/failed) so both
backends talk to their agent the same way — just pointed at our own TEE
instead of Octic's Airlock API.

Stdlib only: this container never needs to parse untrusted traffic beyond
one JSON body, so a dependency like Flask/FastAPI isn't worth the extra
image surface.
"""
import json
import os
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from run import run_for_consent

PORT = int(os.environ.get("PORT", "8081"))

runs: dict[str, dict] = {}
lock = threading.Lock()


def execute(run_id: str, consent_id: str) -> None:
    try:
        result = run_for_consent(consent_id)
        with lock:
            runs[run_id] = {"status": "completed", "consentId": consent_id, "result": result}
    except Exception as e:  # noqa: BLE001
        with lock:
            runs[run_id] = {"status": "failed", "consentId": consent_id, "error": str(e)}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self) -> None:
        if self.path != "/v1/runs":
            return self._send(404, {"error": "not found"})
        length = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        consent_id = body.get("consentId")
        if not consent_id:
            return self._send(400, {"error": "consentId required"})
        run_id = str(uuid.uuid4())
        with lock:
            runs[run_id] = {"status": "running", "consentId": consent_id}
        threading.Thread(target=execute, args=(run_id, consent_id), daemon=True).start()
        self._send(202, {"id": run_id, "status": "running"})

    def do_GET(self) -> None:
        prefix = "/v1/runs/"
        if not self.path.startswith(prefix):
            return self._send(404, {"error": "not found"})
        run_id = self.path[len(prefix):]
        run = runs.get(run_id)
        if not run:
            return self._send(404, {"error": "unknown run id"})
        self._send(200, run)

    def log_message(self, fmt: str, *args) -> None:
        print(f"[tee-agent] {self.address_string()} {fmt % args}", flush=True)


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"TEE agent run-trigger listening on :{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
