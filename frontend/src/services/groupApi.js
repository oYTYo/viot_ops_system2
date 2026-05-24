import request from "./request";

export async function createGroup(data) {
  const res = await request.post("/groups", data);
  return res.data;
}

export async function getGroupTree() {
  // 【修复】增加 _t 时间戳，防止 Edge/Chrome 缓存 GET 请求导致删除后列表不刷新
  const res = await request.get(`/groups/tree?_t=${Date.now()}`);
  return res.data;
}

export async function getGroup(groupId) {
  const res = await request.get(`/groups/${groupId}`);
  return res.data;
}

export async function updateGroup(groupId, data) {
  const res = await request.put(`/groups/${groupId}`, data);
  return res.data;
}

export async function deleteGroup(groupId) {
  const res = await request.delete(`/groups/${groupId}`);
  return res.data;
}