import { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, MonitorPlay, X } from "lucide-react";

function formatDateTime(value) {
  const pad = (num) => String(num).padStart(2, "0");

  return [
    `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`,
    `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`,
  ].join(" ");
}

function VideoTile({ stream, selected, onSelect, onClose, nowText }) {
  const videoRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream?.playUrl) return undefined;

    const seekToStart = () => {
      if (Number.isFinite(stream.startTime)) {
        video.currentTime = stream.startTime;
      }

      video.play().catch(() => {});
    };

    video.addEventListener("loadedmetadata", seekToStart);
    video.load();

    return () => {
      video.removeEventListener("loadedmetadata", seekToStart);
    };
  }, [stream]);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          onSelect();
        }
      }}
      className={`relative min-h-0 overflow-hidden rounded-[var(--layout-radius-md)] border bg-black text-left shadow-[var(--shadow-panel)] transition-colors ${
        selected
          ? "border-[var(--color-accent)]"
          : "border-[var(--color-panel-border)]"
      }`}
    >
      {stream ? (
        <>
          {stream.status === "connecting" ? (
            <div className="flex h-full min-h-[12rem] flex-col items-center justify-center gap-[var(--layout-content-gap)] bg-black text-white">
              <Loader2 size="var(--icon-logo)" className="animate-spin text-[var(--color-accent)]" />
              <span className="max-w-[80%] truncate text-ui-small text-white/80">
                正在连接 {stream.cameraName}
              </span>
            </div>
          ) : (
            <>
              <video
                ref={videoRef}
                key={`${stream.cameraId}-${stream.loadedAt}`}
                className="h-full w-full object-cover"
                src={stream.playUrl}
                muted
                loop
                playsInline
                autoPlay
              />
              <div className="absolute left-[var(--layout-search-padding-x)] top-[var(--layout-search-padding-y)] max-w-[calc(100%-var(--layout-content-padding)*2)] rounded-[var(--layout-radius-sm)] bg-black/60 px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)] text-ui-small font-medium text-white">
                <span className="block truncate">
                  {nowText} {stream.cameraName}
                </span>
              </div>
            </>
          )}
          <button
            type="button"
            title="关闭预览"
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
            className="absolute right-[var(--layout-search-padding-x)] top-[var(--layout-search-padding-y)] flex h-[var(--layout-bottom-button-size)] w-[var(--layout-bottom-button-size)] items-center justify-center rounded-[var(--layout-radius-sm)] bg-black/60 text-white transition-colors hover:bg-[var(--color-error-text)]"
          >
            <X size="var(--icon-bottom)" />
          </button>
        </>
      ) : (
        <div className="flex h-full min-h-[12rem] items-center justify-center bg-[var(--color-control-bg)] text-[var(--color-text-muted)]">
          <MonitorPlay size="var(--icon-logo)" />
        </div>
      )}
    </div>
  );
}

export default function VideoBrowse({
  gridSize,
  streams,
  selectedSlot,
  connectionError,
  onSelectSlot,
  onCloseSlot,
  onClearConnectionError,
}) {
  const now = useNow();
  const columns = gridSize === 1 ? 1 : gridSize === 4 ? 2 : 3;
  const nowText = formatDateTime(now);

  return (
    <main className="flex min-w-0 flex-1 bg-[var(--color-page-bg)] p-[var(--layout-content-padding)] transition-colors">
      <section
        className="grid min-h-0 flex-1 gap-[var(--layout-content-gap)]"
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${columns}, minmax(0, 1fr))`,
        }}
      >
        {Array.from({ length: gridSize }, (_, index) => (
          <VideoTile
            key={index}
            stream={streams[index]}
            selected={selectedSlot === index}
            onSelect={() => onSelectSlot(index)}
            onClose={() => onCloseSlot(index)}
            nowText={nowText}
          />
        ))}
      </section>

      {connectionError && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35">
          <div className="w-[min(32rem,calc(100%-var(--layout-content-padding)*2))] rounded-[var(--layout-radius-lg)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] p-[var(--layout-content-padding)] shadow-[var(--shadow-panel)]">
            <div className="flex items-start gap-[var(--layout-content-gap)] text-[var(--color-text-main)]">
              <AlertCircle size="var(--icon-topbar)" className="shrink-0 text-[var(--color-error-text)]" />
              <div className="min-w-0">
                <div className="text-ui-large font-semibold">连接失败</div>
                <div className="mt-[var(--layout-search-padding-y)] text-ui-medium text-[var(--color-text-muted)]">
                  {connectionError}
                </div>
              </div>
            </div>
            <div className="mt-[var(--layout-content-padding)] flex justify-end">
              <button
                type="button"
                onClick={onClearConnectionError}
                className="rounded-[var(--layout-radius-sm)] bg-[var(--color-topbar-active-bg)] px-[var(--layout-tab-padding-x)] py-[var(--layout-segment-button-padding-y)] text-ui-medium font-medium text-[var(--color-topbar-active-text)]"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function useNow() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(new Date());
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

  return now;
}
