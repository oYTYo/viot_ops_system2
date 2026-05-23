import request from "./request";

export async function createGroup(data) {
  const res = await request.post("/groups", data);
  return res.data;
}

export async function getGroupTree() {
  const res = await request.get("/groups/tree");
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
