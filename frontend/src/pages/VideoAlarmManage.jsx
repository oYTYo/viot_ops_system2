import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Bell, CheckCircle2, Loader2, Search, Settings2, X, Zap } from "lucide-react";
import { getDeviceCameras, getDeviceStreams } from "../services/deviceApi";
import { getCameraPreview } from "../services/videoApi";

const ALARM_CONFIRM_STORAGE_KEY = "viotops-alarm-confirm-state-v1";

function readAlarmConfirmState() {
  try {
    return JSON.parse(localStorage.getItem(ALARM_CONFIRM_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeAlarmConfirmState(value) {
  localStorage.setItem(ALARM_CONFIRM_STORAGE_KEY, JSON.stringify(value));
}

function cameraStatusText(status) {
  if (status === "online") return "正常";
  if (status === "fault") return "异常";
  if (status === "offline") return "离线";
  return status || "-";
}

function statusClass(status) {
  if (status === "已确认") return "border-[var(--color-accent)] bg-[var(--color-hover-bg)] text-[var(--color-accent)]";
  return "border-[var(--color-error-text)] bg-[var(--color-error-bg)] text-[var(--color-error-text)]";
}

function detectionRowClass(tier) {
  if (tier === "strong") return "bg-red-300/45";
  if (tier === "medium") return "bg-orange-300/50";
  if (tier === "light") return "bg-yellow-100/70";
  return "";
}

function formatClock(date = new Date()) {
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function formatShiftedClock(date, seconds) {
  return formatClock(new Date(date.getTime() - seconds * 1000));
}

function inferVideoAnomaly(camera, stream) {
  const offline = camera.status === "offline";
  const disconnected = stream && !stream.is_connected;
  const latency = Number(stream?.latency || 0);
  const jitter = Number(stream?.jitter || 0);
  const packetLoss = Number(stream?.packet_loss_rate || 0);
  const qoe = Number(stream?.qoe_score || 0);

  if (offline) {
    return {
      type: "设备离线",
      metric: "设备不可达，实时视频画面无法拉取",
      metricName: "连通状态",
      metricUnit: "",
      metricValue: 0,
      threshold: "在线",
      evidence: "黑屏 / 无法连接摄像机",
      confidence: 0.98,
    };
  }

  if (disconnected) {
    return {
      type: "视频流中断",
      metric: "流连接断开，播放地址不可用",
      metricName: "吞吐量",
      metricUnit: "Mbps",
      metricValue: 0,
      threshold: 4,
      evidence: "黑屏 / 视频流断连",
      confidence: 0.96,
    };
  }

  if (packetLoss > 1.5) {
    return {
      type: "画面花屏",
      metric: `丢包率 ${packetLoss.toFixed(2)}%，QoE ${qoe || "-"} 分`,
      metricName: "丢包率",
      metricUnit: "%",
      metricValue: packetLoss,
      threshold: 1.5,
      evidence: "异常视频片段中存在画面破碎或块状噪声",
      confidence: 0.9,
    };
  }

  if (jitter > 25) {
    return {
      type: "画面拖影",
      metric: `抖动 ${jitter.toFixed(1)}ms，QoE ${qoe || "-"} 分`,
      metricName: "时延抖动",
      metricUnit: "ms",
      metricValue: jitter,
      threshold: 25,
      evidence: "异常视频片段中存在运动残影",
      confidence: 0.88,
    };
  }

  if (latency > 150) {
    return {
      type: "画面卡顿",
      metric: `时延 ${latency.toFixed(1)}ms，QoE ${qoe || "-"} 分`,
      metricName: "时延",
      metricUnit: "ms",
      metricValue: latency,
      threshold: 150,
      evidence: "异常视频片段中存在播放停顿",
      confidence: 0.86,
    };
  }

  return {
    type: "QoE骤降",
    metric: `QoE ${qoe || "-"} 分，视频业务质量低于基线`,
    metricName: "QoE",
    metricUnit: "分",
    metricValue: qoe,
    threshold: 75,
    evidence: "异常视频片段中存在可感知质量下降",
    confidence: 0.84,
  };
}

function isHuliCamera(camera) {
  return [camera.county_name, camera.town_name, camera.name, camera.location_desc]
    .filter(Boolean)
    .some((value) => String(value).includes("湖里") || String(value).includes("金山") || String(value).includes("禾山") || String(value).includes("殿前") || String(value).includes("江头"));
}

function isFakeCamera(camera) {
  return /^F|^Z/.test(String(camera?.id || ""));
}

function algorithmFlowerScreenLimit(algorithm) {
  if (algorithm === "rule") return 2;
  if (algorithm === "algorithmA") return 4;
  if (algorithm === "algorithmB") return 5;
  return 8;
}

function buildFlowerScreenAlarms(cameras, streams, handledMap, confirmStrategy, algorithm, usedCameraIds) {
  const streamByCamera = new Map();
  streams.forEach((stream) => {
    if (!streamByCamera.has(stream.camera_id)) streamByCamera.set(stream.camera_id, stream);
  });

  return cameras
    .filter((camera) => camera.status === "fault" && isHuliCamera(camera) && !usedCameraIds.has(camera.id))
    .sort((left, right) => {
      const leftDemo = left.id?.startsWith("alarm-demo-flower") ? 0 : 1;
      const rightDemo = right.id?.startsWith("alarm-demo-flower") ? 0 : 1;
      return leftDemo - rightDemo || String(left.id).localeCompare(String(right.id));
    })
    .slice(0, algorithmFlowerScreenLimit(algorithm))
    .map((camera, index) => {
      const stream = streamByCamera.get(camera.id);
      const id = `alarm-flower-${algorithm}-${camera.id}`;
      const packetLoss = Number(stream?.packet_loss_rate || 1.8 + index * 0.2);
      const jitter = Number(stream?.jitter || 32 + index * 2.2);
      const detectionTier = algorithm === "rule"
        ? "base"
        : algorithm === "algorithmA"
          ? index >= 2 ? "light" : "base"
          : algorithm === "algorithmB"
            ? index >= 4 ? "medium" : index >= 2 ? "light" : "base"
            : index >= 5 ? "strong" : index >= 4 ? "medium" : index >= 2 ? "light" : "base";
      const metricName = algorithm === "algorithmA" ? "时延抖动" : "丢包率";
      const metricUnit = algorithm === "algorithmA" ? "ms" : "%";
      const metricValue = algorithm === "algorithmA" ? jitter : packetLoss;
      return {
        id,
        camera: { ...camera, status: camera.status === "offline" ? camera.status : "fault" },
        stream,
        time: new Date(Date.now() - 1000 * 60 * (18 + index * 7)).toLocaleString("zh-CN", { hour12: false }),
        source: camera.name || camera.id,
        type: "画面花屏",
        status: confirmStrategy === "auto" ? "已确认" : handledMap[id] || "未确认",
        metric: algorithm === "rule"
          ? `丢包率 ${packetLoss.toFixed(2)}%，超过规则阈值`
          : algorithm === "algorithmA"
            ? `时延抖动片段异常，单指标重构损失升高`
            : `画面纹理块异常，重构损失高于同区域时空基线`,
        metricName,
        metricUnit,
        metricValue: Number(metricValue.toFixed(2)),
        threshold: algorithm === "algorithmA" ? 25 : 1.5,
        evidence: "异常视频片段中存在花屏块状噪声",
        confidence: algorithm === "spatioTemporal" ? 0.94 : algorithm === "algorithmB" ? 0.89 : algorithm === "algorithmA" ? 0.84 : 0.78,
        related: [camera.id, stream?.id].filter(Boolean),
        synthetic: true,
        detectionTier,
      };
    });
}

function buildAlarms(cameras, streams, handledMap, confirmStrategy, algorithm) {
  const realCameras = cameras.filter((camera) => !isFakeCamera(camera));
  const streamByCamera = new Map();
  const realCameraIds = new Set(realCameras.map((camera) => camera.id));
  streams.forEach((stream) => {
    if (!realCameraIds.has(stream.camera_id)) return;
    if (!streamByCamera.has(stream.camera_id)) streamByCamera.set(stream.camera_id, stream);
  });

  const baseAlarms = realCameras
    .map((camera) => {
      const stream = streamByCamera.get(camera.id);
      const abnormal = camera.status !== "online";
      if (!abnormal) return null;

      const anomaly = inferVideoAnomaly(camera, stream);
      const id = `alarm-${camera.id}`;
      return {
        id,
        camera,
        stream,
        time: new Date(Date.now() - (camera.status === "offline" ? 1000 * 60 * 12 : 1000 * 60 * 38)).toLocaleString("zh-CN", { hour12: false }),
        source: camera.name || camera.id,
        type: anomaly.type,
        status: confirmStrategy === "auto" ? "已确认" : handledMap[id] || "未确认",
        metric: anomaly.metric,
        metricName: anomaly.metricName,
        metricUnit: anomaly.metricUnit,
        metricValue: anomaly.metricValue,
        threshold: anomaly.threshold,
        evidence: anomaly.evidence,
        confidence: anomaly.confidence,
        related: [camera.id, stream?.id].filter(Boolean),
      };
    })
    .filter(Boolean)
    .filter((alarm) => alarm.type !== "画面花屏")
    .slice(0, 80);

  const usedCameraIds = new Set(baseAlarms.map((alarm) => alarm.camera.id));
  const flowerAlarms = buildFlowerScreenAlarms(realCameras, streams, handledMap, confirmStrategy, algorithm, usedCameraIds);
  return [...baseAlarms, ...flowerAlarms].slice(0, 80);
}

function AlarmPreview({ alarm }) {
  const [state, setState] = useState("loading");
  const [preview, setPreview] = useState(null);
  const videoRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setPreview(null);

    if (alarm.camera?.status === "offline") {
      const timer = window.setTimeout(() => {
        if (!cancelled) setState("failed");
      }, 1200);
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    }

    getCameraPreview(alarm.camera.id)
      .then((data) => {
        if (!cancelled) {
          setPreview(data);
          setState("playing");
        }
      })
      .catch(() => {
        if (!cancelled) setState("failed");
      });

    return () => {
      cancelled = true;
    };
  }, [alarm.id, alarm.camera?.id]);

  useEffect(() => {
    if (state !== "playing" || !preview?.play_url || !videoRef.current) return undefined;
    const video = videoRef.current;
    const play = () => {
      video.currentTime = Number(preview.start_time || 0);
      video.play().catch(() => {});
    };
    video.addEventListener("loadedmetadata", play, { once: true });
    video.load();
    return () => video.removeEventListener("loadedmetadata", play);
  }, [state, preview]);

  return (
    <div className="relative aspect-video overflow-hidden rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-black">
      {state === "playing" && preview?.play_url ? (
        <video ref={videoRef} src={preview.play_url} muted loop playsInline className="h-full w-full object-cover" />
      ) : state === "failed" ? (
        <div className="flex h-full flex-col items-center justify-center gap-[var(--layout-search-gap)] text-ui-medium text-white">
          <AlertTriangle size="var(--icon-topbar)" className="text-[var(--color-error-text)]" />
          {alarm.evidence}
        </div>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-[var(--layout-search-gap)] text-ui-medium text-white">
          <Loader2 size="var(--icon-topbar)" className="animate-spin text-[var(--color-accent)]" />
          正在加载告警画面
        </div>
      )}
      <div className="absolute left-[var(--layout-search-padding-x)] top-[var(--layout-search-padding-y)] rounded-[var(--layout-radius-sm)] bg-black/65 px-[var(--layout-search-padding-x)] py-[var(--layout-segment-button-padding-y)] text-ui-small text-white">
        {alarm.type}
      </div>
    </div>
  );
}

function buildMetricSeries(alarm, tick = 0) {
  const current = Number(alarm.metricValue || 0);
  const base = current > 0 ? current : alarm.type === "视频流中断" ? 5.8 : 1;
  const highIsBad = alarm.metricName !== "吞吐量" && alarm.metricName !== "QoE";
  const wave = Math.sin((tick + 1) * 0.9) * 0.05;
  const factors = highIsBad
    ? [0.42, 0.48, 0.51, 0.58, 0.62, 0.71, 0.86, 1.0].map((item, index) => item + wave * (index / 8))
    : [1.2, 1.1, 1.04, 0.95, 0.84, 0.72, 0.58, current > 0 ? 1 : 0].map((item, index) => Math.max(0, item - wave * (index / 8)));
  return factors.map((factor, index) => ({
    label: `${index + 1}`,
    value: Math.max(0, Number((base * factor).toFixed(2))),
  }));
}

function buildReconstructionSeries(baseValue, tick = 0, count = 8, boost = 1) {
  const movingCenter = count - 1 - Math.floor((tick + Math.round(baseValue * 3)) % count);
  return Array.from({ length: count }, (_, index) => {
    const phase = tick * 0.8 - index * 0.9 + baseValue;
    const distance = Math.abs(index - movingCenter);
    const wrappedDistance = Math.min(distance, count - distance);
    const baseline = 16 + index * 1.8 + Math.max(0, Math.sin(phase)) * 8 + baseValue * 1.2;
    const anomalyLift = wrappedDistance <= 1 ? (46 - wrappedDistance * 16) * boost : 0;
    const loss = baseline + anomalyLift;
    return {
      label: `${index + 1}`,
      value: Number(Math.max(4, Math.min(96, loss)).toFixed(1)),
    };
  });
}

function safePatternId(value) {
  return `alarm-stripe-${String(value).replace(/[^\w-]/g, "-")}`;
}

function ReconstructionChart({ title, series, now, legendMode = "horizontal", showLegend = true }) {
  const width = 420;
  const height = legendMode === "compactGrid" ? 170 : 130;
  const padLeft = 42;
  const padRight = 18;
  const padTop = legendMode === "compactGrid" ? 4 : 26;
  const padBottom = 30;
  const colors = ["var(--color-error-text)", "var(--color-accent)", "#f59e0b", "#8b5cf6"];
  const maxValue = 100;
  const xFor = (index, length) => padLeft + (index * (width - padLeft - padRight)) / Math.max(length - 1, 1);
  const yFor = (value) => height - padBottom - (value / maxValue) * (height - padTop - padBottom);
  const patternId = safePatternId(`${title}-${series.map((item) => item.name).join("-")}`);
  const anomalyIndexes = series[0].data
    .map((_, index) => {
      const maxAtIndex = Math.max(...series.map((item) => item.data[index]?.value || 0));
      return maxAtIndex > 50 ? index : null;
    })
    .filter((index) => index !== null);
  const legendClass = legendMode === "compactGrid"
    ? "absolute right-[var(--layout-search-padding-x)] top-[calc(var(--font-small)*1.05+var(--layout-tree-gap)*0.7)] z-10 grid grid-cols-2 gap-x-[var(--layout-tree-action-padding)] gap-y-[calc(var(--layout-tree-gap)*0.55)] rounded-[var(--layout-radius-sm)] bg-[var(--color-control-bg)]/85 px-[var(--layout-tree-action-padding)] py-[calc(var(--layout-tree-gap)*0.65)] shadow-sm backdrop-blur"
    : "absolute right-[var(--layout-search-padding-x)] top-[var(--layout-search-padding-y)] z-10 flex flex-wrap justify-end gap-x-[var(--layout-search-gap)] gap-y-[var(--layout-tree-gap)] rounded-[var(--layout-radius-sm)] bg-[var(--color-control-bg)]/75 px-[var(--layout-tree-action-padding)] py-[var(--layout-tree-gap)]";
  const svgClass = legendMode === "compactGrid"
    ? "-mt-[calc(var(--font-small)*0.9)] h-[calc(var(--font-large)*7.15)] w-full"
    : "h-[calc(var(--font-large)*5.25)] w-full";

  return (
    <div className="relative min-w-0 overflow-hidden rounded-[var(--layout-radius-sm)] bg-gradient-to-b from-[var(--color-control-bg)] to-transparent">
      {title && <div className="px-[var(--layout-tree-action-padding)] pt-[calc(var(--layout-tree-gap)*0.35)] pb-0 text-ui-small leading-none text-[var(--color-text-main)]">{title}</div>}
      {showLegend && <div className={legendClass}>
          {series.map((item, index) => (
            <span key={item.name} className="inline-flex items-center gap-[var(--layout-tree-gap)] text-[var(--color-text-muted)]">
              <span className="h-[calc(var(--font-small)*0.38)] w-[calc(var(--font-small)*1.2)] rounded-full" style={{ backgroundColor: colors[index % colors.length] }} />
              {item.name}
            </span>
          ))}
      </div>}
      <svg viewBox={`0 0 ${width} ${height}`} className={svgClass}>
        <defs>
          <pattern id={patternId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="3" height="6" fill="var(--color-error-text)" opacity="0.35" />
          </pattern>
        </defs>
        <line x1={padLeft} x2={padLeft} y1={padTop} y2={height - padBottom} stroke="var(--color-panel-border)" />
        <line x1={padLeft} x2={width - padRight} y1={height - padBottom} y2={height - padBottom} stroke="var(--color-panel-border)" />
        <text x={padLeft - 8} y={padTop + 5} textAnchor="end" fill="var(--color-text-muted)" fontSize="var(--font-small)">{maxValue.toFixed(1)}</text>
        <text x={padLeft - 8} y={height - padBottom + 4} textAnchor="end" fill="var(--color-text-muted)" fontSize="var(--font-small)">0</text>
        {anomalyIndexes.map((index) => {
          const start = xFor(Math.max(index - 0.5, 0), series[0].data.length);
          const end = xFor(Math.min(index + 0.5, series[0].data.length - 1), series[0].data.length);
          return <rect key={index} className="transition-all duration-700 ease-out" x={start} y={padTop} width={Math.max(8, end - start)} height={height - padTop - padBottom} fill={`url(#${patternId})`} opacity="0.55" />;
        })}
        {series.map((item, seriesIndex) => {
          const points = item.data.map((point, index) => `${xFor(index, item.data.length)},${yFor(point.value)}`).join(" ");
          return (
            <g key={item.name}>
              <polyline className="transition-all duration-700 ease-out" points={points} fill="none" stroke={colors[seriesIndex % colors.length]} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </g>
          );
        })}
        <text x={(padLeft + width - padRight) / 2} y={height - 4} textAnchor="middle" fill="var(--color-text-muted)" fontSize="var(--font-small)">{formatShiftedClock(now, 30)}</text>
        <text x={width - padRight} y={height - 4} textAnchor="end" fill="var(--color-text-muted)" fontSize="var(--font-small)">{formatClock(now)}</text>
      </svg>
    </div>
  );
}

function MetricTrendChart({ alarm, algorithm, thresholds }) {
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTick((value) => value + 1);
      setNow(new Date());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const data = buildMetricSeries(alarm, tick);
  const width = 420;
  const height = 150;
  const padLeft = 44;
  const padRight = 18;
  const padTop = 18;
  const padBottom = 28;
  const fixedMaxByMetric = {
    丢包率: 8,
    时延抖动: 90,
    时延: 380,
    吞吐量: 8,
    QoE: 100,
    连通状态: 1,
  };
  const maxValue = fixedMaxByMetric[alarm.metricName] || Math.max(1, Number(thresholds?.[alarm.metricName] || alarm.threshold || 1) * 2);
  const xFor = (index) => padLeft + (index * (width - padLeft - padRight)) / Math.max(data.length - 1, 1);
  const yFor = (value) => height - padBottom - (value / maxValue) * (height - padTop - padBottom);
  const points = data.map((item, index) => `${xFor(index)},${yFor(item.value)}`).join(" ");
  const area = `${padLeft},${height - padBottom} ${points} ${width - padRight},${height - padBottom}`;
  const threshold = Number(thresholds?.[alarm.metricName] ?? alarm.threshold ?? 0);
  const showThreshold = algorithm === "rule" && threshold > 0;
  const description = algorithm === "rule"
    ? `${alarm.metricName}触发规则阈值，当前趋势持续处于异常区间。`
    : `${alarm.metricName}的重构损失显著偏高，指标分布偏离正常时空基线。`;

  if (algorithm === "algorithmA") {
    const data = buildReconstructionSeries(Number(alarm.metricValue || 1), tick, 8, 1);
    return (
      <section className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] p-[var(--layout-content-gap)]">
        <div className="mb-[var(--layout-search-gap)] text-ui-medium font-bold text-[var(--color-text-main)]">异常指标：时延抖动重构损失</div>
        <ReconstructionChart title="" series={[{ name: "时延抖动", data }]} now={now} showLegend={false} />
      </section>
    );
  }

  if (algorithm === "algorithmB") {
    const packetLoss = buildReconstructionSeries(Number(alarm.metricValue || 1), tick, 8, 1.05);
    const jitter = buildReconstructionSeries(1.4, tick + 2, 8, 0.88);
    const throughput = buildReconstructionSeries(1.1, tick + 4, 8, 0.72);
    return (
      <section className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] p-[var(--layout-content-gap)]">
        <div className="mb-[var(--layout-search-gap)] text-ui-medium font-bold text-[var(--color-text-main)]">异常指标：多指标联合重构损失</div>
        <ReconstructionChart title="" series={[{ name: "丢包率", data: packetLoss }, { name: "时延抖动", data: jitter }, { name: "吞吐量", data: throughput }]} now={now} />
      </section>
    );
  }

  if (algorithm === "spatioTemporal") {
    const charts = [
      { title: "上行链路", series: [{ name: "丢包率", data: buildReconstructionSeries(1.5, tick, 8, 1.12) }, { name: "抖动", data: buildReconstructionSeries(1.2, tick + 1, 8, 0.92) }] },
      { title: "流媒体服务器", series: [{ name: "转码负荷", data: buildReconstructionSeries(1.6, tick + 2, 8, 1.04) }, { name: "缓存积压", data: buildReconstructionSeries(1.3, tick + 3, 8, 0.86) }] },
      { title: "下行链路", series: [{ name: "QoE损失", data: buildReconstructionSeries(1.4, tick + 4, 8, 0.98) }, { name: "吞吐下降", data: buildReconstructionSeries(1.0, tick + 5, 8, 0.76) }] },
    ];
    return (
      <section className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] p-[var(--layout-content-gap)]">
        <div className="mb-[var(--layout-search-gap)] text-ui-medium font-bold text-[var(--color-text-main)]">异常指标：时空联合指标重构损失</div>
        <div className="grid gap-[var(--layout-search-gap)] xl:grid-cols-3">
          {charts.map((chart) => <ReconstructionChart key={chart.title} title={chart.title} series={chart.series} now={now} legendMode="compactGrid" />)}
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] p-[var(--layout-content-gap)]">
      <div className="min-w-0">
        <div className="min-w-0">
          <div className="text-ui-medium font-bold text-[var(--color-text-main)]">异常指标：{alarm.metricName}</div>
        </div>
      </div>
      <div className="mt-[var(--layout-search-gap)] min-w-0 overflow-hidden">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-[calc(var(--font-large)*6)] w-full">
          <line x1={padLeft} x2={padLeft} y1={padTop} y2={height - padBottom} stroke="var(--color-panel-border)" />
          <line x1={padLeft} x2={width - padRight} y1={height - padBottom} y2={height - padBottom} stroke="var(--color-panel-border)" />
          <text x={padLeft - 8} y={padTop + 5} textAnchor="end" fill="var(--color-text-muted)" fontSize="var(--font-small)">{maxValue.toFixed(maxValue > 10 ? 0 : 1)}</text>
          <text x={padLeft - 8} y={height - padBottom + 4} textAnchor="end" fill="var(--color-text-muted)" fontSize="var(--font-small)">0</text>
          {showThreshold && (
            <>
              <line x1={padLeft} x2={width - padRight} y1={yFor(threshold)} y2={yFor(threshold)} stroke="var(--color-error-text)" strokeDasharray="5 5" opacity="0.55" />
              <text x={width - padRight} y={yFor(threshold) - 5} textAnchor="end" fill="var(--color-error-text)" fontSize="var(--font-small)">阈值 {threshold}{alarm.metricUnit}</text>
            </>
          )}
          <polyline points={area} fill="var(--color-error-text)" opacity="0.16" />
          <polyline points={points} fill="none" stroke="var(--color-error-text)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          {data.map((item, index) => (
            <g key={item.label}>
              <circle cx={xFor(index)} cy={yFor(item.value)} r="3.5" fill="var(--color-error-text)" />
            </g>
          ))}
          <text x={(padLeft + width - padRight) / 2} y={height - 5} textAnchor="middle" fill="var(--color-text-muted)" fontSize="var(--font-small)">{formatShiftedClock(now, 30)}</text>
          <text x={width - padRight} y={height - 5} textAnchor="end" fill="var(--color-text-muted)" fontSize="var(--font-small)">{formatClock(now)}</text>
        </svg>
      </div>
    </section>
  );
}

function InlineAlgorithmConfig({ scopeName, algorithm, setAlgorithm, confirmStrategy, setConfirmStrategy, thresholds, setThresholds }) {
  const [thresholdOpen, setThresholdOpen] = useState(false);
  const [thresholdDraft, setThresholdDraft] = useState(thresholds);
  const algorithms = [
    { key: "rule", label: "基于规则" },
    { key: "algorithmA", label: "LSTM-VAE" },
    { key: "algorithmB", label: "SDF-VAE" },
    { key: "spatioTemporal", label: "Spade(本项目)" },
  ];
  const descriptions = {
    rule: "企业现行的检测算法，基于固定阈值触发异常告警",
    algorithmA: "美国佐治亚理工学院提出的基于单指标重构的异常检测算法(2018)",
    algorithmB: "中科院信工所、中国传媒大学、上海交大提出的多指标重构异常检测算法(2021)",
    spatioTemporal: "本项目提出的多实体多指标时空联合分布重构的异常检测算法，能识别复杂业务异常模式",
  };

  useEffect(() => {
    if (thresholdOpen) setThresholdDraft(thresholds);
  }, [thresholdOpen, thresholds]);

  function updateThreshold(key, value) {
    setThresholdDraft((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function saveThresholds() {
    setThresholds({
      QoE: Number(thresholdDraft.QoE || 0),
      吞吐量: Number(thresholdDraft.吞吐量 || 0),
      时延: Number(thresholdDraft.时延 || 0),
      时延抖动: Number(thresholdDraft.时延抖动 || 0),
      丢包率: Number(thresholdDraft.丢包率 || 0),
    });
    setThresholdOpen(false);
  }

  return (
    <section className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] p-[var(--layout-content-padding)] shadow-[var(--shadow-panel)]">
      <div className="mb-[var(--layout-search-gap)] flex items-center gap-[var(--layout-search-gap)] text-ui-medium font-bold text-[var(--color-text-main)]">
        <Settings2 size="var(--icon-bottom)" className="text-[var(--color-accent)]" />
        异常检测算法配置
      </div>
      <div className="grid items-end gap-[var(--layout-content-gap)] xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1.45fr)_auto]">
        <div className="grid min-w-0 grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)_minmax(0,0.9fr)] gap-[var(--layout-search-gap)]">
          <label className="min-w-0">
            <span className="mb-[var(--layout-tree-gap)] block truncate text-ui-small leading-none text-[var(--color-text-muted)]">轮巡周期</span>
            <select defaultValue="60" className="h-[var(--layout-search-height)] w-full rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] text-ui-medium outline-none">
              <option value="10">每 10 秒</option>
              <option value="30">每 30 秒</option>
              <option value="60">每 1 分钟</option>
              <option value="300">每 5 分钟</option>
            </select>
          </label>
          <label className="min-w-0">
            <span className="mb-[var(--layout-tree-gap)] block truncate text-ui-small leading-none text-[var(--color-text-muted)]">轮巡范围</span>
            <select defaultValue="current" className="h-[var(--layout-search-height)] w-full rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] text-ui-medium outline-none">
              <option value="current">{scopeName}</option>
              <option value="fault">仅异常/离线摄像机</option>
              <option value="all">全部区域</option>
            </select>
          </label>
          <label className="min-w-0">
            <span className="mb-[var(--layout-tree-gap)] block truncate text-ui-small leading-none text-[var(--color-text-muted)]">确认策略</span>
            <select value={confirmStrategy} onChange={(event) => setConfirmStrategy(event.target.value)} className="h-[var(--layout-search-height)] w-full rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] text-ui-medium outline-none">
              <option value="manual">人工确认</option>
              <option value="auto">自动确认</option>
            </select>
          </label>
        </div>

        <div className="min-w-0">
          <div className="mb-[var(--layout-tree-gap)] block w-[calc(100%+10rem+var(--layout-content-gap))] truncate text-ui-small leading-none text-[var(--color-text-muted)]" title={descriptions[algorithm]}>
            {descriptions[algorithm]}
          </div>
          <div className="grid h-[var(--layout-search-height)] grid-cols-4 items-center gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-md)] bg-[var(--color-control-bg)] px-[var(--layout-tree-gap)]">
            {algorithms.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setAlgorithm(item.key)}
                className={`flex h-[calc(var(--layout-search-height)-var(--layout-tree-gap)*2)] min-h-0 items-center justify-center rounded-[var(--layout-radius-sm)] px-[var(--layout-segment-button-padding-x)] text-ui-small font-medium leading-none transition ${algorithm === item.key ? "bg-[var(--color-topbar-active-bg)] text-[var(--color-topbar-active-text)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-hover-bg)] hover:text-[var(--color-text-main)]"}`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          disabled={algorithm !== "rule"}
          onClick={() => setThresholdOpen(true)}
          className="h-[var(--layout-search-height)] self-end rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] text-ui-small text-[var(--color-accent)] enabled:hover:bg-[var(--color-hover-bg)] disabled:cursor-not-allowed disabled:text-[var(--color-text-muted)]"
        >
          配置异常阈值
        </button>
      </div>
      {thresholdOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35">
          <div className="w-[min(58rem,calc(100%-var(--layout-content-padding)*2))] rounded-[var(--layout-radius-lg)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] shadow-[var(--shadow-panel)]">
            <header className="flex items-center justify-between border-b border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-content-padding)] py-[var(--layout-search-padding-y)]">
              <div className="text-ui-large font-bold text-[var(--color-text-main)]">规则阈值配置</div>
              <button type="button" onClick={() => setThresholdOpen(false)} className="text-[var(--color-icon-muted)] hover:text-[var(--color-error-text)]"><X size="var(--icon-topbar)" /></button>
            </header>
            <div className="grid grid-cols-2 gap-[var(--layout-content-gap)] p-[var(--layout-content-padding)] text-ui-medium">
              <label className="flex items-center justify-between gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)]">
                区域平均 QoE 低于
                <span className="shrink-0">
                  <input type="number" min="0" step="1" value={thresholdDraft.QoE ?? ""} onChange={(event) => updateThreshold("QoE", event.target.value)} className="w-[8rem] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-[var(--layout-search-padding-x)] outline-none" /> 分
                </span>
              </label>
              <label className="flex items-center justify-between gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)]">
                吞吐量小于
                <span className="shrink-0">
                  <input type="number" min="0" step="0.1" value={thresholdDraft.吞吐量 ?? ""} onChange={(event) => updateThreshold("吞吐量", event.target.value)} className="w-[8rem] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-[var(--layout-search-padding-x)] outline-none" /> Mbps
                </span>
              </label>
              <label className="flex items-center justify-between gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)]">
                时延大于
                <span className="shrink-0">
                  <input type="number" min="0" step="1" value={thresholdDraft.时延 ?? ""} onChange={(event) => updateThreshold("时延", event.target.value)} className="w-[8rem] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-[var(--layout-search-padding-x)] outline-none" /> ms
                </span>
              </label>
              <label className="flex items-center justify-between gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)]">
                时延抖动大于
                <span className="shrink-0">
                  <input type="number" min="0" step="1" value={thresholdDraft.时延抖动 ?? ""} onChange={(event) => updateThreshold("时延抖动", event.target.value)} className="w-[8rem] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-[var(--layout-search-padding-x)] outline-none" /> ms
                </span>
              </label>
              <label className="flex items-center justify-between gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)]">
                丢包率大于
                <span className="shrink-0">
                  <input type="number" min="0" step="0.1" value={thresholdDraft.丢包率 ?? ""} onChange={(event) => updateThreshold("丢包率", event.target.value)} className="w-[8rem] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-[var(--layout-search-padding-x)] outline-none" /> %
                </span>
              </label>
              <div className="col-span-2 flex justify-end gap-[var(--layout-search-gap)]">
                <button type="button" onClick={() => setThresholdOpen(false)} className="h-[var(--layout-search-height)] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] text-ui-small text-[var(--color-text-muted)] hover:bg-[var(--color-hover-bg)]">取消</button>
                <button type="button" onClick={saveThresholds} className="h-[var(--layout-search-height)] rounded-[var(--layout-radius-sm)] bg-[var(--color-topbar-active-bg)] px-[var(--layout-search-padding-x)] text-ui-small font-semibold text-[var(--color-topbar-active-text)]">保存配置</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default function VideoAlarmManage({ focusTarget, resetVersion = 0, onOpenCameraDiagnosis }) {
  const [cameras, setCameras] = useState([]);
  const [streams, setStreams] = useState([]);
  const [keyword, setKeyword] = useState("");
  const [selectedAlarm, setSelectedAlarm] = useState(null);
  const [handledMap, setHandledMap] = useState(() => readAlarmConfirmState());
  const [statusFilter, setStatusFilter] = useState("all");
  const [algorithm, setAlgorithm] = useState("spatioTemporal");
  const [confirmStrategy, setConfirmStrategy] = useState("manual");
  const [thresholds, setThresholds] = useState({
    QoE: 75,
    吞吐量: 4,
    时延: 150,
    时延抖动: 25,
    丢包率: 1.5,
  });
  const [loading, setLoading] = useState(false);
  const alarmResetSeenRef = useRef(resetVersion);
  const algorithmLoadSeenRef = useRef(algorithm);

  const regionCode = focusTarget?.nodeType === "region" ? focusTarget.regionCode : "";
  const cameraId = focusTarget?.nodeType === "camera" ? focusTarget.cameraId : "";

  useEffect(() => {
    setLoading(true);
    Promise.all([
      getDeviceCameras(regionCode ? { region_code: regionCode } : {}),
      getDeviceStreams(),
    ])
      .then(([cameraRows, streamRows]) => {
        setCameras(cameraRows);
        setStreams(streamRows);
      })
      .finally(() => setLoading(false));
  }, [regionCode, cameraId]);

  useEffect(() => {
    if (alarmResetSeenRef.current === resetVersion) return;
    alarmResetSeenRef.current = resetVersion;
    localStorage.removeItem(ALARM_CONFIRM_STORAGE_KEY);
    setHandledMap({});
    setConfirmStrategy("manual");
    setStatusFilter("all");
  }, [resetVersion]);

  useEffect(() => {
    if (algorithmLoadSeenRef.current === algorithm) return;
    algorithmLoadSeenRef.current = algorithm;
    setLoading(true);
    setSelectedAlarm(null);
    const timer = window.setTimeout(() => setLoading(false), 450);
    return () => window.clearTimeout(timer);
  }, [algorithm]);

  const allAlarms = useMemo(() => {
    const scopedCameras = cameraId ? cameras.filter((camera) => camera.id === cameraId) : cameras;
    const scopedIds = new Set(scopedCameras.map((camera) => camera.id));
    const scopedStreams = streams.filter((stream) => scopedIds.has(stream.camera_id));
    return buildAlarms(scopedCameras, scopedStreams, handledMap, confirmStrategy, algorithm);
  }, [cameras, streams, cameraId, handledMap, confirmStrategy, algorithm]);

  const anomalyTypeOptions = useMemo(
    () => Array.from(new Set(allAlarms.map((alarm) => alarm.type))).filter(Boolean),
    [allAlarms]
  );

  const alarms = useMemo(() => {
    return allAlarms.filter((alarm) => {
      const haystack = `${alarm.source} ${alarm.type} ${alarm.status} ${alarm.camera?.id || ""}`.toLowerCase();
      const matchesKeyword = haystack.includes(keyword.trim().toLowerCase());
      const matchesStatus = statusFilter === "all"
        || alarm.status === statusFilter
        || (statusFilter.startsWith("type:") && alarm.type === statusFilter.slice(5));
      return matchesKeyword && matchesStatus;
    });
  }, [allAlarms, keyword, statusFilter]);

  useEffect(() => {
    setSelectedAlarm((current) => current && alarms.some((alarm) => alarm.id === current.id) ? current : alarms[0] || null);
  }, [alarms]);

  const scopeText = focusTarget ? (focusTarget.nodeType === "camera" ? `当前摄像机：${focusTarget.name}` : `当前行政区：${focusTarget.name}`) : "当前范围：全部区域";

  function toggleHandled(alarm) {
    setHandledMap((current) => ({
      ...current,
      [alarm.id]: alarm.status === "已确认" ? "未确认" : "已确认",
    }));
  }

  useEffect(() => {
    writeAlarmConfirmState(handledMap);
  }, [handledMap]);

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-[var(--layout-content-gap)] bg-[var(--color-page-bg)] p-[var(--layout-content-padding)]">
      <section className="rounded-[var(--layout-radius-lg)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] p-[var(--layout-content-padding)] shadow-[var(--shadow-panel)]">
        <div className="flex items-center gap-[var(--layout-content-gap)]">
          <h1 className="shrink-0 text-ui-large font-bold text-[var(--color-text-main)]">异常告警</h1>
          <span className="min-w-0 flex-1 truncate text-ui-medium text-[var(--color-text-muted)]">{scopeText}</span>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="h-[var(--layout-search-height)] shrink-0 rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] text-ui-medium text-[var(--color-text-main)] outline-none">
            <option value="all">全部告警</option>
            <option value="未确认">未确认</option>
            <option value="已确认">已确认</option>
            {anomalyTypeOptions.map((type) => (
              <option key={type} value={`type:${type}`}>{type}</option>
            ))}
          </select>
          <div className="flex min-h-[var(--layout-search-height)] w-[min(30rem,28vw)] items-center gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)]">
            <Search size="var(--icon-search)" className="text-[var(--color-icon-muted)]" />
            <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索摄像机、异常类型、状态" className="min-w-0 flex-1 bg-transparent text-ui-medium outline-none" />
          </div>
        </div>
      </section>

      <section className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] gap-[var(--layout-content-gap)]">
        <div className="min-h-0 overflow-auto rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)]">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-[var(--layout-search-gap)] text-ui-medium text-[var(--color-text-muted)]"><Loader2 size="var(--icon-search)" className="animate-spin" /> 正在加载告警</div>
          ) : (
            <table className="w-max min-w-full border-separate border-spacing-0 text-left text-ui-medium">
              <thead className="sticky top-0 z-10 bg-[var(--color-control-bg)] text-[var(--color-text-muted)]">
                <tr>
                  {["告警时间", "告警摄像机", "异常类型", "当前状态", "操作"].map((label) => (
                    <th key={label} className="whitespace-nowrap border-b border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] py-[var(--layout-device-table-padding-y)]">{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {alarms.map((alarm) => (
                  <tr key={alarm.id} onClick={() => setSelectedAlarm(alarm)} className={`cursor-pointer text-[var(--color-text-main)] ${selectedAlarm?.id === alarm.id ? "bg-[var(--color-hover-bg)]" : `${detectionRowClass(alarm.detectionTier)} hover:bg-[var(--color-hover-bg)]`}`}>
                    <td className="whitespace-nowrap border-b border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] py-[var(--layout-device-table-padding-y)]">{alarm.time}</td>
                    <td className="max-w-[28rem] truncate border-b border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] py-[var(--layout-device-table-padding-y)]" title={alarm.source}>{alarm.source}</td>
                    <td className="whitespace-nowrap border-b border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] py-[var(--layout-device-table-padding-y)]">{alarm.type}</td>
                    <td className="whitespace-nowrap border-b border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] py-[var(--layout-device-table-padding-y)]">
                      <span className={`rounded-[var(--layout-radius-sm)] border px-[var(--layout-tree-action-padding)] ${statusClass(alarm.status)}`}>{alarm.status}</span>
                    </td>
                    <td className="whitespace-nowrap border-b border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] py-[var(--layout-device-table-padding-y)]">
                      <button type="button" onClick={(event) => { event.stopPropagation(); toggleHandled(alarm); }} className="text-ui-small text-[var(--color-accent)] hover:underline">
                        {alarm.status === "已确认" ? "取消确认" : "确认"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <aside className="min-h-0 overflow-auto rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] p-[var(--layout-content-padding)]">
          {selectedAlarm ? (
            <div className="space-y-[var(--layout-content-gap)]">
              <div className="flex items-center justify-between gap-[var(--layout-search-gap)]">
                <div className="flex min-w-0 items-center gap-[var(--layout-search-gap)]">
                  <Bell size="var(--icon-topbar)" className="text-[var(--color-error-text)]" />
                  <h2 className="max-w-[min(46rem,52vw)] truncate text-ui-large font-bold text-[var(--color-text-main)]" title={selectedAlarm.camera?.name}>{selectedAlarm.camera?.name || selectedAlarm.camera?.id}</h2>
                </div>
                <button type="button" onClick={() => onOpenCameraDiagnosis?.(selectedAlarm.camera)} className="flex min-h-[var(--layout-segment-button-height)] shrink-0 items-center gap-[var(--layout-reset-tooltip-gap)] rounded-[var(--layout-radius-sm)] bg-[var(--color-topbar-active-bg)] px-[var(--layout-segment-button-padding-x)] text-ui-medium font-semibold text-[var(--color-topbar-active-text)]">
                  <Zap size="var(--icon-bottom)" /> 根因诊断
                </button>
              </div>
              <AlarmPreview alarm={selectedAlarm} />
              <div className="grid grid-cols-2 gap-[var(--layout-content-gap)] text-ui-medium">
                <div className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] p-[var(--layout-content-gap)]">摄像机状态：{cameraStatusText(selectedAlarm.camera?.status)}</div>
                <div className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] p-[var(--layout-content-gap)]">告警状态：{selectedAlarm.status}</div>
              </div>
              <MetricTrendChart alarm={selectedAlarm} algorithm={algorithm} thresholds={thresholds} />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-ui-medium text-[var(--color-text-muted)]"><CheckCircle2 size="var(--icon-topbar)" className="mr-[var(--layout-search-gap)] text-[var(--color-accent)]" /> 当前范围暂无告警</div>
          )}
        </aside>
      </section>

      <InlineAlgorithmConfig
        scopeName={scopeText.replace(/^当前范围：/, "")}
        algorithm={algorithm}
        setAlgorithm={setAlgorithm}
        confirmStrategy={confirmStrategy}
        setConfirmStrategy={setConfirmStrategy}
        thresholds={thresholds}
        setThresholds={setThresholds}
      />
    </main>
  );
}
