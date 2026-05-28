import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Camera,
  ChevronDown,
  Loader2,
  RadioTower,
  Search,
  ShieldCheck,
  Signal,
  Video,
  WifiOff,
} from "lucide-react";
import { getDeviceCameras } from "../services/deviceApi";
import { resolveApiUrl } from "../services/videoApi";

const metricOptions = [
  { key: "qoe", label: "QoE分数", unit: "分", color: "var(--color-accent)", max: 100 },
  { key: "throughput", label: "吞吐量", unit: "Mbps", color: "var(--color-topbar-active-text)", max: 8 },
  { key: "jitter", label: "时延抖动", unit: "ms", color: "var(--color-text-main)", max: 160 },
  { key: "loss", label: "丢包率", unit: "%", color: "var(--color-error-text)", max: 20 },
];

const normalSeries = {
  qoe: [91, 92, 92, 92, 93, 93, 93, 92, 92, 92],
  throughput: [3.4, 3.4, 3.5, 3.9, 4.1, 4.0, 4.0, 3.7, 3.5, 3.5],
  jitter: [54, 55, 56, 54, 59, 57, 60, 58, 55, 54],
  loss: [1.4, 2.0, 1.6, 1.5, 1.0, 0.9, 1.5, 1.9, 1.6, 1.3],
};

const impairedSeries = {
  qoe: [77, 70, 62, 55, 49, 45, 42, 40, 39, 40],
  throughput: [0.9, 0.9, 0.9, 1.2, 1.4, 1.4, 1.4, 1.4, 1.4, 1.4],
  jitter: [147, 151, 149, 142, 136, 132, 128, 125, 122, 121],
  loss: [6.9, 7.5, 6.3, 4.5, 4.2, 4.5, 4.2, 4.5, 3.7, 4.5],
};

const enabledSeries = {
  qoe: [42, 50, 60, 68, 75, 80, 83, 85, 86, 85],
  throughput: [1.4, 1.4, 1.4, 1.4, 1.4, 1.8, 1.8, 1.9, 2.3, 2.3],
  jitter: [121, 115, 108, 101, 94, 86, 80, 74, 68, 62],
  loss: [4.5, 4.2, 4.5, 3.7, 4.5, 1.9, 3.1, 2.7, 2.3, 2.9],
};

function buildScopeParams(focusTarget) {
  if (!focusTarget) return {};
  if (focusTarget.nodeType !== "camera" && focusTarget.regionCode) {
    return { region_code: focusTarget.regionCode };
  }
  return {};
}

function cameraStatusText(status) {
  if (status === "fault") return "异常";
  if (status === "offline") return "离线";
  return "在线";
}

function cameraStatusClass(status) {
  if (status === "fault") return "border-[var(--color-error-text)] bg-[var(--color-error-bg)] text-[var(--color-error-text)]";
  if (status === "offline") return "border-[var(--color-panel-border)] bg-[var(--color-control-bg)] text-[var(--color-text-muted)]";
  return "border-[var(--color-accent)] bg-[var(--color-hover-bg)] text-[var(--color-accent)]";
}

function flowStateClass(enabled) {
  return enabled
    ? "border-[var(--color-accent)] bg-[var(--color-hover-bg)] text-[var(--color-accent)]"
    : "border-[var(--color-panel-border)] bg-[var(--color-control-bg)] text-[var(--color-text-muted)]";
}

function scenarioFor({ hasNetworkLoss, flowEnabled }) {
  if (hasNetworkLoss && flowEnabled) return "enabled";
  if (hasNetworkLoss) return "impaired";
  return "normal";
}

function seriesForScenario(scenario) {
  if (scenario === "enabled") return enabledSeries;
  if (scenario === "impaired") return impairedSeries;
  return normalSeries;
}

function clampMetricValue(value, key) {
  const max = metricOptions.find((item) => item.key === key)?.max || 100;
  const digits = key === "loss" || key === "throughput" ? 1 : 0;
  return Math.max(0, Math.min(max, Number(value.toFixed(digits))));
}

function nextTransitionValue(currentValue, targetValue, key) {
  const span =
    key === "loss" ? 0.28 :
    key === "jitter" ? 1.2 :
    key === "throughput" ? 0.12 :
    0.8;
  const ratio = key === "qoe" ? 0.62 : 0.42;
  const delta = (targetValue - currentValue) * ratio;
  const noise = (Math.random() - 0.5) * span;
  return clampMetricValue(currentValue + delta + noise, key);
}

function useLiveMetrics(scenario) {
  const [seriesState, setSeriesState] = useState(() => ({
    scenario,
    values: seriesForScenario(scenario),
    transitionIndex: 0,
  }));

  useEffect(() => {
    const timer = window.setInterval(() => {
      setSeriesState((current) => {
        const target = seriesForScenario(scenario);
        const transitionIndex = current.scenario === scenario ? current.transitionIndex + 1 : 0;
        const values = Object.fromEntries(
          metricOptions.map((metric) => {
            const currentValues = current.values[metric.key] || target[metric.key];
            const lastValue = currentValues[currentValues.length - 1] ?? target[metric.key][0] ?? 0;
            const targetValues = target[metric.key];
            const targetValue = targetValues[Math.min(transitionIndex, targetValues.length - 1)];
            const nextValue = nextTransitionValue(lastValue, targetValue, metric.key);
            return [metric.key, [...currentValues.slice(-9), nextValue]];
          })
        );
        return { scenario, values, transitionIndex };
      });
    }, 1300);

    return () => window.clearInterval(timer);
  }, [scenario]);

  return seriesState.values;
}

function MetricLineChart({ values, metric }) {
  const width = 720;
  const height = 210;
  const padLeft = 46;
  const padRight = 18;
  const padTop = 24;
  const padBottom = 34;
  const safeValues = values?.length ? values : [0];
  const maxValue = metric.max;
  const xFor = (index) => padLeft + (index * (width - padLeft - padRight)) / Math.max(safeValues.length - 1, 1);
  const yFor = (value) => height - padBottom - (Number(value || 0) / maxValue) * (height - padTop - padBottom);
  const points = safeValues.map((value, index) => `${xFor(index)},${yFor(value)}`).join(" ");
  const area = `${padLeft},${height - padBottom} ${points} ${width - padRight},${height - padBottom}`;
  const ticks = [maxValue, maxValue / 2, 0];

  return (
    <div className="h-full min-h-0 min-w-0">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-full min-h-[calc(var(--font-large)*5.2)] w-full">
        {ticks.map((tick) => (
          <g key={tick}>
            <text x={padLeft - 10} y={yFor(tick) + 5} textAnchor="end" fill="var(--color-text-muted)" className="text-[calc(var(--font-small)*0.72)]">
              {Number(tick).toFixed(metric.key === "loss" || metric.key === "throughput" ? 1 : 0)}
            </text>
            <line x1={padLeft} x2={width - padRight} y1={yFor(tick)} y2={yFor(tick)} stroke="var(--color-panel-border)" strokeDasharray="4 6" />
          </g>
        ))}
        <line x1={padLeft} x2={padLeft} y1={padTop} y2={height - padBottom} stroke="var(--color-panel-border)" />
        <line x1={padLeft} x2={width - padRight} y1={height - padBottom} y2={height - padBottom} stroke="var(--color-panel-border)" />
        <polyline points={area} fill={metric.color} opacity="0.14" />
        <polyline points={points} fill="none" stroke={metric.color} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        {safeValues.map((value, index) => (
          <circle key={`${metric.key}-${index}`} cx={xFor(index)} cy={yFor(value)} r="4" fill={metric.color} />
        ))}
        {safeValues.map((_, index) => (
          <text key={index} x={xFor(index)} y={height - 8} textAnchor="middle" fill="var(--color-text-muted)" className="text-[calc(var(--font-small)*0.72)]">
            {index === safeValues.length - 1 ? "当前" : `${safeValues.length - index - 1}s`}
          </text>
        ))}
      </svg>
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, unit, tone = "accent" }) {
  const color = tone === "error" ? "var(--color-error-text)" : tone === "warn" ? "var(--color-text-main)" : "var(--color-accent)";
  return (
    <div className="inline-flex min-h-[calc(var(--layout-segment-button-height)*2)] min-w-0 items-center gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)]">
      <div className="flex min-w-0 items-center gap-[var(--layout-tree-gap)] text-ui-large text-[var(--color-text-muted)]">
        <Icon size="var(--icon-bottom)" style={{ color }} />
        <span className="truncate">{label}</span>
      </div>
      <div className="ml-auto flex shrink-0 items-baseline gap-[var(--layout-tree-gap)]">
        <span className="text-ui-medium font-bold" style={{ color }}>{value}</span>
        <span className="text-ui-small text-[var(--color-text-muted)]">{unit}</span>
      </div>
    </div>
  );
}

function MetricDropdown({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const current = metricOptions.find((item) => item.key === value) || metricOptions[0];

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((state) => !state)}
        className="flex min-h-[calc(var(--layout-segment-button-height)*0.82)] min-w-[calc(var(--font-medium)*4.8)] items-center justify-between gap-[var(--layout-tree-gap)] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-[var(--layout-segment-button-padding-x)] text-ui-small font-medium text-[var(--color-text-main)] transition-colors hover:bg-[var(--color-hover-bg)]"
      >
        <span className="truncate">{current.label}</span>
        <ChevronDown size="var(--icon-bottom)" className={`shrink-0 text-[var(--color-accent)] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-[calc(100%+var(--layout-tree-gap))] z-50 min-w-full overflow-hidden rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] shadow-[var(--shadow-panel)]">
            {metricOptions.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => {
                  onChange(item.key);
                  setOpen(false);
                }}
                className={`block w-full whitespace-nowrap px-[var(--layout-segment-button-padding-x)] py-[var(--layout-search-padding-y)] text-left text-ui-small transition-colors hover:bg-[var(--color-hover-bg)] ${
                  item.key === value ? "bg-[var(--color-hover-bg)] font-bold text-[var(--color-accent)]" : "text-[var(--color-text-main)]"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function stateCopy(scenario) {
  if (scenario === "impaired") {
    return {
      title: "网损注入中",
      desc: "播放链路出现卡顿与模糊，QoE 分数持续下探。",
      badgeClass: "border-[var(--color-error-text)] bg-[var(--color-error-bg)] text-[var(--color-error-text)]",
    };
  }
  if (scenario === "enabled") {
    return {
      title: "流控赋能已启动",
      desc: "低吞吐条件下抖动与丢包收敛，QoE 回升但画质略有压缩。",
      badgeClass: "border-[var(--color-accent)] bg-[var(--color-hover-bg)] text-[var(--color-accent)]",
    };
  }
  return {
    title: "高清视频流畅播放",
    desc: "高吞吐、低抖动、低丢包，QoE 分数保持高位。",
    badgeClass: "border-[var(--color-accent)] bg-[var(--color-hover-bg)] text-[var(--color-accent)]",
  };
}

const videoEffectTargets = {
  normal: {
    blur: 0,
    scale: 1,
    saturate: 1.1,
    contrast: 1.05,
    scanlineOpacity: 0,
    playbackRate: 1,
    stutter: 0,
  },
  impaired: {
    blur: 3.2,
    scale: 1.018,
    saturate: 0.72,
    contrast: 0.78,
    scanlineOpacity: 0.34,
    playbackRate: 0.58,
    stutter: 1,
  },
  enabled: {
    blur: 2,
    scale: 1.01,
    saturate: 0.9,
    contrast: 0.92,
    scanlineOpacity: 0.12,
    playbackRate: 1,
    stutter: 0.04,
  },
};

function transitionVideoEffect(current, target) {
  const ratio = 0.14;
  return Object.fromEntries(
    Object.entries(target).map(([key, targetValue]) => [
      key,
      current[key] + (targetValue - current[key]) * ratio,
    ])
  );
}

export default function FlowControlView({ focusTarget, networkLossEnabled = false }) {
  const layoutRef = useRef(null);
  const videoRef = useRef(null);
  const stutterRef = useRef(0);
  const stutterTimeoutRef = useRef(null);
  const [cameras, setCameras] = useState([]);
  const [selectedCamera, setSelectedCamera] = useState(null);
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [metricKey, setMetricKey] = useState("qoe");
  const [flowEnabledMap, setFlowEnabledMap] = useState({});
  const [videoPanelPercent, setVideoPanelPercent] = useState(60);
  const [videoEffect, setVideoEffect] = useState(videoEffectTargets.normal);
  const rightPanelPercent = 28;

  const scopeParams = useMemo(() => buildScopeParams(focusTarget), [focusTarget]);
  const focusNodeType = focusTarget?.nodeType;
  const focusCameraId = focusTarget?.cameraId;
  const focusVersion = focusTarget?.version;
  const selectedFlowEnabled = !!(selectedCamera && flowEnabledMap[selectedCamera.id]);
  const scenario = scenarioFor({ hasNetworkLoss: networkLossEnabled, flowEnabled: selectedFlowEnabled });
  const liveMetrics = useLiveMetrics(scenario);
  const metric = metricOptions.find((item) => item.key === metricKey) || metricOptions[0];
  const copy = stateCopy(scenario);

  useEffect(() => {
    let cancelled = false;
    const loadingTimer = window.setTimeout(() => {
      if (cancelled) return;
      setLoading(true);
      setError("");
    }, 0);

    getDeviceCameras({ ...scopeParams, keyword: keyword || undefined, include_fake: true, limit: 200 })
      .then((data) => {
        if (cancelled) return;
        setCameras(data || []);
        setSelectedCamera((current) => {
          if (focusNodeType === "camera" && focusCameraId) {
            return (data || []).find((item) => item.id === focusCameraId) || current || data?.[0] || null;
          }
          if (current && (data || []).some((item) => item.id === current.id)) return current;
          return data?.[0] || null;
        });
      })
      .catch((err) => {
        console.error("Failed to load flow control cameras:", err);
        if (!cancelled) setError("摄像机列表加载失败，请确认后端服务已启动。");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      window.clearTimeout(loadingTimer);
    };
  }, [scopeParams, keyword, focusNodeType, focusCameraId, focusVersion]);

  const currentValues = liveMetrics[metric.key] || [];
  const latestQoe = liveMetrics.qoe?.[liveMetrics.qoe.length - 1] ?? 0;
  const latestThroughput = liveMetrics.throughput?.[liveMetrics.throughput.length - 1] ?? 0;
  const latestJitter = liveMetrics.jitter?.[liveMetrics.jitter.length - 1] ?? 0;
  const latestLoss = liveMetrics.loss?.[liveMetrics.loss.length - 1] ?? 0;
  const videoUrl = resolveApiUrl("/videos/normal.mp4");

  useEffect(() => {
    const timer = window.setInterval(() => {
      setVideoEffect((current) => transitionVideoEffect(current, videoEffectTargets[scenario]));
    }, 120);

    return () => window.clearInterval(timer);
  }, [scenario]);

  useEffect(() => {
    stutterRef.current = videoEffect.stutter;
    const video = videoRef.current;
    if (video) {
      video.playbackRate = videoEffect.playbackRate;
    }
  }, [videoEffect.playbackRate, videoEffect.stutter]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const intensity = stutterRef.current;
      const video = videoRef.current;
      if (!video || intensity < 0.08 || video.paused || Math.random() > intensity * 0.42) return;

      video.pause();
      window.clearTimeout(stutterTimeoutRef.current);
      stutterTimeoutRef.current = window.setTimeout(() => {
        const latestVideo = videoRef.current;
        if (latestVideo) latestVideo.play().catch(() => {});
      }, 220 + intensity * 1450);
    }, 520);

    return () => {
      window.clearInterval(timer);
      window.clearTimeout(stutterTimeoutRef.current);
    };
  }, []);

  const toggleFlow = (camera) => {
    setSelectedCamera(camera);
    setFlowEnabledMap((current) => ({
      ...current,
      [camera.id]: !current[camera.id],
    }));
  };

  const startRowResize = (event) => {
    event.preventDefault();
    const rect = layoutRef.current?.getBoundingClientRect();
    if (!rect) return;

    const onMove = (moveEvent) => {
      const next = ((moveEvent.clientY - rect.top) / rect.height) * 100;
      setVideoPanelPercent(Math.max(34, Math.min(68, next)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const videoStyle = {
    filter: `blur(${videoEffect.blur}px) saturate(${videoEffect.saturate}) contrast(${videoEffect.contrast})`,
    WebkitFilter: `blur(${videoEffect.blur}px) saturate(${videoEffect.saturate}) contrast(${videoEffect.contrast})`,
    transform: `scale(${videoEffect.scale})`,
  };

  return (
    <main className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-[var(--color-page-bg)] transition-colors">
      <div
        ref={layoutRef}
        className="relative m-[var(--layout-content-padding)] grid min-h-0 flex-1 gap-[var(--layout-content-gap)]"
        style={{
          gridTemplateColumns: `minmax(0, 1fr) minmax(0, ${rightPanelPercent}%)`,
          gridTemplateRows: `minmax(0, ${videoPanelPercent}%) minmax(0, 1fr)`,
        }}
      >
        <div
          className="absolute left-0 z-30 h-[var(--layout-tree-action-padding)] cursor-row-resize rounded-full hover:bg-[var(--color-hover-bg)]"
          style={{ right: `${rightPanelPercent}%`, top: `${videoPanelPercent}%` }}
          onMouseDown={startRowResize}
          title="拖动调整视频和指标区域高度"
        />
        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] shadow-[var(--shadow-panel)]">
          <header className="flex min-w-0 items-center justify-between gap-[var(--layout-content-gap)] border-b border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-content-padding)] py-[var(--layout-search-padding-y)]">
            <div className="flex min-w-0 items-center gap-[var(--layout-search-gap)]">
              <Video size="var(--icon-topbar)" className="shrink-0 text-[var(--color-accent)]" />
              <h1 className="truncate text-ui-large font-bold text-[var(--color-text-main)]">流控模块</h1>
              <span className="truncate text-ui-small text-[var(--color-text-muted)]">{selectedCamera?.name || "请选择摄像机"}</span>
            </div>
            <span className={`shrink-0 rounded-[var(--layout-radius-sm)] border px-[var(--layout-search-padding-x)] py-[var(--layout-reset-padding-y)] text-ui-small font-semibold ${copy.badgeClass}`}>
              {copy.title}
            </span>
          </header>
          <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
            {selectedCamera ? (
              <>
                <video
                  ref={videoRef}
                  key={selectedCamera.id}
                  src={videoUrl}
                  autoPlay
                  loop
                  muted
                  playsInline
                  className="h-full w-full object-cover transition-[filter,transform] duration-700"
                  style={videoStyle}
                />
                <div
                  className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(0deg,rgba(255,255,255,0.08)_0,rgba(255,255,255,0.08)_1px,transparent_1px,transparent_6px)] transition-opacity duration-700"
                  style={{ opacity: videoEffect.scanlineOpacity }}
                />
                <div className="absolute left-[var(--layout-content-padding)] top-[var(--layout-content-padding)] rounded-[var(--layout-radius-md)] border border-white/20 bg-black/55 px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)] text-white">
                  <div className="text-ui-medium font-bold">{selectedCamera.name}</div>
                  <div className="mt-[var(--layout-tree-gap)] text-ui-small text-white/75">{copy.desc}</div>
                </div>
              </>
            ) : (
              <div className="flex h-full items-center justify-center text-ui-medium text-white/70">请选择摄像机</div>
            )}
          </div>
        </section>

        <aside className="row-span-2 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] shadow-[var(--shadow-panel)]">
          <header className="border-b border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-content-padding)] py-[var(--layout-search-padding-y)]">
            <div className="flex min-w-0 items-center gap-[var(--layout-search-gap)]">
              <Camera size="var(--icon-topbar)" className="shrink-0 text-[var(--color-accent)]" />
              <h2 className="truncate text-ui-large font-bold text-[var(--color-text-main)]">摄像机列表</h2>
              <span className="ml-auto shrink-0 text-ui-small text-[var(--color-text-muted)]">{cameras.length} 路</span>
            </div>
            <div className="mt-[var(--layout-search-gap)] flex min-h-[var(--layout-search-height)] items-center gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-[var(--layout-search-padding-x)]">
              <Search size="var(--icon-search)" className="shrink-0 text-[var(--color-icon-muted)]" />
              <input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="搜索摄像机名称、IP、位置"
                className="min-w-0 flex-1 bg-transparent text-ui-medium outline-none"
              />
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-auto">
            {loading ? (
              <div className="flex h-full items-center justify-center gap-[var(--layout-search-gap)] text-ui-medium text-[var(--color-text-muted)]">
                <Loader2 size="var(--icon-search)" className="animate-spin" /> 正在加载摄像机
              </div>
            ) : error ? (
              <div className="p-[var(--layout-content-padding)] text-ui-medium text-[var(--color-error-text)]">{error}</div>
            ) : (
              <table className="w-full table-fixed border-separate border-spacing-0 text-ui-small">
                <colgroup>
                  <col className="w-[48%]" />
                  <col className="w-[30%]" />
                  <col className="w-[22%]" />
                </colgroup>
                <thead className="sticky top-0 z-10 bg-[var(--color-control-bg)] text-[var(--color-text-muted)]">
                  <tr>
                    <th className="whitespace-nowrap border-b border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] py-[var(--layout-device-table-padding-y)] text-left">摄像机</th>
                    <th className="whitespace-nowrap border-b border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] py-[var(--layout-device-table-padding-y)] text-left">流控赋能</th>
                    <th className="whitespace-nowrap border-b border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] py-[var(--layout-device-table-padding-y)] text-left">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {cameras.map((camera) => {
                    const enabled = !!flowEnabledMap[camera.id];
                    const selected = selectedCamera?.id === camera.id;
                    return (
                      <tr
                        key={camera.id}
                        onClick={() => setSelectedCamera(camera)}
                        className={`cursor-pointer text-[var(--color-text-main)] ${selected ? "bg-[var(--color-hover-bg)]" : "hover:bg-[var(--color-hover-bg)]"}`}
                      >
                        <td className="border-b border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] py-[var(--layout-device-table-padding-y)]">
                          <div className="whitespace-normal break-words font-semibold leading-snug" title={camera.name}>{camera.name}</div>
                          <div className="mt-[var(--layout-tree-gap)] truncate text-ui-small text-[var(--color-text-muted)]">{camera.ip || camera.location_desc || camera.id}</div>
                        </td>
                        <td className="border-b border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] py-[var(--layout-device-table-padding-y)]">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleFlow(camera);
                            }}
                            className={`inline-flex w-[calc(var(--font-small)*5.1)] shrink-0 items-center justify-center gap-[var(--layout-tree-gap)] rounded-[var(--layout-radius-sm)] border px-[var(--layout-tree-action-padding)] py-[var(--layout-tree-gap)] text-ui-small font-semibold transition-colors hover:brightness-95 ${flowStateClass(enabled)}`}
                          >
                            {enabled ? <ShieldCheck size="var(--icon-status)" /> : <ChevronDown size="var(--icon-status)" />}
                            {enabled ? "启动" : "未启动"}
                          </button>
                        </td>
                        <td className="border-b border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] py-[var(--layout-device-table-padding-y)]">
                          <span className={`inline-flex rounded-[var(--layout-radius-sm)] border px-[var(--layout-tree-action-padding)] py-[var(--layout-tree-gap)] text-ui-small ${cameraStatusClass(camera.status)}`}>
                            {cameraStatusText(camera.status)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {!cameras.length && (
                    <tr>
                      <td colSpan={3} className="px-[var(--layout-content-padding)] py-[var(--layout-content-padding)] text-center text-ui-medium text-[var(--color-text-muted)]">当前范围暂无摄像机</td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] p-[var(--layout-content-padding)] shadow-[var(--shadow-panel)]">
          <div className="flex min-h-0 flex-1 flex-col gap-[var(--layout-search-gap)]">
            <div className="grid shrink-0 grid-cols-4 gap-[var(--layout-search-gap)]">
              <MetricCard icon={Activity} label="QoE分数" value={latestQoe} unit="分" tone={latestQoe < 60 ? "error" : latestQoe < 80 ? "warn" : "accent"} />
              <MetricCard icon={Signal} label="吞吐量" value={latestThroughput} unit="Mbps" tone={latestThroughput < 30 ? "warn" : "accent"} />
              <MetricCard icon={RadioTower} label="时延抖动" value={latestJitter} unit="ms" tone={latestJitter > 40 ? "error" : "accent"} />
              <MetricCard icon={WifiOff} label="丢包率" value={latestLoss} unit="%" tone={latestLoss > 5 ? "error" : "accent"} />
            </div>
            <div className="relative min-h-0 flex-1">
              <div className="absolute right-[var(--layout-search-gap)] top-[var(--layout-search-gap)] z-20">
                <MetricDropdown value={metricKey} onChange={setMetricKey} />
              </div>
              <MetricLineChart values={currentValues} metric={metric} />
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
