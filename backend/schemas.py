from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


# =========================
# 通用类型
# =========================

RegionLevel = Literal["province", "city", "county", "town"]
EntityType = Literal["camera", "server", "network_node"]
TopologyEntityType = Literal["camera", "server", "network_node"]
WorkOrderEntityType = Literal["camera", "server", "stream_media", "network_node"]


# =========================
# AdministrativeRegion
# =========================

class AdministrativeRegionBase(BaseModel):
    region_name: str = Field(..., max_length=64)
    level: RegionLevel
    parent_code: str | None = Field(default=None, max_length=64)

    official_code: str | None = Field(default=None, max_length=32)
    amap_adcode: str | None = Field(default=None, max_length=32)
    amap_citycode: str | None = Field(default=None, max_length=32)
    center: str | None = Field(default=None, max_length=64)

    source: str | None = Field(default=None, max_length=32)
    source_version: str | None = Field(default=None, max_length=32)

    sort_order: int = 0
    remark: str | None = Field(default=None, max_length=255)


class AdministrativeRegionCreate(AdministrativeRegionBase):
    region_code: str = Field(..., max_length=64)


class AdministrativeRegionUpdate(BaseModel):
    region_name: str | None = Field(default=None, max_length=64)
    level: RegionLevel | None = None
    parent_code: str | None = Field(default=None, max_length=64)

    official_code: str | None = Field(default=None, max_length=32)
    amap_adcode: str | None = Field(default=None, max_length=32)
    amap_citycode: str | None = Field(default=None, max_length=32)
    center: str | None = Field(default=None, max_length=64)

    source: str | None = Field(default=None, max_length=32)
    source_version: str | None = Field(default=None, max_length=32)

    sort_order: int | None = None
    remark: str | None = Field(default=None, max_length=255)


class AdministrativeRegionRead(AdministrativeRegionBase):
    region_code: str
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AdministrativeRegionTreeNode(AdministrativeRegionRead):
    children: list["AdministrativeRegionTreeNode"] = Field(default_factory=list)
    camera_count: int = 0


# =========================
# Server
# =========================

class ServerBase(BaseModel):
    name: str = Field(..., max_length=128)
    ip: str = Field(..., max_length=45)

    node_type: str = Field(..., max_length=32)
    status: str = Field(..., max_length=32)

    location_desc: str | None = Field(default=None, max_length=255)

    longitude: float | None = None
    latitude: float | None = None

    cpu_usage: float | None = None
    ram_usage: float | None = None
    disk_usage: float | None = None
    net_bandwidth: float | None = None
    gpu_usage: float | None = None

    last_heartbeat: datetime | None = None


class ServerCreate(ServerBase):
    id: str = Field(..., max_length=64)


class ServerUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=128)
    ip: str | None = Field(default=None, max_length=45)

    node_type: str | None = Field(default=None, max_length=32)
    status: str | None = Field(default=None, max_length=32)

    location_desc: str | None = Field(default=None, max_length=255)

    longitude: float | None = None
    latitude: float | None = None

    cpu_usage: float | None = None
    ram_usage: float | None = None
    disk_usage: float | None = None
    net_bandwidth: float | None = None
    gpu_usage: float | None = None

    last_heartbeat: datetime | None = None


class ServerRead(ServerBase):
    id: str
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# =========================
# NetworkNode
# =========================

class NetworkNodeBase(BaseModel):
    name: str = Field(..., max_length=128)
    ip: str | None = Field(default=None, max_length=45)

    node_type: str = Field(..., max_length=32)
    status: str = Field(..., max_length=32)

    vendor: str | None = Field(default=None, max_length=64)
    model: str | None = Field(default=None, max_length=128)

    location_desc: str | None = Field(default=None, max_length=255)

    longitude: float | None = None
    latitude: float | None = None

    cpu_usage: float | None = None
    ram_usage: float | None = None
    net_bandwidth: float | None = None

    last_heartbeat: datetime | None = None


class NetworkNodeCreate(NetworkNodeBase):
    id: str = Field(..., max_length=64)


class NetworkNodeUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=128)
    ip: str | None = Field(default=None, max_length=45)

    node_type: str | None = Field(default=None, max_length=32)
    status: str | None = Field(default=None, max_length=32)

    vendor: str | None = Field(default=None, max_length=64)
    model: str | None = Field(default=None, max_length=128)

    location_desc: str | None = Field(default=None, max_length=255)

    longitude: float | None = None
    latitude: float | None = None

    cpu_usage: float | None = None
    ram_usage: float | None = None
    net_bandwidth: float | None = None

    last_heartbeat: datetime | None = None


class NetworkNodeRead(NetworkNodeBase):
    id: str
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# =========================
# Camera
# =========================

class CameraBase(BaseModel):
    name: str = Field(..., max_length=128)

    model: str | None = Field(default=None, max_length=128)
    vendor: str | None = Field(default=None, max_length=64)

    ip: str = Field(..., max_length=45)
    status: str = Field(..., max_length=32)

    protocol: str | None = Field(default=None, max_length=16)
    codec: str | None = Field(default=None, max_length=32)
    stream_type: str | None = Field(default=None, max_length=32)
    access_type: str | None = Field(default=None, max_length=32)

    unit: str | None = Field(default=None, max_length=128)
    manager: str | None = Field(default=None, max_length=128)

    # 四级行政区字段。摄像机必须明确挂到一个乡级行政区下。
    province_code: str = Field(..., max_length=64)
    province_name: str = Field(..., max_length=64)

    city_code: str = Field(..., max_length=64)
    city_name: str = Field(..., max_length=64)

    county_code: str = Field(..., max_length=64)
    county_name: str = Field(..., max_length=64)

    town_code: str = Field(..., max_length=64)
    town_name: str = Field(..., max_length=64)

    location_desc: str | None = Field(default=None, max_length=255)

    longitude: float | None = None
    latitude: float | None = None

    server_id: str | None = Field(default=None, max_length=64)

    video_url: str | None = Field(default=None, max_length=512)

    last_heartbeat: datetime | None = None


class CameraCreate(CameraBase):
    id: str = Field(..., max_length=64)


class CameraUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=128)

    model: str | None = Field(default=None, max_length=128)
    vendor: str | None = Field(default=None, max_length=64)

    ip: str | None = Field(default=None, max_length=45)
    status: str | None = Field(default=None, max_length=32)

    protocol: str | None = Field(default=None, max_length=16)
    codec: str | None = Field(default=None, max_length=32)
    stream_type: str | None = Field(default=None, max_length=32)
    access_type: str | None = Field(default=None, max_length=32)

    unit: str | None = Field(default=None, max_length=128)
    manager: str | None = Field(default=None, max_length=128)

    province_code: str | None = Field(default=None, max_length=64)
    province_name: str | None = Field(default=None, max_length=64)

    city_code: str | None = Field(default=None, max_length=64)
    city_name: str | None = Field(default=None, max_length=64)

    county_code: str | None = Field(default=None, max_length=64)
    county_name: str | None = Field(default=None, max_length=64)

    town_code: str | None = Field(default=None, max_length=64)
    town_name: str | None = Field(default=None, max_length=64)

    location_desc: str | None = Field(default=None, max_length=255)

    longitude: float | None = None
    latitude: float | None = None

    server_id: str | None = Field(default=None, max_length=64)

    video_url: str | None = Field(default=None, max_length=512)

    last_heartbeat: datetime | None = None


class CameraRead(CameraBase):
    id: str
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# =========================
# StreamMedia
# =========================

class StreamMediaBase(BaseModel):
    source_ip: str = Field(..., max_length=45)
    source_port: int

    destination_ip: str = Field(..., max_length=45)
    destination_port: int

    ssrc: str = Field(..., max_length=64)

    camera_id: str | None = Field(default=None, max_length=64)
    server_id: str | None = Field(default=None, max_length=64)

    codec: str | None = Field(default=None, max_length=32)
    resolution: str | None = Field(default=None, max_length=32)
    frame_rate: float | None = None

    real_time_bitrate: float | None = None
    throughput: float | None = None
    latency: float | None = None
    jitter: float | None = None
    packet_loss_rate: float | None = None
    qoe_score: float | None = None

    transport_protocol: str | None = Field(default=None, max_length=16)

    is_connected: bool = True
    is_fault: bool = False

    link_type: str | None = Field(default=None, max_length=32)
    stream_type: str | None = Field(default=None, max_length=32)

    last_update_time: datetime | None = None


class StreamMediaCreate(StreamMediaBase):
    id: str = Field(..., max_length=64)


class StreamMediaUpdate(BaseModel):
    source_ip: str | None = Field(default=None, max_length=45)
    source_port: int | None = None

    destination_ip: str | None = Field(default=None, max_length=45)
    destination_port: int | None = None

    ssrc: str | None = Field(default=None, max_length=64)

    camera_id: str | None = Field(default=None, max_length=64)
    server_id: str | None = Field(default=None, max_length=64)

    codec: str | None = Field(default=None, max_length=32)
    resolution: str | None = Field(default=None, max_length=32)
    frame_rate: float | None = None

    real_time_bitrate: float | None = None
    throughput: float | None = None
    latency: float | None = None
    jitter: float | None = None
    packet_loss_rate: float | None = None
    qoe_score: float | None = None

    transport_protocol: str | None = Field(default=None, max_length=16)

    is_connected: bool | None = None
    is_fault: bool | None = None

    link_type: str | None = Field(default=None, max_length=32)
    stream_type: str | None = Field(default=None, max_length=32)

    last_update_time: datetime | None = None


class StreamMediaRead(StreamMediaBase):
    id: str
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# =========================
# TopologyLink
# =========================

class TopologyLinkBase(BaseModel):
    source_type: TopologyEntityType
    source_id: str = Field(..., max_length=64)

    target_type: TopologyEntityType
    target_id: str = Field(..., max_length=64)

    link_type: str | None = Field(default=None, max_length=32)

    status: str = Field(default="normal", max_length=32)

    bandwidth_usage: float | None = None
    latency: float | None = None
    packet_loss_rate: float | None = None


class TopologyLinkCreate(TopologyLinkBase):
    id: str = Field(..., max_length=64)


class TopologyLinkUpdate(BaseModel):
    source_type: TopologyEntityType | None = None
    source_id: str | None = Field(default=None, max_length=64)

    target_type: TopologyEntityType | None = None
    target_id: str | None = Field(default=None, max_length=64)

    link_type: str | None = Field(default=None, max_length=32)

    status: str | None = Field(default=None, max_length=32)

    bandwidth_usage: float | None = None
    latency: float | None = None
    packet_loss_rate: float | None = None


class TopologyLinkRead(TopologyLinkBase):
    id: str
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class TopologyNodeRead(BaseModel):
    id: str
    type: TopologyEntityType
    name: str
    status: str
    node_type: str | None = None
    ip: str | None = None
    longitude: float | None = None
    latitude: float | None = None


class TopologyGraphRead(BaseModel):
    nodes: list[TopologyNodeRead]
    links: list[TopologyLinkRead]


# =========================
# FaultEvent
# =========================

class FaultEventBase(BaseModel):
    title: str = Field(..., max_length=128)

    entity_id: str = Field(..., max_length=64)
    entity_type: EntityType

    category_l1: str | None = Field(default=None, max_length=64)
    category_l2: str | None = Field(default=None, max_length=64)
    category_l3: str | None = Field(default=None, max_length=64)

    fault_code: str = Field(..., max_length=64)
    fault_desc: str = Field(..., max_length=255)

    level: str = Field(..., max_length=16)
    status: str = Field(..., max_length=16)

    confidence: float | None = None

    trigger_time: datetime
    end_time: datetime | None = None

    handler: str | None = Field(default=None, max_length=64)
    ack_time: datetime | None = None
    resolved_by: str | None = Field(default=None, max_length=64)

    metrics_snapshot: dict[str, Any] | None = None
    repair_strategy: dict[str, Any] | None = None


class FaultEventCreate(FaultEventBase):
    id: str = Field(..., max_length=64)


class FaultEventUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=128)

    entity_id: str | None = Field(default=None, max_length=64)
    entity_type: EntityType | None = None

    category_l1: str | None = Field(default=None, max_length=64)
    category_l2: str | None = Field(default=None, max_length=64)
    category_l3: str | None = Field(default=None, max_length=64)

    fault_code: str | None = Field(default=None, max_length=64)
    fault_desc: str | None = Field(default=None, max_length=255)

    level: str | None = Field(default=None, max_length=16)
    status: str | None = Field(default=None, max_length=16)

    confidence: float | None = None

    trigger_time: datetime | None = None
    end_time: datetime | None = None

    handler: str | None = Field(default=None, max_length=64)
    ack_time: datetime | None = None
    resolved_by: str | None = Field(default=None, max_length=64)

    metrics_snapshot: dict[str, Any] | None = None
    repair_strategy: dict[str, Any] | None = None


class FaultEventRead(FaultEventBase):
    id: str
    duration_seconds: int | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# =========================
# RootCause
# =========================

class RootCauseBase(BaseModel):
    description: str = Field(..., max_length=255)
    fault_event_id: str = Field(..., max_length=64)
    device_type: str = Field(..., max_length=32)


class RootCauseCreate(RootCauseBase):
    id: str = Field(..., max_length=64)


class RootCauseUpdate(BaseModel):
    description: str | None = Field(default=None, max_length=255)
    fault_event_id: str | None = Field(default=None, max_length=64)
    device_type: str | None = Field(default=None, max_length=32)


class RootCauseRead(RootCauseBase):
    id: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


# =========================
# WorkOrder
# =========================

class WorkOrderBase(BaseModel):
    title: str = Field(..., max_length=128)
    description: str | None = Field(default=None, max_length=512)

    order_type: str = Field(default="manual", max_length=32)
    priority: str = Field(default="medium", max_length=16)
    status: str = Field(default="pending", max_length=16)
    source: str | None = Field(default="manual", max_length=32)

    related_entity_type: WorkOrderEntityType | None = None
    related_entity_id: str | None = Field(default=None, max_length=64)
    related_entity_name: str | None = Field(default=None, max_length=128)

    region_code: str | None = Field(default=None, max_length=64)
    region_name: str | None = Field(default=None, max_length=64)
    region_level: RegionLevel | None = None
    region_path: str | None = Field(default=None, max_length=255)

    assignee: str | None = Field(default=None, max_length=64)
    creator: str | None = Field(default=None, max_length=64)
    reviewer: str | None = Field(default=None, max_length=64)

    sla_deadline: datetime | None = None
    accepted_at: datetime | None = None
    closed_at: datetime | None = None

    last_action: str | None = Field(default=None, max_length=255)
    resolution: str | None = Field(default=None, max_length=512)
    timeline: list[dict[str, Any]] | None = None


class WorkOrderCreate(WorkOrderBase):
    id: str | None = Field(default=None, max_length=64)


class WorkOrderUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=128)
    description: str | None = Field(default=None, max_length=512)

    order_type: str | None = Field(default=None, max_length=32)
    priority: str | None = Field(default=None, max_length=16)
    status: str | None = Field(default=None, max_length=16)
    source: str | None = Field(default=None, max_length=32)

    related_entity_type: WorkOrderEntityType | None = None
    related_entity_id: str | None = Field(default=None, max_length=64)
    related_entity_name: str | None = Field(default=None, max_length=128)

    region_code: str | None = Field(default=None, max_length=64)
    region_name: str | None = Field(default=None, max_length=64)
    region_level: RegionLevel | None = None
    region_path: str | None = Field(default=None, max_length=255)

    assignee: str | None = Field(default=None, max_length=64)
    creator: str | None = Field(default=None, max_length=64)
    reviewer: str | None = Field(default=None, max_length=64)

    sla_deadline: datetime | None = None
    accepted_at: datetime | None = None
    closed_at: datetime | None = None

    last_action: str | None = Field(default=None, max_length=255)
    resolution: str | None = Field(default=None, max_length=512)
    timeline: list[dict[str, Any]] | None = None


class WorkOrderRead(WorkOrderBase):
    id: str
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# =========================
# VideoDiagnosis
# =========================

class VideoDiagnosisRead(BaseModel):
    id: str
    camera_id: str
    work_order_id: str | None = None
    camera_name: str | None = None
    camera_status: str | None = None
    started_at: datetime
    ended_at: datetime | None = None
    health_score: int | None = None
    business_status: str | None = None
    abnormal_type: str | None = None
    root_cause_type: str | None = None
    root_cause_node: str | None = None
    root_cause_metric: str | None = None
    conclusion: str | None = None
    suggestion: str | None = None
    ping_output: str | None = None
    steps: list[dict[str, Any]] | None = None
    topology: dict[str, Any] | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


# =========================
# Dashboard
# =========================

class DashboardSummaryRead(BaseModel):
    region_count: int
    server_count: int
    network_node_count: int
    camera_count: int
    online_camera_count: int
    offline_camera_count: int
    stream_count: int
    fault_stream_count: int
    active_fault_count: int
    critical_fault_count: int

    avg_cpu_usage: float
    avg_ram_usage: float
    avg_latency: float
    avg_packet_loss_rate: float
    avg_qoe_score: float


class StatisticsOverviewRead(BaseModel):
    generated_at: datetime
    scope: dict[str, Any]
    device_status: dict[str, dict[str, int]]
    golden_metrics: dict[str, Any]
    kqi_degradation: list[dict[str, Any]]
    anomaly_trend: list[dict[str, Any]]
    work_order_trend: list[dict[str, Any]]
    anomaly_patterns: list[dict[str, Any]]
    anomaly_entities: list[dict[str, Any]]
    work_order_efficiency: dict[str, Any]


# =========================
# DeviceGroup
# =========================

class DeviceGroupBase(BaseModel):
    name: str = Field(..., max_length=64)
    parent_id: str | None = Field(default=None, max_length=64)
    sort_order: int = 0


class DeviceGroupCreate(DeviceGroupBase):
    camera_ids: list[str] = Field(default_factory=list)


class DeviceGroupUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=64)
    parent_id: str | None = None
    sort_order: int | None = None
    camera_ids: list[str] | None = None


class DeviceGroupRead(DeviceGroupBase):
    id: str
    created_at: datetime
    updated_at: datetime
    cameras: list[CameraRead] = Field(default_factory=list)
    model_config = ConfigDict(from_attributes=True)


class DeviceGroupTreeNode(DeviceGroupRead):
    children: list["DeviceGroupTreeNode"] = Field(default_factory=list)
    camera_count: int = 0
