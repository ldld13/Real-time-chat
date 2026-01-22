from aiohttp import web, WSCloseCode
import asyncio
import json
import uuid
import time
import os
from pathlib import Path

ROOT = Path(__file__).parent
STATIC_DIR = ROOT / 'static'

# In-memory state
MAX_HISTORY = 200
MESSAGES = []  # list of message dicts
CLIENTS = {}  # websocket -> name


def make_message(name, text):
    return {
        'id': str(uuid.uuid4()),
        'name': name,
        'text': text,
        'time': int(time.time() * 1000),
    }


async def broadcast(message_obj):
    data = {'type': 'message', **message_obj}
    dead = []
    for ws in list(CLIENTS.keys()):
        try:
            await ws.send_json(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        CLIENTS.pop(ws, None)


async def broadcast_users():
    names = list(CLIENTS.values())
    data = {'type': 'users', 'names': names}
    dead = []
    for ws in list(CLIENTS.keys()):
        try:
            await ws.send_json(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        CLIENTS.pop(ws, None)


async def handle_ws(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    name = None
    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                try:
                    payload = json.loads(msg.data)
                except Exception:
                    await ws.send_json({'type': 'error', 'message': 'bad json'})
                    continue

                typ = payload.get('type')
                if typ == 'join':
                    # validate name
                    name_candidate = (payload.get('name') or '').strip()
                    if not name_candidate:
                        await ws.send_json({'type': 'error', 'message': 'empty name'})
                        continue
                    name = name_candidate
                    CLIENTS[ws] = name
                    # send history
                    await ws.send_json({'type': 'history', 'messages': MESSAGES})
                    # broadcast updated users list
                    await broadcast_users()
                elif typ == 'message':
                    if ws not in CLIENTS:
                        await ws.send_json({'type': 'error', 'message': 'not joined'})
                        continue
                    text = payload.get('text')
                    if not isinstance(text, str):
                        await ws.send_json({'type': 'error', 'message': 'invalid message'})
                        continue
                    text = text.strip()
                    if not text:
                        # ignore empty messages
                        continue
                    if len(text) > 1000:
                        await ws.send_json({'type': 'error', 'message': 'message too long'})
                        continue
                    msg_obj = make_message(CLIENTS[ws], text)
                    MESSAGES.append(msg_obj)
                    if len(MESSAGES) > MAX_HISTORY:
                        MESSAGES.pop(0)
                    await broadcast(msg_obj)
                else:
                    await ws.send_json({'type': 'error', 'message': 'unknown type'})
            elif msg.type == web.WSMsgType.ERROR:
                print('ws connection closed with exception %s' % ws.exception())
    finally:
        # cleanup
        CLIENTS.pop(ws, None)
        try:
            await broadcast_users()
        except Exception:
            pass
        try:
            await ws.close()
        except Exception:
            pass
    return ws


async def index(request):
    return web.FileResponse(STATIC_DIR / 'index.html')


async def chat_page(request):
    return web.FileResponse(STATIC_DIR / 'chat.html')


def create_app():
    app = web.Application()
    app.router.add_get('/', index)
    app.router.add_get('/chat', chat_page)
    app.router.add_get('/ws', handle_ws)
    app.router.add_static('/static/', path=str(STATIC_DIR), name='static')
    return app


if __name__ == '__main__':
    # Read preferred port from environment or default to 8080
    base_port = int(os.environ.get('PORT', '8080'))
    max_tries = 11  # try base_port .. base_port+10
    started = False
    for offset in range(max_tries):
        port = base_port + offset
        try:
            print(f'Trying to start server on http://127.0.0.1:{port}')
            # create the app inside the loop to avoid event-loop mismatch
            app = create_app()
            web.run_app(app, host='127.0.0.1', port=port)
            started = True
            break
        except OSError as e:
            print(f'Port {port} unavailable: {e}')
            # try next port
            continue
    if not started:
        print(f'Failed to bind to any port in range {base_port}-{base_port+max_tries-1}. Exiting.')
