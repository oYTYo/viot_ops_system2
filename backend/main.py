from __future__ import annotations

from collections import Counter, defaultdict
import hashlib
import json
import os
import re
from random import randint
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timedelta
from typing import Any
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import case, or_
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

import models
import schemas
from cms_preview import PreviewUnavailable, resolve_camera_preview
from database import SessionLocal, engine


app = FastAPI(title="VIoT Ops Backend API", version="0.1.0")

BASE_DIR = Path(__file__).resolve().parent
VIDEOS_DIR = BASE_DIR / "videos"
NORMAL_VIDEO_NAME = "normal.mp4"
ANOMALY_VIDEO_NAME = "anomaly.mp4"
RUNTIME_PROFILE_FILE = Path(os.getenv("VIOT_RUNTIME_PROFILE_FILE", str(BASE_DIR / "runtime_profile.json")))
ACTIVE_FLOW_CACHE_FILE = Path(os.getenv("VIOT_ACTIVE_FLOW_CACHE_FILE", str(BASE_DIR / "active_flows_cache.json")))
CHAINLIST_FILE = Path(os.getenv("VIOT_CHAINLIST_FILE", "/home/monitor_realtime/chainlist.json"))
MATCH_SCRIPT_PATH = Path(os.getenv("VIOT_MATCH_SCRIPT_PATH", "/home/monitor_realtime/network/match_uplink_downlink_flows.py"))
MATCH_OUTPUT_FILE = Path(os.getenv("VIOT_MATCH_OUTPUT_FILE", "/home/monitor_realtime/network/uplink_downlink_match.json"))
ANOMALY_LOG_FILE = Path(os.getenv("VIOT_ANOMALY_LOG_FILE", "/home/monitor_realtime/output/anomaly_log.jsonl"))
MAX_COLLECTABLE_FLOWS = int(os.getenv("VIOT_MAX_COLLECTABLE_FLOWS", "5"))
STREAM_MEDIA_SERVER_IP = os.getenv("VIOT_STREAM_MEDIA_SERVER_IP", "10.193.12.10")
STREAM_MEDIA_SERVER_ID = os.getenv("VIOT_STREAM_MEDIA_SERVER_ID", f"流媒体服务-{STREAM_MEDIA_SERVER_IP}")
RUNTIME_PROFILE_OPTIONS = [
    {"value": "aliyun-offline1", "label": "阿里云离线检测 1", "description": "读取阿里云离线数据文件。"},
    {"value": "aliyun-offline2", "label": "阿里云离线检测 2", "description": "读取阿里云 offline2/replay socket 数据。"},
    {"value": "aliyun-hybrid", "label": "阿里云混合检测", "description": "阿里云环境下混合使用历史与实时数据。"},
    {"value": "dianxin-hybrid", "label": "电信混合检测", "description": "电信环境下混合使用历史与实时数据。"},
    {"value": "dianxin-live", "label": "电信实时检测", "description": "电信实时采集链路模式。"},
]
REQUIRED_UPLINK_FIELDS = ("ip_src", "ip_dst", "ssrc", "port_src", "port_dst")
REQUIRED_DOWNLINK_FIELDS = ("ip_src", "ip_dst", "port_src", "port_dst")

app.mount("/videos", StaticFiles(directory=VIDEOS_DIR), name="videos")


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def create_runtime_tables() -> None:
    models.WorkOrder.__table__.create(bind=engine, checkfirst=True)
    models.VideoDiagnosis.__table__.create(bind=engine, checkfirst=True)
    models.DeviceGroup.__table__.create(bind=engine, checkfirst=True)
    models.group_camera_link.create(bind=engine, checkfirst=True)
    models.StreamMediaSegment.__table__.create(bind=engine, checkfirst=True)
    _ensure_runtime_profile_file()
    _ensure_active_flow_cache_file()
    _normalize_existing_camera_protocols()
    _ensure_huli_alarm_demo_cameras()
    _ensure_huli_fake_camera_fleet()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _write_json_file(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _read_json_file(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def _ensure_runtime_profile_file() -> None:
    if RUNTIME_PROFILE_FILE.exists():
        return
    _write_json_file(
        RUNTIME_PROFILE_FILE,
        {
            "runtime_profile": "aliyun-offline2",
            "updated_at": datetime.utcnow().isoformat() + "Z",
            "updated_by": "system",
        },
    )


def _ensure_active_flow_cache_file() -> None:
    if ACTIVE_FLOW_CACHE_FILE.exists():
        return
    _write_json_file(
        ACTIVE_FLOW_CACHE_FILE,
        {
            "updated_at": None,
            "source_file": None,
            "raw_payload": {},
            "flows": [],
            "chainlist_format": "device_map",
        },
    )


def _runtime_profile_options() -> list[schemas.RuntimeProfileOption]:
    return [schemas.RuntimeProfileOption(**item) for item in RUNTIME_PROFILE_OPTIONS]


def _read_runtime_profile_payload() -> dict[str, Any]:
    _ensure_runtime_profile_file()
    payload = _read_json_file(RUNTIME_PROFILE_FILE, {})
    runtime_profile = str(payload.get("runtime_profile") or "aliyun-offline2").strip().lower()
    valid_values = {item["value"] for item in RUNTIME_PROFILE_OPTIONS}
    if runtime_profile not in valid_values:
        raise HTTPException(status_code=500, detail=f"runtime_profile 非法：{runtime_profile}")
    return {
        "runtime_profile": runtime_profile,
        "updated_at": payload.get("updated_at"),
        "updated_by": payload.get("updated_by"),
    }


def _build_runtime_profile_response() -> schemas.RuntimeProfileRead:
    payload = _read_runtime_profile_payload()
    updated_at = None
    if payload.get("updated_at"):
        updated_at = datetime.fromisoformat(str(payload["updated_at"]).replace("Z", "+00:00"))
    return schemas.RuntimeProfileRead(
        runtime_profile=payload["runtime_profile"],
        updated_at=updated_at,
        updated_by=payload.get("updated_by"),
        profile_file=str(RUNTIME_PROFILE_FILE),
        auto_restart_enabled=True,
        options=_runtime_profile_options(),
    )


def _segment_key(direction: str, source_ip: str, source_port: int | None, destination_ip: str, destination_port: int | None, ssrc: str | None) -> str:
    return ":".join([
        direction,
        source_ip or "",
        "" if source_port is None else str(source_port),
        destination_ip or "",
        "" if destination_port is None else str(destination_port),
        ssrc or "",
    ])


def _normalize_flow_endpoint(data: Any) -> dict[str, str | None]:
    if not isinstance(data, dict):
        return {
            "ip_src": None,
            "ip_dst": None,
            "ssrc": None,
            "ssrc_hex": None,
            "port_src": None,
            "port_dst": None,
        }
    return {
        "ip_src": str(data.get("ip_src")).strip() if data.get("ip_src") else None,
        "ip_dst": str(data.get("ip_dst")).strip() if data.get("ip_dst") else None,
        "ssrc": str(data.get("ssrc")).strip() if data.get("ssrc") else None,
        "ssrc_hex": str(data.get("ssrc_hex")).strip() if data.get("ssrc_hex") else None,
        "port_src": str(data.get("port_src")).strip() if data.get("port_src") else None,
        "port_dst": str(data.get("port_dst")).strip() if data.get("port_dst") else None,
    }


def _flow_missing_fields(uplink: dict[str, Any], downlinks: list[dict[str, Any]]) -> list[str]:
    missing = [field for field in REQUIRED_UPLINK_FIELDS if not uplink.get(field)]
    if not downlinks:
        missing.append("downlink")
        return missing

    has_complete_downlink = False
    for item in downlinks:
        if not [field for field in REQUIRED_DOWNLINK_FIELDS if not item.get(field)]:
            has_complete_downlink = True
            break
    if not has_complete_downlink:
        missing.extend([f"downlink.{field}" for field in REQUIRED_DOWNLINK_FIELDS])
    return missing


def _normalize_raw_active_flows(payload: Any) -> list[dict[str, Any]]:
    flows: list[dict[str, Any]] = []
    if not isinstance(payload, dict):
        return flows

    source_payload = {"default": payload} if "uplink" in payload or "downlink" in payload else payload
    for device_id, value in source_payload.items():
        if not isinstance(value, dict):
            continue
        uplink = _normalize_flow_endpoint(value.get("uplink") or {})
        downlinks = [
            _normalize_flow_endpoint(item)
            for item in (value.get("downlink") or [])
            if isinstance(item, dict)
        ]
        missing_fields = _flow_missing_fields(uplink, downlinks)
        flows.append(
            {
                "device_id": str(device_id),
                "camera_name": str(device_id),
                "camera_ip": uplink.get("ip_src"),
                "server_ip": uplink.get("ip_dst") or (downlinks[0].get("ip_src") if downlinks else None),
                "uplink": uplink,
                "downlink": downlinks,
                "collectable": not missing_fields,
                "missing_fields": missing_fields,
                "connectivity_status": "connected" if not missing_fields else "config_missing",
                "detection_status": "idle" if not missing_fields else "config_missing",
                "matched_anomaly_count": 0,
                "matched_anomaly_types": [],
            }
        )
    return flows


def _int_or_none(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _hash_stream_id(*parts: Any) -> str:
    raw = "|".join(str(part or "").strip() for part in parts)
    return f"match-{hashlib.sha1(raw.encode('utf-8')).hexdigest()[:16]}"


def _clean_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _first_present(*values: Any) -> str:
    for value in values:
        text = _clean_text(value)
        if text:
            return text
    return ""


def _has_text(value: Any) -> bool:
    return bool(_clean_text(value))


def _merge_non_empty(existing: Any, incoming: Any) -> Any:
    return incoming if _has_text(incoming) and not _has_text(existing) else existing


def _complete_uplink_segment(segment: models.StreamMediaSegment | None) -> bool:
    return bool(
        segment
        and segment.direction == "uplink"
        and _has_text(segment.source_ip)
        and _has_text(segment.destination_ip)
        and segment.source_port is not None
        and segment.destination_port is not None
        and _has_text(segment.ssrc)
    )


def _complete_downlink_segment(segment: models.StreamMediaSegment | None) -> bool:
    return bool(
        segment
        and segment.direction == "downlink"
        and _has_text(segment.source_ip)
        and _has_text(segment.destination_ip)
        and segment.source_port is not None
        and segment.destination_port is not None
    )


def _stream_has_complete_chain(stream: models.StreamMedia) -> bool:
    segments = list(stream.segments or [])
    return any(_complete_uplink_segment(item) for item in segments) and any(_complete_downlink_segment(item) for item in segments)


def _default_camera_region(db: Session) -> dict[str, str]:
    camera = db.query(models.Camera).first()
    if camera:
        return {
            "province_code": camera.province_code,
            "province_name": camera.province_name,
            "city_code": camera.city_code,
            "city_name": camera.city_name,
            "county_code": camera.county_code,
            "county_name": camera.county_name,
            "town_code": camera.town_code,
            "town_name": camera.town_name,
        }
    return {
        "province_code": "110000",
        "province_name": "北京市",
        "city_code": "110100",
        "city_name": "北京市",
        "county_code": "110108",
        "county_name": "海淀区",
        "town_code": "110108-btpz",
        "town_name": "北太平庄",
    }


def _ensure_stream_camera(db: Session, flow: dict[str, Any], server_id: str, now: datetime) -> str | None:
    device_id = str(flow.get("device_id") or "").strip()
    camera_ip = str(flow.get("camera_ip") or "").strip()
    if device_id:
        camera = db.get(models.Camera, device_id)
        if camera:
            if camera_ip:
                camera.ip = camera_ip
            camera.status = "online"
            camera.server_id = server_id
            camera.protocol = camera.protocol or "RTP"
            camera.stream_type = camera.stream_type or "main"
            camera.access_type = camera.access_type or "Ethernet"
            camera.last_heartbeat = now
            db.add(camera)
            return camera.id

        camera = models.Camera(
            id=device_id,
            name=str(flow.get("camera_name") or device_id),
            ip=camera_ip or "",
            status="online",
            protocol="RTP",
            stream_type="main",
            access_type="Ethernet",
            server_id=server_id,
            last_heartbeat=now,
            **_default_camera_region(db),
        )
        db.add(camera)
        return camera.id

    if camera_ip:
        camera = db.query(models.Camera).filter(models.Camera.ip == camera_ip).first()
        if camera:
            return camera.id
    return None


def _ensure_stream_media_server(db: Session) -> str:
    server = db.get(models.Server, STREAM_MEDIA_SERVER_ID)
    if server:
        if server.ip != STREAM_MEDIA_SERVER_IP:
            server.ip = STREAM_MEDIA_SERVER_IP
            db.add(server)
        return server.id

    server = models.Server(
        id=STREAM_MEDIA_SERVER_ID,
        name=STREAM_MEDIA_SERVER_ID,
        ip=STREAM_MEDIA_SERVER_IP,
        node_type="stream_server",
        status="normal",
        location_desc="match脚本识别的流媒体服务",
    )
    db.add(server)
    return server.id


def _upsert_flow_segment(db: Session, stream_media_id: str, direction: str, endpoint: dict[str, Any], ssrc: str | None, now: datetime) -> str | None:
    source_ip = _clean_text(endpoint.get("ip_src"))
    destination_ip = _clean_text(endpoint.get("ip_dst"))
    if not source_ip and not destination_ip:
        return None

    source_port = _int_or_none(endpoint.get("port_src"))
    destination_port = _int_or_none(endpoint.get("port_dst"))
    segment_ssrc = _first_present(ssrc, endpoint.get("ssrc"), endpoint.get("ssrc_hex"))
    key = _segment_key(
        direction,
        source_ip,
        source_port,
        destination_ip,
        destination_port,
        segment_ssrc,
    )
    segment = db.query(models.StreamMediaSegment).filter(models.StreamMediaSegment.segment_key == key).first()
    payload = {
        "stream_media_id": stream_media_id,
        "segment_key": key,
        "direction": direction,
        "source_ip": source_ip,
        "source_port": source_port,
        "destination_ip": destination_ip,
        "destination_port": destination_port,
        "ssrc": segment_ssrc or None,
        "status": "online" if source_ip and destination_ip else "config_missing",
        "is_fault": False,
        "last_seen_at": now,
    }
    if segment:
        for key_name, value in payload.items():
            if key_name in {"status", "is_fault", "last_seen_at"}:
                setattr(segment, key_name, value)
            else:
                setattr(segment, key_name, _merge_non_empty(getattr(segment, key_name), value))
    else:
        segment = models.StreamMediaSegment(**payload, first_seen_at=now)
    db.add(segment)
    return key


def _sync_active_flows_to_database(db: Session, flows: list[dict[str, Any]]) -> dict[str, int]:
    now = datetime.utcnow()
    server_id = _ensure_stream_media_server(db)
    seen_stream_ids: set[str] = set()
    seen_segment_keys: set[str] = set()
    updated_streams = 0

    for flow in flows:
        uplink = flow.get("uplink") or {}
        source_ip = _first_present(uplink.get("ip_src"), flow.get("camera_ip"))
        destination_ip = _clean_text(uplink.get("ip_dst"))
        ssrc = _first_present(uplink.get("ssrc"), uplink.get("ssrc_hex"))
        if not destination_ip and not source_ip and not ssrc:
            continue

        stream_id = _hash_stream_id(flow.get("device_id"), source_ip, destination_ip, ssrc)
        stream = db.get(models.StreamMedia, stream_id)
        payload = {
            "source_ip": source_ip,
            "source_port": _int_or_none(uplink.get("port_src")) or 0,
            "destination_ip": destination_ip,
            "destination_port": _int_or_none(uplink.get("port_dst")) or 0,
            "ssrc": str(ssrc or ""),
            "camera_id": _ensure_stream_camera(db, flow, server_id, now),
            "server_id": server_id,
            "transport_protocol": "RTP",
            "is_connected": True,
            "is_fault": False,
            "link_type": "实时流链路",
            "stream_type": "主码流",
            "last_update_time": now,
        }
        if stream:
            for key_name, value in payload.items():
                if key_name in {"is_connected", "is_fault", "last_update_time", "transport_protocol", "link_type", "stream_type", "server_id", "camera_id"}:
                    setattr(stream, key_name, value)
                else:
                    setattr(stream, key_name, _merge_non_empty(getattr(stream, key_name), value))
        else:
            stream = models.StreamMedia(id=stream_id, **payload)
        db.add(stream)
        seen_stream_ids.add(stream_id)
        updated_streams += 1

        segment_key = _upsert_flow_segment(db, stream_id, "uplink", uplink, str(ssrc or ""), now)
        if segment_key:
            seen_segment_keys.add(segment_key)
        for downlink in flow.get("downlink") or []:
            segment_key = _upsert_flow_segment(db, stream_id, "downlink", downlink, None, now)
            if segment_key:
                seen_segment_keys.add(segment_key)

    offline_streams = 0
    for stream in db.query(models.StreamMedia).filter(models.StreamMedia.id.like("match-%")).all():
        if stream.id not in seen_stream_ids:
            stream.is_connected = False
            stream.last_update_time = now
            db.add(stream)
            offline_streams += 1

    offline_segments = 0
    for segment in (
        db.query(models.StreamMediaSegment)
        .join(models.StreamMedia, models.StreamMedia.id == models.StreamMediaSegment.stream_media_id)
        .filter(models.StreamMedia.id.like("match-%"))
        .all()
    ):
        if segment.segment_key not in seen_segment_keys:
            segment.status = "offline"
            segment.last_seen_at = now
            db.add(segment)
            offline_segments += 1

    return {
        "streams_seen": len(seen_stream_ids),
        "segments_seen": len(seen_segment_keys),
        "streams_updated": updated_streams,
        "streams_marked_offline": offline_streams,
        "segments_marked_offline": offline_segments,
    }


def _build_chainlist_payload(flows: list[dict[str, Any]]) -> tuple[str, dict[str, Any]]:
    payload: dict[str, Any] = {}
    for flow in [item for item in flows if item.get("collectable")][:MAX_COLLECTABLE_FLOWS]:
        payload[str(flow["device_id"])] = {
            "uplink": {
                key: flow["uplink"].get(key)
                for key in ("ip_src", "ip_dst", "ssrc", "ssrc_hex", "port_src", "port_dst")
                if flow["uplink"].get(key) is not None
            },
            "downlink": [
                {
                    key: item.get(key)
                    for key in ("ip_src", "ip_dst", "port_src", "port_dst", "ssrc", "ssrc_hex")
                    if item.get(key) is not None
                }
                for item in flow.get("downlink", [])
                if not [field for field in REQUIRED_DOWNLINK_FIELDS if not item.get(field)]
            ],
        }
    return "device_map", payload


def _stream_to_chainlist_entry(stream: models.StreamMedia) -> dict[str, Any] | None:
    segments = list(stream.segments or [])
    uplink = next((item for item in segments if _complete_uplink_segment(item)), None)
    downlinks = [item for item in segments if _complete_downlink_segment(item)]
    if not uplink or not downlinks:
        return None
    entry = {
        "uplink": {
            "ip_src": uplink.source_ip,
            "ip_dst": uplink.destination_ip,
            "ssrc": uplink.ssrc,
            "port_src": str(uplink.source_port),
            "port_dst": str(uplink.destination_port),
        },
        "downlink": [
            {
                "ip_src": item.source_ip,
                "ip_dst": item.destination_ip,
                "port_src": str(item.source_port),
                "port_dst": str(item.destination_port),
            }
            for item in downlinks
        ],
    }
    if str(uplink.ssrc or "").isdigit():
        entry["uplink"]["ssrc_hex"] = f"0x{int(uplink.ssrc):08x}"
    return entry


def _build_chainlist_from_streams(streams: list[models.StreamMedia]) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    for stream in streams[:MAX_COLLECTABLE_FLOWS]:
        entry = _stream_to_chainlist_entry(stream)
        if not entry:
            continue
        key = stream.camera_id or stream.id
        payload[str(key)] = entry
    return payload


def _load_active_flow_cache() -> dict[str, Any]:
    raw_payload = _read_json_file(MATCH_OUTPUT_FILE, {})
    flows = _normalize_raw_active_flows(raw_payload) if isinstance(raw_payload, dict) else []
    return {
        "updated_at": datetime.fromtimestamp(MATCH_OUTPUT_FILE.stat().st_mtime).isoformat() + "Z" if MATCH_OUTPUT_FILE.exists() else None,
        "source_file": str(MATCH_OUTPUT_FILE),
        "raw_payload": raw_payload if isinstance(raw_payload, dict) else {},
        "flows": flows,
        "chainlist_format": "device_map",
    }


def _extract_ips(text: str) -> list[str]:
    return re.findall(r"(?:\d{1,3}\.){3}\d{1,3}", text or "")


def _anomaly_identity_keys(entity_id: str, entity_type: str) -> set[str]:
    keys = set()
    text = str(entity_id or "").strip()
    if not text:
        return keys
    keys.add(text)
    parts = [part for part in text.split("_") if part]
    ips = _extract_ips(text)
    if entity_type == "network_uplink" and len(parts) >= 3 and len(ips) >= 2:
        keys.add(f"uplink|{ips[0]}|{ips[1]}|{parts[-1]}")
    elif entity_type == "network_downlink" and len(parts) >= 4 and len(ips) >= 2:
        keys.add(f"downlink|{ips[0]}|{ips[1]}|{parts[2]}|{parts[3]}")
    return keys


def _build_flow_lookup(flows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    lookup: dict[str, dict[str, Any]] = {}
    for flow in flows:
        uplink = flow.get("uplink") or {}
        if uplink.get("ip_src") and uplink.get("ip_dst") and (uplink.get("ssrc_hex") or uplink.get("ssrc")):
            lookup[f"uplink|{uplink.get('ip_src')}|{uplink.get('ip_dst')}|{uplink.get('ssrc_hex') or uplink.get('ssrc')}"] = flow
        for item in flow.get("downlink") or []:
            if item.get("ip_src") and item.get("ip_dst") and item.get("port_src") and item.get("port_dst"):
                lookup[f"downlink|{item.get('ip_src')}|{item.get('ip_dst')}|{item.get('port_src')}|{item.get('port_dst')}"] = flow
    return lookup


def _collect_algorithm_anomalies(limit: int = 100) -> list[dict[str, Any]]:
    if not ANOMALY_LOG_FILE.exists():
        return []
    lines = ANOMALY_LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines()
    flow_lookup = _build_flow_lookup(_load_active_flow_cache().get("flows") or [])
    records: list[dict[str, Any]] = []

    for line in reversed(lines[-max(limit * 4, limit):]):
        if not line.strip():
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        for index, entity in enumerate(payload.get("entities") or []):
            entity_id = str(entity.get("anomaly_entity_id") or "").strip()
            entity_type = str(entity.get("anomaly_entity_type") or "").strip()
            matched_flow = None
            for key in _anomaly_identity_keys(entity_id, entity_type):
                matched_flow = flow_lookup.get(key)
                if matched_flow:
                    break
            ips = _extract_ips(entity_id)
            records.append(
                {
                    "id": f"{payload.get('run_id') or 'run'}-{payload.get('timestamp')}-{index}",
                    "timestamp": payload.get("timestamp"),
                    "source_label": str(matched_flow.get("device_id")) if matched_flow else (ips[0] if ips else entity_id or "unknown"),
                    "anomaly_entity_id": entity_id,
                    "anomaly_entity_type": entity_type,
                    "anomaly_type": entity.get("anomaly_type"),
                    "anomaly_score": entity.get("anomaly_score"),
                    "anomaly_column": entity.get("anomaly_column"),
                    "anomaly_column_value": entity.get("anomaly_column_value"),
                    "global_anomaly_score": payload.get("global_anomaly_score"),
                    "root_cause_entity": payload.get("root_cause_entity"),
                    "root_cause_entity_type": payload.get("root_cause_entity_type"),
                    "device_id": matched_flow.get("device_id") if matched_flow else None,
                    "camera_ip": matched_flow.get("camera_ip") if matched_flow else (ips[0] if ips else None),
                    "server_ip": matched_flow.get("server_ip") if matched_flow else (ips[1] if len(ips) > 1 else None),
                    "run_id": payload.get("run_id"),
                    "prediction": entity.get("prediction"),
                    "reconstruction_error": entity.get("reconstruction_error"),
                    "raw": payload,
                }
            )
            if len(records) >= limit:
                return list(reversed(records))
    return list(reversed(records))


def _attach_anomaly_status_to_flows(flows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_device: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in _collect_algorithm_anomalies(limit=200):
        if item.get("device_id"):
            by_device[str(item["device_id"])].append(item)

    for flow in flows:
        matches = by_device.get(str(flow.get("device_id")), [])
        flow["matched_anomaly_count"] = len(matches)
        flow["matched_anomaly_types"] = sorted({str(item.get("anomaly_type") or "") for item in matches if item.get("anomaly_type")})
        if not flow.get("collectable"):
            flow["detection_status"] = "config_missing"
        elif matches:
            flow["detection_status"] = "anomaly"
        else:
            flow["detection_status"] = "ready"
    return flows


def _build_active_flow_response_from_cache() -> schemas.AlgorithmActiveFlowResponse:
    payload = _load_active_flow_cache()
    updated_at = None
    if payload.get("updated_at"):
        updated_at = datetime.fromisoformat(str(payload["updated_at"]).replace("Z", "+00:00"))
    flows = _attach_anomaly_status_to_flows(list(payload.get("flows") or []))
    return schemas.AlgorithmActiveFlowResponse(
        updated_at=updated_at,
        source_file=payload.get("source_file"),
        chainlist_file=str(CHAINLIST_FILE),
        raw_flow_count=len(flows),
        collectable_flow_count=len([item for item in flows if item.get("collectable")]),
        chainlist_format=str(payload.get("chainlist_format") or "device_map"),
        flows=[schemas.AlgorithmActiveFlowItem(**item) for item in flows],
    )


def _ensure_huli_alarm_demo_cameras() -> None:
    db = SessionLocal()
    try:
        province = db.get(models.AdministrativeRegion, "350000")
        city = db.get(models.AdministrativeRegion, "350200")
        county = db.get(models.AdministrativeRegion, "350206")
        if not province or not city or not county:
            return

        towns = (
            db.query(models.AdministrativeRegion)
            .filter(models.AdministrativeRegion.parent_code == county.region_code)
            .filter(models.AdministrativeRegion.level == "town")
            .all()
        )
        town_by_name = {town.region_name: town for town in towns}
        fallback_town = towns[0] if towns else None
        if not fallback_town:
            return

        server = db.get(models.Server, "srv-huli-alarm-demo")
        if not server:
            server = models.Server(
                id="srv-huli-alarm-demo",
                name="湖里区视频告警演示边缘节点",
                ip="10.35.206.88",
                node_type="stream_server",
                status="normal",
                location_desc="福建省厦门市湖里区云顶北路与枋湖北二路周边",
                longitude=118.1519,
                latitude=24.5235,
                cpu_usage=42.0,
                ram_usage=51.0,
                disk_usage=47.0,
                net_bandwidth=68.0,
                gpu_usage=18.0,
                last_heartbeat=datetime.utcnow(),
            )
            db.add(server)
            db.flush()

        demo_points = [
            ("alarm-demo-flower-001", "金山街道", "五缘湾乐都汇西门", 118.1768, 24.5254, "fault"),
            ("alarm-demo-flower-002", "金山街道", "湖里万达广场1号门", 118.1812, 24.5058, "fault"),
            ("alarm-demo-flower-003", "江头街道", "SM城市广场一期东侧路口", 118.1260, 24.4968, "fault"),
            ("alarm-demo-flower-004", "江头街道", "吕厝地铁站3号口", 118.1277, 24.4891, "fault"),
            ("alarm-demo-flower-005", "禾山街道", "枋湖客运中心南广场", 118.1522, 24.5234, "fault"),
            ("alarm-demo-flower-006", "禾山街道", "湖里创新园公交首末站", 118.1642, 24.5213, "fault"),
            ("alarm-demo-flower-007", "殿前街道", "高崎火车站进站口", 118.1166, 24.5437, "fault"),
            ("alarm-demo-flower-008", "湖里街道", "湖里公园南门", 118.1039, 24.5122, "fault"),
            ("alarm-demo-normal-001", "金山街道", "五缘湾湿地公园西门", 118.1785, 24.5318, "online"),
            ("alarm-demo-normal-002", "江头街道", "台湾街江头市场路口", 118.1235, 24.4976, "online"),
            ("alarm-demo-normal-003", "禾山街道", "枋湖路车管所路口", 118.1546, 24.5169, "online"),
            ("alarm-demo-normal-004", "殿前街道", "殿前一路公交站", 118.1137, 24.5324, "online"),
            ("alarm-demo-normal-005", "湖里街道", "湖里大道特区纪念馆路口", 118.1031, 24.5113, "online"),
            ("alarm-demo-normal-006", "金山街道", "金湖路云顶北路路口", 118.1589, 24.5097, "online"),
            ("alarm-demo-normal-007", "江头街道", "仙岳路台湾街路口", 118.1209, 24.5035, "online"),
            ("alarm-demo-normal-008", "禾山街道", "坂尚社区服务中心路口", 118.1493, 24.5381, "online"),
            ("alarm-demo-normal-009", "殿前街道", "长虹路殿前六路路口", 118.1119, 24.5262, "online"),
            ("alarm-demo-normal-010", "湖里街道", "东渡路海天码头路口", 118.0837, 24.4896, "online"),
        ]

        now = datetime.utcnow()
        for index, (camera_id, town_name, poi_name, lon, lat, status_value) in enumerate(demo_points, start=1):
            town = town_by_name.get(town_name) or fallback_town
            camera = db.get(models.Camera, camera_id)
            if not camera:
                camera = models.Camera(
                    id=camera_id,
                    name=f"{town.region_name}-{poi_name}-视频质量监测-{index:04d}",
                    model="DS-2CD7A47",
                    vendor="海康威视",
                    ip=f"10.206.88.{index}",
                    status=status_value,
                    protocol="RTSP",
                    codec="H.265",
                    stream_type="main",
                    access_type="Ethernet",
                    unit="湖里区城市运行管理中心",
                    manager="值班运维",
                    province_code=province.region_code,
                    province_name=province.region_name,
                    city_code=city.region_code,
                    city_name=city.region_name,
                    county_code=county.region_code,
                    county_name=county.region_name,
                    town_code=town.region_code,
                    town_name=town.region_name,
                    location_desc=f"{province.region_name}{city.region_name}{county.region_name}{town.region_name}{poi_name}",
                    longitude=lon,
                    latitude=lat,
                    server_id=server.id,
                    video_url=f"rtsp://example.com/huli/{camera_id}",
                    last_heartbeat=now - timedelta(minutes=randint(1, 12)),
                )
                db.add(camera)
            else:
                camera.status = status_value
                camera.town_code = town.region_code
                camera.town_name = town.region_name
                camera.longitude = lon
                camera.latitude = lat
                camera.server_id = server.id
                camera.last_heartbeat = now - timedelta(minutes=randint(1, 12))

            stream_id = f"stream-{camera_id}"
            stream = db.get(models.StreamMedia, stream_id)
            is_fault = status_value == "fault"
            if not stream:
                stream = models.StreamMedia(
                    id=stream_id,
                    source_ip=f"10.206.88.{index}",
                    source_port=5600 + index,
                    destination_ip=server.ip,
                    destination_port=8600 + index,
                    ssrc=f"alarm-demo-ssrc-{index:04d}",
                    camera_id=camera_id,
                    server_id=server.id,
                    codec="H.265",
                    resolution="1920x1080",
                    frame_rate=25.0,
                    transport_protocol="RTP",
                    link_type="rtp_push",
                    stream_type="main",
                    last_update_time=now,
                )
                db.add(stream)

            stream.is_connected = True
            stream.is_fault = is_fault
            stream.real_time_bitrate = 1.4 + index * 0.06 if is_fault else 5.2 + index * 0.08
            stream.throughput = 1.2 + index * 0.05 if is_fault else 6.0 + index * 0.1
            stream.latency = 112 + index * 4 if is_fault else 42 + index
            stream.jitter = 34 + index * 2.4 if is_fault else 6 + index * 0.4
            stream.packet_loss_rate = 1.8 + index * 0.18 if is_fault else 0.08 + index * 0.02
            stream.qoe_score = 58 - index * 0.8 if is_fault else 92 - index * 0.2
            stream.last_update_time = now

        db.commit()
    except Exception as exc:
        db.rollback()
        print(f"初始化湖里区异常告警演示摄像机失败: {exc}")
    finally:
        db.close()


def _ensure_huli_fake_camera_fleet() -> None:
    db = SessionLocal()
    try:
        legacy_f_camera_ids = [
            camera_id
            for (camera_id,) in db.query(models.Camera.id).filter(models.Camera.id.like("F%")).all()
        ]
        if legacy_f_camera_ids:
            db.query(models.StreamMedia).filter(models.StreamMedia.camera_id.in_(legacy_f_camera_ids)).delete(synchronize_session=False)
            db.query(models.VideoDiagnosis).filter(models.VideoDiagnosis.camera_id.in_(legacy_f_camera_ids)).delete(synchronize_session=False)
            db.query(models.WorkOrder).filter(models.WorkOrder.related_entity_id.in_(legacy_f_camera_ids)).delete(synchronize_session=False)
            db.query(models.Camera).filter(models.Camera.id.in_(legacy_f_camera_ids)).delete(synchronize_session=False)
            db.flush()

        province = db.get(models.AdministrativeRegion, "350000")
        city = db.get(models.AdministrativeRegion, "350200")
        county = db.get(models.AdministrativeRegion, "350206")
        if not province or not city or not county:
            return

        towns = (
            db.query(models.AdministrativeRegion)
            .filter(models.AdministrativeRegion.parent_code == county.region_code)
            .filter(models.AdministrativeRegion.level == "town")
            .order_by(models.AdministrativeRegion.region_name)
            .all()
        )
        if not towns:
            return

        server = db.get(models.Server, "srv-huli-fake-fleet")
        if not server:
            server = models.Server(
                id="srv-huli-fake-fleet",
                name="湖里区虚拟接入汇聚节点",
                ip="10.35.206.188",
                node_type="stream_server",
                status="normal",
                location_desc="福建省厦门市湖里区虚拟摄像机接入汇聚节点",
                longitude=118.1458,
                latitude=24.5168,
                cpu_usage=58.0,
                ram_usage=62.0,
                disk_usage=55.0,
                net_bandwidth=72.0,
                gpu_usage=24.0,
                last_heartbeat=datetime.utcnow(),
            )
            db.add(server)
            db.flush()

        pois = [
            ("五缘湾湿地公园", 118.1805, 24.5312),
            ("湖里万达广场", 118.1811, 24.5060),
            ("湖里创新园", 118.1642, 24.5215),
            ("枋湖客运中心", 118.1524, 24.5234),
            ("SM城市广场", 118.1260, 24.4968),
            ("吕厝地铁站", 118.1277, 24.4891),
            ("湖里公园", 118.1039, 24.5122),
            ("高崎火车站", 118.1166, 24.5437),
            ("东渡邮轮中心", 118.0834, 24.4902),
            ("仙岳路台湾街", 118.1209, 24.5035),
            ("金湖路云顶北路", 118.1589, 24.5097),
            ("殿前一路", 118.1137, 24.5324),
            ("坂尚社区", 118.1493, 24.5381),
            ("海天码头", 118.0837, 24.4896),
            ("江头市场", 118.1235, 24.4976),
            ("五通客运码头", 118.2017, 24.5289),
            ("马垄路口", 118.1098, 24.5204),
            ("寨上社", 118.0924, 24.5248),
            ("钟宅畲族社区", 118.1884, 24.5336),
            ("金尚路口", 118.1428, 24.5094),
        ]
        vendors = ["海康威视", "大华", "宇视", "华为好望", "天地伟业"]
        models_by_vendor = {
            "海康威视": "DS-2CD7A47",
            "大华": "DH-IPC-HFW5443",
            "宇视": "IPC-B2A5",
            "华为好望": "D2120-10-SIU",
            "天地伟业": "TC-C55MS",
        }
        now = datetime.utcnow()
        total = 2000
        online_cutoff = 1200
        fault_cutoff = 1800

        for index in range(1, total + 1):
            camera_id = f"Z{index:06d}"
            town = towns[(index - 1) % len(towns)]
            poi_name, base_lon, base_lat = pois[(index - 1) % len(pois)]
            ring = (index - 1) // len(pois)
            lon = round(base_lon + (((ring % 11) - 5) * 0.00042) + (((index % 7) - 3) * 0.00008), 6)
            lat = round(base_lat + ((((ring // 11) % 9) - 4) * 0.00036) + (((index % 5) - 2) * 0.00007), 6)

            if index <= online_cutoff:
                status_value = "online"
            elif index <= fault_cutoff:
                status_value = "fault"
            else:
                status_value = "offline"

            vendor = vendors[index % len(vendors)]
            camera = db.get(models.Camera, camera_id)
            camera_data = {
                "name": f"Z{town.region_name}-{poi_name}-虚拟接入摄像机-{index:04d}",
                "model": models_by_vendor[vendor],
                "vendor": vendor,
                "ip": f"10.207.{(index - 1) // 250 + 1}.{(index - 1) % 250 + 1}",
                "status": status_value,
                "protocol": "RTSP",
                "codec": "H.265" if index % 3 else "H.264",
                "stream_type": "main",
                "access_type": "Ethernet",
                "unit": "湖里区城市运行管理中心",
                "manager": "值班运维",
                "province_code": province.region_code,
                "province_name": province.region_name,
                "city_code": city.region_code,
                "city_name": city.region_name,
                "county_code": county.region_code,
                "county_name": county.region_name,
                "town_code": town.region_code,
                "town_name": town.region_name,
                "location_desc": f"{province.region_name}{city.region_name}{county.region_name}{town.region_name}{poi_name}周边",
                "longitude": lon,
                "latitude": lat,
                "server_id": server.id,
                "video_url": f"rtsp://example.com/huli/fake/{camera_id}",
                "last_heartbeat": now - timedelta(minutes=randint(1, 45)),
            }

            if not camera:
                camera = models.Camera(id=camera_id, **camera_data)
                db.add(camera)
            else:
                for key, value in camera_data.items():
                    setattr(camera, key, value)

            stream_id = f"stream-{camera_id}"
            stream = db.get(models.StreamMedia, stream_id)
            if not stream:
                stream = models.StreamMedia(
                    id=stream_id,
                    source_port=554,
                    destination_port=1935,
                    ssrc=f"fake-ssrc-{index:06d}",
                    camera_id=camera_id,
                    server_id=server.id,
                    resolution="1920x1080",
                    frame_rate=25.0,
                    transport_protocol="RTP",
                    link_type="rtp_push",
                    stream_type="main",
                )
                db.add(stream)

            stream.source_ip = camera_data["ip"]
            stream.destination_ip = server.ip
            stream.codec = camera_data["codec"]
            stream.is_connected = status_value != "offline"
            stream.is_fault = status_value == "fault"
            stream.real_time_bitrate = 5.6 + (index % 12) * 0.08
            stream.throughput = 6.2 + (index % 10) * 0.1
            stream.latency = 46 + (index % 18)
            stream.jitter = 6 + (index % 8) * 0.7
            stream.packet_loss_rate = 0.08 + (index % 6) * 0.02
            stream.qoe_score = 90 - (index % 9) * 0.4
            if status_value == "fault":
                stream.latency = 168 + (index % 45)
                stream.jitter = 32 + (index % 22)
                stream.throughput = 2.4 + (index % 10) * 0.08
                stream.real_time_bitrate = 2.0 + (index % 8) * 0.08
                stream.packet_loss_rate = 0.22 + (index % 5) * 0.04
                stream.qoe_score = 62 - (index % 12) * 0.9
            elif status_value == "offline":
                stream.throughput = 0
                stream.real_time_bitrate = 0
                stream.latency = None
                stream.jitter = None
                stream.packet_loss_rate = None
                stream.qoe_score = 0
            stream.last_update_time = now

            if index % 250 == 0:
                db.flush()

        db.commit()
    except Exception as exc:
        db.rollback()
        print(f"初始化湖里区 Fake 摄像机接入数据失败: {exc}")
    finally:
        db.close()


def _looks_like_mojibake(value: str) -> bool:
    if not value:
        return False

    markers = ("Ã", "Â", "â", "æ", "å", "ç", "è", "é", "ä", "¤", "¥")
    if any(marker in value for marker in markers):
        return True

    return any(0x80 <= ord(ch) <= 0x9F for ch in value)


def _text(value: str | None) -> str | None:
    """
    修复数据库中历史导入时出现的 UTF-8 被 Latin1/CP1252 误解码文本。
    正常中文不处理，只对明显乱码字符串做兜底恢复。
    """
    if value is None or not isinstance(value, str) or not _looks_like_mojibake(value):
        return value

    candidates = [value]
    for encoding in ("latin1", "cp1252"):
        try:
            candidates.append(value.encode(encoding).decode("utf-8"))
        except UnicodeError:
            continue

    def score(text: str) -> int:
        cjk = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
        controls = sum(1 for ch in text if 0x80 <= ord(ch) <= 0x9F)
        bad_markers = sum(text.count(marker) for marker in ("Ã", "Â", "â", "æ", "å", "ç", "è", "é", "ä", "�"))
        return cjk * 5 - controls * 10 - bad_markers * 3

    return max(candidates, key=score)


@app.get("/")
def health() -> dict[str, str]:
    return {"message": "VIoT Ops Backend is running"}


# =========================
# Common helpers
# =========================

def _commit_or_rollback(db: Session, error_message: str) -> None:
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=400, detail=error_message)


def _apply_update(obj: Any, update_data: dict[str, Any]) -> None:
    for key, value in update_data.items():
        setattr(obj, key, value)


def _get_region_or_404(db: Session, region_code: str) -> models.AdministrativeRegion:
    obj = db.get(models.AdministrativeRegion, region_code)
    if not obj:
        raise HTTPException(status_code=404, detail="administrative region not found")
    return obj


def _ensure_region_parent_exists(db: Session, parent_code: str | None) -> None:
    if parent_code and not db.get(models.AdministrativeRegion, parent_code):
        raise HTTPException(status_code=400, detail=f"parent region '{parent_code}' does not exist")


def _ensure_camera_admin_chain(
    db: Session,
    province_code: str,
    city_code: str,
    county_code: str,
    town_code: str,
) -> tuple[
    models.AdministrativeRegion,
    models.AdministrativeRegion,
    models.AdministrativeRegion,
    models.AdministrativeRegion,
]:
    province = db.get(models.AdministrativeRegion, province_code)
    city = db.get(models.AdministrativeRegion, city_code)
    county = db.get(models.AdministrativeRegion, county_code)
    town = db.get(models.AdministrativeRegion, town_code)

    if not province:
        raise HTTPException(status_code=400, detail=f"province '{province_code}' does not exist")
    if not city:
        raise HTTPException(status_code=400, detail=f"city '{city_code}' does not exist")
    if not county:
        raise HTTPException(status_code=400, detail=f"county '{county_code}' does not exist")
    if not town:
        raise HTTPException(status_code=400, detail=f"town '{town_code}' does not exist")

    if province.level != "province":
        raise HTTPException(status_code=400, detail=f"region '{province_code}' is not a province")
    if city.level != "city":
        raise HTTPException(status_code=400, detail=f"region '{city_code}' is not a city")
    if county.level != "county":
        raise HTTPException(status_code=400, detail=f"region '{county_code}' is not a county")
    if town.level != "town":
        raise HTTPException(status_code=400, detail=f"region '{town_code}' is not a town")

    if city.parent_code != province.region_code:
        raise HTTPException(status_code=400, detail="city does not belong to the given province")
    if county.parent_code != city.region_code:
        raise HTTPException(status_code=400, detail="county does not belong to the given city")
    if town.parent_code != county.region_code:
        raise HTTPException(status_code=400, detail="town does not belong to the given county")

    return province, city, county, town


def _normalize_camera_region_names(
    data: dict[str, Any],
    province: models.AdministrativeRegion,
    city: models.AdministrativeRegion,
    county: models.AdministrativeRegion,
    town: models.AdministrativeRegion,
) -> None:
    data["province_name"] = province.region_name
    data["city_name"] = city.region_name
    data["county_name"] = county.region_name
    data["town_name"] = town.region_name


def _ensure_server_exists(db: Session, server_id: str | None) -> None:
    if server_id and not db.get(models.Server, server_id):
        raise HTTPException(status_code=400, detail=f"server '{server_id}' does not exist")


def _ensure_camera_exists(db: Session, camera_id: str | None) -> None:
    if camera_id and not db.get(models.Camera, camera_id):
        raise HTTPException(status_code=400, detail=f"camera '{camera_id}' does not exist")


def _ensure_stream_refs_exist(db: Session, camera_id: str | None, server_id: str | None) -> None:
    if not camera_id and not server_id:
        raise HTTPException(status_code=400, detail="at least one of camera_id or server_id is required")
    _ensure_camera_exists(db, camera_id)
    _ensure_server_exists(db, server_id)


def _auto_stream_id(camera_id: str, server_id: str) -> str:
    safe_camera_id = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in camera_id)
    safe_server_id = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in server_id)
    return f"auto-{safe_camera_id}-{safe_server_id}"[:64]


def _sync_camera_stream_media(db: Session, camera: models.Camera) -> None:
    db.query(models.StreamMedia).filter(
        models.StreamMedia.camera_id == camera.id,
        models.StreamMedia.id.like("auto-%"),
    ).delete(synchronize_session=False)

    if not camera.server_id:
        return

    server = db.get(models.Server, camera.server_id)
    if not server:
        return

    stream = models.StreamMedia(
        id=_auto_stream_id(camera.id, server.id),
        source_ip=camera.ip,
        source_port=554,
        destination_ip=server.ip,
        destination_port=1935,
        ssrc=f"ssrc-{camera.id}"[:64],
        camera_id=camera.id,
        server_id=server.id,
        codec=camera.codec,
        resolution=None,
        frame_rate=None,
        real_time_bitrate=None,
        throughput=None,
        latency=None,
        jitter=None,
        packet_loss_rate=None,
        qoe_score=None,
        transport_protocol=camera.protocol or "TCP",
        is_connected=camera.status != "offline" and server.status != "offline",
        is_fault=camera.status == "fault" or server.status == "fault",
        link_type="auto",
        stream_type=camera.stream_type,
        last_update_time=datetime.utcnow(),
    )
    db.add(stream)


def _ensure_entity_exists(db: Session, entity_type: str, entity_id: str) -> None:
    model_map = {
        "camera": models.Camera,
        "server": models.Server,
        "stream_media": models.StreamMedia,
        "network_node": models.NetworkNode,
    }

    model = model_map.get(entity_type)
    if not model:
        raise HTTPException(status_code=400, detail=f"unsupported entity_type '{entity_type}'")

    if not db.get(model, entity_id):
        raise HTTPException(status_code=400, detail=f"{entity_type} '{entity_id}' does not exist")


def _normalize_camera_protocol_value(protocol: str | None) -> str | None:
    if not protocol:
        return protocol
    return "RTSP" if protocol.upper() in {"RTP", "RTSP"} else protocol


def _normalize_existing_camera_protocols() -> None:
    db = SessionLocal()
    try:
        db.query(models.Camera).filter(models.Camera.protocol == "RTP").update(
            {models.Camera.protocol: "RTSP"},
            synchronize_session=False,
        )
        db.commit()
    except SQLAlchemyError:
        db.rollback()
    finally:
        db.close()


def _collect_region_descendant_codes(db: Session, region_code: str) -> list[str]:
    _get_region_or_404(db, region_code)

    regions = db.query(models.AdministrativeRegion).all()
    children_map: dict[str | None, list[str]] = defaultdict(list)

    for region in regions:
        children_map[region.parent_code].append(region.region_code)

    result: list[str] = []

    def dfs(code: str) -> None:
        result.append(code)
        for child_code in children_map.get(code, []):
            dfs(child_code)

    dfs(region_code)
    return result


def _is_camera_online(camera: models.Camera) -> bool:
    """
    离线摄像机不计入在线数。
    在线故障摄像机仍然计入在线数。
    """
    return camera.status != "offline"


def _camera_match_status_filter(camera: models.Camera, status_filter: str) -> bool:
    if status_filter == "all":
        return True

    if status_filter == "normal":
        return camera.status == "online"

    if status_filter == "fault":
        return camera.status == "fault"

    if status_filter == "offline":
        return camera.status == "offline"

    return True


def _camera_stat_inc(camera: models.Camera, status_filter: str) -> int:
    """
    决定行政区后面括号里的分子。

    all：沿用默认含义，显示在线设备数，即非 offline 都算在线。
    normal：显示正常设备数，即 status == online。
    fault：显示故障设备数。
    offline：显示离线设备数。
    """
    if status_filter == "all":
        return 1 if camera.status != "offline" else 0

    if status_filter == "normal":
        return 1 if camera.status == "online" else 0

    if status_filter == "fault":
        return 1 if camera.status == "fault" else 0

    if status_filter == "offline":
        return 1 if camera.status == "offline" else 0

    return 1 if camera.status != "offline" else 0


def _camera_db_status_from_filter(status_filter: str) -> str | None:
    """
    将前端筛选状态映射到数据库里的 camera.status。
    """
    if status_filter == "normal":
        return "online"

    if status_filter == "fault":
        return "fault"

    if status_filter == "offline":
        return "offline"

    return None


def _camera_list_order():
    fake_rank = case(
        (models.Camera.id.like("F%"), 1),
        (models.Camera.id.like("Z%"), 1),
        else_=0,
    )
    return fake_rank, models.Camera.status, models.Camera.name, models.Camera.id


def _server_list_order():
    return models.Server.status, models.Server.name, models.Server.id



def _build_camera_stat_map(
    db: Session,
    status_filter: str = "all",
) -> dict[str, dict[str, int]]:
    """
    统计每个行政区下的设备数。

    total 永远表示全部设备数。
    online 字段为了兼容前端显示，作为括号里的分子：
    - all / online：在线设备数
    - fault：故障设备数
    - offline：离线设备数
    """
    stats: dict[str, dict[str, int]] = defaultdict(lambda: {"online": 0, "total": 0})

    cameras = db.query(models.Camera).all()

    for camera in cameras:
        stat_inc = _camera_stat_inc(camera, status_filter)

        region_codes = {
            camera.province_code,
            camera.city_code,
            camera.county_code,
            camera.town_code,
        }

        for code in region_codes:
            if not code:
                continue

            stats[code]["total"] += 1
            stats[code]["online"] += stat_inc

    return stats


def _region_to_nav_node(
    region: models.AdministrativeRegion,
    stats: dict[str, dict[str, int]],
) -> dict[str, Any]:
    region_stats = stats.get(region.region_code, {"online": 0, "total": 0})

    return {
        "node_type": "region",
        "id": region.region_code,
        "region_code": region.region_code,
        "region_name": _text(region.region_name),
        "level": region.level,
        "parent_code": region.parent_code,
        "official_code": region.official_code,
        "amap_adcode": region.amap_adcode,
        "amap_citycode": region.amap_citycode,
        "center": region.center,
        "source": region.source,
        "source_version": region.source_version,
        "sort_order": region.sort_order,
        "remark": _text(region.remark),
        "online": region_stats["online"],
        "total": region_stats["total"],
        "children": [],
    }


def _camera_to_nav_node(camera: models.Camera) -> dict[str, Any]:
    online = 1 if _is_camera_online(camera) else 0

    return {
        "node_type": "camera",
        "id": camera.id,
        "camera_id": camera.id,
        "region_code": camera.town_code,
        "region_name": _text(camera.name),
        "level": "camera",
        "parent_code": camera.town_code,
        "official_code": None,
        "amap_adcode": None,
        "amap_citycode": None,
        "center": None,
        "source": "camera",
        "source_version": None,
        "sort_order": 0,
        "remark": None,
        "online": online,
        "total": 1,
        "status": camera.status,
        "ip": camera.ip,
        "name": _text(camera.name),
        "longitude": camera.longitude,
        "latitude": camera.latitude,
        "video_url": camera.video_url,
        "children": [],
    }


def _build_region_path(
    region_map: dict[str, models.AdministrativeRegion],
    region_code: str,
) -> list[models.AdministrativeRegion]:
    path: list[models.AdministrativeRegion] = []

    current = region_map.get(region_code)

    while current:
        path.append(current)
        if not current.parent_code:
            break
        current = region_map.get(current.parent_code)

    path.reverse()
    return path


@app.get("/nav-tree/children")
def get_nav_tree_children(
    parent_code: str | None = Query(default=None, max_length=64),
    status_filter: str = Query(default="all", pattern="^(all|normal|fault|offline)$"),
    db: Session = Depends(get_db),
):
    """
    左侧导航树懒加载行政区子节点。
    parent_code 为空时返回省级行政区。
    """
    stats = _build_camera_stat_map(db, status_filter)

    query = db.query(models.AdministrativeRegion)

    if parent_code:
        query = query.filter(models.AdministrativeRegion.parent_code == parent_code)
    else:
        query = query.filter(models.AdministrativeRegion.level == "province")

    regions = (
        query.order_by(
            models.AdministrativeRegion.sort_order,
            models.AdministrativeRegion.region_code,
        )
        .all()
    )

    return [_region_to_nav_node(region, stats) for region in regions]


@app.get("/nav-tree/node")
def get_nav_tree_node(
    region_code: str = Query(..., max_length=64),
    status_filter: str = Query(default="all", pattern="^(all|normal|fault|offline)$"),
    db: Session = Depends(get_db),
):
    """
    获取单个行政区导航节点，用于刷新“我的收藏”里的统计值。
    """
    region = db.get(models.AdministrativeRegion, region_code)

    if not region:
        raise HTTPException(status_code=404, detail="region not found")

    stats = _build_camera_stat_map(db, status_filter)

    return _region_to_nav_node(region, stats)



@app.get("/nav-tree/cameras")
def get_nav_tree_cameras(
    region_code: str = Query(..., max_length=64),
    keyword: str | None = Query(default=None, max_length=64),
    status_filter: str = Query(default="all", pattern="^(all|normal|fault|offline)$"),
    include_fake: bool = Query(default=True),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=2000, ge=1, le=5000),
    db: Session = Depends(get_db),
):
    """
    左侧导航树加载某个行政区下的摄像机。
    主要在乡级行政区展开时调用。
    """
    region = _get_region_or_404(db, region_code)

    # 【优化】同样基于已保存的层级信息直接查表，告别缓慢的 IN 语句
    query = db.query(models.Camera)
    if region.level == "province":
        query = query.filter(models.Camera.province_code == region_code)
    elif region.level == "city":
        query = query.filter(models.Camera.city_code == region_code)
    elif region.level == "county":
        query = query.filter(models.Camera.county_code == region_code)
    else:
        query = query.filter(models.Camera.town_code == region_code)

    db_status = _camera_db_status_from_filter(status_filter)
    if db_status:
        query = query.filter(models.Camera.status == db_status)

    if not include_fake:
        query = query.filter(~models.Camera.id.like("F%"), ~models.Camera.id.like("Z%"))

    if keyword:
        keyword_like = f"%{keyword.strip()}%"
        query = query.filter(
            or_(
                models.Camera.name.like(keyword_like),
                models.Camera.ip.like(keyword_like),
                models.Camera.location_desc.like(keyword_like),
            )
        )

    cameras = (
        query.order_by(*_camera_list_order())
        .offset(skip)
        .limit(limit)
        .all()
    )

    return [_camera_to_nav_node(camera) for camera in cameras]


@app.get("/nav-tree/search")
def search_nav_tree(
    keyword: str = Query(..., min_length=1, max_length=64),
    status_filter: str = Query(default="all", pattern="^(all|normal|fault|offline)$"),
    db: Session = Depends(get_db),
):
    """
    左侧导航树搜索。
    支持搜索行政区名称/编码，也支持搜索摄像机名称/IP/位置。
    返回结果会自动补齐从省到目标节点的路径。
    """
    value = keyword.strip()
    keyword_like = f"%{value}%"

    all_regions = db.query(models.AdministrativeRegion).all()
    region_map: dict[str, models.AdministrativeRegion] = {
        region.region_code: region for region in all_regions
    }

    children_map: dict[str | None, list[models.AdministrativeRegion]] = defaultdict(list)
    for region in all_regions:
        children_map[region.parent_code].append(region)

    matched_regions = (
        db.query(models.AdministrativeRegion)
        .filter(
            or_(
                models.AdministrativeRegion.region_name.like(keyword_like),
                models.AdministrativeRegion.region_code.like(keyword_like),
                models.AdministrativeRegion.official_code.like(keyword_like),
                models.AdministrativeRegion.amap_adcode.like(keyword_like),
            )
        )
        .limit(500)
        .all()
    )

    matched_region_codes = {region.region_code for region in matched_regions}

    def has_matched_descendant(region_code: str) -> bool:
        stack = [child.region_code for child in children_map.get(region_code, [])]

        while stack:
            current_code = stack.pop()

            if current_code in matched_region_codes:
                return True

            stack.extend(child.region_code for child in children_map.get(current_code, []))

        return False

    deepest_region_matches = [
        region
        for region in matched_regions
        if not has_matched_descendant(region.region_code)
    ]

    matched_camera_query = db.query(models.Camera).filter(
        or_(
            models.Camera.name.like(keyword_like),
            models.Camera.ip.like(keyword_like),
            models.Camera.location_desc.like(keyword_like),
        )
    )

    db_status = _camera_db_status_from_filter(status_filter)
    if db_status:
        matched_camera_query = matched_camera_query.filter(
            models.Camera.status == db_status
        )

    matched_cameras = matched_camera_query.limit(500).all()

    stats = _build_camera_stat_map(db, status_filter)
    node_map: dict[str, dict[str, Any]] = {}

    def ensure_region_path(region_code: str) -> None:
        path = _build_region_path(region_map, region_code)

        for region in path:
            if region.region_code not in node_map:
                node_map[region.region_code] = _region_to_nav_node(region, stats)

    for region in deepest_region_matches:
        ensure_region_path(region.region_code)

    for camera in matched_cameras:
        ensure_region_path(camera.town_code)
        camera_node_id = f"camera-{camera.id}"
        node_map[camera_node_id] = _camera_to_nav_node(camera)

    for _, node in list(node_map.items()):
        if node.get("node_type") == "camera":
            parent_code = node["parent_code"]
            if parent_code in node_map:
                node_map[parent_code]["children"].append(node)
            continue

        parent_code = node.get("parent_code")
        if parent_code and parent_code in node_map:
            node_map[parent_code]["children"].append(node)

    level_order = {
        "province": 1,
        "city": 2,
        "county": 3,
        "town": 4,
        "camera": 5,
    }

    def sort_node(node: dict[str, Any]) -> None:
        node["children"].sort(
            key=lambda child: (
                level_order.get(child.get("level"), 99),
                child.get("sort_order") or 0,
                child.get("region_name") or child.get("name") or "",
            )
        )

        for child in node["children"]:
            sort_node(child)

    roots = [
        node
        for node in node_map.values()
        if node.get("node_type") != "camera"
        and (not node.get("parent_code") or node.get("parent_code") not in node_map)
    ]

    roots.sort(
        key=lambda node: (
            level_order.get(node.get("level"), 99),
            node.get("sort_order") or 0,
            node.get("region_code") or "",
        )
    )

    for root in roots:
        sort_node(root)

    return roots



def _region_to_tree_node(
    region: models.AdministrativeRegion,
    camera_count: int = 0,
) -> dict[str, Any]:
    return {
        "region_code": region.region_code,
        "region_name": _text(region.region_name),
        "level": region.level,
        "parent_code": region.parent_code,
        "official_code": region.official_code,
        "amap_adcode": region.amap_adcode,
        "amap_citycode": region.amap_citycode,
        "center": region.center,
        "source": region.source,
        "source_version": region.source_version,
        "sort_order": region.sort_order,
        "remark": _text(region.remark),
        "created_at": region.created_at,
        "updated_at": region.updated_at,
        "children": [],
        "camera_count": camera_count,
    }


def _build_region_search_tree(db: Session, keyword: str) -> list[dict[str, Any]]:
    value = keyword.strip()
    if not value:
        return []

    keyword_like = f"%{value}%"

    matched_regions = (
        db.query(models.AdministrativeRegion)
        .filter(
            or_(
                models.AdministrativeRegion.region_name.like(keyword_like),
                models.AdministrativeRegion.region_code.like(keyword_like),
                models.AdministrativeRegion.official_code.like(keyword_like),
                models.AdministrativeRegion.amap_adcode.like(keyword_like),
            )
        )
        .limit(500)
        .all()
    )

    if not matched_regions:
        return []

    all_regions = db.query(models.AdministrativeRegion).all()

    region_map: dict[str, models.AdministrativeRegion] = {
        region.region_code: region for region in all_regions
    }

    children_map: dict[str | None, list[models.AdministrativeRegion]] = defaultdict(list)
    for region in all_regions:
        children_map[region.parent_code].append(region)

    matched_codes = {region.region_code for region in matched_regions}

    def has_matched_descendant(region_code: str) -> bool:
        stack = [child.region_code for child in children_map.get(region_code, [])]

        while stack:
            current_code = stack.pop()

            if current_code in matched_codes:
                return True

            stack.extend(
                child.region_code for child in children_map.get(current_code, [])
            )

        return False

    # 只保留最细粒度的命中节点。
    # 例如“海淀”同时命中“海淀区”和“海淀街道”，则只把“海淀街道/海淀镇”作为搜索目标。
    target_regions = [
        region
        for region in matched_regions
        if not has_matched_descendant(region.region_code)
    ]

    if not target_regions:
        target_regions = matched_regions

    included_codes: set[str] = set()

    for target in target_regions:
        current: models.AdministrativeRegion | None = target

        while current:
            included_codes.add(current.region_code)

            if not current.parent_code:
                break

            current = region_map.get(current.parent_code)

    camera_rows = db.query(models.Camera.town_code).all()
    direct_camera_count: dict[str, int] = defaultdict(int)
    for (town_code,) in camera_rows:
        direct_camera_count[town_code] += 1

    nodes: dict[str, dict[str, Any]] = {
        code: _region_to_tree_node(
            region_map[code],
            direct_camera_count.get(code, 0),
        )
        for code in included_codes
        if code in region_map
    }

    level_order = {
        "province": 1,
        "city": 2,
        "county": 3,
        "town": 4,
    }

    def sort_key(code: str):
        region = region_map[code]
        return (
            level_order.get(region.level, 99),
            region.sort_order,
            region.region_code,
        )

    roots: list[dict[str, Any]] = []

    for code in sorted(nodes.keys(), key=sort_key):
        region = region_map[code]
        node = nodes[code]

        if region.parent_code and region.parent_code in nodes:
            nodes[region.parent_code]["children"].append(node)
        else:
            roots.append(node)

    def aggregate_count(node: dict[str, Any]) -> int:
        total = node["camera_count"]

        for child in node["children"]:
            total += aggregate_count(child)

        node["camera_count"] = total
        return total

    def sort_children(node: dict[str, Any]) -> None:
        node["children"].sort(
            key=lambda child: (
                level_order.get(child["level"], 99),
                child["sort_order"],
                child["region_code"],
            )
        )

        for child in node["children"]:
            sort_children(child)

    for root in roots:
        aggregate_count(root)
        sort_children(root)

    return roots



# =========================
# AdministrativeRegion
# =========================

@app.post(
    "/regions",
    response_model=schemas.AdministrativeRegionRead,
    status_code=status.HTTP_201_CREATED,
)
def create_region(payload: schemas.AdministrativeRegionCreate, db: Session = Depends(get_db)):
    if db.get(models.AdministrativeRegion, payload.region_code):
        raise HTTPException(
            status_code=409,
            detail=f"region '{payload.region_code}' already exists",
        )

    _ensure_region_parent_exists(db, payload.parent_code)

    obj = models.AdministrativeRegion(**payload.model_dump())
    db.add(obj)
    _commit_or_rollback(db, "failed to create region: constraint violation")
    db.refresh(obj)
    return obj




@app.get("/regions", response_model=list[schemas.AdministrativeRegionRead])
def list_regions(
    level: schemas.RegionLevel | None = None,
    parent_code: str | None = Query(default=None, max_length=64),
    keyword: str | None = Query(default=None, max_length=64),
    db: Session = Depends(get_db),
):
    query = db.query(models.AdministrativeRegion)

    if level:
        query = query.filter(models.AdministrativeRegion.level == level)

    if parent_code is not None:
        query = query.filter(models.AdministrativeRegion.parent_code == parent_code)

    if keyword:
        keyword_like = f"%{keyword.strip()}%"
        query = query.filter(
            or_(
                models.AdministrativeRegion.region_name.like(keyword_like),
                models.AdministrativeRegion.region_code.like(keyword_like),
                models.AdministrativeRegion.official_code.like(keyword_like),
                models.AdministrativeRegion.amap_adcode.like(keyword_like),
            )
        )

    ordered_query = query.order_by(
        models.AdministrativeRegion.level,
        models.AdministrativeRegion.sort_order,
        models.AdministrativeRegion.region_code,
    )

    if keyword:
        return ordered_query.limit(200).all()

    return ordered_query.all()




@app.get("/regions/tree", response_model=list[schemas.AdministrativeRegionTreeNode])
def get_region_tree(db: Session = Depends(get_db)):
    regions = (
        db.query(models.AdministrativeRegion)
        .order_by(models.AdministrativeRegion.sort_order, models.AdministrativeRegion.region_code)
        .all()
    )

    camera_rows = db.query(models.Camera.town_code).all()
    direct_camera_count: dict[str, int] = defaultdict(int)
    for (town_code,) in camera_rows:
        direct_camera_count[town_code] += 1

    node_map: dict[str, dict[str, Any]] = {}

    for region in regions:
        node_map[region.region_code] = {
            "region_code": region.region_code,
            "region_name": region.region_name,
            "level": region.level,
            "parent_code": region.parent_code,
            "official_code": region.official_code,
            "amap_adcode": region.amap_adcode,
            "amap_citycode": region.amap_citycode,
            "center": region.center,
            "source": region.source,
            "source_version": region.source_version,
            "sort_order": region.sort_order,
            "remark": region.remark,
            "created_at": region.created_at,
            "updated_at": region.updated_at,
            "children": [],
            "camera_count": direct_camera_count.get(region.region_code, 0),
        }

    roots: list[dict[str, Any]] = []

    for region in regions:
        node = node_map[region.region_code]
        if region.parent_code and region.parent_code in node_map:
            node_map[region.parent_code]["children"].append(node)
        else:
            roots.append(node)

    def aggregate_count(node: dict[str, Any]) -> int:
        total = node["camera_count"]
        for child in node["children"]:
            total += aggregate_count(child)
        node["camera_count"] = total
        return total

    for root in roots:
        aggregate_count(root)

    return roots



@app.get("/regions/search-tree", response_model=list[schemas.AdministrativeRegionTreeNode])
def search_region_tree(
    keyword: str = Query(..., min_length=1, max_length=64),
    db: Session = Depends(get_db),
):
    return _build_region_search_tree(db, keyword)


@app.get("/regions/{region_code}", response_model=schemas.AdministrativeRegionRead)
def get_region(region_code: str, db: Session = Depends(get_db)):
    return _get_region_or_404(db, region_code)


@app.put("/regions/{region_code}", response_model=schemas.AdministrativeRegionRead)
def update_region(
    region_code: str,
    payload: schemas.AdministrativeRegionUpdate,
    db: Session = Depends(get_db),
):
    obj = _get_region_or_404(db, region_code)
    update_data = payload.model_dump(exclude_unset=True)

    if "parent_code" in update_data:
        new_parent_code = update_data["parent_code"]
        if new_parent_code == region_code:
            raise HTTPException(status_code=400, detail="region cannot be its own parent")
        _ensure_region_parent_exists(db, new_parent_code)

    _apply_update(obj, update_data)
    db.add(obj)
    _commit_or_rollback(db, "failed to update region: constraint violation")
    db.refresh(obj)
    return obj


@app.delete("/regions/{region_code}")
def delete_region(region_code: str, db: Session = Depends(get_db)):
    obj = _get_region_or_404(db, region_code)

    child_count = (
        db.query(models.AdministrativeRegion)
        .filter(models.AdministrativeRegion.parent_code == region_code)
        .count()
    )
    if child_count > 0:
        raise HTTPException(status_code=400, detail="cannot delete region with child regions")

    camera_count = db.query(models.Camera).filter(models.Camera.town_code == region_code).count()
    if camera_count > 0:
        raise HTTPException(status_code=400, detail="cannot delete region with cameras")

    db.delete(obj)
    db.commit()
    return {"message": f"region '{region_code}' deleted"}


# =========================
# Server
# =========================

@app.post("/servers", response_model=schemas.ServerRead, status_code=status.HTTP_201_CREATED)
def create_server(payload: schemas.ServerCreate, db: Session = Depends(get_db)):
    if db.get(models.Server, payload.id):
        raise HTTPException(status_code=409, detail=f"server '{payload.id}' already exists")

    obj = models.Server(**payload.model_dump())
    db.add(obj)
    _commit_or_rollback(db, "failed to create server: constraint violation")
    db.refresh(obj)
    return obj


@app.get("/servers", response_model=list[schemas.ServerRead])
def list_servers(
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=1000),
    status_filter: str | None = Query(default=None, alias="status"),
    node_type: str | None = None,
    db: Session = Depends(get_db),
):
    query = db.query(models.Server)

    if status_filter:
        query = query.filter(models.Server.status == status_filter)

    if node_type:
        query = query.filter(models.Server.node_type == node_type)

    return query.order_by(*_server_list_order()).offset(skip).limit(limit).all()


@app.get("/servers/{server_id}", response_model=schemas.ServerRead)
def get_server(server_id: str, db: Session = Depends(get_db)):
    obj = db.get(models.Server, server_id)
    if not obj:
        raise HTTPException(status_code=404, detail="server not found")
    return obj


@app.put("/servers/{server_id}", response_model=schemas.ServerRead)
def update_server(server_id: str, payload: schemas.ServerUpdate, db: Session = Depends(get_db)):
    obj = db.get(models.Server, server_id)
    if not obj:
        raise HTTPException(status_code=404, detail="server not found")

    update_data = payload.model_dump(exclude_unset=True)
    _apply_update(obj, update_data)

    db.add(obj)
    for camera in db.query(models.Camera).filter(models.Camera.server_id == server_id).all():
        _sync_camera_stream_media(db, camera)

    _commit_or_rollback(db, "failed to update server: constraint violation")
    db.refresh(obj)
    return obj


@app.delete("/servers/{server_id}")
@app.delete("/servers/{server_id}/")
def delete_server(server_id: str, db: Session = Depends(get_db)):
    obj = db.get(models.Server, server_id)
    if not obj:
        raise HTTPException(status_code=404, detail="server not found")

    db.query(models.StreamMedia).filter(models.StreamMedia.server_id == server_id).delete(synchronize_session=False)
    db.delete(obj)
    db.commit()
    return {"message": f"server '{server_id}' deleted"}


# =========================
# NetworkNode
# =========================

@app.post(
    "/network-nodes",
    response_model=schemas.NetworkNodeRead,
    status_code=status.HTTP_201_CREATED,
)
def create_network_node(payload: schemas.NetworkNodeCreate, db: Session = Depends(get_db)):
    if db.get(models.NetworkNode, payload.id):
        raise HTTPException(status_code=409, detail=f"network_node '{payload.id}' already exists")

    obj = models.NetworkNode(**payload.model_dump())
    db.add(obj)
    _commit_or_rollback(db, "failed to create network_node: constraint violation")
    db.refresh(obj)
    return obj


@app.get("/network-nodes", response_model=list[schemas.NetworkNodeRead])
def list_network_nodes(
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=1000),
    status_filter: str | None = Query(default=None, alias="status"),
    node_type: str | None = None,
    db: Session = Depends(get_db),
):
    query = db.query(models.NetworkNode)

    if status_filter:
        query = query.filter(models.NetworkNode.status == status_filter)

    if node_type:
        query = query.filter(models.NetworkNode.node_type == node_type)

    return query.offset(skip).limit(limit).all()


@app.get("/network-nodes/{node_id}", response_model=schemas.NetworkNodeRead)
def get_network_node(node_id: str, db: Session = Depends(get_db)):
    obj = db.get(models.NetworkNode, node_id)
    if not obj:
        raise HTTPException(status_code=404, detail="network_node not found")
    return obj


@app.put("/network-nodes/{node_id}", response_model=schemas.NetworkNodeRead)
def update_network_node(
    node_id: str,
    payload: schemas.NetworkNodeUpdate,
    db: Session = Depends(get_db),
):
    obj = db.get(models.NetworkNode, node_id)
    if not obj:
        raise HTTPException(status_code=404, detail="network_node not found")

    update_data = payload.model_dump(exclude_unset=True)
    _apply_update(obj, update_data)

    db.add(obj)
    _commit_or_rollback(db, "failed to update network_node: constraint violation")
    db.refresh(obj)
    return obj


@app.delete("/network-nodes/{node_id}")
def delete_network_node(node_id: str, db: Session = Depends(get_db)):
    obj = db.get(models.NetworkNode, node_id)
    if not obj:
        raise HTTPException(status_code=404, detail="network_node not found")

    db.delete(obj)
    db.commit()
    return {"message": f"network_node '{node_id}' deleted"}


# =========================
# Camera
# =========================

@app.post("/cameras", response_model=schemas.CameraRead, status_code=status.HTTP_201_CREATED)
def create_camera(payload: schemas.CameraCreate, db: Session = Depends(get_db)):
    if db.get(models.Camera, payload.id):
        raise HTTPException(status_code=409, detail=f"camera '{payload.id}' already exists")

    _ensure_server_exists(db, payload.server_id)

    province, city, county, town = _ensure_camera_admin_chain(
        db,
        payload.province_code,
        payload.city_code,
        payload.county_code,
        payload.town_code,
    )

    data = payload.model_dump()
    data["protocol"] = _normalize_camera_protocol_value(data.get("protocol"))
    _normalize_camera_region_names(data, province, city, county, town)

    obj = models.Camera(**data)
    db.add(obj)
    db.flush()
    _sync_camera_stream_media(db, obj)
    _commit_or_rollback(db, "failed to create camera: constraint violation")
    db.refresh(obj)
    return obj


@app.get("/cameras", response_model=list[schemas.CameraRead])
def list_cameras(
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=5000),
    region_code: str | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    keyword: str | None = None,
    include_fake: bool = Query(default=True),
    db: Session = Depends(get_db),
):
    query = db.query(models.Camera)

    if region_code:
        # 【优化】不再把整个行政区表拉到内存去查 descendant，直接通过对应层级过滤
        region = db.get(models.AdministrativeRegion, region_code)
        if region:
            if region.level == "province":
                query = query.filter(models.Camera.province_code == region_code)
            elif region.level == "city":
                query = query.filter(models.Camera.city_code == region_code)
            elif region.level == "county":
                query = query.filter(models.Camera.county_code == region_code)
            else:
                query = query.filter(models.Camera.town_code == region_code)

    if status_filter:
        query = query.filter(models.Camera.status == status_filter)

    if not include_fake:
        query = query.filter(~models.Camera.id.like("F%"), ~models.Camera.id.like("Z%"))

    if keyword:
        keyword_like = f"%{keyword}%"
        query = query.filter(
            (models.Camera.name.like(keyword_like))
            | (models.Camera.ip.like(keyword_like))
            | (models.Camera.location_desc.like(keyword_like))
        )

    return query.order_by(*_camera_list_order()).offset(skip).limit(limit).all()


@app.get("/cameras/by-region/{region_code}", response_model=list[schemas.CameraRead])
def list_cameras_by_region(
    region_code: str,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=1000),
    db: Session = Depends(get_db),
):
    region_codes = _collect_region_descendant_codes(db, region_code)

    return (
        db.query(models.Camera)
        .filter(models.Camera.town_code.in_(region_codes))
        .order_by(*_camera_list_order())
        .offset(skip)
        .limit(limit)
        .all()
    )


@app.get("/cameras/{camera_id}", response_model=schemas.CameraRead)
def get_camera(camera_id: str, db: Session = Depends(get_db)):
    obj = db.get(models.Camera, camera_id)
    if not obj:
        raise HTTPException(status_code=404, detail="camera not found")
    return obj


@app.get("/cameras/{camera_id}/preview")
def get_camera_preview(camera_id: str, db: Session = Depends(get_db)):
    camera = db.get(models.Camera, camera_id)
    if not camera:
        raise HTTPException(status_code=404, detail="camera not found")
    if camera.status == "offline":
        raise HTTPException(status_code=503, detail="camera offline")

    try:
        preview = resolve_camera_preview(camera)
        candidates = list(preview.candidates or [])
        return {
            "camera_id": camera.id,
            "camera_name": camera.name,
            "play_url": preview.play_url,
            "start_time": 0,
            "playback_type": candidates[0]["type"] if candidates else preview.protocol,
            "protocol": preview.protocol,
            "device_no": preview.device_no,
            "stream_id": preview.stream_id,
            "source": preview.source,
            "message": preview.message,
            "candidates": candidates,
        }
    except PreviewUnavailable:
        if camera.video_url and not camera.video_url.startswith("rtsp://example.com"):
            raise HTTPException(status_code=503, detail="camera preview unavailable")

    video_name = ANOMALY_VIDEO_NAME if camera.status == "fault" else NORMAL_VIDEO_NAME
    video_path = VIDEOS_DIR / video_name
    if not video_path.exists():
        raise HTTPException(status_code=404, detail=f"preview video '{video_name}' not found")

    return {
        "camera_id": camera.id,
        "camera_name": camera.name,
        "play_url": f"/videos/{video_name}",
        "start_time": randint(0, 45),
        "playback_type": "mp4",
        "protocol": "http",
        "source": "demo_video",
        "candidates": [{"type": "mp4", "url": f"/videos/{video_name}", "source": "demo_video"}],
    }


@app.put("/cameras/{camera_id}", response_model=schemas.CameraRead)
def update_camera(camera_id: str, payload: schemas.CameraUpdate, db: Session = Depends(get_db)):
    obj = db.get(models.Camera, camera_id)
    if not obj:
        raise HTTPException(status_code=404, detail="camera not found")

    update_data = payload.model_dump(exclude_unset=True)
    if "protocol" in update_data:
        update_data["protocol"] = _normalize_camera_protocol_value(update_data.get("protocol"))

    if "server_id" in update_data:
        _ensure_server_exists(db, update_data["server_id"])

    region_keys = {
        "province_code",
        "city_code",
        "county_code",
        "town_code",
        "province_name",
        "city_name",
        "county_name",
        "town_name",
    }

    if region_keys.intersection(update_data.keys()):
        province_code = update_data.get("province_code", obj.province_code)
        city_code = update_data.get("city_code", obj.city_code)
        county_code = update_data.get("county_code", obj.county_code)
        town_code = update_data.get("town_code", obj.town_code)

        province, city, county, town = _ensure_camera_admin_chain(
            db,
            province_code,
            city_code,
            county_code,
            town_code,
        )

        update_data["province_code"] = province.region_code
        update_data["city_code"] = city.region_code
        update_data["county_code"] = county.region_code
        update_data["town_code"] = town.region_code
        _normalize_camera_region_names(update_data, province, city, county, town)

    _apply_update(obj, update_data)

    db.add(obj)
    _sync_camera_stream_media(db, obj)
    _commit_or_rollback(db, "failed to update camera: constraint violation")
    db.refresh(obj)
    return obj


def _delete_camera_by_id(camera_id: str, db: Session):
    obj = db.get(models.Camera, camera_id)
    if not obj:
        raise HTTPException(status_code=404, detail="camera not found")

    db.query(models.StreamMedia).filter(models.StreamMedia.camera_id == camera_id).delete(synchronize_session=False)
    db.delete(obj)
    db.commit()
    return {"message": f"camera '{camera_id}' deleted"}


@app.delete("/cameras")
def delete_camera_query(camera_id: str = Query(..., max_length=64), db: Session = Depends(get_db)):
    return _delete_camera_by_id(camera_id, db)


@app.delete("/cameras/{camera_id}")
@app.delete("/cameras/{camera_id}/")
def delete_camera(camera_id: str, db: Session = Depends(get_db)):
    return _delete_camera_by_id(camera_id, db)


# =========================
# StreamMedia
# =========================

@app.post(
    "/stream-medias",
    response_model=schemas.StreamMediaRead,
    status_code=status.HTTP_201_CREATED,
)
def create_stream_media(payload: schemas.StreamMediaCreate, db: Session = Depends(get_db)):
    if db.get(models.StreamMedia, payload.id):
        raise HTTPException(status_code=409, detail=f"stream_media '{payload.id}' already exists")

    _ensure_stream_refs_exist(db, payload.camera_id, payload.server_id)

    obj = models.StreamMedia(**payload.model_dump())
    db.add(obj)
    _commit_or_rollback(db, "failed to create stream_media: constraint violation")
    db.refresh(obj)
    return obj


@app.get("/stream-medias", response_model=list[schemas.StreamMediaRead])
def list_stream_medias(
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=5000),
    camera_id: str | None = None,
    server_id: str | None = None,
    is_fault: bool | None = None,
    is_connected: bool | None = None,
    include_fake: bool = Query(default=True),
    db: Session = Depends(get_db),
):
    query = db.query(models.StreamMedia)

    if not include_fake:
        query = (
            query.join(models.Camera, models.StreamMedia.camera_id == models.Camera.id)
            .filter(~models.Camera.id.like("F%"), ~models.Camera.id.like("Z%"))
        )

    if camera_id:
        query = query.filter(models.StreamMedia.camera_id == camera_id)

    if server_id:
        query = query.filter(models.StreamMedia.server_id == server_id)

    if is_fault is not None:
        query = query.filter(models.StreamMedia.is_fault == is_fault)

    if is_connected is not None:
        query = query.filter(models.StreamMedia.is_connected == is_connected)

    return query.order_by(models.StreamMedia.camera_id, models.StreamMedia.id).offset(skip).limit(limit).all()


@app.get("/stream-medias/{stream_media_id}", response_model=schemas.StreamMediaRead)
def get_stream_media(stream_media_id: str, db: Session = Depends(get_db)):
    obj = db.get(models.StreamMedia, stream_media_id)
    if not obj:
        raise HTTPException(status_code=404, detail="stream_media not found")
    return obj


@app.put("/stream-medias/{stream_media_id}", response_model=schemas.StreamMediaRead)
def update_stream_media(
    stream_media_id: str,
    payload: schemas.StreamMediaUpdate,
    db: Session = Depends(get_db),
):
    obj = db.get(models.StreamMedia, stream_media_id)
    if not obj:
        raise HTTPException(status_code=404, detail="stream_media not found")

    update_data = payload.model_dump(exclude_unset=True)

    camera_id = update_data.get("camera_id", obj.camera_id)
    server_id = update_data.get("server_id", obj.server_id)
    _ensure_stream_refs_exist(db, camera_id, server_id)

    _apply_update(obj, update_data)

    db.add(obj)
    _commit_or_rollback(db, "failed to update stream_media: constraint violation")
    db.refresh(obj)
    return obj


@app.delete("/stream-medias/{stream_media_id}")
def delete_stream_media(stream_media_id: str, db: Session = Depends(get_db)):
    obj = db.get(models.StreamMedia, stream_media_id)
    if not obj:
        raise HTTPException(status_code=404, detail="stream_media not found")

    db.delete(obj)
    db.commit()
    return {"message": f"stream_media '{stream_media_id}' deleted"}


@app.post(
    "/stream-media-segments",
    response_model=schemas.StreamMediaSegmentRead,
    status_code=status.HTTP_201_CREATED,
)
def create_stream_media_segment(payload: schemas.StreamMediaSegmentCreate, db: Session = Depends(get_db)):
    if not db.get(models.StreamMedia, payload.stream_media_id):
        raise HTTPException(status_code=404, detail="stream_media not found")
    if db.query(models.StreamMediaSegment).filter(models.StreamMediaSegment.segment_key == payload.segment_key).first():
        raise HTTPException(status_code=409, detail=f"stream_media_segment '{payload.segment_key}' already exists")

    obj = models.StreamMediaSegment(**payload.model_dump())
    db.add(obj)
    _commit_or_rollback(db, "failed to create stream_media_segment: constraint violation")
    db.refresh(obj)
    return obj


@app.put("/stream-media-segments/{segment_id}", response_model=schemas.StreamMediaSegmentRead)
def update_stream_media_segment(
    segment_id: int,
    payload: schemas.StreamMediaSegmentUpdate,
    db: Session = Depends(get_db),
):
    obj = db.get(models.StreamMediaSegment, segment_id)
    if not obj:
        raise HTTPException(status_code=404, detail="stream_media_segment not found")

    update_data = payload.model_dump(exclude_unset=True)
    _apply_update(obj, update_data)
    obj.segment_key = _segment_key(
        obj.direction,
        obj.source_ip,
        obj.source_port,
        obj.destination_ip,
        obj.destination_port,
        obj.ssrc,
    )
    db.add(obj)
    _commit_or_rollback(db, "failed to update stream_media_segment: constraint violation")
    db.refresh(obj)
    return obj


@app.delete("/stream-media-segments/{segment_id}")
def delete_stream_media_segment(segment_id: int, db: Session = Depends(get_db)):
    obj = db.get(models.StreamMediaSegment, segment_id)
    if not obj:
        raise HTTPException(status_code=404, detail="stream_media_segment not found")
    db.delete(obj)
    db.commit()
    return {"message": f"stream_media_segment '{segment_id}' deleted"}


@app.get("/algorithm/runtime-profile", response_model=schemas.RuntimeProfileRead)
def get_algorithm_runtime_profile():
    return _build_runtime_profile_response()


@app.put("/algorithm/runtime-profile", response_model=schemas.RuntimeProfileRead)
def update_algorithm_runtime_profile(payload: schemas.RuntimeProfileUpdate):
    current = _read_runtime_profile_payload()
    if payload.runtime_profile != current["runtime_profile"]:
        _write_json_file(
            RUNTIME_PROFILE_FILE,
            {
                "runtime_profile": payload.runtime_profile,
                "updated_at": datetime.utcnow().isoformat() + "Z",
                "updated_by": payload.updated_by or "frontend",
            },
        )
    return _build_runtime_profile_response()


@app.get("/algorithm/active-flows", response_model=schemas.AlgorithmActiveFlowResponse)
def get_algorithm_active_flows():
    return _build_active_flow_response_from_cache()


@app.post("/algorithm/active-flows/refresh", response_model=schemas.AlgorithmActiveFlowResponse)
def refresh_algorithm_active_flows(db: Session = Depends(get_db)):
    if not MATCH_SCRIPT_PATH.exists():
        raise HTTPException(status_code=500, detail=f"match 脚本不存在：{MATCH_SCRIPT_PATH}")

    MATCH_OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    command = [
        sys.executable,
        str(MATCH_SCRIPT_PATH),
        "--output",
        str(MATCH_OUTPUT_FILE),
    ]

    try:
        result = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="match 脚本执行超时") from exc
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or exc.stdout or "").strip()
        raise HTTPException(status_code=500, detail=f"match 脚本执行失败：{stderr[:500]}") from exc

    raw_payload = _read_json_file(MATCH_OUTPUT_FILE, {})
    if not isinstance(raw_payload, dict) or not raw_payload:
        raise HTTPException(status_code=500, detail=f"match 脚本未输出有效 JSON：{MATCH_OUTPUT_FILE}")

    flows = _normalize_raw_active_flows(raw_payload)
    sync_summary = _sync_active_flows_to_database(db, flows)
    _commit_or_rollback(db, "failed to sync active flows to database")
    _write_json_file(
        ACTIVE_FLOW_CACHE_FILE,
        {
            "updated_at": datetime.utcnow().isoformat() + "Z",
            "source_file": str(MATCH_OUTPUT_FILE),
            "raw_payload": raw_payload,
            "flows": flows,
            "chainlist_format": "device_map",
            "stdout": (result.stdout or "").strip(),
            "database_sync": sync_summary,
        },
    )
    return _build_active_flow_response_from_cache()


@app.post("/algorithm/chainlist/apply", response_model=schemas.ChainlistApplyResponse)
def apply_algorithm_chainlist(payload: schemas.ChainlistApplyRequest, db: Session = Depends(get_db)):
    requested_ids = [item for item in dict.fromkeys(payload.stream_ids) if item][:MAX_COLLECTABLE_FLOWS]
    query = db.query(models.StreamMedia).filter(models.StreamMedia.is_connected == True)  # noqa: E712
    if requested_ids:
        streams = query.filter(models.StreamMedia.id.in_(requested_ids)).order_by(models.StreamMedia.updated_at.desc()).all()
        streams_by_id = {stream.id: stream for stream in streams}
        selected_streams = [streams_by_id[item] for item in requested_ids if item in streams_by_id and _stream_has_complete_chain(streams_by_id[item])]
        skipped = [item for item in requested_ids if item not in {stream.id for stream in selected_streams}]
    else:
        candidates = query.order_by(models.StreamMedia.updated_at.desc()).limit(500).all()
        selected_streams = [stream for stream in candidates if _stream_has_complete_chain(stream)][:MAX_COLLECTABLE_FLOWS]
        skipped = []

    chainlist_payload = _build_chainlist_from_streams(selected_streams)
    _write_json_file(CHAINLIST_FILE, chainlist_payload)
    selected_ids = [stream.id for stream in selected_streams if str(stream.camera_id or stream.id) in chainlist_payload]
    return schemas.ChainlistApplyResponse(
        chainlist_file=str(CHAINLIST_FILE),
        selected_stream_ids=selected_ids,
        written_count=len(chainlist_payload),
        skipped_stream_ids=skipped,
        max_count=MAX_COLLECTABLE_FLOWS,
    )


@app.get("/algorithm/anomalies/latest", response_model=list[schemas.AlgorithmAnomalyRead])
def get_algorithm_anomalies_latest(limit: int = Query(default=100, ge=1, le=500)):
    result = []
    for item in _collect_algorithm_anomalies(limit=limit):
        timestamp = None
        if item.get("timestamp"):
            try:
                timestamp = datetime.fromisoformat(str(item["timestamp"]).replace(" ", "T"))
            except ValueError:
                timestamp = None
        result.append(schemas.AlgorithmAnomalyRead(**{**item, "timestamp": timestamp}))
    return result


# =========================
# Topology
# =========================

@app.post(
    "/topology-links",
    response_model=schemas.TopologyLinkRead,
    status_code=status.HTTP_201_CREATED,
)
def create_topology_link(payload: schemas.TopologyLinkCreate, db: Session = Depends(get_db)):
    if db.get(models.TopologyLink, payload.id):
        raise HTTPException(status_code=409, detail=f"topology_link '{payload.id}' already exists")

    _ensure_entity_exists(db, payload.source_type, payload.source_id)
    _ensure_entity_exists(db, payload.target_type, payload.target_id)

    obj = models.TopologyLink(**payload.model_dump())
    db.add(obj)
    _commit_or_rollback(db, "failed to create topology_link: constraint violation")
    db.refresh(obj)
    return obj


@app.get("/topology-links", response_model=list[schemas.TopologyLinkRead])
def list_topology_links(
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=1000, ge=1, le=5000),
    db: Session = Depends(get_db),
):
    return db.query(models.TopologyLink).offset(skip).limit(limit).all()


@app.get("/topology-links/{link_id}", response_model=schemas.TopologyLinkRead)
def get_topology_link(link_id: str, db: Session = Depends(get_db)):
    obj = db.get(models.TopologyLink, link_id)
    if not obj:
        raise HTTPException(status_code=404, detail="topology_link not found")
    return obj


@app.put("/topology-links/{link_id}", response_model=schemas.TopologyLinkRead)
def update_topology_link(
    link_id: str,
    payload: schemas.TopologyLinkUpdate,
    db: Session = Depends(get_db),
):
    obj = db.get(models.TopologyLink, link_id)
    if not obj:
        raise HTTPException(status_code=404, detail="topology_link not found")

    update_data = payload.model_dump(exclude_unset=True)

    source_type = update_data.get("source_type", obj.source_type)
    source_id = update_data.get("source_id", obj.source_id)
    target_type = update_data.get("target_type", obj.target_type)
    target_id = update_data.get("target_id", obj.target_id)

    _ensure_entity_exists(db, source_type, source_id)
    _ensure_entity_exists(db, target_type, target_id)

    _apply_update(obj, update_data)

    db.add(obj)
    _commit_or_rollback(db, "failed to update topology_link: constraint violation")
    db.refresh(obj)
    return obj


@app.delete("/topology-links/{link_id}")
def delete_topology_link(link_id: str, db: Session = Depends(get_db)):
    obj = db.get(models.TopologyLink, link_id)
    if not obj:
        raise HTTPException(status_code=404, detail="topology_link not found")

    db.delete(obj)
    db.commit()
    return {"message": f"topology_link '{link_id}' deleted"}


@app.get("/topology", response_model=schemas.TopologyGraphRead)
def get_topology(db: Session = Depends(get_db)):
    nodes: list[schemas.TopologyNodeRead] = []

    cameras = db.query(models.Camera).all()
    servers = db.query(models.Server).all()
    network_nodes = db.query(models.NetworkNode).all()

    for camera in cameras:
        nodes.append(
            schemas.TopologyNodeRead(
                id=camera.id,
                type="camera",
                name=camera.name,
                status=camera.status,
                node_type="camera",
                ip=camera.ip,
                longitude=camera.longitude,
                latitude=camera.latitude,
            )
        )

    for server in servers:
        nodes.append(
            schemas.TopologyNodeRead(
                id=server.id,
                type="server",
                name=server.name,
                status=server.status,
                node_type=server.node_type,
                ip=server.ip,
                longitude=server.longitude,
                latitude=server.latitude,
            )
        )

    for node in network_nodes:
        nodes.append(
            schemas.TopologyNodeRead(
                id=node.id,
                type="network_node",
                name=node.name,
                status=node.status,
                node_type=node.node_type,
                ip=node.ip,
                longitude=node.longitude,
                latitude=node.latitude,
            )
        )

    links = db.query(models.TopologyLink).all()

    return {
        "nodes": nodes,
        "links": links,
    }


# =========================
# FaultEvent
# =========================

@app.post(
    "/fault-events",
    response_model=schemas.FaultEventRead,
    status_code=status.HTTP_201_CREATED,
)
def create_fault_event(payload: schemas.FaultEventCreate, db: Session = Depends(get_db)):
    if db.get(models.FaultEvent, payload.id):
        raise HTTPException(status_code=409, detail=f"fault_event '{payload.id}' already exists")

    _ensure_entity_exists(db, payload.entity_type, payload.entity_id)

    obj = models.FaultEvent(**payload.model_dump())
    db.add(obj)
    _commit_or_rollback(db, "failed to create fault_event: constraint violation")
    db.refresh(obj)
    return obj


@app.get("/fault-events", response_model=list[schemas.FaultEventRead])
def list_fault_events(
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=1000),
    entity_type: schemas.EntityType | None = None,
    entity_id: str | None = None,
    level: str | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    db: Session = Depends(get_db),
):
    query = db.query(models.FaultEvent)

    if entity_type:
        query = query.filter(models.FaultEvent.entity_type == entity_type)

    if entity_id:
        query = query.filter(models.FaultEvent.entity_id == entity_id)

    if level:
        query = query.filter(models.FaultEvent.level == level)

    if status_filter:
        query = query.filter(models.FaultEvent.status == status_filter)

    return (
        query.order_by(models.FaultEvent.trigger_time.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )


@app.get("/fault-events/{fault_event_id}", response_model=schemas.FaultEventRead)
def get_fault_event(fault_event_id: str, db: Session = Depends(get_db)):
    obj = db.get(models.FaultEvent, fault_event_id)
    if not obj:
        raise HTTPException(status_code=404, detail="fault_event not found")
    return obj


@app.put("/fault-events/{fault_event_id}", response_model=schemas.FaultEventRead)
def update_fault_event(
    fault_event_id: str,
    payload: schemas.FaultEventUpdate,
    db: Session = Depends(get_db),
):
    obj = db.get(models.FaultEvent, fault_event_id)
    if not obj:
        raise HTTPException(status_code=404, detail="fault_event not found")

    update_data = payload.model_dump(exclude_unset=True)

    entity_type = update_data.get("entity_type", obj.entity_type)
    entity_id = update_data.get("entity_id", obj.entity_id)
    _ensure_entity_exists(db, entity_type, entity_id)

    _apply_update(obj, update_data)

    db.add(obj)
    _commit_or_rollback(db, "failed to update fault_event: constraint violation")
    db.refresh(obj)
    return obj


@app.delete("/fault-events/{fault_event_id}")
def delete_fault_event(fault_event_id: str, db: Session = Depends(get_db)):
    obj = db.get(models.FaultEvent, fault_event_id)
    if not obj:
        raise HTTPException(status_code=404, detail="fault_event not found")

    db.delete(obj)
    db.commit()
    return {"message": f"fault_event '{fault_event_id}' deleted"}


# =========================
# RootCause
# =========================

@app.post(
    "/root-causes",
    response_model=schemas.RootCauseRead,
    status_code=status.HTTP_201_CREATED,
)
def create_root_cause(payload: schemas.RootCauseCreate, db: Session = Depends(get_db)):
    if db.get(models.RootCause, payload.id):
        raise HTTPException(status_code=409, detail=f"root_cause '{payload.id}' already exists")

    if not db.get(models.FaultEvent, payload.fault_event_id):
        raise HTTPException(
            status_code=400,
            detail=f"fault_event '{payload.fault_event_id}' does not exist",
        )

    obj = models.RootCause(**payload.model_dump())
    db.add(obj)
    _commit_or_rollback(db, "failed to create root_cause: constraint violation")
    db.refresh(obj)
    return obj


@app.get("/root-causes", response_model=list[schemas.RootCauseRead])
def list_root_causes(
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=1000),
    db: Session = Depends(get_db),
):
    return db.query(models.RootCause).offset(skip).limit(limit).all()


@app.get("/root-causes/{root_cause_id}", response_model=schemas.RootCauseRead)
def get_root_cause(root_cause_id: str, db: Session = Depends(get_db)):
    obj = db.get(models.RootCause, root_cause_id)
    if not obj:
        raise HTTPException(status_code=404, detail="root_cause not found")
    return obj


@app.put("/root-causes/{root_cause_id}", response_model=schemas.RootCauseRead)
def update_root_cause(
    root_cause_id: str,
    payload: schemas.RootCauseUpdate,
    db: Session = Depends(get_db),
):
    obj = db.get(models.RootCause, root_cause_id)
    if not obj:
        raise HTTPException(status_code=404, detail="root_cause not found")

    update_data = payload.model_dump(exclude_unset=True)

    if "fault_event_id" in update_data:
        if not db.get(models.FaultEvent, update_data["fault_event_id"]):
            raise HTTPException(
                status_code=400,
                detail=f"fault_event '{update_data['fault_event_id']}' does not exist",
            )

    _apply_update(obj, update_data)

    db.add(obj)
    _commit_or_rollback(db, "failed to update root_cause: constraint violation")
    db.refresh(obj)
    return obj


@app.delete("/root-causes/{root_cause_id}")
def delete_root_cause(root_cause_id: str, db: Session = Depends(get_db)):
    obj = db.get(models.RootCause, root_cause_id)
    if not obj:
        raise HTTPException(status_code=404, detail="root_cause not found")

    db.delete(obj)
    db.commit()
    return {"message": f"root_cause '{root_cause_id}' deleted"}


# =========================
# WorkOrder
# =========================

def _make_work_order_id() -> str:
    return f"WO-{datetime.utcnow():%Y%m%d%H%M%S}-{randint(1000, 9999)}"


def _append_work_order_timeline(
    order: models.WorkOrder,
    action: str,
    operator: str | None = None,
    note: str | None = None,
) -> None:
    entries = list(order.timeline or [])
    entries.append(
        {
            "time": datetime.utcnow().isoformat(),
            "action": action,
            "operator": operator or "system",
            "note": note or "",
        }
    )
    order.timeline = entries
    order.last_action = action


def _region_path_from_camera(camera: models.Camera) -> str:
    return " / ".join(
        [
            camera.province_name,
            camera.city_name,
            camera.county_name,
            camera.town_name,
        ]
    )


def _get_region_path(db: Session, region_code: str) -> tuple[str, str, str]:
    region = _get_region_or_404(db, region_code)
    chain: list[models.AdministrativeRegion] = []
    current: models.AdministrativeRegion | None = region

    while current:
        chain.append(current)
        current = db.get(models.AdministrativeRegion, current.parent_code) if current.parent_code else None

    chain.reverse()
    return region.region_name, region.level, " / ".join(item.region_name for item in chain)


def _hydrate_work_order_context(db: Session, data: dict[str, Any]) -> None:
    entity_type = data.get("related_entity_type")
    entity_id = data.get("related_entity_id")

    if bool(entity_type) != bool(entity_id):
        raise HTTPException(status_code=400, detail="related_entity_type and related_entity_id must be provided together")

    if entity_type and entity_id:
        _ensure_entity_exists(db, entity_type, entity_id)

        if entity_type == "camera":
            camera = db.get(models.Camera, entity_id)
            data["related_entity_name"] = data.get("related_entity_name") or camera.name
            data["region_code"] = camera.town_code
            data["region_name"] = camera.town_name
            data["region_level"] = "town"
            data["region_path"] = _region_path_from_camera(camera)

        elif entity_type == "server":
            server = db.get(models.Server, entity_id)
            data["related_entity_name"] = data.get("related_entity_name") or server.name
            data["region_path"] = data.get("region_path") or server.location_desc

        elif entity_type == "stream_media":
            stream = db.get(models.StreamMedia, entity_id)
            camera = db.get(models.Camera, stream.camera_id) if stream.camera_id else None
            server = db.get(models.Server, stream.server_id) if stream.server_id else None
            data["related_entity_name"] = data.get("related_entity_name") or " -> ".join(
                item for item in [camera.name if camera else stream.camera_id, server.name if server else stream.server_id] if item
            ) or stream.id
            if camera:
                data["region_code"] = camera.town_code
                data["region_name"] = camera.town_name
                data["region_level"] = "town"
                data["region_path"] = _region_path_from_camera(camera)

        elif entity_type == "network_node":
            node = db.get(models.NetworkNode, entity_id)
            data["related_entity_name"] = data.get("related_entity_name") or node.name
            data["region_path"] = data.get("region_path") or node.location_desc

    if data.get("region_code") and not data.get("region_path"):
        region_name, region_level, region_path = _get_region_path(db, data["region_code"])
        data["region_name"] = data.get("region_name") or region_name
        data["region_level"] = data.get("region_level") or region_level
        data["region_path"] = region_path


def _ensure_demo_work_orders(db: Session) -> None:
    if db.query(models.WorkOrder).count() > 0:
        return

    cameras = db.query(models.Camera).limit(6).all()
    servers = db.query(models.Server).limit(2).all()
    streams = db.query(models.StreamMedia).limit(2).all()

    if not cameras and not servers and not streams:
        return

    now = datetime.utcnow()
    demo_items: list[dict[str, Any]] = []

    if cameras:
        camera = cameras[0]
        demo_items.append(
            {
                "title": f"{camera.name} 画面中断排查",
                "description": "巡检发现该点位预览不稳定，请确认摄像机供电、网络与平台接入状态。",
                "order_type": "camera",
                "priority": "high",
                "status": "pending",
                "source": "inspection",
                "related_entity_type": "camera",
                "related_entity_id": camera.id,
                "assignee": "值班运维",
                "creator": "系统巡检",
                "sla_deadline": now + timedelta(hours=4),
            }
        )

    if len(cameras) > 1:
        camera = cameras[1]
        demo_items.append(
            {
                "title": f"{camera.name} 点位信息复核",
                "description": "设备台账与地图定位存在偏差，请核对经纬度、安装位置和归属行政区。",
                "order_type": "camera",
                "priority": "medium",
                "status": "processing",
                "source": "manual",
                "related_entity_type": "camera",
                "related_entity_id": camera.id,
                "assignee": "现场工程师",
                "creator": "平台管理员",
                "accepted_at": now - timedelta(hours=1),
                "sla_deadline": now + timedelta(hours=10),
            }
        )

    if servers:
        server = servers[0]
        demo_items.append(
            {
                "title": f"{server.name} 资源占用持续偏高",
                "description": "近一小时 CPU 与网卡 IO 波动较大，请检查流转发压力和进程状态。",
                "order_type": "server",
                "priority": "urgent",
                "status": "processing",
                "source": "alarm",
                "related_entity_type": "server",
                "related_entity_id": server.id,
                "assignee": "平台运维",
                "creator": "告警中心",
                "accepted_at": now - timedelta(minutes=35),
                "sla_deadline": now + timedelta(hours=2),
            }
        )

    if streams:
        stream = streams[0]
        demo_items.append(
            {
                "title": f"{stream.id} 流链路质量异常",
                "description": "该链路吞吐量下降且存在丢包，请排查摄像机到流媒体服务器链路质量。",
                "order_type": "stream",
                "priority": "high",
                "status": "review",
                "source": "alarm",
                "related_entity_type": "stream_media",
                "related_entity_id": stream.id,
                "assignee": "网络运维",
                "creator": "链路监测",
                "accepted_at": now - timedelta(hours=2),
                "sla_deadline": now + timedelta(hours=6),
                "resolution": "已调整接入交换机端口，等待复测确认。",
            }
        )

    demo_items.append(
        {
            "title": "重点区域视频点位例行巡检",
            "description": "对当前重点行政区内摄像机在线率、流链路连通性和服务器资源进行例行复核。",
            "order_type": "inspection",
            "priority": "low",
            "status": "pending",
            "source": "manual",
            "assignee": "值班运维",
            "creator": "平台管理员",
            "sla_deadline": now + timedelta(days=1),
        }
    )

    for index, item in enumerate(demo_items, start=1):
        data = {
            "id": f"WO-DEMO-{index:04d}",
            **item,
            "timeline": [
                {
                    "time": (now - timedelta(minutes=15 * index)).isoformat(),
                    "action": "创建工单",
                    "operator": item.get("creator") or "system",
                    "note": item.get("description") or "",
                }
            ],
        }
        _hydrate_work_order_context(db, data)
        db.add(models.WorkOrder(**data))

    db.commit()


@app.post(
    "/work-orders",
    response_model=schemas.WorkOrderRead,
    status_code=status.HTTP_201_CREATED,
)
def create_work_order(payload: schemas.WorkOrderCreate, db: Session = Depends(get_db)):
    data = payload.model_dump()
    data["id"] = data.get("id") or _make_work_order_id()

    if db.get(models.WorkOrder, data["id"]):
        raise HTTPException(status_code=409, detail=f"work_order '{data['id']}' already exists")

    _hydrate_work_order_context(db, data)
    data["timeline"] = data.get("timeline") or []

    obj = models.WorkOrder(**data)
    _append_work_order_timeline(obj, "创建工单", obj.creator, obj.description)
    db.add(obj)
    _commit_or_rollback(db, "failed to create work_order: constraint violation")
    db.refresh(obj)
    return obj


@app.get("/work-orders", response_model=list[schemas.WorkOrderRead])
def list_work_orders(
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=200, ge=1, le=1000),
    status_filter: str | None = None,
    priority: str | None = None,
    order_type: str | None = None,
    region_code: str | None = None,
    entity_type: schemas.WorkOrderEntityType | None = None,
    entity_id: str | None = None,
    keyword: str | None = None,
    db: Session = Depends(get_db),
):
    _ensure_demo_work_orders(db)
    query = db.query(models.WorkOrder)

    if status_filter and status_filter != "all":
        query = query.filter(models.WorkOrder.status == status_filter)

    if priority and priority != "all":
        query = query.filter(models.WorkOrder.priority == priority)

    if order_type and order_type != "all":
        query = query.filter(models.WorkOrder.order_type == order_type)

    if region_code:
        region_codes = _collect_region_descendant_codes(db, region_code)
        query = query.filter(models.WorkOrder.region_code.in_(region_codes))

    if entity_type:
        query = query.filter(models.WorkOrder.related_entity_type == entity_type)

    if entity_id:
        query = query.filter(models.WorkOrder.related_entity_id == entity_id)

    if keyword:
        text = f"%{keyword.strip()}%"
        query = query.filter(
            or_(
                models.WorkOrder.id.like(text),
                models.WorkOrder.title.like(text),
                models.WorkOrder.description.like(text),
                models.WorkOrder.related_entity_name.like(text),
                models.WorkOrder.region_path.like(text),
                models.WorkOrder.assignee.like(text),
            )
        )

    return (
        query.order_by(models.WorkOrder.updated_at.desc(), models.WorkOrder.created_at.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )


@app.get("/work-orders/{order_id}", response_model=schemas.WorkOrderRead)
def get_work_order(order_id: str, db: Session = Depends(get_db)):
    obj = db.get(models.WorkOrder, order_id)
    if not obj:
        raise HTTPException(status_code=404, detail="work_order not found")
    return obj


@app.put("/work-orders/{order_id}", response_model=schemas.WorkOrderRead)
def update_work_order(
    order_id: str,
    payload: schemas.WorkOrderUpdate,
    db: Session = Depends(get_db),
):
    obj = db.get(models.WorkOrder, order_id)
    if not obj:
        raise HTTPException(status_code=404, detail="work_order not found")

    update_data = payload.model_dump(exclude_unset=True)
    previous_status = obj.status
    _hydrate_work_order_context(db, update_data)
    _apply_update(obj, update_data)

    if obj.status == "processing" and not obj.accepted_at:
        obj.accepted_at = datetime.utcnow()
    if obj.status == "closed" and not obj.closed_at:
        obj.closed_at = datetime.utcnow()
    if "status" in update_data and update_data["status"] != previous_status:
        _append_work_order_timeline(obj, f"状态变更为 {update_data['status']}", obj.assignee, obj.resolution)
    elif "last_action" in update_data:
        _append_work_order_timeline(obj, update_data["last_action"], obj.assignee, obj.resolution)

    db.add(obj)
    _commit_or_rollback(db, "failed to update work_order: constraint violation")
    db.refresh(obj)
    return obj


@app.delete("/work-orders/{order_id}")
def delete_work_order(order_id: str, db: Session = Depends(get_db)):
    obj = db.get(models.WorkOrder, order_id)
    if not obj:
        raise HTTPException(status_code=404, detail="work_order not found")

    db.delete(obj)
    db.commit()
    return {"message": f"work_order '{order_id}' deleted"}


# =========================
# VideoDiagnosis
# =========================

def _make_video_diagnosis_id(camera_id: str) -> str:
    safe_camera_id = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in camera_id)
    return f"vd-{safe_camera_id}-{datetime.utcnow():%Y%m%d%H%M%S}-{randint(100, 999)}"[:64]


def _diagnosis_branch(key: str, label: str, evidence: str, selected_keys: set[str]) -> dict[str, Any]:
    return {
        "key": key,
        "label": label,
        "evidence": evidence,
        "selected": key in selected_keys,
    }


def _format_diagnosis_time(value: datetime | None) -> str:
    return value.strftime("%Y-%m-%d %H:%M:%S") if value else "未查询到"


def _build_demo_diagnosis_flow(selected_keys: set[str]) -> dict[str, Any]:
    return {
        "title": "5G 专线故障定位分析流程",
        "description": "按 IPC 诊断、网络诊断、平台诊断三段展示完整分支，演示时只高亮本次命中的判断路径。",
        "stages": [
            {
                "key": "ipc",
                "title": "IPC 诊断",
                "decision": "先判断摄像机是否具备可诊断条件。",
                "branches": [
                    _diagnosis_branch("ipc.not_registered", "设备未录入", "首次上线时间为空，无法关联资产台账。", selected_keys),
                    _diagnosis_branch("ipc.ip_missing", "IP 信息不全", "设备 IP 或归属区域缺失。", selected_keys),
                    _diagnosis_branch("ipc.power_off", "断电/离线", "硬件监控告警或心跳长时间中断。", selected_keys),
                    _diagnosis_branch("ipc.normal", "设备侧通过", "设备已录入、IP 完整、基础心跳正常。", selected_keys),
                ],
            },
            {
                "key": "network",
                "title": "网络诊断",
                "decision": "设备侧通过后，继续排查有线网络和专线链路。",
                "branches": [
                    _diagnosis_branch("network.unreachable", "链路不可达", "Ping 超时，接入交换机方向不可达。", selected_keys),
                    _diagnosis_branch("network.packet_loss", "丢包/抖动异常", "流量、前 10 命令计数器和重传指标异常。", selected_keys),
                    _diagnosis_branch("network.throughput", "吞吐下降", "事务处理数下降，表打开缓存命中率偏低。", selected_keys),
                    _diagnosis_branch("network.normal", "网络侧通过", "端到端连通性和链路质量指标未触发阈值。", selected_keys),
                    _diagnosis_branch("network.skipped", "网络诊断跳过", "设备侧已定位到根因，无需继续网络诊断。", selected_keys),
                ],
            },
            {
                "key": "platform",
                "title": "平台诊断",
                "decision": "网络侧未闭环时，继续判断平台服务和上下游状态。",
                "branches": [
                    _diagnosis_branch("platform.server_load", "流媒体服务异常", "CPU、转码队列或网卡缓冲区指标异常。", selected_keys),
                    _diagnosis_branch("platform.downstream", "下级平台异常", "下级平台请求失败或回包超时。", selected_keys),
                    _diagnosis_branch("platform.upstream", "上级平台异常", "上级平台注册或级联链路异常。", selected_keys),
                    _diagnosis_branch("platform.normal", "平台侧通过", "平台服务、上下游级联和客户端侧指标正常。", selected_keys),
                    _diagnosis_branch("platform.skipped", "平台诊断跳过", "前序阶段已定位到根因，无需继续平台诊断。", selected_keys),
                ],
            },
        ],
        "selected_path": [key for key in selected_keys if not key.endswith(".skipped")],
    }


def _select_demo_diagnosis_scenario(camera: models.Camera, server_name: str) -> dict[str, Any]:
    if not camera.ip:
        return {
            "keys": {"ipc.ip_missing", "network.skipped", "platform.skipped"},
            "health_score": 35,
            "business_status": "设备信息缺失",
            "abnormal_type": "设备信息异常",
            "root_cause_type": "IPC",
            "root_cause_node": camera.name,
            "root_cause_metric": "设备 IP 或归属区域不完整，诊断流程无法进入网络与平台侧。",
            "hierarchy": {
                "level1": "IPC 诊断",
                "level2": "设备信息",
                "level3": "IP 信息不全",
                "target": camera.name,
                "reason": "设备基础台账不完整，无法建立有效的网络探测目标。",
            },
            "suggestion": "补齐摄像机 IP、所属区域和接入信息后重新发起诊断。",
            "ping_output": "缺少有效 IP，未执行 Ping 探测。",
        }

    if camera.status == "offline":
        return {
            "keys": {"ipc.power_off", "network.unreachable", "platform.skipped"},
            "health_score": 0,
            "business_status": "断连",
            "abnormal_type": "断连",
            "root_cause_type": "网络链路",
            "root_cause_node": "接入交换机端口",
            "root_cause_metric": "ICMP 不可达，设备无响应；同乡镇相邻在线摄像机可达，异常收敛在摄像机接入侧。",
            "hierarchy": {
                "level1": "网络链路",
                "level2": "上行链路",
                "level3": "接入端口 / 传输介质",
                "target": "摄像机上行链路",
                "reason": "Ping 连续超时，且同区域其他摄像机仍可达，说明核心网络与服务器侧不构成主要瓶颈，根因更可能位于摄像机上行链路的接入端口、网线或现场供电链路。",
            },
            "suggestion": "请运维人员优先核对设备 IP、供电状态、接入交换机端口和现场网线连接。",
            "ping_output": f"PING {camera.ip}: request timeout\nPING {camera.ip}: destination host unreachable\n--- {camera.ip} ping statistics ---\n4 packets transmitted, 0 received, 100% packet loss",
        }

    if camera.status != "fault":
        return {
            "keys": {"ipc.normal", "network.normal", "platform.normal"},
            "health_score": 92,
            "business_status": "视频业务健康",
            "abnormal_type": "无明显异常",
            "root_cause_type": "无",
            "root_cause_node": "无",
            "root_cause_metric": "IPC、网络与平台侧演示检查均未命中异常分支。",
            "hierarchy": {
                "level1": "无",
                "level2": "无",
                "level3": "无",
                "target": "无",
                "reason": "设备侧、网络侧和平台侧均处于正常演示路径。",
            },
            "suggestion": "当前无需处置，建议保持常规巡检。",
            "ping_output": f"PING {camera.ip}: 56 data bytes\n64 bytes from {camera.ip}: icmp_seq=1 ttl=63 time=6.8 ms\n64 bytes from {camera.ip}: icmp_seq=2 ttl=63 time=7.1 ms\n64 bytes from {camera.ip}: icmp_seq=3 ttl=63 time=6.5 ms\n--- {camera.ip} ping statistics ---\n3 packets transmitted, 3 received, 0% packet loss",
        }

    scenarios = [
        {
            "keys": {"ipc.normal", "network.normal", "platform.server_load"},
            "health_score": 75,
            "business_status": "画面轻微拖影",
            "abnormal_type": "拖影",
            "root_cause_type": "服务器",
            "root_cause_node": server_name,
            "root_cause_metric": "转码负荷过高，CPU 利用率 > 95%；多路视频在同一服务器节点同步出现编码延迟。",
            "hierarchy": {
                "level1": "服务器",
                "level2": "流媒体服务器",
                "level3": "CPU",
                "target": server_name,
                "reason": "Ping 与上行链路指标基本正常，但服务器侧转码队列持续积压，CPU 利用率长时间高于 95%，并影响同服务器承载的多路视频，定位为流媒体服务器 CPU 资源瓶颈。",
            },
            "suggestion": "建议迁移部分转码任务、检查服务器 CPU 与网卡队列，并复测流媒体服务。",
        },
        {
            "keys": {"ipc.normal", "network.packet_loss", "platform.normal"},
            "health_score": 68,
            "business_status": "视频明显卡顿",
            "abnormal_type": "卡顿",
            "root_cause_type": "网络链路",
            "root_cause_node": "摄像机上行链路",
            "root_cause_metric": "高抖动 42ms，频繁重传，吞吐量下降 38%；异常集中在摄像机到服务器方向。",
            "hierarchy": {
                "level1": "网络链路",
                "level2": "上行链路",
                "level3": "链路容量",
                "target": "摄像机上行链路",
                "reason": "客户端下行与服务器负载未出现同步异常，异常重构损失主要集中在上行链路的抖动、重传和吞吐下降指标，定位为上行链路容量不足或队列拥塞。",
            },
            "suggestion": "建议检查摄像机上行链路、交换机端口错误包、丢包和抖动，并复测端到端吞吐。",
        },
        {
            "keys": {"ipc.normal", "network.packet_loss", "platform.normal"},
            "health_score": 62,
            "business_status": "画面局部花屏",
            "abnormal_type": "花屏",
            "root_cause_type": "网络链路",
            "root_cause_node": "摄像机上行链路",
            "root_cause_metric": "乱序率高，关键帧丢失，丢包率 6.8%；异常片段与上行链路丢包峰值时间对齐。",
            "hierarchy": {
                "level1": "网络链路",
                "level2": "上行链路",
                "level3": "传输介质",
                "target": "摄像机上行链路",
                "reason": "花屏片段与关键帧丢失、乱序率升高同步出现，服务器转码与客户端解码指标未达到异常阈值，定位为上行传输介质质量异常。",
            },
            "suggestion": "建议检查摄像机上行链路、交换机端口错误包、丢包和抖动，并复测端到端吞吐。",
        },
        {
            "keys": {"ipc.normal", "network.normal", "platform.server_load"},
            "health_score": 48,
            "business_status": "链路间歇断连",
            "abnormal_type": "断连",
            "root_cause_type": "服务器",
            "root_cause_node": server_name,
            "root_cause_metric": "网卡缓冲区溢出，服务进程短时无响应；同节点多路流出现短时断续。",
            "hierarchy": {
                "level1": "服务器",
                "level2": "流媒体服务器",
                "level3": "网卡",
                "target": server_name,
                "reason": "摄像机 Ping 可达，客户端侧无独立异常，但流媒体服务器网卡队列出现突增丢弃，同节点多路视频同时短断，定位为服务器网卡缓冲区瓶颈。",
            },
            "suggestion": "建议迁移部分转码任务、检查服务器 CPU 与网卡队列，并复测流媒体服务。",
        },
    ]
    selected = scenarios[sum(ord(ch) for ch in camera.id) % len(scenarios)]
    return {
        "ping_output": f"PING {camera.ip}: 56 data bytes\n64 bytes from {camera.ip}: icmp_seq=1 ttl=63 time=6.8 ms\n64 bytes from {camera.ip}: icmp_seq=2 ttl=63 time=7.1 ms\n64 bytes from {camera.ip}: icmp_seq=3 ttl=63 time=6.5 ms\n--- {camera.ip} ping statistics ---\n3 packets transmitted, 3 received, 0% packet loss",
        **selected,
    }


def _diagnosis_profile(camera: models.Camera) -> dict[str, Any]:
    server_name = camera.server_id or "流媒体服务器"
    scenario = _select_demo_diagnosis_scenario(camera, server_name)
    selected_keys = set(scenario["keys"])
    root_cause_hierarchy = scenario["hierarchy"]
    score = scenario["health_score"]
    first_online_text = _format_diagnosis_time(camera.created_at)
    last_heartbeat_text = _format_diagnosis_time(camera.last_heartbeat)
    conclusion = (
        "问题归类：未发现明显异常。根因定位：IPC、网络和平台侧均通过。"
        if score >= 80
        else f"问题归类：{root_cause_hierarchy['level1']}。根因定位：{root_cause_hierarchy['level2']} - {root_cause_hierarchy['level3']}。"
    )
    ipc_blocked = bool({"ipc.ip_missing", "ipc.power_off"} & selected_keys)
    network_skipped = "network.skipped" in selected_keys
    ping_unreachable = "network.unreachable" in selected_keys
    stream_skipped = network_skipped or ping_unreachable
    stream_quality_abnormal = "network.packet_loss" in selected_keys
    full_chain_skipped = stream_skipped

    return {
        "health_score": score,
        "business_status": scenario["business_status"],
        "abnormal_type": scenario["abnormal_type"],
        "root_cause_type": scenario["root_cause_type"],
        "root_cause_node": scenario["root_cause_node"],
        "root_cause_metric": scenario["root_cause_metric"],
        "root_cause_hierarchy": root_cause_hierarchy,
        "conclusion": conclusion,
        "suggestion": f"处置建议：{scenario['suggestion']}",
        "ping_output": scenario["ping_output"],
        "steps": [
            {
                "index": 1,
                "title": "IPC 诊断",
                "status": "failed" if "ipc.power_off" in selected_keys or "ipc.ip_missing" in selected_keys else "done",
                "description": "检查设备录入、IP 信息、心跳和断电状态，确认是否具备继续诊断条件。",
                "checks": [
                    {
                        "label": "查询设备首次上线时间",
                        "status": "hit" if "ipc.not_registered" in selected_keys else "pass",
                        "result": "设备未录入，未查询到首次上线时间。" if "ipc.not_registered" in selected_keys else f"首次上线时间：{first_online_text}。",
                    },
                    {
                        "label": "查询设备 IP 情况",
                        "status": "hit" if "ipc.ip_missing" in selected_keys else "pass",
                        "result": "IP 信息不完整" if "ipc.ip_missing" in selected_keys else f"设备 IP：{camera.ip}，信息完整。",
                    },
                    {
                        "label": "接收硬件监控告警",
                        "status": "hit" if "ipc.power_off" in selected_keys else "pass",
                        "result": f"命中断电/离线分支，最近心跳时间：{last_heartbeat_text}。" if "ipc.power_off" in selected_keys else f"未发现断电告警，最近心跳时间：{last_heartbeat_text}，继续向网络侧排查。",
                    },
                    {
                        "label": "IPC 阶段结论",
                        "status": "hit" if ipc_blocked else "pass",
                        "result": "IPC 侧已定位到根因，后续诊断跳过。" if ipc_blocked else "IPC 侧通过，进入网络诊断。",
                    },
                ],
            },
            {
                "index": 2,
                "title": "网络诊断",
                "status": "failed" if ping_unreachable or stream_quality_abnormal else "done",
                "description": "检查 Ping 连通性，并在网络可达后尝试开流。",
                "checks": [
                    {
                        "label": "Ping 连通性检测",
                        "status": "skip" if network_skipped else "hit" if ping_unreachable else "pass",
                        "result": "前序 IPC 已定位，跳过网络诊断。" if network_skipped else "Ping 不通，第三步跳过。" if ping_unreachable else "Ping 可达，继续尝试开流。",
                    },
                    {
                        "label": "尝试开流",
                        "status": "skip" if stream_skipped else "hit" if stream_quality_abnormal else "pass",
                        "result": "Ping 不通，跳过开流尝试。" if stream_skipped else "开流成功，但发现视频质量异常。" if stream_quality_abnormal else "开流成功，进入全链路信息采集。",
                    },
                ],
            },
            {
                "index": 3,
                "title": "采集全链路信息",
                "status": "done",
                "description": "开流成功后采集摄像机链路、视频流状态和平台关联信息。",
                "checks": [
                    {
                        "label": "采集全链路信息",
                        "status": "skip" if full_chain_skipped else "pass",
                        "result": "Ping 不通，第三步跳过。" if full_chain_skipped else "摄像机链路、视频流状态和平台关联信息采集完成。",
                    },
                ],
            },
            {
                "index": 4,
                "title": "生成诊断结论",
                "status": "done",
                "description": f"{conclusion} 处置建议：{scenario['suggestion']}",
                "checks": [
                    {"label": "问题归类", "status": "hit" if score < 80 else "pass", "result": root_cause_hierarchy["level1"]},
                    {"label": "根因定位", "status": "hit" if score < 80 else "pass", "result": f"{root_cause_hierarchy['level2']} - {root_cause_hierarchy['level3']}"},
                    {"label": "处置建议", "status": "pass", "result": scenario["suggestion"]},
                ],
            },
        ],
    }


def _build_diagnosis_topology(camera: models.Camera, profile: dict[str, Any]) -> dict[str, Any]:
    server_id = camera.server_id or "stream-server"
    return {
        "nodes": [
            {"id": camera.id, "label": "摄像机", "name": camera.name, "type": "camera"},
            {"id": "network-node", "label": "网络节点", "name": "接入交换机", "type": "network"},
            {"id": server_id, "label": "流媒体服务器", "name": server_id, "type": "server"},
            {"id": "client", "label": "客户端", "name": "视频浏览端", "type": "client"},
        ],
        "fault_node": profile["root_cause_node"],
        "fault_metric": profile["root_cause_metric"],
        "root_cause_hierarchy": profile.get("root_cause_hierarchy"),
    }


def _find_open_video_diagnosis_order(db: Session, camera_id: str) -> models.WorkOrder | None:
    return (
        db.query(models.WorkOrder)
        .filter(
            models.WorkOrder.related_entity_type == "camera",
            models.WorkOrder.related_entity_id == camera_id,
            models.WorkOrder.source == "video_diagnosis",
            models.WorkOrder.status.notin_(["closed", "cancelled"]),
        )
        .order_by(models.WorkOrder.updated_at.desc())
        .first()
    )


def _diagnosis_work_order_note(diagnosis: models.VideoDiagnosis) -> str:
    hierarchy = (diagnosis.topology or {}).get("root_cause_hierarchy") or {}
    hierarchy_text = " → ".join(
        str(hierarchy.get(key))
        for key in ("level1", "level2", "level3")
        if hierarchy.get(key)
    ) or diagnosis.root_cause_type or "无"
    return (
        f"诊断时间：{diagnosis.started_at:%Y-%m-%d %H:%M:%S}；"
        f"健康度：{diagnosis.health_score}分；"
        f"业务状态：{diagnosis.business_status}；"
        f"根因层级：{hierarchy_text}；"
        f"根因位置：{hierarchy.get('target') or diagnosis.root_cause_node}；"
        f"定位依据：{hierarchy.get('reason') or diagnosis.root_cause_metric}；"
        f"处置建议：{diagnosis.suggestion}"
    )[:512]


def _sync_video_diagnosis_work_order(
    db: Session,
    camera: models.Camera,
    diagnosis: models.VideoDiagnosis,
) -> str | None:
    if camera.status == "online" and (diagnosis.health_score or 0) >= 80:
        return None

    now = datetime.utcnow()
    priority = "urgent" if camera.status == "offline" else "high"
    title = f"{camera.name}{diagnosis.business_status or '视频异常'}"
    description = _diagnosis_work_order_note(diagnosis)

    order = _find_open_video_diagnosis_order(db, camera.id)
    if order:
        order.title = title[:128]
        order.description = description
        order.priority = priority
        order.status = order.status or "pending"
        order.assignee = camera.manager or order.assignee or "值班运维"
        order.sla_deadline = now + timedelta(hours=2 if priority == "urgent" else 8)
        order.last_action = f"根因诊断更新：{diagnosis.business_status}，健康度 {diagnosis.health_score} 分"
        _append_work_order_timeline(order, "根因诊断更新", "根因诊断", description)
        return order.id

    data = {
        "id": _make_work_order_id(),
        "title": title[:128],
        "description": description,
        "order_type": "camera",
        "priority": priority,
        "status": "pending",
        "source": "video_diagnosis",
        "related_entity_type": "camera",
        "related_entity_id": camera.id,
        "related_entity_name": camera.name,
        "region_code": camera.town_code,
        "assignee": camera.manager or "值班运维",
        "creator": "根因诊断",
        "sla_deadline": now + timedelta(hours=2 if priority == "urgent" else 8),
        "last_action": f"根因诊断自动生成：{diagnosis.business_status}，健康度 {diagnosis.health_score} 分",
        "timeline": [],
    }
    _hydrate_work_order_context(db, data)
    order = models.WorkOrder(**data)
    _append_work_order_timeline(order, "根因诊断自动生成工单", "根因诊断", description)
    db.add(order)
    return order.id


def _attach_video_diagnosis_work_order_id(
    db: Session,
    diagnosis: models.VideoDiagnosis | None,
) -> models.VideoDiagnosis | None:
    if not diagnosis:
        return None

    order = _find_open_video_diagnosis_order(db, diagnosis.camera_id)
    diagnosis.work_order_id = order.id if order else None
    return diagnosis


@app.get("/cameras/{camera_id}/diagnoses/latest", response_model=schemas.VideoDiagnosisRead | None)
def get_latest_video_diagnosis(camera_id: str, db: Session = Depends(get_db)):
    _ensure_camera_exists(db, camera_id)
    diagnosis = (
        db.query(models.VideoDiagnosis)
        .filter(models.VideoDiagnosis.camera_id == camera_id)
        .order_by(models.VideoDiagnosis.started_at.desc())
        .first()
    )
    return _attach_video_diagnosis_work_order_id(db, diagnosis)


@app.post("/cameras/{camera_id}/diagnoses/run", response_model=schemas.VideoDiagnosisRead)
def run_video_diagnosis(camera_id: str, db: Session = Depends(get_db)):
    camera = db.get(models.Camera, camera_id)
    if not camera:
        raise HTTPException(status_code=404, detail="camera not found")

    started_at = datetime.utcnow()
    profile = _diagnosis_profile(camera)
    diagnosis_fields = {
        key: value
        for key, value in profile.items()
        if key not in {"root_cause_hierarchy", "diagnosis_flow"}
    }
    ended_at = started_at + timedelta(seconds=randint(8, 16))

    obj = models.VideoDiagnosis(
        id=_make_video_diagnosis_id(camera.id),
        camera_id=camera.id,
        camera_name=camera.name,
        camera_status=camera.status,
        started_at=started_at,
        ended_at=ended_at,
        topology=_build_diagnosis_topology(camera, profile),
        **diagnosis_fields,
    )
    db.add(obj)
    db.flush()
    work_order_id = _sync_video_diagnosis_work_order(db, camera, obj)
    _commit_or_rollback(db, "failed to create video diagnosis: constraint violation")
    db.refresh(obj)
    obj.work_order_id = work_order_id
    return obj


@app.delete("/diagnoses")
def clear_video_diagnosis_history(db: Session = Depends(get_db)):
    deleted_count = db.query(models.VideoDiagnosis).delete(synchronize_session=False)
    _commit_or_rollback(db, "failed to clear video diagnosis history")
    return {"deleted": deleted_count}


# =========================
# Dashboard
# =========================

@app.get("/dashboard/summary", response_model=schemas.DashboardSummaryRead)
def get_dashboard_summary(db: Session = Depends(get_db)):
    regions = db.query(models.AdministrativeRegion).all()
    servers = db.query(models.Server).all()
    network_nodes = db.query(models.NetworkNode).all()
    cameras = db.query(models.Camera).all()
    streams = db.query(models.StreamMedia).all()
    faults = db.query(models.FaultEvent).all()

    online_camera_count = len([c for c in cameras if c.status == "online"])
    offline_camera_count = len([c for c in cameras if c.status == "offline"])

    fault_stream_count = len([s for s in streams if s.is_fault])
    active_fault_count = len([f for f in faults if f.status != "resolved"])
    critical_fault_count = len([f for f in faults if f.level == "critical"])

    avg_cpu_usage = (
        sum(s.cpu_usage or 0 for s in servers) / len(servers)
        if servers
        else 0
    )

    avg_ram_usage = (
        sum(s.ram_usage or 0 for s in servers) / len(servers)
        if servers
        else 0
    )

    avg_latency = (
        sum(s.latency or 0 for s in streams) / len(streams)
        if streams
        else 0
    )

    avg_packet_loss_rate = (
        sum(s.packet_loss_rate or 0 for s in streams) / len(streams)
        if streams
        else 0
    )

    avg_qoe_score = (
        sum(s.qoe_score or 0 for s in streams) / len(streams)
        if streams
        else 0
    )

    return {
        "region_count": len(regions),
        "server_count": len(servers),
        "network_node_count": len(network_nodes),
        "camera_count": len(cameras),
        "online_camera_count": online_camera_count,
        "offline_camera_count": offline_camera_count,
        "stream_count": len(streams),
        "fault_stream_count": fault_stream_count,
        "active_fault_count": active_fault_count,
        "critical_fault_count": critical_fault_count,
        "avg_cpu_usage": round(avg_cpu_usage, 2),
        "avg_ram_usage": round(avg_ram_usage, 2),
        "avg_latency": round(avg_latency, 2),
        "avg_packet_loss_rate": round(avg_packet_loss_rate, 3),
        "avg_qoe_score": round(avg_qoe_score, 2),
    }


def _status_bucket(status: str | None) -> str:
    if status in {"offline", "disconnected"}:
        return "offline"
    if status in {"fault", "warning", "abnormal"}:
        return "fault"
    return "normal"


def _stream_reconstruction_error(stream: models.StreamMedia) -> float:
    latency = max((stream.latency or 0) - 80, 0) / 240
    jitter = max((stream.jitter or 0) - 8, 0) / 60
    loss = max(stream.packet_loss_rate or 0, 0) / 8
    throughput_drop = max(8 - (stream.throughput or 8), 0) / 8
    qoe_drop = max(100 - (stream.qoe_score or 100), 0) / 100
    disconnected = 1 if not stream.is_connected else 0
    fault = 0.45 if stream.is_fault else 0
    return min(1.0, latency * 0.2 + jitter * 0.16 + loss * 0.22 + throughput_drop * 0.12 + qoe_drop * 0.15 + disconnected * 0.4 + fault)


def _date_key(value: datetime | None) -> str | None:
    if not value:
        return None
    return value.strftime("%m-%d")


def _is_abnormal_diagnosis(diagnosis: models.VideoDiagnosis) -> bool:
    abnormal_type = diagnosis.abnormal_type or ""
    return bool(abnormal_type) and abnormal_type not in {"正常", "无明显异常"}


def _representative_pattern(value: str | None, fallback: str | None = None) -> str:
    text = value or fallback or "未分类异常"
    if any(token in text for token in ["CPU", "处理器", "转码负荷"]):
        return "CPU负载过高"
    if any(token in text for token in ["内存", "可用内存"]):
        return "内存资源不足"
    if any(token in text for token in ["磁盘", "I/O", "IO"]):
        return "磁盘 I/O 阻塞"
    if any(token in text for token in ["丢包", "关键帧丢失", "花屏"]):
        return "网络丢包率过高"
    if any(token in text for token in ["抖动", "重传", "卡顿"]):
        return "网络抖动与重传"
    if any(token in text for token in ["吞吐", "码率"]):
        return "链路吞吐量下降"
    if any(token in text for token in ["心跳", "疑似离线", "设备离线", "长时间未上报"]):
        return "摄像机离线"
    if any(token in text for token in ["视频流", "媒体流", "断连", "不可达", "无响应", "缓冲区溢出"]):
        return "视频链路断连"
    if "乱序" in text:
        return "网络乱序率过高"
    return text[:32]


def _entity_category_from_diagnosis(diagnosis: models.VideoDiagnosis) -> str:
    node = diagnosis.root_cause_node or ""
    metric = diagnosis.root_cause_metric or ""
    cause_type = diagnosis.root_cause_type or ""
    text = f"{node} {metric} {cause_type}"
    if node == "无":
        return "无"
    if "下行" in text or "客户端" in text:
        return "下行链路"
    if "上行" in text or "接入网络" in text or "链路" in text and "服务器" not in text:
        return "上行链路"
    if "服务器" in text or "CPU" in text or "转码" in text or "网卡缓冲区" in text:
        return "流媒体服务器"
    if "客户端" in text:
        return "客户端"
    return "摄像机"


def _entity_category_from_fault(fault: models.FaultEvent) -> str:
    if fault.entity_type == "server":
        return "流媒体服务器"
    if fault.entity_type == "network_node":
        return "上行链路"
    return "摄像机"


@app.get("/statistics/overview", response_model=schemas.StatisticsOverviewRead)
def get_statistics_overview(
    region_code: str | None = Query(default=None),
    camera_id: str | None = Query(default=None),
    camera_ids: str | None = Query(default=None),
    db: Session = Depends(get_db),
):
    now = datetime.utcnow()
    start_day = (now - timedelta(days=6)).date()
    days = [(start_day + timedelta(days=index)).strftime("%m-%d") for index in range(7)]

    scope = {"type": "all", "code": None, "name": "全部区域"}
    camera_query = db.query(models.Camera)
    region_codes: list[str] | None = None
    scoped_camera_ids: set[str] | None = None

    if camera_ids:
        scoped_camera_ids = {value.strip() for value in camera_ids.split(",") if value.strip()}
        if scoped_camera_ids:
            camera_query = camera_query.filter(models.Camera.id.in_(scoped_camera_ids))
            scope = {"type": "custom_folder", "code": None, "name": f"自定义分区（{len(scoped_camera_ids)}路）"}

    if camera_id:
        camera = db.get(models.Camera, camera_id)
        if not camera:
            raise HTTPException(status_code=404, detail="camera not found")
        region_code = camera.town_code
        scope = {"type": "camera_region", "code": camera.town_code, "name": camera.town_name or camera.name}

    if region_code and not scoped_camera_ids:
        # 【优化】摒弃 _collect_region_descendant_codes
        region = db.get(models.AdministrativeRegion, region_code)
        if region:
            if region.level == "province":
                camera_query = camera_query.filter(models.Camera.province_code == region_code)
            elif region.level == "city":
                camera_query = camera_query.filter(models.Camera.city_code == region_code)
            elif region.level == "county":
                camera_query = camera_query.filter(models.Camera.county_code == region_code)
            else:
                camera_query = camera_query.filter(models.Camera.town_code == region_code)
            scope = {"type": "region", "code": region.region_code, "name": region.region_name}

    cameras = camera_query.all()
    camera_ids = {camera.id for camera in cameras}
    server_ids = {camera.server_id for camera in cameras if camera.server_id}

    stream_query = db.query(models.StreamMedia)
    if region_code or camera_id or scoped_camera_ids:
        stream_query = stream_query.filter(models.StreamMedia.camera_id.in_(camera_ids or {"__none__"}))
    streams = stream_query.all()
    streams_by_id = {stream.id: stream for stream in streams}
    stream_ids = {stream.id for stream in streams}
    server_ids.update(stream.server_id for stream in streams if stream.server_id)
    camera_ids_by_server_id: dict[str, set[str]] = defaultdict(set)
    for camera in cameras:
        if camera.server_id:
            camera_ids_by_server_id[camera.server_id].add(camera.id)

    server_query = db.query(models.Server)
    if region_code or camera_id or scoped_camera_ids:
        server_query = server_query.filter(models.Server.id.in_(server_ids or {"__none__"}))
    servers = server_query.all()
    server_ids = {server.id for server in servers}

    diagnosis_query = db.query(models.VideoDiagnosis)
    if region_code or camera_id or scoped_camera_ids:
        diagnosis_query = diagnosis_query.filter(models.VideoDiagnosis.camera_id.in_(camera_ids or {"__none__"}))
    diagnoses = diagnosis_query.all()

    work_order_query = db.query(models.WorkOrder)
    if region_code or camera_id or scoped_camera_ids:
        work_order_query = work_order_query.filter(
            or_(
                models.WorkOrder.region_code.in_(region_codes or []),
                models.WorkOrder.related_entity_id.in_(camera_ids | server_ids),
            )
        )
    work_orders = work_order_query.all()

    fault_query = db.query(models.FaultEvent)
    if region_code or camera_id or scoped_camera_ids:
        fault_query = fault_query.filter(models.FaultEvent.entity_id.in_(camera_ids | server_ids | stream_ids))
    faults = fault_query.all()

    camera_status = Counter(_status_bucket(camera.status) for camera in cameras)
    server_status = Counter(_status_bucket(server.status) for server in servers)
    stream_status = Counter(
        "offline" if not stream.is_connected else "fault" if stream.is_fault else "normal"
        for stream in streams
    )

    weighted_score = 0.0
    weight_total = 0.0
    for stream in streams:
        weight = max(stream.real_time_bitrate or stream.throughput or 1, 1)
        anomaly_score = _stream_reconstruction_error(stream) * 100
        weighted_score += anomaly_score * weight
        weight_total += weight
    global_anomaly_score = weighted_score / weight_total if weight_total else 0
    global_health = max(0, min(100, 100 - global_anomaly_score))

    total_streams = max(len(streams), 1)
    latest_diagnoses_by_camera: dict[str, models.VideoDiagnosis] = {}
    for diagnosis in diagnoses:
        current = latest_diagnoses_by_camera.get(diagnosis.camera_id)
        if not current or diagnosis.started_at > current.started_at:
            latest_diagnoses_by_camera[diagnosis.camera_id] = diagnosis

    diagnosis_abnormal = Counter(
        diagnosis.abnormal_type
        for diagnosis in latest_diagnoses_by_camera.values()
        if _is_abnormal_diagnosis(diagnosis)
    )
    disconnected_count = len([stream for stream in streams if not stream.is_connected])
    scoped_seed = sum(ord(ch) for ch in "".join(sorted(camera_ids))[:128])
    kqi_ratios = {
        "卡顿": 0.09 + (scoped_seed % 5) * 0.004,
        "拖影": 0.10 + (scoped_seed % 7) * 0.003,
        "花屏": 0.085 + (scoped_seed % 6) * 0.004,
    }
    latency_count = min(len(streams), max(0, round(len(streams) * kqi_ratios["卡顿"])))
    jitter_count = min(len(streams), max(0, round(len(streams) * kqi_ratios["拖影"])))
    flower_count = min(len(streams), max(0, round(len(streams) * kqi_ratios["花屏"])))
    qoe_drop_count = len([stream for stream in streams if stream.is_connected and stream.qoe_score is not None and stream.qoe_score < 75])
    bitrate_drop_count = len([
        stream for stream in streams
        if stream.is_connected
        and not stream.is_fault
        and stream.real_time_bitrate is not None
        and stream.real_time_bitrate < 3.5
    ])
    throughput_drop_count = len([
        stream for stream in streams
        if stream.is_connected
        and stream.throughput is not None
        and stream.throughput < 3.5
    ])
    kqi_degradation = [
        {"name": "画面卡顿", "count": latency_count, "ratio": round(latency_count / total_streams * 100, 2)},
        {"name": "画面拖影", "count": jitter_count, "ratio": round(jitter_count / total_streams * 100, 2)},
        {"name": "画面花屏", "count": flower_count, "ratio": round(flower_count / total_streams * 100, 2)},
        {"name": "流断连", "count": disconnected_count, "ratio": round(disconnected_count / total_streams * 100, 2)},
    ]

    anomaly_camera_ids_by_day: dict[str, set[str]] = {day: set() for day in days}
    for diagnosis in diagnoses:
        if diagnosis.started_at and diagnosis.started_at.date() >= start_day and _is_abnormal_diagnosis(diagnosis):
            key = _date_key(diagnosis.started_at)
            if key in anomaly_camera_ids_by_day and diagnosis.camera_id in camera_ids:
                anomaly_camera_ids_by_day[key].add(diagnosis.camera_id)
    for fault in faults:
        if fault.trigger_time and fault.trigger_time.date() >= start_day:
            key = _date_key(fault.trigger_time)
            if key not in anomaly_camera_ids_by_day:
                continue

            affected_camera_ids: set[str] = set()
            if fault.entity_type == "camera" and fault.entity_id in camera_ids:
                affected_camera_ids.add(fault.entity_id)
            elif fault.entity_type == "server" and fault.entity_id in server_ids:
                affected_camera_ids.update(camera_ids_by_server_id.get(fault.entity_id, set()))
            elif fault.entity_id in stream_ids:
                stream = streams_by_id.get(fault.entity_id)
                if stream and stream.camera_id in camera_ids:
                    affected_camera_ids.add(stream.camera_id)

            anomaly_camera_ids_by_day[key].update(affected_camera_ids)

    today_key = _date_key(now)
    if today_key in anomaly_camera_ids_by_day:
        current_anomaly_camera_ids = {
            camera.id
            for camera in cameras
            if camera.status in {"fault", "offline"}
        }
        current_anomaly_camera_ids.update(
            stream.camera_id
            for stream in streams
            if stream.camera_id in camera_ids and (stream.is_fault or not stream.is_connected)
        )
        anomaly_camera_ids_by_day[today_key].update(current_anomaly_camera_ids)

    scoped_camera_ids = sorted(camera_ids)
    if scoped_camera_ids:
        current_anomaly_count = len(anomaly_camera_ids_by_day.get(today_key, set()))
        simulated_peak = min(len(scoped_camera_ids), max(1, current_anomaly_count))
        simulated_floor = min(100, simulated_peak)
        base_wave = [0.82, 0.58, 0.74, 0.52, 0.9, 0.66, 1.0]
        for index, day in enumerate(days[:-1]):
            if anomaly_camera_ids_by_day[day]:
                continue
            wave_count = round(simulated_peak * base_wave[index])
            simulated_count = min(simulated_peak, max(simulated_floor, wave_count))
            if index > 0 and simulated_peak >= 4 and simulated_count == len(anomaly_camera_ids_by_day[days[index - 1]]):
                simulated_count = min(simulated_peak, simulated_count + (1 if index % 2 == 0 else -1))
                simulated_count = max(simulated_floor, simulated_count)
            anomaly_camera_ids_by_day[day].update(scoped_camera_ids[:simulated_count])

    anomaly_trend = [
        {"date": day, "count": min(len(anomaly_camera_ids_by_day[day]), len(camera_ids))}
        for day in days
    ]
    total_abnormal_count = min(len(anomaly_camera_ids_by_day.get(today_key, set())), len(camera_ids))

    created_by_day = {day: 0 for day in days}
    closed_by_day = {day: 0 for day in days}
    for order in work_orders:
        if order.created_at and order.created_at.date() >= start_day:
            key = _date_key(order.created_at)
            if key in created_by_day:
                created_by_day[key] += 1
        if order.closed_at and order.closed_at.date() >= start_day:
            key = _date_key(order.closed_at)
            if key in closed_by_day:
                closed_by_day[key] += 1
    work_order_trend = [
        {"date": day, "created": created_by_day[day], "resolved": closed_by_day[day]}
        for day in days
    ]

    pattern_counter: Counter[str] = Counter()
    entity_counter: Counter[str] = Counter()
    for diagnosis in diagnoses:
        if _is_abnormal_diagnosis(diagnosis):
            pattern_counter[_representative_pattern(diagnosis.root_cause_metric, diagnosis.abnormal_type)] += 1
            entity = _entity_category_from_diagnosis(diagnosis)
            if entity != "无":
                entity_counter[entity] += 1
    for fault in faults:
        pattern_counter[_representative_pattern(fault.fault_desc, fault.category_l3)] += 1
        entity_counter[_entity_category_from_fault(fault)] += 1

    if disconnected_count:
        pattern_counter["摄像机离线"] += disconnected_count
        entity_counter["摄像机"] += disconnected_count
    if latency_count:
        pattern_counter["端到端时延过高"] += latency_count
        entity_counter["上行链路"] += max(1, round(latency_count * 0.56))
        entity_counter["下行链路"] += max(1, round(latency_count * 0.22))
    if jitter_count:
        pattern_counter["网络抖动与重传"] += jitter_count
        entity_counter["上行链路"] += max(1, round(jitter_count * 0.62))
    if throughput_drop_count:
        pattern_counter["链路吞吐下降"] += throughput_drop_count
        entity_counter["上行链路"] += max(1, round(throughput_drop_count * 0.48))
        entity_counter["流媒体服务器"] += max(1, round(throughput_drop_count * 0.28))
    if qoe_drop_count:
        pattern_counter["视频质量评分偏低"] += qoe_drop_count
        entity_counter["客户端"] += max(1, round(qoe_drop_count * 0.18))
    if flower_count:
        pattern_counter["画面花屏与块状噪声"] += flower_count
        entity_counter["摄像机"] += max(1, round(flower_count * 0.35))
    if bitrate_drop_count:
        pattern_counter["编码码率异常下降"] += bitrate_drop_count
        entity_counter["流媒体服务器"] += max(1, round(bitrate_drop_count * 0.46))

    def distribute_counts(total: int, weighted_items: list[tuple[str, float]]) -> Counter[str]:
        if total <= 0:
            return Counter()
        distributed: Counter[str] = Counter()
        remaining = total
        for index, (name, ratio) in enumerate(weighted_items):
            if index == len(weighted_items) - 1:
                count = remaining
            else:
                count = min(remaining, max(1, round(total * ratio)))
            distributed[name] += count
            remaining -= count
            if remaining <= 0:
                break
        return Counter({name: count for name, count in distributed.items() if count > 0})

    pattern_counter = distribute_counts(
        total_abnormal_count,
        [
            ("摄像机离线", 0.25),
            ("网络抖动与重传", 0.18),
            ("链路吞吐下降", 0.15),
            ("端到端时延过高", 0.13),
            ("视频质量评分偏低", 0.11),
            ("编码码率异常下降", 0.08),
            ("画面花屏与块状噪声", 0.06),
            ("服务器转码负荷偏高", 0.04),
        ],
    )
    entity_counter = distribute_counts(
        total_abnormal_count,
        [
            ("摄像机", 0.37),
            ("上行链路", 0.27),
            ("流媒体服务器", 0.18),
            ("下行链路", 0.12),
            ("客户端", 0.06),
        ],
    )

    closed_orders = [order for order in work_orders if order.closed_at]
    close_rate = (len(closed_orders) / len(work_orders) * 100) if work_orders else 0
    resolve_hours = [
        (order.closed_at - order.created_at).total_seconds() / 3600
        for order in closed_orders
        if order.created_at and order.closed_at and order.closed_at >= order.created_at
    ]
    avg_resolve_hours = sum(resolve_hours) / len(resolve_hours) if resolve_hours else 0

    return {
        "generated_at": now,
        "scope": scope,
        "device_status": {
            "cameras": {
                "normal": camera_status.get("normal", 0),
                "fault": camera_status.get("fault", 0),
                "offline": camera_status.get("offline", 0),
                "total": len(cameras),
            },
            "streams": {
                "normal": stream_status.get("normal", 0),
                "fault": stream_status.get("fault", 0),
                "offline": stream_status.get("offline", 0),
                "total": len(streams),
            },
            "servers": {
                "normal": server_status.get("normal", 0),
                "fault": server_status.get("fault", 0),
                "offline": server_status.get("offline", 0),
                "total": len(servers),
            },
        },
        "golden_metrics": {
            "global_stream_health": round(global_health, 2),
            "global_anomaly_score": round(global_anomaly_score, 2),
            "formula": "全局健康度 = 100 - 加权平均异常分数。异常分数由每条流链路的 reconstruction_error 归一化得到，权重取实时码率/吞吐量。",
            "formula_latex": "全局健康度 = 100 - 加权平均异常分数",
            "sample_count": len(streams),
        },
        "kqi_degradation": kqi_degradation,
        "anomaly_trend": anomaly_trend,
        "work_order_trend": work_order_trend,
        "anomaly_patterns": [
            {"name": name, "count": count}
            for name, count in pattern_counter.most_common(12)
        ],
        "anomaly_entities": [
            {"name": name, "count": count}
            for name, count in entity_counter.most_common(12)
        ],
        "work_order_efficiency": {
            "total": len(work_orders),
            "resolved": len(closed_orders),
            "pending": len([order for order in work_orders if order.status not in {"closed", "cancelled"}]),
            "resolve_rate": round(close_rate, 2),
            "avg_resolve_hours": round(avg_resolve_hours, 2),
        },
    }


# =========================
# DeviceGroup CRUD
# =========================


@app.post("/groups", response_model=schemas.DeviceGroupRead)
def create_group(payload: schemas.DeviceGroupCreate, db: Session = Depends(get_db)):
    if payload.parent_id and not db.get(models.DeviceGroup, payload.parent_id):
        raise HTTPException(status_code=400, detail=f"parent group '{payload.parent_id}' does not exist")

    group_id = str(uuid4())
    new_group = models.DeviceGroup(
        id=group_id,
        name=payload.name,
        parent_id=payload.parent_id,
        sort_order=payload.sort_order,
    )

    if payload.camera_ids:
        cameras = db.query(models.Camera).filter(models.Camera.id.in_(payload.camera_ids)).all()
        if len(cameras) != len(payload.camera_ids):
            raise HTTPException(status_code=400, detail="one or more camera IDs are invalid")
        new_group.cameras.extend(cameras)

    db.add(new_group)
    _commit_or_rollback(db, "failed to create device group")
    db.refresh(new_group)
    return new_group


@app.get("/groups/tree", response_model=list[schemas.DeviceGroupTreeNode])
def get_group_tree(db: Session = Depends(get_db)):
    all_groups = db.query(models.DeviceGroup).order_by(
        models.DeviceGroup.sort_order, models.DeviceGroup.created_at
    ).all()
    group_map: dict[str, schemas.DeviceGroupTreeNode] = {}
    for g in all_groups:
        node = schemas.DeviceGroupTreeNode(
            id=g.id,
            name=g.name,
            parent_id=g.parent_id,
            sort_order=g.sort_order,
            created_at=g.created_at,
            updated_at=g.updated_at,
            cameras=[schemas.CameraRead.model_validate(c) for c in g.cameras],
            camera_count=len(g.cameras),
            children=[],
        )
        group_map[g.id] = node

    roots: list[schemas.DeviceGroupTreeNode] = []
    for g in all_groups:
        node = group_map[g.id]
        if g.parent_id and g.parent_id in group_map:
            group_map[g.parent_id].children.append(node)
        else:
            roots.append(node)
    return roots


@app.get("/groups/{group_id}", response_model=schemas.DeviceGroupRead)
def get_group(group_id: str, db: Session = Depends(get_db)):
    group = db.get(models.DeviceGroup, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="device group not found")
    return group


@app.put("/groups/{group_id}", response_model=schemas.DeviceGroupRead)
def update_group(group_id: str, payload: schemas.DeviceGroupUpdate, db: Session = Depends(get_db)):
    group = db.get(models.DeviceGroup, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="device group not found")

    if payload.parent_id is not None:
        if payload.parent_id == group_id:
            raise HTTPException(status_code=400, detail="group cannot be its own parent")
        if payload.parent_id and not db.get(models.DeviceGroup, payload.parent_id):
            raise HTTPException(status_code=400, detail=f"parent group '{payload.parent_id}' does not exist")

    update_data = payload.model_dump(exclude_unset=True, exclude={"camera_ids"})
    _apply_update(group, update_data)

    if payload.camera_ids is not None:
        cameras = db.query(models.Camera).filter(models.Camera.id.in_(payload.camera_ids)).all()
        if len(cameras) != len(payload.camera_ids):
            raise HTTPException(status_code=400, detail="one or more camera IDs are invalid")
        group.cameras.clear()
        group.cameras.extend(cameras)

    _commit_or_rollback(db, "failed to update device group")
    db.refresh(group)
    return group


@app.delete("/groups/{group_id}")
def delete_group(group_id: str, db: Session = Depends(get_db)):
    group = db.get(models.DeviceGroup, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="device group not found")
    db.delete(group)
    _commit_or_rollback(db, "failed to delete device group")
    return {"message": f"group '{group_id}' deleted"}
