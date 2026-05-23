from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Table,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


class AdministrativeRegion(Base):
    """行政区划表，用于组织摄像机所属的省、市、县、乡四级结构。"""

    __tablename__ = "administrative_region"

    __table_args__ = (
        Index("ix_region_parent_code", "parent_code"),
        Index("ix_region_level", "level"),
        Index("ix_region_official_code", "official_code"),
        Index("ix_region_amap_adcode", "amap_adcode"),
        CheckConstraint(
            "level in ('province', 'city', 'county', 'town')",
            name="ck_region_level",
        ),
        UniqueConstraint(
            "parent_code",
            "region_name",
            "level",
            name="uq_region_parent_name_level",
        ),
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )

    # 系统内部唯一编码。
    # 省、市、县可以用官方 6 位码；乡镇街道可以用系统生成码。
    region_code: Mapped[str] = mapped_column(String(64), primary_key=True)

    # 行政区名称，例如：江苏省、南京市、江宁区、东山街道。
    region_name: Mapped[str] = mapped_column(String(64), nullable=False)

    # 行政区级别：province / city / county / town。
    level: Mapped[str] = mapped_column(String(16), nullable=False)

    # 上级行政区内部编码。
    parent_code: Mapped[str | None] = mapped_column(
        String(64),
        ForeignKey("administrative_region.region_code", ondelete="RESTRICT"),
        nullable=True,
    )

    # 官方行政区划代码。省、市、县一般有；乡镇街道可以为空。
    official_code: Mapped[str | None] = mapped_column(String(32), nullable=True)

    # 高德 adcode。注意：乡镇街道通常继承区县 adcode，不能当唯一主键。
    amap_adcode: Mapped[str | None] = mapped_column(String(32), nullable=True)

    # 高德 citycode，可选。
    amap_citycode: Mapped[str | None] = mapped_column(String(32), nullable=True)

    # 高德中心点，例如 "118.839510,31.953195"。
    center: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # 数据来源，例如 official / amap / manual。
    source: Mapped[str | None] = mapped_column(String(32), nullable=True)

    # 数据版本，例如 2024 / 2026-04 / amap-2026-04。
    source_version: Mapped[str | None] = mapped_column(String(32), nullable=True)

    # 前端展示排序使用。
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    remark: Mapped[str | None] = mapped_column(String(255), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        nullable=False,
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )

    parent: Mapped["AdministrativeRegion | None"] = relationship(
        remote_side=[region_code],
        back_populates="children",
    )

    children: Mapped[list["AdministrativeRegion"]] = relationship(
        back_populates="parent",
        lazy="selectin",
    )

    # 摄像机最终挂在乡级行政区下面。
    cameras: Mapped[list["Camera"]] = relationship(
        back_populates="town_region",
        lazy="selectin",
        foreign_keys="Camera.town_code",
    )


class Server(Base):
    """服务器节点信息。"""

    __tablename__ = "server"

    __table_args__ = (
        Index("ix_server_ip", "ip"),
        Index("ix_server_status", "status"),
        Index("ix_server_node_type", "node_type"),
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)

    name: Mapped[str] = mapped_column(String(128), nullable=False)
    ip: Mapped[str] = mapped_column(String(45), nullable=False)

    # 例如：stream_server / database_server / gateway_server。
    node_type: Mapped[str] = mapped_column(String(32), nullable=False)

    # 例如：normal / warning / offline / fault。
    status: Mapped[str] = mapped_column(String(32), nullable=False)

    location_desc: Mapped[str | None] = mapped_column(String(255), nullable=True)

    longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    latitude: Mapped[float | None] = mapped_column(Float, nullable=True)

    cpu_usage: Mapped[float | None] = mapped_column(Float, nullable=True)
    ram_usage: Mapped[float | None] = mapped_column(Float, nullable=True)
    disk_usage: Mapped[float | None] = mapped_column(Float, nullable=True)
    net_bandwidth: Mapped[float | None] = mapped_column(Float, nullable=True)
    gpu_usage: Mapped[float | None] = mapped_column(Float, nullable=True)

    last_heartbeat: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        nullable=False,
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )

    cameras: Mapped[list["Camera"]] = relationship(
        back_populates="server",
        lazy="selectin",
    )

    stream_medias: Mapped[list["StreamMedia"]] = relationship(
        back_populates="server",
        lazy="selectin",
    )


class NetworkNode(Base):
    """网络节点信息，例如交换机、路由器、网关、防火墙等。"""

    __tablename__ = "network_node"

    __table_args__ = (
        Index("ix_network_node_ip", "ip"),
        Index("ix_network_node_status", "status"),
        Index("ix_network_node_node_type", "node_type"),
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)

    name: Mapped[str] = mapped_column(String(128), nullable=False)

    ip: Mapped[str | None] = mapped_column(String(45), nullable=True)

    # 例如：switch / router / gateway / firewall / olt / onu。
    node_type: Mapped[str] = mapped_column(String(32), nullable=False)

    # 例如：normal / warning / offline / fault。
    status: Mapped[str] = mapped_column(String(32), nullable=False)

    vendor: Mapped[str | None] = mapped_column(String(64), nullable=True)
    model: Mapped[str | None] = mapped_column(String(128), nullable=True)

    location_desc: Mapped[str | None] = mapped_column(String(255), nullable=True)

    longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    latitude: Mapped[float | None] = mapped_column(Float, nullable=True)

    cpu_usage: Mapped[float | None] = mapped_column(Float, nullable=True)
    ram_usage: Mapped[float | None] = mapped_column(Float, nullable=True)
    net_bandwidth: Mapped[float | None] = mapped_column(Float, nullable=True)

    last_heartbeat: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        nullable=False,
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )


class Camera(Base):
    """摄像机设备信息。"""

    __tablename__ = "camera"

    __table_args__ = (
        Index("ix_camera_ip", "ip"),
        Index("ix_camera_status", "status"),
        Index("ix_camera_server_id", "server_id"),
        Index("ix_camera_province_code", "province_code"),
        Index("ix_camera_city_code", "city_code"),
        Index("ix_camera_county_code", "county_code"),
        Index("ix_camera_town_code", "town_code"),
        Index(
            "ix_camera_admin_region",
            "province_code",
            "city_code",
            "county_code",
            "town_code",
        ),
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)

    name: Mapped[str] = mapped_column(String(128), nullable=False)

    model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    vendor: Mapped[str | None] = mapped_column(String(64), nullable=True)

    ip: Mapped[str] = mapped_column(String(45), nullable=False)

    # 例如：online / offline / warning / fault。
    status: Mapped[str] = mapped_column(String(32), nullable=False)

    # 例如：RTSP / GB28181 / RTP。
    protocol: Mapped[str | None] = mapped_column(String(16), nullable=True)

    # 例如：H.264 / H.265 / VP9 / AV1。
    codec: Mapped[str | None] = mapped_column(String(32), nullable=True)

    # 例如：main / sub。
    stream_type: Mapped[str | None] = mapped_column(String(32), nullable=True)

    # 例如：Ethernet / Wi-Fi / 4G / 5G。
    access_type: Mapped[str | None] = mapped_column(String(32), nullable=True)

    unit: Mapped[str | None] = mapped_column(String(128), nullable=True)
    manager: Mapped[str | None] = mapped_column(String(128), nullable=True)

    # 省级行政区。
    province_code: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("administrative_region.region_code", ondelete="RESTRICT"),
        nullable=False,
    )
    province_name: Mapped[str] = mapped_column(String(64), nullable=False)

    # 地级行政区。
    city_code: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("administrative_region.region_code", ondelete="RESTRICT"),
        nullable=False,
    )
    city_name: Mapped[str] = mapped_column(String(64), nullable=False)

    # 县级行政区。
    county_code: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("administrative_region.region_code", ondelete="RESTRICT"),
        nullable=False,
    )
    county_name: Mapped[str] = mapped_column(String(64), nullable=False)

    # 乡级行政区。摄像机最终挂在这个层级下面。
    town_code: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("administrative_region.region_code", ondelete="RESTRICT"),
        nullable=False,
    )
    town_name: Mapped[str] = mapped_column(String(64), nullable=False)

    # 经纬度保留，但不再作为主定位方式。
    location_desc: Mapped[str | None] = mapped_column(String(255), nullable=True)

    longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    latitude: Mapped[float | None] = mapped_column(Float, nullable=True)

    server_id: Mapped[str | None] = mapped_column(
        String(64),
        ForeignKey("server.id", ondelete="SET NULL"),
        nullable=True,
    )

    video_url: Mapped[str | None] = mapped_column(String(512), nullable=True)

    last_heartbeat: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        nullable=False,
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )

    server: Mapped[Server | None] = relationship(
        back_populates="cameras",
    )

    province_region: Mapped[AdministrativeRegion] = relationship(
        foreign_keys=[province_code],
    )

    city_region: Mapped[AdministrativeRegion] = relationship(
        foreign_keys=[city_code],
    )

    county_region: Mapped[AdministrativeRegion] = relationship(
        foreign_keys=[county_code],
    )

    town_region: Mapped[AdministrativeRegion] = relationship(
        back_populates="cameras",
        foreign_keys=[town_code],
    )

    stream_medias: Mapped[list["StreamMedia"]] = relationship(
        back_populates="camera",
        lazy="selectin",
    )


class StreamMedia(Base):
    """流媒体链路信息。"""

    __tablename__ = "stream_media"

    __table_args__ = (
        Index("ix_stream_media_camera_id", "camera_id"),
        Index("ix_stream_media_server_id", "server_id"),
        Index("ix_stream_media_ssrc", "ssrc"),
        Index("ix_stream_media_is_fault", "is_fault"),
        Index("ix_stream_media_is_connected", "is_connected"),
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)

    source_ip: Mapped[str] = mapped_column(String(45), nullable=False)
    source_port: Mapped[int] = mapped_column(Integer, nullable=False)

    destination_ip: Mapped[str] = mapped_column(String(45), nullable=False)
    destination_port: Mapped[int] = mapped_column(Integer, nullable=False)

    ssrc: Mapped[str] = mapped_column(String(64), nullable=False)

    camera_id: Mapped[str | None] = mapped_column(
        String(64),
        ForeignKey("camera.id", ondelete="SET NULL"),
        nullable=True,
    )

    server_id: Mapped[str | None] = mapped_column(
        String(64),
        ForeignKey("server.id", ondelete="SET NULL"),
        nullable=True,
    )

    codec: Mapped[str | None] = mapped_column(String(32), nullable=True)
    resolution: Mapped[str | None] = mapped_column(String(32), nullable=True)
    frame_rate: Mapped[float | None] = mapped_column(Float, nullable=True)

    real_time_bitrate: Mapped[float | None] = mapped_column(Float, nullable=True)
    throughput: Mapped[float | None] = mapped_column(Float, nullable=True)
    latency: Mapped[float | None] = mapped_column(Float, nullable=True)
    jitter: Mapped[float | None] = mapped_column(Float, nullable=True)
    packet_loss_rate: Mapped[float | None] = mapped_column(Float, nullable=True)
    qoe_score: Mapped[float | None] = mapped_column(Float, nullable=True)

    transport_protocol: Mapped[str | None] = mapped_column(String(16), nullable=True)

    is_connected: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_fault: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    link_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    stream_type: Mapped[str | None] = mapped_column(String(32), nullable=True)

    last_update_time: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        nullable=False,
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )

    camera: Mapped[Camera | None] = relationship(
        back_populates="stream_medias",
    )

    server: Mapped[Server | None] = relationship(
        back_populates="stream_medias",
    )


class TopologyLink(Base):
    """拓扑连线信息，用于描述摄像机、服务器、网络节点之间的连接关系。"""

    __tablename__ = "topology_link"

    __table_args__ = (
        Index("ix_topology_link_source", "source_type", "source_id"),
        Index("ix_topology_link_target", "target_type", "target_id"),
        Index("ix_topology_link_status", "status"),
        CheckConstraint(
            "source_type in ('camera', 'server', 'network_node')",
            name="ck_topology_link_source_type",
        ),
        CheckConstraint(
            "target_type in ('camera', 'server', 'network_node')",
            name="ck_topology_link_target_type",
        ),
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)

    source_type: Mapped[str] = mapped_column(String(32), nullable=False)
    source_id: Mapped[str] = mapped_column(String(64), nullable=False)

    target_type: Mapped[str] = mapped_column(String(32), nullable=False)
    target_id: Mapped[str] = mapped_column(String(64), nullable=False)

    # 例如：access / uplink / stream / management。
    link_type: Mapped[str | None] = mapped_column(String(32), nullable=True)

    # 例如：normal / warning / offline / fault。
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="normal")

    bandwidth_usage: Mapped[float | None] = mapped_column(Float, nullable=True)
    latency: Mapped[float | None] = mapped_column(Float, nullable=True)
    packet_loss_rate: Mapped[float | None] = mapped_column(Float, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        nullable=False,
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )


class FaultEvent(Base):
    """故障与修复事件。"""

    __tablename__ = "fault_event"

    __table_args__ = (
        Index("ix_fault_event_entity", "entity_type", "entity_id"),
        Index("ix_fault_event_trigger_time", "trigger_time"),
        Index("ix_fault_event_level_status", "level", "status"),
        CheckConstraint(
            "entity_type in ('camera', 'server', 'network_node')",
            name="ck_fault_event_entity_type",
        ),
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)

    title: Mapped[str] = mapped_column(String(128), nullable=False)

    entity_id: Mapped[str] = mapped_column(String(64), nullable=False)

    # camera / server / network_node。
    entity_type: Mapped[str] = mapped_column(String(32), nullable=False)

    category_l1: Mapped[str | None] = mapped_column(String(64), nullable=True)
    category_l2: Mapped[str | None] = mapped_column(String(64), nullable=True)
    category_l3: Mapped[str | None] = mapped_column(String(64), nullable=True)

    fault_code: Mapped[str] = mapped_column(String(64), nullable=False)
    fault_desc: Mapped[str] = mapped_column(String(255), nullable=False)

    # 例如：critical / major / minor / warning。
    level: Mapped[str] = mapped_column(String(16), nullable=False)

    # 例如：pending / processing / resolved / ignored。
    status: Mapped[str] = mapped_column(String(16), nullable=False)

    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)

    trigger_time: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    end_time: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    handler: Mapped[str | None] = mapped_column(String(64), nullable=True)
    ack_time: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    resolved_by: Mapped[str | None] = mapped_column(String(64), nullable=True)

    metrics_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    repair_strategy: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        nullable=False,
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )

    root_cause: Mapped["RootCause | None"] = relationship(
        back_populates="fault_event",
        lazy="selectin",
        uselist=False,
    )

    @property
    def duration_seconds(self) -> int | None:
        """故障持续时间，单位为秒。只有存在 end_time 时才可计算。"""
        if not self.end_time:
            return None

        return max(0, int((self.end_time - self.trigger_time).total_seconds()))


class RootCause(Base):
    """故障根因分析结果。"""

    __tablename__ = "root_cause"

    __table_args__ = (
        UniqueConstraint("fault_event_id", name="uq_root_cause_fault_event_id"),
        Index("ix_root_cause_fault_event_id", "fault_event_id"),
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)

    description: Mapped[str] = mapped_column(String(255), nullable=False)

    fault_event_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("fault_event.id", ondelete="CASCADE"),
        nullable=False,
    )

    # 例如：camera / server / network_node / stream_media。
    device_type: Mapped[str] = mapped_column(String(32), nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        nullable=False,
    )

    fault_event: Mapped[FaultEvent] = relationship(
        back_populates="root_cause",
    )


class WorkOrder(Base):
    """Operations work order for camera, server, stream, or regional issues."""

    __tablename__ = "work_order"

    __table_args__ = (
        Index("ix_work_order_status", "status"),
        Index("ix_work_order_priority", "priority"),
        Index("ix_work_order_order_type", "order_type"),
        Index("ix_work_order_region_code", "region_code"),
        Index("ix_work_order_entity", "related_entity_type", "related_entity_id"),
        Index("ix_work_order_assignee", "assignee"),
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)

    title: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[str | None] = mapped_column(String(512), nullable=True)

    # camera / server / stream / inspection / manual.
    order_type: Mapped[str] = mapped_column(String(32), nullable=False, default="manual")

    # urgent / high / medium / low.
    priority: Mapped[str] = mapped_column(String(16), nullable=False, default="medium")

    # pending / processing / review / closed / cancelled.
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")

    # manual / alarm / inspection / system.
    source: Mapped[str | None] = mapped_column(String(32), nullable=True)

    related_entity_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    related_entity_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    related_entity_name: Mapped[str | None] = mapped_column(String(128), nullable=True)

    region_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    region_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    region_level: Mapped[str | None] = mapped_column(String(16), nullable=True)
    region_path: Mapped[str | None] = mapped_column(String(255), nullable=True)

    assignee: Mapped[str | None] = mapped_column(String(64), nullable=True)
    creator: Mapped[str | None] = mapped_column(String(64), nullable=True)
    reviewer: Mapped[str | None] = mapped_column(String(64), nullable=True)

    sla_deadline: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    last_action: Mapped[str | None] = mapped_column(String(255), nullable=True)
    resolution: Mapped[str | None] = mapped_column(String(512), nullable=True)
    timeline: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        nullable=False,
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )


class VideoDiagnosis(Base):
    """Camera video diagnosis result and replayable diagnostic narrative."""

    __tablename__ = "video_diagnosis"

    __table_args__ = (
        Index("ix_video_diagnosis_camera_id", "camera_id"),
        Index("ix_video_diagnosis_started_at", "started_at"),
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    camera_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("camera.id", ondelete="CASCADE"),
        nullable=False,
    )
    camera_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    camera_status: Mapped[str | None] = mapped_column(String(32), nullable=True)

    started_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    health_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    business_status: Mapped[str | None] = mapped_column(String(64), nullable=True)
    abnormal_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    root_cause_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    root_cause_node: Mapped[str | None] = mapped_column(String(128), nullable=True)
    root_cause_metric: Mapped[str | None] = mapped_column(String(255), nullable=True)

    conclusion: Mapped[str | None] = mapped_column(String(255), nullable=True)
    suggestion: Mapped[str | None] = mapped_column(String(512), nullable=True)
    ping_output: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    steps: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON, nullable=True)
    topology: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        nullable=False,
    )


# 分组与摄像机的多对多关联表
group_camera_link = Table(
    "group_camera_link",
    Base.metadata,
    Column(
        "group_id",
        String(64),
        ForeignKey("device_group.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "camera_id",
        String(64),
        ForeignKey("camera.id", ondelete="CASCADE"),
        primary_key=True,
    ),
)


class DeviceGroup(Base):
    """设备自定义分组，支持层级嵌套。"""

    __tablename__ = "device_group"

    __table_args__ = (
        Index("ix_device_group_parent_id", "parent_id"),
        Index("ix_device_group_sort_order", "sort_order"),
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)

    name: Mapped[str] = mapped_column(String(64), nullable=False)

    # 父分组 ID，支持层级嵌套。
    parent_id: Mapped[str | None] = mapped_column(
        String(64),
        ForeignKey("device_group.id", ondelete="CASCADE"),
        nullable=True,
    )

    # 前端展示排序使用。
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        nullable=False,
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )

    # 父分组
    parent: Mapped["DeviceGroup | None"] = relationship(
        remote_side=[id],
        back_populates="children",
    )

    # 子分组
    children: Mapped[list["DeviceGroup"]] = relationship(
        back_populates="parent",
        lazy="selectin",
    )

    # 关联摄像机
    cameras: Mapped[list["Camera"]] = relationship(
        secondary=group_camera_link,
        backref="groups",
        lazy="selectin",
    )

