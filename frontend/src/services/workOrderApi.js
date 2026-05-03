import request from "./request";

export async function getWorkOrders(params = {}) {
  const res = await request.get("/work-orders", {
    params: {
      limit: 1000,
      ...params,
    },
  });
  return res.data;
}

export async function createWorkOrder(payload) {
  const res = await request.post("/work-orders", payload);
  return res.data;
}

export async function updateWorkOrder(orderId, payload) {
  const res = await request.put(`/work-orders/${encodeURIComponent(orderId)}`, payload);
  return res.data;
}

export async function deleteWorkOrder(orderId) {
  const res = await request.delete(`/work-orders/${encodeURIComponent(orderId)}`);
  return res.data;
}
