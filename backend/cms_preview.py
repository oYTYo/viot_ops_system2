from __future__ import annotations

from dataclasses import dataclass
import base64
import hashlib
import hmac
import time
import json
import os
from random import randint
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen


class PreviewUnavailable(RuntimeError):
    """真实播放地址不可用时抛出，让接口显式失败。"""


@dataclass(frozen=True)
class CameraPreview:
    play_url: str
    device_no: str | None
    stream_id: str | None
    protocol: str
    source: str
    message: str | None = None
    candidates: tuple[dict[str, str], ...] = ()


@dataclass(frozen=True)
class CmsProfile:
    name: str
    base_url: str
    auth_base_url: str
    app_id: str
    app_key: str
    login_nonce: str
    access_token_cache_file: Path


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_PLAYBACK_MAP_FILE = BASE_DIR / "camera_playback_map.json"

Transport = Callable[[str, dict[str, str], dict[str, str], float], dict[str, Any]]


def _load_local_env_file() -> None:
    env_path = Path(__file__).resolve().with_name(".env.local")
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key or key in os.environ:
            continue

        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]

        os.environ[key] = value


_load_local_env_file()
CMS_PROVIDER = os.getenv("VIOT_CMS_PROVIDER", "0").strip()


def _env_first(*keys: str, default: str = "") -> str:
    for key in keys:
        value = os.getenv(key)
        if value not in (None, ""):
            return value
    return default


def _load_cms_profile(provider: str) -> CmsProfile:
    if provider == "0":
        name = "aliyun"
        base_url = _env_first("VIOT_CMS_PROVIDER_0_BASE_URL", "VIOT_CMS_BASE_URL", default="http://172.29.151.209:9192")
        auth_base_url = _env_first("VIOT_CMS_PROVIDER_0_AUTH_BASE_URL", "VIOT_CMS_AUTH_BASE_URL", default="http://172.29.151.209:20002")
        app_id = _env_first("VIOT_CMS_PROVIDER_0_APP_ID", "VIOT_CMS_APP_ID", default="831000003")
        app_key = _env_first("VIOT_CMS_PROVIDER_0_APP_KEY", "VIOT_CMS_APP_KEY", default="rebB6FT74H%UrXQhxC&a2wscXALrsZ$W")
        login_nonce = _env_first("VIOT_CMS_PROVIDER_0_LOGIN_NONCE", "VIOT_CMS_LOGIN_NONCE", default="6310372240")
        cache_file = _env_first("VIOT_CMS_PROVIDER_0_ACCESS_TOKEN_CACHE_FILE", "VIOT_CMS_ACCESS_TOKEN_CACHE_FILE", default=str(BASE_DIR / ".cms_access_token_aliyun.json"))
    elif provider == "1":
        name = "telecom"
        base_url = _env_first("VIOT_CMS_PROVIDER_1_BASE_URL", "VIOT_CMS_BASE_URL", default="http://172.29.151.209:9192")
        auth_base_url = _env_first("VIOT_CMS_PROVIDER_1_AUTH_BASE_URL", "VIOT_CMS_AUTH_BASE_URL", default="http://172.29.151.209:20002")
        app_id = _env_first("VIOT_CMS_PROVIDER_1_APP_ID", "VIOT_CMS_APP_ID", default="835000038")
        app_key = _env_first("VIOT_CMS_PROVIDER_1_APP_KEY", "VIOT_CMS_APP_KEY", default="ssVnC$jWIgUyk0awU5Oidn3LzP0FACMa")
        login_nonce = _env_first("VIOT_CMS_PROVIDER_1_LOGIN_NONCE", "VIOT_CMS_LOGIN_NONCE", default="6310372240")
        cache_file = _env_first("VIOT_CMS_PROVIDER_1_ACCESS_TOKEN_CACHE_FILE", "VIOT_CMS_ACCESS_TOKEN_CACHE_FILE", default=str(BASE_DIR / ".cms_access_token_telecom.json"))
    else:
        raise PreviewUnavailable(f"未知 VIOT_CMS_PROVIDER：{provider}，只能配置为 0（阿里云）或 1（电信）")

    return CmsProfile(
        name=name,
        base_url=base_url.rstrip("/"),
        auth_base_url=auth_base_url.rstrip("/"),
        app_id=app_id.strip(),
        app_key=app_key.strip(),
        login_nonce=login_nonce.strip(),
        access_token_cache_file=Path(cache_file),
    )


CMS_PROFILE = _load_cms_profile(CMS_PROVIDER)
CMS_BASE_URL = CMS_PROFILE.base_url
CMS_AUTH_BASE_URL = CMS_PROFILE.auth_base_url
CMS_LIVESTREAM_PATH = os.getenv("VIOT_CMS_LIVESTREAM_PATH", "/vic/cms/v1/camera/livestream")
CMS_AUTH_MODE = os.getenv("VIOT_CMS_AUTH_MODE", "none").strip().lower()
CMS_TIMEOUT_SECONDS = float(os.getenv("VIOT_CMS_TIMEOUT_SECONDS", "8"))
CMS_LOGIN_PATH = os.getenv("VIOT_CMS_LOGIN_PATH", "/vic/account/v1/auth/loginByAppId")
CMS_LOGIN_NONCE = CMS_PROFILE.login_nonce
CMS_APP_ID = CMS_PROFILE.app_id
CMS_APP_KEY = CMS_PROFILE.app_key
CMS_ACCESS_TOKEN_CACHE_FILE = CMS_PROFILE.access_token_cache_file


def load_cms_settings() -> CmsProfile:
    profile = _load_cms_profile(os.getenv("VIOT_CMS_PROVIDER", "0").strip())
    auth_mode = os.getenv("VIOT_CMS_AUTH_MODE", "none").strip().lower()
    if auth_mode == "app" and (not profile.app_id or not profile.app_key):
        raise PreviewUnavailable("VIOT_CMS_AUTH_MODE=app 时必须显式配置 VIOT_CMS_APP_ID 和 VIOT_CMS_APP_KEY")
    return profile


def resolve_camera_preview(
    camera: Any,
    *,
    playback_map: dict[str, Any] | None = None,
    transport: Transport | None = None,
) -> CameraPreview:
    mapping = _resolve_mapping(camera, playback_map)

    direct_url = mapping.get("play_url")
    if direct_url:
        return CameraPreview(
            play_url=direct_url,
            device_no=mapping.get("device_no"),
            stream_id=mapping.get("stream_id"),
            protocol=_url_protocol(direct_url),
            source=mapping.get("source", "camera_video_url"),
            candidates=({"type": _playback_type(direct_url), "url": direct_url, "source": mapping.get("source", "camera_video_url")},),
        )

    device_no = mapping.get("device_no")
    if not device_no:
        raise PreviewUnavailable(
            f"未配置真实 deviceNo：请在 camera_playback_map.json 中为摄像头 {getattr(camera, 'id', '')} 配置 deviceNo，"
            "或将摄像头视频地址写为 cms://<deviceNo>。"
        )

    payload = _query_cms_livestream(
        device_no,
        mapping.get("stream_id"),
        transport=transport,
    )
    if _is_unauthorized_payload(payload) and CMS_AUTH_MODE == "app" and transport is None:
        _clear_cached_access_token()
        payload = _query_cms_livestream(
            device_no,
            mapping.get("stream_id"),
            transport=transport,
        )

    candidates = _extract_play_candidates(payload)
    play_url = candidates[0]["url"] if candidates else None
    if not play_url:
        code = payload.get("code")
        message = payload.get("message") or payload.get("msg") or "智融平台未返回播放地址"
        raise PreviewUnavailable(f"智融平台播放地址获取失败：code={code}, message={message}")

    return CameraPreview(
        play_url=play_url,
        device_no=device_no,
        stream_id=mapping.get("stream_id"),
        protocol=_url_protocol(play_url),
        source="cms_livestream",
        message=payload.get("message") or payload.get("msg"),
        candidates=tuple(candidates),
    )


def _resolve_mapping(camera: Any, playback_map: dict[str, Any] | None) -> dict[str, str | None]:
    configured = playback_map if playback_map is not None else _load_playback_map()
    camera_id = str(getattr(camera, "id", "") or "")
    camera_name = str(getattr(camera, "name", "") or "")

    for key in (camera_id, camera_name):
        if key and key in configured:
            return _normalize_map_value(configured[key])

    video_url = str(getattr(camera, "video_url", "") or "").strip()
    if video_url:
        from_video_url = _mapping_from_video_url(video_url)
        if from_video_url:
            return from_video_url

    device_no = _device_no_from_camera_id(camera_id)
    if device_no:
        return {"device_no": device_no, "stream_id": _stream_id_from_camera_id(camera_id), "source": "camera_id"}

    return {}


def _load_playback_map() -> dict[str, Any]:
    path = Path(os.getenv("VIOT_CAMERA_PLAYBACK_MAP_FILE", str(DEFAULT_PLAYBACK_MAP_FILE)))
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise PreviewUnavailable(f"摄像头播放映射文件格式错误：{path}: {exc}") from exc
    if not isinstance(data, dict):
        raise PreviewUnavailable(f"摄像头播放映射文件必须是 JSON 对象：{path}")
    return data


def _normalize_map_value(value: Any) -> dict[str, str | None]:
    if isinstance(value, str):
        value = value.strip()
        if _is_direct_play_url(value):
            return {"play_url": value, "protocol": _url_protocol(value), "source": "camera_playback_map"}
        return {"device_no": value, "stream_id": "0", "source": "camera_playback_map"}

    if not isinstance(value, dict):
        raise PreviewUnavailable("摄像头播放映射值必须是字符串或对象")

    device_no = _clean_text(value.get("deviceNo") or value.get("device_no") or value.get("deviceId") or value.get("device_id"))
    play_url = _clean_text(value.get("playUrl") or value.get("play_url") or value.get("url") or value.get("rtspUrl"))
    stream_id = _clean_text(value.get("streamId") if "streamId" in value else value.get("stream_id"))
    if stream_id is None:
        stream_id = "0"

    if play_url:
        return {
            "play_url": play_url,
            "device_no": device_no,
            "stream_id": stream_id,
            "source": "camera_playback_map",
        }
    return {"device_no": device_no, "stream_id": stream_id, "source": "camera_playback_map"}


def _mapping_from_video_url(video_url: str) -> dict[str, str | None] | None:
    parsed = urlparse(video_url)
    scheme = parsed.scheme.lower()
    if scheme == "cms":
        device_no = (parsed.netloc + parsed.path).strip("/")
        params = parse_qs(parsed.query)
        stream_id = params.get("streamId", params.get("stream_id", ["0"]))[0]
        return {"device_no": device_no, "stream_id": stream_id, "source": "camera_video_url"}

    if video_url.lower().startswith("deviceno:"):
        return {"device_no": video_url.split(":", 1)[1].strip(), "stream_id": "0", "source": "camera_video_url"}

    if _is_direct_play_url(video_url):
        return {"play_url": video_url, "protocol": _url_protocol(video_url), "source": "camera_video_url"}

    return None


def _is_direct_play_url(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme.lower() not in {"http", "https", "ws", "wss", "rtsp", "rtmp", "webrtc"}:
        return False
    host = parsed.netloc.lower()
    if not host or "example.com" in host:
        return False
    return True


def _device_no_from_camera_id(camera_id: str) -> str | None:
    # 兼容从智融/国标设备编码同步过来的摄像头 ID；演示 ID 不会误判。
    if camera_id.isdigit() and len(camera_id) >= 16:
        return camera_id
    base, sep, stream = camera_id.partition("_")
    if sep and base.isdigit() and len(base) >= 16 and stream.isdigit():
        return base
    return None


def _stream_id_from_camera_id(camera_id: str) -> str:
    base, sep, stream = camera_id.partition("_")
    if sep and base.isdigit() and stream.isdigit():
        return stream
    return "0"


def _query_cms_livestream(device_no: str, stream_id: str | None, *, transport: Transport | None) -> dict[str, Any]:
    params = {"deviceNo": device_no}
    if stream_id not in (None, ""):
        params["streamId"] = str(stream_id)
    headers = _cms_headers()
    active_transport = transport or _http_get_json
    return active_transport(CMS_LIVESTREAM_PATH, params, headers, CMS_TIMEOUT_SECONDS)


def _cms_headers() -> dict[str, str]:
    headers = {"Accept": "application/json"}
    if CMS_AUTH_MODE == "none":
        return headers
    if CMS_AUTH_MODE == "token":
        token = os.getenv("VIOT_CMS_ACCESS_TOKEN", "").strip()
        if not token:
            raise PreviewUnavailable("VIOT_CMS_AUTH_MODE=token 时必须配置 VIOT_CMS_ACCESS_TOKEN")
        headers["X-VIC-ACCESS-TOKEN"] = token
        return headers
    if CMS_AUTH_MODE == "app":
        headers["X-VIC-ACCESS-TOKEN"] = _get_app_access_token()
        return headers
    raise PreviewUnavailable(f"未知 VIOT_CMS_AUTH_MODE：{CMS_AUTH_MODE}")


def _get_app_access_token() -> str:
    cached = _load_cached_access_token()
    if cached:
        return cached

    if not CMS_APP_ID or not CMS_APP_KEY:
        raise PreviewUnavailable("VIOT_CMS_AUTH_MODE=app 时必须配置 VIOT_CMS_APP_ID 和 VIOT_CMS_APP_KEY")

    timestamp = str(int(time.time() * 1000))
    nonce = CMS_LOGIN_NONCE or str(randint(1000000000, 9999999999))
    sign_content = "POST\n" + CMS_LOGIN_PATH + "\n" + timestamp + "\n" + nonce + "\n\n"
    signature = base64.b64encode(
        hmac.new(CMS_APP_KEY.encode("utf-8"), sign_content.encode("utf-8"), hashlib.sha256).digest()
    ).decode("utf-8")

    headers = {
        "Accept": "application/json",
        "X-VIC-APP-ID": CMS_APP_ID,
        "X-VIC-TIMESTAMP": timestamp,
        "X-VIC-NONCE": nonce,
        "X-VIC-SIGNATURE": signature,
    }
    payload = _http_post_json(CMS_LOGIN_PATH, headers, CMS_TIMEOUT_SECONDS)
    token = _extract_access_token(payload)
    if not token:
        code = payload.get("code")
        message = payload.get("message") or payload.get("msg") or "登录接口未返回 token"
        raise PreviewUnavailable(f"智融平台登录失败：code={code}, message={message}")

    _store_cached_access_token(token)
    return token


def _load_cached_access_token() -> str | None:
    if not CMS_ACCESS_TOKEN_CACHE_FILE.exists():
        return None
    try:
        payload = json.loads(CMS_ACCESS_TOKEN_CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    token = _clean_text(payload.get("token"))
    if not token:
        return None
    return token


def _store_cached_access_token(token: str) -> None:
    try:
        CMS_ACCESS_TOKEN_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        CMS_ACCESS_TOKEN_CACHE_FILE.write_text(json.dumps({"token": token}, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


def _invalidate_cached_access_token() -> None:
    try:
        CMS_ACCESS_TOKEN_CACHE_FILE.unlink(missing_ok=True)
    except Exception:
        pass


def _clear_cached_access_token() -> None:
    try:
        CMS_ACCESS_TOKEN_CACHE_FILE.unlink(missing_ok=True)
    except Exception:
        pass


def _http_get_json(path: str, params: dict[str, str], headers: dict[str, str], timeout: float) -> dict[str, Any]:
    url = f"{CMS_BASE_URL}{path}?{urlencode(params)}"
    req = Request(url, headers=headers, method="GET")
    try:
        with urlopen(req, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise PreviewUnavailable(f"智融平台 HTTP {exc.code}: {body[:300]}") from exc
    except URLError as exc:
        raise PreviewUnavailable(f"智融平台连接失败：{exc.reason}") from exc
    except TimeoutError as exc:
        raise PreviewUnavailable("智融平台连接超时") from exc

    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise PreviewUnavailable(f"智融平台返回非 JSON：{body[:300]}") from exc
    if not isinstance(payload, dict):
        raise PreviewUnavailable("智融平台返回格式不是 JSON 对象")
    return payload


def _http_post_json(path: str, headers: dict[str, str], timeout: float) -> dict[str, Any]:
    url = f"{CMS_AUTH_BASE_URL}{path}"
    req = Request(url, data=b"", headers=headers, method="POST")
    try:
        with urlopen(req, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise PreviewUnavailable(f"智融平台 HTTP {exc.code}: {body[:300]}") from exc
    except URLError as exc:
        raise PreviewUnavailable(f"智融平台连接失败：{exc.reason}") from exc
    except TimeoutError as exc:
        raise PreviewUnavailable("智融平台连接超时") from exc

    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise PreviewUnavailable(f"智融平台返回非 JSON：{body[:300]}") from exc
    if not isinstance(payload, dict):
        raise PreviewUnavailable("智融平台返回格式不是 JSON 对象")
    return payload


def _extract_access_token(payload: dict[str, Any]) -> str | None:
    data = payload.get("data")
    if isinstance(data, dict):
        for key in ("token", "accessToken", "access_token"):
            token = _clean_text(data.get(key))
            if token:
                return token
    if isinstance(data, str):
        token = data.strip()
        if token:
            return token
    return None

def _is_auth_failure(payload: dict[str, Any]) -> bool:
    code = payload.get("code")
    message = _clean_text(payload.get("message") or payload.get("msg")) or ""
    return str(code) == "9000" or "未认证" in message or "token" in message.lower()


def _is_unauthorized_payload(payload: dict[str, Any]) -> bool:
    code = payload.get("code")
    return code in (9000, 9001, 9003, 9004, "9000", "9001", "9003", "9004")


def _extract_play_url(payload: dict[str, Any]) -> str | None:
    candidates = _extract_play_candidates(payload)
    return candidates[0]["url"] if candidates else None


def _extract_play_candidates(payload: dict[str, Any]) -> list[dict[str, str]]:
    if payload.get("code") not in (0, "0", None):
        return []
    data = payload.get("data")
    if isinstance(data, str):
        value = data.strip()
        return [{"type": _playback_type(value), "url": value, "source": "data"}] if value else []
    if not isinstance(data, dict):
        return []

    candidates: list[dict[str, str]] = []
    for key in (
        "flvUrl",
        "httpsFlvUrl",
        "httpsHlsUrl",
        "hlsUrl",
        "wsFlvUrl",
        "rtmpUrl",
        "playUrl",
        "play_url",
        "url",
        "rtspUrl",
        "rtspEsUrl",
    ):
        value = _clean_text(data.get(key))
        if value:
            candidates.append({"type": _playback_type(value), "url": value, "source": key})

    play_list = data.get("playList")
    if isinstance(play_list, list):
        for item in play_list:
            if isinstance(item, dict):
                value = _clean_text(item.get("url") or item.get("playUrl"))
                if value:
                    candidates.append({"type": _playback_type(value), "url": value, "source": "playList"})

    deduped: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in candidates:
        if item["url"] in seen:
            continue
        seen.add(item["url"])
        deduped.append(item)
    return deduped


def _playback_type(url: str) -> str:
    lower = url.lower()
    if ".flv" in lower or "format=flv" in lower:
        return "flv"
    if ".m3u8" in lower:
        return "hls"
    return _url_protocol(url)


def _url_protocol(url: str) -> str:
    parsed = urlparse(url)
    return parsed.scheme.lower() or "unknown"


def _clean_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
