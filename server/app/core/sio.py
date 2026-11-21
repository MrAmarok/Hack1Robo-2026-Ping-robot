from __future__ import annotations

import asyncio
import inspect
from collections import defaultdict
from typing import Any, Awaitable, Callable

import socketio

from app.core.logs import log

sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",
    ping_interval=25,
    ping_timeout=60,
    max_http_buffer_size=3 * 1024 * 1024,
    logger=False,
    engineio_logger=False,
)

Handler = Callable[[str, Any], Awaitable[Any] | Any]

_handlers: dict[str, list[Handler]] = defaultdict(list)
_connect_handlers: list[Callable[[str, dict], Awaitable[None] | None]] = []
_disconnect_handlers: list[Callable[[str], Awaitable[None] | None]] = []
_waiters: list[tuple[str, Callable[[str, Any], bool], asyncio.Future]] = []


def on(event: str):
    def deco(fn: Handler) -> Handler:
        _handlers[event].append(fn)
        return fn

    return deco


def on_connect(fn):
    _connect_handlers.append(fn)
    return fn


def on_disconnect(fn):
    _disconnect_handlers.append(fn)
    return fn


async def _appeler(fn, *args):
    r = fn(*args)
    if inspect.isawaitable(r):
        r = await r
    return r


@sio.on("*")
async def _aiguillage(event: str, sid: str, *args):
    data = args[0] if args else None

    for w in list(_waiters):
        ev, filtre, fut = w
        if ev != event or fut.done():
            continue
        try:
            ok = filtre(sid, data)
        except Exception:
            ok = False
        if ok:
            fut.set_result(data)

    ack = None
    for fn in _handlers.get(event, ()):
        try:
            r = await _appeler(fn, sid, data)
        except Exception as e:
            log(f"[SOCKET] erreur dans le gestionnaire '{event}' :", repr(e))
            continue
        if ack is None and r is not None:
            ack = r
    return ack


@sio.event
async def connect(sid, environ, auth=None):
    for fn in _connect_handlers:
        try:
            await _appeler(fn, sid, environ)
        except Exception as e:
            log("[SOCKET] erreur a la connexion :", repr(e))


@sio.event
async def disconnect(sid, *args):
    for fn in _disconnect_handlers:
        try:
            await _appeler(fn, sid)
        except Exception as e:
            log("[SOCKET] erreur a la deconnexion :", repr(e))


async def emit_room(room: str, event: str, data: Any = None, skip_sid: str | None = None) -> None:
    if not room:
        return
    await sio.emit(event, data, room=str(room), skip_sid=skip_sid)


async def emit_to(sid: str, event: str, data: Any = None) -> None:
    await sio.emit(event, data, to=sid)


async def call(sid: str, event: str, data: Any = None, timeout: float = 8) -> Any:
    try:
        return await sio.call(event, data, to=sid, timeout=timeout)
    except Exception:
        return None


async def enter_room(sid: str, room: str) -> None:
    await sio.enter_room(sid, str(room))


async def leave_room(sid: str, room: str) -> None:
    await sio.leave_room(sid, str(room))


def room_sids(room: str) -> list[str]:
    if not room:
        return []
    try:
        return [s for s, _eio in sio.manager.get_participants("/", str(room))]
    except Exception:
        return []


def is_connected(sid: str) -> bool:
    try:
        return bool(sio.manager.is_connected(sid, "/"))
    except Exception:
        return False


async def wait_for_event(
    event: str,
    room: str | None = None,
    timeout: float = 5,
    filtre: Callable[[str, Any], bool] | None = None,
) -> Any:
    if room is not None and not room_sids(room):
        return None
    loop = asyncio.get_running_loop()
    fut: asyncio.Future = loop.create_future()

    def _filtre(sid: str, data: Any) -> bool:
        if room is not None and sid not in room_sids(room):
            return False
        return filtre(sid, data) if filtre else True

    w = (event, _filtre, fut)
    _waiters.append(w)
    try:
        return await asyncio.wait_for(fut, timeout)
    except asyncio.TimeoutError:
        return None
    finally:
        try:
            _waiters.remove(w)
        except ValueError:
            pass


def payload(data: Any) -> dict:
    return data if isinstance(data, dict) else {}


def tache(coro) -> asyncio.Task:
    t = asyncio.ensure_future(coro)
    _taches.add(t)

    def _fin(task: asyncio.Task):
        _taches.discard(task)
        if not task.cancelled() and task.exception() is not None:
            log("[TACHE] erreur :", repr(task.exception()))

    t.add_done_callback(_fin)
    return t


_taches: set[asyncio.Task] = set()
