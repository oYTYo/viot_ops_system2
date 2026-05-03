import RegionLazyTree from "../RegionLazyTree";
import { useRegion } from "../../context/RegionContext";

export default function RegionWorkLayout({ children }) {
  const { selectedRegion, setSelectedRegion } = useRegion();

  return (
    <div className="flex h-full min-h-0 gap-3">
      <aside className="h-full w-80 shrink-0 overflow-hidden rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-3">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            行政区划
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            按省、市、县、乡逐级加载
          </p>
        </div>

        <div className="h-[calc(100%-52px)] min-h-0">
          <RegionLazyTree onSelect={setSelectedRegion} />
        </div>
      </aside>

      <section className="min-w-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-slate-200 px-4 dark:border-slate-800">
            <div className="min-w-0">
              <div className="text-sm text-slate-500 dark:text-slate-400">
                当前行政区
              </div>
              <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                {selectedRegion ? selectedRegion.region_name : "未选择"}
              </div>
            </div>

            {selectedRegion && (
              <div className="rounded-full bg-cyan-500/10 px-3 py-1 text-xs text-cyan-600 dark:text-cyan-300">
                {selectedRegion.level}
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-4">
            {children}
          </div>
        </div>
      </section>
    </div>
  );
}