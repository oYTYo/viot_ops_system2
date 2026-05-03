from __future__ import annotations

import argparse
import hashlib
import os
import time
from datetime import datetime
from typing import Any

import requests

from database import SessionLocal
import models


AMAP_DISTRICT_URL = "https://restapi.amap.com/v3/config/district"

AMAP_LEVEL_TO_SYSTEM_LEVEL = {
    "province": "province",
    "city": "city",
    "district": "county",
    "street": "town",
}

SYSTEM_LEVEL_ORDER = {
    "province": 1,
    "city": 2,
    "county": 3,
    "town": 4,
}


def short_hash(text: str, length: int = 10) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:length]


def amap_request(
    *,
    key: str,
    keywords: str,
    subdistrict: int = 1,
    extensions: str = "base",
    output: str = "JSON",
    timeout: int = 20,
) -> dict[str, Any]:
    params = {
        "key": key,
        "keywords": keywords,
        "subdistrict": subdistrict,
        "extensions": extensions,
        "output": output,
    }

    resp = requests.get(AMAP_DISTRICT_URL, params=params, timeout=timeout)
    resp.raise_for_status()

    data = resp.json()

    if data.get("status") != "1":
        raise RuntimeError(
            f"高德 API 调用失败: info={data.get('info')}, "
            f"infocode={data.get('infocode')}, keywords={keywords}"
        )

    return data


def fetch_amap_node(key: str, keywords: str) -> dict[str, Any] | None:
    """
    查询一个行政区节点，并返回它的一层子节点。
    高德的 subdistrict=1 表示返回下一级行政区。
    """
    data = amap_request(
        key=key,
        keywords=keywords,
        subdistrict=1,
        extensions="base",
    )

    districts = data.get("districts") or []
    if not districts:
        return None

    # 通常 keywords 精确传 adcode 或名称时，只会返回一个主节点。
    return districts[0]


def make_region_code(
    *,
    system_level: str,
    amap_item: dict[str, Any],
    parent_code: str | None,
) -> str:
    """
    生成系统内部唯一 region_code。

    省、市、县：优先用高德 adcode，通常也是 6 位行政区代码。
    乡镇/街道：不能用高德 adcode，因为高德文档说明街道 adcode 继承区县。
              因此用 parent_code + 名称 hash 生成稳定内部编码。
    """
    amap_adcode = str(amap_item.get("adcode") or "").strip()
    name = str(amap_item.get("name") or "").strip()

    if system_level in {"province", "city", "county"}:
        if not amap_adcode:
            raise ValueError(f"{system_level} 缺少 adcode: {amap_item}")
        return amap_adcode

    if system_level == "town":
        if not parent_code:
            raise ValueError(f"乡镇/街道缺少 parent_code: {amap_item}")

        digest = short_hash(f"{parent_code}:{name}:{amap_adcode}")
        return f"{parent_code}-T-{digest}"

    raise ValueError(f"unsupported system_level: {system_level}")


def upsert_region(
    db,
    *,
    region_code: str,
    region_name: str,
    level: str,
    parent_code: str | None,
    official_code: str | None,
    amap_adcode: str | None,
    amap_citycode: str | None,
    center: str | None,
    source: str,
    source_version: str,
    sort_order: int,
    remark: str | None = None,
) -> models.AdministrativeRegion:
    obj = db.get(models.AdministrativeRegion, region_code)

    if obj is None:
        obj = models.AdministrativeRegion(
            region_code=region_code,
            region_name=region_name,
            level=level,
            parent_code=parent_code,
            official_code=official_code,
            amap_adcode=amap_adcode,
            amap_citycode=amap_citycode,
            center=center,
            source=source,
            source_version=source_version,
            sort_order=sort_order,
            remark=remark,
        )
        db.add(obj)
    else:
        obj.region_name = region_name
        obj.level = level
        obj.parent_code = parent_code
        obj.official_code = official_code
        obj.amap_adcode = amap_adcode
        obj.amap_citycode = amap_citycode
        obj.center = center
        obj.source = source
        obj.source_version = source_version
        obj.sort_order = sort_order
        obj.remark = remark

    db.flush()
    return obj


def ensure_virtual_region(
    db,
    *,
    parent: models.AdministrativeRegion,
    virtual_level: str,
    source_version: str,
) -> models.AdministrativeRegion:
    """
    用于处理直辖市、省直辖县级市、东莞这类行政层级不完整的情况。

    例如：
    北京市可能是 province -> county；
    东莞市可能是 city -> town。

    但我们的业务前端希望是 province -> city -> county -> town。
    所以这里补一个“系统虚拟层”，但不伪造 official_code。
    """
    if virtual_level == "city":
        region_code = f"{parent.region_code}-VCITY"
        region_name = parent.region_name
    elif virtual_level == "county":
        region_code = f"{parent.region_code}-VCOUNTY"
        region_name = f"{parent.region_name}直属区域"
    else:
        raise ValueError(f"unsupported virtual_level: {virtual_level}")

    return upsert_region(
        db,
        region_code=region_code,
        region_name=region_name,
        level=virtual_level,
        parent_code=parent.region_code,
        official_code=None,
        amap_adcode=parent.amap_adcode,
        amap_citycode=parent.amap_citycode,
        center=parent.center,
        source="system_virtual",
        source_version=source_version,
        sort_order=0,
        remark="系统为保持四级行政区树结构自动生成的虚拟层，不代表官方行政区划。",
    )


def adjust_parent_for_four_level_tree(
    db,
    *,
    parent: models.AdministrativeRegion | None,
    child_level: str,
    source_version: str,
) -> models.AdministrativeRegion | None:
    """
    把高德返回的真实层级调整成系统需要的四级树。

    正常情况：
    province -> city -> county -> town

    特殊情况：
    province -> county，需要补 virtual city
    city -> town，需要补 virtual county
    """
    if child_level == "province":
        return None

    if parent is None:
        return None

    if child_level == "city":
        return parent

    if child_level == "county":
        if parent.level == "city":
            return parent
        if parent.level == "province":
            return ensure_virtual_region(
                db,
                parent=parent,
                virtual_level="city",
                source_version=source_version,
            )

    if child_level == "town":
        if parent.level == "county":
            return parent
        if parent.level == "city":
            return ensure_virtual_region(
                db,
                parent=parent,
                virtual_level="county",
                source_version=source_version,
            )
        if parent.level == "province":
            virtual_city = ensure_virtual_region(
                db,
                parent=parent,
                virtual_level="city",
                source_version=source_version,
            )
            return ensure_virtual_region(
                db,
                parent=virtual_city,
                virtual_level="county",
                source_version=source_version,
            )

    return parent


def import_amap_item(
    db,
    *,
    key: str,
    amap_item: dict[str, Any],
    parent_region: models.AdministrativeRegion | None,
    source_version: str,
    sleep_seconds: float,
    sort_order: int,
) -> models.AdministrativeRegion | None:
    amap_level = str(amap_item.get("level") or "").strip()
    amap_name = str(amap_item.get("name") or "").strip()
    amap_adcode = str(amap_item.get("adcode") or "").strip() or None
    amap_citycode = amap_item.get("citycode")
    center = amap_item.get("center")

    # citycode 有时可能是 []，这里统一转成 None 或字符串。
    if isinstance(amap_citycode, list):
        amap_citycode = None
    elif amap_citycode is not None:
        amap_citycode = str(amap_citycode)

    if amap_level == "country":
        current_region = None
    else:
        system_level = AMAP_LEVEL_TO_SYSTEM_LEVEL.get(amap_level)

        if not system_level:
            print(f"跳过未知层级: level={amap_level}, name={amap_name}")
            return None

        adjusted_parent = adjust_parent_for_four_level_tree(
            db,
            parent=parent_region,
            child_level=system_level,
            source_version=source_version,
        )

        parent_code = adjusted_parent.region_code if adjusted_parent else None

        region_code = make_region_code(
            system_level=system_level,
            amap_item=amap_item,
            parent_code=parent_code,
        )

        # 乡镇/街道没有独立官方码，因此 official_code 置空。
        if system_level == "town":
            official_code = None
        else:
            official_code = amap_adcode

        current_region = upsert_region(
            db,
            region_code=region_code,
            region_name=amap_name,
            level=system_level,
            parent_code=parent_code,
            official_code=official_code,
            amap_adcode=amap_adcode,
            amap_citycode=amap_citycode,
            center=center,
            source="amap",
            source_version=source_version,
            sort_order=sort_order,
            remark=None,
        )

        print(
            f"导入: {current_region.level} "
            f"{current_region.region_name} "
            f"region_code={current_region.region_code} "
            f"parent={current_region.parent_code}"
        )

    # 乡镇/街道已经是最后一级，不再递归。
    if amap_level == "street":
        return current_region

    # 为了拿到稳定的一层子节点，重新请求当前节点。
    # 传 adcode 通常比传名称更稳定；没有 adcode 时再传名称。
    query_keyword = amap_adcode or amap_name

    if query_keyword:
        time.sleep(sleep_seconds)
        fresh_node = fetch_amap_node(key, query_keyword)
        children = fresh_node.get("districts", []) if fresh_node else []
    else:
        children = amap_item.get("districts", []) or []

    for idx, child in enumerate(children):
        import_amap_item(
            db,
            key=key,
            amap_item=child,
            parent_region=current_region or parent_region,
            source_version=source_version,
            sleep_seconds=sleep_seconds,
            sort_order=idx,
        )

    return current_region


def reset_regions(db) -> None:
    """
    只适合开发库或还没有摄像机数据时使用。
    如果已经有 camera 绑定了行政区，删除行政区会触发外键约束失败。
    """
    for level in ["town", "county", "city", "province"]:
        db.query(models.AdministrativeRegion).filter(
            models.AdministrativeRegion.level == level
        ).delete(synchronize_session=False)

    db.commit()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--keywords",
        default="中国",
        help="导入范围。建议开发阶段先用省份，例如：江苏省；全国则用：中国。",
    )
    parser.add_argument(
        "--reset",
        action="store_true",
        help="导入前清空行政区表。仅建议开发库使用。",
    )
    parser.add_argument(
        "--sleep",
        type=float,
        default=0.2,
        help="每次请求之间的等待秒数，避免调用过快。",
    )
    parser.add_argument(
        "--source-version",
        default=datetime.now().strftime("amap-%Y-%m-%d"),
        help="写入数据库的 source_version。",
    )

    args = parser.parse_args()

    key = os.getenv("AMAP_KEY")
    if not key:
        raise RuntimeError("请先设置环境变量 AMAP_KEY=你的高德Web服务Key")

    db = SessionLocal()

    try:
        if args.reset:
            print("正在清空 administrative_region 表...")
            reset_regions(db)

        print(f"开始从高德导入行政区: {args.keywords}")

        root = fetch_amap_node(key, args.keywords)
        if not root:
            raise RuntimeError(f"没有从高德查询到行政区: {args.keywords}")

        import_amap_item(
            db,
            key=key,
            amap_item=root,
            parent_region=None,
            source_version=args.source_version,
            sleep_seconds=args.sleep,
            sort_order=0,
        )

        db.commit()
        print("行政区导入完成！")

    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()