import request from "./request";

const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;

export function resolveApiUrl(path) {
  if (!path) return "";
  if (ABSOLUTE_URL_PATTERN.test(path)) return path;

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

function normalizePreviewCandidate(candidate) {
  if (typeof candidate === "string") {
    return {
      url: resolveApiUrl(candidate),
    };
  }

  if (!candidate?.url) return null;

  return {
    ...candidate,
    url: resolveApiUrl(candidate.url),
  };
}

function normalizePreview(data = {}) {
  const candidates = Array.isArray(data.candidates)
    ? data.candidates.map(normalizePreviewCandidate).filter(Boolean)
    : [];
  const playUrl = resolveApiUrl(data.play_url);

  return {
    ...data,
    play_url: playUrl,
    candidates,
  };
}

export async function getCameraPreview(cameraId) {
  const res = await request.get(`/cameras/${cameraId}/preview`);

  return normalizePreview(res.data);
}
