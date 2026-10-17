import axios from "axios";

// VITE_API_URL is set at build time (Vercel -> Environment Variables), e.g.
//   https://queen-captivated-api.onrender.com/api
// "/api" is appended automatically if you forget it.
function resolveBaseUrl() {
  let url = (import.meta.env.VITE_API_URL || "").trim().replace(/\/+$/, "");
  if (!url) return import.meta.env.DEV ? "http://localhost:4000/api" : "/api";
  if (!/\/api$/i.test(url) && /^https?:\/\//i.test(url)) url += "/api";
  return url;
}

const baseURL = resolveBaseUrl();
export const API_NOT_CONFIGURED = /your-backend/.test(baseURL);

const client = axios.create({
  baseURL,
  timeout: 65000, // free hosts can take ~60s to wake from sleep
});

function readToken() {
  try { return localStorage.getItem("qc_token"); } catch { return null; }
}

client.interceptors.request.use((config) => {
  if (API_NOT_CONFIGURED) {
    return Promise.reject(
      Object.assign(new Error("The server is not connected yet. (Site owner: set VITE_API_URL in Vercel and redeploy.)"), { friendly: true })
    );
  }
  const token = readToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

client.interceptors.response.use(
  (res) => res,
  (error) => {
    if (!error.response && !error.friendly) {
      // Network error / timeout: no JSON body to show, so give the pages a readable message.
      error.response = {
        status: 0,
        data: { error: "Cannot reach the server. If it was idle it may be waking up - please wait a minute and try again." },
      };
    } else if (error.friendly) {
      error.response = { status: 0, data: { error: error.message } };
    }
    // A saved login that the server no longer recognises (e.g. database reset after a redeploy).
    const status = error.response?.status;
    const isAuthCall = /\/auth\//.test(error.config?.url || "");
    if (status === 401 && !isAuthCall && readToken()) {
      try {
        localStorage.removeItem("qc_token");
        localStorage.removeItem("qc_user");
      } catch { /* ignore */ }
      const base = import.meta.env.BASE_URL.replace(/\/$/, "");
      if (!window.location.pathname.endsWith("/login")) window.location.assign(`${base}/login`);
    }
    return Promise.reject(error);
  }
);

export default client;
