import ast
import re
from pathlib import Path

import httpx
import pytest
from fastapi.routing import APIRoute

from app.api.doc_socket import PREFIXE
from app.core.sio import _handlers
from app.core.state import _TYPES_FILE
from app.main import fastapi_app

APP_DIR = Path(__file__).resolve().parents[1] / "app"
SPEC = fastapi_app.openapi()


def _evenements_emis_par_le_serveur() -> set[str]:
    noms: set[str] = set(_TYPES_FILE)
    positions = {"emit_room": 1, "emit_to": 1, "call": 1, "_relayer_ou_mettre_en_file": 2}
    for fichier in APP_DIR.rglob("*.py"):
        for noeud in ast.walk(ast.parse(fichier.read_text("utf8"))):
            if not isinstance(noeud, ast.Call):
                continue
            f = noeud.func
            nom = f.attr if isinstance(f, ast.Attribute) else getattr(f, "id", None)
            i = positions.get(nom)
            if i is None or len(noeud.args) <= i:
                continue
            arg = noeud.args[i]
            if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                noms.add(arg.value)
    return noms


def _operations_socket(methode: str) -> set[str]:
    return {
        chemin[len(PREFIXE) + 1:]
        for chemin, item in SPEC["paths"].items()
        if chemin.startswith(PREFIXE + "/") and methode in item
    }


def test_chaque_evenement_ecoute_est_documente_en_post():
    ecoutes = set(_handlers)
    assert ecoutes - _operations_socket("post") == set()
    assert _operations_socket("post") - ecoutes == set()


def test_chaque_evenement_emis_est_documente_en_get():
    emis = _evenements_emis_par_le_serveur()
    assert emis - _operations_socket("get") == set()
    assert _operations_socket("get") - emis == set()


def test_chaque_route_http_est_documentee():
    for route in fastapi_app.routes:
        if not isinstance(route, APIRoute) or not route.include_in_schema:
            continue
        chemin = route.path.replace(":path", "")
        assert chemin in SPEC["paths"], chemin
        for m in route.methods:
            op = SPEC["paths"][chemin][m.lower()]
            assert op.get("tags") and op.get("summary"), f"{m} {chemin}"


def test_operations_uniques_et_references_valides():
    ids = [op["operationId"] for item in SPEC["paths"].values() for op in item.values()]
    assert len(ids) == len(set(ids))
    schemas = SPEC["components"]["schemas"]
    texte = str(SPEC)
    for ref in set(re.findall(r"#/components/schemas/([A-Za-z0-9_]+)", texte)):
        assert ref in schemas, ref


@pytest.mark.asyncio
async def test_swagger_servi(serveur):
    async with httpx.AsyncClient(base_url=serveur) as http:
        assert (await http.get("/docs")).status_code == 200
        spec = (await http.get("/openapi.json")).json()
        assert f"{PREFIXE}/robot_drive" in spec["paths"]
        r = await http.post(f"{PREFIXE}/robot_drive")
        assert r.status_code == 400 and "socket.emit('robot_drive'" in r.json()["erreur"]



def test_websocket_capteur_documente():
    op = SPEC["paths"]["/ws/capteur"]["get"]
    assert {p["name"] for p in op["parameters"]} == {"code", "session", "cle"}
    types = {SPEC["components"]["schemas"][r["$ref"].rsplit("/", 1)[1]]["properties"]["type"]["const"]
             for r in op["responses"]["101"]["content"]["application/json"]["schema"]["oneOf"]}
    assert types == {"bonjour", "ack", "erreur"}
    assert "Capteur : protocole robot → serveur" in SPEC["info"]["description"]
