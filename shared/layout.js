// Smart API base detection: only set production URL when NOT in dev environment
// This allows dev (localhost/127.0.0.1) to work without explicit overrides
if (!window.__API_BASE__ && !localStorage.getItem("API_BASE")) {
  const { hostname } = window.location;
  // Only set production URL if NOT on localhost/127.0.0.1
  if (hostname !== "localhost" && hostname !== "127.0.0.1") {
    window.__API_BASE__ = "https://ptw-yu8u.onrender.com";
  }
}

// Minimal, robust layout scripting: theme + hamburger/sidebar behavior
(function () {
  // Toast helpers are now in shared/toast.js; keep a defensive guard in case it's not loaded.
  try {
    if (typeof window.showToast !== "function") {
      window.showToast = function (_type, _message) {
        /* no-op fallback */
      };
    }
    if (typeof window.dismissToast !== "function") {
      window.dismissToast = function (_el) {
        /* no-op fallback */
      };
    }
  } catch (_) {
    /* ignore */
  }
  // --- Global fetch interceptor for revoked sessions ---
  try {
    const origFetch = window.fetch.bind(window);
    // Helper to read per-tab access token (sessionStorage)
    function getAccessToken() {
      try {
        return sessionStorage.getItem("accessToken");
      } catch (_) {
        return null;
      }
    }

    // Broadcast helpers for session events (login/logout) to other tabs
    window.__ptw_broadcastSession = function (data) {
      try {
        localStorage.setItem(
          "ptw:session",
          JSON.stringify({ ts: Date.now(), ...data })
        );
      } catch (_) {
        /* ignore */
      }
    };

    window.__ptw_clearSessionBroadcast = function () {
      try {
        localStorage.removeItem("ptw:session");
      } catch (_) {}
    };

    // Listen for session broadcast events from other tabs and react in a conservative way.
    // Previously we reloaded on any session broadcast which caused tabs to flip state when
    // another tab logged in (or rotated the refresh cookie). That breaks multi-tab workflows
    // where different users want to remain signed-in in separate tabs. We'll only reload on
    // logout/session_expired or when a login for a different user is detected.
    window.addEventListener("storage", (ev) => {
      try {
        if (!ev.key) return;
        if (ev.key !== "ptw:session") return;
        const payload = (() => {
          try {
            return JSON.parse(ev.newValue || ev.oldValue || "{}");
          } catch (e) {
            return {};
          }
        })();

        const type = payload && payload.type;
        // Always reload on explicit logout or session expiry so UI clears sensitive state
        if (type === "logout" || type === "session_expired") {
          try {
            window.location.reload();
          } catch (_) {
            /* ignore */
          }
          return;
        }

        // On login: only reload if a different user signed in elsewhere. Many pages store a
        // per-tab `accessToken` and optionally a known `__USER_ID__` meta/global. If the
        // broadcast contains a userId and it doesn't match this tab's user, reload so cookie
        // state / server-side session is reflected. If it matches (same user), avoid reloading
        // to keep the current tab's per-tab token intact.
        if (type === "login") {
          const otherUserId = payload.userId || null;
          let localUser = null;
          try {
            if (window.__USER_ID__) localUser = String(window.__USER_ID__);
            else {
              const m = document.querySelector('meta[name="user-id"]');
              if (m && m.content) localUser = String(m.content);
            }
          } catch (e) {
            /* ignore */
          }

          // Also check sessionStorage for any stored per-tab userId (non-blocking)
          try {
            if (!localUser) localUser = sessionStorage.getItem("ptw:userId");
          } catch (_) {}

          // If otherUserId is present and different from localUser, reload to reflect new server session
          if (otherUserId && String(otherUserId) !== String(localUser)) {
            try {
              window.location.reload();
            } catch (_) {
              /* ignore */
            }
          }
          return;
        }
      } catch (_) {
        /* ignore */
      }
    });

    // Single-refresh lock and queue: ensures only one /api/refresh-token call runs at a time
    let __ptw_refreshPromise = null;

    function isReplayableBody(body) {
      try {
        if (!body) return true;
        if (typeof body === "string") return true;
        if (body instanceof FormData) return true;
        if (body instanceof URLSearchParams) return true;
        if (body instanceof Blob) return true;
        if (body instanceof ArrayBuffer) return true;
        if (ArrayBuffer.isView && ArrayBuffer.isView(body)) return true;
        return false;
      } catch (_) {
        return false;
      }
    }

    async function runRefreshOnce() {
      if (__ptw_refreshPromise) return __ptw_refreshPromise;
      __ptw_refreshPromise = (async () => {
        try {
          // call the existing helper which exchanges the httpOnly refresh cookie
          if (typeof window.ptwRefreshToken === "function") {
            const ok = await window.ptwRefreshToken();
            return !!ok;
          }
          // fallback: call the endpoint directly
          try {
            const r = await origFetch(apiUrl("/api/refresh-token"), {
              method: "POST",
              credentials: "include",
            });
            if (!r.ok) return false;
            const j = await r.json().catch(() => ({}));
            if (j && j.accessToken) {
              try {
                sessionStorage.setItem("accessToken", j.accessToken);
              } catch (_) {}
              return true;
            }
            return false;
          } catch (e) {
            return false;
          }
        } finally {
          // allow next refresh after this completes
          const p = __ptw_refreshPromise;
          __ptw_refreshPromise = null;
          return p;
        }
      })();
      return __ptw_refreshPromise;
    }

    window.fetch = async function (...args) {
      // Normalize args -> [url, options]
      const url = args[0];
      const options = Object.assign({}, args[1] || {});

      // ensure headers exist
      options.headers = options.headers || {};

      // Attach access token if available
      try {
        const token = getAccessToken();
        if (token) {
          if (typeof options.headers.set === "function")
            options.headers.set("Authorization", `Bearer ${token}`);
          else options.headers["Authorization"] = `Bearer ${token}`;
        }
      } catch (_) {}

      // Use a single attempt + one refresh retry. If body is not replayable, do not attempt retry.
      let attemptedRefresh = false;
      // Keep original body reference for replay check
      const originalBody = options.body;
      const canReplay = isReplayableBody(originalBody);

      // Build request args for invocation
      async function doRequest(opts) {
        const callArgs = [url, opts];
        return origFetch(...callArgs);
      }

      let res;
      try {
        res = await doRequest(options);
      } catch (e) {
        // network failure — propagate
        throw e;
      }

      // If 401 and we can attempt refresh, do so (only once)
      if (res && res.status === 401 && !attemptedRefresh && canReplay) {
        attemptedRefresh = true;
        try {
          const refreshed = await runRefreshOnce();
          if (refreshed) {
            // update Authorization header from newly stored token
            try {
              const newToken = getAccessToken();
              if (newToken) {
                if (typeof options.headers.set === "function")
                  options.headers.set("Authorization", `Bearer ${newToken}`);
                else options.headers["Authorization"] = `Bearer ${newToken}`;
              }
            } catch (_) {}

            // retry original request once
            try {
              const retryOpts = Object.assign({}, options, { _ptwRetry: true });
              res = await doRequest(retryOpts);
            } catch (e) {
              // if retry fails, fall through to return original response (or throw)
            }
          } else {
            // refresh failed: clear local access, show a friendly toast, notify other tabs,
            // and redirect to login after a short pause so the user can read the message.
            try {
              sessionStorage.removeItem("accessToken");
            } catch (_) {}
            try {
              if (window.__ptw_broadcastSession)
                window.__ptw_broadcastSession({ type: "session_expired" });
            } catch (_) {}
            try {
              try {
                if (window.showToast)
                  window.showToast(
                    "error",
                    "Your session expired — please sign in again."
                  );
              } catch (_) {}
              setTimeout(() => {
                try {
                  window.location.href = getLoginUrl
                    ? getLoginUrl()
                    : "/login/index.html";
                } catch (_) {
                  window.location.href = "/login/index.html";
                }
              }, 1400);
            } catch (_) {
              try {
                window.location.href = getLoginUrl
                  ? getLoginUrl()
                  : "/login/index.html";
              } catch (_) {
                window.location.href = "/login/index.html";
              }
            }
          }
        } catch (_) {
          /* ignore refresh errors */
        }
      }

      try {
        if (res && (res.status === 440 || res.status === 401)) {
          // Try to detect our specific code
          let code = "";
          try {
            const cloned = res.clone();
            const data = await cloned.json().catch(() => ({}));
            code = data && data.code;
          } catch (_) {
            /* ignore */
          }
          if (res.status === 440 || code === "SESSION_REVOKED") {
            // Notify user and redirect to login
            try {
              showSessionEndedNotice();
            } catch (_) {
              /* ignore */
            }
            try {
              if (window.showToast)
                window.showToast(
                  "error",
                  "Your session ended because it was used on another device. Please sign in again."
                );
            } catch (_) {
              /* ignore */
            }
            // Clear theme hints and redirect
            try {
              localStorage.removeItem("theme");
            } catch (_) {}
            try {
              sessionStorage.removeItem("theme");
            } catch (_) {}
            setTimeout(() => {
              window.location.href = getLoginUrl
                ? getLoginUrl()
                : "/login/index.html";
            }, 800);
          }
        }
      } catch (_) {
        /* ignore */
      }

      return res;
    };
  } catch (_) {
    /* ignore */
  }

  // Convenience logout helper used by pages to perform a logout and clear
  // per-tab access token storage, then notify other tabs to reload.
  try {
    window.ptwLogout = async function () {
      try {
        await fetch(apiUrl("/api/logout"), {
          method: "POST",
          credentials: "include",
        });
      } catch (_) {
        /* ignore network errors, still clear local state */
      }
      try {
        sessionStorage.removeItem("accessToken");
      } catch (_) {}
      try {
        sessionStorage.removeItem("ptw:userId");
      } catch (_) {}
      try {
        if (window.__ptw_broadcastSession)
          window.__ptw_broadcastSession({ type: "logout" });
      } catch (_) {}
      try {
        await findLoginAndRedirect();
      } catch (_) {
        try {
          window.location.href = getLoginUrl
            ? getLoginUrl()
            : "/login/index.html";
        } catch (_) {
          window.location.href = "/";
        }
      }
    };
  } catch (_) {
    /* ignore */
  }
  try {
    // Expose a programmatic refresh helper: attempts to exchange httpOnly refresh
    // cookie for a new access token and stores it in sessionStorage.
    window.ptwRefreshToken = async function () {
      try {
        const res = await fetch(apiUrl("/api/refresh-token"), {
          method: "POST",
          credentials: "include",
        });
        if (!res.ok) return false;
        const json = await res.json().catch(() => ({}));
        if (json && json.accessToken) {
          try {
            sessionStorage.setItem("accessToken", json.accessToken);
          } catch (_) {}
          return true;
        }
        return false;
      } catch (e) {
        return false;
      }
    };
  } catch (_) {
    /* ignore */
  }
  // --- Theme init & toggle ---
  try {
    const STORAGE_KEY = "theme";
    const USER_KEY_PREFIX = "theme_user_";
    // Migrate legacy page-specific key 'hia:theme' to the unified STORAGE_KEY if present.
    try {
      const legacy = localStorage.getItem("hia:theme");
      if (legacy && !localStorage.getItem(STORAGE_KEY)) {
        localStorage.setItem(STORAGE_KEY, legacy);
      }
    } catch (_) {
      /* ignore storage errors */
    }
    const root = document.documentElement;
    // Determine a logged-in user id if the server injected one (meta tag) or
    // a global override exists. This allows persisting a theme per-user so two
    // different users in the same browser profile don't clobber each other's
    // preference.
    let detectedUserId = null;
    try {
      if (window.__USER_ID__) detectedUserId = String(window.__USER_ID__);
    } catch (e) {
      /* ignore */
    }
    try {
      if (!detectedUserId) {
        const m = document.querySelector('meta[name="user-id"]');
        if (m && m.content) detectedUserId = String(m.content);
      }
    } catch (e) {
      /* ignore */
    }

    // Prefer sessionStorage for tab-scoped preference, then a per-user
    // localStorage key (if user known). Falling back to a generic localStorage
    // value keeps backwards compatibility for guest or legacy usage.
    const stored = (() => {
      try {
        if (detectedUserId) {
          const perUser = localStorage.getItem(
            USER_KEY_PREFIX + detectedUserId
          );
          if (perUser && perUser.trim()) return perUser.trim();
        }
        // sessionStorage keeps each tab independent (avoids cross-user clobbers)
        const sessionVal = sessionStorage.getItem(STORAGE_KEY);
        if (sessionVal && sessionVal.trim()) return sessionVal.trim();
        // fallback to legacy localStorage key
        try {
          return localStorage.getItem(STORAGE_KEY);
        } catch (_e) {
          return null;
        }
      } catch (e) {
        try {
          return sessionStorage.getItem(STORAGE_KEY);
        } catch (_e) {
          return null;
        }
      }
    })();
    const prefersDark =
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    const useDark = stored ? stored === "dark" : prefersDark;
    root.classList.toggle("dark", useDark);
    root.setAttribute("data-theme", useDark ? "dark" : "light");
    // also set on body for any code that checks body[data-theme]
    try {
      document.body.setAttribute("data-theme", useDark ? "dark" : "light");
    } catch (e) {
      /* ignore */
    }
    // initialization complete
    // Force body styles on initial load
    try {
      document.body.style.backgroundColor = "var(--bg-surface)";
      document.body.style.color = "var(--text-primary)";
    } catch (e) {
      /* ignore */
    }
  } catch (e) {
    /* ignore */
  }

  function applyThemeStyles() {
    // Force body styles to update using CSS variables
    document.body.style.backgroundColor = "var(--bg-surface)";
    document.body.style.color = "var(--text-primary)";
  }

  // Compute API base URL depending on where the page is served from (dev vs prod)
  function getApiBase() {
    try {
      // Allow an explicit override (set by server or inline script)
      if (
        window.__API_BASE__ &&
        typeof window.__API_BASE__ === "string" &&
        window.__API_BASE__.trim()
      ) {
        return window.__API_BASE__.trim();
      }
      // Allow local override via localStorage
      try {
        const ls = localStorage.getItem("API_BASE");
        if (ls && ls.trim()) return ls.trim();
      } catch (_) {}
      // Allow a meta tag to be used by server-side templating to inject API base
      try {
        const meta = document.querySelector('meta[name="api-base"]');
        if (meta && meta.content && meta.content.trim())
          return meta.content.trim();
      } catch (_) {}

      const DEFAULT_PROD = "https://ptw-yu8u.onrender.com";
      const { protocol, hostname, port } = window.location;

      // Live Server default port is 5500; many dev setups use 3000, 8080, etc.
      // Map common static dev ports back to the backend port 5000 so fetches work
      // when front-end is served separately in development.
      if (hostname === "127.0.0.1" || hostname === "localhost") {
        const devToBackend = new Set(["5500", "3000", "8080"]);
        if (port && devToBackend.has(port))
          return `${protocol}//${hostname}:5000`;
        // If front-end and backend are intentionally same-origin (no mapping),
        // return same-origin so relative paths work.
        return `${protocol}//${hostname}${port ? `:${port}` : ""}`;
      }

      // If served via file:// (local file open), fall back to production backend
      if (!hostname || window.location.protocol === "file:")
        return DEFAULT_PROD;

      // For non-localhost hosts, prefer same-origin if the backend is hosted on the
      // same origin (i.e., reverse-proxy), otherwise fall back to configured prod.
      // We can't reliably detect reverse-proxy from client JS, so prefer a safe
      // default: if the current origin equals DEFAULT_PROD use same-origin, else
      // return DEFAULT_PROD so API calls go to the dedicated backend.
      try {
        const origin = `${protocol}//${hostname}${port ? `:${port}` : ""}`;
        if (origin === DEFAULT_PROD) return origin;
      } catch (_) {}
      return DEFAULT_PROD;
    } catch (_) {
      return "";
    }
  }

  function apiUrl(path) {
    const base = getApiBase();
    if (!base) return path; // same-origin
    // ensure single slash join
    return path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;
  }

  function persistTheme(theme) {
    try {
      // write tab-scoped value (avoids cross-tab/user clobbering)
      try {
        sessionStorage.setItem(STORAGE_KEY, theme);
      } catch (_e) {
        /* ignore */
      }
      // if we detected a user id, persist per-user in localStorage so the
      // preference follows that user across tabs. Otherwise keep legacy
      // behaviour and write a generic localStorage value.
      try {
        if (detectedUserId) {
          localStorage.setItem(USER_KEY_PREFIX + detectedUserId, theme);
        } else {
          localStorage.setItem(STORAGE_KEY, theme);
        }
      } catch (_e) {
        /* ignore */
      }
      // also write to sessionStorage for compatibility with other scripts (again)
    } catch (_e) {}
  }

  function toggleTheme() {
    const root = document.documentElement;
    const next = root.classList.contains("dark") ? "light" : "dark";
    root.classList.toggle("dark", next === "dark");
    root.setAttribute("data-theme", next);
    try {
      document.body.setAttribute("data-theme", next);
    } catch (e) {
      /* ignore */
    }
    persistTheme(next);
    applyThemeStyles(); // Force styles to update
    // dispatch a custom event so other scripts can react and for debugging
    try {
      window.dispatchEvent(
        new CustomEvent("theme:changed", { detail: { theme: next } })
      );
    } catch (e) {
      /* ignore */
    }
    // Update any theme-toggle icons so they reflect the new state
    try {
      updateThemeToggleIcons();
    } catch (e) {
      /* ignore */
    }
  }

  // Update icons inside elements with [data-theme-toggle] to reflect current theme
  function updateThemeToggleIcons() {
    const isDark = document.documentElement.classList.contains("dark");
    document.querySelectorAll("[data-theme-toggle]").forEach((el) => {
      // If the control already has FontAwesome moon/sun icons (desktop), leave them
      // to be handled by CSS. Otherwise create/update a single icon element.
      const hasFaMoon = !!el.querySelector("i.fa-moon");
      const hasFaSun = !!el.querySelector("i.fa-sun");

      if (hasFaMoon || hasFaSun) {
        // animate the visible icon(s) if present
        const icons = Array.from(
          el.querySelectorAll("i.fa-moon, i.fa-sun, i.icon-sun, i.icon-moon")
        );
        icons.forEach((ic) => {
          try {
            const style = window.getComputedStyle(ic);
            // CSS now uses opacity/visibility to show/hide icons; animate only the
            // currently visible one (opacity > 0).
            const isVisible =
              style && style.opacity && parseFloat(style.opacity) > 0;
            if (isVisible) {
              ic.classList.add("rotating");
              setTimeout(() => ic.classList.remove("rotating"), 360);
            }
          } catch (e) {
            /* ignore */
          }
        });
        // set accessible label/title
        const label = isDark ? "Dark mode" : "Light mode";
        el.setAttribute("aria-label", label);
        el.title = label;
      } else {
        // find or create the <i> indicator inside the control
        let icon = el.querySelector("i.icon-toggle");
        if (!icon) {
          icon = document.createElement("i");
          // no extra margin class here so spacing matches navbar
          icon.className = "fas icon-toggle";
          el.insertBefore(icon, el.firstChild);
        }

        // animate rotation for visual feedback
        icon.classList.add("rotating");
        // remove the rotating class after the transition duration (safe fallback)
        setTimeout(() => icon.classList.remove("rotating"), 360);

        // set classes (swap fa-moon / fa-sun)
        // show moon when dark, sun when light
        if (isDark) {
          icon.classList.remove("fa-sun");
          icon.classList.add("fa-moon");
        } else {
          icon.classList.remove("fa-moon");
          icon.classList.add("fa-sun");
        }

        // update label text (if present)
        const labelSpan = el.querySelector("span.theme-label");
        if (labelSpan)
          labelSpan.textContent = isDark ? "Dark mode" : "Light mode";
        const label = isDark ? "Dark mode" : "Light mode";
        el.setAttribute("aria-label", label);
        el.title = label;
      }
    });
  }

  // Attach direct listeners to theme toggle controls for reliability. This
  // avoids edge cases where event.target may be a text node and closest()
  // checks fail. Also support keyboard activation (Enter / Space).
  const toggleElements = document.querySelectorAll("[data-theme-toggle]");
  toggleElements.forEach((el) => {
    el.addEventListener("click", (ev) => {
      ev.preventDefault();
      toggleTheme();
    });
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        toggleTheme();
      }
    });
  });

  // initialize theme toggle icons on load
  try {
    updateThemeToggleIcons();
  } catch (e) {
    /* ignore */
  }

  // --- Submit New Request (Permit) modal wiring ---
  (function permitModal() {
    const modal = document.getElementById("permit-form-modal");
    if (!modal) return; // layout without modal
    const permitOverlay = modal.querySelector("[data-permit-overlay]");
    const btnClose = modal.querySelector("[data-permit-close]");
    const btnCancel = modal.querySelector("[data-permit-cancel]");
    const btnSubmit = modal.querySelector("[data-permit-submit]");
    const bodyEl = document.getElementById("permit-modal-body");

    let formRoot = null;
    let filesInput = null;
    let updateFileUploadVisibilityFn = null; // set when handlers init

    function open() {
      if (modal.classList.contains("hidden")) modal.classList.remove("hidden");
      // find embedded form in modal
      formRoot = modal.querySelector("#permitForm");
      if (!formRoot) return;
      // Initialize once per page load
      if (!formRoot.dataset.wired) {
        initFormHandlers();
        formRoot.dataset.wired = "1";
      }
      // Prefill each time modal opens
      prefillFromProfile().catch(() => {});
    }
    function close() {
      modal.classList.add("hidden");
    }

    // Expose a safe global opener so feature pages (e.g., profile) can call it
    try {
      window.openPermitModal = () => {
        open();
        return true;
      };
    } catch (_) {}

    async function prefillFromProfile() {
      if (!formRoot) return;
      try {
        const res = await fetch(apiUrl("/api/profile"), {
          credentials: "include",
        });
        if (!res.ok) return;
        const data = await res.json();
        const u = data && data.user ? data.user : {};

        const nameSource = (u.fullName || u.username || "").trim();
        let firstName = nameSource;
        let lastName = "";
        if (nameSource.includes(" ")) {
          const parts = nameSource.split(/\s+/);
          firstName = parts.shift();
          lastName = parts.join(" ");
        }

        const setIfEmpty = (sel, val) => {
          const el = formRoot.querySelector(sel);
          if (el && !el.value && val) el.value = val;
        };

        // Requester Details
        setIfEmpty("#fullName", firstName);
        setIfEmpty("#lastName", lastName);
        setIfEmpty("#corpemailid", u.email || "");
        // Prefer mobile fields commonly used in profile
        const phone =
          u.mobile ||
          u.mobileNumber ||
          u.phone ||
          u.phoneNumber ||
          (u.contact && (u.contact.mobile || u.contact.phone)) ||
          "";
        setIfEmpty("#contactdetails", phone);

        // No signature fields in modal anymore
      } catch (_) {
        /* ignore prefill failures */
      }
    }

    function toggleHidden(el, show) {
      if (!el) return;
      if (show) el.classList.remove("hidden");
      else el.classList.add("hidden");
    }

    function initFormHandlers() {
      if (!formRoot) return;

      // Initialize flatpickr if available, else provide a graceful fallback
      try {
        const startEl = formRoot.querySelector("#startDateTime");
        const endEl = formRoot.querySelector("#endDateTime");
        if (window.flatpickr && startEl && endEl) {
          let endPicker;
          const startPicker = window.flatpickr(startEl, {
            enableTime: true,
            dateFormat: "Y-m-d H:i",
            minDate: "today",
            allowInput: false,
            onOpen: function (_, __, fp) {
              fp.set("minDate", new Date());
            },
            onChange: function (selectedDates) {
              const start =
                selectedDates && selectedDates[0] ? selectedDates[0] : null;
              if (endPicker && start) {
                endPicker.set("minDate", start);
                const end =
                  endPicker.selectedDates && endPicker.selectedDates[0];
                if (!end || end <= start) {
                  // set end = start + 30 minutes
                  const next = new Date(start.getTime() + 30 * 60000);
                  endPicker.setDate(next, true);
                }
              }
            },
          });
          endPicker = window.flatpickr(endEl, {
            enableTime: true,
            dateFormat: "Y-m-d H:i",
            minDate: "today",
            allowInput: false,
            onOpen: function (_, __, fp) {
              fp.set("minDate", new Date());
            },
          });
        } else {
          // Fallback: allow manual input if flatpickr unavailable
          if (startEl) startEl.removeAttribute("readonly");
          if (endEl) endEl.removeAttribute("readonly");
        }
      } catch (_) {}

      // Terminal -> Facility and specify fields (fetched from backend lookups)
      const terminalSel = formRoot.querySelector("#terminal");
      const facilityContainer = formRoot.querySelector("#facilityContainer");
      const facilitySel = formRoot.querySelector("#facility");
      const specifyTerminalContainer = formRoot.querySelector(
        "#specifyTerminalContainer"
      );
      const specifyFacilityContainer = formRoot.querySelector(
        "#specifyFacilityContainer"
      );
      const equipmentTypeSel = formRoot.querySelector("#equipmentTypeInput");
      const natureOfWorkSel = formRoot.querySelector("#natureOfWork");

      let lookups = null; // cache within modal lifecycle

      function populateSelect(selectEl, placeholder, values) {
        if (!selectEl) return;
        selectEl.innerHTML = "";
        const ph = document.createElement("option");
        ph.value = "";
        ph.disabled = true;
        ph.selected = true;
        ph.textContent = placeholder;
        selectEl.appendChild(ph);
        (values || []).forEach((val) => {
          const opt = document.createElement("option");
          opt.value = val;
          opt.textContent = val;
          selectEl.appendChild(opt);
        });
      }

      function populateFacilities(list) {
        populateSelect(facilitySel, "Select the Facility", list || []);
      }

      const updateTerminal = () => {
        if (!terminalSel) return;
        const val = terminalSel.value;
        const isOther = val === "Other";
        if (
          val &&
          !isOther &&
          lookups &&
          lookups.facilities &&
          lookups.facilities[val]
        ) {
          populateFacilities(lookups.facilities[val]);
          toggleHidden(facilityContainer, true);
          toggleHidden(specifyTerminalContainer, false);
          toggleHidden(specifyFacilityContainer, false);
        } else if (isOther) {
          toggleHidden(facilityContainer, false);
          toggleHidden(specifyTerminalContainer, true);
          toggleHidden(specifyFacilityContainer, true);
          if (facilitySel) {
            facilitySel.selectedIndex = 0;
          }
        } else {
          toggleHidden(facilityContainer, false);
          toggleHidden(specifyTerminalContainer, false);
          toggleHidden(specifyFacilityContainer, false);
        }
      };

      async function loadLookupsAndPopulate() {
        // Fetch lookups from backend and populate selects
        try {
          const res = await fetch(apiUrl("/api/lookups"), {
            credentials: "include",
          });
          if (res.ok) {
            lookups = await res.json();
          } else {
            // fallback to built-in defaults if backend unavailable
            lookups = {
              terminals: ["PTC", "RTBF", "QROC", "Other"],
              facilities: {
                PTC: [
                  "Arrival Hall",
                  "Baggage Hall",
                  "BHS Baggage Control Room",
                  "Concourse Alpha",
                  "Concourse Bravo",
                  "Concourse Charlie",
                  "Departure Hall",
                  "DSF Area",
                  "Terminating Alpha",
                  "Terminating Bravo",
                  "Concourse Alpha Basement",
                  "Concourse Bravo Basement",
                  "HLC Server Room",
                  "HBSS Server Room",
                  "MOI Break Room",
                  "Custom OSR Room (Concourse Alpha)",
                  "Custom OSR Room (Concourse Bravo)",
                ],
                RTBF: [
                  "Baggage Hall",
                  "Control Room",
                  "Staff Break Room",
                  "OSR Room",
                  "Transfer Area",
                  "Customer Service Building",
                  "Employee Service Building",
                  "Stagging Area",
                ],
                QROC: [
                  "Arrival Area",
                  "Departure Area",
                  "Baggage Hall",
                  "BHS Baggage Control Room",
                ],
              },
              equipmentTypes: [
                "BHS",
                "PLB - Passenger Loading Bridge",
                "VDGS - Visual Docking Guidance System",
                "High Speed Shutter Door",
              ],
              natureOfWork: [
                "Project",
                "Fault",
                "Preventive Maintenance",
                "Corrective Maintenance",
                "Snag Work",
              ],
            };
          }
        } catch (_) {
          // same fallback if network error
          lookups = lookups || {
            terminals: ["PTC", "RTBF", "QROC", "Other"],
            facilities: {
              PTC: [
                "Arrival Hall",
                "Baggage Hall",
                "BHS Baggage Control Room",
                "Concourse Alpha",
                "Concourse Bravo",
                "Concourse Charlie",
                "Departure Hall",
                "DSF Area",
                "Terminating Alpha",
                "Terminating Bravo",
                "Concourse Alpha Basement",
                "Concourse Bravo Basement",
                "HLC Server Room",
                "HBSS Server Room",
                "MOI Break Room",
                "Custom OSR Room (Concourse Alpha)",
                "Custom OSR Room (Concourse Bravo)",
              ],
              RTBF: [
                "Baggage Hall",
                "Control Room",
                "Staff Break Room",
                "OSR Room",
                "Transfer Area",
                "Customer Service Building",
                "Employee Service Building",
                "Stagging Area",
              ],
              QROC: [
                "Arrival Area",
                "Departure Area",
                "Baggage Hall",
                "BHS Baggage Control Room",
              ],
            },
            equipmentTypes: [
              "BHS",
              "PLB - Passenger Loading Bridge",
              "VDGS - Visual Docking Guidance System",
              "High Speed Shutter Door",
            ],
            natureOfWork: [
              "Project",
              "Fault",
              "Preventive Maintenance",
              "Corrective Maintenance",
              "Snag Work",
            ],
          };
        }

        // Populate terminal list
        if (terminalSel)
          populateSelect(
            terminalSel,
            "Select the Terminal",
            lookups.terminals || []
          );
        // Populate equipment types
        if (equipmentTypeSel)
          populateSelect(
            equipmentTypeSel,
            "Select Equipment Type",
            lookups.equipmentTypes || []
          );
        // Populate nature of work
        if (natureOfWorkSel)
          populateSelect(
            natureOfWorkSel,
            "Select Nature of Work",
            lookups.natureOfWork || []
          );

        // Sync facilities based on current terminal selection
        updateTerminal();
      }

      if (terminalSel) {
        terminalSel.addEventListener("change", updateTerminal);
        // Load lookups once and initialize all dependent selects
        loadLookupsAndPopulate();
      }

      // Impact -> dependent fields
      const impactSel = formRoot.querySelector("#impact");
      const levelOfImpactContainer = formRoot.querySelector(
        "#levelOfImpactContainer"
      );
      const equipmentType = formRoot.querySelector("#equipmentType");
      const impactDetails = formRoot.querySelector("#impactDetails");
      if (impactSel) {
        const updateImpact = () => {
          const yes = impactSel.value === "Yes";
          toggleHidden(levelOfImpactContainer, yes);
          toggleHidden(equipmentType, yes);
          toggleHidden(impactDetails, yes);
        };
        impactSel.addEventListener("change", updateImpact);
        // Initialize visibility on load
        updateImpact();
      }

      // Radios with dependent reason inputs
      function wireRadioPair(name, yesId, noId, containerId) {
        const yes = formRoot.querySelector("#" + yesId);
        const no = formRoot.querySelector("#" + noId);
        const cont = formRoot.querySelector("#" + containerId);
        // when NO is selected, show reason textbox and require it; otherwise hide and remove required
        const update = () => {
          const showReason = no && no.checked;
          toggleHidden(cont, showReason);
          if (cont) {
            const input = cont.querySelector("input,textarea,select");
            if (input) input.required = !!showReason;
          }
          updateFileUploadVisibility();
        };
        if (yes) yes.addEventListener("change", update);
        if (no) no.addEventListener("change", update);
        // Set initial state
        update();
      }
      wireRadioPair("ePermit", "ePermitYes", "ePermitNo", "ePermitDetails");
      wireRadioPair(
        "fmmWorkorder",
        "fmmWorkorderYes",
        "fmmWorkorderNo",
        "fmmwrkordr"
      );
      wireRadioPair("hseRisk", "hseRiskYes", "hseRiskNo", "hseassmnt");
      wireRadioPair("opRisk", "opRiskYes", "opRiskNo", "opsassmnt");

      // File upload list + validation + preview + remove
      filesInput = formRoot.querySelector("#fileUpload");
      const uploadedList = formRoot.querySelector("#uploadedFiles");
      const fileMsg = formRoot.querySelector("#fileTypeMessage");
      const allowedExt = ["pdf", "jpeg", "jpg"];
      let selectedFiles = [];

      function fileKey(f) {
        return `${f.name}|${f.size}|${f.lastModified || 0}`;
      }
      function syncInputFiles() {
        if (!filesInput) return;
        const dt = new DataTransfer();
        selectedFiles.forEach((f) => dt.items.add(f));
        filesInput.files = dt.files;
      }
      function clearSelectedFiles() {
        selectedFiles = [];
        syncInputFiles();
        if (uploadedList) uploadedList.innerHTML = "";
        if (fileMsg) fileMsg.textContent = "";
      }

      // expose a clear hook so global reset can purge this state
      if (modal) modal._permitClearFiles = clearSelectedFiles;

      function validateAndRenderFiles() {
        if (!uploadedList) return { valid: true, files: [] };
        uploadedList.innerHTML = "";
        if (fileMsg) fileMsg.textContent = "";
        let allValid = true;
        selectedFiles.forEach((f, idx) => {
          const ext = (f.name.split(".").pop() || "").toLowerCase();
          const sizeOk = f.size <= 3 * 1024 * 1024; // 3MB
          const typeOk = allowedExt.includes(ext);
          const li = document.createElement("li");
          const sizeKB = Math.max(1, Math.round(f.size / 1024));
          li.innerHTML = `
            <span>${f.name} (${sizeKB} KB)</span>
            <button type="button" data-preview-index="${idx}" class="inline-flex items-center px-2 py-0.5 rounded border text-xs ml-2">Preview</button>
            <button type="button" data-remove-index="${idx}" class="inline-flex items-center px-2 py-0.5 rounded border text-xs ml-2 text-red-600 border-red-400">Remove</button>
          `;
          if (!sizeOk || !typeOk) {
            allValid = false;
            const reason = !typeOk
              ? "Invalid file type"
              : "File too large (>3MB)";
            const warn = document.createElement("span");
            warn.textContent = ` - ${reason}`;
            warn.style.color = "var(--error-color)";
            li.appendChild(warn);
          }
          uploadedList.appendChild(li);
        });
        return { valid: allValid, files: selectedFiles.slice() };
      }

      function handleFileChange() {
        if (!filesInput) return;
        const incoming = Array.from(filesInput.files || []);
        // merge unique by name+size+lastModified
        const seen = new Set(selectedFiles.map(fileKey));
        incoming.forEach((f) => {
          const k = fileKey(f);
          if (!seen.has(k)) {
            selectedFiles.push(f);
            seen.add(k);
          }
        });
        // reflect in input.files for form submission
        syncInputFiles();
        validateAndRenderFiles();
      }

      if (filesInput && uploadedList) {
        filesInput.addEventListener("change", handleFileChange);
        uploadedList.addEventListener("click", (e) => {
          const tgt = e.target;
          if (!tgt) return;
          const previewBtn = tgt.closest("[data-preview-index]");
          const removeBtn = tgt.closest("[data-remove-index]");
          if (previewBtn) {
            const idx = parseInt(
              previewBtn.getAttribute("data-preview-index"),
              10
            );
            const f = selectedFiles[idx];
            if (!f) return;
            const url = URL.createObjectURL(f);
            window.open(url, "_blank");
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
            return;
          }
          if (removeBtn) {
            const idx = parseInt(
              removeBtn.getAttribute("data-remove-index"),
              10
            );
            if (
              Number.isInteger(idx) &&
              idx >= 0 &&
              idx < selectedFiles.length
            ) {
              selectedFiles.splice(idx, 1);
              syncInputFiles();
              validateAndRenderFiles();
            }
          }
        });
      }

      // Update file-upload section visibility based on required-docs radios
      function anyRequiredDocsYes() {
        const ids = [
          "ePermitYes",
          "fmmWorkorderYes",
          "hseRiskYes",
          "opRiskYes",
        ];
        return ids.some((id) => {
          const el = formRoot.querySelector("#" + id);
          return el && el.checked;
        });
      }
      function updateFileUploadVisibility() {
        const sec = formRoot.querySelector("#fileUploadSection");
        const legend = formRoot.querySelector("#fileUploadLegend");
        const show = anyRequiredDocsYes();
        toggleHidden(sec, show);
        toggleHidden(legend, show);
        if (!show && filesInput) {
          // also clear our tracked list when section hides
          clearSelectedFiles();
        }
      }
      // initial sync
      updateFileUploadVisibility();

      // Expose for use in reset
      updateFileUploadVisibilityFn = updateFileUploadVisibility;

      function updateFileUploadVisibilityWrapper() {
        updateFileUploadVisibility();
      }
      // Fallback: also watch changes on the fieldset for document radios
      const docsFieldset = formRoot
        .querySelector("section fieldset legend h3")
        ?.textContent?.includes("Required Documents")
        ? formRoot.querySelector("section fieldset").parentElement
        : null;
      if (docsFieldset) {
        docsFieldset.addEventListener(
          "change",
          updateFileUploadVisibilityWrapper
        );
      }

      // Ensure Enter key or native submit triggers our handler too
      try {
        formRoot.addEventListener("submit", (e) => {
          e.preventDefault();
          handleSubmit();
        });
      } catch (_) {
        /* ignore */
        if (window._registerEmailExists) {
          if (window.showToast)
            window.showToast("error", "Email already exists");
          return;
        }
        if (window._registerMobileExists) {
          if (window.showToast)
            window.showToast("error", "Mobile number already exists");
          return;
        }
      }

      // Attach database validation on blur for email and phone
      const emailInput = formRoot.querySelector("#corpemailid");
      const phoneInput = formRoot.querySelector("#contactdetails");
      if (emailInput)
        emailInput.addEventListener("blur", () => validateAgainstDB("email"));
      if (phoneInput)
        phoneInput.addEventListener("blur", () => validateAgainstDB("phone"));

      async function validateAgainstDB(kind) {
        try {
          const res = await fetch(apiUrl("/api/profile"), {
            credentials: "include",
          });
          const data = await res.json();
          const u = data && data.user ? data.user : {};
          const emailDB = u.email || "";
          const phoneDB = u.phone || u.mobile || u.mobileNumber || "";
          if (kind === "email" && emailInput) {
            if (
              emailInput.value &&
              emailDB &&
              emailInput.value.trim().toLowerCase() !==
                emailDB.trim().toLowerCase()
            ) {
              emailInput.setCustomValidity(
                "Email does not match your registered email"
              );
              window.showToast &&
                window.showToast(
                  "error",
                  "Email does not match your registered email"
                );
            } else {
              emailInput.setCustomValidity("");
            }
          }
          if (kind === "phone" && phoneInput) {
            if (
              phoneInput.value &&
              phoneDB &&
              phoneInput.value.trim() !== phoneDB.trim()
            ) {
              phoneInput.setCustomValidity(
                "Mobile number does not match your registered number"
              );
              window.showToast &&
                window.showToast(
                  "error",
                  "Mobile number does not match your registered number"
                );
            } else {
              phoneInput.setCustomValidity("");
            }
          }
        } catch (_) {
          /* ignore */
        }
      }
    }

    async function handleSubmit() {
      if (!formRoot) return;
      try {
        // Custom validation only (no native HTML5 validation)
        const errors = [];
        const getVal = (sel) => {
          const el = formRoot.querySelector(sel);
          return el ? (el.value || "").trim() : "";
        };
        const nonEmpty = (v) => v && v.length > 0;

        // Requester details must be present (read-only)
        if (!nonEmpty(getVal("#fullName")))
          errors.push("Missing requester first name");
        if (!nonEmpty(getVal("#lastName")))
          errors.push("Missing requester last name");
        if (!nonEmpty(getVal("#corpemailid")))
          errors.push("Missing requester email");
        if (!nonEmpty(getVal("#contactdetails")))
          errors.push("Missing requester mobile");

        // Work basics
        if (!nonEmpty(getVal("#permitTitle")))
          errors.push("Permit Title is required");
        const terminal = getVal("#terminal");
        if (!nonEmpty(terminal)) errors.push("Terminal is required");
        if (terminal === "Other") {
          if (!nonEmpty(getVal("#specifyTerminal")))
            errors.push("Specify Terminal is required");
          if (!nonEmpty(getVal("#specifyFacility")))
            errors.push("Specify Facility is required");
        } else if (nonEmpty(terminal)) {
          // require facility when a known terminal is selected
          if (!nonEmpty(getVal("#facility")))
            errors.push("Facility is required");
        }

        const impact = getVal("#impact");
        if (!nonEmpty(impact)) errors.push("Impact selection is required");
        if (impact === "Yes") {
          if (!nonEmpty(getVal("#levelOfImpact")))
            errors.push("Level of Impact is required");
          if (!nonEmpty(getVal("#equipmentTypeInput")))
            errors.push("Equipment Type is required");
          if (!nonEmpty(getVal("#impactDetailsInput")))
            errors.push("Affected Equipment Details are required");
        }

        if (!nonEmpty(getVal("#natureOfWork")))
          errors.push("Nature of Work is required");
        if (!nonEmpty(getVal("#workDescription")))
          errors.push("Work Description is required");

        // --- Required documents validation (see section below for details) ---
        const docGroups = [
          {
            yes: "#ePermitYes",
            no: "#ePermitNo",
            label: "e-Permit",
            reasonInput: "#ePermitReason",
          },
          {
            yes: "#fmmWorkorderYes",
            no: "#fmmWorkorderNo",
            label: "FMM Workorder",
            reasonInput: "#noFmmWorkorder",
          },
          {
            yes: "#hseRiskYes",
            no: "#hseRiskNo",
            label: "HSE Risk Assessment",
            reasonInput: "#noHseRiskAssessmentReason",
          },
          {
            yes: "#opRiskYes",
            no: "#opRiskNo",
            label: "Operations Risk Assessment",
            reasonInput: "#noOpsRiskAssessmentReason",
          },
        ];
        let anyDocYes = false;
        docGroups.forEach((g) => {
          const yes = formRoot.querySelector(g.yes);
          const no = formRoot.querySelector(g.no);
          if ((!yes || !yes.checked) && (!no || !no.checked)) {
            errors.push(`Please select Yes/No for ${g.label}`);
          }
          if (yes && yes.checked) anyDocYes = true;
          if (no && no.checked && g.reasonInput) {
            if (!nonEmpty(getVal(g.reasonInput)))
              errors.push(`Reason for No ${g.label} is required`);
          }
        });

        // If any doc group is Yes, at least one document must be uploaded
        const allowedExt = ["pdf", "jpeg", "jpg"];
        if (anyDocYes) {
          const files =
            filesInput && filesInput.files ? Array.from(filesInput.files) : [];
          if (!files.length)
            errors.push(
              "Please upload required document(s) for the selected items"
            );
          files.forEach((f) => {
            const ext = (f.name.split(".").pop() || "").toLowerCase();
            if (!allowedExt.includes(ext))
              errors.push(`Invalid file type: ${f.name}`);
            if (f.size > 3 * 1024 * 1024)
              errors.push(`File too large (>3MB): ${f.name}`);
          });
        }

        // Date/time (validated after Required Documents so users see doc errors first)
        const startStr = getVal("#startDateTime");
        const endStr = getVal("#endDateTime");
        if (!nonEmpty(startStr)) errors.push("Start Date & Time is required");
        if (!nonEmpty(endStr)) errors.push("End Date & Time is required");
        if (nonEmpty(startStr) && nonEmpty(endStr)) {
          const start = new Date(startStr.replace(" ", "T"));
          const end = new Date(endStr.replace(" ", "T"));
          const now = new Date();
          if (isNaN(start) || isNaN(end)) errors.push("Invalid date/time");
          if (!isNaN(start) && start < now)
            errors.push("Start Date & Time cannot be in the past");
          if (!isNaN(end) && end <= start)
            errors.push("End Date & Time must be after Start Date & Time");
        }

        // Conditions
        const confirmEl = formRoot.querySelector("#confirmConditions");
        if (!confirmEl || !confirmEl.checked)
          errors.push("Please agree to the conditions");

        // (moved Required Documents validation above)

        // DB validations (compare with current user)
        try {
          const res = await fetch(apiUrl("/api/profile"), {
            credentials: "include",
          });
          if (res.ok) {
            const data = await res.json();
            const u = data && data.user ? data.user : {};
            const emailDB = (u.email || "").trim().toLowerCase();
            const phoneDB = (
              u.phone ||
              u.mobile ||
              u.mobileNumber ||
              ""
            ).trim();
            const emailVal = getVal("#corpemailid").toLowerCase();
            const phoneVal = getVal("#contactdetails");
            if (emailDB && emailVal && emailVal !== emailDB)
              errors.push("Email does not match your registered email");
            if (phoneDB && phoneVal && phoneVal !== phoneDB)
              errors.push(
                "Mobile number does not match your registered number"
              );
          }
        } catch (_) {
          /* ignore */
        }

        if (errors.length) {
          if (window.showToast) window.showToast("error", errors[0]);
          else alert(errors[0]);
          return;
        }

        // Required documents -> show message if invalid files already signaled by fileMsg
        const fileMsg = formRoot.querySelector("#fileTypeMessage");
        if (fileMsg && fileMsg.textContent) {
          if (window.showToast) window.showToast("error", fileMsg.textContent);
          else alert(fileMsg.textContent);
          return;
        }

        const fd = new FormData(formRoot);
        // Ensure multiple files appended if present (FormData captures automatically by name="files")

        // Submit
        if (btnSubmit) {
          btnSubmit.disabled = true;
          btnSubmit.textContent = "Submitting...";
        }
        const res = await fetch(apiUrl("/api/permit"), {
          method: "POST",
          credentials: "include",
          body: fd,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg =
            data && data.message ? data.message : "Failed to submit request";
          if (window.showToast) window.showToast("error", msg);
          else alert(msg);
          if (btnSubmit) {
            btnSubmit.disabled = false;
            btnSubmit.textContent = "Submit";
          }
          return;
        }
        // Show success message
        if (window.showToast)
          window.showToast("success", "Request submitted successfully");
        else alert("Request submitted successfully");
        // Clear the form so the next open starts fresh
        try {
          resetPermitForm();
        } catch (_) {}
        close();
        try {
          window.dispatchEvent(
            new CustomEvent("permit:submitted", { detail: data })
          );
        } catch (_) {}
      } catch (e) {
        if (window.showToast)
          window.showToast("error", "Network error while submitting");
        else alert("Network error while submitting");
      } finally {
        if (btnSubmit) {
          btnSubmit.disabled = false;
          btnSubmit.textContent = "Submit";
        }
      }
    }

    // open/close wiring
    document.addEventListener("click", (ev) => {
      const a =
        ev.target &&
        ev.target.closest &&
        ev.target.closest('[data-action="submit-new-request"]');
      if (a) {
        ev.preventDefault();
        open();
      }
    });
    if (permitOverlay)
      permitOverlay.addEventListener("click", () => {
        try {
          resetPermitForm();
        } catch (_) {}
        close();
      });
    if (btnClose)
      btnClose.addEventListener("click", () => {
        try {
          resetPermitForm();
        } catch (_) {}
        close();
      });
    if (btnCancel)
      btnCancel.addEventListener("click", () => {
        try {
          resetPermitForm();
        } catch (_) {}
        close();
      });
    // Direct binding if the button was found at script init
    if (btnSubmit)
      btnSubmit.addEventListener("click", (e) => {
        e.preventDefault();
        // prevent delegated handler from also firing on the same click
        try {
          e.stopImmediatePropagation();
        } catch (_) {}
        try {
          e.stopPropagation();
        } catch (_) {}
        handleSubmit();
      });

    // Robust fallback: delegate clicks so it works even if the specific element
    // wasn’t found at init time (e.g., due to dynamic mounting order)
    document.addEventListener("click", (ev) => {
      const b =
        ev.target &&
        ev.target.closest &&
        ev.target.closest("[data-permit-submit]");
      if (!b) return;
      ev.preventDefault();
      handleSubmit();
    });

    // ESC key should also clear and close the permit modal
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && !modal.classList.contains("hidden")) {
        try {
          resetPermitForm();
        } catch (_) {}
        close();
      }
    });
  })();

  // Utility: clear the permit form to pristine state
  function resetPermitForm() {
    try {
      const modal = document.getElementById("permit-form-modal");
      if (!modal) return;
      const form = modal.querySelector("#permitForm");
      if (!form) return;

      // Clear all field values and selections
      form.reset();

      // Clear file input and list (and any tracked selection in modal wiring)
      const fileInput = form.querySelector("#fileUpload");
      const fileList = form.querySelector("#uploadedFiles");
      const fileMsg = form.querySelector("#fileTypeMessage");
      if (modal && typeof modal._permitClearFiles === "function") {
        try {
          modal._permitClearFiles();
        } catch (_) {}
      }
      if (fileInput) fileInput.value = "";
      if (fileList) fileList.innerHTML = "";
      if (fileMsg) fileMsg.textContent = "";

      // Hide conditional containers
      [
        "#facilityContainer",
        "#specifyTerminalContainer",
        "#specifyFacilityContainer",
        "#levelOfImpactContainer",
        "#equipmentType",
        "#impactDetails",
        "#ePermitDetails",
        "#fmmwrkordr",
        "#hseassmnt",
        "#opsassmnt",
        "#fileUploadSection",
      ].forEach((sel) => {
        const el = form.querySelector(sel);
        if (el) el.classList.add("hidden");
      });

      // Reset selects to placeholder
      [
        "#terminal",
        "#facility",
        "#impact",
        "#levelOfImpact",
        "#equipmentTypeInput",
        "#natureOfWork",
      ].forEach((sel) => {
        const el = form.querySelector(sel);
        if (el) el.selectedIndex = 0;
      });

      // Clear flatpickr controls if initialized
      ["#startDateTime", "#endDateTime"].forEach((sel) => {
        const el = form.querySelector(sel);
        if (el && el._flatpickr) el._flatpickr.clear();
        else if (el) el.value = "";
      });

      // Clear custom validation messages
      ["#corpemailid", "#contactdetails"].forEach((sel) => {
        const el = form.querySelector(sel);
        if (el && typeof el.setCustomValidity === "function")
          el.setCustomValidity("");
      });

      // Ensure upload section visibility reflects cleared radios
      if (typeof updateFileUploadVisibilityFn === "function") {
        try {
          updateFileUploadVisibilityFn();
        } catch (_) {
          /* ignore */
        }
      }
    } catch (_) {
      /* ignore */
    }
  }

  // --- Sidebar / hamburger ---
  const hamburger = document.getElementById("sidebar-hamburger");
  const sidebar = document.getElementById("desktop-sidebar");
  const mobileMenu = document.getElementById("mobile-menu");
  const sidebarOverlay = document.getElementById("sidebar-overlay");
  const body = document.body;
  let desktopOpen = false;
  let mobileOpen = false;

  function isDesktop() {
    return window.innerWidth >= 768;
  }

  function openDesktop() {
    if (!sidebar) return;
    sidebar.classList.remove("-translate-x-full");
    sidebar.classList.add("translate-x-0");
    // also add legacy/strong selector used by theme.css to ensure transform wins
    sidebar.classList.add("active");
    body.classList.add("sidebar-open");
    if (sidebarOverlay) sidebarOverlay.classList.add("overlay-open");
    if (hamburger) hamburger.classList.add("active");
    desktopOpen = true;
  }

  function closeDesktop() {
    if (!sidebar) return;
    sidebar.classList.add("-translate-x-full");
    sidebar.classList.remove("translate-x-0");
    sidebar.classList.remove("active");
    body.classList.remove("sidebar-open");
    if (hamburger) hamburger.classList.remove("active");
    if (sidebarOverlay) sidebarOverlay.classList.remove("overlay-open");
    desktopOpen = false;
  }

  function toggleDesktop() {
    if (desktopOpen) closeDesktop();
    else openDesktop();
  }

  function openMobile() {
    if (!mobileMenu) return;
    // Remove display:none so the element can transition in
    mobileMenu.classList.remove("hidden");
    // ensure the transition starts from hidden state
    mobileMenu.classList.remove("mobile-open");
    // force reflow so the browser acknowledges the state change
    // eslint-disable-next-line no-unused-expressions
    mobileMenu.offsetWidth;
    mobileMenu.classList.add("mobile-open");
    if (sidebarOverlay) sidebarOverlay.classList.add("overlay-open");
    mobileOpen = true;
    if (hamburger) hamburger.classList.add("active");
  }

  function closeMobile() {
    if (!mobileMenu) return;
    // start fade-out/slide-out by removing the open class
    mobileMenu.classList.remove("mobile-open");
    // remove hamburger open state immediately
    if (hamburger) hamburger.classList.remove("active");
    // start overlay fade-out
    if (sidebarOverlay) sidebarOverlay.classList.remove("overlay-open");

    // clean up any previous handler
    if (mobileMenu._closeHandler) {
      mobileMenu.removeEventListener("transitionend", mobileMenu._closeHandler);
      clearTimeout(mobileMenu._closeFallback);
    }

    // after transition ends, add hidden to remove from flow
    const onEnd = (ev) => {
      if (ev.target !== mobileMenu) return;
      // only react to opacity/transform transitions
      if (
        ev.propertyName &&
        !(ev.propertyName === "opacity" || ev.propertyName === "transform")
      )
        return;
      mobileMenu.classList.add("hidden");
      mobileOpen = false;
      mobileMenu.removeEventListener("transitionend", onEnd);
      delete mobileMenu._closeHandler;
      if (mobileMenu._closeFallback) {
        clearTimeout(mobileMenu._closeFallback);
        delete mobileMenu._closeFallback;
      }
    };

    mobileMenu._closeHandler = onEnd;
    mobileMenu.addEventListener("transitionend", onEnd);

    // fallback in case transitionend doesn't fire
    mobileMenu._closeFallback = setTimeout(() => {
      if (!mobileMenu.classList.contains("mobile-open")) {
        mobileMenu.classList.add("hidden");
        mobileOpen = false;
      }
      if (mobileMenu._closeHandler) {
        mobileMenu.removeEventListener(
          "transitionend",
          mobileMenu._closeHandler
        );
        delete mobileMenu._closeHandler;
      }
      delete mobileMenu._closeFallback;
    }, 420);
  }

  function toggleMobile() {
    if (mobileOpen) closeMobile();
    else openMobile();
  }

  // handle hamburger clicks
  if (hamburger) {
    hamburger.addEventListener("click", (ev) => {
      ev.preventDefault();
      if (isDesktop()) toggleDesktop();
      else toggleMobile();
    });
  }

  // close when clicking outside
  document.addEventListener("click", (ev) => {
    const target = ev.target;
    // if desktop and sidebar open, close when clicking outside sidebar and hamburger
    if (isDesktop() && desktopOpen) {
      if (
        sidebar &&
        !sidebar.contains(target) &&
        hamburger &&
        !hamburger.contains(target)
      ) {
        closeDesktop();
      }
    }
    // mobile
    if (!isDesktop() && mobileOpen) {
      if (
        mobileMenu &&
        !mobileMenu.contains(target) &&
        hamburger &&
        !hamburger.contains(target)
      ) {
        closeMobile();
      }
    }
  });

  // clicking the overlay closes any open menu
  if (typeof sidebarOverlay !== "undefined" && sidebarOverlay) {
    sidebarOverlay.addEventListener("click", () => {
      if (desktopOpen) closeDesktop();
      if (mobileOpen) closeMobile();
    });
  }

  // close menus on ESC
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      if (desktopOpen) closeDesktop();
      if (mobileOpen) closeMobile();
    }
  });

  // ensure state aligns on resize
  window.addEventListener("resize", () => {
    if (isDesktop()) {
      // ensure mobile menu closed
      if (mobileOpen) closeMobile();
    } else {
      // ensure desktop sidebar is closed when switching to mobile
      if (desktopOpen) closeDesktop();
    }
  });

  // initial state
  if (isDesktop()) {
    // keep closed by default
    closeDesktop();
  } else {
    closeMobile();
  }

  // Populate mobile sections from desktop so mobile accordions have content
  // and keep them in sync via MutationObserver (cloned content, live sync).
  function populateMobileSections() {
    const map = [
      ["desktop-personal-section", "mobile-personal-section"],
      ["desktop-actions-section", "mobile-actions-section"],
      ["desktop-account-section", "mobile-account-section"],
    ];

    const observers = [];
    const timers = new Map();

    function cloneInto(src, dest) {
      // deep-clone child nodes to dest so IDs on wrappers don't duplicate
      const clones = Array.from(src.childNodes).map((n) => n.cloneNode(true));

      // remove id attributes from cloned nodes to avoid duplicate IDs in the document
      function stripIds(node) {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.hasAttribute && node.hasAttribute("id"))
          node.removeAttribute("id");
        // also remove `for` attributes that might reference IDs
        if (node.hasAttribute && node.hasAttribute("for"))
          node.removeAttribute("for");
        // recurse
        for (let i = 0; i < node.children.length; i++)
          stripIds(node.children[i]);
      }

      clones.forEach((c) => stripIds(c));
      dest.replaceChildren(...clones);
    }

    map.forEach(([srcId, destId]) => {
      const src = document.getElementById(srcId);
      const dest = document.getElementById(destId);
      if (!src || !dest) return;

      // initial clone
      cloneInto(src, dest);

      // observe src for changes and update dest (debounced)
      const obs = new MutationObserver((mutations) => {
        // debounce updates to avoid thrashing
        if (timers.has(destId)) clearTimeout(timers.get(destId));
        timers.set(
          destId,
          setTimeout(() => {
            try {
              cloneInto(src, dest);
            } catch (e) {
              /* ignore */
            }
            timers.delete(destId);
          }, 150)
        );
      });

      obs.observe(src, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
      observers.push(obs);
    });

    // disconnect observers when the page unloads
    window.addEventListener("beforeunload", () => {
      observers.forEach((o) => o.disconnect());
    });
  }

  populateMobileSections();
  // Ensure newly-inserted mobile controls reflect the current theme
  try {
    updateThemeToggleIcons();
  } catch (e) {
    /* ignore */
  }

  // --- Accordions (chevron wiring) ---
  // Buttons with class `accordion-toggle` should expand/collapse the element
  // referenced by their `data-target`. If `data-accordion-group` is set,
  // only one item in the group stays open.
  // Accordion handling using event delegation so newly-cloned mobile content works
  function initAccordions() {
    // click handler delegates accordion toggle behaviour
    document.addEventListener("click", (ev) => {
      const btn =
        ev.target &&
        ev.target.closest &&
        ev.target.closest(".accordion-toggle");
      if (!btn) return;
      ev.preventDefault();

      const targetId = btn.getAttribute("data-target");
      const content = targetId ? document.getElementById(targetId) : null;
      if (!content) return;

      const expanded = btn.getAttribute("aria-expanded") === "true";
      if (expanded) {
        btn.setAttribute("aria-expanded", "false");
        content.style.maxHeight = "0px";
        return;
      }

      // if grouped, close others in the same group
      const group = btn.getAttribute("data-accordion-group");
      if (group) {
        document
          .querySelectorAll(
            `.accordion-toggle[data-accordion-group="${group}"]`
          )
          .forEach((t) => {
            if (t === btn) return;
            const otherId = t.getAttribute("data-target");
            const otherContent = otherId && document.getElementById(otherId);
            if (otherContent) {
              t.setAttribute("aria-expanded", "false");
              otherContent.style.maxHeight = "0px";
            }
          });
      }

      // expand this one
      btn.setAttribute("aria-expanded", "true");
      content.style.maxHeight = content.scrollHeight + "px";
    });

    // ensure initial state for any existing toggles
    document.querySelectorAll(".accordion-toggle").forEach((btn) => {
      const targetId = btn.getAttribute("data-target");
      const content = targetId ? document.getElementById(targetId) : null;
      if (content)
        content.style.maxHeight =
          btn.getAttribute("aria-expanded") === "true"
            ? content.scrollHeight + "px"
            : "0px";
    });
  }

  initAccordions();

  // --- Profile data wiring (Personal Information card) ---
  function setUserField(name, value) {
    try {
      document.querySelectorAll(`[data-user-field="${name}"]`).forEach((el) => {
        el.textContent = value ?? "";
      });
    } catch (e) {
      /* ignore */
    }
  }

  function formatDate(dt) {
    try {
      if (!dt) return "";
      const d = typeof dt === "string" ? new Date(dt) : dt;
      if (Number.isNaN(d.getTime())) return "";
      return d.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (_) {
      return "";
    }
  }

  async function loadProfileData() {
    try {
      const res = await fetch(apiUrl("/api/profile"), {
        credentials: "include",
      });
      if (!res.ok) return;
      const data = await res.json();
      const u = data && data.user ? data.user : {};
      const clientIp = data && data.clientIp ? data.clientIp : "";

      const fullName = u.fullName || u.username || "";
      const email = u.email || "";
      const company = u.company || u.department || "";
      const phone = u.phone || u.mobile || "";
      const memberSince = formatDate(u.createdAt);
      const lastLogin = formatDate(u.lastLogin || u.prevLogin);
      const ipAddress = clientIp || "";

      setUserField("fullName", fullName);
      setUserField("email", email);
      setUserField("company", company);
      setUserField("phone", phone);
      setUserField("memberSince", memberSince);
      setUserField("lastLogin", lastLogin);
      setUserField("ipAddress", ipAddress);

      // Reveal admin-only UI if session indicates Admin role. The /api/profile
      // endpoint returns session.role in data.session.role when available.
      try {
        const role =
          data && data.session && data.session.role
            ? data.session.role
            : u && u.role
            ? u.role
            : null;

        // Store role globally for other scripts to access
        window.__USER_ROLE__ = role;

        // Handle [data-admin-only] elements
        document.querySelectorAll("[data-admin-only]").forEach((el) => {
          if (role === "Admin") {
            el.classList.remove("hidden");
            el.style.display = "flex";
          } else {
            el.classList.add("hidden");
            el.style.display = "none";
          }
        });

        // Handle [data-role-visibility] elements - show only for specified roles
        document.querySelectorAll("[data-role-visibility]").forEach((el) => {
          const allowedRoles = el.getAttribute("data-role-visibility");
          if (allowedRoles && role) {
            const rolesArray = allowedRoles.split(",").map((r) => r.trim());
            if (rolesArray.includes(role)) {
              el.classList.remove("hidden");
              el.style.display = "";
            } else {
              el.classList.add("hidden");
              el.style.display = "none";
            }
          }
        });
      } catch (e) {
        /* ignore */
      }
    } catch (e) {
      /* ignore */
    }
  }

  // Kick off profile fetch. MutationObserver in populateMobileSections will
  // re-clone changes into the mobile sidebar.
  loadProfileData();

  // --- Logout flow wiring ---
  function getLoginUrl() {
    try {
      const path = window.location.pathname || "";
      const base = path.includes("/PTW/") ? "/PTW" : "";
      return `${base}/login/index.html`;
    } catch (_) {
      return "/login/index.html";
    }
  }

  // Probe a list of candidate login URLs and redirect to the first reachable one.
  // This makes logout robust when front-end static files may be served from
  // different base paths in production vs dev (e.g., '/PTW').
  async function findLoginAndRedirect(fallback = "/") {
    const candidates = [
      getLoginUrl(),
      "/login/index.html",
      "/PTW/login/index.html",
      "/login.html",
      "/PTW/login.html",
      "/index.html",
      "/",
    ];
    for (const candidate of candidates) {
      try {
        // Build absolute URL for same-origin probing
        const url = candidate.startsWith("http")
          ? candidate
          : window.location.origin +
            (candidate.startsWith("/") ? candidate : "/" + candidate);
        // Use a short HEAD request with timeout so we don't hang on slow networks
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(url, {
          method: "HEAD",
          credentials: "include",
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res && res.status >= 200 && res.status < 400) {
          window.location.href = url;
          return;
        }
      } catch (_) {
        // ignore and try next candidate
      }
    }
    // last resort
    try {
      window.location.href = fallback;
    } catch (_) {
      window.location.href = "/";
    }
  }

  function showSessionEndedNotice() {
    try {
      let bar = document.getElementById("session-ended-bar");
      if (!bar) {
        bar = document.createElement("div");
        bar.id = "session-ended-bar";
        bar.style.position = "fixed";
        bar.style.top = "0";
        bar.style.left = "0";
        bar.style.right = "0";
        bar.style.zIndex = "9999";
        bar.style.padding = "10px 14px";
        bar.style.textAlign = "center";
        bar.style.fontWeight = "600";
        bar.style.backgroundColor = "#f59e0b"; // amber-500
        bar.style.color = "#1f2937"; // gray-800
        bar.textContent =
          "Your session ended because it was used on another device. Redirecting to sign in...";
        document.body.appendChild(bar);
      }
    } catch (_) {
      /* ignore */
    }
  }

  (function wireLogout() {
    const modal = document.getElementById("logout-confirm-modal");
    const openers = document.querySelectorAll("[data-logout-trigger]");
    const cancelBtn = document.querySelector("[data-logout-cancel]");
    const confirmBtn = document.querySelector("[data-logout-confirm]");
    const overlay = document.querySelector("[data-logout-overlay]");
    const status = document.querySelector("[data-logout-status]");

    function openModal() {
      if (modal) modal.classList.remove("hidden");
      if (status) {
        status.textContent = "";
        status.classList.add("hidden");
      }
    }
    function closeModal() {
      if (modal) modal.classList.add("hidden");
    }

    openers.forEach((btn) =>
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        openModal();
      })
    );
    if (cancelBtn)
      cancelBtn.addEventListener("click", (e) => {
        e.preventDefault();
        closeModal();
      });
    if (overlay) overlay.addEventListener("click", () => closeModal());
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") closeModal();
    });

    async function doLogout() {
      try {
        const res = await fetch(apiUrl("/api/logout"), {
          method: "POST",
          credentials: "include",
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          if (status) {
            status.textContent = err.message || "Logout failed";
            status.classList.remove("hidden");
          }
          return;
        }
        // Clear any theme/session storage hints to avoid visual mismatch after redirect
        try {
          localStorage.removeItem("theme");
        } catch (_) {}
        try {
          sessionStorage.removeItem("theme");
        } catch (_) {}
        // Redirect to the best available login page (robust across different deploy bases)
        try {
          await findLoginAndRedirect();
        } catch (_) {
          try {
            window.location.href = getLoginUrl();
          } catch (_) {
            window.location.href = "/";
          }
        }
      } catch (_) {
        if (status) {
          status.textContent = "Network error during logout";
          status.classList.remove("hidden");
        }
      }
    }

    if (confirmBtn)
      confirmBtn.addEventListener("click", (e) => {
        e.preventDefault();
        doLogout();
      });
  })();

  // --- Update Password (shared modal) ---
  (function wireUpdatePasswordModal() {
    const modal = document.getElementById("update-password-modal");
    if (!modal) return;
    const openers = document.querySelectorAll("[data-update-password-trigger]");
    const overlay = modal.querySelector("[data-update-password-overlay]");
    const btnClose = modal.querySelector("[data-update-password-close]");
    const btnCancel = modal.querySelector("[data-update-password-cancel]");

    const form = modal.querySelector("#updatePasswordFormShared");
    const currentEl = modal.querySelector("#currentPasswordShared");
    const currentHint = modal.querySelector("#currentPasswordHintShared");
    const currentErr = modal.querySelector("#currentPasswordErrorShared");
    const newSection = modal.querySelector("#newPasswordSectionShared");
    const newEl = modal.querySelector("#newPasswordShared");
    const confirmEl = modal.querySelector("#confirmNewPasswordShared");
    const confirmErr = modal.querySelector("#confirmErrorShared");
    const bar = modal.querySelector("#passwordStrengthBarShared");
    const label = modal.querySelector("#passwordStrengthLabelShared");
    const submitBtn = modal.querySelector("#updatePasswordSubmitShared");

    let mode = "verify"; // 'verify' current password first, then 'update'

    function resetUI() {
      try {
        form && form.reset();
        newSection && newSection.classList.add("hidden");
        currentErr && currentErr.classList.add("hidden");
        confirmErr && confirmErr.classList.add("hidden");
        currentHint && currentHint.classList.remove("hidden");
        if (bar) {
          bar.style.width = "0%";
          bar.style.backgroundColor = "transparent";
        }
        if (label) label.textContent = "Strength: —";
        mode = "verify";
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = "Continue";
        }
      } catch (_) {}
    }

    function open() {
      modal.classList.remove("hidden");
      resetUI();
      currentEl && currentEl.focus();
    }
    function close() {
      modal.classList.add("hidden");
    }

    // Expose global opener for feature pages
    try {
      window.openUpdatePasswordModal = () => {
        open();
        return true;
      };
    } catch (_) {}

    function countMatches(regex, str) {
      const m = (str || "").match(regex);
      return m ? m.length : 0;
    }
    function assessStrength(pw) {
      const len = (pw || "").length;
      const lowers = countMatches(/[a-z]/g, pw);
      const uppers = countMatches(/[A-Z]/g, pw);
      const digits = countMatches(/\d/g, pw);
      const specials = countMatches(/[^A-Za-z\d]/g, pw);
      let score = 0;
      if (len >= 8) score++;
      if (lowers >= 1) score++;
      if (uppers >= 1) score++;
      if (digits >= 1) score++;
      if (specials >= 1) score++;
      const percent = Math.min(100, score * 20);
      let strength = "Weak";
      let color = "#ef4444";
      if (score >= 3 && score <= 4) {
        strength = "Strong";
        color = "#f59e0b";
      }
      if (score >= 5) {
        strength = "Very Strong";
        color = "#22c55e";
      }
      return { percent, strength, color };
    }
    function meetsPolicy(pw) {
      return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/.test(
        pw || ""
      );
    }
    function updateStrengthUI() {
      const pw = newEl ? newEl.value : "";
      const { percent, strength, color } = assessStrength(pw);
      if (bar) {
        bar.style.width = percent + "%";
        bar.style.backgroundColor = color;
      }
      if (label) label.textContent = "Strength: " + (pw ? strength : "—");
    }
    function updateSubmitState() {
      // Keep submit enabled to allow showing toast messages on click even when fields are empty.
      // We still block in the submit handler and show appropriate toasts.
      return;
    }

    // Openers (direct binding for elements present at init)
    openers.forEach((btn) =>
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        open();
      })
    );
    // Delegated binding so dynamically cloned items in the mobile menu work too
    document.addEventListener("click", (e) => {
      const trigger =
        e.target &&
        e.target.closest &&
        e.target.closest("[data-update-password-trigger]");
      if (!trigger) return;
      e.preventDefault();
      open();
    });
    if (overlay) overlay.addEventListener("click", close);
    if (btnClose) btnClose.addEventListener("click", close);
    if (btnCancel) btnCancel.addEventListener("click", close);
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && !modal.classList.contains("hidden")) close();
    });

    // Live UI
    if (currentEl)
      currentEl.addEventListener("input", () => {
        // Only toggle hint/section; do not show inline errors. Toasts will handle messaging.
        currentHint &&
          currentHint.classList.toggle("hidden", !!currentEl.value);
        newSection && newSection.classList.toggle("hidden", !currentEl.value);
        updateSubmitState();
      });
    if (newEl)
      newEl.addEventListener("input", () => {
        updateStrengthUI();
        updateSubmitState();
      });
    if (confirmEl)
      confirmEl.addEventListener("input", () => {
        // No inline error below the field; rely on toast on submit
        updateSubmitState();
      });

    // Submit
    if (form)
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const currentPassword = currentEl ? currentEl.value : "";
        const newPassword = newEl ? newEl.value : "";
        const confirmPassword = confirmEl ? confirmEl.value : "";
        if (!currentPassword) {
          if (window.showToast)
            showToast("error", "Current password is required");
          else alert("Current password is required");
          return;
        }

        if (mode === "verify") {
          // Verify current password against DB
          try {
            submitBtn &&
              ((submitBtn.disabled = true),
              (submitBtn.textContent = "Checking…"));
            const res = await fetch(apiUrl("/api/check-password"), {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ currentPassword }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              // If endpoint doesn't exist (older backend), gracefully skip verify and advance
              if (res.status === 404) {
                mode = "update";
                newSection && newSection.classList.remove("hidden");
                currentHint && currentHint.classList.add("hidden");
                submitBtn && (submitBtn.textContent = "Update Password");
                newEl && newEl.focus();
                if (window.showToast)
                  showToast(
                    "info",
                    "Verification step unavailable; continue to update."
                  );
                updateSubmitState();
                return;
              }
              const msg = (data && data.message) || "Unable to verify password";
              if (window.showToast) showToast("error", msg);
              else alert(msg);
              // Reset verification field state on failure
              if (currentEl) currentEl.value = "";
              currentHint && currentHint.classList.remove("hidden");
              newSection && newSection.classList.add("hidden");
              return;
            }
            // Good: advance to update stage
            mode = "update";
            newSection && newSection.classList.remove("hidden");
            currentHint && currentHint.classList.add("hidden");
            submitBtn && (submitBtn.textContent = "Update Password");
            newEl && newEl.focus();
            updateSubmitState();
          } catch (err) {
            if (window.showToast)
              showToast("error", "Network error while verifying");
            else alert("Network error while verifying");
            // Reset verification field state on failure
            if (currentEl) currentEl.value = "";
            currentHint && currentHint.classList.remove("hidden");
            newSection && newSection.classList.add("hidden");
          } finally {
            if (submitBtn) {
              submitBtn.disabled = false;
              submitBtn.textContent =
                mode === "verify" ? "Continue" : "Update Password";
            }
          }
          return;
        }

        // mode === 'update'
        if (!newPassword) {
          if (window.showToast) showToast("error", "New password is required");
          else alert("New password is required");
          return;
        }
        if (!confirmPassword) {
          if (window.showToast)
            showToast("error", "Confirm new password is required");
          else alert("Confirm new password is required");
          return;
        }
        if (!meetsPolicy(newPassword)) {
          const msg =
            "Password must be at least 8 characters with 1 uppercase, 1 lowercase, 1 number, and 1 special character.";
          if (window.showToast) showToast("error", msg);
          else alert(msg);
          return;
        }
        if (newPassword !== confirmPassword) {
          if (window.showToast) showToast("error", "Passwords do not match");
          else alert("Passwords do not match");
          return;
        }
        try {
          submitBtn &&
            ((submitBtn.disabled = true),
            (submitBtn.textContent = "Updating…"));
          const res = await fetch(apiUrl("/api/update-password"), {
            method: "PUT",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ currentPassword, newPassword }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            const msg = (data && data.message) || "Failed to update password";
            if (window.showToast) showToast("error", msg);
            else alert(msg);
            return;
          }
          if (window.showToast)
            showToast("success", "Password updated successfully");
          else alert("Password updated successfully");
          // Reset UI and close
          resetUI();
          close();
        } catch (err) {
          if (window.showToast)
            showToast("error", "Network error while updating password");
          else alert("Network error while updating password");
        } finally {
          // Keep disabled briefly to avoid double clicks; will re-enable on next open/reset
          submitBtn &&
            ((submitBtn.disabled = true),
            (submitBtn.textContent = "Update Password"));
        }
      });
  })();

  // --- Idle timeout manager ---
  (function idleTimeoutManager() {
    // Do not run idle warnings on login page or when explicitly disabled
    try {
      const path = (window.location && window.location.pathname) || "";
      if (
        (document.body && document.body.hasAttribute("data-no-idle")) ||
        /\/login(\/|$)/i.test(path)
      ) {
        return; // no-op on login or when disabled
      }
    } catch (_) {
      /* ignore */
    }
    // Configurable timings (in ms)
    // Session idle timeout: 10 minutes total. Show reminder at the last 2 minutes (after 8 minutes of inactivity).
    const IDLE_WARNING_AFTER = 8 * 60 * 1000; // show warning after 8 minutes of inactivity
    const WARNING_COUNTDOWN_SECONDS = 120; // 120 seconds to choose

    // Elements
    const modal = document.getElementById("idle-timeout-modal");
    const overlay = modal ? modal.querySelector("[data-idle-overlay]") : null;
    const stayBtn = modal ? modal.querySelector("[data-idle-stay]") : null;
    const logoutBtn = modal ? modal.querySelector("[data-idle-logout]") : null;
    const countdownEl = modal
      ? modal.querySelector("[data-idle-countdown]")
      : null;
    const statusEl = modal ? modal.querySelector("[data-idle-status]") : null;

    let idleTimer = null;
    let countdownTimer = null;
    let remaining = WARNING_COUNTDOWN_SECONDS;
    let showing = false;

    function openModal() {
      if (!modal || showing) return;
      // Prevent any pending idle timers while the modal is open
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      remaining = WARNING_COUNTDOWN_SECONDS;
      if (countdownEl) countdownEl.textContent = String(remaining);
      if (statusEl) {
        statusEl.textContent = "";
        statusEl.classList.add("hidden");
      }
      modal.classList.remove("hidden");
      showing = true;
      startCountdown();
    }

    function closeModal() {
      if (!modal || !showing) return;
      modal.classList.add("hidden");
      showing = false;
      stopCountdown();
    }

    function startCountdown() {
      stopCountdown();
      countdownTimer = setInterval(() => {
        remaining -= 1;
        if (countdownEl) countdownEl.textContent = String(remaining);
        if (remaining <= 0) {
          // Auto-logout immediately when timer reaches 0; keep modal visible until redirect begins
          stopCountdown();
          if (countdownEl) countdownEl.textContent = "0";
          doLogout();
        }
      }, 1000);
    }

    function stopCountdown() {
      if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
      }
    }

    function resetIdleTimer() {
      if (idleTimer) clearTimeout(idleTimer);
      // Only schedule the warning. Auto-logout will occur in the modal if no action is taken.
      idleTimer = setTimeout(() => openModal(), IDLE_WARNING_AFTER);
    }

    // Treat interactions as activity
    const activityEvents = [
      "mousemove",
      "mousedown",
      "keydown",
      "scroll",
      "touchstart",
      "visibilitychange",
    ];
    activityEvents.forEach((evt) => {
      document.addEventListener(evt, () => {
        if (evt === "visibilitychange") {
          if (document.visibilityState !== "visible") return;
        }
        // If the warning is up and user moves the mouse, keep the modal but keep timers flowing.
        if (!showing) resetIdleTimer();
      });
    });

    async function refreshSession() {
      try {
        const res = await fetch(apiUrl("/api/ping"), {
          credentials: "include",
        });
        if (!res.ok) throw new Error("Ping failed");
        if (window.showToast)
          window.showToast("success", "Your session has been extended.");
        resetIdleTimer();
      } catch (e) {
        if (statusEl) {
          statusEl.textContent =
            "Unable to extend session. You may need to sign in again soon.";
          statusEl.classList.remove("hidden");
        }
      }
    }

    async function doLogout() {
      try {
        const res = await fetch(apiUrl("/api/logout"), {
          method: "POST",
          credentials: "include",
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          if (statusEl) {
            statusEl.textContent =
              err && err.message ? err.message : "Logout failed.";
            statusEl.classList.remove("hidden");
          }
          return;
        }
        try {
          localStorage.removeItem("theme");
        } catch (_) {}
        try {
          sessionStorage.removeItem("theme");
        } catch (_) {}
        window.location.href = getLoginUrl();
      } catch (_) {
        if (statusEl) {
          statusEl.textContent = "Network error during logout";
          statusEl.classList.remove("hidden");
        }
      }
    }

    // Wire modal buttons
    // Do not close on overlay click; require explicit action
    if (overlay)
      overlay.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    // Prevent ESC from closing the idle modal
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && showing) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    });
    if (stayBtn)
      stayBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        await refreshSession();
        closeModal();
      });
    if (logoutBtn)
      logoutBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        await doLogout();
      });

    // Initialize
    resetIdleTimer();
  })();

  // --- Notification System ---
  (function notificationManager() {
    const bellBtn = document.getElementById("notification-bell");
    const dropdown = document.getElementById("notification-dropdown");
    const badge = document.getElementById("notification-badge");
    const listContainer = document.getElementById("notification-list");
    const emptyState = document.getElementById("notification-empty");
    const markAllReadBtn = document.getElementById("mark-all-read");
    const detailModal = document.getElementById("notification-detail-modal");
    const detailOverlay = detailModal
      ? detailModal.querySelector("[data-notification-detail-overlay]")
      : null;
    const detailCloseButtons = detailModal
      ? detailModal.querySelectorAll("[data-notification-detail-close]")
      : [];
    const detailTitle = document.getElementById("notification-detail-title");
    const detailTime = document.getElementById("notification-detail-time");
    const detailMessage = document.getElementById(
      "notification-detail-message"
    );
    const detailMetadata = document.getElementById(
      "notification-detail-metadata"
    );
    const detailIcon = document.getElementById("notification-detail-icon");
    const detailActionBtn = document.getElementById(
      "notification-detail-action"
    );

    if (!bellBtn || !dropdown) return;

    let notifications = [];
    let dropdownOpen = false;

    // Toggle dropdown
    function toggleDropdown() {
      dropdownOpen = !dropdownOpen;
      dropdown.classList.toggle("hidden", !dropdownOpen);
      bellBtn.setAttribute("aria-expanded", String(dropdownOpen));
      if (dropdownOpen) {
        fetchNotifications();
      }
    }

    function closeDropdown() {
      dropdownOpen = false;
      dropdown.classList.add("hidden");
      bellBtn.setAttribute("aria-expanded", "false");
    }

    // Fetch notifications from backend
    async function fetchNotifications() {
      try {
        const res = await fetch(apiUrl("/api/notifications"), {
          credentials: "include",
        });
        if (!res.ok) throw new Error("Failed to fetch notifications");
        const data = await res.json();
        notifications = data.notifications || [];
        renderNotifications();
      } catch (e) {
        console.error("Error fetching notifications:", e);
        if (window.showToast)
          window.showToast("error", "Failed to load notifications");
      }
    }

    // Render notification list
    function renderNotifications() {
      if (!listContainer) return;

      const unreadCount = notifications.filter((n) => !n.read).length;

      // Update badge

      if (badge) {
        if (unreadCount > 0) {
          badge.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
          badge.classList.remove("hidden");
        } else {
          badge.classList.add("hidden");
        }
      }

      // Render list
      if (notifications.length === 0) {
        if (emptyState) emptyState.classList.remove("hidden");
        listContainer.innerHTML = "";
        return;
      }

      if (emptyState) emptyState.classList.add("hidden");

      listContainer.innerHTML = notifications
        .map((notif) => {
          const unread = !notif.read;
          const iconClass = getNotificationIcon(notif.type);
          const iconColor = getNotificationColor(notif.type);

          return `
          <div class="notification-item px-4 py-3 border-b border-[var(--input-border)] hover:bg-[color:rgba(39,49,114,0.05)] cursor-pointer transition-colors ${
            unread ? "bg-[color:rgba(39,49,114,0.06)]" : ""
          }"
               data-notification-id="${notif._id || notif.id}">
            <div class="flex items-start gap-3">
              <div class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full ${iconColor}">
                <i class="${iconClass} text-sm"></i>
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-start justify-between gap-2">
                  <p class="text-sm font-medium text-primary line-clamp-1">${escapeHtml(
                    notif.title || "Notification"
                  )}</p>
                  ${
                    unread
                      ? '<span class="flex h-2 w-2 rounded-full bg-[var(--page-color)] flex-shrink-0"></span>'
                      : ""
                  }
                </div>
                <p class="text-xs text-primary opacity-75 mt-1 line-clamp-2">${escapeHtml(
                  notif.message || ""
                )}</p>
                <p class="text-xs text-primary opacity-60 mt-1">${formatNotificationTime(
                  notif.createdAt
                )}</p>
              </div>
            </div>
          </div>
        `;
        })
        .join("");

      // Attach click handlers
      listContainer.querySelectorAll(".notification-item").forEach((item) => {
        item.addEventListener("click", () => {
          const id = item.dataset.notificationId;
          const notif = notifications.find((n) => (n._id || n.id) === id);
          if (notif) {
            showNotificationDetail(notif);
            markAsRead(id);
          }
        });
      });
    }

    // Show notification detail modal
    function showNotificationDetail(notif) {
      if (!detailModal) return;

      closeDropdown();

      // Set icon and color
      if (detailIcon) {
        const iconClass = getNotificationIcon(notif.type);
        const colorClass = getNotificationColor(notif.type);
        detailIcon.className = `flex h-12 w-12 items-center justify-center rounded-full ${colorClass}`;
        detailIcon.innerHTML = `<i class="${iconClass} text-xl"></i>`;
      }

      // Set content
      if (detailTitle)
        detailTitle.textContent = notif.title || "Notification Details";
      if (detailTime)
        detailTime.textContent = formatNotificationTime(notif.createdAt);

      // Build detailed paragraph message
      if (detailMessage) {
        detailMessage.innerHTML = buildDetailedMessage(notif);
      }

      // Set metadata with additional context
      if (detailMetadata) {
        let metadataHtml = "";

        if (
          notif.type === "permit_approved" ||
          notif.type === "permit_rejected" ||
          notif.type === "permit_updated"
        ) {
          metadataHtml = `
            <div class="space-y-3 text-sm">
              ${
                notif.metadata?.permitId || notif.metadata?.permitNumber
                  ? `
                <div class="flex items-center justify-between py-2 border-b border-gray-200 dark:border-gray-700">
                  <span class="text-gray-500 dark:text-gray-400">Permit Reference</span>
                  <span class="font-medium text-gray-800 dark:text-white">${escapeHtml(
                    notif.metadata.permitNumber || notif.metadata.permitId
                  )}</span>
                </div>
              `
                  : ""
              }
              ${
                notif.metadata?.status
                  ? `
                <div class="flex items-center justify-between py-2 border-b border-gray-200 dark:border-gray-700">
                  <span class="text-gray-500 dark:text-gray-400">Current Status</span>
                  <span class="font-semibold px-2 py-1 rounded text-xs ${getStatusBadgeClass(
                    notif.metadata.status
                  )}">${escapeHtml(notif.metadata.status)}</span>
                </div>
              `
                  : ""
              }
              ${
                notif.metadata?.comments
                  ? `
                <div class="py-2">
                  <p class="text-gray-500 dark:text-gray-400 text-xs mb-1">Additional Comments</p>
                  <p class="text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-700/50 p-3 rounded-lg italic">"${escapeHtml(
                    notif.metadata.comments
                  )}"</p>
                </div>
              `
                  : ""
              }
            </div>
          `;
        }

        detailMetadata.innerHTML = metadataHtml;
      }

      // Set action button
      if (detailActionBtn && notif.metadata?.permitId) {
        detailActionBtn.classList.remove("hidden");
        detailActionBtn.textContent = "View Permit Details";
        detailActionBtn.onclick = () => {
          closeNotificationDetail();
          // Navigate to permit details or relevant page
          if (notif.metadata.permitId) {
            window.location.href = `../profile/profile.html?permitId=${notif.metadata.permitId}`;
          }
        };
      } else if (detailActionBtn) {
        detailActionBtn.classList.add("hidden");
      }

      detailModal.classList.remove("hidden");
    }

    // Build detailed paragraph message based on notification type
    function buildDetailedMessage(notif) {
      const meta = notif.metadata || {};
      const approverName = meta.approverName || "an approver";
      const permitRef = meta.permitNumber || meta.permitId || "your permit";
      const status = meta.status || "updated";

      let message = "";

      switch (notif.type) {
        case "permit_approved":
          if (status === "In Progress") {
            // Pre-approved case
            message = `Great news! Your permit <strong>${escapeHtml(
              permitRef
            )}</strong> has been <strong>pre-approved</strong> by ${escapeHtml(
              approverName
            )}.`;
            message += `<br><br>The permit is now marked as <strong>In Progress</strong> and has been forwarded to the final approver for review and validation. You will receive another notification once the final approval decision is made.`;
            if (meta.comments) {
              message += `<br><br>The pre-approver noted: <em>"${escapeHtml(
                meta.comments
              )}"</em>`;
            }
          } else {
            // Final approved case
            message = `Congratulations! Your permit <strong>${escapeHtml(
              permitRef
            )}</strong> has been <strong>fully approved</strong> by ${escapeHtml(
              approverName
            )}.`;
            message += `<br><br>The permit is now active and you can proceed with the planned work according to the terms and conditions specified in the permit.`;
            if (meta.comments) {
              message += `<br><br>Approval notes: <em>"${escapeHtml(
                meta.comments
              )}"</em>`;
            }
          }
          break;

        case "permit_rejected":
          message = `Unfortunately, your permit <strong>${escapeHtml(
            permitRef
          )}</strong> has been <strong>rejected</strong> by ${escapeHtml(
            approverName
          )}.`;

          if (
            status === "Rejected" &&
            approverName.toLowerCase().includes("pre")
          ) {
            // Rejected by pre-approver
            message += `<br><br>However, the permit has been forwarded to the final approver for further verification and validation. The final approver may review the rejection and make a final decision. You will be notified of any updates.`;
          } else {
            // Final rejection
            message += `<br><br>Please review the comments below and make necessary modifications before resubmitting your permit request.`;
          }

          if (meta.comments) {
            message += `<br><br>Reason for rejection: <em>"${escapeHtml(
              meta.comments
            )}"</em>`;
          } else {
            message += `<br><br>No specific reason was provided. Please contact the approver for more details.`;
          }
          break;

        case "permit_updated":
          message = `Your permit <strong>${escapeHtml(
            permitRef
          )}</strong> has been <strong>updated</strong>.`;
          message += `<br><br>The current status is now <strong>${escapeHtml(
            status
          )}</strong>. `;

          if (meta.approverName) {
            message += `This update was made by ${escapeHtml(approverName)}.`;
          }

          if (meta.comments) {
            message += `<br><br>Update notes: <em>"${escapeHtml(
              meta.comments
            )}"</em>`;
          }

          message += `<br><br>Please review the permit details to see what has changed.`;
          break;

        case "permit_submitted":
          message = `Your permit <strong>${escapeHtml(
            permitRef
          )}</strong> has been successfully submitted for review.`;
          message += `<br><br>It is currently <strong>Pending</strong> and awaiting review by the pre-approver. You will receive notifications as your permit moves through the approval workflow.`;
          break;

        default:
          message = escapeHtml(notif.message || "Notification details");
      }

      return message;
    }

    // Helper to get status badge color class
    function getStatusBadgeClass(status) {
      const statusLower = String(status).toLowerCase();
      if (statusLower.includes("approve"))
        return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
      if (statusLower.includes("reject"))
        return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
      if (statusLower.includes("progress"))
        return "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300";
      if (statusLower.includes("pending"))
        return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300";
      return "bg-gray-100 text-gray-700 dark:bg-gray-900 dark:text-gray-300";
    }

    function closeNotificationDetail() {
      if (detailModal) detailModal.classList.add("hidden");
    }

    // Mark notification as read
    async function markAsRead(notificationId) {
      try {
        await fetch(apiUrl(`/api/notifications/${notificationId}/read`), {
          method: "PUT",
          credentials: "include",
        });

        // Remove notification from local array
        const index = notifications.findIndex(
          (n) => (n._id || n.id) === notificationId
        );
        if (index > -1) {
          notifications.splice(index, 1);
        }

        // Re-render the list
        renderNotifications();

        // No toast for individual notification - cleaner UX
      } catch (e) {
        console.error("Error marking notification as read:", e);
        // On error, still try to remove from local array
        const index = notifications.findIndex(
          (n) => (n._id || n.id) === notificationId
        );
        if (index > -1) {
          notifications.splice(index, 1);
        }
        renderNotifications();
      }
    }

    // Mark all as read
    async function markAllRead() {
      try {
        await fetch(apiUrl("/api/notifications/mark-all-read"), {
          method: "PUT",
          credentials: "include",
        });

        // Clear all notifications from the local array
        notifications = [];
        renderNotifications();
        if (window.showToast)
          window.showToast("success", "All notifications marked as read");
      } catch (e) {
        console.error("Error marking all as read:", e);
        if (window.showToast)
          window.showToast("error", "Failed to mark notifications as read");
      }
    }

    // Helper functions
    function getNotificationIcon(type) {
      const icons = {
        permit_approved: "fas fa-check-circle",
        permit_rejected: "fas fa-times-circle",
        permit_updated: "fas fa-edit",
        permit_submitted: "fas fa-file-alt",
        system: "fas fa-info-circle",
      };
      return icons[type] || "fas fa-bell";
    }

    function getNotificationColor(type) {
      const colors = {
        permit_approved:
          "bg-green-100 dark:bg-green-500/10 text-green-600 dark:text-green-400",
        permit_rejected:
          "bg-red-100 dark:bg-red-500/10 text-red-600 dark:text-red-400",
        permit_updated:
          "bg-yellow-100 dark:bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
        permit_submitted:
          "bg-blue-100 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400",
        system:
          "bg-gray-100 dark:bg-gray-500/10 text-gray-600 dark:text-gray-400",
      };
      return (
        colors[type] ||
        "bg-blue-100 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400"
      );
    }

    function formatNotificationTime(dateString) {
      if (!dateString) return "";
      try {
        const date = new Date(dateString);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) return "Just now";
        if (diffMins < 60)
          return `${diffMins} minute${diffMins > 1 ? "s" : ""} ago`;
        if (diffHours < 24)
          return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
        if (diffDays < 7)
          return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
        return date.toLocaleDateString();
      } catch (e) {
        return "";
      }
    }

    function escapeHtml(text) {
      if (!text) return "";
      const div = document.createElement("div");
      div.textContent = text;
      return div.innerHTML;
    }

    // Event listeners
    if (bellBtn) {
      bellBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleDropdown();
      });
    }

    if (markAllReadBtn) {
      markAllReadBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        markAllRead();
      });
    }

    if (detailOverlay) {
      detailOverlay.addEventListener("click", closeNotificationDetail);
    }

    detailCloseButtons.forEach((btn) => {
      btn.addEventListener("click", closeNotificationDetail);
    });

    // Close dropdown when clicking outside
    document.addEventListener("click", (e) => {
      if (
        dropdownOpen &&
        !bellBtn.contains(e.target) &&
        !dropdown.contains(e.target)
      ) {
        closeDropdown();
      }
    });

    // Close detail modal with ESC
    document.addEventListener("keydown", (ev) => {
      if (
        ev.key === "Escape" &&
        detailModal &&
        !detailModal.classList.contains("hidden")
      ) {
        closeNotificationDetail();
      }
    });

    // Initial fetch and periodic updates (polling fallback)
    fetchNotifications();
    let pollingInterval = setInterval(fetchNotifications, 60000); // Refresh every minute

    // Initialize SSE for real-time notifications (will disable polling on success)
    function initNotificationsSSE() {
      try {
        if (!window.EventSource) return;
        const esUrl = apiUrl("/api/notifications/stream");
        const es = new EventSource(esUrl);

        es.addEventListener("open", () => {
          // stop polling once SSE opens
          if (pollingInterval) {
            clearInterval(pollingInterval);
            pollingInterval = null;
          }
        });

        es.addEventListener("message", (ev) => {
          try {
            const payload = JSON.parse(ev.data);
            if (!payload) return;
            if (payload.type === "init") {
              notifications = payload.notifications || [];
              renderNotifications();
            } else if (payload.type === "notification") {
              // Add to local list and re-render
              const notif = payload.notification;
              if (notif) {
                // ensure newest on top
                notifications.unshift(notif);
                renderNotifications();
              }
            }
          } catch (e) {
            console.warn("SSE message parse error", e);
          }
        });

        es.addEventListener("error", (err) => {
          // Attempt reconnect: EventSource auto-reconnects, but if closed, fall back to polling
          if (es.readyState === EventSource.CLOSED) {
            try {
              if (!pollingInterval)
                pollingInterval = setInterval(fetchNotifications, 60000);
            } catch (_) {}
          }
        });

        // keep a reference to allow future control if needed
        window.__ptw_notifications_es = es;
      } catch (e) {
        console.warn("Failed to init notifications SSE", e);
      }
    }

    // Try to start SSE connection immediately
    initNotificationsSSE();
  })();

  // --- Announcement Button (Admin Only) ---
  (function announcementButton() {
    const announcementBtn = document.getElementById("announcement-button");
    if (!announcementBtn) return;

    announcementBtn.addEventListener("click", (e) => {
      e.preventDefault();
      try {
        // Check if we're on the admin page
        const path = window.location.pathname || "";
        const isAdminPage = path.includes("/admin/admin.html");

        if (isAdminPage) {
          // Open the announcement modal if it exists on admin page
          const modal = document.getElementById("announcement-modal");
          if (modal) {
            // Create a body-level overlay so it covers the entire viewport
            try {
              let bodyOv = document.querySelector(
                "[data-announcement-body-overlay]"
              );
              if (!bodyOv) {
                bodyOv = document.createElement("div");
                bodyOv.setAttribute("data-announcement-body-overlay", "");
                bodyOv.className =
                  "fixed inset-0 bg-[var(--overlay-bg)] backdrop-blur-sm z-40";
                // Clicking the overlay should close the modal
                bodyOv.addEventListener("click", () => {
                  try {
                    modal.classList.add("hidden");
                  } catch (e) {}
                  try {
                    bodyOv.remove();
                  } catch (e) {}
                });
                document.body.appendChild(bodyOv);
              }
            } catch (e) {
              /* ignore overlay creation failures */
            }
            modal.classList.remove("hidden");
            // Focus management for accessibility
            try {
              const closeBtn = document.getElementById(
                "announcementModalClose"
              );
              if (closeBtn) closeBtn.focus();
            } catch (_) {}
          }
        } else {
          // Navigate to admin page
          const base = path.includes("/PTW/") ? "/PTW" : "";
          window.location.href = `${base}/admin/admin.html`;
        }
      } catch (err) {
        console.error("Failed to handle announcement button:", err);
        // Fallback
        window.location.href = "/admin/admin.html";
      }
    });
  })();

  // --- Download Report Modal Logic ---
  // Open report modal when quick action is clicked (uses data-action on anchor)
  document.addEventListener("click", function (e) {
    try {
      const btn =
        e.target.closest && e.target.closest('[data-action="openReportModal"]');
      if (btn) {
        e.preventDefault();
        openDownloadReportModal();
      }
    } catch (_) {}
  });

  function openDownloadReportModal() {
    const modal = document.getElementById("download-report-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    // Initialize flatpickr once per modal
    try {
      if (window.flatpickr && !modal._fpInit) {
        flatpickr(document.getElementById("reportStartDate"), {
          dateFormat: "Y-m-d",
        });
        flatpickr(document.getElementById("reportEndDate"), {
          dateFormat: "Y-m-d",
        });
        modal._fpInit = true;
      }
    } catch (_) {}
  }

  document
    .getElementById("cancelReportDownload")
    ?.addEventListener("click", function () {
      document.getElementById("download-report-modal").classList.add("hidden");
    });

  document
    .getElementById("downloadReportForm")
    ?.addEventListener("submit", async function (e) {
      e.preventDefault();
      const startDate = document.getElementById("reportStartDate").value;
      const endDate = document.getElementById("reportEndDate").value;
      const format = document.getElementById("reportFormat").value;
      if (!startDate || !endDate || !format) {
        if (window.showToast)
          window.showToast("error", "Please select dates and format");
        return;
      }
      try {
        // Use apiUrl so requests go to backend port (5000) when front-end served from Live Server (5500)
        const url = apiUrl(
          `/api/reports?start=${encodeURIComponent(
            startDate
          )}&end=${encodeURIComponent(endDate)}&format=${encodeURIComponent(
            format
          )}`
        );
        const res = await fetch(url, { method: "GET", credentials: "include" });

        if (!res.ok) {
          // try to read server-provided error message
          let msg = "Failed to generate report";
          try {
            const j = await res.json().catch(() => ({}));
            if (j && j.message) msg = j.message;
          } catch (_) {
            /* ignore */
          }
          throw new Error(msg);
        }

        const blob = await res.blob();
        const downloadUrl = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = downloadUrl;
        a.download = `PTW_Report_${startDate}_to_${endDate}.${format}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(downloadUrl);
        document
          .getElementById("download-report-modal")
          .classList.add("hidden");
        if (window.showToast) window.showToast("success", "Report downloaded");
      } catch (err) {
        // Distinguish network errors (likely backend not running) from server errors
        const msg = err && err.message ? err.message : "Download failed";
        if (window.showToast) window.showToast("error", msg);
      }
    });
  // --- End Download Report Modal Logic ---

  // --- Register New User Modal Logic (Admin Only) ---
  (function () {
    const modal = document.getElementById("register-user-modal");
    const form = document.getElementById("registerUserForm");
    const overlay = document.querySelector("[data-register-overlay]");
    const closeBtn = document.querySelector("[data-register-close]");
    const cancelBtn = document.querySelector("[data-register-cancel]");
    const submitBtn = document.getElementById("registerSubmitBtn");

    if (!modal || !form) return;
    // Disable native HTML5 validation tooltips — we use toast messages instead
    try {
      form.noValidate = true;
    } catch (e) {
      /* ignore if setting noValidate fails for any reason */
    }

    function open() {
      modal.classList.remove("hidden");
      document.body.style.overflow = "hidden";
    }

    function close() {
      modal.classList.add("hidden");
      document.body.style.overflow = "";
      form.reset();
      // Clear all error messages
      form.querySelectorAll(".error-message").forEach((el) => {
        el.textContent = "";
        el.classList.add("hidden");
      });
    }

    function showError(fieldId, message) {
      const field = document.getElementById(fieldId);
      if (!field) return;
      const errorSpan = field.parentElement.querySelector(".error-message");
      if (errorSpan) {
        errorSpan.textContent = message;
        errorSpan.classList.remove("hidden");
      }
      field.classList.add("border-red-500");
    }

    function clearFieldError(fieldId) {
      const field = document.getElementById(fieldId);
      if (!field) return;
      const errorSpan = field.parentElement.querySelector(".error-message");
      if (errorSpan) {
        errorSpan.textContent = "";
        errorSpan.classList.add("hidden");
      }
      field.classList.remove("border-red-500");
    }

    async function checkRegisterEmailUnique() {
      const fieldId = "register_email";
      const el = document.getElementById(fieldId);
      if (!el) return;
      const v = (el.value || "").trim();
      if (!v) {
        window._registerEmailExists = false;
        return;
      }
      try {
        const res = await fetch(
          apiUrl(`/api/check-email?email=${encodeURIComponent(v)}`),
          { credentials: "include" }
        );
        if (!res.ok) return;
        const j = await res.json();
        window._registerEmailExists = !!j.exists;
        if (j.exists) {
          if (window.showToast)
            window.showToast("error", "Email already exists");
        } else {
          window._registerEmailExists = false;
        }
      } catch (e) {
        console.warn("checkRegisterEmailUnique error", e);
      }
    }

    async function checkRegisterMobileUnique() {
      const fieldId = "register_mobile";
      const el = document.getElementById(fieldId);
      if (!el) return;
      const v = (el.value || "").trim();
      if (!v) {
        window._registerMobileExists = false;
        return;
      }
      try {
        const res = await fetch(
          apiUrl(`/api/check-phone?phone=${encodeURIComponent(v)}`),
          { credentials: "include" }
        );
        if (!res.ok) return;
        const j = await res.json();
        window._registerMobileExists = !!j.exists;
        if (j.exists) {
          if (window.showToast)
            window.showToast("error", "Phone number already exists");
        } else {
          window._registerMobileExists = false;
        }
      } catch (e) {
        console.warn("checkRegisterMobileUnique error", e);
      }
    }
    function clearErrors() {
      form.querySelectorAll(".error-message").forEach((el) => {
        el.textContent = "";
        el.classList.add("hidden");
      });
      form.querySelectorAll("input, select").forEach((el) => {
        el.classList.remove("border-red-500");
      });
    }

    function validateForm() {
      // Remove inline field error UI; return boolean and show a toast caller-side.
      const errors = [];

      const fullName = document
        .getElementById("register_fullName")
        .value.trim();
      const email = document.getElementById("register_email").value.trim();
      const mobile = document.getElementById("register_mobile").value.trim();
      const role = document.getElementById("register_role").value;
      const password = document.getElementById("register_password").value;
      const confirmPassword = document.getElementById(
        "register_confirmPassword"
      ).value;

      if (!fullName) errors.push("Full name is required");
      else if (!/^[A-Za-z\s]+$/.test(fullName))
        errors.push("Full name should contain letters only");

      if (!email) errors.push("Email is required");
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
        errors.push("Enter a valid email address");

      if (!mobile) errors.push("Phone number is required");
      else {
        const cleanMobile = mobile.replace(/[\s\-()]/g, "");
        if (!/^\+974\d{8,}$/.test(cleanMobile))
          errors.push(
            "Phone must start with +974 and contain at least 8 digits"
          );
      }

      if (!role) errors.push("Please select a role");

      if (!password) errors.push("Password is required");
      else if (
        !/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/.test(
          password
        )
      )
        errors.push(
          "Password must be at least 8 characters with uppercase, lowercase, number, and special character"
        );

      if (!confirmPassword) errors.push("Please confirm your password");
      else if (password !== confirmPassword)
        errors.push("Passwords do not match");

      if (errors.length) {
        if (window.showToast) window.showToast("error", errors[0]);
        return false;
      }
      return true;
    }

    async function handleSubmit(e) {
      e.preventDefault();

      if (!validateForm()) {
        return;
      }

      // Prevent submission if async uniqueness checks flagged duplicates
      if (window._registerEmailExists) {
        if (window.showToast) window.showToast("error", "Email already exists");
        return;
      }
      if (window._registerMobileExists) {
        if (window.showToast)
          window.showToast("error", "Mobile number already exists");
        return;
      }

      // Prevent double-submit
      if (window._registerSubmitting) return;
      window._registerSubmitting = true;

      const formData = {
        fullName: document.getElementById("register_fullName").value.trim(),
        email: document.getElementById("register_email").value.trim(),
        mobile: document.getElementById("register_mobile").value.trim(),
        company: document.getElementById("register_company").value.trim(),
        department: document.getElementById("register_department").value.trim(),
        designation: document
          .getElementById("register_designation")
          .value.trim(),
        role: document.getElementById("register_role").value,
        password: document.getElementById("register_password").value,
        confirmPassword: document.getElementById("register_confirmPassword")
          .value,
      };

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML =
          '<i class="fas fa-spinner fa-spin mr-2"></i>Registering...';
      }

      try {
        const res = await fetch(apiUrl("/admin/register-user"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(formData),
        });

        const data = await res.json();

        if (res.ok) {
          if (window.showToast)
            window.showToast(
              "success",
              data.message || "User registered successfully"
            );
          close();
          // Refresh user list if on admin page
          if (typeof window.loadUsers === "function") {
            setTimeout(() => window.loadUsers(), 500);
          }
        } else {
          if (window.showToast)
            window.showToast("error", data.error || "Registration failed");
        }
      } catch (err) {
        console.error("Registration error:", err);
        if (window.showToast)
          window.showToast("error", "Network error. Please try again.");
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.classList.remove("loading");
          submitBtn.innerHTML =
            '<i class="fas fa-user-plus mr-2"></i>Register User';
        }
        window._registerSubmitting = false;
      }
    }

    // Event listeners
    document.addEventListener("click", (ev) => {
      const trigger = ev.target.closest('[data-action="register-new-user"]');
      if (trigger) {
        ev.preventDefault();
        open();
      }
    });

    if (overlay) overlay.addEventListener("click", close);
    if (closeBtn) closeBtn.addEventListener("click", close);
    if (cancelBtn) cancelBtn.addEventListener("click", close);
    if (form) form.addEventListener("submit", handleSubmit);

    // Async uniqueness checks for admin register modal
    const regEmailEl = document.getElementById("register_email");
    const regMobileEl = document.getElementById("register_mobile");
    // debounce helper to reduce API calls on rapid interactions
    function debounce(fn, wait) {
      let t = null;
      return function (...args) {
        if (t) clearTimeout(t);
        t = setTimeout(() => {
          t = null;
          try {
            fn.apply(this, args);
          } catch (e) {
            console.warn("debounced fn error", e);
          }
        }, wait);
      };
    }
    if (regEmailEl) {
      const debouncedRegEmail = debounce(checkRegisterEmailUnique, 200);
      regEmailEl.addEventListener("blur", debouncedRegEmail);
      regEmailEl.addEventListener("input", () =>
        clearFieldError("register_email")
      );
    }
    if (regMobileEl) {
      const debouncedRegMobile = debounce(checkRegisterMobileUnique, 200);
      regMobileEl.addEventListener("blur", debouncedRegMobile);
      regMobileEl.addEventListener("input", () =>
        clearFieldError("register_mobile")
      );
    }
  })();
  // --- End Register New User Modal Logic ---

  // --- Add New User Modal Wiring (open/close + submit) ---
  // Add-user/signup handling removed per user request. No-op placeholder retained so
  // layout.js remains syntactically valid. The quick-action anchor remains but will
  // no longer open a signup modal from this shared layout.

  // Observe changes to <html> attributes related to theme so we can detect
  // external scripts that overwrite theme state. This logs changes and updates
  // the toggle icons so the UI stays synchronized.
  try {
    const html = document.documentElement;
    let lastTheme =
      html.getAttribute("data-theme") ||
      (html.classList.contains("dark") ? "dark" : "light");
    const mo = new MutationObserver((records) => {
      records.forEach((rec) => {
        if (
          rec.type === "attributes" &&
          (rec.attributeName === "data-theme" || rec.attributeName === "class")
        ) {
          const current =
            html.getAttribute("data-theme") ||
            (html.classList.contains("dark") ? "dark" : "light");
          if (current !== lastTheme) {
            lastTheme = current;
            // keep UI in sync
            try {
              updateThemeToggleIcons();
            } catch (e) {}
          }
        }
      });
    });
    mo.observe(html, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
    // listen for our own dispatched event too
    window.addEventListener("theme:changed", () => {
      try {
        updateThemeToggleIcons();
      } catch (e) {}
    });
  } catch (e) {
    /* ignore */
  }
})();
