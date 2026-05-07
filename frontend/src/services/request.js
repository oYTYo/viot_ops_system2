import axios from "axios";

function getDefaultApiBaseUrl() {
  return "/api/backend";
}

function getApiBaseUrl() {
  const configured = import.meta.env.VITE_API_BASE_URL;
  if (!configured) return getDefaultApiBaseUrl();

  if (typeof window !== "undefined") {
    try {
      const url = new URL(configured, window.location.origin);
      if (["127.0.0.1", "localhost"].includes(url.hostname)) {
        return getDefaultApiBaseUrl();
      }
    } catch {
      return configured;
    }
  }

  return configured;
}

const request = axios.create({
  baseURL: getApiBaseUrl(),
  timeout: 15000,
});

request.interceptors.response.use(
  (response) => response,
  (error) => {
    if (axios.isCancel(error) || error.code === "ERR_CANCELED") {
      return Promise.reject(error);
    }

    console.error("API request failed:", error);
    return Promise.reject(error);
  }
);

export default request;
