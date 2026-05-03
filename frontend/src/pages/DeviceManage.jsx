import { useEffect, useMemo, useRef, useState } from "react";
import {
  Camera,
  Edit3,
  Eye,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Server,
  Trash2,
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

function DeviceTable({ columns, rows, emptyText, onView, onEdit, onDelete, readonly = false }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)]">
      <table className="w-max min-w-full border-separate border-spacing-0 text-left text-ui-medium">
        <thead className="sticky top-0 z-10 bg-[var(--color-control-bg)] text-[var(--color-text-muted)]">
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={`whitespace-nowrap border-b border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] py-[var(--layout-device-table-padding-y)] font-semibold ${column.className || "min-w-[12rem]"}`}>
                {column.label}
              </th>
            ))}
            <th className="sticky right-0 z-20 min-w-[10rem] whitespace-nowrap border-b border-l border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-device-table-padding-y)] font-semibold shadow-[-0.75rem_0_1rem_rgba(0,0,0,0.08)]">
              操作
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length + 1} className="px-[var(--layout-content-padding)] py-[var(--layout-content-padding)] text-center text-[var(--color-text-muted)]">
                {emptyText}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id} className="text-[var(--color-text-main)] hover:bg-[var(--color-hover-bg)]">
                {columns.map((column) => (
                  <td key={column.key} className={`whitespace-nowrap border-b border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] py-[var(--layout-device-table-padding-y)] ${column.className || "min-w-[12rem]"}`}>
                    {column.render ? column.render(row) : formatValue(row[column.key])}
                  </td>
                ))}
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
            ))
          )}
        </tbody>
      </table>
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

function InfoLine({ label, value, mono = false }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-[var(--layout-search-gap)] border-b border-[var(--color-panel-border)] py-[var(--layout-search-padding-y)] last:border-b-0">
      <span className="whitespace-nowrap text-[var(--color-text-muted)]">{label}</span>
      <span className={`min-w-0 whitespace-nowrap text-[var(--color-text-main)] ${mono ? "font-mono" : ""}`}>{formatValue(value)}</span>
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

function CameraPreview({ camera }) {
  const [previewUrl, setPreviewUrl] = useState("");
  const [startTime, setStartTime] = useState(0);
  const [previewError, setPreviewError] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [pendingPlay, setPendingPlay] = useState(false);
  const [clockText, setClockText] = useState("");
  const videoRef = useRef(null);
  const canPreview = camera.status !== "offline";

  useEffect(() => {
    const updateClock = () => {
      const now = new Date();
      const pad = (value) => String(value).padStart(2, "0");
      setClockText(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`);
    };
    updateClock();
    const timer = window.setInterval(updateClock, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!pendingPlay || !previewUrl) return;
    const video = videoRef.current;
    if (!video) return;

    const playFromStart = () => {
      if (Number.isFinite(startTime)) {
        video.currentTime = startTime;
      }
      video.play().then(() => setIsPlaying(true)).catch((err) => {
        console.error("Failed to play preview video:", err);
        setPreviewError("视频播放失败");
      });
      setPendingPlay(false);
    };

    if (video.readyState >= 1) {
      playFromStart();
      return;
    }

    video.addEventListener("loadedmetadata", playFromStart, { once: true });
    video.load();

    return () => {
      video.removeEventListener("loadedmetadata", playFromStart);
    };
  }, [pendingPlay, previewUrl, startTime]);

  const togglePreview = async () => {
    if (!canPreview || previewLoading) return;

    if (isPlaying) {
      videoRef.current?.pause();
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
        setPreviewUrl(url);
      }
      setPendingPlay(true);
    } catch (err) {
      console.error("Failed to load camera preview:", err);
      setPreviewError(err.response?.data?.detail || err.message || "预览拉取失败");
    } finally {
      setPreviewLoading(false);
    }
  };

  return (
    <div className="relative min-h-0 overflow-hidden rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-black">
      <div className="relative aspect-video min-h-0">
        {previewUrl ? (
          <video ref={videoRef} key={previewUrl} src={previewUrl} loop muted playsInline className="h-full w-full translate-y-12 object-contain" onPause={() => setIsPlaying(false)} onPlay={() => setIsPlaying(true)} />
        ) : (
          <div className="flex h-full items-center justify-center text-ui-medium text-white/55">{canPreview ? "" : "离线摄像机不可预览"}</div>
        )}
        <div className="absolute left-[var(--layout-content-gap)] top-[var(--layout-search-padding-y)] rounded-[var(--layout-radius-sm)] bg-black/60 px-[var(--layout-search-padding-x)] py-[var(--layout-segment-button-padding-y)] text-ui-small font-semibold text-white">
          {clockText}
        </div>
        <button type="button" onClick={togglePreview} disabled={!canPreview || previewLoading} className="absolute left-1/2 top-1/2 grid h-[4.5rem] w-[4.5rem] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-white transition hover:bg-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-45">
          {previewLoading ? <Loader2 size="var(--icon-topbar)" className="animate-spin" /> : isPlaying ? "Ⅱ" : "▶"}
        </button>
        {previewError && (
          <div className="absolute inset-x-0 bottom-0 bg-[var(--color-error-bg)] px-[var(--layout-content-gap)] py-[var(--layout-search-padding-y)] text-ui-small text-[var(--color-error-text)]">
            {previewError}
          </div>
        )}
      </div>
    </div>
  );
}

function CameraDetailContent({ item }) {
  return (
    <div className="grid min-h-0 grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)] gap-[var(--layout-content-gap)]">
      <div className="grid content-start gap-[var(--layout-content-gap)]">
        <div className="grid gap-[var(--layout-content-gap)] text-ui-medium">
          <div className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] p-[var(--layout-content-gap)]">
            <div className="mb-[var(--layout-search-padding-y)] text-ui-medium font-semibold text-[var(--color-text-main)]">基础信息</div>
            <InfoLine label="IP" value={item.ip} mono />
            <InfoLine label="协议" value={item.protocol} />
            <InfoLine label="编码" value={item.codec} />
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

      <CameraPreview camera={item} />
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
          <InfoLine label="SSRC" value={item.ssrc} mono />
        </div>
        <div className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] p-[var(--layout-content-gap)]">
          <div className="mb-[var(--layout-search-padding-y)] text-ui-medium font-semibold text-[var(--color-text-main)]">传输参数</div>
          <InfoLine label="链路状态" value={streamStatusText(item)} />
          <InfoLine label="编码" value={item.codec} />
          <InfoLine label="分辨率" value={item.resolution} />
          <InfoLine label="帧率" value={item.frame_rate} />
          <InfoLine label="QoE" value={item.qoe_score} />
        </div>
      </div>
    </div>
  );
}

function DetailView({ detail, onClose }) {
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
                  <span className="shrink-0 font-mono text-[var(--color-text-muted)]">SSRC: {formatValue(item.ssrc)}</span>
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
          {isCamera && <CameraDetailContent item={item} />}
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
                <Field label="编码" name="codec" value={form.codec} onChange={onChange} options={[{ label: "H.264", value: "H.264" }, { label: "H.265", value: "H.265" }, { label: "MJPEG", value: "MJPEG" }]} />
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

export default function DeviceManage({ focusTarget }) {
  const [activeTab, setActiveTab] = useState("camera");
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [cameras, setCameras] = useState([]);
  const [servers, setServers] = useState([]);
  const [streams, setStreams] = useState([]);
  const [detail, setDetail] = useState(null);
  const [formState, setFormState] = useState(null);

  const regionCode = focusTarget?.nodeType === "region" ? focusTarget.regionCode : "";
  const cameraId = focusTarget?.nodeType === "camera" ? focusTarget.cameraId : "";

  const focusedCameras = useMemo(() => {
    if (cameraId) return cameras.filter((camera) => camera.id === cameraId);
    return cameras;
  }, [cameras, cameraId]);

  const focusedServerIds = useMemo(
    () => new Set(focusedCameras.map((camera) => camera.server_id).filter(Boolean)),
    [focusedCameras]
  );

  const focusedServers = useMemo(() => {
    if (cameraId || regionCode) {
      return servers.filter((server) => focusedServerIds.has(server.id));
    }
    return servers;
  }, [servers, focusedServerIds, cameraId, regionCode]);

  const focusedCameraIds = useMemo(
    () => new Set(focusedCameras.map((camera) => camera.id)),
    [focusedCameras]
  );

  const focusedStreams = useMemo(() => {
    if (cameraId || regionCode) {
      return streams.filter((stream) => focusedCameraIds.has(stream.camera_id));
    }
    return streams;
  }, [streams, focusedCameraIds, cameraId, regionCode]);

  const shownCameras = useMemo(
    () => filterByKeyword(focusedCameras, keyword, ["id", "name", "ip", "town_name", "server_id"]),
    [focusedCameras, keyword]
  );
  const shownServers = useMemo(
    () => filterByKeyword(focusedServers, keyword, ["id", "name", "ip", "node_type"]),
    [focusedServers, keyword]
  );
  const shownStreams = useMemo(
    () => filterByKeyword(focusedStreams, keyword, ["id", "camera_id", "server_id", "ssrc"]),
    [focusedStreams, keyword]
  );

  const loadData = async () => {
    setLoading(true);
    setError("");

    try {
      const [cameraRows, serverRows, streamRows] = await Promise.all([
        getDeviceCameras(regionCode ? { region_code: regionCode } : {}),
        getDeviceServers(),
        getDeviceStreams(),
      ]);

      setCameras(cameraRows);
      setServers(serverRows);
      setStreams(streamRows);
    } catch (err) {
      console.error("Failed to load device data:", err);
      setError(err.message || "设备数据加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionCode, cameraId]);

  useEffect(() => {
    if (cameraId) setActiveTab("camera");
  }, [cameraId]);

  const onlineCameraCount = focusedCameras.filter((item) => item.status === "online").length;
  const onlineServerCount = focusedServers.filter((item) => item.status === "normal").length;
  const connectedStreamCount = focusedStreams.filter((item) => item.is_connected && !item.is_fault).length;

  const scopeText = focusTarget
    ? focusTarget.nodeType === "camera"
      ? `当前摄像机：${focusTarget.name}`
      : `当前行政区：${focusTarget.name}`
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
          { key: "codec", label: "编码" },
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
      await loadData();
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
      await loadData();
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
    { key: "protocol", label: "协议", className: "min-w-[8rem]" },
    { key: "codec", label: "编码", className: "min-w-[8rem]" },
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
    { key: "id", label: "链路ID", className: "min-w-[18rem]" },
    { key: "camera_id", label: "摄像机", className: "min-w-[14rem]" },
    { key: "server_id", label: "服务器", className: "min-w-[14rem]" },
    { key: "ssrc", label: "SSRC", className: "min-w-[12rem]" },
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
        <MetricCard icon={Camera} label="摄像机（在线/总数）" value={`${onlineCameraCount}/${focusedCameras.length} 台`} />
        <MetricCard icon={Server} label="服务器（在线/总数）" value={`${onlineServerCount}/${focusedServers.length} 台`} />
        <MetricCard icon={Link2} label="流链路（连通/总数）" value={`${connectedStreamCount}/${focusedStreams.length} 条`} />
      </section>

      <section className="flex min-h-0 flex-1 flex-col gap-[var(--layout-content-gap)] rounded-[var(--layout-radius-lg)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] p-[var(--layout-content-padding)] shadow-[var(--shadow-panel)]">
        <header className="flex shrink-0 flex-wrap items-center gap-[var(--layout-content-gap)]">
          <div className="flex min-w-0 items-center gap-[var(--layout-content-gap)]">
            <div className="shrink-0 text-ui-large font-bold text-[var(--color-text-main)]">设备管理</div>
            <div className="min-w-0 truncate text-ui-medium text-[var(--color-text-muted)]">{scopeText}</div>
          </div>

          <div className="ml-[calc(var(--layout-content-padding)*3)] grid min-w-0 grid-cols-3 rounded-[var(--layout-radius-lg)] bg-[var(--color-control-bg)] p-[var(--layout-segment-padding)] text-ui-medium">
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
                  setActiveTab(key);
                }}
                className={`flex min-h-[var(--layout-segment-button-height)] items-center justify-center gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-md)] px-[var(--layout-segment-button-padding-x)] font-medium transition-colors ${activeTab === key ? "bg-[var(--color-topbar-active-bg)] text-[var(--color-topbar-active-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:bg-[var(--color-hover-bg)] hover:text-[var(--color-accent)]"}`}
              >
                <Icon size="var(--icon-bottom)" />
                {label}
              </button>
            ))}
          </div>

          {activeTab !== "stream" && (
            <button type="button" onClick={() => handleOpenCreate(activeTab)} className="flex min-h-[var(--layout-segment-button-height)] items-center gap-[var(--layout-reset-tooltip-gap)] rounded-[var(--layout-radius-sm)] bg-[var(--color-topbar-active-bg)] px-[var(--layout-tab-padding-x)] text-ui-medium font-medium text-[var(--color-topbar-active-text)]">
              <Plus size="var(--icon-bottom)" />
              {activeTab === "camera" ? "新增摄像机" : "新增服务器"}
            </button>
          )}

          <div className="ml-auto flex min-w-0 items-center gap-[var(--layout-search-gap)]">
            <div className="flex min-h-[var(--layout-search-height)] min-w-[24rem] items-center gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)]">
              <Search size="var(--icon-search)" className="text-[var(--color-icon-muted)]" />
              <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索名称、IP、ID" className="min-w-0 flex-1 bg-transparent text-ui-medium text-[var(--color-text-main)] outline-none placeholder:text-[var(--color-text-muted)]" />
            </div>
            <button type="button" onClick={loadData} className="flex min-h-[var(--layout-segment-button-height)] items-center gap-[var(--layout-reset-tooltip-gap)] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] px-[var(--layout-segment-button-padding-x)] text-ui-medium text-[var(--color-text-muted)] hover:bg-[var(--color-hover-bg)] hover:text-[var(--color-accent)]">
              <RefreshCw size="var(--icon-bottom)" />
              刷新
            </button>
          </div>
        </header>

        {error && (
          <div className="rounded-[var(--layout-radius-sm)] bg-[var(--color-error-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)] text-ui-small text-[var(--color-error-text)]">
            {error}
          </div>
        )}

        {detail ? (
          <DetailView detail={detail} onClose={() => setDetail(null)} />
        ) : loading ? (
          <div className="flex min-h-0 flex-1 items-center justify-center gap-[var(--layout-search-gap)] text-ui-medium text-[var(--color-text-muted)]">
            <Loader2 size="var(--icon-search)" className="animate-spin" />
            正在加载设备数据
          </div>
        ) : activeTab === "camera" ? (
          <DeviceTable columns={cameraColumns} rows={shownCameras} emptyText="当前范围暂无摄像机" onView={(item) => setDetail({ type: "camera", item })} onEdit={(item) => handleOpenEdit("camera", item)} onDelete={(item) => handleDelete("camera", item)} />
        ) : activeTab === "server" ? (
          <DeviceTable columns={serverColumns} rows={shownServers} emptyText="当前范围暂无关联服务器" onView={(item) => setDetail({ type: "server", item })} onEdit={(item) => handleOpenEdit("server", item)} onDelete={(item) => handleDelete("server", item)} />
        ) : (
          <DeviceTable columns={streamColumns} rows={shownStreams} emptyText="当前范围暂无流链路" onView={(item) => setDetail({ type: "stream", item })} readonly />
        )}
      </section>

      {formState && (
        <DeviceFormModal type={formState.type} mode={formState.mode} form={formState.form} error={formState.error} servers={servers} selectedRegion={focusTarget} onChange={handleFormChange} onRegionSelect={handleRegionSelect} onSubmit={handleSubmitForm} onClose={() => setFormState(null)} />
      )}
    </main>
  );
}
