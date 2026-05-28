import request from "./request";

export async function getAlgorithmRuntimeProfile() {
  const res = await request.get("/algorithm/runtime-profile");
  return res.data;
}

export async function updateAlgorithmRuntimeProfile(payload) {
  const res = await request.put("/algorithm/runtime-profile", payload);
  return res.data;
}

export async function getAlgorithmActiveFlows() {
  const res = await request.get("/algorithm/active-flows");
  return res.data;
}

export async function refreshAlgorithmActiveFlows() {
  const res = await request.post("/algorithm/active-flows/refresh");
  return res.data;
}

export async function applyAlgorithmChainlist(payload) {
  const res = await request.post("/algorithm/chainlist/apply", payload);
  return res.data;
}

export async function getLatestAlgorithmAnomalies(params = {}) {
  const res = await request.get("/algorithm/anomalies/latest", {
    params: {
      limit: 100,
      ...params,
    },
  });
  return res.data;
}
