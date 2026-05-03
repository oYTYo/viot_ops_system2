import request from "./request";

export function resolveApiUrl(path) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;

  const baseUrl = request.defaults.baseURL || window.location.origin;
  return new URL(path, baseUrl).toString();
}

export async function getCameraPreview(cameraId) {
  const res = await request.get(`/cameras/${cameraId}/preview`);

  return {
    ...res.data,
    play_url: resolveApiUrl(res.data.play_url),
  };
}
