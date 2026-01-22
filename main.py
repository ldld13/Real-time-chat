from aiohttp import web, WSCloseCode
import asyncio
import json
import uuid
import time
import os
from pathlib import Path
import traceback

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


async def autocomplete_ai(request):
    """Generate suggestions via Zhipu AI.
    Expects JSON: {"text": "..."}
    Returns JSON: {"suggestions": ["...", ...]}
    """
    try:
        data = await request.json()
    except Exception as e:
        print('[autocomplete_ai] failed to parse request json:', e)
        return web.json_response({'suggestions': []})

    text = (data.get('text') or '').strip()
    print(f"[autocomplete_ai] request text: '{text}'")
    if not text:
        return web.json_response({'suggestions': []})

    zkey = os.environ.get('ZHIPU_API_KEY')
    if not zkey:
        print('[autocomplete_ai] ZHIPU_API_KEY not set')
        return web.json_response({'suggestions': []})

    try:
        from zai import ZhipuAiClient
    except Exception as e:
        print('[autocomplete_ai] import zai-sdk failed:', e)
        traceback.print_exc()
        return web.json_response({'suggestions': []})

    try:
        client = ZhipuAiClient(api_key=zkey)
    except Exception as e:
        print('[autocomplete_ai] failed to create client:', e)
        traceback.print_exc()
        return web.json_response({'suggestions': []})

    def call_api():
        # prompt: polish/complete user's message with concise, polite replies that continue the intent
        messages = [
            {"role": "system", "content": "你是话术/补全助手。你根据我的输入的词，理解我的语义，补全或扩展，以同样的人称视角。根据用户输入，生成 3 条自然、口语友好、礼貌得体的续写/改写/补全，帮助完善表达（如把简短词组扩展为完整问候或礼貌询问）。每条不超过 40 字，只输出候选文本，每条单独一行，不要编号、不加额外说明。"},
            {"role": "user", "content": f"用户输入：\"{text}\""}
        ]
        attempts = 2  # reduce retries to avoid long waits
        for attempt in range(1, attempts + 1):
            try:
                resp = client.chat.completions.create(
                    model="glm-4-flash",
                    messages=messages,
                    max_tokens=200,  # smaller for faster response
                    temperature=0.6  # slightly more conservative
                )
                return resp
            except Exception as e:
                errstr = str(e)
                print(f"[autocomplete_ai] API call exception (attempt {attempt}): {errstr}")
                traceback.print_exc()
                if attempt < attempts and ("429" in errstr or "并发" in errstr or "超" in errstr):
                    backoff = 1 * (2 ** (attempt - 1))
                    print(f"[autocomplete_ai] retrying after {backoff}s due to rate limit")
                    time.sleep(backoff)
                    continue
                raise

    try:
        # overall timeout to avoid long waits
        resp = await asyncio.wait_for(asyncio.to_thread(call_api), timeout=6)
    except Exception:
        return web.json_response({'suggestions': []})

    # parse response
    raw = ''
    try:
        msg = resp.choices[0].message
        if isinstance(msg, str):
            raw = msg
        else:
            raw = getattr(msg, 'content', str(msg))
    except Exception as e:
        print('[autocomplete_ai] failed to extract message from resp:', e)
        traceback.print_exc()
        raw = ''

    suggestions = []
    if raw:
        # split by line breaks or sentence punctuation
        parts = [ln.strip() for ln in raw.splitlines() if ln.strip()]
        if not parts:
            import re
            parts = [p.strip() for p in re.split(r'[。！？;；\n]+', raw) if p.strip()]
        seen = set()
        for p in parts:
            if p not in seen:
                suggestions.append(p)
                seen.add(p)
            if len(suggestions) >= 3:
                break

    print(f"[autocomplete_ai] returning {len(suggestions)} suggestions")
    return web.json_response({'suggestions': suggestions})


def create_app():
    app = web.Application()
    app.router.add_get('/', index)
    app.router.add_get('/chat', chat_page)
    app.router.add_get('/ws', handle_ws)
    app.router.add_post('/autocomplete_ai', autocomplete_ai)
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
