
import { useEffect, useMemo, useRef, useState } from "react";

const JESSIBUCA_SCRIPT_ID = "viot-jessibuca-pro-script";
const JESSIBUCA_BASE_PATH = "/vendor/jessibuca/";
const JESSIBUCA_SCRIPT_PATH = `${JESSIBUCA_BASE_PATH}jessibuca-pro.js`;
const JESSIBUCA_PROTOCOLS = new Set(["rtsp", "rtmp", "ws", "wss", "webrtc"]);
const JESSIBUCA_STALL_TIMEOUT_MS = 8000;

let jessibucaLoader = null;

function urlPlaybackType(url) {
  const value = String(url || "").toLowerCase();
  if (value.includes(".flv") || value.includes("format=flv")) return "flv";
  if (value.includes(".m3u8")) return "hls";
  const match = value.match(/^([a-z][a-z\d+.-]*):\/\//i);
  return match?.[1] || "unknown";
}

function normalizeCandidates(preview) {
  const rawCandidates = Array.isArray(preview?.candidates) ? preview.candidates : [];
  const candidates = rawCandidates
    .map((candidate) => ({
      type: String(candidate?.type || urlPlaybackType(candidate?.url)).toLowerCase(),
      url: candidate?.url || "",
      source: candidate?.source || "candidate",
    }))
    .filter((candidate) => candidate.url);

  if (preview?.play_url && !candidates.some((candidate) => candidate.url === preview.play_url)) {
    candidates.unshift({
      type: String(preview?.playback_type || preview?.protocol || urlPlaybackType(preview.play_url)).toLowerCase(),
      url: preview.play_url,
      source: preview?.source || "play_url",
    });
  }

  const supported = candidates.filter((candidate) => ["flv", "hls", "http", "https"].includes(candidate.type));
  const unsupported = candidates.filter((candidate) => !supported.includes(candidate));
  return [...supported, ...unsupported].filter((candidate, index, list) => list.findIndex((item) => item.url === candidate.url) === index);
}

export function shouldUseJessibuca(preview) {
  const protocol = String(preview?.playback_type || preview?.protocol || "").toLowerCase();
  const url = String(preview?.play_url || "").toLowerCase();

  if (protocol === "flv") return true;
  if (JESSIBUCA_PROTOCOLS.has(protocol)) return true;
  if (url.startsWith("rtsp://") || url.startsWith("rtmp://") || url.startsWith("ws://") || url.startsWith("wss://") || url.startsWith("webrtc://")) return true;
  if (url.includes(".flv") || url.includes("format=flv")) return true;
  return false;
}

function canNativePlayHls() {
  if (typeof document === "undefined") return false;
  const video = document.createElement("video");
  return Boolean(video.canPlayType("application/vnd.apple.mpegurl") || video.canPlayType("application/x-mpegURL"));
}

function loadJessibuca() {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("浏览器环境不可用"));
  }
  if (window.JessibucaPro) return Promise.resolve(window.JessibucaPro);
  if (jessibucaLoader) return jessibucaLoader;

  jessibucaLoader = new Promise((resolve, reject) => {
    const existing = document.getElementById(JESSIBUCA_SCRIPT_ID);
    const script = existing || document.createElement("script");

    const handleLoad = () => {
      if (window.JessibucaPro) {
        resolve(window.JessibucaPro);
        return;
      }
      reject(new Error("JessibucaPro 未挂载到 window"));
    };

    const handleError = () => reject(new Error("JessibucaPro 加载失败"));

    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });

    if (!existing) {
      script.id = JESSIBUCA_SCRIPT_ID;
      script.async = true;
      script.src = JESSIBUCA_SCRIPT_PATH;
      document.head.appendChild(script);
    } else {
      window.setTimeout(handleLoad, 0);
    }
  });

  return jessibucaLoader;
}

async function stopPlayer(player, destroy = false) {
  if (!player) return;
  if (destroy) {
    await player.destroy();
    return;
  }
  await player.close();
}

export default function LivePlayer({ preview, className = "h-full w-full", nativeClassName = "h-full w-full object-cover", startTime = 0, muted = true, loop = true, onPlaying, onError }) {
  const containerRef = useRef(null);
  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const activeUrlRef = useRef("");
  const onPlayingRef = useRef(onPlaying);
  const onErrorRef = useRef(onError);
  const fallbackTimerRef = useRef(null);
  const [internalError, setInternalError] = useState("");
  const [candidateIndex, setCandidateIndex] = useState(0);

  const candidates = useMemo(() => normalizeCandidates(preview), [preview]);
  const activeCandidate = candidates[candidateIndex] || candidates[0] || null;
  const playUrl = activeCandidate?.url || "";
  const playbackType = activeCandidate?.type || urlPlaybackType(playUrl);
  const useJessibuca = playbackType === "flv" || shouldUseJessibuca({ ...preview, play_url: playUrl, playback_type: playbackType });
  const useNativeHls = playbackType === "hls" && canNativePlayHls();

  useEffect(() => {
    setCandidateIndex(0);
    setInternalError("");
  }, [preview]);

  useEffect(() => {
    onPlayingRef.current = onPlaying;
    onErrorRef.current = onError;
  }, [onPlaying, onError]);

  useEffect(() => {
    return () => {
      if (fallbackTimerRef.current) window.clearTimeout(fallbackTimerRef.current);
    };
  }, []);

  const tryNextCandidate = (message) => {
    if (fallbackTimerRef.current) window.clearTimeout(fallbackTimerRef.current);
    if (candidateIndex < candidates.length - 1) {
      setInternalError(message ? `${message}，正在切换备用流` : "正在切换备用流");
      setCandidateIndex((index) => index + 1);
      return true;
    }
    if (message) setInternalError(message);
    onErrorRef.current?.(message || "视频播放失败");
    return false;
  };

  useEffect(() => {
    if (!useJessibuca && playerRef.current) {
      stopPlayer(playerRef.current, true).catch((error) => console.error("销毁 Jessibuca 失败:", error));
      playerRef.current = null;
      activeUrlRef.current = "";
    }
  }, [useJessibuca]);

  useEffect(() => {
    if (!playUrl || !useJessibuca) return undefined;

    let cancelled = false;
    setInternalError("");

    async function start() {
      try {
        const JessibucaPro = await loadJessibuca();
        if (cancelled || !containerRef.current) return;

        if (!playerRef.current) {
          playerRef.current = new JessibucaPro({
            container: containerRef.current,
            decoder: `${JESSIBUCA_BASE_PATH}decoder-pro.js`,
            decoderAudio: `${JESSIBUCA_BASE_PATH}decoder-pro-audio.js`,
            decoderWASM: `${JESSIBUCA_BASE_PATH}decoder-pro.wasm`,
            isResize: true,
            isFlv: true,
            useMSE: true,
            useSIMD: true,
            hasAudio: true,
            volume: muted ? 0 : 100,
            loadingIcon: false,
            hiddenAutoPause: true,
            heartTimeoutReplay: false,
            loadingTimeoutReplay: false,
          });
        }

        if (activeUrlRef.current && activeUrlRef.current !== playUrl) {
          await stopPlayer(playerRef.current, false);
        }

        if (fallbackTimerRef.current) window.clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = window.setTimeout(() => {
          if (!cancelled && activeUrlRef.current !== playUrl) {
            tryNextCandidate("视频首帧等待超时");
          }
        }, JESSIBUCA_STALL_TIMEOUT_MS);

        await playerRef.current.play(playUrl);
        activeUrlRef.current = playUrl;
        if (fallbackTimerRef.current) window.clearTimeout(fallbackTimerRef.current);
        if (!cancelled) onPlayingRef.current?.();
      } catch (error) {
        console.error("Jessibuca 播放失败:", error);
        const message = error?.message || String(error) || "视频播放失败";
        if (!cancelled) tryNextCandidate(message);
      }
    }

    start();

    return () => {
      cancelled = true;
      if (fallbackTimerRef.current) window.clearTimeout(fallbackTimerRef.current);
    };
  }, [playUrl, useJessibuca, muted]);

  useEffect(() => {
    if (useJessibuca || !playUrl || (playbackType === "hls" && !useNativeHls)) return undefined;
    const video = videoRef.current;
    if (!video) return undefined;

    const fail = () => tryNextCandidate("原生视频播放失败");
    const play = () => {
      if (Number.isFinite(startTime)) {
        video.currentTime = startTime;
      }
      video.play().then(() => onPlayingRef.current?.()).catch((error) => {
        console.error("原生视频播放失败:", error);
        const message = error?.message || "视频播放失败";
        tryNextCandidate(message);
      });
    };

    video.addEventListener("loadedmetadata", play, { once: true });
    video.addEventListener("error", fail);
    video.load();
    return () => {
      video.removeEventListener("loadedmetadata", play);
      video.removeEventListener("error", fail);
    };
  }, [playUrl, useJessibuca, playbackType, useNativeHls, startTime]);

  useEffect(() => {
    if (playbackType === "hls" && !useNativeHls && !useJessibuca) {
      tryNextCandidate("当前浏览器需要 HLS 播放器");
    }
  }, [playbackType, useNativeHls, useJessibuca]);

  useEffect(() => {
    return () => {
      if (playerRef.current) {
        stopPlayer(playerRef.current, true).catch((error) => console.error("销毁 Jessibuca 失败:", error));
        playerRef.current = null;
      }
    };
  }, []);

  if (!playUrl) return null;

  return (
    <div className={`relative ${className}`}>
      {useJessibuca ? (
        <div ref={containerRef} className="h-full w-full" />
      ) : (
        <video ref={videoRef} key={playUrl} src={playUrl} muted={muted} loop={loop} playsInline preload="auto" className={nativeClassName} />
      )}
      {internalError && (
        <div className="absolute inset-x-0 bottom-0 bg-[var(--color-error-bg)] px-[var(--layout-content-gap)] py-[var(--layout-search-padding-y)] text-ui-small text-[var(--color-error-text)]">
          {internalError}
        </div>
      )}
    </div>
  );
}
