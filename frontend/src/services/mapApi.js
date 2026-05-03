import request from "./request";

export async function getMapRegionChildren(parentCode = null, statusFilter = "all") {
  const res = await request.get("/nav-tree/children", {
    params: {
      status_filter: statusFilter,
      ...(parentCode ? { parent_code: parentCode } : {}),
    },
  });

  return res.data;
}

export async function getMapRegionCameras(regionCode, statusFilter = "all") {
  const res = await request.get("/nav-tree/cameras", {
    params: {
      region_code: regionCode,
      status_filter: statusFilter,
      limit: 5000,
    },
  });

  return res.data;
}

export async function getMapRegion(regionCode) {
  const res = await request.get(`/regions/${regionCode}`);
  return res.data;
}

export async function getMapCamera(cameraId) {
  const res = await request.get(`/cameras/${cameraId}`);
  return res.data;
}
