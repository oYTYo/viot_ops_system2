import { useEffect, useState } from "react";
import { getChildRegions, getProvinceRegions } from "../services/regionApi";

function toTreeNode(region) {
  return {
    key: region.region_code,
    title: region.region_name,
    level: region.level,
    parentCode: region.parent_code,
    isLeaf: region.level === "town",
    loading: false,
    loaded: false,
    expanded: false,
    children: [],
    raw: region,
  };
}

function updateNode(nodes, key, updater) {
  return nodes.map((node) => {
    if (node.key === key) {
      return updater(node);
    }

    if (node.children && node.children.length > 0) {
      return {
        ...node,
        children: updateNode(node.children, key, updater),
      };
    }

    return node;
  });
}

function RegionNode({ node, depth, selectedKey, onToggle, onSelect }) {
  const selected = selectedKey === node.key;

  return (
    <div>
      <div
        className={[
          "flex cursor-pointer items-center rounded-lg px-2 py-1.5 text-sm transition",
          selected
            ? "bg-cyan-500/15 text-cyan-600 dark:text-cyan-300"
            : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800",
        ].join(" ")}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => onSelect(node)}
      >
        <button
          type="button"
          className="mr-1 flex h-5 w-5 items-center justify-center rounded text-xs hover:bg-slate-200 dark:hover:bg-slate-700"
          disabled={node.isLeaf}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(node);
          }}
        >
          {node.isLeaf ? (
            <span className="text-slate-400">·</span>
          ) : node.loading ? (
            <span className="animate-pulse">…</span>
          ) : node.expanded ? (
            <span>▾</span>
          ) : (
            <span>▸</span>
          )}
        </button>

        <span className="truncate">{node.title}</span>

        <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
          {node.level}
        </span>
      </div>

      {node.expanded &&
        node.children.map((child) => (
          <RegionNode
            key={child.key}
            node={child}
            depth={depth + 1}
            selectedKey={selectedKey}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}

export default function RegionLazyTree({ onSelect }) {
  const [treeData, setTreeData] = useState([]);
  const [selectedKey, setSelectedKey] = useState(null);
  const [initialLoading, setInitialLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);

  async function loadProvinces() {
    setInitialLoading(true);
    setErrorMessage(null);

    try {
      const provinces = await getProvinceRegions();
      setTreeData(provinces.map(toTreeNode));
    } catch (error) {
      console.error(error);
      setErrorMessage("行政区加载失败，请检查后端服务是否启动。");
    } finally {
      setInitialLoading(false);
    }
  }

  async function handleToggle(node) {
    if (node.isLeaf) return;

    if (node.loaded) {
      setTreeData((prev) =>
        updateNode(prev, node.key, (current) => ({
          ...current,
          expanded: !current.expanded,
        }))
      );
      return;
    }

    setTreeData((prev) =>
      updateNode(prev, node.key, (current) => ({
        ...current,
        loading: true,
      }))
    );

    try {
      const children = await getChildRegions(node.key);
      const childNodes = children.map(toTreeNode);

      setTreeData((prev) =>
        updateNode(prev, node.key, (current) => ({
          ...current,
          loading: false,
          loaded: true,
          expanded: true,
          children: childNodes,
        }))
      );
    } catch (error) {
      console.error(error);

      setTreeData((prev) =>
        updateNode(prev, node.key, (current) => ({
          ...current,
          loading: false,
        }))
      );
    }
  }

  function handleSelect(node) {
    setSelectedKey(node.key);
    onSelect?.(node.raw);
  }

  useEffect(() => {
    loadProvinces();
  }, []);

  if (initialLoading) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        正在加载行政区...
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
        {errorMessage}
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto rounded-xl border border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-900">
      {treeData.length === 0 ? (
        <div className="p-3 text-sm text-slate-500 dark:text-slate-400">
          暂无行政区数据
        </div>
      ) : (
        treeData.map((node) => (
          <RegionNode
            key={node.key}
            node={node}
            depth={0}
            selectedKey={selectedKey}
            onToggle={handleToggle}
            onSelect={handleSelect}
          />
        ))
      )}
    </div>
  );
}