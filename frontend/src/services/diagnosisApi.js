import request from "./request";

export async function getLatestVideoDiagnosis(cameraId) {
  const res = await request.get(`/cameras/${encodeURIComponent(cameraId)}/diagnoses/latest`);
  return res.data;
}

export async function runVideoDiagnosis(cameraId) {
  const res = await request.post(`/cameras/${encodeURIComponent(cameraId)}/diagnoses/run`);
  return res.data;
}

export async function clearVideoDiagnosisHistory() {
  const res = await request.delete("/diagnoses");
  return res.data;
}
