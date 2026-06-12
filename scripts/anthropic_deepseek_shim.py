import json
import os
import uuid
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI(title="Anthropic-to-DeepSeek shim")


def profile_config(authorization: str | None) -> dict[str, Any] | None:
    root = Path(os.environ.get("VIBE_PROFILES_ROOT", "/opt/vibe-coding/profiles"))
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization.removeprefix("Bearer ").strip()
    for path in root.glob("*/deepseek.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if data.get("anthropicToken") == token:
            return data
    return None


def active_config(authorization: str | None) -> dict[str, Any]:
    cfg = profile_config(authorization)
    if cfg:
        return cfg
    expected = os.environ.get("LITELLM_MASTER_KEY", "").strip()
    if expected and authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="Invalid bearer token")
    return {
        "apiKey": os.environ.get("DEEPSEEK_API_KEY", "").strip(),
        "baseUrl": os.environ.get("DEEPSEEK_API_BASE", "https://api.deepseek.com"),
        "model": os.environ.get("DEEPSEEK_MODEL", os.environ.get("ANTHROPIC_MODEL", "deepseek-chat")),
    }


def text_from_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        chunks = []
        for item in content:
            if isinstance(item, dict):
                if item.get("type") == "text":
                    chunks.append(str(item.get("text", "")))
                elif item.get("type") == "tool_result":
                    chunks.append(str(item.get("content", "")))
            else:
                chunks.append(str(item))
        return "\n".join(part for part in chunks if part)
    return str(content)


def anthropic_to_openai(payload: dict[str, Any], cfg: dict[str, Any]) -> dict[str, Any]:
    messages = []
    system = payload.get("system")
    if system:
        messages.append({"role": "system", "content": text_from_content(system)})
    for message in payload.get("messages", []):
        role = message.get("role", "user")
        if role not in {"user", "assistant", "system"}:
            role = "user"
        messages.append({"role": role, "content": text_from_content(message.get("content", ""))})
    if not messages:
        messages.append({"role": "user", "content": ""})
    return {
        "model": cfg.get("model") or "deepseek-chat",
        "messages": messages,
        "max_tokens": payload.get("max_tokens", 2048),
        "temperature": payload.get("temperature", 0.2),
        "stream": bool(payload.get("stream", False)),
    }


def anthropic_message(text: str, model: str, usage: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "id": f"msg_{uuid.uuid4().hex}",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": [{"type": "text", "text": text}],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {
            "input_tokens": int((usage or {}).get("prompt_tokens", 0) or 0),
            "output_tokens": int((usage or {}).get("completion_tokens", 0) or 0),
        },
    }


def require_key(cfg: dict[str, Any]) -> str:
    api_key = str(cfg.get("apiKey") or "").strip()
    if not api_key or api_key == "__FILL_DEEPSEEK_API_KEY__":
        raise HTTPException(status_code=503, detail="DeepSeek API key is not configured")
    return api_key


async def deepseek_request(openai_payload: dict[str, Any], cfg: dict[str, Any]) -> httpx.Response:
    api_key = require_key(cfg)
    base_url = str(cfg.get("baseUrl") or "https://api.deepseek.com").rstrip("/")
    timeout = httpx.Timeout(120.0, connect=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=openai_payload,
        )
    if response.status_code >= 400:
        raise HTTPException(status_code=response.status_code, detail=response.text)
    return response


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True}


@app.post("/v1/messages")
@app.post("/anthropic/v1/messages")
async def messages(request: Request, authorization: str | None = Header(default=None)) -> Any:
    cfg = active_config(authorization)
    payload = await request.json()
    openai_payload = anthropic_to_openai(payload, cfg)
    if openai_payload["stream"]:
        return StreamingResponse(stream_deepseek(openai_payload, cfg), media_type="text/event-stream")
    response = await deepseek_request(openai_payload, cfg)
    data = response.json()
    text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    return JSONResponse(anthropic_message(text, openai_payload["model"], data.get("usage")))


async def stream_deepseek(openai_payload: dict[str, Any], cfg: dict[str, Any]):
    api_key = require_key(cfg)
    base_url = str(cfg.get("baseUrl") or "https://api.deepseek.com").rstrip("/")
    model = openai_payload["model"]
    message_id = f"msg_{uuid.uuid4().hex}"

    def event(name: str, data: dict[str, Any]) -> str:
        return f"event: {name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

    yield event("message_start", {
        "type": "message_start",
        "message": {
            "id": message_id,
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": [],
            "stop_reason": None,
            "stop_sequence": None,
            "usage": {"input_tokens": 0, "output_tokens": 0},
        },
    })
    yield event("content_block_start", {
        "type": "content_block_start",
        "index": 0,
        "content_block": {"type": "text", "text": ""},
    })

    timeout = httpx.Timeout(120.0, connect=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream(
            "POST",
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=openai_payload,
        ) as response:
            if response.status_code >= 400:
                body = await response.aread()
                yield event("error", {"type": "error", "error": {"type": "api_error", "message": body.decode("utf-8", "replace")}})
                return
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if raw == "[DONE]":
                    break
                try:
                    chunk = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                text = chunk.get("choices", [{}])[0].get("delta", {}).get("content")
                if text:
                    yield event("content_block_delta", {
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": {"type": "text_delta", "text": text},
                    })

    yield event("content_block_stop", {"type": "content_block_stop", "index": 0})
    yield event("message_delta", {
        "type": "message_delta",
        "delta": {"stop_reason": "end_turn", "stop_sequence": None},
        "usage": {"output_tokens": 0},
    })
    yield event("message_stop", {"type": "message_stop"})
