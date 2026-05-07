from __future__ import annotations

import argparse
import math
import os
import random
import time
from datetime import datetime, timedelta
from typing import Any

import requests

from database import SessionLocal
import models


AMAP_PLACE_TEXT_URL = "https://restapi.amap.com/v3/place/text"

PROVINCE_CODE = "350000"
CITY_CODE = "350200"
COUNTY_CODE = "350206"

DEFAULT_COUNT = 1000
OFFLINE_RATIO = 0.20
ONLINE_FAULT_RATIO = 0.10

random.seed(20260501)


POI_KEYWORDS = [
    "学校",
    "医院",
    "商场",
    "小区",
    "公园",
    "地铁站",
    "公交站",
    "写字楼",
    "市场",
    "社区",
    "道路",
    "路口",
    "派出所",
    "银行",
    "酒店",
]


CAMERA_SCENES = [
    "出入口监控",
    "道路监控",
    "周界监控",
    "人流监控",
    "车辆监控",
    "治安监控",
    "广场监控",
    "路口监控",
]


SERVER_ANCHORS = [
    {
        "id": "srv-huli-001",
        "name": "湖里区政务边缘节点-01",
        "keyword": "厦门市湖里区人民政府",
        "fallback": (118.1457, 24.5122),
    },
    {
        "id": "srv-huli-002",
        "name": "高崎机场边缘节点-02",
        "keyword": "厦门高崎国际机场",
        "fallback": (118.1277, 24.5440),
    },
    {
        "id": "srv-huli-003",
        "name": "枋湖交通枢纽边缘节点-03",
        "keyword": "厦门枋湖客运中心",
        "fallback": (118.1521, 24.5235),
    },
    {
        "id": "srv-huli-004",
        "name": "江头商圈边缘节点-04",
        "keyword": "厦门SM城市广场",
        "fallback": (118.1258, 24.4966),
    },
    {
        "id": "srv-huli-005",
        "name": "五缘湾边缘节点-05",
        "keyword": "厦门五缘湾湿地公园",
        "fallback": (118.1782, 24.5317),
    },
]


def truncate(text: str, max_len: int) -> str:
    if len(text) <= max_len:
        return text
    return text[: max_len - 1]


def parse_location(location: str | None) -> tuple[float, float] | None:
    if not location or "," not in location:
        return None

    lon_str, lat_str = location.split(",", 1)
    return float(lon_str), float(lat_str)


def jitter_location(lon: float, lat: float, max_meter: float = 35.0) -> tuple[float, float]:
    """
    给同一个 POI 下的多路摄像机增加一点点扰动，避免坐标完全重叠。
    """
    distance = random.uniform(0, max_meter)
    angle = random.uniform(0, 2 * math.pi)

    delta_lat = (distance * math.sin(angle)) / 111_320
    delta_lon = (distance * math.cos(angle)) / (111_320 * math.cos(math.radians(lat)))

    return round(lon + delta_lon, 7), round(lat + delta_lat, 7)


def haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    radius = 6371.0

    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)

    a = (
        math.sin(d_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    )

    return radius * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def amap_place_search(
    *,
    key: str,
    keywords: str,
    city: str = "厦门",
    page: int = 1,
    offset: int = 25,
    timeout: int = 20,
) -> dict[str, Any]:
    params = {
        "key": key,
        "keywords": keywords,
        "city": city,
        "citylimit": "true",
        "offset": offset,
        "page": page,
        "extensions": "base",
        "output": "JSON",
    }

    resp = requests.get(AMAP_PLACE_TEXT_URL, params=params, timeout=timeout)
    resp.raise_for_status()

    data = resp.json()

    if data.get("status") != "1":
        raise RuntimeError(
            f"高德 POI 查询失败: keywords={keywords}, "
            f"info={data.get('info')}, infocode={data.get('infocode')}"
        )

    return data


def search_pois_for_town(
    *,
    key: str,
    town_name: str,
    page_count: int,
    sleep_seconds: float,
) -> list[dict[str, Any]]:
    """
    按街道 + 多类关键词搜索真实 POI。
    """
    pois: list[dict[str, Any]] = []
    seen: set[str] = set()

    for word in POI_KEYWORDS:
        query = f"厦门市湖里区{town_name}{word}"

        for page in range(1, page_count + 1):
            try:
                data = amap_place_search(
                    key=key,
                    keywords=query,
                    city="厦门",
                    page=page,
                    offset=25,
                )
            except Exception as exc:
                print(f"POI 查询失败，跳过: {query}, page={page}, error={exc}")
                continue

            for item in data.get("pois", []):
                name = item.get("name") or ""
                address = item.get("address") or ""
                location = item.get("location") or ""
                adname = item.get("adname") or ""

                parsed = parse_location(location)
                if not parsed:
                    continue

                # 尽量限制在湖里区，避免搜索结果跑到厦门其他区。
                full_text = f"{name}{address}{adname}"
                if "湖里" not in full_text and "厦门" not in full_text:
                    continue

                unique_key = item.get("id") or f"{name}-{location}"
                if unique_key in seen:
                    continue

                seen.add(unique_key)

                lon, lat = parsed
                pois.append(
                    {
                        "name": name,
                        "address": address if isinstance(address, str) else "",
                        "location": location,
                        "longitude": lon,
                        "latitude": lat,
                        "adname": adname,
                        "keyword": query,
                    }
                )

            time.sleep(sleep_seconds)

    return pois


def search_one_poi(
    *,
    key: str,
    keyword: str,
    fallback: tuple[float, float],
    sleep_seconds: float,
) -> tuple[float, float, str]:
    try:
        data = amap_place_search(
            key=key,
            keywords=keyword,
            city="厦门",
            page=1,
            offset=10,
        )

        pois = data.get("pois", [])
        for item in pois:
            parsed = parse_location(item.get("location"))
            if parsed:
                time.sleep(sleep_seconds)
                return parsed[0], parsed[1], item.get("address") or keyword

    except Exception as exc:
        print(f"服务器锚点 POI 查询失败，使用 fallback: {keyword}, error={exc}")

    return fallback[0], fallback[1], keyword


def reset_business_tables(db) -> None:
    """
    清空业务表，但不清空 administrative_region。
    """
    db.query(models.RootCause).delete()
    db.query(models.FaultEvent).delete()
    db.query(models.TopologyLink).delete()
    db.query(models.StreamMedia).delete()
    db.query(models.Camera).delete()
    db.query(models.NetworkNode).delete()
    db.query(models.Server).delete()
    db.commit()


def get_huli_regions(db):
    province = db.get(models.AdministrativeRegion, PROVINCE_CODE)
    city = db.get(models.AdministrativeRegion, CITY_CODE)
    county = db.get(models.AdministrativeRegion, COUNTY_CODE)

    if not province:
        raise RuntimeError("没有找到福建省 350000，请确认全国行政区已经导入。")
    if not city:
        raise RuntimeError("没有找到厦门市 350200，请确认全国行政区已经导入。")
    if not county:
        raise RuntimeError("没有找到湖里区 350206，请确认全国行政区已经导入。")

    towns = (
        db.query(models.AdministrativeRegion)
        .filter(models.AdministrativeRegion.parent_code == county.region_code)
        .filter(models.AdministrativeRegion.level == "town")
        .order_by(models.AdministrativeRegion.sort_order, models.AdministrativeRegion.region_code)
        .all()
    )

    if not towns:
        raise RuntimeError("湖里区下面没有找到街道数据，请检查 administrative_region。")

    return province, city, county, towns


def seed_servers(db, key: str, sleep_seconds: float) -> list[models.Server]:
    now = datetime.now()
    servers: list[models.Server] = []

    for index, anchor in enumerate(SERVER_ANCHORS, start=1):
        lon, lat, address = search_one_poi(
            key=key,
            keyword=anchor["keyword"],
            fallback=anchor["fallback"],
            sleep_seconds=sleep_seconds,
        )

        server = models.Server(
            id=anchor["id"],
            name=anchor["name"],
            ip=f"10.35.206.{10 + index}",
            node_type="stream_server",
            status="normal",
            location_desc=truncate(address, 255),
            longitude=lon,
            latitude=lat,
            cpu_usage=round(random.uniform(25, 70), 2),
            ram_usage=round(random.uniform(35, 75), 2),
            disk_usage=round(random.uniform(30, 80), 2),
            net_bandwidth=round(random.uniform(35, 85), 2),
            gpu_usage=round(random.uniform(5, 45), 2),
            last_heartbeat=now,
        )

        servers.append(server)

    db.add_all(servers)
    db.commit()

    print("服务器写入完成:")
    for server in servers:
        print(f"  {server.id} {server.name} ({server.longitude}, {server.latitude})")

    return servers


def nearest_server(
    *,
    lon: float,
    lat: float,
    servers: list[models.Server],
) -> models.Server:
    return min(
        servers,
        key=lambda server: haversine_km(
            lon,
            lat,
            float(server.longitude),
            float(server.latitude),
        ),
    )


def allocate_counts(total: int, buckets: int) -> list[int]:
    base = total // buckets
    remain = total % buckets
    result = [base for _ in range(buckets)]

    for i in range(remain):
        result[i] += 1

    random.shuffle(result)
    return result


def collect_pois_by_town(
    *,
    key: str,
    towns: list[models.AdministrativeRegion],
    page_count: int,
    sleep_seconds: float,
) -> dict[str, list[dict[str, Any]]]:
    pois_by_town: dict[str, list[dict[str, Any]]] = {}

    for town in towns:
        print(f"开始获取 POI: {town.region_name}")

        pois = search_pois_for_town(
            key=key,
            town_name=town.region_name,
            page_count=page_count,
            sleep_seconds=sleep_seconds,
        )

        print(f"  {town.region_name}: 获取到 {len(pois)} 个 POI")

        if not pois:
            # 兜底：至少用街道名生成一个点，防止整个街道没有数据。
            print(f"  警告：{town.region_name} 没有查到 POI，将使用湖里区附近 fallback 点")
            pois = [
                {
                    "name": f"{town.region_name}街道办事处",
                    "address": f"厦门市湖里区{town.region_name}",
                    "longitude": 118.1457 + random.uniform(-0.03, 0.03),
                    "latitude": 24.5122 + random.uniform(-0.03, 0.03),
                    "adname": "湖里区",
                    "keyword": town.region_name,
                }
            ]

        pois_by_town[town.region_code] = pois

    return pois_by_town


def choose_camera_status(index: int, offline_set: set[int], fault_set: set[int]) -> str:
    if index in offline_set:
        return "offline"
    if index in fault_set:
        return "fault"
    return "online"


def make_stream_metrics(status: str) -> dict[str, Any]:
    if status == "offline":
        return {
            "is_connected": False,
            "is_fault": True,
            "real_time_bitrate": 0.0,
            "throughput": 0.0,
            "latency": 999.0,
            "jitter": 0.0,
            "packet_loss_rate": 100.0,
            "qoe_score": 0.0,
        }

    if status == "fault":
        latency = round(random.uniform(150, 360), 2)
        packet_loss = round(random.uniform(2.0, 8.0), 3)
        qoe = round(random.uniform(45, 75), 1)

        return {
            "is_connected": True,
            "is_fault": True,
            "real_time_bitrate": round(random.uniform(0.5, 3.0), 2),
            "throughput": round(random.uniform(0.3, 3.5), 2),
            "latency": latency,
            "jitter": round(random.uniform(25, 80), 2),
            "packet_loss_rate": packet_loss,
            "qoe_score": qoe,
        }

    return {
        "is_connected": True,
        "is_fault": False,
        "real_time_bitrate": round(random.uniform(2.0, 8.0), 2),
        "throughput": round(random.uniform(3.0, 12.0), 2),
        "latency": round(random.uniform(20, 90), 2),
        "jitter": round(random.uniform(1, 20), 2),
        "packet_loss_rate": round(random.uniform(0.0, 0.5), 3),
        "qoe_score": round(random.uniform(86, 99), 1),
    }


def seed_cameras_and_streams(
    db,
    *,
    count: int,
    province: models.AdministrativeRegion,
    city: models.AdministrativeRegion,
    county: models.AdministrativeRegion,
    towns: list[models.AdministrativeRegion],
    pois_by_town: dict[str, list[dict[str, Any]]],
    servers: list[models.Server],
) -> tuple[list[models.Camera], list[models.StreamMedia]]:
    now = datetime.now()

    offline_count = int(count * OFFLINE_RATIO)
    online_fault_count = int(count * ONLINE_FAULT_RATIO)

    all_indices = list(range(1, count + 1))
    random.shuffle(all_indices)

    offline_set = set(all_indices[:offline_count])
    fault_set = set(all_indices[offline_count : offline_count + online_fault_count])

    town_counts = allocate_counts(count, len(towns))

    cameras: list[models.Camera] = []
    streams: list[models.StreamMedia] = []

    vendors = ["海康威视", "大华", "宇视", "天地伟业"]
    models_list = ["DS-2CD3T46", "IPC-HFW4433", "IPC-B12", "SmartCam-X1", "DS-2CD7A47"]
    codecs = ["H.264", "H.264", "H.265", "H.265", "VP9"]
    access_types = ["Ethernet", "Ethernet", "Wi-Fi", "4G", "5G"]

    global_index = 1

    for town, town_count in zip(towns, town_counts):
        pois = pois_by_town[town.region_code]

        for _ in range(town_count):
            poi = random.choice(pois)

            lon, lat = jitter_location(
                float(poi["longitude"]),
                float(poi["latitude"]),
                max_meter=45,
            )

            server = nearest_server(lon=lon, lat=lat, servers=servers)

            status = choose_camera_status(global_index, offline_set, fault_set)

            scene = random.choice(CAMERA_SCENES)
            poi_name = poi["name"] or town.region_name
            camera_name = truncate(
                f"{town.region_name}-{poi_name}-{scene}-{global_index:04d}",
                128,
            )

            ip_second = 10 + global_index // 250
            ip_last = global_index % 250 + 1

            last_heartbeat = now - timedelta(minutes=random.randint(0, 20))
            if status == "offline":
                last_heartbeat = now - timedelta(hours=random.randint(2, 48))

            camera = models.Camera(
                id=f"cam-huli-{global_index:04d}",
                name=camera_name,
                model=random.choice(models_list),
                vendor=random.choice(vendors),
                ip=f"10.206.{ip_second}.{ip_last}",
                status=status,
                protocol=random.choice(["RTSP", "GB28181", "RTSP"]),
                codec=random.choice(codecs),
                stream_type=random.choice(["main", "main", "sub"]),
                access_type=random.choice(access_types),
                unit=random.choice(["湖里区公安分局", "湖里区城管局", "湖里区应急管理局", "湖里区交通管理部门"]),
                manager=random.choice(["张工", "李工", "王工", "陈工", "林工"]),
                province_code=province.region_code,
                province_name=province.region_name,
                city_code=city.region_code,
                city_name=city.region_name,
                county_code=county.region_code,
                county_name=county.region_name,
                town_code=town.region_code,
                town_name=town.region_name,
                location_desc=truncate(
                    f"{province.region_name}{city.region_name}{county.region_name}{town.region_name}"
                    f"{poi.get('address') or poi_name}",
                    255,
                ),
                longitude=lon,
                latitude=lat,
                server_id=server.id,
                video_url=f"rtsp://example.com/huli/cam-huli-{global_index:04d}",
                last_heartbeat=last_heartbeat,
            )

            metrics = make_stream_metrics(status)

            stream = models.StreamMedia(
                id=f"stream-huli-{global_index:04d}",
                source_ip=camera.ip,
                source_port=5000 + global_index,
                destination_ip=server.ip,
                destination_port=8000 + global_index,
                ssrc=f"huli-ssrc-{100000 + global_index}",
                camera_id=camera.id,
                server_id=server.id,
                codec=camera.codec,
                resolution=random.choice(["1280x720", "1920x1080", "2560x1440"]),
                frame_rate=random.choice([25.0, 30.0, 30.0, 60.0]),
                real_time_bitrate=metrics["real_time_bitrate"],
                throughput=metrics["throughput"],
                latency=metrics["latency"],
                jitter=metrics["jitter"],
                packet_loss_rate=metrics["packet_loss_rate"],
                qoe_score=metrics["qoe_score"],
                transport_protocol=random.choice(["TCP", "UDP", "RTP"]),
                is_connected=metrics["is_connected"],
                is_fault=metrics["is_fault"],
                link_type=random.choice(["rtsp_pull", "rtp_push", "gb28181"]),
                stream_type=camera.stream_type,
                last_update_time=now,
            )

            cameras.append(camera)
            streams.append(stream)

            global_index += 1

    db.add_all(cameras)
    db.add_all(streams)
    db.commit()

    return cameras, streams


def seed_faults_and_root_causes(
    db,
    *,
    cameras: list[models.Camera],
    streams: list[models.StreamMedia],
) -> None:
    now = datetime.now()

    stream_map = {stream.camera_id: stream for stream in streams}

    fault_events: list[models.FaultEvent] = []
    root_causes: list[models.RootCause] = []

    fault_index = 1

    for camera in cameras:
        if camera.status not in {"offline", "fault"}:
            continue

        stream = stream_map[camera.id]

        if camera.status == "offline":
            title = f"{camera.name}离线"
            fault_code = "CAMERA_OFFLINE"
            category_l1 = "设备状态异常"
            category_l2 = "设备离线"
            category_l3 = "摄像机心跳中断"
            fault_desc = "摄像机心跳长时间未上报，疑似离线。"
            level = random.choice(["major", "critical"])
            metrics_snapshot = {
                "is_connected": False,
                "packet_loss_rate": 100.0,
                "qoe_score": 0.0,
                "last_heartbeat": camera.last_heartbeat.isoformat() if camera.last_heartbeat else None,
            }
            repair = "检查摄像机供电、接入交换机端口和现场网络链路。"
            root_desc = "摄像机离线，可能由供电中断、网络断连或设备异常导致。"
        else:
            issue = random.choice(["packet_loss", "latency", "qoe"])

            if issue == "packet_loss":
                fault_code = "STREAM_PACKET_LOSS_HIGH"
                category_l2 = "丢包异常"
                category_l3 = "上行链路丢包"
                fault_desc = "摄像机在线视频流丢包率过高，可能导致画面卡顿或花屏。"
            elif issue == "latency":
                fault_code = "STREAM_LATENCY_HIGH"
                category_l2 = "时延异常"
                category_l3 = "链路时延升高"
                fault_desc = "摄像机在线视频流时延过高，实时预览体验下降。"
            else:
                fault_code = "STREAM_QOE_LOW"
                category_l2 = "视频质量异常"
                category_l3 = "QoE评分过低"
                fault_desc = "摄像机在线但视频质量评分偏低，需要排查链路和码流参数。"

            title = f"{camera.name}{category_l2}"
            category_l1 = "视频质量异常"
            level = random.choice(["minor", "major", "major"])
            metrics_snapshot = {
                "is_connected": True,
                "latency": stream.latency,
                "jitter": stream.jitter,
                "packet_loss_rate": stream.packet_loss_rate,
                "qoe_score": stream.qoe_score,
                "throughput": stream.throughput,
            }
            repair = "检查摄像机上行链路质量，必要时临时降低码率或迁移接入服务器。"
            root_desc = "摄像机仍在线，但视频流质量异常，主要表现为丢包、时延或QoE下降。"

        trigger_time = now - timedelta(minutes=random.randint(5, 720))

        event = models.FaultEvent(
            id=f"fault-huli-{fault_index:04d}",
            title=truncate(title, 128),
            entity_id=camera.id,
            entity_type="camera",
            category_l1=category_l1,
            category_l2=category_l2,
            category_l3=category_l3,
            fault_code=fault_code,
            fault_desc=fault_desc,
            level=level,
            status=random.choice(["pending", "processing"]),
            confidence=round(random.uniform(0.75, 0.98), 2),
            trigger_time=trigger_time,
            end_time=None,
            handler=random.choice(["张工", "李工", "王工", "陈工", None]),
            ack_time=trigger_time + timedelta(minutes=random.randint(1, 20)),
            resolved_by=None,
            metrics_snapshot=metrics_snapshot,
            repair_strategy={
                "suggestion": repair,
                "priority": level,
            },
        )

        root_cause = models.RootCause(
            id=f"rc-huli-{fault_index:04d}",
            description=root_desc,
            fault_event_id=event.id,
            device_type="camera",
        )

        fault_events.append(event)
        root_causes.append(root_cause)

        fault_index += 1

    db.add_all(fault_events)
    db.commit()

    db.add_all(root_causes)
    db.commit()

    print(f"故障事件写入完成: {len(fault_events)} 条")


def seed_topology_links(
    db,
    *,
    cameras: list[models.Camera],
    servers: list[models.Server],
) -> None:
    links: list[models.TopologyLink] = []

    server_map = {server.id: server for server in servers}

    for index, camera in enumerate(cameras, start=1):
        server = server_map[camera.server_id]

        distance = haversine_km(
            float(camera.longitude),
            float(camera.latitude),
            float(server.longitude),
            float(server.latitude),
        )

        status = "normal"
        if camera.status == "offline":
            status = "offline"
        elif camera.status == "fault":
            status = "warning"

        links.append(
            models.TopologyLink(
                id=f"topo-huli-{index:04d}",
                source_type="camera",
                source_id=camera.id,
                target_type="server",
                target_id=server.id,
                link_type="nearest_access",
                status=status,
                bandwidth_usage=round(random.uniform(5, 90), 2),
                latency=round(distance * random.uniform(1.5, 4.0) + random.uniform(5, 20), 2),
                packet_loss_rate=0.0 if status == "normal" else round(random.uniform(1.0, 5.0), 3),
            )
        )

    db.add_all(links)
    db.commit()

    print(f"拓扑连线写入完成: {len(links)} 条")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=DEFAULT_COUNT)
    parser.add_argument("--reset-business", action="store_true")
    parser.add_argument("--poi-pages", type=int, default=2)
    parser.add_argument("--sleep", type=float, default=0.15)

    args = parser.parse_args()

    key = os.getenv("AMAP_KEY")
    if not key:
        raise RuntimeError("请先设置环境变量 AMAP_KEY=你的高德 Web 服务 Key")

    db = SessionLocal()

    try:
        if args.reset_business:
            print("开始清空业务表，不会清空 administrative_region...")
            reset_business_tables(db)

        print("读取福建省 / 厦门市 / 湖里区行政区...")
        province, city, county, towns = get_huli_regions(db)

        print("湖里区街道:")
        for town in towns:
            print(f"  {town.region_name} {town.region_code}")

        print("开始获取湖里区各街道 POI...")
        pois_by_town = collect_pois_by_town(
            key=key,
            towns=towns,
            page_count=args.poi_pages,
            sleep_seconds=args.sleep,
        )

        print("开始写入 5 台服务器...")
        servers = seed_servers(db, key, args.sleep)

        print(f"开始写入 {args.count} 路摄像机和流媒体链路...")
        cameras, streams = seed_cameras_and_streams(
            db,
            count=args.count,
            province=province,
            city=city,
            county=county,
            towns=towns,
            pois_by_town=pois_by_town,
            servers=servers,
        )

        print("开始写入故障事件和根因...")
        seed_faults_and_root_causes(
            db,
            cameras=cameras,
            streams=streams,
        )

        print("开始写入拓扑连线...")
        seed_topology_links(
            db,
            cameras=cameras,
            servers=servers,
        )

        offline_count = len([camera for camera in cameras if camera.status == "offline"])
        fault_count = len([camera for camera in cameras if camera.status == "fault"])
        online_count = len([camera for camera in cameras if camera.status == "online"])

        print("湖里区摄像机 seed 完成！")
        print(f"  摄像机总数: {len(cameras)}")
        print(f"  在线正常: {online_count}")
        print(f"  离线: {offline_count}")
        print(f"  在线故障: {fault_count}")

    finally:
        db.close()


if __name__ == "__main__":
    main()
