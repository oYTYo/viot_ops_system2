import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Gauge,
  Loader2,
  RefreshCw,
  Server,
  TrendingUp,
  Video,
  WifiOff,
} from "lucide-react";
import { getStatisticsOverview } from "../services/statisticsApi";

const statusMeta = {
  normal: { label: "正常", color: "var(--color-accent)", icon: CheckCircle2 },
  fault: { label: "异常", color: "var(--color-error-text)", icon: AlertTriangle },
  offline: { label: "离线/断连", color: "var(--color-text-muted)", icon: WifiOff },
};

function formatNumber(value, digits = 0) {
  const number = Number(value || 0);
  return number.toFixed(digits).replace(/\.0+$/, "");
}

function percent(value) {
  return `${formatNumber(value, 1)}%`;
}

function Panel({ title, subtitle, icon: Icon, children, action = null, className = "" }) {
  return (
    <section className={`flex min-w-0 flex-col rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] shadow-[var(--shadow-panel)] ${className}`}>
      <div className="flex min-w-0 items-center gap-[var(--layout-search-gap)] border-b border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-content-padding)] py-[var(--layout-search-padding-y)]">
        {Icon && <Icon size="var(--icon-topbar)" className="shrink-0 text-[var(--color-accent)]" />}
        <h2 className="shrink-0 text-ui-large font-bold text-[var(--color-text-main)]">{title}</h2>
        {subtitle && <span className="min-w-0 truncate text-ui-small text-[var(--color-text-muted)]">{subtitle}</span>}
        {action && <div className="ml-auto shrink-0">{action}</div>}
      </div>
      <div className="min-w-0 flex-1 p-[var(--layout-content-padding)]">{children}</div>
    </section>
  );
}

function StatusGroup({ title, icon: Icon, data, offlineLabel = "离线", onTitleClick, onStatusClick }) {
  const total = data?.total || 0;
  const rows = ["normal", "fault", "offline"].map((key) => ({
    key,
    value: data?.[key] || 0,
    ratio: total ? ((data?.[key] || 0) / total) * 100 : 0,
    ...statusMeta[key],
    label: key === "offline" ? offlineLabel : statusMeta[key].label,
  }));

  return (
    <div className="min-w-0 rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] p-[var(--layout-content-padding)]">
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
              width: `${total ? (row.value / total) * 100 : 0}%`,
              minWidth: row.value ? "var(--layout-tree-action-padding)" : 0,
              backgroundColor: row.color,
            }}
          />
        ))}
      </div>
    </div>
  );
}

function LatexFormula({ source }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-center gap-x-[var(--layout-search-gap)] gap-y-[var(--layout-tree-gap)] text-ui-small text-[var(--color-text-muted)] [.font-scale-small_&]:flex-nowrap [.font-scale-small_&]:gap-x-[var(--layout-reset-tooltip-gap)] [.font-scale-small_&]:gap-y-0 [.font-scale-small_&]:overflow-visible" title={source}>
      <span className="shrink-0 whitespace-nowrap">全局健康度 = 100 -</span>
      <span className="inline-flex shrink-0 flex-col items-center align-middle leading-none" title={source}>
        <span className="border-b border-[var(--color-text-muted)] px-[var(--layout-tree-action-padding)] pb-[var(--layout-tree-gap)] [.font-scale-small_&]:px-[var(--layout-reset-padding-x)]">
          Σ (每条链路权重 × 异常分数)
        </span>
        <span className="px-[var(--layout-tree-action-padding)] pt-[var(--layout-tree-gap)] [.font-scale-small_&]:px-[var(--layout-reset-padding-x)]">
          Σ 每条链路权重
        </span>
      </span>
    </div>
  );
}

function HealthGauge({ value, formula, formulaLatex, sampleCount, safeDays = 42 }) {
  const radius = 44;
  const circumference = 2 * Math.PI * radius;
  const dash = circumference * (Number(value || 0) / 100);
  // 更新分级阈值为 90 和 70
  const color = value >= 90 ? "var(--color-accent)" : value >= 70 ? "#f59e0b" : "var(--color-error-text)";

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
            <div className="text-ui-large font-bold leading-none" style={{ color }}>{formatNumber(value, 1)}</div>
          </div>
          {/* Hover 悬浮显示公式 */}
          <div className="pointer-events-none absolute left-0 top-[110%] z-[9999] w-max opacity-0 transition-opacity group-hover:opacity-100 rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] p-[var(--layout-content-padding)] shadow-[var(--shadow-panel)]">
            <LatexFormula source={formulaLatex} />
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

function KqiBar({ items }) {
  const total = Math.max(...(items || []).map((item) => item.ratio || 0), 1);
  return (
    <div className="grid min-w-0 gap-[var(--layout-content-gap)] md:grid-cols-4">
      {(items || []).map((item) => (
        <div key={item.name} className="min-w-0 rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] p-[var(--layout-search-padding-x)]">
          <div className="flex items-center justify-between gap-[var(--layout-search-gap)]">
            <span className="truncate text-ui-medium font-bold text-[var(--color-text-main)]">{item.name}</span>
            <span className="shrink-0 text-ui-large font-bold text-[var(--color-error-text)]">{percent(item.ratio)}</span>
          </div>
          <div className="mt-[var(--layout-content-gap)] h-[calc(var(--font-small)*0.42)] overflow-hidden rounded-full bg-[var(--color-page-bg)]">
            <div className="h-full rounded-full bg-[var(--color-error-text)]" style={{ width: `${Math.max((item.ratio / total) * 100, item.count ? 4 : 0)}%` }} />
          </div>
          <div className="mt-[var(--layout-tree-gap)] text-ui-small text-[var(--color-text-muted)]">异常链路 {item.count || 0} 条</div>
        </div>
      ))}
    </div>
  );
}

function LineChart({ data, series, maxCount }) {
  const width = 640;
  const height = 160;
  const padLeft = 38;
  const padRight = 18;
  const padTop = 20;
  const padBottom = 24;
  const normalizedData = data.map((row) => {
    const next = { ...row };
    series.forEach((item) => {
      next[item.key] = Math.min(Number(row[item.key] || 0), Math.max(Number(maxCount || 0), 0) || Number(row[item.key] || 0));
    });
    return next;
  });
  const maxValue = Math.max(1, ...normalizedData.flatMap((row) => series.map((item) => row[item.key] || 0)));
  const xFor = (index) => padLeft + (index * (width - padLeft - padRight)) / Math.max(data.length - 1, 1);
  const yFor = (value) => height - padBottom - (value / maxValue) * (height - padTop - padBottom);
  const ticks = [maxValue, Math.round(maxValue / 2), 0];

  return (
    <div className="min-w-0 overflow-hidden">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-[calc(var(--font-large)*7)] w-full">
        {ticks.map((tick) => (
          <g key={tick}>
            <text x={padLeft - 8} y={yFor(tick) + 5} textAnchor="end" fill="var(--color-text-muted)" fontSize="15">
              {tick}
            </text>
            <line x1={padLeft} x2={width - padRight} y1={yFor(tick)} y2={yFor(tick)} stroke="var(--color-panel-border)" strokeDasharray="4 6" />
          </g>
        ))}
        <line x1={padLeft} x2={padLeft} y1={padTop} y2={height - padBottom} stroke="var(--color-panel-border)" />
        {series.map((item) => {
          const points = normalizedData.map((row, index) => `${xFor(index)},${yFor(row[item.key] || 0)}`).join(" ");
          const area = `${padLeft},${height - padBottom} ${points} ${width - padRight},${height - padBottom}`;
          return (
            <g key={item.key}>
              <polyline points={area} fill={item.fill} opacity="0.18" />
              <polyline points={points} fill="none" stroke={item.color} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
              {normalizedData.map((row, index) => (
                <g key={`${item.key}-${row.date}`}>
                  <text x={xFor(index)} y={yFor(row[item.key] || 0) - 7} textAnchor="middle" fill={item.color} fontSize="15" fontWeight="700">
                    {row[item.key] || 0}
                  </text>
                  <circle cx={xFor(index)} cy={yFor(row[item.key] || 0)} r="4" fill={item.color} />
                </g>
              ))}
            </g>
          );
        })}
        {normalizedData.map((row, index) => (
          <text key={row.date} x={xFor(index)} y={height - 4} textAnchor="middle" fill="var(--color-text-muted)" fontSize="15">
            {row.date}
          </text>
        ))}
      </svg>
      <div className="flex flex-wrap items-center gap-[var(--layout-content-gap)] text-ui-small">
        {series.map((item) => (
          <span key={item.key} className="flex items-center gap-[var(--layout-reset-tooltip-gap)] text-[var(--color-text-muted)]">
            <span className="h-[calc(var(--font-small)*0.45)] w-[calc(var(--font-small)*0.9)] rounded-full" style={{ backgroundColor: item.color }} />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function RankingList({ items, tone = "error", limit = 3 }) {
  const topItems = (items || []).slice(0, limit);
  const maxValue = Math.max(1, ...topItems.map((item) => item.count || 0));
  const color = tone === "accent" ? "var(--color-accent)" : "var(--color-error-text)";

  return (
    <div className="space-y-[var(--layout-content-gap)]">
      {topItems.map((item, index) => (
        <div key={`${item.name}-${index}`} className="min-w-0">
          <div className="mb-[var(--layout-tree-gap)] flex items-center justify-between gap-[var(--layout-search-gap)]">
            <span className="min-w-0 truncate text-ui-medium font-semibold text-[var(--color-text-main)]" title={item.name}>
              {index + 1}. {item.name}
            </span>
            <span className="shrink-0 text-ui-medium font-bold" style={{ color }}>{item.count}</span>
          </div>
          <div className="h-[calc(var(--font-small)*0.36)] overflow-hidden rounded-full bg-[var(--color-control-bg)]">
            <div className="h-full rounded-full" style={{ width: `${Math.max((item.count / maxValue) * 100, 5)}%`, backgroundColor: color }} />
          </div>
        </div>
      ))}
      {topItems.length === 0 && <div className="text-ui-medium text-[var(--color-text-muted)]">暂无异常记录</div>}
    </div>
  );
}

function RankingModal({ title, items, tone = "error", onClose }) {
  const color = tone === "accent" ? "var(--color-accent)" : "var(--color-error-text)";
  const maxValue = Math.max(1, ...(items || []).map((item) => Number(item.count || 0)));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35">
      <div className="max-h-[80vh] w-[min(72rem,calc(100%-var(--layout-content-padding)*2))] overflow-hidden rounded-[var(--layout-radius-lg)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] shadow-[var(--shadow-panel)]">
        <header className="flex items-center justify-between border-b border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-content-padding)] py-[var(--layout-search-padding-y)]">
          <h2 className="text-ui-large font-bold text-[var(--color-text-main)]">{title}</h2>
          <button type="button" onClick={onClose} className="text-ui-medium text-[var(--color-text-muted)] hover:text-[var(--color-error-text)]">关闭</button>
        </header>
        <div className="max-h-[65vh] overflow-auto p-[var(--layout-content-padding)]">
          <table className="w-full border-separate border-spacing-0 text-ui-medium">
            <thead className="text-[var(--color-text-muted)]">
              <tr>
                <th className="border-b border-[var(--color-panel-border)] py-[var(--layout-search-padding-y)] text-left">排名</th>
                <th className="border-b border-[var(--color-panel-border)] py-[var(--layout-search-padding-y)] text-left">名称</th>
                <th className="border-b border-[var(--color-panel-border)] py-[var(--layout-search-padding-y)] text-left">分布</th>
                <th className="border-b border-[var(--color-panel-border)] py-[var(--layout-search-padding-y)] text-right">次数</th>
              </tr>
            </thead>
            <tbody>
              {(items || []).map((item, index) => (
                <tr key={`${item.name}-${index}`}>
                  <td className="border-b border-[var(--color-panel-border)] py-[var(--layout-search-padding-y)]">{index + 1}</td>
                  <td className="border-b border-[var(--color-panel-border)] py-[var(--layout-search-padding-y)] text-[var(--color-text-main)]">{item.name}</td>
                  <td className="border-b border-[var(--color-panel-border)] py-[var(--layout-search-padding-y)]">
                    <div className="h-[calc(var(--font-small)*0.42)] overflow-hidden rounded-full bg-[var(--color-control-bg)]">
                      <div className="h-full rounded-full" style={{ width: `${Math.max((Number(item.count || 0) / maxValue) * 100, item.count ? 3 : 0)}%`, backgroundColor: color }} />
                    </div>
                  </td>
                  <td className="border-b border-[var(--color-panel-border)] py-[var(--layout-search-padding-y)] text-right font-bold" style={{ color }}>{item.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function buildScopeParams(focusTarget) {
  if (!focusTarget) return {};
  if (focusTarget.nodeType === "camera" && focusTarget.cameraId) {
    return { camera_id: focusTarget.cameraId };
  }
  if (focusTarget.nodeType !== "camera" && focusTarget.regionCode) {
    return { region_code: focusTarget.regionCode };
  }
  return {};
}

export default function StatisticsView({ focusTarget, onNavigateToDevice }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [rankingModal, setRankingModal] = useState(null);

  const scopeParams = useMemo(() => buildScopeParams(focusTarget), [focusTarget]);

  const fetchData = async () => {
    setLoading(true);
    setError("");
    try {
      const overview = await getStatisticsOverview(scopeParams);
      setData(overview);
    } catch (err) {
      console.error("Failed to load statistics overview:", err);
      setError("统计数据加载失败，请确认后端服务已启动。");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [scopeParams.camera_id, scopeParams.region_code]);

  const generatedAt = useMemo(() => {
    if (!data?.generated_at) return "";
    return new Date(data.generated_at).toLocaleString("zh-CN", { hour12: false });
  }, [data]);

  const scopeName = data?.scope?.name || focusTarget?.name || "全部区域";
  const cameraTotal = Number(data?.device_status?.cameras?.total || 0);

  if (loading) {
    return (
      <main className="flex min-w-0 flex-1 items-center justify-center bg-[var(--color-page-bg)] text-[var(--color-accent)]">
        <Loader2 size="var(--icon-logo)" className="animate-spin" />
      </main>
    );
  }

  return (
    <main className="min-w-0 flex-1 overflow-auto bg-[var(--color-page-bg)] transition-colors">
      <div className="m-[var(--layout-content-padding)] flex min-h-0 flex-col gap-[calc(var(--layout-content-gap)*4.95)]">
        <section className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-[var(--layout-content-padding)] py-[var(--layout-search-padding-y)] shadow-[var(--shadow-panel)]">
          <div className="flex min-w-0 flex-wrap items-center gap-[var(--layout-content-gap)]">
            <h1 className="shrink-0 text-ui-large font-bold text-[var(--color-text-main)]">统计分析</h1>
            <span className="min-w-0 flex-1 truncate text-ui-medium text-[var(--color-text-muted)]" title={scopeName}>
              当前范围：{scopeName}
            </span>
            <span className="shrink-0 text-ui-small text-[var(--color-text-muted)]">更新时间：{generatedAt || "-"}</span>
            <button type="button" onClick={fetchData} className="flex h-[var(--layout-search-height)] shrink-0 items-center gap-[var(--layout-reset-tooltip-gap)] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] text-ui-small text-[var(--color-accent)] hover:bg-[var(--color-hover-bg)]">
              <RefreshCw size="var(--icon-bottom)" /> 刷新
            </button>
          </div>
          {error && <div className="mt-[var(--layout-content-gap)] rounded-[var(--layout-radius-sm)] border border-[var(--color-error-text)] bg-[var(--color-error-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)] text-ui-medium text-[var(--color-error-text)]">{error}</div>}
        </section>

        <Panel title="资源状态统计" icon={Activity}>
          <div className="grid min-w-0 gap-[var(--layout-content-gap)] xl:grid-cols-3">
            <StatusGroup 
              title="摄像机设备" 
              icon={Video} 
              data={data?.device_status?.cameras} 
              offlineLabel="离线"
              onTitleClick={() => onNavigateToDevice?.('camera')}
              onStatusClick={(status) => onNavigateToDevice?.('camera', status)}
            />
            <StatusGroup 
              title="流链路" 
              icon={TrendingUp} 
              data={data?.device_status?.streams} 
              offlineLabel="断连" 
              onTitleClick={() => onNavigateToDevice?.('stream')}
              onStatusClick={(status) => onNavigateToDevice?.('stream', status)}
            />
            <StatusGroup 
              title="服务器" 
              icon={Server} 
              data={data?.device_status?.servers} 
              offlineLabel="离线" 
              onTitleClick={() => onNavigateToDevice?.('server')}
              onStatusClick={(status) => onNavigateToDevice?.('server', status)}
            />
          </div>
        </Panel>

        <div className="grid min-w-0 items-stretch gap-[var(--layout-content-gap)] xl:grid-cols-[minmax(0,0.670fr)_minmax(0,1.325fr)]">
          <Panel title="黄金指标 - 流链路全局健康度" icon={Gauge}>
            <HealthGauge value={data?.golden_metrics?.global_stream_health || 0} formula={data?.golden_metrics?.formula || ""} formulaLatex={data?.golden_metrics?.formula_latex || ""} sampleCount={data?.golden_metrics?.sample_count || 0} safeDays={data?.golden_metrics?.safe_days || 42} />
          </Panel>
          <Panel title="画面异常类型统计" icon={AlertTriangle}>
            <KqiBar items={data?.kqi_degradation || []} />
          </Panel>
        </div>

        <div className="grid min-w-0 gap-[var(--layout-content-gap)] xl:grid-cols-2">
          <Panel title="告警类型统计TOP3" icon={AlertTriangle} action={<button type="button" onClick={() => setRankingModal({ title: "告警类型完整表格", items: data?.anomaly_patterns || [], tone: "error" })} className="rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] py-[var(--layout-reset-padding-y)] text-ui-small text-[var(--color-accent)] hover:bg-[var(--color-hover-bg)]">详情</button>}>
            <RankingList items={data?.anomaly_patterns || []} />
          </Panel>
          <Panel title="根因实体统计TOP3" icon={TrendingUp} action={<button type="button" onClick={() => setRankingModal({ title: "根因实体完整表格", items: data?.anomaly_entities || [], tone: "accent" })} className="rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] py-[var(--layout-reset-padding-y)] text-ui-small text-[var(--color-accent)] hover:bg-[var(--color-hover-bg)]">详情</button>}>
            <RankingList items={data?.anomaly_entities || []} tone="accent" />
          </Panel>
        </div>

        {rankingModal && <RankingModal {...rankingModal} onClose={() => setRankingModal(null)} />}
      </div>
    </main>
  );
}
