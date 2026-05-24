import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  RefreshCw,
  Star,
  StarOff,
  ChevronRight,
  ChevronDown,
  Folder,
  Plus,
  Trash2,
  Camera,
  Map,
  Database,
  Bell,
  BarChart3,
  Type,
  Moon,
  UserCircle,
  Loader2,
  AlertCircle,
  Network,
  Settings2,
  X,
  RotateCw,
  Check,
} from "lucide-react";
import MapView from "../../pages/MapView";
import DeviceManage from "../../pages/DeviceManage";
import VideoAlarmManage from "../../pages/VideoAlarmManage";
import StatisticsView from "../../pages/StatisticsView";


import {
  getNavTreeChildren,
  getNavTreeCameras,
  getNavTreeNode,
  searchNavTree,
} from "../../services/regionApi";
import { clearVideoDiagnosisHistory } from "../../services/diagnosisApi";
import {
  createGroup,
  getGroupTree,
  deleteGroup,
} from "../../services/groupApi";


const FAVORITES_STORAGE_KEY = "viot-favorite-region-nodes-v2";
const CUSTOM_FOLDERS_STORAGE_KEY = "viot-custom-camera-folders-v1";
const GROUP_CUSTOM_FOLDERS_STORAGE_KEY = "viot-group-custom-folders-v1";

function readGroupCustomFolders() {
  try {
    const stored = JSON.parse(localStorage.getItem(GROUP_CUSTOM_FOLDERS_STORAGE_KEY) || "{}");
    return Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, repairStoredNode(value)]));
  } catch { return {}; }
}

const COUNTRY_NODE_ID = "country-100000-cn";

const tabs = [
  { key: "map", label: "运维大屏", icon: Map },
  { key: "alarm", label: "异常告警", icon: Bell },
  { key: "device", label: "根因诊断", icon: Database },
  { key: "stats", label: "统计分析", icon: BarChart3 },
];

function looksLikeMojibake(value) {
  return /[\u0080-\u009fÃÂâæåçèéä¤¥]/.test(value);
}

function repairText(value) {
  if (typeof value !== "string" || !value || !looksLikeMojibake(value)) return value;

  const candidates = [value];
  try {
    const bytes = Uint8Array.from(value, (char) => char.charCodeAt(0));
    candidates.push(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    // 正常文本或不可逆文本保持原样。
  }

  const score = (text) => {
    const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const controls = (text.match(/[\u0080-\u009f]/g) || []).length;
    const markers = (text.match(/[ÃÂâæåçèéä�]/g) || []).length;
    return cjk * 5 - controls * 10 - markers * 3;
  };

  return candidates.sort((left, right) => score(right) - score(left))[0];
}

function repairStoredNode(node) {
  if (!node || typeof node !== "object") return node;
  return {
    ...node,
    name: repairText(node.name),
    regionName: repairText(node.regionName),
    raw: node.raw ? { ...node.raw, region_name: repairText(node.raw.region_name) } : node.raw,
    children: Array.isArray(node.children) ? node.children.map(repairStoredNode) : node.children,
  };
}

function readFavoriteNodes() {
  try {
    const stored = JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY) || "{}");
    return Object.fromEntries(
      Object.entries(stored).map(([key, value]) => [key, repairStoredNode(value)])
    );
  } catch {
    return {};
  }
}

function readCustomFolders() {
  try {
    const stored = JSON.parse(localStorage.getItem(CUSTOM_FOLDERS_STORAGE_KEY) || "{}");
    return Object.fromEntries(
      Object.entries(stored).map(([key, value]) => [key, repairStoredNode(value)])
    );
  } catch {
    return {};
  }
}

function normalizeCameraForCustomFolder(camera) {
  return {
    ...camera,
    id: camera.id || `camera-${camera.cameraId || camera.camera_id}`,
    nodeType: "camera",
    cameraId: camera.cameraId || camera.camera_id || camera.id?.replace(/^camera-/, "") || "",
    name: repairText(camera.name || camera.regionName || camera.cameraName || "未命名摄像机"),
    children: [],
    loaded: true,
    isLeaf: true,
  };
}

function makeCustomFolderNode({ id, name, regionCode, regionName, children = [] }) {
  const normalizedChildren = children.map(normalizeCameraForCustomFolder);
  const online = normalizedChildren.filter((camera) => camera.status !== "offline").length;
  return {
    id,
    nodeType: "custom_folder",
    regionCode,
    parentCode: regionCode,
    name: repairText(name || "自定义文件夹"),
    regionName: repairText(regionName || ""),
    level: "custom_folder",
    children: normalizedChildren,
    loaded: true,
    isLeaf: normalizedChildren.length === 0,
    online,
    total: normalizedChildren.length,
  };
}

function buildGroupNode(group) {
  const subGroups = (group.children || []).map(buildGroupNode);
  const rawCameras = (group.cameras || []).map(normalizeCameraForCustomFolder);

  // 【新增】递归收集该分组下所有的摄像机列表，方便传递给右侧面板联动
  const flatCameras = [...rawCameras];
  subGroups.forEach(sg => flatCameras.push(...(sg.flatCameras || [])));

  const onlineCameras = rawCameras.filter((c) => c.status !== "offline").length;
  const onlineSub = subGroups.reduce((acc, g) => acc + (g.online || 0), 0);

  // 【修复】彻底使用 window.Map 避免与 lucide-react 的 Map 图标组件冲突
  const countyMap = new window.Map();

  rawCameras.forEach(cam => {
    const countyCode = cam.county_code || cam.countyCode || 'unknown_county';
    const countyName = cam.county_name || cam.countyName || '未知区县';
    const townCode = cam.town_code || cam.townCode || 'unknown_town';
    const townName = cam.town_name || cam.townName || '未知街道';

    if (!countyMap.has(countyCode)) {
      countyMap.set(countyCode, {
        id: `virtual-county-${group.id}-${countyCode}`,
        nodeType: "region",
        level: "county",
        name: countyName,
        regionCode: countyCode, // 【修复】补上至关重要的 regionCode
        // 【修复】内部子字典也需要使用 window.Map
        childrenMap: new window.Map(),
        cameras: [],
        online: 0,
        total: 0
      });
    }

    const countyNode = countyMap.get(countyCode);
    countyNode.total += 1;
    if (cam.status !== 'offline') countyNode.online += 1;

    if (!countyNode.childrenMap.has(townCode)) {
      countyNode.childrenMap.set(townCode, {
        id: `virtual-town-${group.id}-${townCode}`,
        nodeType: "region",
        level: "town",
        name: townName,
        regionCode: townCode, // 【修复】补上至关重要的 regionCode
        cameras: [],
        online: 0,
        total: 0
      });
    }

    const townNode = countyNode.childrenMap.get(townCode);
    townNode.total += 1;
    if (cam.status !== 'offline') townNode.online += 1;

    townNode.cameras.push(cam);
  });

  const virtualRegionNodes = Array.from(countyMap.values()).map(county => {
    const townNodes = Array.from(county.childrenMap.values()).map(town => {
      return {
        id: town.id,
        nodeType: "region",
        level: "town",
        name: town.name,
        regionCode: town.regionCode, // 【修复】映射 regionCode
        online: town.online,
        total: town.total,
        isLeaf: false,
        loaded: true,
        children: town.cameras
      };
    });

    return {
      id: county.id,
      nodeType: "region",
      level: "county",
      name: county.name,
      regionCode: county.regionCode, // 【修复】映射 regionCode
      online: county.online,
      total: county.total,
      isLeaf: false,
      loaded: true,
      children: townNodes
    };
  });

  return {
    id: `group-${group.id}`,
    rawId: group.id,
    nodeType: "group",
    name: repairText(group.name || "未命名分组"),
    level: "group",
    children: [...subGroups, ...virtualRegionNodes],
    flatCameras, // 【新增】将拍平后的摄像机暴露给外部
    loaded: true,
    isLeaf: subGroups.length === 0 && virtualRegionNodes.length === 0,
    online: onlineCameras + onlineSub,
    total: group.camera_count ?? (rawCameras.length + subGroups.reduce((acc, g) => acc + (g.total || 0), 0)),
    raw: group,
  };
}


function makeNodeId(item) {
  if (item.node_type === "camera") {
    return `camera-${item.camera_id || item.id}`;
  }

  return item.region_code || item.id;
}

function buildNode(item) {
  const nodeType = item.node_type || "region";
  const isCamera = nodeType === "camera";
  const isTown = item.level === "town";
  const displayName = repairText(item.region_name || item.name || "未命名节点");

  const children = (item.children || []).map(buildNode);

  return {
    id: makeNodeId(item),
    nodeType,
    cameraId: item.camera_id || "",
    regionCode: item.region_code || "",
    adcode: item.amap_adcode || item.official_code || "",
    citycode: item.amap_citycode || "",
    name: displayName,
    level: item.level || (isCamera ? "camera" : "unknown"),
    center: item.center || "",
    longitude: item.longitude,
    latitude: item.latitude,
    status: item.status || "",
    online: item.online || 0,
    total: item.total || 0,
    children,
    loaded: isCamera || children.length > 0,
    isLeaf: isCamera || (isTown && Number(item.total || 0) === 0),
    raw: item,
  };
}

async function fetchRootRegions(statusFilter = "all", options = {}) {
  const provinces = await getNavTreeChildren(null, statusFilter, options);
  return provinces.map(buildNode);
}

async function fetchRegionChildren(node, statusFilter = "all", options = {}) {
  if (node.nodeType === "camera") return [];

  if (node.level === "town") {
    const cameras = await getNavTreeCameras(node.regionCode, {
      status_filter: statusFilter,
      signal: options.signal,
    });
    return cameras.map(buildNode);
  }

  const children = await getNavTreeChildren(node.regionCode, statusFilter, options);
  return children.map(buildNode);
}

async function searchDistrict(keyword, statusFilter = "all") {
  const result = await searchNavTree(keyword, statusFilter);
  return result.map(buildNode);
}


function cameraMatchesStatusFilter(node, statusFilter) {
  if (node.nodeType !== "camera") return true;

  if (statusFilter === "all") return true;
  if (statusFilter === "normal") return node.status === "online";
  if (statusFilter === "fault") return node.status === "fault";
  if (statusFilter === "offline") return node.status === "offline";

  return true;
}

function filterFavoriteNodeByStatus(node, statusFilter) {
  if (node.nodeType === "camera") {
    return cameraMatchesStatusFilter(node, statusFilter) ? node : null;
  }

  const children = (node.children || [])
    .map((child) => filterFavoriteNodeByStatus(child, statusFilter))
    .filter(Boolean);

  return {
    ...node,
    children,
    loaded: node.loaded,
  };
}





function filterTree(nodes, keyword) {
  if (!keyword.trim()) return nodes;
  const lower = keyword.trim().toLowerCase();
  return nodes
    .map((node) => {
      const children = filterTree(node.children || [], keyword);
      const matched =
        node.name.toLowerCase().includes(lower) ||
        node.adcode.includes(lower) ||
        String(node.total).includes(lower) ||
        String(node.online).includes(lower);
      if (matched || children.length) return { ...node, children };
      return null;
    })
    .filter(Boolean);
}

function updateTreeNode(nodes, targetId, updater) {
  return nodes.map((node) => {
    if (node.id === targetId) return updater(node);
    if (node.children?.length) {
      return { ...node, children: updateTreeNode(node.children, targetId, updater) };
    }
    return node;
  });
}

function updateFavoriteNodes(favoriteNodes, targetId, updater) {
  const next = {};
  Object.entries(favoriteNodes).forEach(([id, node]) => {
    next[id] = updateTreeNode([node], targetId, updater)[0];
  });
  return next;
}


function toFavoriteNode(node) {
  const isCamera = node.nodeType === "camera";
  const isCustomFolder = node.nodeType === "custom_folder";
  const displayName = repairText(node.name || node.raw?.region_name || node.raw?.name || "未命名节点");

  return {
    id: node.id,
    nodeType: node.nodeType || "region",
    cameraId: node.cameraId || "",
    regionCode: node.regionCode || "",
    adcode: node.adcode || "",
    citycode: node.citycode || "",
    name: displayName,
    level: node.level || (isCamera ? "camera" : "unknown"),
    center: node.center || "",
    longitude: node.longitude,
    latitude: node.latitude,
    status: node.status || "",
    online: Number(node.online || 0),
    total: Number(node.total || 0),

    // 行政区收藏运行时按需加载 children；自定义文件夹需要保留手动加入的摄像机。
    children: isCustomFolder ? (node.children || []).map(normalizeCameraForCustomFolder) : [],
    loaded: isCamera || isCustomFolder,
    isLeaf: isCamera || (isCustomFolder ? false : node.isLeaf),

    // raw 字段供功能页透传行政区和摄像机上下文，避免把展示树结构耦合到业务页。
    raw: {
      node_type: node.nodeType || "region",
      camera_id: node.cameraId || "",
      region_code: node.regionCode || "",
      region_name: displayName || "",
      level: node.level || "",
      status: node.status || "",
      longitude: node.longitude,
      latitude: node.latitude,
      online: Number(node.online || 0),
      total: Number(node.total || 0),
    },
  };
}



function refreshFavoriteNodeStats(favoriteNodes, latestRootNodes) {
  const latestMap = new window.Map();

  function collect(nodes) {
    nodes.forEach((node) => {
      latestMap.set(node.id, node);
      if (node.children?.length) {
        collect(node.children);
      }
    });
  }

  collect(latestRootNodes);

  const next = {};

  Object.entries(favoriteNodes).forEach(([id, node]) => {
    const latest = latestMap.get(id);

    next[id] = latest
      ? {
          ...node,
          online: latest.online,
          total: latest.total,
          status: latest.status,
          raw: latest.raw,
        }
      : node;
  });

  return next;
}

function attachCustomFoldersToTree(nodes, customFolders) {
  const folders = Object.values(customFolders);
  if (!folders.length) return nodes;

  return nodes.map((node) => {
    const children = Array.isArray(node.children)
      ? attachCustomFoldersToTree(node.children, customFolders)
      : [];

    if (node.level !== "town") {
      return { ...node, children };
    }

    const folderChildren = folders
      .filter((folder) => folder.regionCode === node.regionCode)
      .map(makeCustomFolderNode);

    return {
      ...node,
      children: [...folderChildren, ...children],
      loaded: node.loaded,
      isLeaf: false,
    };
  });
}


function TopBar({ activeTab, onTabChange, onFontSizeToggle, onThemeToggle, darkMode }) {
  return (
    <header className="h-[var(--layout-topbar-height)] shrink-0 border-b border-[var(--color-panel-border)] bg-[var(--color-topbar-bg)] px-[var(--layout-topbar-padding-x)] shadow-[var(--shadow-panel)] transition-colors">
      <div className="flex h-full items-center justify-between gap-[var(--layout-topbar-gap)]">

        <div className="flex min-w-[var(--layout-title-width-aligned)] shrink-0 items-center gap-[var(--layout-title-gap)] border-r border-[var(--color-topbar-divider)] pr-[var(--layout-topbar-gap)] overflow-hidden text-app-title font-bold leading-none tracking-tight text-white">
          <Network
            size="var(--icon-logo)"
            className={`shrink-0 ${darkMode ? "text-[var(--color-accent)]" : "text-white"}`}
          />
          <span>视联网智能运维平台</span>
        </div>

        <nav className="flex flex-1 items-center justify-start gap-[var(--layout-tab-gap)]">
          {tabs.map(({ key, label, icon: Icon }) => {
            const isActive = activeTab === key;
            return (
              <button
                key={key}
                onClick={() => onTabChange(key)}
                className={`flex min-h-[var(--layout-tab-height)] items-center gap-[var(--layout-tab-inner-gap)] rounded-[var(--layout-radius-lg)] px-[var(--layout-tab-padding-x)] py-[var(--layout-tab-padding-y)] text-ui-large font-bold transition-colors ${
                  isActive
                    ? "bg-[var(--color-topbar-active-bg)] text-[var(--color-topbar-active-text)] shadow-sm"
                    : "text-[var(--color-topbar-text)] hover:bg-[var(--color-topbar-hover-bg)] hover:text-[var(--color-topbar-hover-text)]"
                }`}
              >
                <Icon size="var(--icon-tab)" />
                {label}
              </button>
            );
          })}
        </nav>

        <div className="flex min-w-[var(--layout-topbar-actions-width)] items-center justify-end gap-[var(--layout-topbar-action-gap)] text-[var(--color-topbar-text)]">
          <button
            onClick={onFontSizeToggle}
            title="点击切换字体大小"
            className="rounded-[var(--layout-radius-lg)] p-[var(--layout-icon-button-padding)] transition-colors hover:bg-[var(--color-topbar-hover-bg)] hover:text-[var(--color-topbar-hover-text)]"
          >
            <Type size="var(--icon-topbar)" />
          </button>
          <button
            onClick={onThemeToggle}
            title={darkMode ? "切换浅色模式" : "切换深色模式"}
            className="rounded-[var(--layout-radius-lg)] p-[var(--layout-icon-button-padding)] transition-colors hover:bg-[var(--color-topbar-hover-bg)] hover:text-[var(--color-topbar-hover-text)]"
          >
            <Moon size="var(--icon-topbar)" />
          </button>
          <button
            title="用户"
            className="rounded-[var(--layout-radius-lg)] p-[var(--layout-icon-button-padding)] transition-colors hover:bg-[var(--color-topbar-hover-bg)] hover:text-[var(--color-topbar-hover-text)]"
          >
            <UserCircle size="var(--icon-user)" />
          </button>
        </div>
      </div>
    </header>
  );
}


function getCameraStatusText(status) {
  if (status === "offline") return "离线";
  if (status === "fault") return "异常";
  return "正常";
}

function getCameraStatusBadgeClass(status) {
  if (status === "offline") {
    return "border-[var(--color-panel-border)] bg-[var(--color-control-bg)] text-[var(--color-text-muted)]";
  }

  if (status === "fault") {
    return "border-[var(--color-error-text)] bg-[var(--color-error-bg)] text-[var(--color-error-text)]";
  }

  return "border-[var(--color-accent)] bg-[var(--color-hover-bg)] text-[var(--color-accent)]";
}


function CreateGroupModal({ onClose, onSubmit }) {
  const [name, setName] = useState("");
  const [selectedCameraIds, setSelectedCameraIds] = useState([]);
  const [regionTree, setRegionTree] = useState([]);
  const [loadingTree, setLoadingTree] = useState(true);
  const [expandedRegions, setExpandedRegions] = useState(new Set());
  const [loadingNodeId, setLoadingNodeId] = useState("");
  const loadedNodesRef = useRef(new Set());
  const [fetchingRegionId, setFetchingRegionId] = useState("");
  const cameraMap = useRef(new window.Map());

  useEffect(() => {
    const loadTree = async () => {
      try {
        const provinces = await getNavTreeChildren(null);
        setRegionTree(provinces);
        setLoadingTree(false);
      } catch {
        setLoadingTree(false);
      }
    };
    loadTree();
  }, []);

  const toggleCamera = (cameraId) => {
    setSelectedCameraIds((prev) =>
      prev.includes(cameraId) ? prev.filter((id) => id !== cameraId) : [...prev, cameraId]
    );
  };

  const updateTreeNode = (nodes, regionCode, updater) => {
    return nodes.map((node) => {
      if (node.region_code === regionCode) {
        return updater(node);
      }
      if (node.children && node.children.length > 0) {
        return { ...node, children: updateTreeNode(node.children, regionCode, updater) };
      }
      return node;
    });
  };

  const toggleExpand = async (node) => {
    const isExpanded = expandedRegions.has(node.region_code);
    setExpandedRegions((prev) => {
      const next = new Set(prev);
      if (isExpanded) next.delete(node.region_code);
      else next.add(node.region_code);
      return next;
    });

    if (!isExpanded && !loadedNodesRef.current.has(node.region_code)) {
      setLoadingNodeId(node.region_code);
      try {
        let children = [];
        if (node.level === "town") {
          const cameras = await getNavTreeCameras(node.region_code);
          cameras.forEach(c => cameraMap.current.set(c.id || c.camera_id, c));
          children = cameras;
        } else {
          children = await getNavTreeChildren(node.region_code);
        }
        loadedNodesRef.current.add(node.region_code);
        setRegionTree((prev) =>
          updateTreeNode(prev, node.region_code, (n) => ({ ...n, children }))
        );
      } catch {
        // ignore
      } finally {
        setLoadingNodeId("");
      }
    }
  };

  const getCameraCheckState = (node) => {
    if (node.node_type === "camera") {
      const isSelected = selectedCameraIds.includes(node.id);
      return { checked: isSelected, indeterminate: false, count: isSelected ? 1 : 0 };
    }

    const total = node.total || 0;
    if (total === 0) return { checked: false, indeterminate: false, count: 0 };

    let selectedCount = 0;
    for (const id of selectedCameraIds) {
      const cam = cameraMap.current.get(id);
      if (cam) {
        const code = node.region_code;
        if (
          cam.town_code === code ||
          cam.county_code === code ||
          cam.city_code === code ||
          cam.province_code === code ||
          cam.region_code === code
        ) {
          selectedCount++;
        }
      }
    }

    return {
      checked: selectedCount > 0 && selectedCount >= total,
      indeterminate: selectedCount > 0 && selectedCount < total,
      count: selectedCount,
    };
  };

  const toggleRegionSelect = async (node) => {
    if (node.node_type === "camera") {
      toggleCamera(node.id);
      return;
    }

    if (node.total === 0) return;

    setFetchingRegionId(node.region_code);
    try {
      const cameras = await getNavTreeCameras(node.region_code, { limit: 5000 });
      const cameraIds = [];
      cameras.forEach((c) => {
        const id = c.id || c.camera_id;
        cameraMap.current.set(id, c);
        cameraIds.push(id);
      });

      setSelectedCameraIds((prev) => {
        const prevSet = new Set(prev);
        const allSelected = cameraIds.every((id) => prevSet.has(id));
        if (allSelected) {
          cameraIds.forEach((id) => prevSet.delete(id));
        } else {
          cameraIds.forEach((id) => prevSet.add(id));
        }
        return [...prevSet];
      });
    } catch (err) {
      console.error("加载行政区摄像机失败:", err);
    } finally {
      setFetchingRegionId("");
    }
  };

  const handleSubmit = () => {
    if (!name.trim()) return;
    onSubmit(name.trim(), selectedCameraIds);
  };

  const renderRegionNode = (node, depth = 0) => {
    const isExpanded = expandedRegions.has(node.region_code);
    const isTown = node.level === "town";
    const canExpand = !isTown || node.total > 0;
    const regionState = getCameraCheckState(node);

    return (
      <div key={node.region_code}>
        <div
          className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-[var(--color-hover-bg)]"
          style={{ paddingLeft: depth * 16 }}
        >
          {canExpand ? (
            <button
              onClick={() => toggleExpand(node)}
              className="shrink-0 p-[2px] text-[var(--color-icon-muted)]"
            >
              {loadingNodeId === node.region_code ? (
                <Loader2 size="var(--icon-tree-toggle)" className="animate-spin" />
              ) : isExpanded ? (
                <ChevronDown size="var(--icon-tree-toggle)" />
              ) : (
                <ChevronRight size="var(--icon-tree-toggle)" />
              )}
            </button>
          ) : (
            <span className="w-[var(--icon-tree-toggle)] shrink-0" />
          )}

          <button
            onClick={() => toggleRegionSelect(node)}
            className="shrink-0 p-[2px]"
            disabled={fetchingRegionId === node.region_code}
          >
            {fetchingRegionId === node.region_code ? (
              <Loader2 size="var(--icon-tree-action)" className="animate-spin text-[var(--color-icon-muted)]" />
            ) : regionState.checked ? (
              <Check size="var(--icon-tree-action)" className="text-[var(--color-accent)]" />
            ) : regionState.indeterminate ? (
              <span className="flex h-[14px] w-[14px] items-center justify-center rounded border border-[var(--color-accent)] bg-[var(--color-accent)]">
                <span className="h-[6px] w-[6px] bg-white" />
              </span>
            ) : (
              <span className="inline-block h-[14px] w-[14px] rounded border border-[var(--color-panel-border)]" />
            )}
          </button>

          {isTown ? (
            <Folder size="var(--icon-tree-node)" className="shrink-0 text-[var(--color-accent)]" />
          ) : (
            <Folder size="var(--icon-tree-node)" className="shrink-0 text-[var(--color-icon-muted)]" />
          )}

          <span className="min-w-0 flex-1 truncate text-ui-small text-[var(--color-text-main)]">
            {node.region_name}
          </span>

          {!isTown && (
            <span className="shrink-0 text-ui-small text-[var(--color-text-muted)]">
              ({node.online}/{node.total})
            </span>
          )}
        </div>

        {isExpanded && node.children && (
          <div>
            {isTown
              ? node.children.map((camera) => (
                  <div
                    key={camera.id}
                    className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-[var(--color-hover-bg)]"
                    style={{ paddingLeft: (depth + 1) * 16 + 20 }}
                  >
                    <button
                      onClick={() => toggleCamera(camera.id)}
                      className="shrink-0 p-[2px]"
                    >
                      {selectedCameraIds.includes(camera.id) ? (
                        <Check size="var(--icon-tree-action)" className="text-[var(--color-accent)]" />
                      ) : (
                        <span className="inline-block h-[14px] w-[14px] rounded border border-[var(--color-panel-border)]" />
                      )}
                    </button>
                    <Camera size="var(--icon-tree-node)" className="shrink-0 text-[var(--color-icon-muted)]" />
                    <span className="min-w-0 flex-1 truncate text-ui-small text-[var(--color-text-main)]">
                      {camera.name}
                    </span>
                    <span className={`shrink-0 text-ui-small ${getCameraStatusBadgeClass(camera.status)}`}>
                      {getCameraStatusText(camera.status)}
                    </span>
                  </div>
                ))
              : node.children.map((child) => (
                  <div key={child.region_code}>
                    {renderRegionNode(child, depth + 1)}
                  </div>
                ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="flex w-[var(--layout-sidebar-width)] max-w-[600px] flex-col rounded-lg bg-[var(--color-panel-bg)] shadow-lg" style={{ maxHeight: "80vh" }}>
        <div className="flex items-center justify-between border-b border-[var(--color-panel-border)] px-4 py-3">
          <h3 className="text-ui-large font-medium text-[var(--color-text-main)]">新建分组</h3>
          <button onClick={onClose} className="text-[var(--color-icon-muted)] hover:text-[var(--color-text-main)]">
            <X size="var(--icon-tab)" />
          </button>
        </div>

        <div className="px-4 py-3">
          <label className="mb-1 block text-ui-small text-[var(--color-text-muted)]">分组名称</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="请输入分组名称"
            className="w-full rounded border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-3 py-2 text-ui-medium text-[var(--color-text-main)] outline-none focus:border-[var(--color-accent)]"
          />
        </div>

        <div className="px-4 pb-1">
          <label className="mb-1 block text-ui-small text-[var(--color-text-muted)]">
            选择摄像机 {selectedCameraIds.length > 0 && `（已选 ${selectedCameraIds.length} 台）`}
          </label>
        </div>

        <div className="flex-1 overflow-auto border-t border-[var(--color-panel-border)] px-4 py-2">
          {loadingTree ? (
            <div className="flex items-center justify-center py-4 text-ui-medium text-[var(--color-text-muted)]">
              <Loader2 size="var(--icon-search)" className="animate-spin" /> <span className="ml-2">加载中...</span>
            </div>
          ) : regionTree.length > 0 ? (
            <div className="space-y-1">
              {regionTree.map((node) => renderRegionNode(node))}
            </div>
          ) : (
            <div className="py-4 text-center text-ui-medium text-[var(--color-text-muted)]">暂无数据</div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--color-panel-border)] px-4 py-3">
          <button
            onClick={onClose}
            className="rounded px-4 py-2 text-ui-medium text-[var(--color-text-muted)] hover:bg-[var(--color-hover-bg)]"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim()}
            className="rounded bg-[var(--color-accent)] px-4 py-2 text-ui-medium text-white disabled:opacity-50 hover:opacity-90"
          >
            确认创建
          </button>
        </div>
      </div>
    </div>
  );
}


function TreeNode({
  node,
  depth = 0,
  favoriteIds,
  previewingCameraIds,
  loadingNodeId,
  expandedNodeIds,
  onSetExpanded,
  onToggleFavorite,
  onLoadChildren,
  onRefreshNode,
  onCameraDoubleClick,
  onNodeDoubleClick,
  onCreateCustomFolder,
  onDeleteCustomFolder,
  onDropCameraToCustomFolder,
  onRemoveCameraFromCustomFolder,
  parentCustomFolderId = "",
  onDeleteGroup,
}) {
  const isLoading = loadingNodeId === node.id;
  const isCamera = node.nodeType === "camera";
  const isCustomFolder = node.nodeType === "custom_folder";
  const isGroup = node.nodeType === "group";
  const isLeaf = node.isLeaf || isCamera;
  const open = expandedNodeIds.has(node.id);
  const canExpand = !isLeaf && (node.children?.length > 0 || !node.loaded);
  const isFavorite = favoriteIds.has(node.id);
  const isPreviewing = isCamera && previewingCameraIds.has(node.cameraId);

  const cameraIconClass =
    node.status === "offline"
      ? "text-[var(--color-icon-muted)]"
      : node.status === "fault"
        ? "text-[var(--color-error-text)]"
        : "text-[var(--color-accent)]";


  const handleExpand = async () => {
    if (!canExpand) return;

    if (open) {
      onSetExpanded(node.id, false);
      return;
    }

    if (!node.loaded) {
      await onLoadChildren(node);
    }

    onSetExpanded(node.id, true);
  };

  const handleRefresh = async (event) => {
    event.stopPropagation();
    if (isLeaf) return;
    await onRefreshNode(node);
    onSetExpanded(node.id, true);
  };

  return (
    <div>
      <div
        draggable={isCamera}
        className={`group flex min-h-[var(--layout-tree-row-height)] items-center rounded-[var(--layout-radius-md)] pr-[var(--layout-tree-padding-right)] text-ui-medium transition-colors ${
          isPreviewing
            ? "bg-[var(--color-hover-bg)] text-emerald-500"
            : open && canExpand
            ? "bg-[var(--color-hover-bg)] text-[var(--color-accent)]"
            : "text-[var(--color-text-main)] hover:bg-[var(--color-hover-bg)]"
        }`}
        style={{ paddingLeft: `calc(var(--layout-tree-indent-base) + ${depth} * var(--layout-tree-indent-step))` }}
        onDragStart={(event) => {
          if (!isCamera) return;
          event.dataTransfer.effectAllowed = "copy";
          event.dataTransfer.setData("application/x-viot-camera", JSON.stringify({
            ...normalizeCameraForCustomFolder(node),
            sourceCustomFolderId: parentCustomFolderId,
          }));
        }}
        onDragOver={(event) => {
          if (!isCustomFolder) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          if (!isCustomFolder) return;
          event.preventDefault();
          event.stopPropagation();
          const raw = event.dataTransfer.getData("application/x-viot-camera");
          if (!raw) return;
          try {
            const camera = JSON.parse(raw);
            onDropCameraToCustomFolder?.(node, camera);
          } catch (error) {
            console.error("Failed to parse dropped camera:", error);
          }
        }}
        onDragEnd={(event) => {
          if (!isCamera || !parentCustomFolderId) return;
          onRemoveCameraFromCustomFolder?.(parentCustomFolderId, normalizeCameraForCustomFolder(node));
        }}
        onDoubleClick={() => {
          onNodeDoubleClick?.(node);

          if (isCamera) {
            onCameraDoubleClick(node);
          }
        }}
      >
        {isCamera ? (
          <span
            className={`mr-[var(--layout-tree-icon-gap)] flex h-[var(--layout-tree-button-size)] shrink-0 items-center justify-center rounded-[var(--layout-radius-sm)] border px-[var(--layout-tree-action-padding)] text-ui-small ${getCameraStatusBadgeClass(
              node.status
            )}`}
          >
            {getCameraStatusText(node.status)}
          </span>
        ) : (
          <button
            className="mr-[var(--layout-tree-icon-gap)] flex h-[var(--layout-tree-button-size)] w-[var(--layout-tree-button-size)] shrink-0 items-center justify-center rounded-[var(--layout-radius-sm)] text-[var(--color-icon-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-accent)]"
            onClick={handleExpand}
          >
            {isLoading ? (
              <Loader2 size="var(--icon-tree-toggle)" className="animate-spin" />
            ) : canExpand ? (
              open ? (
                <ChevronDown size="var(--icon-tree-toggle)" />
              ) : (
                <ChevronRight size="var(--icon-tree-toggle)" />
              )
            ) : (
              <span className="inline-block h-[var(--icon-tree-toggle)] w-[var(--icon-tree-toggle)]" />
            )}
          </button>
        )}

        {isCamera ? (
          <Camera
            size="var(--icon-tree-main)"
            className={`mr-[var(--layout-tree-icon-gap)] shrink-0 ${cameraIconClass}`}
          />
        ) : (
          <Folder
            size="var(--icon-tree-main)"
            className={`mr-[var(--layout-tree-icon-gap)] shrink-0 ${
              open && canExpand ? "text-[var(--color-accent)]" : "text-[var(--color-icon-muted)]"
            }`}
          />
        )}

        <span
          className={`shrink-0 whitespace-nowrap ${isPreviewing ? "text-emerald-500" : ""}`}
          title={`${node.name} ${node.adcode}`}
        >
          {isPreviewing ? `预览中-${node.name}` : node.name}
          {!isCamera && (
            <span className="text-[var(--color-text-muted)]">
              {" "}({node.online}/{node.total})
            </span>
          )}
        </span> 

        {!isLeaf && (
          <button
            title="刷新"
            onClick={handleRefresh}
            className="ml-[var(--layout-tree-action-gap)] hidden rounded-[var(--layout-radius-sm)] p-[var(--layout-tree-action-padding)] text-[var(--color-icon-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-accent)] group-hover:block"
          >
            <RefreshCw size="var(--icon-tree-action)" />
          </button>
          
        )}
        {node.level === "town" && (
          <button
            title="新建自定义文件夹"
            onClick={(event) => {
              event.stopPropagation();
              onCreateCustomFolder?.(node);
            }}
            className="ml-[var(--layout-tree-action-gap)] hidden rounded-[var(--layout-radius-sm)] p-[var(--layout-tree-action-padding)] text-[var(--color-icon-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-accent)] group-hover:block"
          >
            <Plus size="var(--icon-tree-action)" />
          </button>
        )}
        {isCustomFolder && (
          <button
            title="删除自定义文件夹"
            onClick={(event) => {
              event.stopPropagation();
              onDeleteCustomFolder?.(node);
            }}
            className="ml-[var(--layout-tree-action-gap)] hidden rounded-[var(--layout-radius-sm)] p-[var(--layout-tree-action-padding)] text-[var(--color-icon-muted)] transition-colors hover:bg-[var(--color-error-bg)] hover:text-[var(--color-error-text)] group-hover:block"
          >
            <Trash2 size="var(--icon-tree-action)" />
          </button>
        )}
        {isGroup && (
          <button
            title="删除分组"
            onClick={(event) => {
              event.stopPropagation();
              onDeleteGroup?.(node);
            }}
            className="ml-[var(--layout-tree-action-gap)] hidden rounded-[var(--layout-radius-sm)] p-[var(--layout-tree-action-padding)] text-[var(--color-icon-muted)] transition-colors hover:bg-[var(--color-error-bg)] hover:text-[var(--color-error-text)] group-hover:block"
          >
            <Trash2 size="var(--icon-tree-action)" />
          </button>
        )}
        {!isGroup && (
          <button
            title={isFavorite ? "取消收藏" : "收藏"}
            onClick={(event) => {
              event.stopPropagation();
              onToggleFavorite(node);
            }}
            className="ml-[var(--layout-tree-action-gap)] rounded-[var(--layout-radius-sm)] p-[var(--layout-tree-action-padding)] text-[var(--color-icon-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-accent)] group-hover:block"
          >
            {isFavorite ? <Star size="var(--icon-tree-action)" className="fill-current text-[var(--color-accent)]" /> : <StarOff size="var(--icon-tree-action)" />}
          </button>
        )}
      </div>

      {node.children?.length > 0 && open && (
        <div className="space-y-[var(--layout-tree-gap)]" style={{ marginTop: "var(--layout-tree-parent-child-gap, 0.15rem)" }}>
          {node.children.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              favoriteIds={favoriteIds}
              previewingCameraIds={previewingCameraIds}
              loadingNodeId={loadingNodeId}
              expandedNodeIds={expandedNodeIds}
              onSetExpanded={onSetExpanded}
              onToggleFavorite={onToggleFavorite}
              onLoadChildren={onLoadChildren}
              onRefreshNode={onRefreshNode}
              onCameraDoubleClick={onCameraDoubleClick}
              onNodeDoubleClick={onNodeDoubleClick}
              onCreateCustomFolder={onCreateCustomFolder}
              onDeleteCustomFolder={onDeleteCustomFolder}
              onDropCameraToCustomFolder={onDropCameraToCustomFolder}
              onRemoveCameraFromCustomFolder={onRemoveCameraFromCustomFolder}
              parentCustomFolderId={isCustomFolder ? node.id : parentCustomFolderId}
              onDeleteGroup={onDeleteGroup}
            />
          ))}
        </div>
      )}
    </div>
  );
}








function Sidebar({
  resetVersion,
  sidebarWidth,
  setSidebarWidth,
  previewingCameraIds,
  onCameraDoubleClick,
  onNodeDoubleClick,
}) {
  const [mode, setMode] = useState("group");
  const [keyword, setKeyword] = useState("");
  const [tree, setTree] = useState([]);
  const [favoriteNodes, setFavoriteNodes] = useState(readFavoriteNodes);
  const [customFolders, setCustomFolders] = useState(readCustomFolders);
  const [groupCustomFolders, setGroupCustomFolders] = useState(readGroupCustomFolders);
  const [loadingRoot, setLoadingRoot] = useState(false);
  const [loadingNodeId, setLoadingNodeId] = useState("");
  const [error, setError] = useState("");
  const [searchMode, setSearchMode] = useState(false);
  const [cameraStatusFilter, setCameraStatusFilter] = useState("all");
  const [favoriteDisplayNodes, setFavoriteDisplayNodes] = useState([]);
  const [groupTree, setGroupTree] = useState([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);


  const [expandedNodeIds, setExpandedNodeIds] = useState(() => new Set([COUNTRY_NODE_ID]));
  const expandedNodeIdsRef = useRef(expandedNodeIds);
  const navRefreshSeqRef = useRef(0);
  const navRefreshAbortRef = useRef(null);
  const favoriteRefreshSeqRef = useRef(0);
  const favoriteRefreshAbortRef = useRef(null);

  useEffect(() => {
    expandedNodeIdsRef.current = expandedNodeIds;
  }, [expandedNodeIds]);

  const setNodeExpanded = (nodeId, expanded) => {
    setExpandedNodeIds((prev) => {
      const next = new Set(prev);

      if (expanded) {
        next.add(nodeId);
      } else {
        next.delete(nodeId);
      }

      return next;
    });
  };



  const nextSidebarNavRefreshSeq = () => {
    navRefreshAbortRef.current?.abort();
    navRefreshAbortRef.current = new AbortController();
    navRefreshSeqRef.current += 1;
    return {
      seq: navRefreshSeqRef.current,
      signal: navRefreshAbortRef.current.signal,
    };
  };

  const isCanceledRequest = (error) =>
    error?.code === "ERR_CANCELED" || error?.name === "CanceledError";

  const nextFavoriteRefresh = () => {
    favoriteRefreshAbortRef.current?.abort();
    favoriteRefreshAbortRef.current = new AbortController();
    favoriteRefreshSeqRef.current += 1;
    return {
      seq: favoriteRefreshSeqRef.current,
      signal: favoriteRefreshAbortRef.current.signal,
    };
  };

  const favoriteIds = useMemo(() => new Set(Object.keys(favoriteNodes)), [favoriteNodes]);

  const sidebarRef = useRef(null);
  const resizeStartRef = useRef({
    startX: 0,
    startWidth: 0,
    minWidth: 0,
    maxWidth: 0,
  });


  const [resizing, setResizing] = useState(false);


  useEffect(() => {
    setSidebarWidth(null);
  }, [resetVersion]);

  useEffect(() => {
    if (mode === "favorite" || mode === "group") return;

    const timer = window.setTimeout(() => {
      refreshRegionTreeKeepExpanded(cameraStatusFilter);
    }, 180);

    return () => {
      window.clearTimeout(timer);
      navRefreshAbortRef.current?.abort();
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraStatusFilter, mode]);

  useEffect(() => {
    if (mode !== "group") return;

    const loadGroups = async () => {
      setLoadingGroups(true);
      setError("");
      try {
        const data = await getGroupTree();
        setGroupTree(data.map(buildGroupNode));
      } catch (err) {
        if (isCanceledRequest(err)) return;
        setError(err.message || "加载分组失败");
      } finally {
        setLoadingGroups(false);
      }
    };

    loadGroups();
  }, [mode]);

  useEffect(() => {
    if (!resizing) return;

    const handleMouseMove = (event) => {
      const { startX, startWidth, minWidth, maxWidth } = resizeStartRef.current;
      const deltaX = event.clientX - startX;
      const nextWidth = Math.min(
        Math.max(startWidth + deltaX, minWidth),
        maxWidth
      );

      setSidebarWidth(nextWidth);
    };

    const handleMouseUp = () => {
      setResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [resizing]);

  useEffect(() => {
    if (mode !== "favorite") return;

    const timer = window.setTimeout(() => {
      refreshFavoriteDisplayNodes(cameraStatusFilter, favoriteNodes);
    }, 180);

    return () => {
      window.clearTimeout(timer);
      favoriteRefreshAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, cameraStatusFilter, favoriteNodes]);


  const buildCountryNode = (provinces) => {
    const online = provinces.reduce((sum, node) => sum + Number(node.online || 0), 0);
    const total = provinces.reduce((sum, node) => sum + Number(node.total || 0), 0);

    return {
      id: COUNTRY_NODE_ID,
      nodeType: "region",
      regionCode: "",
      adcode: "100000",
      citycode: "",
      name: "中国",
      level: "country",
      center: "",
      online,
      total,
      children: provinces,
      loaded: true,
      isLeaf: false,
    };
  };


  const loadRoot = async ({ resetExpanded = false } = {}) => {
    const request = nextSidebarNavRefreshSeq();
    setLoadingRoot(true);
    setError("");
    setSearchMode(false);

    if (resetExpanded) {
      setExpandedNodeIds(new Set([COUNTRY_NODE_ID]));
    }

    try {
      const provinces = await fetchRootRegions(cameraStatusFilter, {
        signal: request.signal,
      });
      const countryNode = buildCountryNode(provinces);
      if (request.seq !== navRefreshSeqRef.current) return;
      setTree([countryNode]);
    } catch (err) {
      if (isCanceledRequest(err)) return;
      setError(err.message || "行政区加载失败");
    } finally {
      if (request.seq === navRefreshSeqRef.current) {
        setLoadingRoot(false);
      }
    }
  };



  const refreshNodeByExpandedState = async (node, statusFilter, expandedIds, options = {}) => {
  if (node.nodeType === "camera") {
    return node;
  }

  const shouldKeepExpanded = expandedIds.has(node.id);

  if (!shouldKeepExpanded) {
    return {
      ...node,
      children: [],
      loaded: node.level === "country",
      isLeaf: node.level === "town" && Number(node.total || 0) === 0,
    };
  }

  let children = [];

  if (node.level === "country") {
    children = node.children?.length
      ? node.children
      : await fetchRootRegions(statusFilter, options);
  } else {
    children = await fetchRegionChildren(node, statusFilter, options);
  }

  const refreshedChildren = await Promise.all(
    children.map((child) =>
      refreshNodeByExpandedState(child, statusFilter, expandedIds, options)
    )
  );

  return {
    ...node,
    children: refreshedChildren,
    loaded: true,
    isLeaf:
      node.level === "town"
        ? refreshedChildren.length === 0 && Number(node.total || 0) === 0
        : refreshedChildren.length === 0,
  };
};


  const refreshRegionTreeKeepExpanded = async (statusFilter) => {
    const request = nextSidebarNavRefreshSeq();
    const expandedIds = expandedNodeIdsRef.current;

    setLoadingRoot(true);
    setError("");

    try {
      const provinces = await fetchRootRegions(statusFilter, {
        signal: request.signal,
      });
      const countryNode = buildCountryNode(provinces);

      const refreshedCountryNode = await refreshNodeByExpandedState(
        countryNode,
        statusFilter,
        expandedIds,
        { signal: request.signal }
      );

      if (request.seq !== navRefreshSeqRef.current) return;
      setTree([refreshedCountryNode]);
    } catch (err) {
      if (isCanceledRequest(err)) return;
      setError(err.message || "行政区刷新失败");
    } finally {
      if (request.seq === navRefreshSeqRef.current) {
        setLoadingRoot(false);
      }
    }
  };




  useEffect(() => {
    setExpandedNodeIds(new Set([COUNTRY_NODE_ID]));
    setFavoriteDisplayNodes([]);
    loadRoot({ resetExpanded: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetVersion]);




  useEffect(() => {
    try {
      localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favoriteNodes));
    } catch (error) {
      console.error("Failed to save favorite nodes:", error);
    }
  }, [favoriteNodes]);

  useEffect(() => {
    try {
      localStorage.setItem(CUSTOM_FOLDERS_STORAGE_KEY, JSON.stringify(customFolders));
    } catch (error) {
      console.error("Failed to save custom folders:", error);
    }
  }, [customFolders]);

  useEffect(() => {
    try {
      localStorage.setItem(GROUP_CUSTOM_FOLDERS_STORAGE_KEY, JSON.stringify(groupCustomFolders));
    } catch (error) { console.error("Failed to save group custom folders:", error); }
  }, [groupCustomFolders]);




  const loadChildren = async (node) => {
    if (node.isLeaf || node.nodeType === "camera") return;

    setLoadingNodeId(node.id);
    setError("");

    try {
      const children = await fetchRegionChildren(node, cameraStatusFilter);

      const updater = (target) => ({
        ...target,
        children,
        loaded: true,
        isLeaf:
          target.level === "town"
            ? children.length === 0 && Number(target.total || 0) === 0
            : children.length === 0,
      });

      setTree((prev) => updateTreeNode(prev, node.id, updater));
      setFavoriteNodes((prev) => updateFavoriteNodes(prev, node.id, updater));
    } catch (err) {
      setError(err.message || "下级节点加载失败");
    } finally {
      setLoadingNodeId("");
    }
  };



  const refreshFavoriteNodeDeep = async (node, statusFilter, expandedIds, options = {}) => {
    if (node.nodeType === "camera") {
      return node;
    }

    if (node.level === "country") {
      const provinces = await fetchRootRegions(statusFilter, options);

      const online = provinces.reduce(
        (sum, item) => sum + Number(item.online || 0),
        0
      );

      const total = provinces.reduce(
        (sum, item) => sum + Number(item.total || 0),
        0
      );

      const nextChildren = expandedIds.has(node.id)
        ? provinces
        : node.children || [];

      const children = await Promise.all(
        nextChildren.map((child) =>
          refreshFavoriteNodeDeep(child, statusFilter, expandedIds, options)
        )
      );

      return {
        ...node,
        online,
        total,
        children,
      };
    }

    if (!node.regionCode) {
      return node;
    }

    let refreshedNode = node;

    try {
      const latest = await getNavTreeNode(node.regionCode, statusFilter, options);
      const latestNode = buildNode(latest);

      refreshedNode = {
        ...node,
        online: latestNode.online,
        total: latestNode.total,
        raw: latestNode.raw,
      };
    } catch (error) {
      if (isCanceledRequest(error)) {
        return node;
      }
      console.error("Failed to refresh favorite region node:", error);
    }

    const nextChildren = expandedIds.has(node.id)
      ? await fetchRegionChildren(refreshedNode, statusFilter, options)
      : node.children || [];

    const children = await Promise.all(
      nextChildren.map((child) =>
        refreshFavoriteNodeDeep(child, statusFilter, expandedIds, options)
      )
    );

    return {
      ...refreshedNode,
      children,
      loaded: expandedIds.has(node.id) || refreshedNode.loaded,
      isLeaf:
        refreshedNode.level === "town"
          ? children.length === 0 && Number(refreshedNode.total || 0) === 0
          : children.length === 0 && refreshedNode.isLeaf,
    };
  };

  const refreshFavoriteDisplayNodes = async (statusFilter, sourceFavoriteNodes) => {
    const request = nextFavoriteRefresh();
    const sourceNodes = Object.values(sourceFavoriteNodes);
    const expandedIds = expandedNodeIdsRef.current;

    if (sourceNodes.length === 0) {
      setFavoriteDisplayNodes([]);
      return;
    }

    setFavoriteDisplayNodes(sourceNodes);

    try {
      const nextNodes = await Promise.all(
        sourceNodes.map((node) =>
          refreshFavoriteNodeDeep(node, statusFilter, expandedIds, {
            signal: request.signal,
          })
        )
      );

      if (request.seq !== favoriteRefreshSeqRef.current) return;
      setFavoriteDisplayNodes(nextNodes);
    } catch (error) {
      if (isCanceledRequest(error)) return;
      console.error("Failed to refresh favorite display nodes:", error);
      setFavoriteDisplayNodes(sourceNodes);
    }
  };



  const refreshNode = async (node) => {
    if (node.isLeaf || node.nodeType === "camera") return;
    if (node.level === "country") return loadRoot();

    setLoadingNodeId(node.id);
    setError("");

    try {
      const children = await fetchRegionChildren(node, cameraStatusFilter);

      const updater = (target) => ({
        ...target,
        children,
        loaded: true,
        isLeaf:
          target.level === "town"
            ? children.length === 0 && Number(target.total || 0) === 0
            : children.length === 0,
      });

      setTree((prev) => updateTreeNode(prev, node.id, updater));
      setFavoriteNodes((prev) => updateFavoriteNodes(prev, node.id, updater));
    } catch (err) {
      setError(err.message || "节点刷新失败");
    } finally {
      setLoadingNodeId("");
    }
  };



  const handleSearch = async () => {
    const value = keyword.trim();

    if (!value) {
      await loadRoot();
      return;
    }

    setLoadingRoot(true);
    setError("");

    try {
      const result = await searchDistrict(value, cameraStatusFilter);
      setTree(result);
      setSearchMode(true);
      setMode("region");
      setKeyword("");
    } catch (err) {
      setError(err.message || "搜索失败");
    } finally {
      setLoadingRoot(false);
    }
  };



  const toggleFavorite = async (node) => {
    if (favoriteIds.has(node.id)) {
      setFavoriteNodes((prev) => {
        const next = { ...prev };
        delete next[node.id];
        return next;
      });
      return;
    }

    setFavoriteNodes((prev) => ({
      ...prev,
      [node.id]: toFavoriteNode(node),
    }));
  };

  const handleCreateGroup = async (name, cameraIds, parentId = null) => {
    try {
      await createGroup({
        name,
        parent_id: parentId,
        camera_ids: cameraIds,
      });
      const data = await getGroupTree();
      setGroupTree(data.map(buildGroupNode));
      setShowCreateGroupModal(false);
      setError("");
    } catch (err) {
      setError(err.message || "创建分组失败");
    }
  };

  const handleDeleteGroup = async (groupId) => {
      if (!window.confirm("确定要删除该分组吗？子分组将一并删除。")) return;
      try {
        try {
          await deleteGroup(groupId);
        } catch (deleteErr) {
          // 【修复】如果后端返回 404，说明分组早就被删掉了（幽灵点击），我们直接放行，当作删除成功
          if (deleteErr?.response?.status !== 404 && !String(deleteErr).includes("404")) {
            throw deleteErr;
          }
        }
        
        // 重新拉取最新的无缓存分组树
        const data = await getGroupTree();
        setGroupTree(data.map(buildGroupNode));
        setError("");
      } catch (err) {
        setError(err.message || "删除分组失败");
      }
    };

  const handleClearAllGroups = async () => {
    if (mode !== "group") return;

    if (!window.confirm("危险操作：确定要彻底清空所有分组吗？此操作不可恢复。")) return;

    try {
      const topLevelGroups = groupTree.filter(node => node.nodeType === "group");

      for (const group of topLevelGroups) {
        try {
          await deleteGroup(group.rawId);
        } catch (err) {
          if (err?.response?.status !== 404 && !String(err).includes("404")) throw err;
        }
      }

      const data = await getGroupTree();
      setGroupTree(data.map(buildGroupNode));
      setError("");
    } catch (err) {
      setError(err.message || "清空全部分组失败");
    }
  };

  useEffect(() => {
    window.addEventListener("TRIGGER_CLEAR_GROUPS", handleClearAllGroups);
    return () => window.removeEventListener("TRIGGER_CLEAR_GROUPS", handleClearAllGroups);
  }, [handleClearAllGroups]);



  const handleCreateCustomFolder = (townNode) => {
    if (townNode.level !== "town") return;
    const name = window.prompt("请输入自定义文件夹名称", `${townNode.name}自定义分组`);
    const trimmedName = name?.trim();
    if (!trimmedName) return;

    const id = `custom-folder-${townNode.regionCode}-${Date.now()}`;
    const newNode = makeCustomFolderNode({
      id,
      name: trimmedName,
      regionCode: townNode.regionCode,
      regionName: townNode.name,
      parentId: townNode.id,
      children: [],
    });

    if (mode === "group") {
      setGroupCustomFolders(prev => ({ ...prev, [id]: newNode }));
    } else {
      setCustomFolders(prev => ({ ...prev, [id]: newNode }));
    }
    setNodeExpanded(townNode.id, true);
    setError("");
  };

  const handleDropCameraToCustomFolder = (folderNode, cameraNode) => {
    const camera = normalizeCameraForCustomFolder(cameraNode);
    if (!camera.cameraId) return;

    let updatedFolder = null;
    const updateCache = (prev) => {
      const folder = prev[folderNode.id];
      if (!folder) return prev;
      const children = Array.isArray(folder.children) ? folder.children : [];
      if (children.some((item) => normalizeCameraForCustomFolder(item).cameraId === camera.cameraId)) return prev;
      updatedFolder = makeCustomFolderNode({ ...folder, children: [...children, camera] });
      return { ...prev, [folderNode.id]: updatedFolder };
    };

    if (mode === "group") {
      setGroupCustomFolders(updateCache);
    } else {
      setCustomFolders(updateCache);
      setFavoriteNodes((prev) => {
        if (!updatedFolder || !prev[folderNode.id]) return prev;
        return { ...prev, [folderNode.id]: toFavoriteNode(updatedFolder) };
      });
    }
    setNodeExpanded(folderNode.id, true);
  };

  const handleDeleteCustomFolder = (folderNode) => {
    if (folderNode.nodeType !== "custom_folder") return;
    if (!window.confirm(`确定删除自定义文件夹"${folderNode.name}"吗？`)) return;

    if (mode === "group") {
      setGroupCustomFolders(prev => { const next = { ...prev }; delete next[folderNode.id]; return next; });
    } else {
      setCustomFolders(prev => { const next = { ...prev }; delete next[folderNode.id]; return next; });
      setFavoriteNodes(prev => { const next = { ...prev }; delete next[folderNode.id]; return next; });
    }
    setNodeExpanded(folderNode.id, false);
  };

  const handleRemoveCameraFromCustomFolder = (folderId, cameraNode) => {
    const camera = normalizeCameraForCustomFolder(cameraNode);
    if (!camera.cameraId) return;

    let updatedFolder = null;
    const removeCache = (prev) => {
      const folder = prev[folderId];
      if (!folder) return prev;
      const children = (folder.children || []).map(normalizeCameraForCustomFolder).filter((item) => item.cameraId !== camera.cameraId);
      updatedFolder = makeCustomFolderNode({ ...folder, children });
      return { ...prev, [folderId]: updatedFolder };
    };

    if (mode === "group") {
      setGroupCustomFolders(removeCache);
    } else {
      setCustomFolders(removeCache);
      setFavoriteNodes((prev) => {
        if (!updatedFolder || !prev[folderId]) return prev;
        return { ...prev, [folderId]: toFavoriteNode(updatedFolder) };
      });
    }
  };

  const rawTree = useMemo(() => {
    if (mode === "group") {
      return attachCustomFoldersToTree(groupTree, groupCustomFolders);
    }

    if (mode === "favorite") {
      const sourceNodes =
        favoriteDisplayNodes.length > 0
          ? favoriteDisplayNodes
          : Object.values(favoriteNodes);

      return attachCustomFoldersToTree(sourceNodes, customFolders)
        .map((node) => filterFavoriteNodeByStatus(node, cameraStatusFilter))
        .filter(Boolean);
    }

    return attachCustomFoldersToTree(tree, customFolders);
  }, [mode, tree, favoriteNodes, favoriteDisplayNodes, cameraStatusFilter, customFolders, groupTree, groupCustomFolders]);

  const shownTree = useMemo(() => {
    if (searchMode || mode === "favorite") return rawTree;
    return filterTree(rawTree, keyword);
  }, [rawTree, keyword, searchMode, mode]);

  return (
    <aside
      ref={sidebarRef}
      className="relative flex shrink-0 flex-col border-r border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] transition-colors"
      style={{
        width: sidebarWidth === null ? "var(--layout-sidebar-width)" : `${sidebarWidth}px`,
      }}
    >
      <div className="flex h-full flex-col">
        <div className="border-b border-[var(--color-panel-border)] p-[var(--layout-sidebar-padding)]">


          <div className="mb-[var(--layout-sidebar-block-gap)] flex items-center gap-[var(--layout-search-gap)] text-ui-large">
            <div className="grid min-w-0 flex-1 grid-cols-3 rounded-[var(--layout-radius-lg)] bg-[var(--color-control-bg)] p-[var(--layout-segment-padding)]">
              <button
                onClick={() => setMode("group")}
                className={`min-h-[var(--layout-segment-button-height)] rounded-[var(--layout-radius-md)] px-[var(--layout-segment-button-padding-x)] py-[var(--layout-segment-button-padding-y)] font-medium transition-colors ${
                  mode === "group"
                    ? "bg-[var(--color-topbar-active-bg)] text-[var(--color-topbar-active-text)] shadow-sm"
                    : "text-[var(--color-text-muted)] hover:bg-[var(--color-hover-bg)] hover:text-[var(--color-accent)]"
                }`}
              >
                分组
              </button>

              <button
                onClick={() => setMode("region")}
                className={`min-h-[var(--layout-segment-button-height)] rounded-[var(--layout-radius-md)] px-[var(--layout-segment-button-padding-x)] py-[var(--layout-segment-button-padding-y)] font-medium transition-colors ${
                  mode === "region"
                    ? "bg-[var(--color-topbar-active-bg)] text-[var(--color-topbar-active-text)] shadow-sm"
                    : "text-[var(--color-text-muted)] hover:bg-[var(--color-hover-bg)] hover:text-[var(--color-accent)]"
                }`}
              >
                行政区
              </button>

              <button
                onClick={() => setMode("favorite")}
                className={`min-h-[var(--layout-segment-button-height)] rounded-[var(--layout-radius-md)] px-[var(--layout-segment-button-padding-x)] py-[var(--layout-segment-button-padding-y)] font-medium transition-colors ${
                  mode === "favorite"
                    ? "bg-[var(--color-topbar-active-bg)] text-[var(--color-topbar-active-text)] shadow-sm"
                    : "text-[var(--color-text-muted)] hover:bg-[var(--color-hover-bg)] hover:text-[var(--color-accent)]"
                }`}
              >
                收藏
              </button>
            </div>

            <select
              value={cameraStatusFilter}
              onChange={(event) => {
                setCameraStatusFilter(event.target.value);
                setSearchMode(false);
              }}
              className="min-h-[var(--layout-segment-button-height)] shrink-0 rounded-[var(--layout-radius-md)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-[var(--layout-segment-button-padding-x)] py-[var(--layout-segment-button-padding-y)] text-ui-large text-[var(--color-text-main)] outline-none"
            >
              <option value="all">全部</option>
              <option value="normal">正常</option>
              <option value="fault">异常</option>
              <option value="offline">离线</option>
            </select>
          </div>

          <div className="flex min-h-[var(--layout-search-height)] items-center gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-lg)] border border-[var(--color-panel-border)] bg-[var(--color-control-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)]">
            <Search size="var(--icon-search)" className="shrink-0 text-[var(--color-icon-muted)]" />
            <input
              value={keyword}
              onChange={(event) => {
                setKeyword(event.target.value);
                setSearchMode(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleSearch();
              }}
              placeholder="搜索行政区名称，回车查询"
              className="w-full bg-transparent text-ui-medium text-[var(--color-text-main)] outline-none placeholder:text-ui-small placeholder:text-[var(--color-text-muted)]"
            />
          </div>


        </div>

        {error && (
          <div className="mx-[var(--layout-sidebar-padding)] mt-[var(--layout-status-margin-top)] flex gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-lg)] bg-[var(--color-error-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)] text-ui-small text-[var(--color-error-text)]">
            <AlertCircle size="var(--icon-status)" className="mt-[var(--layout-status-icon-margin-top)] shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex-1 overflow-auto p-[var(--layout-tree-container-padding)]">
          {loadingRoot || loadingGroups ? (
            <div className="mt-[var(--layout-loading-margin-top)] flex items-center justify-center gap-[var(--layout-search-gap)] text-ui-medium text-[var(--color-text-muted)]">
              <Loader2 size="var(--icon-search)" className="animate-spin" /> {mode === "group" ? "正在加载分组数据..." : "正在加载行政区数据..."}
            </div>
          ) : (
            <div className="min-w-max space-y-[var(--layout-tree-gap)]">
              {mode === "group" && (
                <button
                  onClick={() => setShowCreateGroupModal(true)}
                  className="flex w-full items-center gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-md)] px-[var(--layout-segment-button-padding-x)] py-[var(--layout-segment-button-padding-y)] text-ui-medium text-[var(--color-accent)] hover:bg-[var(--color-hover-bg)]"
                >
                  <Plus size="var(--icon-search)" />
                  新建分组
                </button>
              )}
              {shownTree.length ? (
                shownTree.map((node) => (
                  <TreeNode
                    key={node.id}
                    node={node}
                    favoriteIds={favoriteIds}
                    previewingCameraIds={previewingCameraIds}
                    loadingNodeId={loadingNodeId}
                    expandedNodeIds={expandedNodeIds}
                    onSetExpanded={setNodeExpanded}
                    onToggleFavorite={toggleFavorite}
                    onLoadChildren={loadChildren}
                    onRefreshNode={refreshNode}
                    onCameraDoubleClick={onCameraDoubleClick}
                    onNodeDoubleClick={onNodeDoubleClick}
                    onCreateCustomFolder={handleCreateCustomFolder}
                    onDeleteCustomFolder={handleDeleteCustomFolder}
                    onDropCameraToCustomFolder={handleDropCameraToCustomFolder}
                    onRemoveCameraFromCustomFolder={handleRemoveCameraFromCustomFolder}
                    onDeleteGroup={(node) => handleDeleteGroup(node.rawId)}
                  />
                ))
              ) : mode !== "group" && (
                <div className="mt-[var(--layout-empty-margin-top)] text-center text-ui-medium text-[var(--color-text-muted)]">暂无数据</div>
              )}
            </div>
          )}
        </div>
      </div>


      <div
        className="absolute right-0 top-0 z-20 h-full w-2 cursor-col-resize"
        onMouseDown={(event) => {
          event.preventDefault();

          const rect = sidebarRef.current?.getBoundingClientRect();
          if (!rect) return;

          resizeStartRef.current = {
            startX: event.clientX,
            startWidth: rect.width,
            minWidth: rect.width * 0.75,
            maxWidth: rect.width * 2,
          };

          setResizing(true);
        }}
      />

      {showCreateGroupModal && (
        <CreateGroupModal
          onClose={() => setShowCreateGroupModal(false)}
          onSubmit={handleCreateGroup}
        />
      )}

    </aside>
  );
}







function ContentPlaceholder({
  activeTab,
  mapFocusTarget,
  deviceFocusTarget,
  deviceResetVersion,
  alarmFocusTarget,
  alarmResetVersion,
  statsFocusTarget,
  darkMode,
  onOpenCameraDetail,
  onOpenCameraDiagnosis,
  onCloseExternalDeviceDetail,
  onNavigateToDevice,
  showAlarmConfig,
  onCloseAlarmConfig,
  showPollingConfig,
  onClosePollingConfig,
}) {
  if (activeTab === "map") {
    return <MapView focusTarget={mapFocusTarget} darkMode={darkMode} onOpenCameraDetail={onOpenCameraDetail} onOpenCameraDiagnosis={onOpenCameraDiagnosis} onNavigateToDevice={onNavigateToDevice} />;
  }

  if (activeTab === "alarm") {
    return <VideoAlarmManage focusTarget={alarmFocusTarget} resetVersion={alarmResetVersion} onOpenCameraDiagnosis={onOpenCameraDiagnosis} showAlarmConfig={showAlarmConfig} onCloseAlarmConfig={onCloseAlarmConfig} showPollingConfig={showPollingConfig} onClosePollingConfig={onClosePollingConfig} />;
  }

  if (activeTab === "device") {
    return <DeviceManage focusTarget={deviceFocusTarget} resetVersion={deviceResetVersion} onCloseExternalDetail={onCloseExternalDeviceDetail} />;
  }

  if (activeTab === "stats") {
    return <StatisticsView focusTarget={statsFocusTarget} onNavigateToDevice={onNavigateToDevice} />;
  }

  const title = tabs.find((tab) => tab.key === activeTab)?.label || "内容";

  return (
    <main className="flex min-w-0 flex-1 bg-[var(--color-page-bg)] transition-colors">
      <section className="m-[var(--layout-content-padding)] flex min-h-0 flex-1 items-center justify-center rounded-[var(--layout-radius-xl)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] shadow-[var(--shadow-panel)] transition-colors">
        <div className="text-center">
          <div className="text-ui-large font-bold text-[var(--color-text-main)]">{title}</div>
          <div className="mt-[var(--layout-content-gap)] text-ui-small text-[var(--color-text-muted)]">
            内容区域暂时留空，后续按页面类型接入具体模块。
          </div>
        </div>
      </section>
    </main>
  );
}






function BottomBar({
  activeTab,
  sidebarWidth,
  onResetSidebar,
  onResetAlarms,
  onResetDiagnoses,
  onOpenAlarmConfig,
  onOpenPollingConfig,
}) {
  return (
    <footer className="flex h-[var(--layout-footer-height)] shrink-0 border-t border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] text-ui-small text-[var(--color-text-muted)] transition-colors">
      <div
        className="flex shrink-0 items-center gap-[var(--layout-search-gap)] overflow-hidden px-[var(--layout-sidebar-padding)]"
        style={{
          width:
            sidebarWidth === null
              ? "var(--layout-sidebar-width)"
              : `${sidebarWidth}px`,
        }}
      >
        <button
          type="button"
          onClick={onResetSidebar}
          className="flex items-center gap-[var(--layout-reset-tooltip-gap)] rounded-[var(--layout-radius-sm)] px-[var(--layout-reset-padding-x)] py-[var(--layout-reset-padding-y)] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-hover-bg)] hover:text-[var(--color-accent)]"
        >
          <RefreshCw size="var(--icon-bottom)" />
        </button>

        <button
          type="button"
          title="清空全部分组"
          onClick={() => window.dispatchEvent(new Event("TRIGGER_CLEAR_GROUPS"))}
          className="flex items-center gap-[var(--layout-reset-tooltip-gap)] rounded-[var(--layout-radius-sm)] px-[var(--layout-reset-padding-x)] py-[var(--layout-reset-padding-y)] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-error-bg)] hover:text-[var(--color-error-text)]"
        >
          <Trash2 size="var(--icon-bottom)" />
        </button>
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-between overflow-hidden px-[var(--layout-content-padding)]">
        <div className="flex min-w-0 items-center gap-[var(--layout-search-gap)]">
          <span className="truncate">{getPageBottomHint(activeTab)}</span>
        </div>

        <div className="flex shrink-0 items-center gap-[var(--layout-search-gap)]">
          {getPageBottomActions(activeTab, { onResetAlarms, onResetDiagnoses, onOpenAlarmConfig, onOpenPollingConfig })}
        </div>
      </div>
    </footer>
  );
}

function getPageBottomHint(activeTab) {
  const map = {
    map: "运维大屏工具栏",
    alarm: "异常告警工具栏",
    device: "根因诊断工具栏",
    stats: "统计分析工具栏",
  };

  return map[activeTab] || "页面工具栏";
}

function getPageBottomActions(activeTab, options = {}) {
  if (activeTab === "alarm") {
    return (
      <div className="flex gap-2">
        <button type="button" onClick={options.onOpenPollingConfig} className="flex min-h-[var(--layout-segment-button-height)] items-center gap-[var(--layout-reset-tooltip-gap)] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] px-[var(--layout-segment-button-padding-x)] text-ui-small font-medium text-[var(--color-accent)] hover:bg-[var(--color-hover-bg)]">
          <RotateCw size="var(--icon-bottom)" />
          轮巡配置
        </button>
        <button type="button" onClick={options.onOpenAlarmConfig} className="flex min-h-[var(--layout-segment-button-height)] items-center gap-[var(--layout-reset-tooltip-gap)] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] px-[var(--layout-segment-button-padding-x)] text-ui-small font-medium text-[var(--color-accent)] hover:bg-[var(--color-hover-bg)]">
          <Settings2 size="var(--icon-bottom)" />
          算法配置
        </button>
        <button type="button" onClick={options.onResetAlarms} className="flex min-h-[var(--layout-segment-button-height)] items-center gap-[var(--layout-reset-tooltip-gap)] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] px-[var(--layout-segment-button-padding-x)] text-ui-small font-medium text-[var(--color-accent)] hover:bg-[var(--color-hover-bg)]">
          <RefreshCw size="var(--icon-bottom)" />
          刷新告警确认
        </button>
      </div>
    );
  }

  if (activeTab === "map") {
    return <span>后续可扩展运维大屏更多工具</span>;
  }

  if (activeTab === "device") {
    return (
      <button type="button" onClick={options.onResetDiagnoses} className="flex min-h-[var(--layout-segment-button-height)] items-center gap-[var(--layout-reset-tooltip-gap)] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] px-[var(--layout-segment-button-padding-x)] text-ui-small font-medium text-[var(--color-accent)] hover:bg-[var(--color-hover-bg)]">
        <RefreshCw size="var(--icon-bottom)" />
        刷新诊断历史
      </button>
    );
  }

  if (activeTab === "stats") {
    return <span>后续可扩展时间范围、报表导出等工具</span>;
  }

  return null;
}





export default function VioTMasterLayout() {
  const [activeTab, setActiveTab] = useState("map");
  const [largeFont, setLargeFont] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [resetVersion, setResetVersion] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState(null); 
  const [mapFocusTarget, setMapFocusTarget] = useState(null);
  const [deviceFocusTarget, setDeviceFocusTarget] = useState(null);
  const [deviceResetVersion, setDeviceResetVersion] = useState(0);
  const [alarmFocusTarget, setAlarmFocusTarget] = useState(null);
  const [alarmResetVersion, setAlarmResetVersion] = useState(0);
  const [statsFocusTarget, setStatsFocusTarget] = useState(null);
  const [showAlarmConfig, setShowAlarmConfig] = useState(false);
  const [showPollingConfig, setShowPollingConfig] = useState(false);
  const externalDetailReturnTabRef = useRef("");
  const previewingCameraIds = useMemo(() => new Set(), []);

  const openCameraDetailFrom = (sourceTab, cameraLike) => {
    const cameraId = cameraLike?.cameraId || cameraLike?.camera_id || cameraLike?.id;
    if (!cameraId) return;

    externalDetailReturnTabRef.current = sourceTab;
    setDeviceFocusTarget({
      id: `camera-${cameraId}`,
      nodeType: "camera",
      cameraId,
      name: cameraLike.cameraName || cameraLike.name || cameraId,
      status: cameraLike.status || "",
      openDetail: true,
      returnTab: sourceTab,
      version: Date.now(),
    });
    setActiveTab("device");
  };

  const openCameraDiagnosisFrom = (sourceTab, cameraLike) => {
    const cameraId = cameraLike?.cameraId || cameraLike?.camera_id || cameraLike?.id;
    if (!cameraId) return;

    externalDetailReturnTabRef.current = sourceTab;
    setDeviceFocusTarget({
      id: `camera-${cameraId}`,
      nodeType: "camera",
      cameraId,
      name: cameraLike.cameraName || cameraLike.name || cameraId,
      status: cameraLike.status || "",
      openDiagnosis: true,
      returnTab: sourceTab,
      version: Date.now(),
    });
    setActiveTab("device");
  };

  const handleCloseExternalDeviceDetail = () => {
    const returnTab = externalDetailReturnTabRef.current;
    externalDetailReturnTabRef.current = "";
    setDeviceFocusTarget(null);
    if (returnTab) {
      setActiveTab(returnTab);
    }
  };

  const handleCameraDoubleClick = (cameraNode) => {
    if (!cameraNode?.cameraId) return;
    if (activeTab === "map") {
      setMapFocusTarget({ ...cameraNode, version: Date.now() });
      return;
    }
    if (activeTab === "alarm") {
      setAlarmFocusTarget({ ...cameraNode, version: Date.now() });
      return;
    }
    if (activeTab === "device") {
      setDeviceFocusTarget({ ...cameraNode, openDiagnosis: true, version: Date.now() });
      return;
    }
    if (activeTab === "stats") {
      setStatsFocusTarget({ ...cameraNode, version: Date.now() });
      return;
    }
  };

  const handleTabChange = (key) => {
    if (key === "device") {
      externalDetailReturnTabRef.current = "";
      setDeviceFocusTarget(null);
      setDeviceResetVersion((value) => value + 1);
    }
    setActiveTab(key);
  };

  const handleNavigateToDevice = (tab, status) => {
    setDeviceFocusTarget({
      deviceTab: tab,
      statusFilter: status || 'all',
      version: Date.now(),
    });
    setActiveTab("device");
  };

  const handleResetAlarmConfirmations = () => {
    setAlarmResetVersion((value) => value + 1);
  };

  const handleResetDiagnosisHistory = async () => {
    try {
      await clearVideoDiagnosisHistory();
      setDeviceFocusTarget(null);
      setDeviceResetVersion((value) => value + 1);
    } catch (error) {
      console.error("Failed to clear diagnosis history:", error);
    }
  };

  const handleNavNodeDoubleClick = (node) => {
    if (activeTab === "map") {
      setMapFocusTarget({
        ...node,
        version: Date.now(),
      });
      return;
    }

    if (activeTab === "device") {
      setDeviceFocusTarget({
        ...node,
        version: Date.now(),
      });
      return;
    }

    if (activeTab === "alarm") {
      setAlarmFocusTarget({
        ...node,
        version: Date.now(),
      });
      return;
    }

    if (activeTab === "stats") {
      setStatsFocusTarget({
        ...node,
        version: Date.now(),
      });
    }
  };

  return (
    <div
      className={`${largeFont ? "font-scale-small" : "font-scale-normal"} ${
        darkMode ? "theme-dark" : "theme-light"
      } flex h-screen flex-col overflow-hidden bg-[var(--color-page-bg)] text-[var(--color-text-main)] transition-colors`}
    >
      <TopBar
        activeTab={activeTab}
        onTabChange={handleTabChange}
        onFontSizeToggle={() => setLargeFont((value) => !value)}
        onThemeToggle={() => setDarkMode((value) => !value)}
        darkMode={darkMode}
      />

      <div className="flex min-h-0 flex-1">
        <Sidebar
          resetVersion={resetVersion}
          sidebarWidth={sidebarWidth}
          setSidebarWidth={setSidebarWidth}
          previewingCameraIds={previewingCameraIds}
          onCameraDoubleClick={handleCameraDoubleClick}
          onNodeDoubleClick={handleNavNodeDoubleClick}
        />

        <ContentPlaceholder
          activeTab={activeTab}
          onOpenCameraDetail={(camera) => openCameraDetailFrom(activeTab, camera)}
          onOpenCameraDiagnosis={(camera) => openCameraDiagnosisFrom(activeTab, camera)}
          onCloseExternalDeviceDetail={handleCloseExternalDeviceDetail}
          onNavigateToDevice={handleNavigateToDevice}
          mapFocusTarget={mapFocusTarget}
          deviceFocusTarget={deviceFocusTarget}
          deviceResetVersion={deviceResetVersion}
          alarmFocusTarget={alarmFocusTarget}
          alarmResetVersion={alarmResetVersion}
          statsFocusTarget={statsFocusTarget}
          darkMode={darkMode}
          showAlarmConfig={showAlarmConfig}
          onCloseAlarmConfig={() => setShowAlarmConfig(false)}
          showPollingConfig={showPollingConfig}
          onClosePollingConfig={() => setShowPollingConfig(false)}
        />
      </div>

      <BottomBar
        activeTab={activeTab}
        sidebarWidth={sidebarWidth}
        onResetAlarms={handleResetAlarmConfirmations}
        onResetDiagnoses={handleResetDiagnosisHistory}
        onResetSidebar={() => {
          setSidebarWidth(null);
          setResetVersion((value) => value + 1);
        }}
        onOpenAlarmConfig={() => setShowAlarmConfig(true)}
        onOpenPollingConfig={() => setShowPollingConfig(true)}
      />
    </div>
  );
}
