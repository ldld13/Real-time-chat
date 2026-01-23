import os
import sys
import json
import pathlib
import pytest
import pytest_asyncio
from aiohttp import web

pytest_plugins = ("aiohttp.pytest_plugin",)

# Ensure project root on path so `import main` works when running pytest from subfolders
ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import main


class DummyMsg:
    def __init__(self, content):
        self.content = content


class DummyChoice:
    def __init__(self, content):
        self.message = DummyMsg(content)


class DummyResp:
    def __init__(self, content):
        self.choices = [DummyChoice(content)]


class DummyCompletions:
    def __init__(self, content):
        self._content = content

    def create(self, *args, **kwargs):
        return DummyResp(self._content)


class DummyChat:
    def __init__(self, content):
        self.completions = DummyCompletions(content)


class DummyClient:
    def __init__(self, content):
        self.chat = DummyChat(content)


@pytest.fixture(autouse=True)
def patch_env(monkeypatch):
    monkeypatch.setenv("ZHIPU_API_KEY", "dummy")
    yield


def install_dummy_zai(monkeypatch, content):
    class DummyZaiModule:
        class ZhipuAiClient:
            def __init__(self, api_key):
                self.chat = DummyChat(content)

    monkeypatch.setitem(sys.modules, "zai", DummyZaiModule)


@pytest_asyncio.mark.asyncio
async def test_autocomplete_ai_returns_three(aiohttp_client, monkeypatch):
    install_dummy_zai(monkeypatch, "a\nb\nc")
    app = main.create_app()
    client = await aiohttp_client(app)
    resp = await client.post("/autocomplete_ai", json={"text": "hello"})
    assert resp.status == 200
    data = await resp.json()
    assert data["suggestions"] == ["a", "b", "c"]


@pytest_asyncio.mark.asyncio
async def test_autocomplete_ai_empty_text(aiohttp_client, monkeypatch):
    install_dummy_zai(monkeypatch, "should not matter")
    app = main.create_app()
    client = await aiohttp_client(app)
    resp = await client.post("/autocomplete_ai", json={"text": "   "})
    assert resp.status == 200
    data = await resp.json()
    assert data["suggestions"] == []


@pytest_asyncio.mark.asyncio
async def test_analyze_users_returns_payload(aiohttp_client, monkeypatch):
    original = list(main.MESSAGES)
    try:
        main.MESSAGES.clear()
        main.MESSAGES.extend([
            {"name": "Alice", "text": "I am fine", "time": 1, "id": "1"},
            {"name": "Bob", "text": "Everything ok", "time": 2, "id": "2"},
        ])
        analyses_json = {
            "analyses": [
                {"user": "Alice", "emotion": "neutral", "inference": "ok", "suggested_reply": "Check in."},
                {"user": "Bob", "emotion": "positive", "inference": "happy", "suggested_reply": "Keep going."},
            ]
        }
        install_dummy_zai(monkeypatch, json.dumps(analyses_json))
        app = main.create_app()
        client = await aiohttp_client(app)
        resp = await client.post("/analyze_users")
        assert resp.status == 200
        data = await resp.json()
        assert len(data["analyses"]) == 2
        assert {x["user"] for x in data["analyses"]} == {"Alice", "Bob"}
    finally:
        main.MESSAGES[:] = original


@pytest_asyncio.mark.asyncio
async def test_analyze_users_empty_messages(aiohttp_client, monkeypatch):
    original = list(main.MESSAGES)
    try:
        main.MESSAGES.clear()
        install_dummy_zai(monkeypatch, json.dumps({"analyses": []}))
        app = main.create_app()
        client = await aiohttp_client(app)
        resp = await client.post("/analyze_users")
        assert resp.status == 200
        data = await resp.json()
        assert data["analyses"] == []
    finally:
        main.MESSAGES[:] = original
