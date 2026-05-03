import request from "./request";

export async function getRegions(params = {}) {
  const res = await request.get("/regions", {
    params,
  });

  return res.data;
}

export async function getProvinceRegions() {
  return getRegions({
    level: "province",
  });
}

export async function getChildRegions(parentCode) {
  return getRegions({
    parent_code: parentCode,
  });
}

export async function getRegionByCode(regionCode) {
  const res = await request.get(`/regions/${regionCode}`);
  return res.data;
}

export async function searchRegionTree(keyword) {
  const res = await request.get("/regions/search-tree", {
    params: {
      keyword,
    },
  });

  return res.data;
}

export async function getNavTreeChildren(parentCode, statusFilter = "all") {
  const params = {
    status_filter: statusFilter,
  };

  if (parentCode) {
    params.parent_code = parentCode;
  }

  const res = await request.get("/nav-tree/children", {
    params,
  });

  return res.data;
}

export async function getNavTreeCameras(regionCode, params = {}) {
  const res = await request.get("/nav-tree/cameras", {
    params: {
      region_code: regionCode,
      status_filter: params.status_filter || "all",
      ...params,
    },
  });

  return res.data;
}

export async function searchNavTree(keyword, statusFilter = "all") {
  const res = await request.get("/nav-tree/search", {
    params: {
      keyword,
      status_filter: statusFilter,
    },
  });

  return res.data;
}


export async function getNavTreeNode(regionCode, statusFilter = "all") {
  const res = await request.get("/nav-tree/node", {
    params: {
      region_code: regionCode,
      status_filter: statusFilter,
    },
  });

  return res.data;
}