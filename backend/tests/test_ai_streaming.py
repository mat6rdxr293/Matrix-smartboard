import asyncio
import threading
from types import SimpleNamespace

from starlette.requests import Request

import app.ai as ai_module
import app.main as main_module


def _request() -> Request:
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/ai/jobs",
            "headers": [],
            "client": ("127.0.0.1", 12345),
            "server": ("127.0.0.1", 8001),
            "scheme": "http",
            "query_string": b"",
        }
    )


def test_visible_stream_text_reads_the_steps_of_a_half_written_answer():
    raw = '{"summary":"","steps":[{"text":"Заметим, что \\\\(25 = 5^2\\\\)","kind":"text"},{"text":"Тогда x - 1 <'
    assert ai_module.visible_stream_text(raw) == "1. Заметим, что \\(25 = 5^2\\)\n2. Тогда x - 1 <"
    assert ai_module.visible_stream_text("Просто текст ответа") == "Просто текст ответа"
    # An escape cut in half is not shown as garbage.
    assert ai_module.visible_stream_text('{"steps":[{"text":"угол \\') == "1. угол"


def _chunk(content=None, finish_reason=None):
    return SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=content), finish_reason=finish_reason)])


class _FakeCompletions:
    def __init__(self):
        self.requests = []

    def create(self, **request):
        self.requests.append(request)
        if request.get("stream"):
            return iter([_chunk('{"steps":[{"text":"Шаг'), _chunk(' один"}]}'), _chunk(None, "stop")])
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="без потока", tool_calls=[]), finish_reason="stop")])


def test_answers_stream_to_the_sink_and_tool_rounds_do_not(monkeypatch):
    fake = _FakeCompletions()
    monkeypatch.setattr(ai_module, "_OpenAI", lambda **_: SimpleNamespace(chat=SimpleNamespace(completions=fake)))
    client = ai_module.OpenAI(api_key="x")
    seen = []
    token = ai_module.ai_stream_sink.set(seen.append)
    try:
        answer = client.chat.completions.create(model="m", messages=[])
        tool_round = client.chat.completions.create(model="m", messages=[], tools=[{"type": "function"}])
    finally:
        ai_module.ai_stream_sink.reset(token)

    assert answer.choices[0].message.content == '{"steps":[{"text":"Шаг один"}]}'
    assert answer.choices[0].finish_reason == "stop"
    # The sink gets the raw text so far; what the class sees is read from it.
    assert seen == ['{"steps":[{"text":"Шаг', '{"steps":[{"text":"Шаг один"}]}']
    assert tool_round.choices[0].message.content == "без потока"
    assert "stream" not in fake.requests[1]

    # Without a sink nothing changes.
    plain = client.chat.completions.create(model="m", messages=[])
    assert plain.choices[0].message.content == "без потока"


def test_ai_job_shows_the_text_while_it_is_written(monkeypatch):
    halfway = threading.Event()
    release = threading.Event()

    def board_response(*args, **kwargs):
        sink = ai_module.ai_stream_sink.get()
        sink("1. Заметим, что 25 = 5^2")
        halfway.set()
        release.wait(timeout=2.0)
        return "готово", [{"text": "готово", "kind": "result"}], []

    monkeypatch.setattr(main_module, "generate_board_response", board_response)
    monkeypatch.setattr(main_module, "_append_ai_history", lambda *args, **kwargs: None)

    async def scenario():
        main_module.app.state.progress_tasks = set()
        payload = main_module.AiRequest(mode="solution", problem="5^(x-1) < 25", board_output=True)
        created = await main_module.create_ai_job(payload, _request())
        job_id = created["jobId"]

        for _ in range(100):
            if halfway.is_set():
                break
            await asyncio.sleep(0.01)
        job = await main_module.get_ai_job(job_id)
        assert job["status"] == "running"
        assert job["partial"] == "1. Заметим, что 25 = 5^2"

        release.set()
        for _ in range(200):
            job = await main_module.get_ai_job(job_id)
            if job["status"] == "done":
                break
            await asyncio.sleep(0.01)
        assert job["status"] == "done"
        assert job["result"]["text"] == "готово"
        assert job["result"]["steps"] == [{"text": "готово", "kind": "result"}]

    asyncio.run(scenario())


def test_the_summary_is_not_counted_as_a_step():
    raw = '{"summary":"Решение неравенства","steps":[{"text":"Заметим, что 9 = 3^2","kind":"text"},{"text":"Тогда'
    assert ai_module.visible_stream_text(raw) == "1. Заметим, что 9 = 3^2\n2. Тогда"


def test_only_finished_steps_are_handed_to_the_board_and_cleaned_like_the_answer():
    raw = (
        '{"summary":"","steps":[{"text":"1. Заметим, что 25 = 5^2","kind":"text"},'
        '{"text":"x < 3","kind":"result"},{"text":"Ответ: x'
    )
    steps = ai_module.visible_stream_steps(raw)
    # The model's own number is dropped as in the finished answer; the step still being written is not there.
    assert steps == [
        {"text": "Заметим, что 25 = 5^2", "kind": "text"},
        {"text": "x < 3", "kind": "result"},
    ]
    assert ai_module.visible_stream_steps("Просто текст") == []
    assert ai_module.visible_stream_steps('{"steps":[{"text":"Шаг') == []


def test_finished_steps_match_the_steps_of_the_finished_answer():
    raw = (
        '{"summary":"Решение","steps":[{"text":"2) Перепишем: 3^{2-x} \\\\geq 3^2","kind":"math"},'
        '{"text":"x \\\\leq 0","kind":"result"}]}'
    )
    _text, final_steps = ai_module._parse_board_solution(raw)
    _text, final_steps = ai_module._sanitize_board_language(_text, final_steps, "ru")
    assert ai_module.visible_stream_steps(raw) == final_steps
