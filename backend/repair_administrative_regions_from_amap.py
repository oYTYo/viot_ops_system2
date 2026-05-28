from __future__ import annotations

import argparse
import hashlib
import os
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import pymysql
import requests


AMAP_DISTRICT_URL = "https://restapi.amap.com/v3/config/district"

AMAP_LEVEL_TO_SYSTEM_LEVEL = {
    "province": "province",
    "city": "city",
    "district": "county",
    "street": "town",
}

LEVELS = ("province", "city", "county", "town")

SUSPICIOUS_TOKENS = (
    "鍖",
    "娴",
    "溿",
    "倝",
    "鐞",
    "鐪",
    "閸",
    "闂",
    "绋",
    "妲",
    "缂",
    "�",
    "?",
)


@dataclass(frozen=True)
class RepairPlan:
    upserts: list[dict[str, Any]]
    updates: list[dict[str, Any]]
    skipped: list[str]
    conflicts: list[str]


def _short_hash(text: str, length: int = 10) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:length]


def _make_town_code(parent_code: str, name: str, amap_adcode: str | None) -> str:
    return f"{parent_code}-T-{_short_hash(f'{parent_code}:{name}:{amap_adcode or ''}')}"


def _clean_citycode(value: Any) -> str | None:
    if isinstance(value, list):
        return None
    if value in (None, ""):
        return None
    return str(value)


def _system_level(amap_level: str) -> str:
    level = AMAP_LEVEL_TO_SYSTEM_LEVEL.get(amap_level)
    if not level:
        raise ValueError(f"不支持的高德行政区层级: {amap_level}")
    return level


def _region_payload(
    item: dict[str, Any],
    *,
    level: str,
    parent_code: str | None,
    sort_order: int,
    existing: dict[str, Any] | None,
    source_version: str,
) -> dict[str, Any]:
    name = str(item.get("name") or "").strip()
    amap_adcode = str(item.get("adcode") or "").strip() or None
    amap_citycode = _clean_citycode(item.get("citycode"))

    if not name:
        raise ValueError(f"行政区名称为空: {item}")

    if level in {"province", "city", "county"}:
        if not amap_adcode:
            raise ValueError(f"{level} 缺少 adcode: {item}")
        region_code = amap_adcode
        official_code = amap_adcode
    elif level == "town":
        if not parent_code:
            raise ValueError(f"乡镇/街道缺少 parent_code: {item}")
        region_code = (
            str(existing["region_code"])
            if existing is not None
            else _make_town_code(parent_code, name, amap_adcode)
        )
        official_code = None
    else:
        raise ValueError(f"不支持的系统层级: {level}")

    return {
        "region_code": region_code,
        "region_name": name,
        "level": level,
        "parent_code": parent_code,
        "official_code": official_code,
        "amap_adcode": amap_adcode,
        "amap_citycode": amap_citycode,
        "center": item.get("center") or None,
        "source": "amap_repair",
        "source_version": source_version,
        "sort_order": sort_order,
        "remark": None,
    }


def _virtual_region_payload(
    *,
    parent: dict[str, Any],
    virtual_level: str,
    source_version: str,
) -> dict[str, Any]:
    if virtual_level == "city":
        region_code = f"{parent['region_code']}-VCITY"
        region_name = parent["region_name"]
    elif virtual_level == "county":
        region_code = f"{parent['region_code']}-VCOUNTY"
        region_name = f"{parent['region_name']}直属区域"
    else:
        raise ValueError(f"不支持的虚拟行政区层级: {virtual_level}")

    return {
        "region_code": region_code,
        "region_name": region_name,
        "level": virtual_level,
        "parent_code": parent["region_code"],
        "official_code": None,
        "amap_adcode": parent.get("amap_adcode"),
        "amap_citycode": parent.get("amap_citycode"),
        "center": parent.get("center"),
        "source": "system_virtual",
        "source_version": source_version,
        "sort_order": 0,
        "remark": "系统为保持四级行政区树结构自动生成的虚拟层，不代表官方行政区划。",
    }


def _would_change_name(existing: dict[str, Any] | None, payload: dict[str, Any]) -> bool:
    return bool(existing and existing.get("region_name") != payload.get("region_name"))


def _find_existing_town(
    existing_regions: list[dict[str, Any]],
    *,
    parent_code: str,
    sort_order: int,
    name: str,
    amap_adcode: str | None,
) -> dict[str, Any] | None:
    for region in existing_regions:
        if region["parent_code"] == parent_code and region["region_name"] == name:
            return region

    for region in existing_regions:
        if region["parent_code"] == parent_code and region["sort_order"] == sort_order:
            return region

    generated_code = _make_town_code(parent_code, name, amap_adcode)
    for region in existing_regions:
        if region["region_code"] == generated_code:
            return region

    return None


def _has_suspicious_text(value: str | None) -> bool:
    return bool(value and any(token in value for token in SUSPICIOUS_TOKENS))


def _db_url_from_env() -> dict[str, Any]:
    return {
        "host": os.getenv("VIOT_DB_HOST", "127.0.0.1"),
        "port": int(os.getenv("VIOT_DB_PORT", "3306")),
        "user": os.getenv("VIOT_DB_USER", "root"),
        "password": os.getenv("VIOT_DB_PASSWORD", "bupt8-AIOps"),
        "database": os.getenv("VIOT_DB_NAME", "viot_ops_db"),
        "charset": "utf8mb4",
        "autocommit": False,
        "cursorclass": pymysql.cursors.DictCursor,
    }


def amap_request(
    *,
    key: str,
    keywords: str,
    subdistrict: int,
    timeout: int = 20,
) -> dict[str, Any]:
    response = requests.get(
        AMAP_DISTRICT_URL,
        params={
            "key": key,
            "keywords": keywords,
            "subdistrict": subdistrict,
            "extensions": "base",
            "output": "JSON",
        },
        timeout=timeout,
    )
    response.raise_for_status()
    data = response.json()
    if data.get("status") != "1":
        raise RuntimeError(
            f"高德 API 调用失败: info={data.get('info')}, "
            f"infocode={data.get('infocode')}, keywords={keywords}"
        )
    return data


def fetch_node(
    key: str,
    keywords: str,
    *,
    sleep_seconds: float,
    subdistrict: int = 1,
) -> dict[str, Any]:
    time.sleep(sleep_seconds)
    data = amap_request(key=key, keywords=keywords, subdistrict=subdistrict)
    districts = data.get("districts") or []
    if not districts:
        raise RuntimeError(f"高德未返回行政区: {keywords}")
    return districts[0]


def load_existing_regions(conn) -> dict[str, dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT region_code, region_name, level, parent_code, official_code,
                   amap_adcode, amap_citycode, center, source, source_version,
                   sort_order, remark
            FROM administrative_region
            """
        )
        return {row["region_code"]: row for row in cur.fetchall()}


def load_reference_counts(conn) -> dict[str, int]:
    counts: dict[str, int] = {}
    checks = (
        ("camera.town_code", "SELECT town_code AS code, COUNT(*) AS count FROM camera GROUP BY town_code"),
        ("server.town_code", "SELECT town_code AS code, COUNT(*) AS count FROM server GROUP BY town_code"),
    )
    with conn.cursor() as cur:
        for label, sql in checks:
            cur.execute(sql)
            for row in cur.fetchall():
                code = row["code"]
                if code:
                    counts[f"{label}:{code}"] = row["count"]
    return counts


def _children(node: dict[str, Any]) -> list[dict[str, Any]]:
    return list(node.get("districts") or [])


def build_repair_plan(
    *,
    root: dict[str, Any],
    existing_regions: dict[str, dict[str, Any]],
    source_version: str,
) -> RepairPlan:
    by_parent = defaultdict(list)
    for region in existing_regions.values():
        by_parent[region["parent_code"]].append(region)

    upserts: list[dict[str, Any]] = []
    updates: list[dict[str, Any]] = []
    skipped: list[str] = []
    planned_by_code: dict[str, dict[str, Any]] = {}

    def stage_payload(payload: dict[str, Any]) -> dict[str, Any]:
        existing = existing_regions.get(payload["region_code"])
        planned_by_code[payload["region_code"]] = payload

        if existing is None:
            upserts.append(payload)
        else:
            comparable_keys = (
                "region_name",
                "level",
                "parent_code",
                "official_code",
                "amap_adcode",
                "amap_citycode",
                "center",
                "source",
                "source_version",
                "sort_order",
                "remark",
            )
            if any(existing.get(key) != payload.get(key) for key in comparable_keys):
                updates.append(payload)

        return payload

    def adjust_parent(
        *,
        parent: dict[str, Any] | None,
        child_level: str,
    ) -> dict[str, Any] | None:
        if child_level == "province" or parent is None:
            return None

        if child_level == "city":
            return parent

        if child_level == "county":
            if parent["level"] == "city":
                return parent
            if parent["level"] == "province":
                return stage_payload(
                    _virtual_region_payload(
                        parent=parent,
                        virtual_level="city",
                        source_version=source_version,
                    )
                )

        if child_level == "town":
            if parent["level"] == "county":
                return parent
            if parent["level"] == "city":
                return stage_payload(
                    _virtual_region_payload(
                        parent=parent,
                        virtual_level="county",
                        source_version=source_version,
                    )
                )
            if parent["level"] == "province":
                virtual_city = stage_payload(
                    _virtual_region_payload(
                        parent=parent,
                        virtual_level="city",
                        source_version=source_version,
                    )
                )
                return stage_payload(
                    _virtual_region_payload(
                        parent=virtual_city,
                        virtual_level="county",
                        source_version=source_version,
                    )
                )

        return parent

    def visit(
        item: dict[str, Any],
        *,
        parent: dict[str, Any] | None,
        sort_order: int,
    ) -> dict[str, Any] | None:
        amap_level = str(item.get("level") or "").strip()
        if amap_level == "country":
            for index, child in enumerate(_children(item)):
                visit(child, parent=None, sort_order=index)
            return None

        level = _system_level(amap_level)
        adjusted_parent = adjust_parent(parent=parent, child_level=level)
        parent_code = adjusted_parent["region_code"] if adjusted_parent else None
        existing = None
        if level == "town":
            existing = _find_existing_town(
                by_parent[parent_code],
                parent_code=parent_code or "",
                sort_order=sort_order,
                name=str(item.get("name") or "").strip(),
                amap_adcode=str(item.get("adcode") or "").strip() or None,
            )

        payload = _region_payload(
            item,
            level=level,
            parent_code=parent_code,
            sort_order=sort_order,
            existing=existing,
            source_version=source_version,
        )

        staged = stage_payload(payload)
        if level == "town":
            return staged

        for index, child in enumerate(_children(item)):
            visit(child, parent=staged, sort_order=index)

        return staged

    visit(root, parent=None, sort_order=0)

    unique_index = defaultdict(list)
    for region in existing_regions.values():
        unique_index[(region["parent_code"], region["region_name"], region["level"])].append(region["region_code"])

    for payload in upserts + updates:
        unique_key = (payload["parent_code"], payload["region_name"], payload["level"])
        unique_index[unique_key] = [code for code in unique_index[unique_key] if code == payload["region_code"]]
        unique_index[unique_key].append(payload["region_code"])

    conflicts = [
        f"{key} -> {sorted(set(codes))}"
        for key, codes in unique_index.items()
        if len(set(codes)) > 1
    ]

    for code, region in existing_regions.items():
        if code not in planned_by_code and _has_suspicious_text(region.get("region_name")):
            skipped.append(f"{code} {region.get('region_name')} level={region.get('level')} parent={region.get('parent_code')}")

    return RepairPlan(upserts=upserts, updates=updates, skipped=skipped, conflicts=conflicts)


def print_plan(plan: RepairPlan, reference_counts: dict[str, int], *, limit: int) -> None:
    print(f"待新增: {len(plan.upserts)}")
    print(f"待更新: {len(plan.updates)}")
    print(f"唯一键冲突: {len(plan.conflicts)}")
    print(f"仍可能残留乱码且高德计划未覆盖: {len(plan.skipped)}")
    print(f"当前已挂载引用数量: {sum(reference_counts.values())}")

    changed_names = [
        payload
        for payload in plan.upserts + plan.updates
        if _has_suspicious_text(payload.get("region_name")) is False
    ]
    if changed_names:
        print("\n更新样例:")
        for payload in changed_names[:limit]:
            print(
                f"- {payload['region_code']} {payload['level']} "
                f"{payload['parent_code']} -> {payload['region_name']}"
            )

    if plan.conflicts:
        print("\n冲突样例:")
        for conflict in plan.conflicts[:limit]:
            print(f"- {conflict}")

    if plan.skipped:
        print("\n未覆盖乱码样例:")
        for item in plan.skipped[:limit]:
            print(f"- {item}")


def apply_plan(conn, plan: RepairPlan) -> None:
    if plan.conflicts:
        raise RuntimeError("存在唯一键冲突，拒绝写库。请先处理 dry-run 输出的冲突。")

    sql = """
    INSERT INTO administrative_region (
        region_code, region_name, level, parent_code, official_code,
        amap_adcode, amap_citycode, center, source, source_version,
        sort_order, remark, created_at, updated_at
    ) VALUES (
        %(region_code)s, %(region_name)s, %(level)s, %(parent_code)s, %(official_code)s,
        %(amap_adcode)s, %(amap_citycode)s, %(center)s, %(source)s, %(source_version)s,
        %(sort_order)s, %(remark)s, NOW(), NOW()
    )
    ON DUPLICATE KEY UPDATE
        region_name = VALUES(region_name),
        level = VALUES(level),
        parent_code = VALUES(parent_code),
        official_code = VALUES(official_code),
        amap_adcode = VALUES(amap_adcode),
        amap_citycode = VALUES(amap_citycode),
        center = VALUES(center),
        source = VALUES(source),
        source_version = VALUES(source_version),
        sort_order = VALUES(sort_order),
        remark = VALUES(remark),
        updated_at = NOW()
    """

    with conn.cursor() as cur:
        if plan.upserts:
            cur.executemany(sql, plan.upserts)
        if plan.updates:
            cur.executemany(sql, plan.updates)
    conn.commit()


def fetch_amap_tree(key: str, keywords: str, *, sleep_seconds: float) -> dict[str, Any]:
    root = fetch_node(key, keywords, sleep_seconds=sleep_seconds, subdistrict=1)
    root_level = str(root.get("level") or "").strip()

    if root_level == "country":
        provinces = []
        for province in _children(root):
            province_keyword = str(province.get("adcode") or province.get("name") or "").strip()
            if not province_keyword:
                raise RuntimeError(f"省级节点缺少查询关键字: {province}")
            provinces.append(
                fetch_node(
                    key,
                    province_keyword,
                    sleep_seconds=sleep_seconds,
                    subdistrict=3,
                )
            )
        root["districts"] = provinces
        return root

    if root_level == "province":
        return fetch_node(key, keywords, sleep_seconds=sleep_seconds, subdistrict=3)

    if root_level in {"city", "district"}:
        return fetch_node(key, keywords, sleep_seconds=sleep_seconds, subdistrict=2)

    return root


def main() -> int:
    parser = argparse.ArgumentParser(description="从高德行政区接口修复现有行政区中文乱码。")
    parser.add_argument("--keywords", default="中国")
    parser.add_argument("--sleep", type=float, default=0.8)
    parser.add_argument("--source-version", default=datetime.now().strftime("amap-repair-%Y-%m-%d"))
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--apply", action="store_true", help="执行写库；不传则只 dry-run。")
    args = parser.parse_args()

    key = os.getenv("AMAP_KEY")
    if not key:
        raise RuntimeError("请先设置 AMAP_KEY。")

    conn = pymysql.connect(**_db_url_from_env())
    try:
        existing_regions = load_existing_regions(conn)
        reference_counts = load_reference_counts(conn)
        root = fetch_amap_tree(key, args.keywords, sleep_seconds=args.sleep)
        plan = build_repair_plan(
            root=root,
            existing_regions=existing_regions,
            source_version=args.source_version,
        )
        print_plan(plan, reference_counts, limit=args.limit)

        if not args.apply:
            print("\n当前为 dry-run，未写库。确认无冲突后加 --apply 执行。")
            return 0

        apply_plan(conn, plan)
        print("\n已写入 administrative_region。")
        return 0
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
