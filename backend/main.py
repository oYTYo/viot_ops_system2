from __future__ import annotations

from collections import defaultdict
from random import randint
from pathlib import Path
from datetime import datetime, timedelta
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import models
import schemas
from database import SessionLocal, engine


app = FastAPI(title="VIoT Ops Backend API", version="0.1.0")

BASE_DIR = Path(__file__).resolve().parent
VIDEOS_DIR = BASE_DIR / "videos"
NORMAL_VIDEO_NAME = "normal.mp4"
ANOMALY_VIDEO_NAME = "anomaly.mp4"

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


def get_db():
    db = SessionLocal()
    try:
        yield db
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
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=2000, ge=1, le=5000),
    db: Session = Depends(get_db),
):
    """
    左侧导航树加载某个行政区下的摄像机。
    主要在乡级行政区展开时调用。
    """
    region = _get_region_or_404(db, region_code)

    if region.level == "town":
        query = db.query(models.Camera).filter(models.Camera.town_code == region_code)
    else:
        region_codes = _collect_region_descendant_codes(db, region_code)
        query = db.query(models.Camera).filter(models.Camera.town_code.in_(region_codes))

    db_status = _camera_db_status_from_filter(status_filter)
    if db_status:
        query = query.filter(models.Camera.status == db_status)

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
        query.order_by(models.Camera.status, models.Camera.name, models.Camera.id)
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

    return query.offset(skip).limit(limit).all()


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
    limit: int = Query(default=100, ge=1, le=1000),
    region_code: str | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    keyword: str | None = None,
    db: Session = Depends(get_db),
):
    query = db.query(models.Camera)

    if region_code:
        region_codes = _collect_region_descendant_codes(db, region_code)
        query = query.filter(models.Camera.town_code.in_(region_codes))

    if status_filter:
        query = query.filter(models.Camera.status == status_filter)

    if keyword:
        keyword_like = f"%{keyword}%"
        query = query.filter(
            (models.Camera.name.like(keyword_like))
            | (models.Camera.ip.like(keyword_like))
            | (models.Camera.location_desc.like(keyword_like))
        )

    return query.offset(skip).limit(limit).all()


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

    video_name = ANOMALY_VIDEO_NAME if camera.status == "fault" else NORMAL_VIDEO_NAME
    video_path = VIDEOS_DIR / video_name
    if not video_path.exists():
        raise HTTPException(status_code=404, detail=f"preview video '{video_name}' not found")

    return {
        "camera_id": camera.id,
        "camera_name": camera.name,
        "play_url": f"/videos/{video_name}",
        "start_time": randint(0, 45),
    }


@app.put("/cameras/{camera_id}", response_model=schemas.CameraRead)
def update_camera(camera_id: str, payload: schemas.CameraUpdate, db: Session = Depends(get_db)):
    obj = db.get(models.Camera, camera_id)
    if not obj:
        raise HTTPException(status_code=404, detail="camera not found")

    update_data = payload.model_dump(exclude_unset=True)

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
    limit: int = Query(default=100, ge=1, le=1000),
    camera_id: str | None = None,
    server_id: str | None = None,
    is_fault: bool | None = None,
    is_connected: bool | None = None,
    db: Session = Depends(get_db),
):
    query = db.query(models.StreamMedia)

    if camera_id:
        query = query.filter(models.StreamMedia.camera_id == camera_id)

    if server_id:
        query = query.filter(models.StreamMedia.server_id == server_id)

    if is_fault is not None:
        query = query.filter(models.StreamMedia.is_fault == is_fault)

    if is_connected is not None:
        query = query.filter(models.StreamMedia.is_connected == is_connected)

    return query.offset(skip).limit(limit).all()


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


def _diagnosis_profile(camera: models.Camera) -> dict[str, Any]:
    server_name = camera.server_id or "流媒体服务器"

    if camera.status == "offline":
        return {
            "health_score": 0,
            "business_status": "断连",
            "abnormal_type": "断连",
            "root_cause_type": "网络链路异常",
            "root_cause_node": camera.name,
            "root_cause_metric": "ICMP 不可达，设备无响应",
            "conclusion": "摄像机不可达，视频业务中断。",
            "suggestion": "请运维人员优先核对设备 IP、供电状态、接入交换机端口和现场网线连接。",
            "ping_output": f"PING {camera.ip}: request timeout\nPING {camera.ip}: destination host unreachable\n--- {camera.ip} ping statistics ---\n4 packets transmitted, 0 received, 100% packet loss",
            "steps": [
                {"index": 1, "title": "读取设备 IP", "status": "done", "description": f"设备 IP：{camera.ip}，开始网络 Ping 探测。"},
                {"index": 2, "title": "Ping 连通性检测", "status": "failed", "description": "设备 ping 不到，基础网络不可达，诊断流程提前结束。"},
            ],
        }

    fault_profiles = [
        ("拖影", "服务器节点异常", server_name, "转码负荷过高，CPU 利用率 > 95%", 75, "画面轻微拖影"),
        ("卡顿", "网络链路异常", "接入网络链路", "高抖动 42ms，频繁重传，吞吐量下降 38%", 68, "视频明显卡顿"),
        ("花屏", "网络链路异常", "摄像机上行链路", "乱序率高，关键帧丢失，丢包率 6.8%", 62, "画面局部花屏"),
        ("断连", "服务器节点异常", server_name, "网卡缓冲区溢出，服务进程短时无响应", 48, "链路间歇断连"),
    ]
    abnormal_type, cause_type, cause_node, cause_metric, score, business_status = fault_profiles[
        sum(ord(ch) for ch in camera.id) % len(fault_profiles)
    ]

    if camera.status != "fault":
        abnormal_type, cause_type, cause_node, cause_metric, score, business_status = (
            "无明显异常",
            "未发现关键瓶颈",
            "无",
            "关键指标处于正常阈值内",
            92,
            "视频业务健康",
        )

    return {
        "health_score": score,
        "business_status": business_status,
        "abnormal_type": abnormal_type,
        "root_cause_type": cause_type,
        "root_cause_node": cause_node,
        "root_cause_metric": cause_metric,
        "conclusion": f"健康度 {score} 分，{business_status}。",
        "suggestion": (
            "当前视频传输状态良好，链路健康。"
            if score >= 80
            else (
                "建议迁移部分转码任务、检查服务器 CPU 与网卡队列，并复测流媒体服务。"
                if cause_type == "服务器节点异常"
                else "建议检查摄像机上行链路、交换机端口错误包、丢包和抖动，并复测端到端吞吐。"
            )
        ),
        "ping_output": f"PING {camera.ip}: 56 data bytes\n64 bytes from {camera.ip}: icmp_seq=1 ttl=63 time=6.8 ms\n64 bytes from {camera.ip}: icmp_seq=2 ttl=63 time=7.1 ms\n64 bytes from {camera.ip}: icmp_seq=3 ttl=63 time=6.5 ms\n--- {camera.ip} ping statistics ---\n3 packets transmitted, 3 received, 0% packet loss",
        "steps": [
            {"index": 1, "title": "读取设备 IP", "status": "done", "description": f"设备 IP：{camera.ip}，开始网络 Ping 探测。"},
            {"index": 2, "title": "Ping 连通性检测", "status": "done", "description": "Ping 可达，基础网络连通，继续采集链路上下游状态。"},
            {"index": 3, "title": "获取拓扑信息", "status": "done", "description": "摄像机 → 网络节点 → 流媒体服务器 → 客户端，正在采集全链路指标。"},
            {"index": 4, "title": "启动异常检测算法", "status": "done", "description": f"识别为：{business_status}，根因指向：{cause_node}。"},
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
    return (
        f"诊断时间：{diagnosis.started_at:%Y-%m-%d %H:%M:%S}；"
        f"健康度：{diagnosis.health_score}分；"
        f"业务状态：{diagnosis.business_status}；"
        f"异常类型：{diagnosis.abnormal_type}；"
        f"根因位置：{diagnosis.root_cause_node}；"
        f"核心指标：{diagnosis.root_cause_metric}；"
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
        order.last_action = f"视频诊断更新：{diagnosis.business_status}，健康度 {diagnosis.health_score} 分"
        _append_work_order_timeline(order, "视频诊断更新", "视频诊断", description)
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
        "creator": "视频诊断",
        "sla_deadline": now + timedelta(hours=2 if priority == "urgent" else 8),
        "last_action": f"视频诊断自动生成：{diagnosis.business_status}，健康度 {diagnosis.health_score} 分",
        "timeline": [],
    }
    _hydrate_work_order_context(db, data)
    order = models.WorkOrder(**data)
    _append_work_order_timeline(order, "视频诊断自动生成工单", "视频诊断", description)
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
    ended_at = started_at + timedelta(seconds=randint(8, 16))

    obj = models.VideoDiagnosis(
        id=_make_video_diagnosis_id(camera.id),
        camera_id=camera.id,
        camera_name=camera.name,
        camera_status=camera.status,
        started_at=started_at,
        ended_at=ended_at,
        topology=_build_diagnosis_topology(camera, profile),
        **profile,
    )
    db.add(obj)
    db.flush()
    work_order_id = _sync_video_diagnosis_work_order(db, camera, obj)
    _commit_or_rollback(db, "failed to create video diagnosis: constraint violation")
    db.refresh(obj)
    obj.work_order_id = work_order_id
    return obj


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
