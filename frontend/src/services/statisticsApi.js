import request from "./request";

export async function getStatisticsOverview(params = {}) {
  const res = await request.get("/statistics/overview", { params });
  return res.data;
}
