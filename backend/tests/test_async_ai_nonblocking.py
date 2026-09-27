import asyncio
import threading
import time

from starlette.requests import Request

import app.main as main_module


def _request() -> Request:
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/ai",
            "headers": [],
            "client": ("127.0.0.1", 12345),
            "server": ("127.0.0.1", 8001),
            "scheme": "http",
            "query_string": b"",
        }
    )


def test_slow_board_ai_does_not_block_status(monkeypatch):
    started = threading.Event()
    release = threading.Event()

    def slow_board_response(*args, **kwargs):
        started.set()
        release.wait(timeout=1.0)
        return "ok", [{"text": "ok", "kind": "result"}], []

    monkeypatch.setattr(main_module, "generate_board_response", slow_board_response)
    monkeypatch.setattr(main_module, "_append_ai_history", lambda *args, **kwargs: None)

    async def scenario():
        payload = main_module.AiRequest(
            mode="solution",
            problem="x=1",
            board_output=True,
        )
        task = asyncio.create_task(main_module.ai_endpoint(payload, _request()))

        before = time.perf_counter()
        await asyncio.sleep(0)
        yielded_in = time.perf_counter() - before

        assert yielded_in < 0.2
        status = await main_module.status()
        assert status["ok"] is True
        assert {"ai", "ocr"} <= status.keys()

        release.set()
        response = await asyncio.wait_for(task, timeout=1.0)
        assert response.text == "ok"

    asyncio.run(scenario())


def test_slow_ocr_runs_off_event_loop(monkeypatch):
    started = threading.Event()
    release = threading.Event()

    def slow_ocr(_data):
        started.set()
        release.wait(timeout=1.0)
        return "x^2 = 1"

    class FakeUpload:
        content_type = "image/png"

        async def read(self):
            return b"png"

    monkeypatch.setattr(main_module, "ocr_image", slow_ocr)

    async def scenario():
        task = asyncio.create_task(main_module.ocr_endpoint(FakeUpload()))

        before = time.perf_counter()
        await asyncio.sleep(0)
        yielded_in = time.perf_counter() - before

        assert yielded_in < 0.2
        status = await main_module.status()
        assert status["ok"] is True
        assert {"ai", "ocr"} <= status.keys()

        release.set()
        response = await asyncio.wait_for(task, timeout=1.0)
        assert response == {"text": "x^2 = 1"}

    asyncio.run(scenario())
