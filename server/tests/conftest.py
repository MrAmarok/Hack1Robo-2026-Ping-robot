import os
import socket
import tempfile
import threading
import time

_TMP = tempfile.mkdtemp(prefix="ping-tests-")
os.environ.setdefault("ENV_FILE", os.path.join(_TMP, "absent.env"))
os.environ["ALERTES_DIR"] = os.path.join(_TMP, "alertes")
os.environ["ALERTES_FICHIER"] = os.path.join(_TMP, "alertes.json")
os.environ["PUSH_FICHIER"] = os.path.join(_TMP, "push-tokens.json")
os.environ["REC_DIR"] = os.path.join(_TMP, "rec")
os.environ["REC_DOSSIER"] = os.path.join(_TMP, "rec")
os.environ["MTX_HTTP_PORT"] = "1"
os.environ["CAPTEUR_DIR"] = os.path.join(_TMP, "capteur")
for _cle in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPGRAM_API_KEY", "TELEGRAM_TOKEN",
             "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"):
    os.environ.pop(_cle, None)

import pytest


def _port_libre() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def serveur():
    import uvicorn

    from app.main import app

    port = _port_libre()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    srv = uvicorn.Server(config)
    t = threading.Thread(target=srv.run, daemon=True)
    t.start()
    for _ in range(100):
        if srv.started:
            break
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    srv.should_exit = True
    t.join(timeout=5)
