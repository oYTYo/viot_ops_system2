import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Camera, CheckCircle2, Loader2, MapPinned, RadioTower, Server, TrendingUp, WifiOff } from "lucide-react";
import {
  getMapCamera,
  getMapRegion,
  getMapRegionCameras,
  getMapRegionChildren,
} from "../services/mapApi";
import { getCameraPreview } from "../services/videoApi";
import { getStatisticsOverview } from "../services/statisticsApi";

const AMAP_URL = "https://webapi.amap.com/maps?v=2.0";
const CHINA_CENTER = [104.195397, 35.86166];
const MAP_STYLE = {
  light: "amap://styles/normal",
  dark: "amap://styles/darkblue",
};
const LEVEL_ZOOM = {
  country: 4,
  province: 7,
  city: 10,
  county: 12,
  town: 14,
  camera: 16,
};
let cachedMapViewState = null;

function parseCenter(center) {
  if (!center) return null;

  const [lng, lat] = String(center)
    .split(",")
    .map((item) => Number(item.trim()));

  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

function hasLngLat(item) {
  return Number.isFinite(Number(item.longitude)) && Number.isFinite(Number(item.latitude));
}

function getCameraRegionCode(camera) {
  return camera?.regionCode || camera?.region_code || camera?.town_code || "";
}

function getCameraId(camera) {
  return camera?.cameraId || camera?.camera_id || camera?.id || "";
}

function loadAmapScript(key) {
  if (window.AMap) return Promise.resolve(window.AMap);

  if (!window.__viotAmapPromise) {
    window.__viotAmapPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${AMAP_URL}&key=${encodeURIComponent(key)}`;
      script.async = true;
      script.onload = () => resolve(window.AMap);
      script.onerror = () => reject(new Error("高德地图脚本加载失败"));
      document.head.appendChild(script);
    });
  }

  return window.__viotAmapPromise;
}

function removeMapOverlays(map, overlays) {
  overlays.forEach((overlay) => {
    try {
      map.remove(overlay);
    } catch (error) {
      console.warn("Failed to remove map overlay:", error);
    }
  });
}

function getRegionMarkerContent(region) {
  return `
    <div class="viot-map-region-marker">
      <div class="viot-map-region-title">${region.region_name || region.name || ""}</div>
      <div class="viot-map-region-count">${Number(region.online || 0)}/${Number(region.total || 0)}</div>
    </div>
  `;
}

function getCameraMarkerContent(camera, focused = false) {
  const statusClass =
    camera.status === "offline"
      ? "is-offline"
      : camera.status === "fault"
        ? "is-fault"
        : "is-online";
  const focusedClass = focused ? "is-focused" : "";

  return `
    <div class="viot-map-camera-marker ${statusClass} ${focusedClass}">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14.5 7.5 20 4.5v15l-5.5-3v-9Z"></path>
        <rect x="3" y="6.5" width="11.5" height="11" rx="2.2"></rect>
        <circle cx="8.8" cy="12" r="2.2"></circle>
      </svg>
    </div>
  `;
}

function MapCameraPreview({ camera, onClose, onDetail, onDiagnose }) {
  const [state, setState] = useState("connecting");
  const [preview, setPreview] = useState(null);
  const videoRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    setState("connecting");
    setPreview(null);

    if (camera.status === "offline") {
      const timer = window.setTimeout(() => {
        if (!cancelled) setState("failed");
      }, 3000);
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    }

    getCameraPreview(getCameraId(camera))
      .then((data) => {
        if (cancelled) return;
        setPreview(data);
        setState("playing");
      })
      .catch(() => {
        if (!cancelled) setState("failed");
      });

    return () => {
      cancelled = true;
    };
  }, [camera]);

  useEffect(() => {
    if (!preview?.play_url || state !== "playing") return undefined;
    const video = videoRef.current;
    if (!video) return undefined;
    const play = () => {
      video.currentTime = Number(preview.start_time || 0);
      video.play().catch(() => {});
    };
    video.addEventListener("loadedmetadata", play, { once: true });
    video.load();
    return () => video.removeEventListener("loadedmetadata", play);
  }, [preview, state]);

  return (
    <div className="absolute left-1/2 top-[var(--layout-content-padding)] z-20 w-[calc(100%-var(--layout-content-padding)*3)] -translate-x-1/2 overflow-hidden rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-black shadow-[var(--shadow-panel)]">
      <div className="flex items-center justify-between bg-black/80 px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)] text-ui-small text-white">
        <span className="truncate">{camera.name || camera.camera_name || getCameraId(camera)}</span>
        <div className="flex shrink-0 items-center gap-[var(--layout-search-gap)]">
          <button type="button" onClick={() => onDiagnose?.(camera)} className="text-[var(--color-accent)] hover:underline">根因诊断</button>
          <button type="button" onClick={onClose} className="text-white/70 hover:text-white">×</button>
        </div>
      </div>
      <div className="relative aspect-video">
        {state === "playing" && preview?.play_url ? (
          <video ref={videoRef} src={preview.play_url} muted loop playsInline className="h-full w-full object-cover" />
        ) : state === "failed" ? (
          <div className="flex h-full flex-col items-center justify-center gap-[var(--layout-search-gap)] text-ui-medium text-white">
            <AlertCircle size="var(--icon-topbar)" className="text-[var(--color-error-text)]" />
            无法连接到摄像机
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-[var(--layout-search-gap)] text-ui-medium text-white">
            <Loader2 size="var(--icon-topbar)" className="animate-spin text-[var(--color-accent)]" />
            正在连接摄像机
          </div>
        )}
        <div className="absolute bottom-[var(--layout-search-padding-y)] right-[var(--layout-search-padding-x)] flex items-center gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-sm)] bg-black/65 px-[var(--layout-search-padding-x)] py-[var(--layout-segment-button-padding-y)] text-ui-small">
          <button type="button" onClick={() => onDetail?.(camera)} className="font-medium text-[var(--color-accent)] hover:underline">详情</button>
        </div>
      </div>
    </div>
  );
}

const statusMeta = {
  normal: { label: "正常", color: "var(--color-accent)", icon: CheckCircle2 },
  fault: { label: "异常", color: "var(--color-error-text)", icon: AlertCircle },
  offline: { label: "离线/断连", color: "var(--color-text-muted)", icon: WifiOff },
};

function StatusMetricBar({ title, icon: Icon, data, offlineLabel = "离线", onTitleClick, onStatusClick }) {
  const normal = Number(data?.normal || 0);
  const fault = Number(data?.fault || 0);
  const offline = Number(data?.offline || 0);
  const total = Math.max(Number(data?.total || 0), normal + fault + offline, 0);
  const safeTotal = Math.max(total, 1);
  const rows = ["normal", "fault", "offline"].map((key) => ({
    key,
    value: key === "normal" ? normal : key === "fault" ? fault : offline,
    ...statusMeta[key],
    label: key === "offline" ? offlineLabel : statusMeta[key].label,
  }));

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-[var(--layout-search-gap)]">
        <div 
          className={`flex min-w-0 items-center gap-[var(--layout-search-gap)] ${onTitleClick ? "cursor-pointer hover:opacity-80" : ""}`}
          onClick={onTitleClick}
        >
          <Icon size="var(--icon-topbar)" className="shrink-0 text-[var(--color-accent)]" />
          <span className="truncate text-ui-medium font-bold text-[var(--color-text-main)] hover:text-[var(--color-accent)] transition-colors">{title}</span>
        </div>
        <span className="shrink-0 text-ui-large font-bold text-[var(--color-accent)]">{total}</span>
      </div>
      <div className="mt-[var(--layout-content-gap)] grid min-w-0 grid-cols-3 items-center gap-[var(--layout-content-gap)]">
        {rows.map((row) => {
          const RowIcon = row.icon;
          return (
            <span 
              key={row.key} 
              className={`flex min-w-0 items-center justify-center gap-[var(--layout-reset-tooltip-gap)] text-ui-medium text-[var(--color-text-main)] ${onStatusClick ? "cursor-pointer hover:text-[var(--color-accent)] transition-colors" : ""}`}
              onClick={() => onStatusClick && onStatusClick(row.key)}
            >
              <RowIcon size="var(--icon-bottom)" style={{ color: row.color }} />
              <span className="whitespace-nowrap">{row.label}</span>
              <span className="font-semibold">{row.value}</span>
            </span>
          );
        })}
      </div>
      <div className="mt-[var(--layout-search-gap)] flex h-[calc(var(--font-small)*0.48)] overflow-hidden rounded-full bg-[var(--color-page-bg)]">
        {rows.map((row) => (
          <div
            key={row.key}
            className="h-full"
            title={`${row.label}: ${row.value}`}
            style={{
              width: `${(row.value / safeTotal) * 100}%`,
              minWidth: row.value ? "var(--layout-tree-action-padding)" : 0,
              backgroundColor: row.color,
            }}
          />
        ))}
      </div>
    </div>
  );
}

function DashboardSection({ title, children }) {
  return (
    <section className="min-w-0">
      <h2 className="mb-[var(--layout-search-padding-y)] text-ui-large font-bold text-[var(--color-text-main)]">{title}</h2>
      <div className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] p-[var(--layout-content-padding)]">
        {children}
      </div>
    </section>
  );
}

function LatexFormulaMini() {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-center gap-x-[var(--layout-search-gap)] gap-y-[var(--layout-tree-gap)] text-ui-small text-[var(--color-text-muted)]" title="全局健康度 = 100 - 加权平均异常分数">
      <span className="shrink-0 whitespace-nowrap">全局健康度 = 100 -</span>
      <span className="inline-flex shrink-0 flex-col items-center align-middle leading-none">
        <span className="border-b border-[var(--color-text-muted)] px-[var(--layout-tree-action-padding)] pb-[var(--layout-tree-gap)]">Σ 每条链路权重 × 异常分数</span>
        <span className="px-[var(--layout-tree-action-padding)] pt-[var(--layout-tree-gap)]">Σ 每条链路权重</span>
      </span>
    </div>
  );
}

function HealthGaugeMini({ value, safeDays = 42 }) {
  const radius = 44;
  const circumference = 2 * Math.PI * radius;
  const numeric = Math.max(0, Math.min(Number(value || 0), 100));
  const dash = circumference * (numeric / 100);
  // 更新分级阈值为 90 和 70
  const color = numeric >= 90 ? "var(--color-accent)" : numeric >= 70 ? "#f59e0b" : "var(--color-error-text)";

  return (
    <div className="flex min-w-0 flex-col items-center justify-center gap-[calc(var(--layout-content-gap)*2)] pt-[var(--layout-search-padding-y)]">
      {/* 上半部分：仪表盘与图例 */}
      <div className="flex min-w-0 items-center justify-center gap-[calc(var(--layout-content-padding)*2)]">
        {/* 仪表盘及悬浮公式 */}
        <div className="group relative h-[calc(var(--font-large)*4.45)] w-[calc(var(--font-large)*4.45)] shrink-0 overflow-visible">
          <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90 scale-125 overflow-visible">
            <circle cx="60" cy="60" r={radius} fill="none" stroke="var(--color-control-bg)" strokeWidth="12" />
            <circle cx="60" cy="60" r={radius} fill="none" stroke={color} strokeWidth="12" strokeLinecap="round" strokeDasharray={`${dash} ${circumference - dash}`} />
          </svg>
          <div className="absolute inset-0 grid scale-115 place-items-center text-center">
            <div className="text-ui-large font-bold leading-none" style={{ color }}>{numeric.toFixed(1)}</div>
          </div>
          {/* Hover 悬浮显示公式 */}
          <div className="pointer-events-none absolute left-67 top-[110%] z-[9999] w-max -translate-x-1/2 opacity-0 transition-opacity group-hover:opacity-100 rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] p-[var(--layout-content-padding)] shadow-[var(--shadow-panel)]">
            <LatexFormulaMini />
          </div>
        </div>

        {/* 右侧：色彩分级图例 */}
        <div className="flex flex-col gap-[var(--layout-search-gap)]">
          <div className="flex items-center gap-[var(--layout-reset-tooltip-gap)]">
            <span className="h-[calc(var(--font-small)*0.8)] w-[calc(var(--font-small)*0.8)] rounded-sm bg-[var(--color-accent)]" />
            <span className="text-ui-medium text-[var(--color-text-main)]">健康（健康度90-100）</span>
          </div>
          <div className="flex items-center gap-[var(--layout-reset-tooltip-gap)]">
            <span className="h-[calc(var(--font-small)*0.8)] w-[calc(var(--font-small)*0.8)] rounded-sm bg-[#f59e0b]" />
            <span className="text-ui-medium text-[var(--color-text-main)]">良好（健康度70-90）</span>
          </div>
          <div className="flex items-center gap-[var(--layout-reset-tooltip-gap)]">
            <span className="h-[calc(var(--font-small)*0.8)] w-[calc(var(--font-small)*0.8)] rounded-sm bg-[var(--color-error-text)]" />
            <span className="text-ui-medium text-[var(--color-text-main)]">危险（健康度低于70）</span>
          </div>
        </div>
      </div>

      {/* 下半部分：运行天数文案 */}
      <div className="text-center text-ui-medium text-[var(--color-text-muted)]">
        已保障系统无重大危险持续 <span className="mx-[var(--layout-reset-tooltip-gap)] font-bold text-[var(--color-accent)]">{safeDays}</span> 天
      </div>
    </div>
  );
}

function formatWeekdayLabel(value) {
  const weekdayLabels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const match = String(value || "").match(/^(\d{2})-(\d{2})$/);

  if (!match) return String(value || "");

  const now = new Date();
  const month = Number(match[1]) - 1;
  const day = Number(match[2]);
  let date = new Date(now.getFullYear(), month, day);

  if (date.getTime() - now.getTime() > 24 * 60 * 60 * 1000) {
    date = new Date(now.getFullYear() - 1, month, day);
  }

  return weekdayLabels[date.getDay()];
}

function MiniLineChart({ data = [], maxCount }) {
  const width = 360;
  const height = 148;
  const padLeft = 34;
  const padRight = 34;
  const padTop = 36;
  const padBottom = 24;
  const normalizedData = data.map((item) => ({
    ...item,
    count: Math.min(Number(item.count || 0), Math.max(Number(maxCount || 0), 0) || Number(item.count || 0)),
  }));
  const maxValue = Math.max(1, ...normalizedData.map((item) => item.count || 0));
  const xFor = (index) => padLeft + (index * (width - padLeft - padRight)) / Math.max(data.length - 1, 1);
  const yFor = (value) => height - padBottom - (value / maxValue) * (height - padTop - padBottom);
  const points = normalizedData.map((row, index) => `${xFor(index)},${yFor(row.count || 0)}`).join(" ");
  const area = `${padLeft},${height - padBottom} ${points} ${width - padRight},${height - padBottom}`;

  return (
    <div className="min-w-0 overflow-hidden text-ui-small">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-[calc(var(--font-large)*7)] w-full text-ui-small">
        <line x1={padLeft} x2={width - padRight} y1={height - padBottom} y2={height - padBottom} stroke="var(--color-panel-border)" />
        <polyline points={area} fill="var(--color-error-text)" opacity="0.16" />
        <polyline points={points} fill="none" stroke="var(--color-error-text)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        {normalizedData.map((row, index) => (
          <g key={row.date}>
            <text x={xFor(index)} y={yFor(row.count || 0) - 7} textAnchor="middle" fill="var(--color-error-text)" fontSize="var(--font-small)" fontWeight="700">{row.count || 0}</text>
            <circle cx={xFor(index)} cy={yFor(row.count || 0)} r="3.5" fill="var(--color-error-text)" />
            <text x={xFor(index)} y={height - 4} textAnchor="middle" fill="var(--color-text-muted)" fontSize="0.95rem">{formatWeekdayLabel(row.date)}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function OperationMetricsPanel({ focusTarget, onNavigateToDevice }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const scopeParams = useMemo(() => {
    if (!focusTarget) return {};
    if (focusTarget.nodeType === "camera" && focusTarget.cameraId) return { camera_id: focusTarget.cameraId };
    if (focusTarget.nodeType === "custom_folder" || focusTarget.nodeType === "group") { // 【修复】增加对 group 的判断
      const sourceCameras = focusTarget.nodeType === "group" ? (focusTarget.flatCameras || []) : (focusTarget.children || []);
      const cameraIds = sourceCameras
        .map((camera) => getCameraId(camera))
        .filter(Boolean);
      return cameraIds.length ? { camera_ids: cameraIds.join(",") } : {};
    }
    if (focusTarget.nodeType !== "camera" && focusTarget.regionCode) return { region_code: focusTarget.regionCode };
    return {};
  }, [focusTarget]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getStatisticsOverview(scopeParams)
      .then((overview) => {
        if (!cancelled) setData(overview);
      })
      .catch((error) => console.error("Failed to load operation metrics:", error))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scopeParams.camera_id, scopeParams.camera_ids, scopeParams.region_code]);

  const health = Number(data?.golden_metrics?.global_stream_health || 0);
  const cameraTotal = Number(data?.device_status?.cameras?.total || 0);

  return (
    <aside className="relative flex min-h-0 flex-col justify-between gap-[var(--layout-content-gap)] overflow-auto rounded-[var(--layout-radius-lg)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] p-[var(--layout-content-padding)] shadow-[var(--shadow-panel)]">
      {loading && <Loader2 size="var(--icon-bottom)" className="absolute right-[var(--layout-content-padding)] top-[var(--layout-content-padding)] animate-spin text-[var(--color-accent)]" />}
      <DashboardSection title="资源状态统计">
        <div className="flex min-h-[calc(var(--font-large)*13)] flex-col justify-between gap-[var(--layout-content-gap)]">
          <StatusMetricBar 
            title="摄像机" 
            icon={Camera} 
            data={data?.device_status?.cameras} 
            onTitleClick={() => onNavigateToDevice?.('camera')}
            onStatusClick={(status) => onNavigateToDevice?.('camera', status)}
          />
          <StatusMetricBar 
            title="流链路" 
            icon={TrendingUp} 
            data={data?.device_status?.streams} 
            offlineLabel="断连" 
            onTitleClick={() => onNavigateToDevice?.('stream')}
            onStatusClick={(status) => onNavigateToDevice?.('stream', status)}
          />
          <StatusMetricBar 
            title="服务器" 
            icon={Server} 
            data={data?.device_status?.servers} 
            onTitleClick={() => onNavigateToDevice?.('server')}
            onStatusClick={(status) => onNavigateToDevice?.('server', status)}
          />
        </div>
      </DashboardSection>
      <DashboardSection title="流链路全局健康度">
        <HealthGaugeMini value={health} safeDays={data?.golden_metrics?.safe_days || 42} />
      </DashboardSection>
      <DashboardSection title="异常告警统计">
        <MiniLineChart data={data?.anomaly_trend || []} maxCount={cameraTotal} />
      </DashboardSection>
    </aside>
  );
}

export default function MapView({ focusTarget, darkMode, onOpenCameraDetail, onOpenCameraDiagnosis, onNavigateToDevice }) {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const amapRef = useRef(null);
  const overlaysRef = useRef([]);
  const focusedCameraIdRef = useRef("");
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [previewCamera, setPreviewCamera] = useState(null);
  const amapKey = import.meta.env.VITE_AMAP_KEY || import.meta.env.AMAP_KEY || "";
  const mapStyle = darkMode ? MAP_STYLE.dark : MAP_STYLE.light;

  const focusKey = useMemo(() => {
    if (!focusTarget) return "";
    return `${focusTarget.nodeType}-${focusTarget.id}-${focusTarget.version || ""}`;
  }, [focusTarget]);

  function clearOverlays() {
    const map = mapRef.current;
    if (map && overlaysRef.current.length > 0) {
      removeMapOverlays(map, overlaysRef.current);
    }

    overlaysRef.current = [];
  }

  function addOverlay(overlay) {
    overlaysRef.current.push(overlay);
    mapRef.current.add(overlay);
  }

  async function renderRegions(parentCode = null) {
    const AMap = amapRef.current;
    if (!AMap || !mapRef.current) return;

    const regions = await getMapRegionChildren(parentCode);
    clearOverlays();

    regions.forEach((region) => {
      const position = parseCenter(region.center);
      if (!position) return;

      const marker = new AMap.Marker({
        position,
        content: getRegionMarkerContent(region),
        offset: new AMap.Pixel(-58, -36),
        title: region.region_name,
        zIndex: 80,
      });

      marker.on("dblclick", () => {
        focusRegion({
          ...region,
          nodeType: "region",
          id: region.region_code,
          name: region.region_name,
          regionCode: region.region_code,
        });
      });

      addOverlay(marker);
    });
  }

  async function renderCameras(regionCode, focusedCameraId = focusedCameraIdRef.current) {
    const AMap = amapRef.current;
    if (!AMap || !mapRef.current || !regionCode) return;

    cachedMapViewState = {
      mode: "cameras",
      regionCode,
      focusedCameraId,
      center: mapRef.current.getCenter?.()
        ? [mapRef.current.getCenter().lng, mapRef.current.getCenter().lat]
        : null,
      zoom: mapRef.current.getZoom?.() || LEVEL_ZOOM.town,
    };

    const cameras = await getMapRegionCameras(regionCode);
    clearOverlays();

    cameras.filter(hasLngLat).forEach((camera) => {
      const focused = getCameraId(camera) === focusedCameraId;
      const marker = new AMap.Marker({
        position: [Number(camera.longitude), Number(camera.latitude)],
        content: getCameraMarkerContent(camera, focused),
        offset: new AMap.Pixel(-20, -20),
        title: camera.name,
        zIndex: focused ? 240 : 120,
      });

      marker.on("click", () => {
        setPreviewCamera(camera);
      });

      marker.on("dblclick", () => {
        onOpenCameraDetail?.({
          ...camera,
          cameraId: getCameraId(camera),
          cameraName: camera.name,
        });
      });

      addOverlay(marker);
    });
  }

  async function renderCustomFolderCameras(folder) {
    const AMap = amapRef.current;
    if (!AMap || !mapRef.current) return;

    // 【修复】兼容 group 的 flatCameras 和 custom_folder 的 children
    const sourceCameras = folder.nodeType === "group" ? (folder.flatCameras || []) : (folder.children || []);
    const cameras = sourceCameras.filter(hasLngLat);
    focusedCameraIdRef.current = "";
    cachedMapViewState = {
      mode: "custom_folder",
      customFolder: folder,
      center: mapRef.current.getCenter?.()
        ? [mapRef.current.getCenter().lng, mapRef.current.getCenter().lat]
        : null,
      zoom: mapRef.current.getZoom?.() || LEVEL_ZOOM.town,
    };
    clearOverlays();

    const markers = cameras.map((camera) => {
      const marker = new AMap.Marker({
        position: [Number(camera.longitude), Number(camera.latitude)],
        content: getCameraMarkerContent(camera, false),
        offset: new AMap.Pixel(-20, -20),
        title: camera.name,
        zIndex: 150,
      });

      marker.on("click", () => {
        setPreviewCamera(camera);
      });

      marker.on("dblclick", () => {
        onOpenCameraDetail?.({
          ...camera,
          cameraId: getCameraId(camera),
          cameraName: camera.name,
        });
      });

      addOverlay(marker);
      return marker;
    });

    if (markers.length > 1) {
      mapRef.current.setFitView?.(markers, false, [60, 60, 60, 60]);
    } else if (cameras.length === 1) {
      mapRef.current.setZoomAndCenter?.(LEVEL_ZOOM.camera, [
        Number(cameras[0].longitude),
        Number(cameras[0].latitude),
      ]);
    }
  }

  async function getRegionForFocus(region) {
    const regionCode = region.regionCode || region.region_code;

    if (region.center || region.amap_adcode || region.adcode || region.region_name) {
      return region;
    }

    if (!regionCode) return region;

    const latest = await getMapRegion(regionCode);
    return {
      ...region,
      ...latest,
      regionCode: latest.region_code,
      name: latest.region_name,
    };
  }

  async function focusRegion(region) {
    const map = mapRef.current;
    if (!map || !region) return;
    focusedCameraIdRef.current = "";

    const latestRegion = await getRegionForFocus(region);
    const position = parseCenter(latestRegion.center);

    if (position) {
      map.setZoomAndCenter(LEVEL_ZOOM[latestRegion.level] || 8, position);
    } else {
      const cityKeyword =
        latestRegion.adcode ||
        latestRegion.amap_adcode ||
        latestRegion.official_code ||
        latestRegion.region_name;

      if (cityKeyword) {
        map.setCity(cityKeyword);
        map.setZoom(LEVEL_ZOOM[latestRegion.level] || 8);
      }
    }

    if (latestRegion.level === "county" || latestRegion.level === "town") {
      cachedMapViewState = {
        mode: "cameras",
        regionCode: latestRegion.regionCode || latestRegion.region_code,
        focusedCameraId: "",
        center: position,
        zoom: LEVEL_ZOOM[latestRegion.level] || LEVEL_ZOOM.county,
      };
      await renderCameras(latestRegion.regionCode || latestRegion.region_code);
    } else {
      cachedMapViewState = {
        mode: "regions",
        regionCode: latestRegion.regionCode || latestRegion.region_code || null,
        center: position,
        zoom: LEVEL_ZOOM[latestRegion.level] || 8,
      };
      await renderRegions(latestRegion.regionCode || latestRegion.region_code || null);
    }
  }

  async function focusCamera(camera) {
    const map = mapRef.current;
    if (!map || !camera) return;

    let targetCamera = camera;
    const cameraId = getCameraId(camera);
    const regionCode = getCameraRegionCode(camera);

    if (!hasLngLat(targetCamera) && regionCode) {
      const regionCameras = await getMapRegionCameras(regionCode);
      const matched = regionCameras.find((item) => getCameraId(item) === cameraId);
      if (matched) {
        targetCamera = {
          ...targetCamera,
          ...matched,
          regionCode,
        };
      }
    }

    if (!hasLngLat(targetCamera) && cameraId) {
      const latest = await getMapCamera(cameraId);
      targetCamera = {
        ...targetCamera,
        ...latest,
        cameraId: latest.id,
        regionCode: latest.town_code || regionCode,
      };
    }

    if (hasLngLat(targetCamera)) {
      focusedCameraIdRef.current = getCameraId(targetCamera) || cameraId;
      cachedMapViewState = {
        mode: "cameras",
        regionCode: getCameraRegionCode(targetCamera),
        focusedCameraId: focusedCameraIdRef.current,
        center: [Number(targetCamera.longitude), Number(targetCamera.latitude)],
        zoom: LEVEL_ZOOM.camera,
      };
      map.setZoomAndCenter(LEVEL_ZOOM.camera, [
        Number(targetCamera.longitude),
        Number(targetCamera.latitude),
      ]);
      await renderCameras(getCameraRegionCode(targetCamera), focusedCameraIdRef.current);
      return;
    }

    const fallbackRegionCode = getCameraRegionCode(targetCamera);
    if (fallbackRegionCode) {
      await focusRegion({
        nodeType: "region",
        level: "town",
        regionCode: fallbackRegionCode,
      });
      return;
    }

    setMessage("该摄像机缺少经纬度，暂时无法定位到地图。");
  }

  async function restoreCachedMapView() {
    const map = mapRef.current;
    const cached = cachedMapViewState;
    if (!map || !cached) {
      await renderRegions(null);
      return;
    }

    if (cached.center && cached.zoom) {
      map.setZoomAndCenter(cached.zoom, cached.center);
    }

    if (cached.mode === "cameras" && cached.regionCode) {
      focusedCameraIdRef.current = cached.focusedCameraId || "";
      await renderCameras(cached.regionCode, cached.focusedCameraId || "");
      return;
    }

    if (cached.mode === "custom_folder" && cached.customFolder) {
      await renderCustomFolderCameras(cached.customFolder);
      return;
    }

    await renderRegions(cached.regionCode || null);
  }

  useEffect(() => {
    if (!amapKey) {
      setMessage("请在前端环境变量中配置 VITE_AMAP_KEY 后使用电子地图。");
      return undefined;
    }

    let disposed = false;

    async function initMap() {
      setLoading(true);
      setMessage("");

      try {
        const AMap = await loadAmapScript(amapKey);
        if (disposed || !mapContainerRef.current) return;

        amapRef.current = AMap;
        const map = new AMap.Map(mapContainerRef.current, {
          zoom: LEVEL_ZOOM.country,
          center: CHINA_CENTER,
          viewMode: "2D",
          resizeEnable: true,
          mapStyle,
        });

        mapRef.current = map;
        setReady(true);
        await restoreCachedMapView();
      } catch (error) {
        console.error("Map init failed:", error);
        setMessage(error.message || "地图初始化失败");
      } finally {
        if (!disposed) setLoading(false);
      }
    }

    initMap();

    return () => {
      disposed = true;
      clearOverlays();
      try {
        mapRef.current?.clearMap?.();
      } catch (error) {
        console.warn("Failed to clear map:", error);
      }
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amapKey]);

  useEffect(() => {
    mapRef.current?.setMapStyle?.(mapStyle);
  }, [mapStyle]);

  useEffect(() => {
    if (!ready || !focusTarget) return;

    setLoading(true);
    setMessage("");

    const task =
      focusTarget.nodeType === "camera"
        ? focusCamera(focusTarget)
        : (focusTarget.nodeType === "custom_folder" || focusTarget.nodeType === "group") // 【修复】增加对 group 的拦截
        ? renderCustomFolderCameras(focusTarget)
        : focusRegion(focusTarget);

    task
      .catch((error) => {
        console.error("Map focus failed:", error);
        setMessage(error.message || "地图定位失败");
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, focusKey]);

  return (
    <main className="grid min-w-0 flex-1 grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-[var(--layout-content-gap)] bg-[var(--color-page-bg)] p-[var(--layout-content-padding)] transition-colors">
      <section className="relative min-h-0 flex-1 overflow-hidden rounded-[var(--layout-radius-lg)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] shadow-[var(--shadow-panel)]">
        <div ref={mapContainerRef} className="h-full w-full" />
        {previewCamera && <MapCameraPreview camera={previewCamera} onClose={() => setPreviewCamera(null)} onDetail={onOpenCameraDetail} onDiagnose={onOpenCameraDiagnosis} />}

        <div className="pointer-events-none absolute left-[var(--layout-content-padding)] top-[var(--layout-content-padding)] flex items-center gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)] text-ui-small text-[var(--color-text-main)] shadow-[var(--shadow-panel)]">
          <MapPinned size="var(--icon-bottom)" className="text-[var(--color-accent)]" />
          <span>双击左侧行政区定位；县级及以下显示摄像机</span>
        </div>

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--color-panel-bg)]/60 text-[var(--color-text-main)]">
            <div className="flex items-center gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-lg)] bg-[var(--color-panel-bg)] px-[var(--layout-content-padding)] py-[var(--layout-search-padding-y)] shadow-[var(--shadow-panel)]">
              <Loader2 size="var(--icon-search)" className="animate-spin text-[var(--color-accent)]" />
              <span className="text-ui-medium">地图数据加载中</span>
            </div>
          </div>
        )}

        {message && (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--color-panel-bg)]/85">
            <div className="flex max-w-[42rem] items-start gap-[var(--layout-content-gap)] rounded-[var(--layout-radius-lg)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] p-[var(--layout-content-padding)] text-[var(--color-text-main)] shadow-[var(--shadow-panel)]">
              <AlertCircle size="var(--icon-topbar)" className="shrink-0 text-[var(--color-error-text)]" />
              <div>
                <div className="text-ui-large font-semibold">电子地图暂不可用</div>
                <div className="mt-[var(--layout-search-padding-y)] text-ui-medium text-[var(--color-text-muted)]">
                  {message}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="absolute bottom-[var(--layout-content-padding)] right-[var(--layout-content-padding)] flex items-center gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)] text-ui-small text-[var(--color-text-muted)] shadow-[var(--shadow-panel)]">
          <RadioTower size="var(--icon-bottom)" className="text-[var(--color-accent)]" />
          <span>区域显示在线/总数</span>
          <Camera size="var(--icon-bottom)" className="text-[var(--color-accent)]" />
          <span>县级显示摄像机</span>
        </div>
      </section>
      <OperationMetricsPanel focusTarget={focusTarget} onNavigateToDevice={onNavigateToDevice} />
    </main>
  );
}
