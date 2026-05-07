import request from "./request";

export function resolveApiUrl(path) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;

  const baseUrl = request.defaults.baseURL || window.location.origin;
  if (path.startsWith("/videos/") && typeof window !== "undefined") {
    const configured = import.meta.env.VITE_MEDIA_BASE_URL;
    if (configured) {
      return new URL(path, configured).toString();
    }

    return `${window.location.protocol}//${window.location.hostname}:8000${path}`;
  }

  if (typeof baseUrl === "string" && baseUrl.startsWith("/")) {
    return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
  }

  return new URL(path, baseUrl).toString();
}

export async function getCameraPreview(cameraId) {
  const res = await request.get(`/cameras/${cameraId}/preview`);

  return {
    ...res.data,
    play_url: resolveApiUrl(res.data.play_url),
  };
}
