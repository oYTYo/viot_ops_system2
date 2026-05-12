import request from "./request";

export async function getDeviceCameras(params = {}) {
  const res = await request.get("/cameras", {
    params: {
      limit: 5000,
      include_fake: false,
      ...params,
    },
  });
  return res.data;
}

export async function createDeviceCamera(payload) {
  const res = await request.post("/cameras", payload);
  return res.data;
}

export async function updateDeviceCamera(cameraId, payload) {
  const res = await request.put(`/cameras/${encodeURIComponent(cameraId)}`, payload);
  return res.data;
}

export async function deleteDeviceCamera(cameraId) {
  const id = cameraId === null || cameraId === undefined ? "" : String(cameraId);
  const res = id
    ? await request.delete(`/cameras/${encodeURIComponent(id)}`)
    : await request.delete("/cameras", {
        params: {
          camera_id: "",
        },
      });
  return res.data;
}

export async function getDeviceServers(params = {}) {
  const res = await request.get("/servers", {
    params: {
      limit: 1000,
      ...params,
    },
  });
  return res.data;
}

export async function createDeviceServer(payload) {
  const res = await request.post("/servers", payload);
  return res.data;
}

export async function updateDeviceServer(serverId, payload) {
  const res = await request.put(`/servers/${encodeURIComponent(serverId)}`, payload);
  return res.data;
}

export async function deleteDeviceServer(serverId) {
  const res = await request.delete(`/servers/${encodeURIComponent(serverId)}`);
  return res.data;
}

export async function getDeviceStreams(params = {}) {
  const res = await request.get("/stream-medias", {
    params: {
      limit: 5000,
      include_fake: false,
      ...params,
    },
  });
  return res.data;
}
