import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Camera,
  CheckCircle2,
  Clock3,
  ClipboardCheck,
  ClipboardList,
  Edit3,
  FilePlus2,
  Filter,
  Link2,
  Loader2,
  MapPin,
  PlayCircle,
  RefreshCw,
  Search,
  Server,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import {
  createWorkOrder,
  deleteWorkOrder,
  getWorkOrders,
  updateWorkOrder,
} from "../services/workOrderApi";
import {
  getDeviceCameras,
  getDeviceServers,
  getDeviceStreams,
} from "../services/deviceApi";

const statusOptions = [
  { value: "all", label: "全部状态" },
  { value: "pending", label: "待受理" },
  { value: "processing", label: "处理中" },
  { value: "review", label: "待复核" },
  { value: "closed", label: "已关闭" },
  { value: "cancelled", label: "已取消" },
];

const editableStatusOptions = statusOptions.filter((item) => item.value !== "all");

const priorityOptions = [
  { value: "all", label: "全部优先级" },
  { value: "urgent", label: "紧急" },
  { value: "high", label: "高" },
  { value: "medium", label: "中" },
  { value: "low", label: "低" },
];

const editablePriorityOptions = priorityOptions.filter((item) => item.value !== "all");

const typeOptions = [
  { value: "all", label: "全部类型" },
  { value: "camera", label: "摄像机" },
  { value: "server", label: "服务器" },
  { value: "stream", label: "流链路" },
  { value: "inspection", label: "巡检" },
  { value: "manual", label: "人工" },
];

const editableTypeOptions = typeOptions.filter((item) => item.value !== "all");

const entityTypeOptions = [
  { value: "", label: "不关联实体" },
  { value: "camera", label: "摄像机" },
  { value: "server", label: "服务器" },
  { value: "stream_media", label: "流链路" },
];

const emptyForm = {
  title: "",
  description: "",
  order_type: "camera",
  priority: "medium",
  status: "pending",
  source: "manual",
  related_entity_type: "",
  related_entity_id: "",
  related_entity_name: "",
  region_code: "",
  region_name: "",
  region_level: "",
  region_path: "",
  assignee: "",
  creator: "平台管理员",
  reviewer: "",
  sla_deadline: "",
  resolution: "",
};

function textOf(options, value, fallback = "-") {
  return options.find((item) => item.value === value)?.label || fallback;
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function toInputDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function toApiDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function statusClass(status) {
  if (status === "closed") return "border-emerald-500 bg-emerald-500/10 text-emerald-600";
  if (status === "processing") return "border-[var(--color-accent)] bg-[var(--color-hover-bg)] text-[var(--color-accent)]";
  if (status === "review") return "border-sky-500 bg-sky-500/10 text-sky-600";
  if (status === "cancelled") return "border-[var(--color-panel-border)] bg-[var(--color-control-bg)] text-[var(--color-text-muted)]";
  return "border-amber-500 bg-amber-500/10 text-amber-600";
}

function priorityClass(priority) {
  if (priority === "urgent") return "border-[var(--color-error-text)] bg-[var(--color-error-bg)] text-[var(--color-error-text)]";
  if (priority === "high") return "border-orange-500 bg-orange-500/10 text-orange-600";
  if (priority === "low") return "border-[var(--color-panel-border)] bg-[var(--color-control-bg)] text-[var(--color-text-muted)]";
  return "border-[var(--color-accent)] bg-[var(--color-hover-bg)] text-[var(--color-accent)]";
}

function entityIcon(type) {
  if (type === "server") return Server;
  if (type === "stream_media" || type === "stream") return Link2;
  return Camera;
}

function entityLabel(type) {
  if (type === "server") return "服务器";
  if (type === "stream_media" || type === "stream") return "流链路";
  if (type === "network_node") return "网络节点";
  if (type === "camera") return "摄像机";
  return "未关联";
}

function isSlaRisk(order) {
  if (!order.sla_deadline || ["closed", "cancelled"].includes(order.status)) return false;
  const deadline = new Date(order.sla_deadline).getTime();
  return deadline - Date.now() <= 2 * 60 * 60 * 1000;
}

function nextStatus(order) {
  if (order.status === "pending") return { value: "processing", label: "接单" };
  if (order.status === "processing") return { value: "review", label: "提交复核" };
  if (order.status === "review") return { value: "closed", label: "关闭" };
  return null;
}

function buildFormFromOrder(order) {
  return {
    ...emptyForm,
    ...order,
    related_entity_type: order.related_entity_type || "",
    related_entity_id: order.related_entity_id || "",
    sla_deadline: toInputDateTime(order.sla_deadline),
  };
}

function buildPayload(form) {
  return {
    title: form.title.trim(),
    description: form.description.trim() || null,
    order_type: form.order_type,
    priority: form.priority,
    status: form.status,
    source: form.source.trim() || "manual",
    related_entity_type: form.related_entity_type || null,
    related_entity_id: form.related_entity_id || null,
    related_entity_name: form.related_entity_name.trim() || null,
    region_code: form.region_code.trim() || null,
    region_name: form.region_name.trim() || null,
    region_level: form.region_level || null,
    region_path: form.region_path.trim() || null,
    assignee: form.assignee.trim() || null,
    creator: form.creator.trim() || null,
    reviewer: form.reviewer.trim() || null,
    sla_deadline: toApiDateTime(form.sla_deadline),
    resolution: form.resolution.trim() || null,
  };
}

function validateForm(form) {
  if (!form.title.trim()) return "请填写工单标题";
  if (!form.description.trim()) return "请填写问题描述";
  if (!form.assignee.trim()) return "请填写处理人";
  if (!form.sla_deadline) return "请设置 SLA 截止时间";
  if (form.related_entity_type && !form.related_entity_id) return "请选择关联实体";
  return "";
}

function FormField({ label, children, className = "" }) {
  return (
    <label className={`flex min-w-0 flex-col gap-[var(--layout-tree-gap)] text-ui-small font-medium text-[var(--color-text-muted)] ${className}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function TextInput(props) {
  return (
    <input
      {...props}
      className={`min-h-[var(--layout-search-height)] rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)] text-ui-medium text-[var(--color-text-main)] outline-none transition-colors focus:border-[var(--color-accent)] ${props.className || ""}`}
    />
  );
}

function SelectInput(props) {
  return (
    <select
      {...props}
      className={`min-h-[var(--layout-search-height)] rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)] text-ui-medium text-[var(--color-text-main)] outline-none transition-colors focus:border-[var(--color-accent)] ${props.className || ""}`}
    />
  );
}

function TextAreaInput(props) {
  return (
    <textarea
      {...props}
      className={`min-h-[calc(var(--layout-search-height)*2)] resize-none rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)] text-ui-medium text-[var(--color-text-main)] outline-none transition-colors focus:border-[var(--color-accent)] ${props.className || ""}`}
    />
  );
}

function MetricCard({ icon: Icon, label, value, tone = "normal" }) {
  const toneClass = tone === "danger" ? "text-[var(--color-error-text)]" : "text-[var(--color-accent)]";

  return (
    <div className="flex min-w-0 items-center justify-between gap-[var(--layout-content-gap)] rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-[var(--layout-content-padding)] py-[var(--layout-search-padding-y)] shadow-[var(--shadow-panel)]">
      <div className="flex min-w-0 items-center gap-[var(--layout-search-gap)]">
        <Icon size="var(--icon-topbar)" className={`shrink-0 ${toneClass}`} />
        <span className="whitespace-nowrap text-ui-medium font-semibold text-[var(--color-text-main)]">{label}</span>
      </div>
      <span className={`shrink-0 whitespace-nowrap text-ui-large font-bold ${toneClass}`}>{value}</span>
    </div>
  );
}

function WorkOrderCard({ order, active, onView, onAdvance, onEdit, onDelete }) {
  const Icon = entityIcon(order.related_entity_type || order.order_type);
  const action = nextStatus(order);

  return (
    <article
      className={`flex min-h-[calc(var(--layout-content-padding)*11)] min-w-0 flex-col overflow-hidden rounded-[var(--layout-radius-md)] border bg-[var(--color-panel-bg)] shadow-[var(--shadow-panel)] transition-colors ${
        active ? "border-[var(--color-accent)]" : "border-[var(--color-panel-border)] hover:border-[var(--color-accent)]"
      }`}
    >
      <button type="button" onClick={() => onView(order)} className="flex min-w-0 flex-1 flex-col p-[var(--layout-content-padding)] text-left">
        <div className="flex items-start justify-between gap-[var(--layout-content-gap)]">
          <div className="flex min-w-0 items-start gap-[var(--layout-search-gap)]">
            <span className="flex h-[calc(var(--icon-topbar)*1.8)] w-[calc(var(--icon-topbar)*1.8)] shrink-0 items-center justify-center rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] text-[var(--color-accent)]">
              <Icon size="var(--icon-topbar)" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-ui-large font-bold text-[var(--color-text-main)]" title={order.title}>
                {order.title}
              </div>
              <div className="mt-[var(--layout-tree-gap)] flex flex-wrap items-center gap-[var(--layout-search-gap)]">
                <span className={`rounded-[var(--layout-radius-sm)] border px-[var(--layout-tree-action-padding)] py-[var(--layout-tree-action-padding)] text-ui-small ${statusClass(order.status)}`}>
                  {textOf(statusOptions, order.status)}
                </span>
                <span className={`rounded-[var(--layout-radius-sm)] border px-[var(--layout-tree-action-padding)] py-[var(--layout-tree-action-padding)] text-ui-small ${priorityClass(order.priority)}`}>
                  {textOf(priorityOptions, order.priority)}
                </span>
              </div>
            </div>
          </div>
          <span className="shrink-0 text-ui-small font-semibold text-[var(--color-text-muted)]">{order.id}</span>
        </div>

        <div className="mt-[var(--layout-content-gap)] grid grid-cols-2 gap-x-[var(--layout-content-gap)] gap-y-[var(--layout-tree-gap)] text-ui-small text-[var(--color-text-muted)]">
          <span className="truncate">类型：{textOf(typeOptions, order.order_type, order.order_type)}</span>
          <span className="truncate">处理人：{order.assignee || "未分派"}</span>
          <span className="col-span-2 truncate">对象：{order.related_entity_name || entityLabel(order.related_entity_type)}</span>
          <span className="col-span-2 truncate">范围：{order.region_path || order.region_name || "未限定"}</span>
        </div>

        <p className="mt-[var(--layout-content-gap)] line-clamp-2 text-ui-medium leading-relaxed text-[var(--color-text-main)]">
          {order.description || "暂无问题描述"}
        </p>

        <div className="mt-auto pt-[var(--layout-content-gap)]">
          <div className={`flex items-center gap-[var(--layout-search-gap)] text-ui-small ${isSlaRisk(order) ? "text-[var(--color-error-text)]" : "text-[var(--color-text-muted)]"}`}>
            <Clock3 size="var(--icon-tree-action)" />
            <span className="truncate">SLA：{formatDateTime(order.sla_deadline)}</span>
          </div>
        </div>
      </button>

      <div className="flex items-center justify-between border-t border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-content-padding)] py-[var(--layout-search-padding-y)]">
        <button type="button" onClick={() => onView(order)} className="flex items-center gap-[var(--layout-reset-tooltip-gap)] rounded-[var(--layout-radius-sm)] px-[var(--layout-segment-button-padding-x)] py-[var(--layout-segment-button-padding-y)] text-ui-small text-[var(--color-accent)] hover:bg-[var(--color-hover-bg)]">
          <ClipboardList size="var(--icon-bottom)" /> 详情
        </button>
        <div className="flex items-center gap-[var(--layout-search-gap)]">
          {action && (
            <button type="button" onClick={() => onAdvance(order, action.value)} className="flex items-center gap-[var(--layout-reset-tooltip-gap)] rounded-[var(--layout-radius-sm)] px-[var(--layout-segment-button-padding-x)] py-[var(--layout-segment-button-padding-y)] text-ui-small text-[var(--color-text-main)] hover:bg-[var(--color-hover-bg)] hover:text-[var(--color-accent)]">
              <PlayCircle size="var(--icon-bottom)" /> {action.label}
            </button>
          )}
          <button type="button" title="编辑" onClick={() => onEdit(order)} className="rounded-[var(--layout-radius-sm)] p-[var(--layout-tree-action-padding)] text-[var(--color-icon-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-accent)]">
            <Edit3 size="var(--icon-bottom)" />
          </button>
          <button type="button" title="删除" onClick={() => onDelete(order)} className="rounded-[var(--layout-radius-sm)] p-[var(--layout-tree-action-padding)] text-[var(--color-icon-muted)] hover:bg-[var(--color-error-bg)] hover:text-[var(--color-error-text)]">
            <Trash2 size="var(--icon-bottom)" />
          </button>
        </div>
      </div>
    </article>
  );
}

function WorkOrderDetail({ order, onClose, onAdvance, onEdit }) {
  const Icon = entityIcon(order.related_entity_type || order.order_type);
  const action = nextStatus(order);
  const timeline = [...(order.timeline || [])].reverse();

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] shadow-[var(--shadow-panel)]">
      <div className="flex shrink-0 items-start justify-between gap-[var(--layout-content-gap)] border-b border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-content-padding)] py-[var(--layout-content-gap)]">
        <div className="flex min-w-0 items-start gap-[var(--layout-content-gap)]">
          <span className="flex h-[calc(var(--icon-topbar)*2)] w-[calc(var(--icon-topbar)*2)] shrink-0 items-center justify-center rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] text-[var(--color-accent)]">
            <Icon size="var(--icon-topbar)" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-ui-large font-bold text-[var(--color-text-main)]">
              {order.id} - {order.title} - {order.region_path || "未限定范围"} - {textOf(statusOptions, order.status)}
            </div>
            <div className="mt-[var(--layout-tree-gap)] flex flex-wrap items-center gap-[var(--layout-search-gap)] text-ui-small text-[var(--color-text-muted)]">
              <span>{entityLabel(order.related_entity_type)}：{order.related_entity_name || order.related_entity_id || "未关联"}</span>
              <span>优先级：{textOf(priorityOptions, order.priority)}</span>
              <span>处理人：{order.assignee || "未分派"}</span>
              <span>SLA：{formatDateTime(order.sla_deadline)}</span>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-[var(--layout-search-gap)]">
          {action && (
            <button type="button" onClick={() => onAdvance(order, action.value)} className="flex items-center gap-[var(--layout-reset-tooltip-gap)] rounded-[var(--layout-radius-md)] bg-[var(--color-topbar-active-bg)] px-[var(--layout-segment-button-padding-x)] py-[var(--layout-segment-button-padding-y)] text-ui-medium font-semibold text-[var(--color-topbar-active-text)]">
              <PlayCircle size="var(--icon-bottom)" /> {action.label}
            </button>
          )}
          <button type="button" title="编辑" onClick={() => onEdit(order)} className="rounded-[var(--layout-radius-sm)] p-[var(--layout-tree-action-padding)] text-[var(--color-icon-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-accent)]">
            <Edit3 size="var(--icon-topbar)" />
          </button>
          <button type="button" title="关闭详情" onClick={onClose} className="rounded-[var(--layout-radius-sm)] p-[var(--layout-tree-action-padding)] text-[var(--color-icon-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-accent)]">
            <X size="var(--icon-topbar)" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-[var(--layout-content-padding)]">
        <div className="grid grid-cols-[1.1fr_0.9fr] gap-[var(--layout-content-gap)]">
          <div className="space-y-[var(--layout-content-gap)]">
            <section className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] p-[var(--layout-content-padding)]">
              <div className="mb-[var(--layout-search-gap)] text-ui-large font-bold text-[var(--color-text-main)]">问题与处置</div>
              <p className="whitespace-pre-wrap text-ui-medium leading-relaxed text-[var(--color-text-main)]">{order.description || "-"}</p>
              <div className="mt-[var(--layout-content-gap)] grid grid-cols-2 gap-[var(--layout-content-gap)] text-ui-medium">
                <InfoLine label="来源" value={order.source || "-"} />
                <InfoLine label="创建人" value={order.creator || "-"} />
                <InfoLine label="创建时间" value={formatDateTime(order.created_at)} />
                <InfoLine label="更新时间" value={formatDateTime(order.updated_at)} />
                <InfoLine label="受理时间" value={formatDateTime(order.accepted_at)} />
                <InfoLine label="关闭时间" value={formatDateTime(order.closed_at)} />
              </div>
            </section>

            <section className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] p-[var(--layout-content-padding)]">
              <div className="mb-[var(--layout-search-gap)] text-ui-large font-bold text-[var(--color-text-main)]">关联对象</div>
              <div className="grid grid-cols-2 gap-[var(--layout-content-gap)] text-ui-medium">
                <InfoLine label="对象类型" value={entityLabel(order.related_entity_type)} />
                <InfoLine label="对象编号" value={order.related_entity_id || "-"} />
                <InfoLine label="对象名称" value={order.related_entity_name || "-"} />
                <InfoLine label="行政范围" value={order.region_path || order.region_name || "-"} />
              </div>
            </section>

            <section className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] p-[var(--layout-content-padding)]">
              <div className="mb-[var(--layout-search-gap)] text-ui-large font-bold text-[var(--color-text-main)]">处理结果</div>
              <p className="min-h-[calc(var(--layout-search-height)*1.5)] whitespace-pre-wrap text-ui-medium leading-relaxed text-[var(--color-text-main)]">
                {order.resolution || "暂未填写处理结果。"}
              </p>
            </section>
          </div>

          <section className="min-h-0 rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] p-[var(--layout-content-padding)]">
            <div className="mb-[var(--layout-content-gap)] flex items-center justify-between">
              <div className="text-ui-large font-bold text-[var(--color-text-main)]">流转记录</div>
              <span className={`rounded-[var(--layout-radius-sm)] border px-[var(--layout-tree-action-padding)] py-[var(--layout-tree-action-padding)] text-ui-small ${statusClass(order.status)}`}>
                {textOf(statusOptions, order.status)}
              </span>
            </div>
            <div className="space-y-[var(--layout-content-gap)]">
              {timeline.length ? (
                timeline.map((item, index) => (
                  <div key={`${item.time}-${index}`} className="border-l border-[var(--color-accent)] pl-[var(--layout-content-gap)]">
                    <div className="text-ui-medium font-semibold text-[var(--color-text-main)]">{item.action}</div>
                    <div className="mt-[var(--layout-tree-gap)] text-ui-small text-[var(--color-text-muted)]">
                      {formatDateTime(item.time)} · {item.operator || "system"}
                    </div>
                    {item.note && <div className="mt-[var(--layout-tree-gap)] text-ui-small leading-relaxed text-[var(--color-text-main)]">{item.note}</div>}
                  </div>
                ))
              ) : (
                <div className="text-ui-medium text-[var(--color-text-muted)]">暂无流转记录</div>
              )}
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}

function InfoLine({ label, value }) {
  return (
    <div className="min-w-0 border-b border-[var(--color-panel-border)] pb-[var(--layout-tree-gap)]">
      <span className="mr-[var(--layout-search-gap)] text-[var(--color-text-muted)]">{label}</span>
      <span className="break-words font-semibold text-[var(--color-text-main)]">{value}</span>
    </div>
  );
}

function WorkOrderForm({ open, title, form, error, entityOptions, onChange, onSubmit, onClose }) {
  if (!open) return null;

  const selectedEntityOptions = entityOptions[form.related_entity_type] || [];

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/30 p-[var(--layout-content-padding)]">
      <form onSubmit={onSubmit} className="flex max-h-full w-[min(74rem,100%)] flex-col overflow-hidden rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] shadow-[var(--shadow-panel)]">
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-content-padding)] py-[var(--layout-content-gap)]">
          <div className="text-ui-large font-bold text-[var(--color-text-main)]">{title}</div>
          <button type="button" onClick={onClose} className="rounded-[var(--layout-radius-sm)] p-[var(--layout-tree-action-padding)] text-[var(--color-icon-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-accent)]">
            <X size="var(--icon-topbar)" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-[var(--layout-content-padding)]">
          {error && (
            <div className="mb-[var(--layout-content-gap)] flex items-center gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-md)] border border-[var(--color-error-text)] bg-[var(--color-error-bg)] px-[var(--layout-content-padding)] py-[var(--layout-search-padding-y)] text-ui-medium text-[var(--color-error-text)]">
              <AlertCircle size="var(--icon-search)" /> {error}
            </div>
          )}

          <div className="grid grid-cols-4 gap-[var(--layout-content-gap)]">
            <FormField label="工单标题 *" className="col-span-2">
              <TextInput value={form.title} onChange={(event) => onChange({ title: event.target.value })} placeholder="例如：摄像机画面中断排查" />
            </FormField>
            <FormField label="工单类型">
              <SelectInput value={form.order_type} onChange={(event) => onChange({ order_type: event.target.value })}>
                {editableTypeOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </SelectInput>
            </FormField>
            <FormField label="优先级">
              <SelectInput value={form.priority} onChange={(event) => onChange({ priority: event.target.value })}>
                {editablePriorityOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </SelectInput>
            </FormField>

            <FormField label="状态">
              <SelectInput value={form.status} onChange={(event) => onChange({ status: event.target.value })}>
                {editableStatusOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </SelectInput>
            </FormField>
            <FormField label="来源">
              <TextInput value={form.source} onChange={(event) => onChange({ source: event.target.value })} placeholder="manual / alarm / inspection" />
            </FormField>
            <FormField label="处理人 *">
              <TextInput value={form.assignee} onChange={(event) => onChange({ assignee: event.target.value })} />
            </FormField>
            <FormField label="SLA 截止时间 *">
              <TextInput type="datetime-local" value={form.sla_deadline} onChange={(event) => onChange({ sla_deadline: event.target.value })} />
            </FormField>

            <FormField label="关联实体类型">
              <SelectInput
                value={form.related_entity_type}
                onChange={(event) => onChange({ related_entity_type: event.target.value, related_entity_id: "", related_entity_name: "" })}
              >
                {entityTypeOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </SelectInput>
            </FormField>
            <FormField label="关联实体" className="col-span-3">
              <SelectInput
                value={form.related_entity_id}
                disabled={!form.related_entity_type}
                onChange={(event) => {
                  const entity = selectedEntityOptions.find((item) => item.value === event.target.value);
                  onChange({
                    related_entity_id: event.target.value,
                    related_entity_name: entity?.label || "",
                  });
                }}
              >
                <option value="">请选择关联对象</option>
                {selectedEntityOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </SelectInput>
            </FormField>

            <FormField label="行政区编码">
              <TextInput value={form.region_code} onChange={(event) => onChange({ region_code: event.target.value })} placeholder="可选" />
            </FormField>
            <FormField label="行政区名称">
              <TextInput value={form.region_name} onChange={(event) => onChange({ region_name: event.target.value })} placeholder="可选" />
            </FormField>
            <FormField label="行政区级别">
              <SelectInput value={form.region_level} onChange={(event) => onChange({ region_level: event.target.value })}>
                <option value="">未指定</option>
                <option value="province">省级</option>
                <option value="city">地级</option>
                <option value="county">县级</option>
                <option value="town">乡级</option>
              </SelectInput>
            </FormField>
            <FormField label="创建人">
              <TextInput value={form.creator} onChange={(event) => onChange({ creator: event.target.value })} />
            </FormField>

            <FormField label="行政区路径" className="col-span-4">
              <TextInput value={form.region_path} onChange={(event) => onChange({ region_path: event.target.value })} placeholder="省 / 市 / 区县 / 街道，可由关联摄像机自动补齐" />
            </FormField>

            <FormField label="问题描述 *" className="col-span-4">
              <TextAreaInput value={form.description} onChange={(event) => onChange({ description: event.target.value })} placeholder="写清楚现象、影响范围、希望处理的目标" />
            </FormField>

            <FormField label="处理结果" className="col-span-4">
              <TextAreaInput value={form.resolution} onChange={(event) => onChange({ resolution: event.target.value })} placeholder="可在关闭工单前填写" />
            </FormField>
          </div>
        </div>

        <div className="flex shrink-0 justify-end gap-[var(--layout-search-gap)] border-t border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-content-padding)] py-[var(--layout-content-gap)]">
          <button type="button" onClick={onClose} className="rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] px-[var(--layout-segment-button-padding-x)] py-[var(--layout-segment-button-padding-y)] text-ui-medium text-[var(--color-text-main)] hover:bg-[var(--color-hover-bg)]">
            取消
          </button>
          <button type="submit" className="rounded-[var(--layout-radius-md)] bg-[var(--color-topbar-active-bg)] px-[var(--layout-segment-button-padding-x)] py-[var(--layout-segment-button-padding-y)] text-ui-medium font-semibold text-[var(--color-topbar-active-text)]">
            保存
          </button>
        </div>
      </form>
    </div>
  );
}

export default function WorkOrderManage({ focusTarget }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [scope, setScope] = useState(null);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [formState, setFormState] = useState({
    open: false,
    mode: "create",
    data: emptyForm,
    error: "",
  });
  const [entityOptions, setEntityOptions] = useState({
    camera: [],
    server: [],
    stream_media: [],
  });

  useEffect(() => {
    loadEntityOptions();
  }, []);

  useEffect(() => {
    if (!focusTarget) return;

    if (focusTarget.nodeType === "camera") {
      setScope({
        type: "camera",
        label: focusTarget.name || focusTarget.cameraId,
        entityType: "camera",
        entityId: focusTarget.cameraId,
      });
      setSelectedOrder(null);
      return;
    }

    setScope({
      type: "region",
      label: focusTarget.name || "当前行政区",
      regionCode: focusTarget.regionCode,
      level: focusTarget.level,
    });
    setSelectedOrder(null);
  }, [focusTarget]);

  useEffect(() => {
    fetchOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, priorityFilter, typeFilter, scope]);

  const filteredOrders = useMemo(() => {
    const text = keyword.trim().toLowerCase();
    if (!text) return orders;
    return orders.filter((order) =>
      [
        order.id,
        order.title,
        order.description,
        order.related_entity_name,
        order.related_entity_id,
        order.region_path,
        order.assignee,
      ].some((value) => String(value || "").toLowerCase().includes(text))
    );
  }, [orders, keyword]);

  const metrics = useMemo(() => {
    const active = orders.filter((order) => !["closed", "cancelled"].includes(order.status)).length;
    const urgent = orders.filter((order) => order.priority === "urgent").length;
    const risk = orders.filter(isSlaRisk).length;
    return { total: orders.length, active, urgent, risk };
  }, [orders]);

  async function loadEntityOptions() {
    try {
      const [cameras, servers, streams] = await Promise.all([
        getDeviceCameras(),
        getDeviceServers(),
        getDeviceStreams(),
      ]);

      setEntityOptions({
        camera: cameras.map((camera) => ({
          value: camera.id,
          label: `${camera.id} - ${camera.name}`,
        })),
        server: servers.map((server) => ({
          value: server.id,
          label: `${server.id} - ${server.name}`,
        })),
        stream_media: streams.map((stream) => ({
          value: stream.id,
          label: `${stream.id} - ${stream.camera_id || "摄像机"} -> ${stream.server_id || "服务器"}`,
        })),
      });
    } catch (err) {
      console.error("Failed to load work order entity options:", err);
    }
  }

  async function fetchOrders() {
    setLoading(true);
    setError("");
    try {
      const params = {
        status_filter: statusFilter,
        priority: priorityFilter,
        order_type: typeFilter,
      };

      if (scope?.type === "camera") {
        params.entity_type = "camera";
        params.entity_id = scope.entityId;
      }

      if (scope?.type === "region") {
        params.region_code = scope.regionCode;
      }

      const data = await getWorkOrders(params);
      setOrders(data);
      setSelectedOrder((current) => {
        if (!current) return current;
        return data.find((item) => item.id === current.id) || null;
      });
    } catch (err) {
      console.error("Failed to load work orders:", err);
      setError("工单数据加载失败，请确认后端服务和数据库连接正常。");
    } finally {
      setLoading(false);
    }
  }

  function openCreateForm() {
    setFormState({
      open: true,
      mode: "create",
      data: {
        ...emptyForm,
        ...(scope?.type === "camera"
          ? { related_entity_type: "camera", related_entity_id: scope.entityId, related_entity_name: scope.label }
          : {}),
        ...(scope?.type === "region"
          ? { region_code: scope.regionCode, region_name: scope.label, region_level: scope.level || "" }
          : {}),
      },
      error: "",
    });
  }

  function openEditForm(order) {
    setFormState({
      open: true,
      mode: "edit",
      data: buildFormFromOrder(order),
      error: "",
    });
  }

  async function handleSubmitForm(event) {
    event.preventDefault();
    const message = validateForm(formState.data);
    if (message) {
      setFormState((prev) => ({ ...prev, error: message }));
      return;
    }

    try {
      const payload = buildPayload(formState.data);
      const saved =
        formState.mode === "edit"
          ? await updateWorkOrder(formState.data.id, payload)
          : await createWorkOrder(payload);

      setFormState((prev) => ({ ...prev, open: false, error: "" }));
      await fetchOrders();
      setSelectedOrder(saved);
    } catch (err) {
      console.error("Failed to save work order:", err);
      setFormState((prev) => ({ ...prev, error: "工单保存失败，请检查必填字段或关联实体是否有效。" }));
    }
  }

  async function handleAdvance(order, status) {
    try {
      const saved = await updateWorkOrder(order.id, {
        status,
        last_action: `状态推进为 ${textOf(statusOptions, status)}`,
      });
      await fetchOrders();
      setSelectedOrder(saved);
    } catch (err) {
      console.error("Failed to update work order:", err);
      setError("工单状态更新失败。");
    }
  }

  async function handleDelete(order) {
    if (!window.confirm(`确定删除工单 ${order.id} 吗？`)) return;
    try {
      await deleteWorkOrder(order.id);
      if (selectedOrder?.id === order.id) setSelectedOrder(null);
      await fetchOrders();
    } catch (err) {
      console.error("Failed to delete work order:", err);
      setError("工单删除失败。");
    }
  }

  const scopeText = scope ? scope.label : "全部范围";

  return (
    <main className="relative flex min-w-0 flex-1 bg-[var(--color-page-bg)] transition-colors">
      <section className="m-[var(--layout-content-padding)] flex min-h-0 flex-1 flex-col gap-[var(--layout-content-gap)] overflow-hidden rounded-[var(--layout-radius-xl)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] p-[var(--layout-content-padding)] shadow-[var(--shadow-panel)] transition-colors">
        <div className="flex shrink-0 items-center justify-between gap-[var(--layout-content-gap)]">
          <div className="flex min-w-0 items-center gap-[var(--layout-content-gap)]">
            <div className="min-w-0">
              <h1 className="whitespace-nowrap text-app-title font-bold text-[var(--color-text-main)]">工单管理</h1>
            </div>
            <div className="ml-[calc(var(--layout-content-padding)*2)] flex min-w-0 items-center gap-[var(--layout-search-gap)] text-ui-large text-[var(--color-text-muted)]">
              <MapPin size="var(--icon-search)" className="shrink-0 text-[var(--color-accent)]" />
              <span className="whitespace-nowrap">当前范围：</span>
              <span className="max-w-[28rem] truncate font-semibold text-[var(--color-text-main)]" title={scopeText}>{scopeText}</span>
              {scope && (
                <button type="button" onClick={() => setScope(null)} className="rounded-[var(--layout-radius-sm)] px-[var(--layout-tree-action-padding)] py-[var(--layout-tree-action-padding)] text-ui-small text-[var(--color-text-muted)] hover:bg-[var(--color-hover-bg)] hover:text-[var(--color-accent)]">
                  清除
                </button>
              )}
            </div>
          </div>

          <div className="flex min-w-0 flex-1 items-center justify-end gap-[var(--layout-search-gap)]">
            <div className="flex min-h-[var(--layout-search-height)] min-w-[18rem] items-center gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-lg)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)]">
              <Search size="var(--icon-search)" className="shrink-0 text-[var(--color-icon-muted)]" />
              <input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="搜索标题、对象、处理人"
                className="min-w-0 flex-1 bg-transparent text-ui-medium text-[var(--color-text-main)] outline-none placeholder:text-[var(--color-text-muted)]"
              />
            </div>
            <button type="button" onClick={fetchOrders} className="flex min-h-[var(--layout-search-height)] items-center gap-[var(--layout-reset-tooltip-gap)] rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)] text-ui-medium text-[var(--color-text-main)] hover:bg-[var(--color-hover-bg)] hover:text-[var(--color-accent)]">
              <RefreshCw size="var(--icon-bottom)" /> 刷新
            </button>
            <button type="button" onClick={openCreateForm} className="flex min-h-[var(--layout-search-height)] items-center gap-[var(--layout-reset-tooltip-gap)] rounded-[var(--layout-radius-md)] bg-[var(--color-topbar-active-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)] text-ui-medium font-semibold text-[var(--color-topbar-active-text)]">
              <FilePlus2 size="var(--icon-bottom)" /> 新建工单
            </button>
          </div>
        </div>

        <div className="grid shrink-0 grid-cols-4 gap-[var(--layout-content-gap)]">
          <MetricCard icon={ClipboardList} label="工单总数" value={metrics.total} />
          <MetricCard icon={ClipboardCheck} label="进行中" value={metrics.active} />
          <MetricCard icon={AlertCircle} label="紧急工单" value={metrics.urgent} tone={metrics.urgent ? "danger" : "normal"} />
          <MetricCard icon={Clock3} label="SLA 风险" value={metrics.risk} tone={metrics.risk ? "danger" : "normal"} />
        </div>

        <div className="flex shrink-0 items-center gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-content-padding)] py-[var(--layout-search-padding-y)]">
          <Filter size="var(--icon-search)" className="text-[var(--color-icon-muted)]" />
          <SelectInput value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            {statusOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </SelectInput>
          <SelectInput value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)}>
            {priorityOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </SelectInput>
          <SelectInput value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
            {typeOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </SelectInput>
          <span className="ml-auto whitespace-nowrap text-ui-small text-[var(--color-text-muted)]">双击左侧行政区或摄像机可限定工单范围</span>
        </div>

        {error && (
          <div className="flex shrink-0 items-center gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-md)] border border-[var(--color-error-text)] bg-[var(--color-error-bg)] px-[var(--layout-content-padding)] py-[var(--layout-search-padding-y)] text-ui-medium text-[var(--color-error-text)]">
            <AlertCircle size="var(--icon-search)" /> {error}
          </div>
        )}

        {selectedOrder ? (
          <WorkOrderDetail
            order={selectedOrder}
            onClose={() => setSelectedOrder(null)}
            onAdvance={handleAdvance}
            onEdit={openEditForm}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            {loading ? (
              <div className="flex h-full items-center justify-center gap-[var(--layout-search-gap)] text-ui-medium text-[var(--color-text-muted)]">
                <Loader2 size="var(--icon-search)" className="animate-spin" /> 正在加载工单...
              </div>
            ) : filteredOrders.length ? (
              <div className="grid grid-cols-3 gap-[var(--layout-content-gap)] pb-[var(--layout-tree-gap)]">
                {filteredOrders.map((order) => (
                  <WorkOrderCard
                    key={order.id}
                    order={order}
                    active={selectedOrder?.id === order.id}
                    onView={setSelectedOrder}
                    onAdvance={handleAdvance}
                    onEdit={openEditForm}
                    onDelete={handleDelete}
                  />
                ))}
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-[var(--layout-search-gap)] text-center text-[var(--color-text-muted)]">
                <CheckCircle2 size="var(--icon-logo)" className="text-[var(--color-accent)]" />
                <div className="text-ui-large font-semibold text-[var(--color-text-main)]">当前范围暂无工单</div>
                <div className="text-ui-medium">可以新建一张工单，或清除范围后查看全部工单。</div>
              </div>
            )}
          </div>
        )}
      </section>

      <WorkOrderForm
        open={formState.open}
        title={formState.mode === "edit" ? "编辑工单" : "新建工单"}
        form={formState.data}
        error={formState.error}
        entityOptions={entityOptions}
        onChange={(patch) => setFormState((prev) => ({ ...prev, data: { ...prev.data, ...patch }, error: "" }))}
        onSubmit={handleSubmitForm}
        onClose={() => setFormState((prev) => ({ ...prev, open: false, error: "" }))}
      />
    </main>
  );
}
