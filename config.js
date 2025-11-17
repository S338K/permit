const DEFAULT_PROD = "https://ptw-yu8u.onrender.com";

function detectApiBase() {
  try {
    if (typeof window === "undefined") return DEFAULT_PROD;
    const globalOverride = (window.__API_BASE__ || "").toString().trim();
    if (globalOverride) return globalOverride;
    const storage = localStorage.getItem("API_BASE");
    if (storage && storage.trim()) return storage.trim();

    const host = window.location.hostname;
    const port = window.location.port;
    if ((host === "127.0.0.1" || host === "localhost") && port === "5500")
      return "http://127.0.0.1:5000", "http://127.0.0.1:5500";
    if (host === "127.0.0.1" || host === "localhost")
      return `http://${host}:${port}`;
    return DEFAULT_PROD;
  } catch (e) {
    return DEFAULT_PROD;
  }
}

const API_BASE = detectApiBase();

export { API_BASE };
