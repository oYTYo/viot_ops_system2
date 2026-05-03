import React from "react";
import { Type, Moon, UserCircle } from "lucide-react";

export default function TopBar({
  tabs,
  activeTab,
  onTabChange,
  onFontSizeToggle,
  onThemeToggle,
  darkMode,
}) {
  return (
    <header className="h-[var(--layout-topbar-height)] shrink-0 border-b border-[var(--color-panel-border)] bg-[var(--color-topbar-bg)] px-[var(--layout-topbar-padding-x)] shadow-[var(--shadow-panel)]">
      <div className="flex h-full items-center justify-between gap-[var(--layout-topbar-gap)]">
        <div className="min-w-[var(--layout-title-width)] text-app-title font-bold leading-none tracking-tight text-white">
          视联网智能运维平台
        </div>

        <nav className="flex flex-1 items-center justify-center gap-[var(--layout-tab-gap)]">
          {tabs.map(({ key, label, icon: Icon }) => {
            const isActive = activeTab === key;

            return (
              <button
                key={key}
                onClick={() => onTabChange(key)}
                className={`flex min-h-[var(--layout-tab-height)] items-center gap-[var(--layout-tab-inner-gap)] rounded-[var(--layout-radius-lg)] px-[var(--layout-tab-padding-x)] py-[var(--layout-tab-padding-y)] text-ui-large font-medium transition ${
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
            className="rounded-[var(--layout-radius-lg)] p-[var(--layout-icon-button-padding)] hover:bg-[var(--color-topbar-hover-bg)]"
          >
            <Type size="var(--icon-topbar)" />
          </button>

          <button
            onClick={onThemeToggle}
            title={darkMode ? "点击切换浅色模式" : "点击切换深色模式"}
            className="rounded-[var(--layout-radius-lg)] p-[var(--layout-icon-button-padding)] hover:bg-[var(--color-topbar-hover-bg)]"
          >
            <Moon size="var(--icon-topbar)" />
          </button>

          <button
            title="用户"
            className="rounded-[var(--layout-radius-lg)] p-[var(--layout-icon-button-padding)] hover:bg-[var(--color-topbar-hover-bg)]"
          >
            <UserCircle size="var(--icon-user)" />
          </button>
        </div>
      </div>
    </header>
  );
}