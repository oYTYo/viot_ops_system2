import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  Camera,
  Activity,
  ChevronDown,
  ChevronRight,
  Edit3,
  Eye,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Server,
  Trash2,
  Zap,
  X,
} from "lucide-react";
import {
  createDeviceCamera,
  createDeviceServer,
  deleteDeviceCamera,
  deleteDeviceServer,
  getDeviceCameras,
  getDeviceServers,
  getDeviceStreams,
  updateDeviceCamera,
  updateDeviceServer,
} from "../services/deviceApi";
import { getRegionByCode, getRegions } from "../services/regionApi";
import { getCameraPreview } from "../services/videoApi";
import { getLatestVideoDiagnosis, runVideoDiagnosis } from "../services/diagnosisApi";
import { getStatisticsOverview } from "../services/statisticsApi";
import { applyAlgorithmChainlist, getAlgorithmActiveFlows, refreshAlgorithmActiveFlows } from "../services/algorithmApi";
import LivePlayer from "../components/LivePlayer";

const cameraInitialForm = {
  id: "",
  name: "",
  ip: "",
  status: "online",
  protocol: "RTSP",
  codec: "H.264",
  stream_type: "main",
  access_type: "Ethernet",
  model: "",
  vendor: "",
  unit: "",
  manager: "",
  province_code: "",
  province_name: "",
  city_code: "",
  city_name: "",
  county_code: "",
  county_name: "",
  town_code: "",
  town_name: "",
  location_desc: "",
  longitude: "",
  latitude: "",
  server_id: "",
  video_url: "",
};

const serverInitialForm = {
  id: "",
  name: "",
  ip: "",
  node_type: "stream_server",
  status: "normal",
  location_desc: "",
  longitude: "",
  latitude: "",
  cpu_usage: "",
  ram_usage: "",
  disk_usage: "",
  net_bandwidth: "",
  gpu_usage: "",
};

function emptyToNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function toNumberOrNull(value) {
  const text = emptyToNull(value);
  if (text === null) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function formatValue(value, fallback = "-") {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}

function formatStreamSsrc(value, fallback = "-") {
  if (value === null || value === undefined || value === "") return fallback;
  const text = String(value).trim();
  if (!text) return fallback;
  if (/^(ssrc-|fake-ssrc-|alarm-demo-ssrc-)/i.test(text)) return fallback;
  return text;
}

function formatStreamSsrcHex(value, fallback = "-") {
  const text = formatStreamSsrc(value, fallback);
  if (text === fallback) return fallback;
  if (/^0x/i.test(text)) return text.toLowerCase();
  const parsed = Number(text);
  return Number.isFinite(parsed) ? `0x${Math.trunc(parsed).toString(16)}` : text;
}

function cameraStatusText(status) {
  if (status === "offline") return "离线";
  if (status === "fault") return "异常";
  return "在线";
}

function serverStatusText(status) {
  if (status === "offline") return "离线";
  if (status === "fault") return "异常";
  if (status === "warning") return "告警";
  return "正常";
}

function streamStatusText(stream) {
  if (!stream.is_connected) return "断开";
  if (stream.is_fault) return "异常";
  return "正常";
}

function segmentDirectionText(direction) {
  if (direction === "uplink") return "上行";
  if (direction === "downlink") return "下行";
  return direction || "未知";
}

function segmentStatusText(segment) {
  if (segment.status === "offline") return "未连通";
  if (segment.is_fault) return "异常";
  return "正常";
}

function formatEndpoint(endpoint = {}) {
  const ip = endpoint.ip_src || endpoint.source_ip || "-";
  const port = endpoint.port_src || endpoint.source_port;
  return port ? `${ip}:${port}` : ip;
}

function formatDestination(endpoint = {}) {
  const ip = endpoint.ip_dst || endpoint.destination_ip || "-";
  const port = endpoint.port_dst || endpoint.destination_port;
  return port ? `${ip}:${port}` : ip;
}

const CONNECTED_FLOW_STATUSES = new Set(["online", "connected", "normal", "collectable"]);

function isActiveFlowConnected(flow) {
  if (flow.collectable === false) return false;
  const status = String(flow.connectivity_status || flow.status || "").trim().toLowerCase();
  if (!status) return Boolean(flow.collectable);
  return CONNECTED_FLOW_STATUSES.has(status);
}

function normalizeKeyPart(value) {
  return String(value || "").trim().toLowerCase();
}

function buildStreamIdentity(stream) {
  return [
    stream.camera_id || stream.device_id || stream.display_id,
    stream.source_ip,
    stream.source_port,
    stream.destination_ip || stream.server_id,
    stream.destination_port,
    stream.ssrc,
  ].map(normalizeKeyPart).join("|");
}

function normalizeMatchFlowToStream(flow) {
  const uplink = flow.uplink || {};
  const downlinks = Array.isArray(flow.downlink) ? flow.downlink : [];
  const ssrc = uplink.ssrc_hex || uplink.ssrc || "";
  const connected = isActiveFlowConnected(flow);
  const segments = [
    ...(uplink.ip_src || uplink.ip_dst
      ? [
          {
            id: `${flow.device_id}-uplink`,
            direction: "uplink",
            source_ip: uplink.ip_src,
            source_port: uplink.port_src,
            destination_ip: uplink.ip_dst,
            destination_port: uplink.port_dst,
            ssrc,
            status: connected ? "online" : "config_missing",
            is_fault: flow.detection_status === "anomaly",
          },
        ]
      : []),
    ...downlinks.map((item, index) => ({
      id: `${flow.device_id}-downlink-${index}`,
      direction: "downlink",
      source_ip: item.ip_src,
      source_port: item.port_src,
      destination_ip: item.ip_dst,
      destination_port: item.port_dst,
      ssrc: item.ssrc_hex || item.ssrc || ssrc,
      status: connected ? "online" : "config_missing",
      is_fault: flow.detection_status === "anomaly",
    })),
  ];

  return {
    id: `active-${flow.device_id}`,
    display_id: flow.device_id,
    device_id: flow.device_id,
    camera_id: flow.device_id,
    camera_name: flow.camera_name,
    server_id: flow.server_ip || "",
    source_ip: uplink.ip_src || flow.camera_ip || "",
    source_port: uplink.port_src || "",
    destination_ip: uplink.ip_dst || flow.server_ip || "",
    destination_port: uplink.port_dst || "",
    ssrc,
    is_connected: connected,
    is_fault: flow.detection_status === "anomaly",
    link_type: "match活跃流",
    stream_type: "实时识别",
    active_flow: flow,
    segments,
  };
}

function getCameraIdFromNode(camera) {
  return camera?.cameraId || camera?.camera_id || camera?.id?.replace(/^camera-/, "") || "";
}

function buildStatisticsScopeParams(focusTarget) {
  if (!focusTarget) return {};
  if (focusTarget.nodeType === "camera" && focusTarget.cameraId) {
    return { camera_id: focusTarget.cameraId };
  }
  if (focusTarget.nodeType === "custom_folder") {
    const cameraIds = (focusTarget.children || [])
      .map(getCameraIdFromNode)
      .filter(Boolean);
    return cameraIds.length ? { camera_ids: cameraIds.join(",") } : {};
  }
  if (focusTarget.nodeType !== "camera" && focusTarget.regionCode) {
    return { region_code: focusTarget.regionCode };
  }
  return {};
}

function formatStatusMetricValue(status, unit, onlineLabel = "online") {
  const normal = Number(status?.normal || 0);
  const fault = Number(status?.fault || 0);
  const offline = Number(status?.offline || 0);
  const total = Number(status?.total || 0);
  const active = onlineLabel === "normal" ? normal : Math.max(0, total - offline);
  return `${active}/${total} ${unit}`;
}

function streamStatusClass(stream) {
  if (!stream.is_connected) return statusClass("offline");
  if (stream.is_fault) return statusClass("fault");
  return statusClass("normal");
}

function statusClass(status) {
  if (status === "offline") return "border-[var(--color-panel-border)] text-[var(--color-text-muted)] bg-[var(--color-control-bg)]";
  if (status === "fault") return "border-[var(--color-error-text)] text-[var(--color-error-text)] bg-[var(--color-error-bg)]";
  if (status === "warning") return "border-amber-500 text-amber-600 bg-amber-500/10";
  return "border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-hover-bg)]";
}

function normalizeCameraForm(camera) {
  return {
    ...cameraInitialForm,
    ...camera,
    server_id: camera.server_id || "",
    longitude: camera.longitude ?? "",
    latitude: camera.latitude ?? "",
  };
}

function normalizeServerForm(server) {
  return {
    ...serverInitialForm,
    ...server,
    longitude: server.longitude ?? "",
    latitude: server.latitude ?? "",
    cpu_usage: server.cpu_usage ?? "",
    ram_usage: server.ram_usage ?? "",
    disk_usage: server.disk_usage ?? "",
    net_bandwidth: server.net_bandwidth ?? "",
    gpu_usage: server.gpu_usage ?? "",
  };
}

function buildCameraPayload(form, selectedRegion) {
  const regionPatch =
    selectedRegion?.nodeType === "region"
      ? {
          [`${selectedRegion.level}_code`]: selectedRegion.regionCode,
          [`${selectedRegion.level}_name`]: selectedRegion.name,
        }
      : {};

  const payload = {
    ...form,
    ...regionPatch,
    model: emptyToNull(form.model),
    vendor: emptyToNull(form.vendor),
    protocol: emptyToNull(form.protocol),
    codec: emptyToNull(form.codec),
    stream_type: emptyToNull(form.stream_type),
    access_type: emptyToNull(form.access_type),
    unit: emptyToNull(form.unit),
    manager: emptyToNull(form.manager),
    location_desc: emptyToNull(form.location_desc),
    longitude: toNumberOrNull(form.longitude),
    latitude: toNumberOrNull(form.latitude),
    server_id: emptyToNull(form.server_id),
    video_url: emptyToNull(form.video_url),
  };

  return payload;
}

function buildServerPayload(form) {
  return {
    ...form,
    location_desc: emptyToNull(form.location_desc),
    longitude: toNumberOrNull(form.longitude),
    latitude: toNumberOrNull(form.latitude),
    cpu_usage: toNumberOrNull(form.cpu_usage),
    ram_usage: toNumberOrNull(form.ram_usage),
    disk_usage: toNumberOrNull(form.disk_usage),
    net_bandwidth: toNumberOrNull(form.net_bandwidth),
    gpu_usage: toNumberOrNull(form.gpu_usage),
  };
}

function filterByKeyword(items, keyword, fields) {
  const value = keyword.trim().toLowerCase();
  if (!value) return items;

  return items.filter((item) =>
    fields.some((field) => String(item[field] || "").toLowerCase().includes(value))
  );
}

const filterByStatus = (items, type, statusFilter) => {
  if (statusFilter === "all") return items;
  return items.filter(item => {
    if (type === "camera") {
      const mappedStatus = item.status === "online" ? "normal" : item.status;
      return mappedStatus === statusFilter;
    }
    if (type === "server") {
      const mappedStatus = (item.status === "warning" || item.status === "fault") ? "fault" : item.status;
      return mappedStatus === statusFilter;
    }
    if (type === "stream") {
      let mappedStatus = "normal";
      if (!item.is_connected) mappedStatus = "offline";
      else if (item.is_fault) mappedStatus = "fault";
      return mappedStatus === statusFilter;
    }
    return true;
  });
};

function validateRequiredFields(form, fields) {
  const missing = fields.find(({ key }) => !emptyToNull(form[key]));
  return missing ? `请填写${missing.label}` : "";
}

function MetricCard({ icon: Icon, label, value }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-[var(--layout-content-gap)] rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-[var(--layout-content-padding)] py-[var(--layout-search-padding-y)] shadow-[var(--shadow-panel)]">
      <div className="flex min-w-0 items-center gap-[var(--layout-search-gap)]">
        <Icon size="var(--icon-topbar)" className="shrink-0 text-[var(--color-accent)]" />
        <span className="whitespace-nowrap text-ui-medium font-semibold text-[var(--color-text-main)]">{label}</span>
      </div>
      <span className="shrink-0 whitespace-nowrap text-ui-large font-bold text-[var(--color-accent)]">{value}</span>
    </div>
  );
}

function DeviceTable({ columns, rows, emptyText, onView, onEdit, onDelete, onDiagnose, readonly = false, renderExpanded = null, selection = null }) {
  const [expandedRows, setExpandedRows] = useState(() => new Set());
  const hasExpanded = typeof renderExpanded === "function";
  const hasSelection = Boolean(selection);
  const extraColumnCount = 1 + (onDiagnose ? 1 : 0) + (hasExpanded ? 1 : 0) + (hasSelection ? 1 : 0);

  const toggleExpanded = (rowId) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)]">
      <table className="w-max min-w-full border-separate border-spacing-0 text-left text-ui-medium">
        <thead className="sticky top-0 z-10 bg-[var(--color-control-bg)] text-[var(--color-text-muted)]">
          <tr>
            {hasSelection && (
              <th className="w-[4.2rem] whitespace-nowrap border-b border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] py-[var(--layout-device-table-padding-y)] font-semibold">采集</th>
            )}
            {hasExpanded && (
              <th className="w-[4.2rem] whitespace-nowrap border-b border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] py-[var(--layout-device-table-padding-y)] font-semibold">展开</th>
            )}
            {columns.map((column) => (
              <th key={column.key} className={`whitespace-nowrap border-b border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] py-[var(--layout-device-table-padding-y)] font-semibold ${column.className || "min-w-[12rem]"}`}>
                {column.label}
              </th>
            ))}
            {onDiagnose && (
              <th className="sticky right-[10rem] z-20 min-w-[10rem] whitespace-nowrap border-b border-l border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-device-table-padding-y)] font-semibold shadow-[-0.75rem_0_1rem_rgba(0,0,0,0.08)]">
                根因诊断
              </th>
            )}
            <th className="sticky right-0 z-20 min-w-[10rem] whitespace-nowrap border-b border-l border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-device-table-padding-y)] font-semibold shadow-[-0.75rem_0_1rem_rgba(0,0,0,0.08)]">
              操作
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length + extraColumnCount} className="px-[var(--layout-content-padding)] py-[var(--layout-content-padding)] text-center text-[var(--color-text-muted)]">
                {emptyText}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <Fragment key={row.id}>
                <tr className="text-[var(--color-text-main)] hover:bg-[var(--color-hover-bg)]">
                  {hasSelection && (
                    <td className="whitespace-nowrap border-b border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] py-[var(--layout-device-table-padding-y)]">
                      <input type="checkbox" checked={selection.selectedIds.has(row.id)} disabled={selection.isDisabled ? selection.isDisabled(row) : false} onChange={(event) => selection.onToggle(row, event.target.checked)} className="h-[1rem] w-[1rem] accent-[var(--color-accent)]" />
                    </td>
                  )}
                  {hasExpanded && (
                    <td className="whitespace-nowrap border-b border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] py-[var(--layout-device-table-padding-y)]">
                      <button type="button" title={expandedRows.has(row.id) ? "收起链路详情" : "展开链路详情"} onClick={() => toggleExpanded(row.id)} className="grid rounded-[var(--layout-radius-sm)] p-[var(--layout-tree-action-padding)] text-[var(--color-icon-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-accent)]">
                        {expandedRows.has(row.id) ? <ChevronDown size="var(--icon-tree-main)" /> : <ChevronRight size="var(--icon-tree-main)" />}
                      </button>
                    </td>
                  )}
                  {columns.map((column) => (
                    <td key={column.key} className={`whitespace-nowrap border-b border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] py-[var(--layout-device-table-padding-y)] ${column.className || "min-w-[12rem]"}`}>
                      {column.render ? column.render(row) : formatValue(row[column.key])}
                    </td>
                  ))}
                  {onDiagnose && (
                    <td className="sticky right-[10rem] z-10 whitespace-nowrap border-b border-l border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-device-table-padding-y)] shadow-[-0.75rem_0_1rem_rgba(0,0,0,0.08)]">
                      <button type="button" onClick={() => onDiagnose(row)} className="flex items-center gap-[var(--layout-reset-tooltip-gap)] rounded-[var(--layout-radius-sm)] bg-[var(--color-topbar-active-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-reset-padding-y)] text-ui-small font-medium text-[var(--color-topbar-active-text)]">
                        <Zap size="var(--icon-bottom)" />
                        诊断
                      </button>
                    </td>
                  )}
                  <td className="sticky right-0 z-10 whitespace-nowrap border-b border-l border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-device-table-padding-y)] shadow-[-0.75rem_0_1rem_rgba(0,0,0,0.08)]">
                    <div className="flex items-center gap-[var(--layout-search-gap)]">
                      <button type="button" title="详情" onClick={() => onView(row)} className="rounded-[var(--layout-radius-sm)] p-[var(--layout-tree-action-padding)] text-[var(--color-icon-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-accent)]">
                        <Eye size="var(--icon-tree-main)" />
                      </button>
                      {!readonly && (
                        <>
                          <button type="button" title="编辑" onClick={() => onEdit(row)} className="rounded-[var(--layout-radius-sm)] p-[var(--layout-tree-action-padding)] text-[var(--color-icon-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-accent)]">
                            <Edit3 size="var(--icon-tree-main)" />
                          </button>
                          <button type="button" title="删除" onClick={() => onDelete(row)} className="rounded-[var(--layout-radius-sm)] p-[var(--layout-tree-action-padding)] text-[var(--color-icon-muted)] hover:bg-[var(--color-error-bg)] hover:text-[var(--color-error-text)]">
                            <Trash2 size="var(--icon-tree-main)" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
                {hasExpanded && expandedRows.has(row.id) && (
                  <tr className="bg-[var(--color-control-bg)]">
                    <td colSpan={columns.length + extraColumnCount} className="border-b border-[var(--color-panel-border)] px-[var(--layout-content-padding)] py-[var(--layout-content-gap)]">
                      {renderExpanded(row)}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function StreamSegmentTable({ stream }) {
  const segments = Array.isArray(stream.segments) ? stream.segments : [];
  const uplinkSegments = segments.filter((segment) => segment.direction === "uplink");
  const downlinkSegments = segments.filter((segment) => segment.direction === "downlink");
  const endpointText = (ip, port) => {
    const cleanIp = ip === null || ip === undefined || ip === "" ? "缺失" : String(ip);
    const cleanPort = port === null || port === undefined || port === "" ? "" : String(port);
    return cleanPort ? `${cleanIp}:${cleanPort}` : cleanIp;
  };
  const segmentLine = (segment) => `${endpointText(segment.source_ip, segment.source_port)} -> ${endpointText(segment.destination_ip, segment.destination_port)}`;
  const statusBadgeClass = (segment) => `inline-flex items-center rounded-[var(--layout-radius-sm)] border px-[var(--layout-tree-action-padding)] ${segment.is_fault ? statusClass("fault") : segment.status === "offline" ? statusClass("offline") : statusClass("normal")}`;

  if (!segments.length) {
    return <div className="rounded-[var(--layout-radius-sm)] border border-dashed border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-gap)] text-ui-small text-[var(--color-text-muted)]">暂无上下行网络段</div>;
  }

  const uplink = uplinkSegments[0];

  return (
    <div className="rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] text-[var(--color-text-main)] shadow-[0_0_0_1px_rgba(255,255,255,0.03)_inset]">
      <div className="flex flex-col gap-[var(--layout-search-gap)] px-[var(--layout-content-gap)] py-[var(--layout-content-gap)]">
        <div className="rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] p-[var(--layout-search-gap)]">
          <div className="mb-[var(--layout-search-gap)] flex items-center justify-between gap-[var(--layout-search-gap)]">
            <div>
              <div className="text-ui-small text-[var(--color-text-muted)]">上行链路</div>
              <div className="text-ui-medium font-semibold text-[var(--color-text-main)]">摄像机 -&gt; 服务器</div>
            </div>
            <span className="rounded-full border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-[var(--layout-tree-action-padding)] py-[var(--layout-reset-padding-y)] text-ui-small text-[var(--color-text-muted)]">{uplink ? 1 : 0} 条</span>
          </div>
          {uplink ? (
            <div className="rounded-[var(--layout-radius-sm)] bg-[var(--color-panel-bg)] p-[var(--layout-search-gap)]">
              <div className="flex flex-wrap items-center gap-[var(--layout-search-gap)] text-ui-small">
                <span className="rounded-full bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-reset-padding-y)] font-mono text-[var(--color-text-main)]">{endpointText(uplink.source_ip, uplink.source_port)}</span>
                <span className="text-[var(--color-text-muted)]">-&gt;</span>
                <span className="rounded-full bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-reset-padding-y)] font-mono text-[var(--color-text-main)]">{endpointText(uplink.destination_ip, uplink.destination_port)}</span>
                <span className={statusBadgeClass(uplink)}>{segmentStatusText(uplink)}</span>
                <span className="rounded-full bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-reset-padding-y)] font-mono text-[var(--color-text-main)]">SSRC {formatStreamSsrcHex(uplink.ssrc)}</span>
              </div>
            </div>
          ) : (
            <div className="rounded-[var(--layout-radius-sm)] border border-dashed border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-gap)] text-ui-small text-[var(--color-text-muted)]">暂无上行网络段</div>
          )}
        </div>

        <div className="rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] p-[var(--layout-search-gap)]">
          <div className="mb-[var(--layout-search-gap)] flex items-center justify-between gap-[var(--layout-search-gap)]">
            <div>
              <div className="text-ui-small text-[var(--color-text-muted)]">下行链路</div>
              <div className="text-ui-medium font-semibold text-[var(--color-text-main)]">服务器 -&gt; 播放端</div>
            </div>
            <span className="rounded-full border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-[var(--layout-tree-action-padding)] py-[var(--layout-reset-padding-y)] text-ui-small text-[var(--color-text-muted)]">{downlinkSegments.length} 条</span>
          </div>
          {downlinkSegments.length ? (
            <div className="grid gap-[var(--layout-search-gap)]">
              {downlinkSegments.map((segment, index) => (
                <div key={segment.id ?? `${segment.direction}-${index}`} className="rounded-[var(--layout-radius-sm)] bg-[var(--color-panel-bg)] p-[var(--layout-search-gap)]">
                  <div className="flex flex-wrap items-center justify-between gap-[var(--layout-search-gap)] text-ui-small">
                    <div className="font-medium text-[var(--color-text-main)]">下行 {index + 1}</div>
                    <span className={statusBadgeClass(segment)}>{segmentStatusText(segment)}</span>
                  </div>
                  <div className="mt-[var(--layout-search-gap)] flex flex-wrap items-center gap-[var(--layout-search-gap)] text-ui-small">
                    <span className="rounded-full bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-reset-padding-y)] font-mono text-[var(--color-text-main)]">{segmentLine(segment)}</span>
                    <span className="rounded-full bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-reset-padding-y)] font-mono text-[var(--color-text-main)]">SSRC {formatStreamSsrcHex(segment.ssrc)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-[var(--layout-radius-sm)] border border-dashed border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-gap)] text-ui-small text-[var(--color-text-muted)]">暂无下行网络段</div>
          )}
        </div>
      </div>
    </div>
  );
}

function RollingTrend({ lines, shaded = false }) {
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full" aria-hidden="true">
      <line x1="0" y1="50" x2="100" y2="50" stroke="currentColor" className="text-[var(--color-panel-border)]" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
      <line x1="0" y1="100" x2="100" y2="100" stroke="currentColor" className="text-[var(--color-panel-border)]" vectorEffect="non-scaling-stroke" />
      {lines.map((line) => {
        const points = line.values.map((value, index) => `${(index / Math.max(line.values.length - 1, 1)) * 100},${100 - value}`).join(" ");
        const areaPoints = `0,100 ${points} 100,100`;
        return (
          <g key={line.key} className={line.className || "text-[var(--color-accent)]"}>
            {shaded && <polygon points={areaPoints} fill="currentColor" opacity="0.12" />}
            <polyline points={points} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </g>
        );
      })}
    </svg>
  );
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function bumpValue(value, min, max, step) {
  const next = value + (Math.random() * step * 2 - step);
  return Math.max(min, Math.min(max, next));
}

function directionalBump(value, min, max, step) {
  if (Math.random() > 0.3) return value;
  const direction = Math.random() > 0.5 ? 1 : -1;
  return Math.max(min, Math.min(max, value + direction * (Math.random() * step)));
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
}

function useRollingValues(initialValues, { min = 0, max = 100, step = 8, active = true } = {}) {
  const [values, setValues] = useState(initialValues);

  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => {
      setValues((prev) => [...prev.slice(1), bumpValue(prev[prev.length - 1] ?? min, min, max, step)]);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active, min, max, step]);

  return values;
}

function InfoLine({ label, value, mono = false, wrap = false, keepBorder = false }) {
  return (
    <div className={`grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-[var(--layout-search-gap)] border-b border-[var(--color-panel-border)] py-[var(--layout-search-padding-y)] text-ui-medium ${keepBorder ? "" : "last:border-b-0"}`}>
      <span className="whitespace-nowrap text-[var(--color-text-muted)]">{label}</span>
      <span className={`min-w-0 text-[var(--color-text-main)] ${wrap ? "whitespace-normal break-words" : "whitespace-nowrap truncate"} ${mono ? "font-mono" : ""}`}>{formatValue(value)}</span>
    </div>
  );
}

function ResourceBar({ label, value, detail }) {
  const numeric = Math.max(0, Math.min(100, Number(value) || 0));

  return (
    <div className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] p-[var(--layout-content-gap)]">
      <div className="mb-[var(--layout-search-padding-y)] flex items-center justify-between gap-[var(--layout-search-gap)]">
        <span className="text-ui-medium font-semibold text-[var(--color-text-main)]">{label}</span>
        <span className="font-mono text-ui-large font-bold text-[var(--color-accent)]">{numeric}%</span>
      </div>
      <div className="h-[0.5rem] overflow-hidden rounded-full bg-[var(--color-panel-border)]">
        <div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${numeric}%` }} />
      </div>
      {detail && <div className="mt-[var(--layout-search-padding-y)] truncate text-ui-small text-[var(--color-text-muted)]">{detail}</div>}
    </div>
  );
}

function ResourceGauge({ label, value, tone = "accent" }) {
  const numeric = Math.max(0, Math.min(100, Number(value) || 0));
  const circumference = 251.2;
  const toneClass = tone === "error" ? "text-[var(--color-error-text)]" : tone === "secondary" ? "text-sky-400" : "text-[var(--color-accent)]";

  return (
    <div className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] p-[var(--layout-content-gap)]">
      <div className="grid place-items-center">
        <div className={`relative grid h-[13rem] w-[13rem] place-items-center ${toneClass}`}>
          <svg className="-rotate-90" viewBox="0 0 100 100" aria-hidden="true">
            <circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" strokeOpacity="0.14" strokeWidth="9" />
            <circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" strokeWidth="9" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference - (numeric / 100) * circumference} />
          </svg>
          <div className="absolute flex flex-col items-center gap-[var(--layout-search-padding-y)] text-center">
            <div className="font-mono text-ui-large font-bold text-[var(--color-text-main)]">{numeric.toFixed(0)}%</div>
            <div className="text-ui-small text-[var(--color-text-muted)]">{label}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CameraPreview({ camera, onDiagnose }) {
  const [preview, setPreview] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [startTime, setStartTime] = useState(0);
  const [previewError, setPreviewError] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewBox, setPreviewBox] = useState({ width: 0, height: 0 });
  const [videoRatio, setVideoRatio] = useState(16 / 9);
  const previewBoxRef = useRef(null);
  const canPreview = camera.status !== "offline";

  useEffect(() => {
    setPreview(null);
    setPreviewUrl("");
    setStartTime(0);
    setPreviewError("");
    setPreviewLoading(false);
    setIsPlaying(false);
  }, [camera.id, canPreview]);

  useEffect(() => {
    let cancelled = false;

    if (!canPreview) return undefined;

    setPreviewLoading(true);
    setPreviewError("");

    getCameraPreview(camera.id)
      .then((data) => {
        if (cancelled) return;

        setStartTime(Number(data.start_time ?? data.startTime ?? Math.random() * 30));
        setPreview(data);
        setPreviewUrl(data.play_url || "");
        setIsPlaying(Boolean(data.play_url));
      })
      .catch((err) => {
        if (cancelled) return;

        console.error("Failed to load camera preview:", err);
        setPreviewError(err.response?.data?.detail || err.message || "预览拉取失败");
      })
      .finally(() => {
        if (!cancelled) {
          setPreviewLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [camera.id, canPreview]);

  useEffect(() => {
    const element = previewBoxRef.current;
    if (!element) return undefined;

    const updatePreviewBox = () => {
      const rect = element.getBoundingClientRect();
      setPreviewBox({
        width: rect.width,
        height: rect.height,
      });
    };

    updatePreviewBox();
    const observer = new ResizeObserver(updatePreviewBox);
    observer.observe(element);
    window.addEventListener("resize", updatePreviewBox);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updatePreviewBox);
    };
  }, []);

  const videoFrameStyle = useMemo(() => {
    const { width, height } = previewBox;

    if (width <= 0 || height <= 0 || !Number.isFinite(videoRatio) || videoRatio <= 0) {
      return { inset: 0 };
    }

    let frameWidth = width;
    let frameHeight = frameWidth / videoRatio;

    if (frameHeight > height) {
      frameHeight = height;
      frameWidth = frameHeight * videoRatio;
    }

    return {
      width: `${frameWidth}px`,
      height: `${frameHeight}px`,
      left: `${(width - frameWidth) / 2}px`,
      top: `${(height - frameHeight) / 2}px`,
    };
  }, [previewBox, videoRatio]);

  const togglePreview = async () => {
    if (!canPreview || previewLoading) return;

    if (isPlaying) {
      setIsPlaying(false);
      return;
    }

    setPreviewLoading(true);
    setPreviewError("");
    try {
      let url = previewUrl;
      if (!url) {
        const data = await getCameraPreview(camera.id);
        url = data.play_url || "";
        setStartTime(Number(data.start_time ?? data.startTime ?? Math.random() * 30));
        setPreview(data);
        setPreviewUrl(url);
      }
      setIsPlaying(Boolean(url));
    } catch (err) {
      console.error("Failed to load camera preview:", err);
      setPreviewError(err.response?.data?.detail || err.message || "预览拉取失败");
    } finally {
      setPreviewLoading(false);
    }
  };

  return (
    <div ref={previewBoxRef} className="relative h-full min-h-[calc(var(--font-large)*12)] overflow-hidden rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-black">
      <div className="absolute overflow-hidden" style={videoFrameStyle}>
        {preview && previewUrl && isPlaying ? (
          <LivePlayer
            preview={preview}
            className="h-full w-full"
            nativeClassName="h-full w-full object-contain"
            startTime={startTime}
            onPlaying={() => setIsPlaying(true)}
            onError={(message) => {
              setIsPlaying(false);
              setPreviewError(message || "视频播放失败");
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-ui-medium text-white/55">{canPreview ? "" : "离线摄像机不可预览"}</div>
        )}
        <button type="button" onClick={() => onDiagnose?.(camera)} className="absolute right-[var(--layout-content-gap)] top-[var(--layout-search-padding-y)] rounded-[var(--layout-radius-sm)] bg-black/60 px-[var(--layout-search-padding-x)] py-[var(--layout-segment-button-padding-y)] text-ui-small font-semibold text-[var(--color-accent)] transition hover:underline">
          根因诊断
        </button>
        <button type="button" onClick={togglePreview} disabled={!canPreview || previewLoading} className="absolute left-1/2 top-1/2 grid h-[4.5rem] w-[4.5rem] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-white transition hover:bg-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-45">
          {previewLoading ? <Loader2 size="var(--icon-topbar)" className="animate-spin" /> : isPlaying ? "Ⅱ" : "▶"}
        </button>
      </div>
      {previewError && (
        <div className="absolute inset-x-0 bottom-0 bg-[var(--color-error-bg)] px-[var(--layout-content-gap)] py-[var(--layout-search-padding-y)] text-ui-small text-[var(--color-error-text)]">
          {previewError}
        </div>
      )}
    </div>
  );
}

function CameraDetailContent({ item, onDiagnose }) {
  return (
    <div className="grid min-h-0 grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)] gap-[var(--layout-content-gap)]">
      <div className="grid content-start gap-[var(--layout-content-gap)]">
        <div className="grid gap-[var(--layout-content-gap)] text-ui-medium">
          <div className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] p-[var(--layout-content-gap)]">
            <div className="mb-[var(--layout-search-padding-y)] text-ui-medium font-semibold text-[var(--color-text-main)]">基础信息</div>
            <InfoLine label="IP" value={item.ip} mono />
            <InfoLine label="协议" value={item.protocol} />
            <InfoLine label="编码格式" value={item.codec} />
            <InfoLine label="码流" value={item.stream_type} />
            <InfoLine label="厂商" value={item.vendor} />
            <InfoLine label="型号" value={item.model} />
          </div>
          <div className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] p-[var(--layout-content-gap)]">
            <div className="mb-[var(--layout-search-padding-y)] text-ui-medium font-semibold text-[var(--color-text-main)]">归属与运维</div>
            <InfoLine label="服务器" value={item.server_id} mono />
            <InfoLine label="单位" value={item.unit} />
            <InfoLine label="负责人" value={item.manager} />
            <InfoLine label="乡镇" value={item.town_name} />
            <InfoLine label="经纬度" value={[item.longitude, item.latitude].filter((value) => value !== null && value !== undefined && value !== "").join(", ")} mono />
          </div>
        </div>
      </div>

      <CameraPreview camera={item} onDiagnose={onDiagnose} />
    </div>
  );
}

function ServerDetailContent({ item }) {
  const [metrics, setMetrics] = useState({
    cpu: clampPercent(item.cpu_usage),
    ram: clampPercent(item.ram_usage),
    disk: clampPercent(item.disk_usage),
    gpu: clampPercent(item.gpu_usage),
    net: clampPercent(item.net_bandwidth),
  });
  const sendValues = useRollingValues([35, 52, 45, 68, 55, 76, 62, 84, 58, 72, 66, 80], { min: 18, max: 95, step: 12 });
  const receiveValues = useRollingValues([28, 42, 36, 55, 48, 68, 52, 78, 50, 66, 58, 72], { min: 12, max: 90, step: 10 });

  useEffect(() => {
    const timer = window.setInterval(() => {
      setMetrics((prev) => ({
        cpu: directionalBump(prev.cpu, 1, 98, 5),
        ram: directionalBump(prev.ram, 1, 98, 3),
        disk: directionalBump(prev.disk, 1, 98, 1.4),
        gpu: directionalBump(prev.gpu, 1, 98, 6),
        net: directionalBump(prev.net, 1, 98, 8),
      }));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="grid min-h-0 gap-[var(--layout-content-gap)]">
      <div className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] p-[var(--layout-content-gap)]">
        <div className="mb-[var(--layout-search-padding-y)] flex items-center justify-between">
          <div>
            <div className="text-ui-medium font-semibold text-[var(--color-text-main)]">网络 I/O</div>
            <div className="mt-[var(--layout-search-padding-y)] flex gap-[var(--layout-content-gap)] text-ui-small text-[var(--color-text-muted)]">
              <span className="flex items-center gap-[var(--layout-search-gap)]"><span className="h-[0.65rem] w-[0.65rem] rounded-full bg-[var(--color-accent)]" />Input Mbps</span>
              <span className="flex items-center gap-[var(--layout-search-gap)]"><span className="h-[0.65rem] w-[0.65rem] rounded-full bg-sky-400" />Output Mbps</span>
            </div>
          </div>
          <div className="font-mono text-ui-large font-bold text-[var(--color-accent)]">{metrics.net.toFixed(0)}%</div>
        </div>
        <div className="h-[12rem]">
          <RollingTrend
            shaded
            lines={[
              { key: "input", values: sendValues, className: "text-[var(--color-accent)]" },
              { key: "output", values: receiveValues, className: "text-sky-400" },
            ]}
          />
        </div>
      </div>
      <div className="grid grid-cols-4 gap-[var(--layout-content-gap)]">
        <ResourceGauge label="CPU占用" value={metrics.cpu.toFixed(0)} />
        <ResourceGauge label="内存占用" value={metrics.ram.toFixed(0)} tone="secondary" />
        <ResourceGauge label="磁盘占用" value={metrics.disk.toFixed(0)} tone="error" />
        <ResourceGauge label="GPU利用率" value={metrics.gpu.toFixed(0)} />
      </div>
    </div>
  );
}

function StreamMetric({ label, averageValue, suffix = "", values, tone = "accent" }) {
  return (
    <div className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] p-[var(--layout-content-gap)]">
      <div className="mb-[var(--layout-search-padding-y)] flex items-center justify-between gap-[var(--layout-search-gap)]">
        <span className="text-ui-medium font-semibold text-[var(--color-text-main)]">{label}</span>
        <span className="font-mono text-ui-large font-bold text-[var(--color-accent)]">{formatValue(averageValue)}{suffix}</span>
      </div>
      <div className="h-[6rem]">
        <RollingTrend shaded lines={[{ key: label, values, className: tone === "error" ? "text-[var(--color-error-text)]" : "text-[var(--color-accent)]" }]} />
      </div>
    </div>
  );
}

function StreamDetailContent({ item }) {
  const isHealthy = item.is_connected && !item.is_fault;
  const throughputValues = useRollingValues(isHealthy ? [42, 55, 48, 64, 70, 62, 78, 72, 86, 80] : [0, 2, 0, 1, 0, 0, 1, 0, 0, 0], { min: isHealthy ? 25 : 0, max: isHealthy ? 95 : 6, step: isHealthy ? 12 : 2, active: true });
  const latencyValues = useRollingValues(isHealthy ? [25, 32, 28, 40, 36, 45, 38, 42, 35, 39] : [80, 88, 92, 96, 90, 98, 94, 99, 91, 95], { min: isHealthy ? 18 : 70, max: isHealthy ? 60 : 100, step: isHealthy ? 6 : 8, active: true });
  const lossValues = useRollingValues(isHealthy ? [2, 5, 1, 8, 3, 6, 2, 4, 1, 3] : [35, 42, 55, 48, 70, 62, 78, 72, 86, 80], { min: isHealthy ? 0 : 25, max: isHealthy ? 12 : 95, step: isHealthy ? 3 : 10, active: true });

  return (
    <div className="grid gap-[var(--layout-content-gap)]">
      <div className="grid grid-cols-3 gap-[var(--layout-content-gap)]">
        <StreamMetric label="吞吐量（Mbps）" averageValue={average(throughputValues).toFixed(1)} values={throughputValues} />
        <StreamMetric label="时延（ms）" averageValue={average(latencyValues).toFixed(0)} values={latencyValues} tone={isHealthy ? "accent" : "error"} />
        <StreamMetric label="丢包率（%）" averageValue={(average(lossValues) / 10).toFixed(2)} values={lossValues} tone={isHealthy ? "accent" : "error"} />
      </div>
      <div className="grid grid-cols-2 gap-[var(--layout-content-gap)] text-ui-medium">
        <div className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] p-[var(--layout-content-gap)]">
          <div className="mb-[var(--layout-search-padding-y)] text-ui-medium font-semibold text-[var(--color-text-main)]">流链路五元组</div>
          <InfoLine label="源IP" value={item.source_ip} mono />
          <InfoLine label="源端口" value={item.source_port} mono />
          <InfoLine label="目的IP" value={item.destination_ip} mono />
          <InfoLine label="目的端口" value={item.destination_port} mono />
          <InfoLine label="SSRC" value={formatStreamSsrc(item.ssrc)} mono />
        </div>
        <div className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] p-[var(--layout-content-gap)]">
          <div className="mb-[var(--layout-search-padding-y)] text-ui-medium font-semibold text-[var(--color-text-main)]">传输参数</div>
          <InfoLine label="链路状态" value={streamStatusText(item)} />
          <InfoLine label="编码格式" value={item.codec} />
          <InfoLine label="分辨率" value={item.resolution} />
          <InfoLine label="帧率" value={item.frame_rate} />
          <InfoLine label="QoE" value={item.qoe_score} />
        </div>
      </div>
    </div>
  );
}

function formatDateTimeText(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (num) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function buildDisposalSuggestion(camera, diagnosis) {
  const base = diagnosis?.suggestion || "请先完成根因诊断，再根据诊断结果执行处置。";
  return base;
}

function getRootCauseHierarchy(diagnosis) {
  const hierarchy = diagnosis?.topology?.root_cause_hierarchy || {};
  return {
    level1: hierarchy.level1 || diagnosis?.root_cause_type || "无",
    level2: hierarchy.level2 || diagnosis?.root_cause_node || "无",
    level3: hierarchy.level3 || diagnosis?.root_cause_metric || "无",
    target: hierarchy.target || diagnosis?.root_cause_node || "无",
    reason: hierarchy.reason || diagnosis?.root_cause_metric || "暂无定位依据",
  };
}

function formatRootCauseTitle(diagnosis) {
  if (!diagnosis) return "暂无结果";
  const hierarchy = getRootCauseHierarchy(diagnosis);
  const parts = [hierarchy.level1, hierarchy.level2, hierarchy.level3]
    .map((item) => String(item || "").trim())
    .filter((item) => item && item !== "无");
  return parts.length ? parts.join(" - ") : "暂无结果";
}

function RootCauseResultCard({ diagnosis }) {
  const hierarchy = getRootCauseHierarchy(diagnosis);

  return (
    <div className="mt-[var(--layout-search-gap)] rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] p-[var(--layout-content-gap)]">
      <div className="grid gap-[var(--layout-search-gap)] text-ui-medium lg:grid-cols-3">
        <InfoLine label="一级根因" value={hierarchy.level1} />
        <InfoLine label="二级根因" value={hierarchy.level2} />
        <InfoLine label="三级根因" value={hierarchy.level3} wrap keepBorder />
      </div>
      <div className="mt-[var(--layout-search-gap)] text-ui-medium">
        <InfoLine label="定位依据" value={hierarchy.reason} wrap />
      </div>
      <div className="mt-[var(--layout-search-gap)] text-ui-medium text-[var(--color-text-main)]">{diagnosis?.conclusion}</div>
    </div>
  );
}

function MiniTopology({ diagnosis, camera, running = false, progress = 100 }) {
  const topologyNodes = diagnosis?.topology?.nodes || [];
  const cameraNode = topologyNodes.find((node) => node.type === "camera") || { id: camera?.id || "camera", label: "摄像机", name: camera?.name || "摄像机" };
  const serverNode = topologyNodes.find((node) => node.type === "server") || { id: camera?.server_id || "server", label: "流媒体服务器", name: camera?.server_id || "流媒体服务器" };
  const clientNode = topologyNodes.find((node) => node.type === "client") || { id: "client", label: "客户端", name: "视频浏览端" };
  const nodes = [cameraNode, serverNode, clientNode];
  const canShowFault = diagnosis && Number(diagnosis.health_score) < 80;
  const faultNode = canShowFault ? diagnosis?.root_cause_node || diagnosis?.topology?.fault_node || "" : "";
  const metric = diagnosis?.root_cause_metric || diagnosis?.topology?.fault_metric || "";
  const faultText = `${faultNode} ${metric}`;
  const uplinkFault = /上行|接入|网络|链路|丢包|抖动|重传|吞吐/.test(faultText);
  const downlinkFault = /下行|客户端|浏览端/.test(faultText);
  const safeProgress = Math.max(0, Math.min(100, progress));
  const nodeProgress = [8, 50, 92];
  const linkProgress = (index) => {
    const start = index === 0 ? 18 : 60;
    const end = index === 0 ? 42 : 84;
    return Math.max(0, Math.min(100, ((safeProgress - start) / (end - start)) * 100));
  };

  return (
    <div className="mt-[var(--layout-search-gap)] rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] p-[var(--layout-content-gap)]">
      <div className="grid grid-cols-[minmax(0,0.78fr)_minmax(4rem,0.7fr)_minmax(0,1fr)_minmax(4rem,0.7fr)_minmax(0,0.78fr)] items-start gap-[var(--layout-search-gap)]">
        {nodes.map((node, index) => {
          const isFault = faultNode && (node.name === faultNode || node.id === faultNode);
          const isActive = safeProgress >= nodeProgress[index];
          return (
            <Fragment key={node.id}>
              <div key={node.id} className="min-w-0 text-center">
                <div className={`grid min-h-[4.5rem] place-items-center rounded-[var(--layout-radius-md)] border px-[var(--layout-search-padding-x)] transition-colors duration-500 ${isFault ? "border-[var(--color-error-text)] bg-[var(--color-error-bg)] text-[var(--color-error-text)]" : isActive ? "border-[var(--color-accent)] bg-[var(--color-hover-bg)] text-[var(--color-accent)]" : "border-[var(--color-panel-border)] bg-[var(--color-control-bg)] text-[var(--color-text-main)]"}`}>
                  <div className="text-ui-medium font-bold">{node.label}</div>
                </div>
                {node.type === "camera" ? (
                  <div className="mt-[var(--layout-tree-gap)] overflow-hidden text-ui-small text-[var(--color-text-muted)]" title={node.name}>
                    <span className="diagnosis-marquee">
                      <span className="diagnosis-marquee-item">{node.name}</span>
                      <span className="diagnosis-marquee-item" aria-hidden="true">{node.name}</span>
                    </span>
                  </div>
                ) : (
                  <div className="mt-[var(--layout-tree-gap)] truncate text-ui-small text-[var(--color-text-muted)]" title={node.name}>{node.name}</div>
                )}
              </div>
              {index < nodes.length - 1 && (
                <div className="relative mt-[2.1rem] min-w-0">
                  <div className={`absolute left-0 right-0 top-1/2 h-[0.25rem] -translate-y-1/2 overflow-hidden rounded-full ${(index === 0 && uplinkFault) || (index === 1 && downlinkFault) ? "bg-[var(--color-error-bg)]" : "bg-[var(--color-panel-border)]"}`}>
                    <div
                      className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ${(index === 0 && uplinkFault) || (index === 1 && downlinkFault) ? "bg-[var(--color-error-text)]" : "bg-[var(--color-accent)]"}`}
                      style={{ width: `${linkProgress(index)}%` }}
                    />
                  </div>
                  <div className={`relative mx-auto w-max max-w-full truncate rounded-[var(--layout-radius-sm)] bg-[var(--color-panel-bg)] px-[var(--layout-tree-action-padding)] text-ui-small ${(index === 0 && uplinkFault) || (index === 1 && downlinkFault) ? "text-[var(--color-error-text)]" : "text-[var(--color-text-muted)]"}`}>
                    {index === 0 ? "上行链路" : "下行链路"}
                  </div>
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
      {running && (
        <div className="mt-[var(--layout-content-gap)]">
          <div className="h-[0.4rem] overflow-hidden rounded-full bg-[var(--color-panel-border)]">
            <div className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-500" style={{ width: `${safeProgress}%` }} />
          </div>
          <div className="mt-[var(--layout-tree-gap)] text-center text-ui-small text-[var(--color-accent)]">正在加载拓扑链路：{safeProgress}%</div>
        </div>
      )}
    </div>
  );
}

function DiagnosisFlowTree({ flow }) {
  const stages = flow?.stages || [];
  if (!stages.length) return null;

  return (
    <div className="mt-[var(--layout-search-gap)] rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] p-[var(--layout-content-gap)]">
      <div className="flex min-w-0 items-center justify-between gap-[var(--layout-content-gap)]">
        <div className="truncate text-ui-medium font-bold text-[var(--color-text-main)]">{flow.title || "诊断流程树"}</div>
        <div className="shrink-0 text-ui-small text-[var(--color-text-muted)]">高亮为本次命中路径</div>
      </div>
      <div className="mt-[var(--layout-search-gap)] grid gap-[var(--layout-search-gap)] lg:grid-cols-3">
        {stages.map((stage) => (
          <div key={stage.key} className="min-w-0 rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] p-[var(--layout-search-padding-x)]">
            <div className="text-ui-medium font-bold text-[var(--color-text-main)]">{stage.title}</div>
            <div className="mt-[var(--layout-tree-gap)] text-ui-small text-[var(--color-text-muted)]">{stage.decision}</div>
            <div className="mt-[var(--layout-search-gap)] space-y-[var(--layout-tree-gap)]">
              {(stage.branches || []).map((branch) => (
                <div
                  key={branch.key}
                  className={`rounded-[var(--layout-radius-sm)] border px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)] ${
                    branch.selected
                      ? "border-[var(--color-accent)] bg-[var(--color-hover-bg)] text-[var(--color-accent)]"
                      : "border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] text-[var(--color-text-muted)] opacity-70"
                  }`}
                >
                  <div className="text-ui-small font-semibold">{branch.label}</div>
                  <div className="mt-[var(--layout-tree-gap)] text-ui-small leading-snug">{branch.evidence}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function diagnosisCheckTone(status) {
  if (status === "running") return "border-[var(--color-accent)] bg-[var(--color-panel-bg)] text-[var(--color-accent)]";
  if (status === "hit") return "border-[var(--color-error-text)] bg-[var(--color-error-bg)] text-[var(--color-error-text)]";
  if (status === "skip") return "border-[var(--color-panel-border)] bg-[var(--color-control-bg)] text-[var(--color-text-muted)]";
  return "border-[var(--color-accent)] bg-[var(--color-hover-bg)] text-[var(--color-accent)]";
}

function diagnosisCheckLabel(status) {
  if (status === "running") return "检测中";
  if (status === "hit") return "命中";
  if (status === "skip") return "跳过";
  return "通过";
}

function InferenceProgress({ progress = 0 }) {
  const safeProgress = Math.max(0, Math.min(100, progress));
  return (
    <div className="mt-[var(--layout-search-gap)] rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] p-[var(--layout-content-gap)]">
      <div className="flex items-center justify-between gap-[var(--layout-content-gap)] text-ui-medium">
        <span className="font-semibold text-[var(--color-text-main)]">根因定位算法推理</span>
        <span className="font-mono text-[var(--color-accent)]">{safeProgress}%</span>
      </div>
      <div className="relative mt-[var(--layout-search-gap)] h-[0.75rem] overflow-hidden rounded-full bg-[var(--color-panel-border)]">
        <div className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-500" style={{ width: `${safeProgress}%` }} />
        {safeProgress > 0 && safeProgress < 100 && (
          <div className="absolute inset-y-0 left-0 w-1/3 animate-pulse rounded-full bg-white/35" style={{ transform: `translateX(${Math.max(0, safeProgress * 2.3)}%)` }} />
        )}
      </div>
      <div className="mt-[var(--layout-search-gap)] text-ui-small text-[var(--color-text-muted)]">融合历史时间窗、链路拓扑和上下游指标，定位三级根因。</div>
    </div>
  );
}

function DiagnosisStep({ step, pingOutput, expanded, onToggle, children }) {
  const summary = `${step.title}：${step.description}`;
  const runningCheckIndex = step.checks?.findIndex((check) => check.status === "running") ?? -1;
  const checkProgress = step.checks?.length
    ? Math.round(((runningCheckIndex >= 0 ? runningCheckIndex + 0.35 : step.checks.length) / step.checks.length) * 100)
    : 0;
  const showCheckDetails = step.index !== 4;

  return (
    <div className="group rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)]">
      <button
        type="button"
        onClick={onToggle}
        className="flex min-h-[var(--layout-segment-button-height)] w-full items-center gap-[var(--layout-search-gap)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)] text-left"
        title={summary}
      >
        <span className={`grid h-[2rem] w-[2rem] shrink-0 place-items-center rounded-full text-ui-small font-bold ${step.status === "failed" ? "bg-[var(--color-error-bg)] text-[var(--color-error-text)]" : "bg-[var(--color-hover-bg)] text-[var(--color-accent)]"}`}>
          {step.index}
        </span>
        <div className="min-w-0 flex-1 truncate text-ui-medium text-[var(--color-text-main)]">
          <span className="font-bold">{step.title}：</span>
          <span className="text-[var(--color-text-muted)]">{step.description}</span>
        </div>
        {expanded ? <ChevronDown size="var(--icon-bottom)" className="shrink-0 text-[var(--color-icon-muted)]" /> : <ChevronRight size="var(--icon-bottom)" className="shrink-0 text-[var(--color-icon-muted)]" />}
      </button>
      {expanded && (
        <div className="border-t border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)]">
          {step.index !== 2 && (
            <div className="truncate text-ui-medium text-[var(--color-text-muted)]" title={step.description}>{step.description}</div>
          )}
          {step.index === 2 && pingOutput && (
            <pre className="diagnosis-terminal mt-[var(--layout-search-gap)] overflow-visible rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)] text-ui-small">
              {pingOutput}
            </pre>
          )}
          {showCheckDetails && runningCheckIndex >= 0 && (
            <div className="mt-[var(--layout-search-gap)]">
              <div className="h-[0.4rem] overflow-hidden rounded-full bg-[var(--color-panel-border)]">
                <div className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-500" style={{ width: `${checkProgress}%` }} />
              </div>
              <div className="mt-[var(--layout-tree-gap)] text-ui-small text-[var(--color-accent)]">正在执行：{step.checks[runningCheckIndex].label}</div>
            </div>
          )}
          {showCheckDetails && !!step.checks?.length && (
            <div className="mt-[var(--layout-search-gap)] space-y-[var(--layout-tree-gap)]">
              {step.checks.map((check) => (
                <div key={check.label} className={`rounded-[var(--layout-radius-sm)] border px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)] ${diagnosisCheckTone(check.status)}`}>
                  <div className="flex min-w-0 items-center justify-between gap-[var(--layout-search-gap)]">
                    <span className="truncate text-ui-small font-semibold">{check.label}</span>
                    <span className="shrink-0 text-ui-small">{diagnosisCheckLabel(check.status)}</span>
                  </div>
                  <div className="mt-[var(--layout-tree-gap)] text-ui-small leading-snug">{check.result}</div>
                </div>
              ))}
            </div>
          )}
          {children}
        </div>
      )}
    </div>
  );
}

function buildPingLines(camera) {
  const ip = camera.ip || "0.0.0.0";
  if (camera.status === "offline") {
    return [
      `正在 Ping ${ip} 具有 32 字节的数据:`,
      "请求超时。",
      "请求超时。",
      "请求超时。",
      "请求超时。",
      "",
      `${ip} 的 Ping 统计信息:`,
      "    数据包: 已发送 = 4，已接收 = 0，丢失 = 4 (100% 丢失)，",
    ];
  }

  return [
    `正在 Ping ${ip} 具有 32 字节的数据:`,
    `来自 ${ip} 的回复: 字节=32 时间=6ms TTL=63`,
    `来自 ${ip} 的回复: 字节=32 时间=7ms TTL=63`,
    `来自 ${ip} 的回复: 字节=32 时间=6ms TTL=63`,
    `来自 ${ip} 的回复: 字节=32 时间=8ms TTL=63`,
    "",
    `${ip} 的 Ping 统计信息:`,
    "    数据包: 已发送 = 4，已接收 = 4，丢失 = 0 (0% 丢失)，",
    "往返行程的估计时间(以毫秒为单位):",
    "    最短 = 6ms，最长 = 8ms，平均 = 7ms",
  ];
}

function diagnosisCheckDelay(stepIndex, checkIndex) {
  if (stepIndex === 1) return checkIndex === 0 ? 1200 : 950;
  if (stepIndex === 2) return checkIndex === 0 ? 650 : 1000;
  if (stepIndex === 3) return 4500;
  return 700;
}

function diagnosisRunningResult(check) {
  if (check.label.includes("Ping")) return "正在执行 Ping 连通性测试，等待全部回显完成。";
  if (check.label.includes("全链路")) return "正在采集摄像机、网络节点、流媒体服务器和客户端侧指标。";
  return `正在${check.label}，等待检测结果。`;
}

function buildRunningDiagnosisSteps(sourceSteps, stage, activeCheckIndex) {
  return sourceSteps
    .filter((step) => step.index <= stage)
    .map((step) => {
      if (step.index < stage) return step;
      const checks = step.checks || [];
      const visibleChecks = checks.slice(0, Math.min(checks.length, activeCheckIndex + 1));
      return {
        ...step,
        status: "running",
        checks: visibleChecks.map((check, index) => (
          index === visibleChecks.length - 1 && check.status !== "skip"
            ? { ...check, status: "running", result: diagnosisRunningResult(check) }
            : check
        )),
      };
    });
}

function VideoDiagnosisView({ camera, onClose }) {
  const scrollRef = useRef(null);
  const stepRefs = useRef({});
  const [diagnosis, setDiagnosis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState(0);
  const [expandedStep, setExpandedStep] = useState(null);
  const [pingLineCount, setPingLineCount] = useState(0);
  const [topologyProgress, setTopologyProgress] = useState(0);
  const [inferenceProgressValue, setInferenceProgressValue] = useState(0);
  const [runStartedAt, setRunStartedAt] = useState(null);
  const [runEndedAt, setRunEndedAt] = useState(null);
  const [pendingDiagnosis, setPendingDiagnosis] = useState(null);
  const [activeCheckIndex, setActiveCheckIndex] = useState(0);
  const marqueeItems = [
    "读取历史状态时间窗",
    "分析上下游联动影响",
    "校验 RTP 抖动与乱序",
    "比对流媒体转码负荷",
    "计算三级根因置信度",
  ];
  const pingLines = buildPingLines(camera);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPendingDiagnosis(null);
    getLatestVideoDiagnosis(camera.id)
      .then((data) => {
        if (!cancelled) setDiagnosis(data);
      })
      .catch((error) => {
        console.error("Failed to load diagnosis:", error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [camera.id]);

  useEffect(() => {
    if (!running) return undefined;
    setStage(1);
    setExpandedStep(1);
    setActiveCheckIndex(0);
    setTopologyProgress(0);
    setInferenceProgressValue(0);
    setPingLineCount(0);
    return undefined;
  }, [running, camera.status]);

  useEffect(() => {
    if (!running || stage !== 2) return undefined;
    setPingLineCount(1);
    const total = pingLines.length;
    const timer = window.setInterval(() => {
      setPingLineCount((value) => Math.min(total, value + 1));
    }, camera.status === "offline" ? 950 : 650);
    return () => window.clearInterval(timer);
  }, [running, stage, camera.status, pingLines.length]);

  const pingComplete = running && stage >= 2 && pingLineCount >= pingLines.length;

  useEffect(() => {
    if (!running || !pendingDiagnosis) return undefined;

    const sourceSteps = pendingDiagnosis.steps || [];
    const currentStep = sourceSteps.find((step) => step.index === stage);
    if (!currentStep) return undefined;

    const checks = currentStep.checks || [];
    if (!checks.length) {
      const nextStep = sourceSteps.find((step) => step.index > stage);
      if (nextStep) {
        setStage(nextStep.index);
        setActiveCheckIndex(0);
      }
      return undefined;
    }

    if (stage === 2 && activeCheckIndex === 0 && !pingComplete) return undefined;

    const timer = window.setTimeout(() => {
      if (activeCheckIndex < checks.length - 1) {
        setActiveCheckIndex((value) => value + 1);
        return;
      }

      const nextStep = sourceSteps.find((step) => step.index > stage);
      if (nextStep) {
        setStage(nextStep.index);
        setActiveCheckIndex(0);
        return;
      }

      const completedAt = new Date();
      setDiagnosis({ ...pendingDiagnosis, ended_at: completedAt.toISOString() });
      setPendingDiagnosis(null);
      setRunEndedAt(completedAt);
      setTopologyProgress(100);
      setInferenceProgressValue(100);
      setRunning(false);
      setExpandedStep(4);
    }, diagnosisCheckDelay(stage, activeCheckIndex));

    return () => window.clearTimeout(timer);
  }, [running, pendingDiagnosis, stage, activeCheckIndex, pingComplete]);

  useEffect(() => {
    if (!running || stage !== 3) return undefined;
    setTopologyProgress(0);
    const timer = window.setInterval(() => {
      setTopologyProgress((value) => Math.min(96, value + 7));
    }, 320);
    return () => window.clearInterval(timer);
  }, [running, stage]);

  useEffect(() => {
    if (!running || stage !== 4) return undefined;
    setInferenceProgressValue(0);
    const timer = window.setInterval(() => {
      setInferenceProgressValue((value) => Math.min(99, value + 7));
    }, 420);
    return () => window.clearInterval(timer);
  }, [running, stage]);

  const handleRun = async () => {
    const startedAt = new Date();
    setDiagnosis(null);
    setRunning(true);
    setStage(1);
    setExpandedStep(1);
    setPingLineCount(0);
    setTopologyProgress(0);
    setInferenceProgressValue(0);
    setRunStartedAt(startedAt);
    setRunEndedAt(null);
    setPendingDiagnosis(null);
    setActiveCheckIndex(0);
    try {
      const data = await runVideoDiagnosis(camera.id);
      setPendingDiagnosis(data);
    } catch (error) {
      console.error("Failed to run diagnosis:", error);
      setRunning(false);
    }
  };

  const displayDiagnosis = running ? pendingDiagnosis : diagnosis;
  const diagnosisBackedSteps = displayDiagnosis?.steps || [];

  const steps = running
    ? diagnosisBackedSteps.length
      ? buildRunningDiagnosisSteps(diagnosisBackedSteps, stage, activeCheckIndex)
      : [
        {
          index: 1,
          title: "准备诊断任务",
          status: "running",
          description: "正在获取设备诊断配置和历史状态。",
          checks: [{ label: "读取诊断配置", status: "running", result: "正在读取摄像机台账、心跳和链路关系。" }],
        },
      ]
    : (diagnosis?.steps || []).filter((step) => step.index !== 5);

  const score = camera.status === "offline" ? 0 : (diagnosis?.health_score ?? 0);
  const startTimeText = running ? formatDateTimeText(runStartedAt) : formatDateTimeText(diagnosis?.started_at);
  const endTimeText = running ? formatDateTimeText(runEndedAt) : formatDateTimeText(diagnosis?.ended_at);
  const resultTitle = running ? "诊断中" : formatRootCauseTitle(diagnosis);
  const resultScore = diagnosis ? `${score}分` : "--";
  const resultToneClass = camera.status === "offline"
    ? "text-[var(--color-text-muted)]"
    : camera.status === "fault" || (diagnosis && score < 80)
      ? "text-[var(--color-error-text)]"
      : "text-[var(--color-accent)]";
  const inferenceProgress = running ? inferenceProgressValue : diagnosis ? 100 : 0;
  const topologyDisplayProgress = running ? topologyProgress : diagnosis ? 100 : 0;
  const pingOutput = running ? pingLines.slice(0, pingLineCount).join("\n") : diagnosis?.ping_output;

  useEffect(() => {
    if (!running) return;
    setExpandedStep(stage);
  }, [running, stage]);

  useEffect(() => {
    if (!expandedStep) return;
    window.setTimeout(() => {
      stepRefs.current[expandedStep]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 80);
  }, [expandedStep]);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <section className="overflow-hidden rounded-[var(--layout-radius-lg)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)]">
        <header className="flex min-h-[var(--layout-segment-button-height)] items-center justify-between gap-[var(--layout-content-gap)] border-b border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-content-padding)] py-[var(--layout-search-padding-y)]">
          <div className="min-w-0">
            <div className="truncate text-ui-large font-bold text-[var(--color-text-main)]">{camera.id} - {camera.name} - 根因诊断</div>
          </div>
          <div className="flex shrink-0 items-center gap-[var(--layout-search-gap)]">
            <button type="button" onClick={handleRun} disabled={running} className="flex min-h-[var(--layout-segment-button-height)] items-center gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-sm)] bg-[var(--color-topbar-active-bg)] px-[var(--layout-tab-padding-x)] text-ui-medium font-semibold text-[var(--color-topbar-active-text)] disabled:opacity-60">
              {running ? <Loader2 size="var(--icon-bottom)" className="animate-spin" /> : <Zap size="var(--icon-bottom)" />}
              {running ? "诊断中" : "诊断"}
            </button>
            <button type="button" title="关闭诊断" onClick={onClose} className="rounded-[var(--layout-radius-sm)] p-[var(--layout-tree-action-padding)] text-[var(--color-icon-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-error-text)]">
              <X size="var(--icon-topbar)" />
            </button>
          </div>
        </header>

        <div className="min-h-0 p-[var(--layout-content-padding)]">
          <div className="space-y-[var(--layout-content-gap)]">
            {loading ? (
              <div className="flex min-h-[20rem] items-center justify-center gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] text-ui-medium text-[var(--color-text-muted)]">
                <Loader2 size="var(--icon-search)" className="animate-spin" /> 正在加载历史诊断
              </div>
            ) : (
              <>
                <section className="grid grid-cols-[minmax(0,1.35fr)_minmax(0,0.65fr)] gap-[var(--layout-content-gap)]">
                  <div className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] p-[var(--layout-content-gap)]">
                    <div className="text-ui-large font-bold text-[var(--color-text-main)]">诊断时间</div>
                    <div className="mt-[var(--layout-search-gap)] truncate text-ui-medium text-[var(--color-text-muted)]" title={`${startTimeText} → ${endTimeText}`}>
                      {startTimeText} → {endTimeText}
                    </div>
                  </div>
                  <div className="relative rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] p-[var(--layout-content-gap)]">
                    <div className="pr-[calc(var(--font-title)*2.4)] text-ui-large font-bold leading-none text-[var(--color-text-main)]">诊断结果</div>
                    <div className={`absolute right-[var(--layout-content-gap)] top-[var(--layout-content-gap)] font-mono text-app-title font-bold leading-none ${resultToneClass}`}>{resultScore}</div>
                    <div className={`mt-[var(--layout-search-gap)] truncate text-ui-medium leading-none ${resultToneClass}`} title={resultTitle}>
                      {resultTitle}
                    </div>
                  </div>
                </section>

                <section ref={scrollRef} className="max-h-[48rem] space-y-[var(--layout-search-gap)] overflow-auto rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] p-[var(--layout-content-gap)]">
                  <div className="flex items-center justify-between">
                    <div className="text-ui-large font-bold text-[var(--color-text-main)]">诊断描述</div>
                    {running && <div className="text-ui-small text-[var(--color-accent)]">{marqueeItems[stage % marqueeItems.length]}...</div>}
                  </div>
                  <div className="space-y-[var(--layout-tree-gap)]">
                    {steps.map((step) => (
                      <div key={step.index} ref={(element) => { stepRefs.current[step.index] = element; }}>
                        <DiagnosisStep
                          step={step}
                          pingOutput={pingOutput}
                          expanded={expandedStep === step.index}
                          onToggle={() => setExpandedStep((value) => (value === step.index ? null : step.index))}
                        >
                          {step.index === 3 && !step.checks?.every((check) => check.status === "skip") && (
                            <>
                              <MiniTopology diagnosis={displayDiagnosis} camera={camera} running={running} progress={topologyDisplayProgress} />
                            </>
                          )}
                          {step.index === 4 && (running || diagnosis) && (
                            <>
                              <InferenceProgress progress={inferenceProgress} />
                              {diagnosis && <RootCauseResultCard diagnosis={diagnosis} />}
                            </>
                          )}
                        </DiagnosisStep>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] p-[var(--layout-content-gap)]">
                  <div className="mb-[var(--layout-search-padding-y)] text-ui-large font-bold text-[var(--color-text-main)]">处置建议</div>
                  <div className="text-ui-medium leading-relaxed text-[var(--color-text-main)]">{buildDisposalSuggestion(camera, diagnosis)}</div>
                  {diagnosis?.work_order_id && (
                    <div className="mt-[var(--layout-search-gap)] truncate text-ui-small text-[var(--color-text-muted)]" title={diagnosis.work_order_id}>
                      已生成工单：{diagnosis.work_order_id}
                    </div>
                  )}
                </section>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function DetailView({ detail, onClose, onDiagnose }) {
  if (!detail?.item) return null;
  const { type, item } = detail;
  const isCamera = type === "camera";
  const isServer = type === "server";
  const isStream = type === "stream";
  const Icon = isCamera ? Camera : isServer ? Server : Link2;
  const regionText = [item.province_name, item.city_name, item.county_name, item.town_name].filter(Boolean).join(" / ");

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <section className="overflow-hidden rounded-[var(--layout-radius-lg)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)]">
        <header className="flex items-center justify-between gap-[var(--layout-content-gap)] border-b border-[var(--color-panel-border)] bg-[var(--color-control-bg)] p-[var(--layout-content-padding)]">
          <div className="flex min-w-0 items-center gap-[var(--layout-content-gap)]">
            <div className="grid h-[4.5rem] w-[4.5rem] shrink-0 place-items-center rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] text-[var(--color-accent)]">
              <Icon size="var(--icon-topbar)" />
            </div>
            <div className="flex min-w-0 items-center gap-[var(--layout-search-gap)] text-ui-medium text-[var(--color-text-main)]">
              {isCamera && (
                <>
                  <span className="shrink-0 font-mono font-semibold">{formatValue(item.id)}</span>
                  <span className="shrink-0 text-[var(--color-text-muted)]">-</span>
                  <span className="truncate font-semibold">{formatValue(item.name)}</span>
                  <span className="shrink-0 text-[var(--color-text-muted)]">-</span>
                  <span className="truncate text-[var(--color-text-muted)]">{formatValue(regionText || item.location_desc)}</span>
                  <span className="shrink-0 text-[var(--color-text-muted)]">-</span>
                  <span className={`shrink-0 rounded-[var(--layout-radius-sm)] border px-[var(--layout-tree-action-padding)] text-ui-small ${statusClass(item.status)}`}>{cameraStatusText(item.status)}</span>
                </>
              )}
              {isServer && (
                <>
                  <span className="shrink-0 font-mono font-semibold">{formatValue(item.id)}</span>
                  <span className="shrink-0 text-[var(--color-text-muted)]">-</span>
                  <span className="truncate font-semibold">{formatValue(item.name)}</span>
                  <span className="shrink-0 text-[var(--color-text-muted)]">-</span>
                  <span className="shrink-0 font-mono">IP: {formatValue(item.ip)}</span>
                  <span className="shrink-0 text-[var(--color-text-muted)]">-</span>
                  <span className="truncate text-[var(--color-text-muted)]">{formatValue(item.location_desc)}</span>
                  <span className="shrink-0 text-[var(--color-text-muted)]">-</span>
                  <span className={`shrink-0 rounded-[var(--layout-radius-sm)] border px-[var(--layout-tree-action-padding)] text-ui-small ${statusClass(item.status)}`}>{serverStatusText(item.status)}</span>
                </>
              )}
              {isStream && (
                <>
                  <span className="shrink-0 font-mono font-semibold">{formatValue(item.id)}</span>
                  <span className="shrink-0 text-[var(--color-text-muted)]">-</span>
                  <Camera size="var(--icon-bottom)" className="shrink-0 text-[var(--color-accent)]" />
                  <span className="truncate font-semibold">{formatValue(item.camera_id)}</span>
                  <span className="shrink-0 text-[var(--color-accent)]">→</span>
                  <Server size="var(--icon-bottom)" className="shrink-0 text-[var(--color-accent)]" />
                  <span className="truncate font-semibold">{formatValue(item.server_id)}</span>
                  <span className="shrink-0 text-[var(--color-text-muted)]">-</span>
                  <span className="shrink-0 font-mono text-[var(--color-text-muted)]">SSRC: {formatStreamSsrc(item.ssrc)}</span>
                  <span className="shrink-0 text-[var(--color-text-muted)]">-</span>
                  <span className={`shrink-0 rounded-[var(--layout-radius-sm)] border px-[var(--layout-tree-action-padding)] text-ui-small ${statusClass(item.is_connected && !item.is_fault ? "normal" : "fault")}`}>{item.is_connected && !item.is_fault ? "连通" : "异常"}</span>
                </>
              )}
            </div>
          </div>
          <button type="button" title="关闭详情" onClick={onClose} className="rounded-[var(--layout-radius-sm)] p-[var(--layout-tree-action-padding)] text-[var(--color-icon-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-error-text)]">
            <X size="var(--icon-topbar)" />
          </button>
        </header>

        <div className="min-h-0 p-[var(--layout-content-padding)]">
          {isCamera && <CameraDetailContent item={item} onDiagnose={onDiagnose} />}
          {isServer && <ServerDetailContent item={item} />}
          {isStream && <StreamDetailContent item={item} />}
        </div>
      </section>
    </div>
  );
}

function Field({ label, name, value, onChange, required = false, type = "text", options = null, disabled = false }) {
  return (
    <label className="min-w-0">
      <span className="mb-[var(--layout-search-padding-y)] block text-ui-small text-[var(--color-text-muted)]">
        {label}{required ? " *" : ""}
      </span>
      {options ? (
        <select name={name} value={value ?? ""} onChange={onChange} disabled={disabled} className="min-h-[var(--layout-segment-button-height)] w-full rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] text-ui-medium text-[var(--color-text-main)] outline-none disabled:opacity-60">
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      ) : (
        <input name={name} value={value ?? ""} onChange={onChange} disabled={disabled} type={type} className="min-h-[var(--layout-segment-button-height)] w-full rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] text-ui-medium text-[var(--color-text-main)] outline-none placeholder:text-[var(--color-text-muted)] disabled:opacity-60" />
      )}
    </label>
  );
}

function RegionPicker({ form, onRegionSelect }) {
  const [keyword, setKeyword] = useState(form.town_name || form.county_name || form.city_name || form.province_name || "");
  const [searchOptions, setSearchOptions] = useState([]);
  const [provinceOptions, setProvinceOptions] = useState([]);
  const [cityOptions, setCityOptions] = useState([]);
  const [countyOptions, setCountyOptions] = useState([]);
  const [townOptions, setTownOptions] = useState([]);
  const [loading, setLoading] = useState(false);

  const levelRank = { province: 1, city: 2, county: 3, town: 4 };

  const buildRegionOption = async (region) => {
    const chain = { province: null, city: null, county: null, town: null, [region.level]: region };
    let current = region;

    while (current?.parent_code) {
      current = await getRegionByCode(current.parent_code);
      chain[current.level] = current;
    }

    return {
      ...chain,
      selected: region,
      label: [chain.province?.region_name, chain.city?.region_name, chain.county?.region_name, chain.town?.region_name].filter(Boolean).join(" / "),
    };
  };

  const patchFromChain = (chain) => ({
    province_code: chain.province?.region_code || "",
    province_name: chain.province?.region_name || "",
    city_code: chain.city?.region_code || "",
    city_name: chain.city?.region_name || "",
    county_code: chain.county?.region_code || "",
    county_name: chain.county?.region_name || "",
    town_code: chain.town?.region_code || "",
    town_name: chain.town?.region_name || "",
  });

  const regionToOption = (region) => ({
    label: region.region_name,
    value: region.region_code,
  });

  const loadChildren = async (parentCode, setter) => {
    if (!parentCode) {
      setter([]);
      return;
    }

    const rows = await getRegions({ parent_code: parentCode });
    setter(rows.map(regionToOption));
  };

  useEffect(() => {
    getRegions({ level: "province" })
      .then((rows) => setProvinceOptions(rows.map(regionToOption)))
      .catch((err) => console.error("Failed to load province regions:", err));
  }, []);

  useEffect(() => {
    loadChildren(form.province_code, setCityOptions).catch((err) => console.error("Failed to load city regions:", err));
  }, [form.province_code]);

  useEffect(() => {
    loadChildren(form.city_code, setCountyOptions).catch((err) => console.error("Failed to load county regions:", err));
  }, [form.city_code]);

  useEffect(() => {
    loadChildren(form.county_code, setTownOptions).catch((err) => console.error("Failed to load town regions:", err));
  }, [form.county_code]);

  useEffect(() => {
    const text = keyword.trim();
    if (!text) {
      setSearchOptions([]);
      return undefined;
    }

    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const rows = await getRegions({ keyword: text });
        const nextOptions = await Promise.all(
          rows
            .slice(0, 40)
            .sort((a, b) => (levelRank[a.level] || 99) - (levelRank[b.level] || 99))
            .map(buildRegionOption)
        );
        setSearchOptions(nextOptions);
      } catch (err) {
        console.error("Failed to search regions:", err);
        setSearchOptions([]);
      } finally {
        setLoading(false);
      }
    }, 250);

    return () => window.clearTimeout(timer);
  }, [keyword]);

  const handleSelectSearchResult = async (event) => {
    const regionCode = event.target.value;
    if (!regionCode) return;

    try {
      const option = searchOptions.find((item) => item.selected.region_code === regionCode) || await buildRegionOption(await getRegionByCode(regionCode));
      onRegionSelect(patchFromChain(option));
      setKeyword(option.label || option.selected.region_name || "");
    } catch (err) {
      console.error("Failed to select region:", err);
    }
  };

  const handleSelectRegionLevel = async (level, regionCode) => {
    if (!regionCode) {
      const clearPatch =
        level === "province"
          ? { province_code: "", province_name: "", city_code: "", city_name: "", county_code: "", county_name: "", town_code: "", town_name: "" }
          : level === "city"
            ? { city_code: "", city_name: "", county_code: "", county_name: "", town_code: "", town_name: "" }
            : level === "county"
              ? { county_code: "", county_name: "", town_code: "", town_name: "" }
              : { town_code: "", town_name: "" };
      onRegionSelect(clearPatch);
      return;
    }

    const option = await buildRegionOption(await getRegionByCode(regionCode));
    onRegionSelect(patchFromChain(option));
  };

  return (
    <div className="col-span-4">
      <span className="mb-[var(--layout-search-padding-y)] block text-ui-small text-[var(--color-text-muted)]">行政区搜索 *</span>
      <div className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] p-[var(--layout-content-gap)]">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-[var(--layout-content-gap)]">
          <label className="min-w-0">
          <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="输入省/市/区县/乡镇名称或编码" className="min-h-[var(--layout-segment-button-height)] w-full rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-[var(--layout-search-padding-x)] text-ui-medium text-[var(--color-text-main)] outline-none placeholder:text-[var(--color-text-muted)]" />
          </label>
          <label className="min-w-0">
          <select value="" onChange={handleSelectSearchResult} className="min-h-[var(--layout-segment-button-height)] w-full rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-[var(--layout-search-padding-x)] text-ui-medium text-[var(--color-text-main)] outline-none">
            <option value="">{loading ? "正在搜索..." : "请选择匹配结果"}</option>
            {searchOptions.map((option) => (
              <option key={option.selected.region_code} value={option.selected.region_code}>
                {option.label}
              </option>
            ))}
          </select>
          </label>
        </div>
        <div className="mt-[var(--layout-content-gap)] grid grid-cols-4 gap-[var(--layout-content-gap)]">
          <Field label="省级行政区" name="province_code" value={form.province_code} onChange={(event) => handleSelectRegionLevel("province", event.target.value)} options={[{ label: "请选择省级行政区", value: "" }, ...provinceOptions]} />
          <Field label="地级行政区" name="city_code" value={form.city_code} onChange={(event) => handleSelectRegionLevel("city", event.target.value)} options={[{ label: "请选择地级行政区", value: "" }, ...cityOptions]} disabled={!form.province_code} />
          <Field label="县级行政区" name="county_code" value={form.county_code} onChange={(event) => handleSelectRegionLevel("county", event.target.value)} options={[{ label: "请选择县级行政区", value: "" }, ...countyOptions]} disabled={!form.city_code} />
          <Field label="乡级行政区" name="town_code" value={form.town_code} onChange={(event) => handleSelectRegionLevel("town", event.target.value)} options={[{ label: "请选择乡级行政区", value: "" }, ...townOptions]} disabled={!form.county_code} />
        </div>
      </div>
    </div>
  );
}

function DeviceFormModal({ type, mode, form, error, servers, selectedRegion, onChange, onRegionSelect, onSubmit, onClose }) {
  const isCamera = type === "camera";
  const title = `${mode === "create" ? "新增" : "编辑"}${isCamera ? "摄像机" : "服务器"}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-[var(--layout-content-padding)]" onClick={onClose}>
      <form className="flex max-h-[88vh] w-[min(78rem,100%)] flex-col overflow-hidden rounded-[var(--layout-radius-lg)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] shadow-[var(--shadow-panel)]" onClick={(event) => event.stopPropagation()} onSubmit={onSubmit}>
        <header className="flex shrink-0 items-center justify-between border-b border-[var(--color-panel-border)] px-[var(--layout-content-padding)] py-[var(--layout-search-padding-y)]">
          <div className="text-ui-large font-bold text-[var(--color-text-main)]">{title}</div>
          <button type="button" onClick={onClose} className="rounded-[var(--layout-radius-sm)] p-[var(--layout-tree-action-padding)] text-[var(--color-icon-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-error-text)]">
            <X size="var(--icon-topbar)" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-[var(--layout-content-padding)]">
          {error && (
            <div className="mb-[var(--layout-content-gap)] rounded-[var(--layout-radius-sm)] bg-[var(--color-error-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)] text-ui-small text-[var(--color-error-text)]">
              {error}
            </div>
          )}

          {selectedRegion?.nodeType === "region" && isCamera && (
            <div className="mb-[var(--layout-content-gap)] rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)] text-ui-small text-[var(--color-text-muted)]">
              当前左侧定位区域：{selectedRegion.name}。行政区可通过下方搜索选择，系统会自动回填四级名称和编码。
            </div>
          )}

          <div className="grid grid-cols-4 gap-[var(--layout-content-gap)]">
            <Field label="ID" name="id" value={form.id} onChange={onChange} required disabled={mode === "edit"} />
            <div className="col-span-2">
              <Field label="名称" name="name" value={form.name} onChange={onChange} required />
            </div>
            <Field label="IP" name="ip" value={form.ip} onChange={onChange} required />

            {isCamera ? (
              <>
                <Field label="状态" name="status" value={form.status} onChange={onChange} options={[{ label: "在线", value: "online" }, { label: "异常", value: "fault" }, { label: "离线", value: "offline" }]} />
                <Field label="协议" name="protocol" value={form.protocol} onChange={onChange} options={[{ label: "RTSP", value: "RTSP" }, { label: "GB28181", value: "GB28181" }, { label: "ONVIF", value: "ONVIF" }, { label: "HTTP-FLV", value: "HTTP-FLV" }]} />
                <Field label="编码格式" name="codec" value={form.codec} onChange={onChange} options={[{ label: "H.264", value: "H.264" }, { label: "H.265", value: "H.265" }, { label: "MJPEG", value: "MJPEG" }]} />
                <Field label="码流类型" name="stream_type" value={form.stream_type} onChange={onChange} options={[{ label: "主码流", value: "main" }, { label: "子码流", value: "sub" }, { label: "第三码流", value: "third" }]} />
                <Field label="接入方式" name="access_type" value={form.access_type} onChange={onChange} options={[{ label: "以太网", value: "Ethernet" }, { label: "光纤", value: "Fiber" }, { label: "Wi-Fi", value: "Wi-Fi" }, { label: "4G", value: "4G" }, { label: "5G", value: "5G" }]} />
                <Field label="绑定服务器" name="server_id" value={form.server_id} onChange={onChange} options={[{ label: "未绑定", value: "" }, ...servers.map((server) => ({ label: `${server.name} (${server.id})`, value: server.id }))]} />
                <Field label="厂商" name="vendor" value={form.vendor} onChange={onChange} />
                <Field label="型号" name="model" value={form.model} onChange={onChange} />
                <Field label="管理单位" name="unit" value={form.unit} onChange={onChange} />
                <Field label="负责人" name="manager" value={form.manager} onChange={onChange} />
                <Field label="经度" name="longitude" value={form.longitude} onChange={onChange} type="number" />
                <Field label="纬度" name="latitude" value={form.latitude} onChange={onChange} type="number" />
                <div className="col-span-2">
                  <Field label="位置描述" name="location_desc" value={form.location_desc} onChange={onChange} />
                </div>
                <div className="col-span-2">
                  <Field label="视频地址" name="video_url" value={form.video_url} onChange={onChange} />
                </div>
                <RegionPicker form={form} onRegionSelect={onRegionSelect} />
              </>
            ) : (
              <>
                <Field label="状态" name="status" value={form.status} onChange={onChange} options={[{ label: "正常", value: "normal" }, { label: "告警", value: "warning" }, { label: "异常", value: "fault" }, { label: "离线", value: "offline" }]} />
                <Field label="节点类型" name="node_type" value={form.node_type} onChange={onChange} options={[{ label: "流媒体服务器", value: "stream_server" }, { label: "媒体服务器", value: "media_server" }, { label: "存储服务器", value: "storage_server" }, { label: "边缘节点", value: "edge_server" }]} />
                <Field label="位置描述" name="location_desc" value={form.location_desc} onChange={onChange} />
                <Field label="经度" name="longitude" value={form.longitude} onChange={onChange} type="number" />
                <Field label="纬度" name="latitude" value={form.latitude} onChange={onChange} type="number" />
                <Field label="CPU 使用率" name="cpu_usage" value={form.cpu_usage} onChange={onChange} type="number" />
                <Field label="内存使用率" name="ram_usage" value={form.ram_usage} onChange={onChange} type="number" />
                <Field label="磁盘使用率" name="disk_usage" value={form.disk_usage} onChange={onChange} type="number" />
                <Field label="带宽使用率" name="net_bandwidth" value={form.net_bandwidth} onChange={onChange} type="number" />
                <Field label="GPU 使用率" name="gpu_usage" value={form.gpu_usage} onChange={onChange} type="number" />
              </>
            )}
          </div>
        </div>

        <footer className="flex shrink-0 justify-end gap-[var(--layout-search-gap)] border-t border-[var(--color-panel-border)] px-[var(--layout-content-padding)] py-[var(--layout-search-padding-y)]">
          <button type="button" onClick={onClose} className="rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] px-[var(--layout-tab-padding-x)] py-[var(--layout-segment-button-padding-y)] text-ui-medium text-[var(--color-text-muted)] hover:bg-[var(--color-hover-bg)]">
            取消
          </button>
          <button type="submit" className="rounded-[var(--layout-radius-sm)] bg-[var(--color-topbar-active-bg)] px-[var(--layout-tab-padding-x)] py-[var(--layout-segment-button-padding-y)] text-ui-medium font-medium text-[var(--color-topbar-active-text)]">
            保存
          </button>
        </footer>
      </form>
    </div>
  );
}

export default function DeviceManage({ focusTarget, resetVersion = 0, onCloseExternalDetail, readonlyMode = false }) {
  const [activeTab, setActiveTab] = useState(focusTarget?.deviceTab || "camera");
  const [deviceStatusFilter, setDeviceStatusFilter] = useState(focusTarget?.statusFilter || "all");
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [cameras, setCameras] = useState([]);
  const [servers, setServers] = useState([]);
  const [streams, setStreams] = useState([]);
  const [activeFlowRows, setActiveFlowRows] = useState([]);
  const [activeFlowMeta, setActiveFlowMeta] = useState(null);
  const [selectedChainlistStreamIds, setSelectedChainlistStreamIds] = useState(() => new Set());
  const [detail, setDetail] = useState(null);
  const [diagnosisCamera, setDiagnosisCamera] = useState(null);
  const [diagnosisFromExternal, setDiagnosisFromExternal] = useState(false);
  const [formState, setFormState] = useState(null);
  const [scopeMetrics, setScopeMetrics] = useState(null);

  const regionCode = focusTarget?.nodeType === "region" ? focusTarget.regionCode : "";
  const cameraId = focusTarget?.nodeType === "camera" ? focusTarget.cameraId : "";
  const statisticsScopeParams = useMemo(() => buildStatisticsScopeParams(focusTarget), [focusTarget]);
  const customFolderCameraIds = useMemo(
    () =>
      focusTarget?.nodeType === "custom_folder"
        ? new Set(
            (focusTarget.children || [])
              .map((camera) => camera.cameraId || camera.camera_id || camera.id?.replace(/^camera-/, ""))
              .filter(Boolean)
          )
        : new Set(),
    [focusTarget]
  );

  const focusedCameras = useMemo(() => {
    if (cameraId) return cameras.filter((camera) => camera.id === cameraId);
    if (focusTarget?.nodeType === "custom_folder") {
      return cameras.filter((camera) => customFolderCameraIds.has(camera.id));
    }
    return cameras;
  }, [cameras, cameraId, customFolderCameraIds, focusTarget?.nodeType]);

  const focusedServerIds = useMemo(
    () => new Set(focusedCameras.map((camera) => camera.server_id).filter(Boolean)),
    [focusedCameras]
  );

  const focusedServers = useMemo(() => {
    if (cameraId || regionCode || focusTarget?.nodeType === "custom_folder") {
      return servers.filter((server) => focusedServerIds.has(server.id));
    }
    return servers;
  }, [servers, focusedServerIds, cameraId, regionCode, focusTarget?.nodeType]);

  const focusedCameraIds = useMemo(
    () => new Set(focusedCameras.map((camera) => camera.id)),
    [focusedCameras]
  );

  const focusedStreams = useMemo(() => {
    if (cameraId || regionCode || focusTarget?.nodeType === "custom_folder") {
      return streams.filter((stream) => focusedCameraIds.has(stream.camera_id));
    }
    return streams;
  }, [streams, focusedCameraIds, cameraId, regionCode, focusTarget?.nodeType]);

  const shownCameras = useMemo(
    () => filterByKeyword(filterByStatus(focusedCameras, "camera", deviceStatusFilter), keyword, ["id", "name", "ip", "town_name", "server_id"]),
    [focusedCameras, keyword, deviceStatusFilter]
  );
  const shownServers = useMemo(
    () => filterByKeyword(filterByStatus(focusedServers, "server", deviceStatusFilter), keyword, ["id", "name", "ip", "node_type"]),
    [focusedServers, keyword, deviceStatusFilter]
  );
  const shownStreams = useMemo(
    () => filterByKeyword(filterByStatus(focusedStreams, "stream", deviceStatusFilter), keyword, ["display_id", "device_id", "camera_id", "camera_name", "server_id", "ssrc", "source_ip", "destination_ip"]),
    [focusedStreams, keyword, deviceStatusFilter]
  );

  // 拆分1：只加载不需要跟随行政区变动的数据（服务器、流链路）
  const loadCommonData = async () => {
    try {
      const [serverRows, streamRows, activeFlowPayload] = await Promise.all([
        getDeviceServers(),
        getDeviceStreams(),
        getAlgorithmActiveFlows(),
      ]);
      setServers(serverRows);
      setStreams(streamRows);
      setActiveFlowRows(activeFlowPayload?.flows || []);
      setActiveFlowMeta(activeFlowPayload || null);
    } catch (err) {
      console.error("Failed to load common device data:", err);
      setError(err.response?.data?.detail || err.message || "设备和流链路数据加载失败");
    }
  };

  // 拆分2：跟随左侧树联动的摄像机数据
  const loadCameraData = async () => {
    setLoading(true);
    setError("");
    try {
      const cameraRows = await getDeviceCameras(regionCode ? { region_code: regionCode } : {});
      setCameras(cameraRows);
    } catch (err) {
      console.error("Failed to load camera data:", err);
      setError(err.message || "摄像机数据加载失败");
    } finally {
      setLoading(false);
    }
  };

  // 手动刷新按钮逻辑
  const handleRefresh = async () => {
    loadCommonData();
    await loadCameraData();
  };

  const handleRefreshActiveFlows = async () => {
    setError("");
    try {
      const payload = await refreshAlgorithmActiveFlows();
      setActiveFlowRows(payload?.flows || []);
      setActiveFlowMeta(payload || null);
      await loadCommonData();
    } catch (err) {
      console.error("Failed to refresh active flows:", err);
      setError(err.response?.data?.detail || err.message || "刷新流链路信息失败");
    }
  };


  const toggleChainlistStream = (stream, checked) => {
    setSelectedChainlistStreamIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        if (next.size >= 5 && !next.has(stream.id)) return next;
        next.add(stream.id);
      } else {
        next.delete(stream.id);
      }
      return next;
    });
  };

  const applySelectedChainlist = async () => {
    setError("");
    try {
      const selectedIds = Array.from(selectedChainlistStreamIds);
      const result = await applyAlgorithmChainlist({ stream_ids: selectedIds });
      setSelectedChainlistStreamIds(new Set(result.selected_stream_ids || []));
      setActiveFlowMeta((prev) => ({ ...(prev || {}), chainlist_file: result.chainlist_file }));
    } catch (err) {
      console.error("Failed to apply chainlist:", err);
      setError(err.response?.data?.detail || err.message || "应用采集链路失败");
    }
  };

  // 仅在组件初次挂载时加载一次服务器和流链路
  useEffect(() => {
    loadCommonData();
  }, []);

  // 当左侧树切换 regionCode 时，仅重新拉取该区域的摄像机
  useEffect(() => {
    loadCameraData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionCode, cameraId]);

  useEffect(() => {
    let cancelled = false;
    getStatisticsOverview(statisticsScopeParams)
      .then((overview) => {
        if (!cancelled) setScopeMetrics(overview);
      })
      .catch((err) => {
        if (!cancelled) {
          console.error("Failed to load diagnosis scope metrics:", err);
          setScopeMetrics(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [statisticsScopeParams.camera_id, statisticsScopeParams.camera_ids, statisticsScopeParams.region_code]);

  useEffect(() => {
    if (cameraId) setActiveTab("camera");
  }, [cameraId]);

  useEffect(() => {
    if (!cameraId) return;
    const camera = cameras.find((item) => item.id === cameraId);
    if (!camera) return;

    setActiveTab("camera");

    if (focusTarget?.openDiagnosis) {
      setDetail(null);
      setDiagnosisCamera(camera);
      setDiagnosisFromExternal(Boolean(focusTarget?.returnTab));
      return;
    }

    if (focusTarget?.openDetail || detail?.type === "camera") {
      setDiagnosisCamera(null);
      setDetail({
        type: "camera",
        item: camera,
        fromExternal: Boolean(focusTarget?.returnTab),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraId, cameras, focusTarget?.version]);

  useEffect(() => {
    if (focusTarget?.deviceTab) {
      setActiveTab(focusTarget.deviceTab);
    }
    if (focusTarget?.statusFilter) {
      setDeviceStatusFilter(focusTarget.statusFilter);
    }
  }, [focusTarget?.version]);

  useEffect(() => {
    setDetail(null);
    setDiagnosisCamera(null);
    setDiagnosisFromExternal(false);
    setFormState(null);
    if (!focusTarget?.deviceTab) {
      setActiveTab("camera");
      setDeviceStatusFilter("all");
    }
  }, [resetVersion]);

  const closeDetail = () => {
    const shouldReturn = detail?.fromExternal;
    setDetail(null);
    if (shouldReturn) {
      onCloseExternalDetail?.();
    }
  };

  const openDiagnosis = (camera) => {
    setDetail(null);
    setDiagnosisCamera(camera);
    setDiagnosisFromExternal(false);
  };

  const closeDiagnosis = () => {
    const shouldReturn = diagnosisFromExternal;
    setDiagnosisCamera(null);
    setDiagnosisFromExternal(false);
    setDetail(null);
    if (shouldReturn) {
      onCloseExternalDetail?.();
    }
  };

  const metricCameraValue = scopeMetrics
    ? formatStatusMetricValue(scopeMetrics.device_status?.cameras, "台")
    : `${focusedCameras.filter((item) => item.status !== "offline").length}/${focusedCameras.length} 台`;
  const metricServerValue = scopeMetrics
    ? formatStatusMetricValue(scopeMetrics.device_status?.servers, "台", "normal")
    : `${focusedServers.filter((item) => item.status === "normal").length}/${focusedServers.length} 台`;
  const metricStreamValue = scopeMetrics
    ? formatStatusMetricValue(scopeMetrics.device_status?.streams, "条")
    : `${focusedStreams.filter((item) => item.is_connected).length}/${focusedStreams.length} 条`;
  const activeFlowInfo = activeFlowMeta
    ? `match流：${activeFlowMeta.collectable_flow_count || 0}/${activeFlowMeta.raw_flow_count || 0} 可采集`
    : "";
  const selectedChainlistCount = selectedChainlistStreamIds.size;

  const scopeText = focusTarget
    ? focusTarget.nodeType === "camera"
      ? `当前摄像机：${focusTarget.name}`
      : focusTarget.nodeType === "custom_folder"
      ? `当前分区：${focusTarget.name}`
      : focusTarget.nodeType === "region"
      ? `当前行政区：${focusTarget.name}`
      : "当前范围：全网设备"
    : "当前范围：全网设备";

  const handleOpenCreate = (type) => {
    setFormState({
      type,
      mode: "create",
      error: "",
      form:
        type === "camera"
          ? {
              ...cameraInitialForm,
              ...(focusTarget?.nodeType === "region" && focusTarget.level === "town"
                ? { town_code: focusTarget.regionCode, town_name: focusTarget.name }
                : {}),
            }
          : serverInitialForm,
    });
  };

  const handleOpenEdit = (type, item) => {
    setFormState({
      type,
      mode: "edit",
      error: "",
      form: type === "camera" ? normalizeCameraForm(item) : normalizeServerForm(item),
    });
  };

  const handleFormChange = (event) => {
    const { name, value } = event.target;
    setFormState((prev) => ({
      ...prev,
      error: "",
      form: {
        ...prev.form,
        [name]: value,
      },
    }));
  };

  const handleRegionSelect = (regionPatch) => {
    setFormState((prev) => ({
      ...prev,
      error: "",
      form: {
        ...prev.form,
        ...regionPatch,
      },
    }));
  };

  const handleSubmitForm = async (event) => {
    event.preventDefault();
    if (!formState) return;

    try {
      if (formState.type === "camera") {
        const cameraRequiredError = validateRequiredFields(formState.form, [
          { key: "id", label: "摄像机ID" },
          { key: "name", label: "摄像机名称" },
          { key: "ip", label: "摄像机IP" },
          { key: "status", label: "状态" },
          { key: "protocol", label: "协议" },
          { key: "codec", label: "编码格式" },
          { key: "stream_type", label: "码流类型" },
          { key: "access_type", label: "接入方式" },
        ]);

        if (cameraRequiredError) {
          setFormState((prev) => ({
            ...prev,
            error: cameraRequiredError,
          }));
          return;
        }

        const missingRegion = ["province_code", "city_code", "county_code", "town_code"].some((key) => !emptyToNull(formState.form[key]));
        if (missingRegion) {
          setFormState((prev) => ({
            ...prev,
            error: "请先通过行政区搜索选择摄像机所属乡镇/街道",
          }));
          return;
        }

        const payload = buildCameraPayload(formState.form, null);
        if (formState.mode === "create") {
          await createDeviceCamera(payload);
        } else {
          const { id, ...updatePayload } = payload;
          await updateDeviceCamera(formState.form.id, updatePayload);
        }
      } else {
        const serverRequiredError = validateRequiredFields(formState.form, [
          { key: "id", label: "服务器ID" },
          { key: "name", label: "服务器名称" },
          { key: "ip", label: "服务器IP" },
          { key: "status", label: "状态" },
          { key: "node_type", label: "节点类型" },
        ]);

        if (serverRequiredError) {
          setFormState((prev) => ({
            ...prev,
            error: serverRequiredError,
          }));
          return;
        }

        const payload = buildServerPayload(formState.form);
        if (formState.mode === "create") {
          await createDeviceServer(payload);
        } else {
          const { id, ...updatePayload } = payload;
          await updateDeviceServer(formState.form.id, updatePayload);
        }
      }

      setFormState(null);
      await loadCommonData();
      await loadCameraData();
    } catch (err) {
      console.error("Failed to save device:", err);
      setFormState((prev) => ({
        ...prev,
        error: err.response?.data?.detail || err.message || "保存失败",
      }));
    }
  };

  const handleDelete = async (type, item) => {
    const label = type === "camera" ? "摄像机" : "服务器";
    const entityId = item.id === null || item.id === undefined ? "" : String(item.id);
    if (type === "server" && !entityId) {
      setError("无法删除：服务器ID为空");
      return;
    }

    if (!window.confirm(`确认删除${label} ${item.name || entityId || "空ID设备"} 吗？相关自动流链路也会被清理。`)) return;

    try {
      if (type === "camera") {
        await deleteDeviceCamera(entityId);
      } else {
        await deleteDeviceServer(entityId);
      }
      await loadCommonData();
      await loadCameraData();
    } catch (err) {
      console.error("Failed to delete device:", err);
      setError(err.response?.data?.detail || err.message || "删除失败");
    }
  };

  const cameraColumns = [
    { key: "name", label: "摄像机", className: "min-w-[24rem]" },
    { key: "id", label: "设备ID", className: "min-w-[12rem]" },
    { key: "ip", label: "IP", className: "min-w-[10rem]" },
    {
      key: "status",
      label: "状态",
      className: "min-w-[8rem]",
      render: (row) => <span className={`rounded-[var(--layout-radius-sm)] border px-[var(--layout-tree-action-padding)] ${statusClass(row.status)}`}>{cameraStatusText(row.status)}</span>,
    },
    { key: "town_name", label: "所属乡镇", className: "min-w-[12rem]" },
    { key: "location_desc", label: "位置", className: "min-w-[24rem]" },
    { key: "server_id", label: "绑定服务器", className: "min-w-[12rem]" },
    { key: "vendor", label: "厂商", className: "min-w-[10rem]" },
  ];

  const serverColumns = [
    { key: "name", label: "服务器", className: "min-w-[20rem]" },
    { key: "id", label: "服务器ID", className: "min-w-[12rem]" },
    { key: "ip", label: "IP", className: "min-w-[10rem]" },
    { key: "node_type", label: "节点类型", className: "min-w-[12rem]" },
    {
      key: "status",
      label: "状态",
      className: "min-w-[8rem]",
      render: (row) => <span className={`rounded-[var(--layout-radius-sm)] border px-[var(--layout-tree-action-padding)] ${statusClass(row.status)}`}>{serverStatusText(row.status)}</span>,
    },
    { key: "location_desc", label: "位置", className: "min-w-[20rem]" },
  ];

  const streamColumns = [
    { key: "display_id", label: "设备ID", className: "min-w-[18rem]", render: (row) => formatValue(row.display_id || row.device_id || row.camera_id) },
    { key: "source_ip", label: "摄像机IP", className: "min-w-[12rem]", render: (row) => formatValue(row.source_ip) },
    { key: "destination_ip", label: "服务器IP", className: "min-w-[12rem]", render: (row) => formatValue(row.destination_ip || row.server_id) },
    { key: "ssrc", label: "SSRC", className: "min-w-[12rem]", render: (row) => formatStreamSsrc(row.ssrc) },
    {
      key: "link_status",
      label: "链路状态",
      className: "min-w-[8rem]",
      render: (row) => <span className={`rounded-[var(--layout-radius-sm)] border px-[var(--layout-tree-action-padding)] ${streamStatusClass(row)}`}>{streamStatusText(row)}</span>,
    },
  ];

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-[var(--layout-content-gap)] bg-[var(--color-page-bg)] p-[var(--layout-content-padding)] transition-colors">
      <section className="grid grid-cols-3 gap-[var(--layout-content-gap)]">
        <MetricCard icon={Camera} label="摄像机（在线/总数）" value={metricCameraValue} />
        <MetricCard icon={Server} label="服务器（在线/总数）" value={metricServerValue} />
        <MetricCard icon={Link2} label="流链路（连通/总数）" value={metricStreamValue} />
      </section>

      <section className="flex min-h-0 flex-1 flex-col gap-[var(--layout-content-gap)] rounded-[var(--layout-radius-lg)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] p-[var(--layout-content-padding)] shadow-[var(--shadow-panel)]">
        <header className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-[var(--layout-content-gap)] gap-y-[var(--layout-search-gap)]">
          <div className="min-w-0 truncate text-ui-large font-bold text-[var(--color-text-main)]" title={scopeText}>
            {scopeText}
          </div>

          <div className="flex min-w-0 items-center justify-end gap-[var(--layout-search-gap)]">
            <div className="flex min-h-[var(--layout-search-height)] w-[min(22rem,24vw)] min-w-[16rem] items-center gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)]">
              <Search size="var(--icon-search)" className="text-[var(--color-icon-muted)]" />
              <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索名称、IP、ID" className="min-w-0 flex-1 bg-transparent text-ui-medium text-[var(--color-text-main)] outline-none placeholder:text-[var(--color-text-muted)]" />
            </div>
            <button type="button" onClick={handleRefresh} className="flex min-h-[var(--layout-segment-button-height)] shrink-0 items-center gap-[var(--layout-reset-tooltip-gap)] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] px-[var(--layout-segment-button-padding-x)] text-ui-medium text-[var(--color-text-muted)] hover:bg-[var(--color-hover-bg)] hover:text-[var(--color-accent)]">
              <RefreshCw size="var(--icon-bottom)" />
              刷新
            </button>
            {activeTab === "stream" && (
              <button type="button" onClick={applySelectedChainlist} className="flex min-h-[var(--layout-segment-button-height)] shrink-0 items-center gap-[var(--layout-reset-tooltip-gap)] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] px-[var(--layout-segment-button-padding-x)] text-ui-medium text-[var(--color-text-muted)] hover:bg-[var(--color-hover-bg)] hover:text-[var(--color-accent)]">
                <Link2 size="var(--icon-bottom)" />
                应用采集{selectedChainlistCount ? `(${selectedChainlistCount})` : ""}
              </button>
            )}
            {activeTab === "stream" && (
              <button type="button" onClick={handleRefreshActiveFlows} className="flex min-h-[var(--layout-segment-button-height)] shrink-0 items-center gap-[var(--layout-reset-tooltip-gap)] rounded-[var(--layout-radius-sm)] bg-[var(--color-topbar-active-bg)] px-[var(--layout-segment-button-padding-x)] text-ui-medium font-medium text-[var(--color-topbar-active-text)] hover:bg-[var(--color-accent)]">
                <RefreshCw size="var(--icon-bottom)" />
                刷新流链路信息
              </button>
            )}
          </div>

          <div className="flex items-center gap-[var(--layout-content-gap)]">
            <div className="grid w-fit min-w-0 grid-cols-3 rounded-[var(--layout-radius-lg)] bg-[var(--color-control-bg)] p-[var(--layout-segment-padding)] text-ui-medium">
              {[
                { key: "camera", label: "摄像机", icon: Camera },
                { key: "server", label: "服务器", icon: Server },
                { key: "stream", label: "流链路", icon: Link2 },
              ].map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setDetail(null);
                    setDiagnosisCamera(null);
                    setDiagnosisFromExternal(false);
                    setActiveTab(key);
                  }}
                  className={`flex min-h-[var(--layout-segment-button-height)] items-center justify-center gap-[var(--layout-search-gap)] whitespace-nowrap rounded-[var(--layout-radius-md)] px-[var(--layout-segment-button-padding-x)] font-medium transition-colors ${activeTab === key ? "bg-[var(--color-topbar-active-bg)] text-[var(--color-topbar-active-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:bg-[var(--color-hover-bg)] hover:text-[var(--color-accent)]"}`}
                >
                  <Icon size="var(--icon-bottom)" />
                  {label}
                </button>
              ))}
            </div>
            
            <select
              value={deviceStatusFilter}
              onChange={(event) => setDeviceStatusFilter(event.target.value)}
              className="min-h-[var(--layout-segment-button-height)] shrink-0 rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-segment-button-padding-y)] text-ui-medium text-[var(--color-text-main)] outline-none hover:border-[var(--color-accent)] transition-colors"
            >
              <option value="all">全部状态</option>
              <option value="normal">正常</option>
              <option value="fault">异常</option>
              <option value="offline">离线</option>
            </select>
          </div>

          <div className="flex justify-end">
            {activeTab !== "stream" && !readonlyMode && (
              <button type="button" onClick={() => handleOpenCreate(activeTab)} className="flex min-h-[var(--layout-segment-button-height)] items-center gap-[var(--layout-reset-tooltip-gap)] rounded-[var(--layout-radius-sm)] bg-[var(--color-topbar-active-bg)] px-[var(--layout-tab-padding-x)] text-ui-medium font-medium text-[var(--color-topbar-active-text)]">
                <Plus size="var(--icon-bottom)" />
                {activeTab === "camera" ? "流链路绑定" : "新增服务器"}
              </button>
            )}
          </div>
        </header>

        {error && (
          <div className="rounded-[var(--layout-radius-sm)] bg-[var(--color-error-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)] text-ui-small text-[var(--color-error-text)]">
            {error}
          </div>
        )}

        {activeTab === "stream" && activeFlowInfo && !detail && !diagnosisCamera && (
          <div className="rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)] text-ui-small text-[var(--color-text-muted)]">
            {activeFlowInfo}；来源：{activeFlowMeta?.source_file || "match结果"}；勾选在线完整流后点击“应用采集”，未勾选时自动选择最多 5 条在线完整流。
          </div>
        )}

        {diagnosisCamera ? (
          <VideoDiagnosisView camera={diagnosisCamera} onClose={closeDiagnosis} />
        ) : detail ? (
          <DetailView detail={detail} onClose={closeDetail} onDiagnose={openDiagnosis} />
        ) : loading ? (
          <div className="flex min-h-0 flex-1 items-center justify-center gap-[var(--layout-search-gap)] text-ui-medium text-[var(--color-text-muted)]">
            <Loader2 size="var(--icon-search)" className="animate-spin" />
            正在加载设备数据
          </div>
        ) : activeTab === "camera" ? (
          <DeviceTable columns={cameraColumns} rows={shownCameras} emptyText="当前范围暂无摄像机" onView={(item) => { setDiagnosisCamera(null); setDetail({ type: "camera", item }); }} onEdit={(item) => handleOpenEdit("camera", item)} onDelete={(item) => handleDelete("camera", item)} onDiagnose={openDiagnosis} readonly={readonlyMode} />
        ) : activeTab === "server" ? (
          <DeviceTable columns={serverColumns} rows={shownServers} emptyText="当前范围暂无关联服务器" onView={(item) => { setDiagnosisCamera(null); setDetail({ type: "server", item }); }} onEdit={(item) => handleOpenEdit("server", item)} onDelete={(item) => handleDelete("server", item)} readonly={readonlyMode} />
        ) : (
          <DeviceTable columns={streamColumns} rows={shownStreams} emptyText="当前范围暂无流链路" onView={(item) => { setDiagnosisCamera(null); setDetail({ type: "stream", item }); }} readonly renderExpanded={(item) => <StreamSegmentTable stream={item} />} selection={{ selectedIds: selectedChainlistStreamIds, onToggle: toggleChainlistStream, isDisabled: (row) => !row.is_connected }} />
        )}
      </section>

      {formState && (
        <DeviceFormModal type={formState.type} mode={formState.mode} form={formState.form} error={formState.error} servers={servers} selectedRegion={focusTarget} onChange={handleFormChange} onRegionSelect={handleRegionSelect} onSubmit={handleSubmitForm} onClose={() => setFormState(null)} />
      )}
    </main>
  );
}
