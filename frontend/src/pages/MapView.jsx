import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Camera, Loader2, MapPinned, RadioTower } from "lucide-react";
import {
  getMapCamera,
  getMapRegion,
  getMapRegionCameras,
  getMapRegionChildren,
} from "../services/mapApi";

const AMAP_URL = "https://webapi.amap.com/maps?v=2.0";
const CHINA_CENTER = [104.195397, 35.86166];
const MAP_STYLE = {
  light: "amap://styles/normal",
  dark: "amap://styles/darkblue",
};
const LEVEL_ZOOM = {
  country: 4,
  province: 7,
  city: 10,
  county: 12,
  town: 14,
  camera: 16,
};

function parseCenter(center) {
  if (!center) return null;

  const [lng, lat] = String(center)
    .split(",")
    .map((item) => Number(item.trim()));

  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

function hasLngLat(item) {
  return Number.isFinite(Number(item.longitude)) && Number.isFinite(Number(item.latitude));
}

function getCameraRegionCode(camera) {
  return camera?.regionCode || camera?.region_code || camera?.town_code || "";
}

function getCameraId(camera) {
  return camera?.cameraId || camera?.camera_id || camera?.id || "";
}

function loadAmapScript(key) {
  if (window.AMap) return Promise.resolve(window.AMap);

  if (!window.__viotAmapPromise) {
    window.__viotAmapPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${AMAP_URL}&key=${encodeURIComponent(key)}`;
      script.async = true;
      script.onload = () => resolve(window.AMap);
      script.onerror = () => reject(new Error("高德地图脚本加载失败"));
      document.head.appendChild(script);
    });
  }

  return window.__viotAmapPromise;
}

function removeMapOverlays(map, overlays) {
  overlays.forEach((overlay) => {
    try {
      map.remove(overlay);
    } catch (error) {
      console.warn("Failed to remove map overlay:", error);
    }
  });
}

function getRegionMarkerContent(region) {
  return `
    <div class="viot-map-region-marker">
      <div class="viot-map-region-title">${region.region_name || region.name || ""}</div>
      <div class="viot-map-region-count">${Number(region.online || 0)}/${Number(region.total || 0)}</div>
    </div>
  `;
}

function getCameraMarkerContent(camera, focused = false) {
  const statusClass =
    camera.status === "offline"
      ? "is-offline"
      : camera.status === "fault"
        ? "is-fault"
        : "is-online";
  const focusedClass = focused ? "is-focused" : "";

  return `
    <div class="viot-map-camera-marker ${statusClass} ${focusedClass}">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14.5 7.5 20 4.5v15l-5.5-3v-9Z"></path>
        <rect x="3" y="6.5" width="11.5" height="11" rx="2.2"></rect>
        <circle cx="8.8" cy="12" r="2.2"></circle>
      </svg>
    </div>
  `;
}

export default function MapView({ focusTarget, darkMode }) {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const amapRef = useRef(null);
  const overlaysRef = useRef([]);
  const focusedCameraIdRef = useRef("");
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const amapKey = import.meta.env.VITE_AMAP_KEY || import.meta.env.AMAP_KEY || "";
  const mapStyle = darkMode ? MAP_STYLE.dark : MAP_STYLE.light;

  const focusKey = useMemo(() => {
    if (!focusTarget) return "";
    return `${focusTarget.nodeType}-${focusTarget.id}-${focusTarget.version || ""}`;
  }, [focusTarget]);

  function clearOverlays() {
    const map = mapRef.current;
    if (map && overlaysRef.current.length > 0) {
      removeMapOverlays(map, overlaysRef.current);
    }

    overlaysRef.current = [];
  }

  function addOverlay(overlay) {
    overlaysRef.current.push(overlay);
    mapRef.current.add(overlay);
  }

  async function renderRegions(parentCode = null) {
    const AMap = amapRef.current;
    if (!AMap || !mapRef.current) return;

    const regions = await getMapRegionChildren(parentCode);
    clearOverlays();

    regions.forEach((region) => {
      const position = parseCenter(region.center);
      if (!position) return;

      const marker = new AMap.Marker({
        position,
        content: getRegionMarkerContent(region),
        offset: new AMap.Pixel(-58, -36),
        title: region.region_name,
        zIndex: 80,
      });

      marker.on("dblclick", () => {
        focusRegion({
          ...region,
          nodeType: "region",
          id: region.region_code,
          name: region.region_name,
          regionCode: region.region_code,
        });
      });

      addOverlay(marker);
    });
  }

  async function renderCameras(regionCode, focusedCameraId = focusedCameraIdRef.current) {
    const AMap = amapRef.current;
    if (!AMap || !mapRef.current || !regionCode) return;

    const cameras = await getMapRegionCameras(regionCode);
    clearOverlays();

    cameras.filter(hasLngLat).forEach((camera) => {
      const focused = getCameraId(camera) === focusedCameraId;
      const marker = new AMap.Marker({
        position: [Number(camera.longitude), Number(camera.latitude)],
        content: getCameraMarkerContent(camera, focused),
        offset: new AMap.Pixel(-20, -20),
        title: camera.name,
        zIndex: focused ? 240 : 120,
      });

      addOverlay(marker);
    });
  }

  async function getRegionForFocus(region) {
    const regionCode = region.regionCode || region.region_code;

    if (region.center || region.amap_adcode || region.adcode || region.region_name) {
      return region;
    }

    if (!regionCode) return region;

    const latest = await getMapRegion(regionCode);
    return {
      ...region,
      ...latest,
      regionCode: latest.region_code,
      name: latest.region_name,
    };
  }

  async function focusRegion(region) {
    const map = mapRef.current;
    if (!map || !region) return;
    focusedCameraIdRef.current = "";

    const latestRegion = await getRegionForFocus(region);
    const position = parseCenter(latestRegion.center);

    if (position) {
      map.setZoomAndCenter(LEVEL_ZOOM[latestRegion.level] || 8, position);
    } else {
      const cityKeyword =
        latestRegion.adcode ||
        latestRegion.amap_adcode ||
        latestRegion.official_code ||
        latestRegion.region_name;

      if (cityKeyword) {
        map.setCity(cityKeyword);
        map.setZoom(LEVEL_ZOOM[latestRegion.level] || 8);
      }
    }

    if (latestRegion.level === "county" || latestRegion.level === "town") {
      await renderCameras(latestRegion.regionCode || latestRegion.region_code);
    } else {
      await renderRegions(latestRegion.regionCode || latestRegion.region_code || null);
    }
  }

  async function focusCamera(camera) {
    const map = mapRef.current;
    if (!map || !camera) return;

    let targetCamera = camera;
    const cameraId = getCameraId(camera);
    const regionCode = getCameraRegionCode(camera);

    if (!hasLngLat(targetCamera) && regionCode) {
      const regionCameras = await getMapRegionCameras(regionCode);
      const matched = regionCameras.find((item) => getCameraId(item) === cameraId);
      if (matched) {
        targetCamera = {
          ...targetCamera,
          ...matched,
          regionCode,
        };
      }
    }

    if (!hasLngLat(targetCamera) && cameraId) {
      const latest = await getMapCamera(cameraId);
      targetCamera = {
        ...targetCamera,
        ...latest,
        cameraId: latest.id,
        regionCode: latest.town_code || regionCode,
      };
    }

    if (hasLngLat(targetCamera)) {
      focusedCameraIdRef.current = getCameraId(targetCamera) || cameraId;
      map.setZoomAndCenter(LEVEL_ZOOM.camera, [
        Number(targetCamera.longitude),
        Number(targetCamera.latitude),
      ]);
      await renderCameras(getCameraRegionCode(targetCamera), focusedCameraIdRef.current);
      return;
    }

    const fallbackRegionCode = getCameraRegionCode(targetCamera);
    if (fallbackRegionCode) {
      await focusRegion({
        nodeType: "region",
        level: "town",
        regionCode: fallbackRegionCode,
      });
      return;
    }

    setMessage("该摄像机缺少经纬度，暂时无法定位到地图。");
  }

  useEffect(() => {
    if (!amapKey) {
      setMessage("请在前端环境变量中配置 VITE_AMAP_KEY 后使用电子地图。");
      return undefined;
    }

    let disposed = false;

    async function initMap() {
      setLoading(true);
      setMessage("");

      try {
        const AMap = await loadAmapScript(amapKey);
        if (disposed || !mapContainerRef.current) return;

        amapRef.current = AMap;
        const map = new AMap.Map(mapContainerRef.current, {
          zoom: LEVEL_ZOOM.country,
          center: CHINA_CENTER,
          viewMode: "2D",
          resizeEnable: true,
          mapStyle,
        });

        mapRef.current = map;
        setReady(true);
        await renderRegions(null);
      } catch (error) {
        console.error("Map init failed:", error);
        setMessage(error.message || "地图初始化失败");
      } finally {
        if (!disposed) setLoading(false);
      }
    }

    initMap();

    return () => {
      disposed = true;
      clearOverlays();
      try {
        mapRef.current?.clearMap?.();
      } catch (error) {
        console.warn("Failed to clear map:", error);
      }
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amapKey]);

  useEffect(() => {
    mapRef.current?.setMapStyle?.(mapStyle);
  }, [mapStyle]);

  useEffect(() => {
    if (!ready || !focusTarget) return;

    setLoading(true);
    setMessage("");

    const task =
      focusTarget.nodeType === "camera"
        ? focusCamera(focusTarget)
        : focusRegion(focusTarget);

    task
      .catch((error) => {
        console.error("Map focus failed:", error);
        setMessage(error.message || "地图定位失败");
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, focusKey]);

  return (
    <main className="relative flex min-w-0 flex-1 bg-[var(--color-page-bg)] p-[var(--layout-content-padding)] transition-colors">
      <section className="relative min-h-0 flex-1 overflow-hidden rounded-[var(--layout-radius-lg)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] shadow-[var(--shadow-panel)]">
        <div ref={mapContainerRef} className="h-full w-full" />

        <div className="pointer-events-none absolute left-[var(--layout-content-padding)] top-[var(--layout-content-padding)] flex items-center gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)] text-ui-small text-[var(--color-text-main)] shadow-[var(--shadow-panel)]">
          <MapPinned size="var(--icon-bottom)" className="text-[var(--color-accent)]" />
          <span>双击左侧行政区定位；县级及以下显示摄像机</span>
        </div>

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--color-panel-bg)]/60 text-[var(--color-text-main)]">
            <div className="flex items-center gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-lg)] bg-[var(--color-panel-bg)] px-[var(--layout-content-padding)] py-[var(--layout-search-padding-y)] shadow-[var(--shadow-panel)]">
              <Loader2 size="var(--icon-search)" className="animate-spin text-[var(--color-accent)]" />
              <span className="text-ui-medium">地图数据加载中</span>
            </div>
          </div>
        )}

        {message && (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--color-panel-bg)]/85">
            <div className="flex max-w-[42rem] items-start gap-[var(--layout-content-gap)] rounded-[var(--layout-radius-lg)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] p-[var(--layout-content-padding)] text-[var(--color-text-main)] shadow-[var(--shadow-panel)]">
              <AlertCircle size="var(--icon-topbar)" className="shrink-0 text-[var(--color-error-text)]" />
              <div>
                <div className="text-ui-large font-semibold">电子地图暂不可用</div>
                <div className="mt-[var(--layout-search-padding-y)] text-ui-medium text-[var(--color-text-muted)]">
                  {message}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="absolute bottom-[var(--layout-content-padding)] right-[var(--layout-content-padding)] flex items-center gap-[var(--layout-search-gap)] rounded-[var(--layout-radius-sm)] border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-[var(--layout-search-padding-x)] py-[var(--layout-search-padding-y)] text-ui-small text-[var(--color-text-muted)] shadow-[var(--shadow-panel)]">
          <RadioTower size="var(--icon-bottom)" className="text-[var(--color-accent)]" />
          <span>区域显示在线/总数</span>
          <Camera size="var(--icon-bottom)" className="text-[var(--color-accent)]" />
          <span>县级显示摄像机</span>
        </div>
      </section>
    </main>
  );
}
