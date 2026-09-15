from __future__ import annotations

import os
from typing import AsyncIterator

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask
from starlette.middleware.cors import CORSMiddleware

PROXY_TARGET = os.getenv("PROXY_TARGET", "http://127.0.0.1:8000")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _startup() -> None:
    timeout_default = httpx.Timeout(connect=10.0, read=60.0, write=60.0, pool=10.0)
    timeout_long = httpx.Timeout(connect=10.0, read=300.0, write=300.0, pool=10.0)
    app.state.client_default = httpx.AsyncClient(base_url=PROXY_TARGET, timeout=timeout_default)
    app.state.client_long = httpx.AsyncClient(base_url=PROXY_TARGET, timeout=timeout_long)


@app.on_event("shutdown")
async def _shutdown() -> None:
    client_default: httpx.AsyncClient = app.state.client_default
    client_long: httpx.AsyncClient = app.state.client_long
    await client_default.aclose()
    await client_long.aclose()


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def proxy(path: str, request: Request) -> Response:
    use_long = path.startswith("api/import/pptx")
    client: httpx.AsyncClient = app.state.client_long if use_long else app.state.client_default

    headers = dict(request.headers)
    headers.pop("host", None)

    body = await request.body()

    upstream = client.build_request(
        request.method,
        f"/{path}",
        params=request.query_params,
        headers=headers,
        content=body if body else None,
    )

    try:
        upstream_response = await client.send(upstream, stream=True)
    except httpx.ConnectError:
        return Response("Upstream недоступен", status_code=502)
    except httpx.ReadTimeout:
        return Response("Upstream таймаут", status_code=504)
    except httpx.RequestError:
        return Response("Ошибка прокси", status_code=502)

    async def iter_bytes() -> AsyncIterator[bytes]:
        async for chunk in upstream_response.aiter_bytes():
            yield chunk

    response_headers = dict(upstream_response.headers)
    response_headers.pop("content-encoding", None)
    response_headers.pop("content-length", None)
    response_headers.pop("transfer-encoding", None)

    return StreamingResponse(
        iter_bytes(),
        status_code=upstream_response.status_code,
        headers=response_headers,
        background=BackgroundTask(upstream_response.aclose),
    )
