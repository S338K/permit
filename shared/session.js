import { API_BASE } from "../config.js";

// Function: getLoginUrl — Build login page URL (handles GitHub Pages prefix)
function getLoginUrl() {
  try {
    const { hostname, pathname } = window.location;
    let prefix = "";
    if (hostname.endsWith("github.io")) {
      const segments = pathname.split("/").filter(Boolean);
      if (segments.length > 0) prefix = `/${segments[0]}`;
    }
    return `${prefix}/login/index.html`;
  } catch (_) {
    return "/login/index.html";
  }
}

// Function: checkSession — Verify session by calling /api/profile and return merged user
export async function checkSession() {
  try {
    const res = await fetch(`${API_BASE}/api/profile`, {
      credentials: "include",
    });

    if (res.status === 401 || res.status === 403) {
      window.location.assign(getLoginUrl());
      return null;
    }

    if (!res.ok) {
      console.error("Unexpected error from /api/profile:", res.status);
      return null;
    }

    const data = await res.json();
    const merged = { ...data.user, role: data.session.role };
    if (data.clientIp) merged.clientIp = data.clientIp;
    return merged;
  } catch (err) {
    console.error("Session check failed:", err);
    return null;
  }
}

const IDLE_LIMIT = 10 * 60 * 1000;
const WARNING_TIME = 3 * 60 * 1000;
let idleTimer;
let warningTimer;
let countdownInterval;

// Function: initIdleTimer — Initialize idle timers and activity listeners
export function initIdleTimer() {
  function resetIdleTimer() {
    clearTimeout(idleTimer);
    clearTimeout(warningTimer);
    clearInterval(countdownInterval);
    hideIdleWarning();
    const warningDelay = IDLE_LIMIT - WARNING_TIME;
    warningTimer = setTimeout(showIdleWarning, warningDelay);
    idleTimer = null;
  }

  ["mousemove", "keydown", "click", "scroll"].forEach((evt) =>
    document.addEventListener(evt, (e) => {
      if (
        document.getElementById("idleWarningModal") &&
        document.getElementById("idleWarningModal").style.display === "flex"
      ) {
        return;
      }
      resetIdleTimer(e);
    })
  );

  resetIdleTimer();
}

// Function: createIdleWarning — Placeholder (modal in page markup)
function createIdleWarning() {
  return;
}

// Function: showIdleWarning — Display idle-warning modal and handle countdown
function showIdleWarning() {
  const modal = document.getElementById("idleWarningModal");
  const countdownEl = document.getElementById("idleWarningCountdown");
  const textEl = document.getElementById("idleWarningText");
  if (!modal || !countdownEl || !textEl) return;

  let remainingMs = WARNING_TIME;

  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  modal.classList.remove("hidden");
  modal.style.display = "flex";
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  textEl.textContent =
    'Your session is about to expire due to inactivity. Please choose on "Continue" to stay logged in or you will be logged out automatically.';

  const extendBtn = document.getElementById("idleExtendBtn");
  const logoutBtn = document.getElementById("idleLogoutBtn");

  const cleanup = () => {
    clearInterval(countdownInterval);
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
  };

  if (extendBtn) {
    extendBtn.onclick = async () => {
      try {
        await fetch(`${API_BASE}/api/ping`, { credentials: "include" });
      } catch (err) {
        console.warn("Keepalive ping failed", err);
      }
      const ev = new Event("mousemove");
      document.dispatchEvent(ev);
      cleanup();
    };
  }

  if (logoutBtn) {
    logoutBtn.onclick = () => {
      cleanup();
      logoutUser();
    };
  }

  function update() {
    if (remainingMs <= 0) {
      countdownEl.textContent = "0:00";
      clearInterval(countdownInterval);
      logoutUser();
      return;
    }
    const totalSeconds = Math.floor(remainingMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    countdownEl.textContent = `${minutes}:${seconds
      .toString()
      .padStart(2, "0")}`;
    remainingMs -= 1000;
  }

  update();
  countdownInterval = setInterval(update, 1000);
}

// Function: hideIdleWarning — Hide idle modal and restore state
function hideIdleWarning() {
  const modal = document.getElementById("idleWarningModal");
  if (!modal) return;
  modal.style.display = "none";
  clearInterval(countdownInterval);
  if (document.body.dataset.prevOverflow !== undefined) {
    document.body.style.overflow = document.body.dataset.prevOverflow;
    delete document.body.dataset.prevOverflow;
  }
}

// Function: logoutUser — Perform logout and redirect to login
export async function logoutUser() {
  try {
    if (window.ptwLogout) {
      await window.ptwLogout();
      return;
    }
    await fetch(`${API_BASE}/api/logout`, {
      method: "POST",
      credentials: "include",
    });
  } catch (err) {
    console.error("Logout request failed:", err);
  } finally {
    try {
      sessionStorage.removeItem("accessToken");
    } catch (_) {}
    try {
      if (window.__ptw_broadcastSession)
        window.__ptw_broadcastSession({ type: "logout" });
    } catch (_) {}
    window.location.assign(getLoginUrl());
  }
}
