# Локальная модель: API для бэкенда

Модель на доске работает как **OpenAI-совместимый сервер** (llama.cpp `llama-server`).
Бэкенду достаточно поменять `base_url` — формат запросов и ответов тот же, что у OpenAI Chat Completions.

## Запуск

```bash
cd ~/matrix
scripts/serve.sh                                   # Qwen3.5-4B Q4_K_M, http://127.0.0.1:8080/v1
HOST=0.0.0.0 API_KEY=secret scripts/serve.sh       # доступ из локальной сети, с ключом
MODEL=models/Qwen3.5-2B-Q4_K_M.gguf scripts/serve.sh   # лёгкая модель
```

Параметры по умолчанию: CPU, 4 потока, без mmap, контекст 8192 токена, **один слот**
(запросы обрабатываются по очереди), режим рассуждений (`<think>`) выключен.
Готовность сервера: `GET /health` → `{"status":"ok"}`. Загрузка 4B занимает несколько секунд.

## Запрос (вместо OpenAI)

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer secret" \
  -d '{
    "model": "qwen3.5-4b-q4-k-m",
    "messages": [
      {"role": "system", "content": "Сен мектеп мұғалімінің көмекшісісің. Қысқа әрі нақты жауап бер."},
      {"role": "user", "content": "Фотосинтез дегеніміз не? Бір сөйлеммен."}
    ],
    "temperature": 0.3,
    "max_tokens": 300
  }'
```

Заголовок `Authorization` нужен, только если сервер запущен с `API_KEY`. Поле `model` сервер
не проверяет (модель одна), но лучше передавать имя из `GET /v1/models`.

Ответ (сокращённо):

```json
{
  "object": "chat.completion",
  "model": "qwen3.5-4b-q4-k-m",
  "choices": [{"index": 0, "finish_reason": "stop",
               "message": {"role": "assistant", "content": "Фотосинтез – өсімдіктер күн сәулесінің энергиясын пайдаланып, ..."}}],
  "usage": {"prompt_tokens": 73, "completion_tokens": 62, "total_tokens": 135},
  "timings": {"prompt_per_second": 38.6, "predicted_per_second": 10.7}
}
```

`timings` — расширение llama.cpp, его можно игнорировать.

### Python (официальный клиент `openai`)

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8080/v1", api_key="secret")  # без ключа — любая строка
resp = client.chat.completions.create(
    model="qwen3.5-4b-q4-k-m",
    messages=[{"role": "user", "content": "Ньютонның бірінші заңын бір сөйлеммен айт."}],
    temperature=0.3,
    max_tokens=300,
)
print(resp.choices[0].message.content)
```

### Потоковая выдача (рекомендуется для UI доски)

Модель генерирует ~11 токенов/с, поэтому ответ лучше показывать по мере генерации: `"stream": true`.
Формат — SSE, как у OpenAI (`data: {...chat.completion.chunk...}`, в конце `data: [DONE]`).

```python
stream = client.chat.completions.create(model="qwen3.5-4b-q4-k-m", messages=msgs, stream=True)
for chunk in stream:
    delta = chunk.choices[0].delta.content
    if delta:
        send_to_ui(delta)
```

## Что важно знать бэкенду

| | |
|---|---|
| Скорость (4B, 4 потока, i7-13650HX) | промпт ~40–45 ток/с, генерация ~11 ток/с. На CPU доски, скорее всего, медленнее |
| Время ответа | ~7–8 с на вопрос из 70 токенов с ответом из 60 токенов; с RAG-контекстом (~1000 токенов) +20–25 с на промпт |
| Память | ~3.2 ГБ RSS у процесса сервера (4B, ctx 8192) |
| Параллельность | 1 слот: второй запрос ждёт первый. Для доски с одним учителем этого достаточно |
| Таймаут HTTP | ставить ≥ 120 с (длинный RAG-промпт + длинный ответ) |
| Языки | kk / ru / en. Системный промпт на языке вопроса даёт более стабильный язык ответа |
| Рассуждения | выключены на сервере. Включить для одного запроса: `"chat_template_kwargs": {"enable_thinking": true}` (сильно медленнее) |
| Структурированный ответ | поддерживается `"response_format": {"type": "json_schema", "json_schema": {...}}` |
| Отмена | закрытие соединения при `stream: true` останавливает генерацию |

Системные промпты, которые используются в бенчмарке и при обучении (лучше брать эти же):
`scripts/prompts.py` → `SYSTEM_PROMPT["kk" | "ru" | "en"]`.

## RAG

Поиск по учебникам пока делается в Python (`scripts/rag.py`, эмбеддер на CPU). Найденные фрагменты
подставляются в сообщение пользователя по шаблону `RAG_TEMPLATE` из `scripts/prompts.py`.
Как поиск будет доступен бэкенду (отдельный HTTP-эндпоинт или библиотека), ещё не решено.
