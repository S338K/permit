import { API_BASE } from "../config.js";

// escapeHtml: simple HTML escape helper
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// stripHtmlTags: strip HTML tags and sanitize text
function stripHtmlTags(input) {
  try {
    if (input === null || input === undefined) return "";
    const raw = String(input);
    // Use DOMParser to parse in an isolated document
    if (window.DOMParser) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(raw, "text/html");

      // Remove potentially executable or unwanted elements
      doc
        .querySelectorAll("script,style,noscript,iframe,object,embed")
        .forEach((el) => el.remove());

      // Remove event handler attributes and javascript: URIs
      const walker = doc.createTreeWalker(
        doc.body,
        NodeFilter.SHOW_ELEMENT,
        null,
        false
      );
      while (walker.nextNode()) {
        const el = walker.currentNode;
        // copy attributes to avoid live mutation issues
        const attrs = Array.from(el.attributes || []);
        attrs.forEach((a) => {
          const name = (a.name || "").toLowerCase();
          const val = a.value || "";
          if (name.startsWith("on") || name === "style") {
            el.removeAttribute(a.name);
          }
          if (
            (name === "href" || name === "src") &&
            /^\s*javascript:/i.test(val)
          ) {
            el.removeAttribute(a.name);
          }
        });
      }

      let text =
        (doc.body && (doc.body.textContent || doc.body.innerText)) || "";
      // Normalize whitespace, remove control characters, and truncate to a sensible limit
      text = text
        .replace(/\s+/g, " ")
        .replace(/[\x00-\x1F\x7F]/g, "")
        .trim();
      const MAX_LEN = 1000;
      if (text.length > MAX_LEN) text = text.slice(0, MAX_LEN) + "…";
      return text;
    } else {
      // Fallback for very old browsers: strip tags and collapse whitespace
      return raw
        .replace(/<[^>]*>/g, "")
        .replace(/\s+/g, " ")
        .trim();
    }
  } catch (err) {
    try {
      return String(input)
        .replace(/<[^>]*>/g, "")
        .replace(/\s+/g, " ")
        .trim();
    } catch (_) {
      return "";
    }
  }
}

// stripHtml removed — HTML stripping was only needed for the removed carousel.

// Consolidated and cleaned login page script
document.addEventListener("DOMContentLoaded", () => {
  // Footer info modal handlers
  try {
    const footerModal = document.getElementById("footerInfoModal");
    const footerOverlay = document.getElementById("footerInfoOverlay");
    const footerClose = document.getElementById("footerInfoClose");
    const footerPanel = footerModal
      ? footerModal.querySelector(".modal-panel")
      : null;

    function closeFooterModal() {
      if (!footerModal) return;
      // Trigger CSS exit animations
      footerModal.classList.add("is-closing");
      const target = footerPanel || footerModal;
      const onDone = () => {
        footerModal.classList.add("hidden");
        footerModal.classList.remove("is-closing");
        target.removeEventListener("animationend", onDone);
      };
      // Fallback timeout in case animationend doesn't fire
      target.addEventListener("animationend", onDone, { once: true });
      setTimeout(onDone, 600);
    }

    if (footerClose && footerModal) {
      footerClose.addEventListener("click", closeFooterModal);
    }
    if (footerOverlay && footerModal) {
      footerOverlay.addEventListener("click", closeFooterModal);
    }
    // Escape key closes the modal
    document.addEventListener("keydown", (e) => {
      if (
        e.key === "Escape" &&
        footerModal &&
        !footerModal.classList.contains("hidden")
      ) {
        closeFooterModal();
      }
    });
  } catch (_) {}

  // ===== Header announcement / weather marquee =====
  // Marquee speed: use a single default duration for all messages (seconds)
  // Marquee speed: use per-character duration but keep no inter-message delay.
  // Duration will be: clamp(len * MULTIPLIER, MIN, MAX)
  // Tuned marquee speed constants — reduced so messages transit faster
  // Slow down marquee: increase per-character multiplier and minimum duration
  const MARQUEE_MIN_DURATION = 10; // seconds (minimum duration for very short messages)
  const MARQUEE_MAX_DURATION = 60; // seconds (cap for very long messages)
  const MARQUEE_CHAR_MULTIPLIER = 0.28; // seconds per character
  // Controller for single-container sequential marquee (allows canceling previous runs)
  let marqueeSequenceController = null;
  // fetchAnnouncementOrWeather: fetch announcements/weather and render marquee
  async function fetchAnnouncementOrWeather() {
    const marqueeEl = document.getElementById("announcement-marquee");
    if (!marqueeEl) return;

    try {
      // Fetch multiple system messages so we can show English + Arabic simultaneously
      const res = await fetch(`${API_BASE}/api/system-messages`, {
        credentials: "include",
      });
      if (res.ok) {
        const messages = await res.json().catch(() => []);
        if (Array.isArray(messages) && messages.length > 0) {
          let arabicMsg = null,
            englishMsg = null;
          for (const m of messages) {
            // sanitize title and message and keep structured object
            const rawMsg = m && (m.message || m.message === 0) ? m.message : "";
            const rawTitle = m && (m.title || m.title === 0) ? m.title : "";
            const safeTitle = stripHtmlTags(rawTitle).trim();
            const safeMsg = stripHtmlTags(rawMsg).trim();
            const combined = safeTitle ? `${safeTitle} : ${safeMsg}` : safeMsg;
            if (!combined) continue;
            const item = { title: safeTitle, text: safeMsg, combined };
            if (!arabicMsg && containsArabic(combined)) arabicMsg = item;
            if (!englishMsg && !containsArabic(combined)) englishMsg = item;
            if (arabicMsg && englishMsg) break;
          }

          if (arabicMsg && englishMsg) {
            renderMarqueeMultiple([englishMsg, arabicMsg]);
            return;
          }
          const single = englishMsg || arabicMsg;
          if (single) {
            renderMarqueeText(single);
            return;
          }
        }
      }
    } catch (e) {
      console.warn("Announcement fetch failed", e);
    }

    // Fallback: weather
    try {
      const wres = await fetch(`${API_BASE}/api/weather?city=Doha`);
      if (wres.ok) {
        const wjson = await wres.json().catch(() => ({}));
        const cityName = wjson && wjson.name ? String(wjson.name) : "Doha";
        const t =
          wjson && (wjson.temperature || wjson.temp || wjson.temperature === 0)
            ? `${wjson.temperature}°C`
            : wjson && wjson.temperature
            ? `${wjson.temperature}`
            : "N/A";
        const condition =
          wjson && wjson.condition
            ? wjson.condition
            : wjson && wjson.detailsLine
            ? ""
            : "N/A";
        const humidity =
          wjson && (wjson.humidity || wjson.humidity === 0)
            ? `${wjson.humidity}%`
            : "N/A";
        const visibility =
          wjson && (wjson.visibility || wjson.visibility === 0)
            ? `${wjson.visibility} km`
            : "N/A";
        const weatherText = `Temperature : ${t} | Weather Status : ${condition} | Humidity: ${humidity} | Visibility: ${visibility}`;
        // use structured object so renderers can style title separately
        renderMarqueeText({
          title: cityName,
          text: weatherText,
          combined: `${cityName} : ${weatherText}`,
        });
        return;
      }
    } catch (e) {
      console.warn("Weather fetch failed", e);
    }

    // Nothing to show
    renderMarqueeText("");
  }

  // renderMarqueeMultiple: show multiple marquee messages sequentially
  function renderMarqueeMultiple(texts) {
    // Single-container sequential loop implementation. Shows one message at a time
    // (no overlap). Each message animates once, then the next starts after gapDelay.
    const container = document.getElementById("announcement-marquee");
    if (!container) return;
    container.textContent = "";
    if (!Array.isArray(texts) || texts.length === 0) return;

    // Cancel any running sequence
    if (
      marqueeSequenceController &&
      typeof marqueeSequenceController.stop === "function"
    ) {
      marqueeSequenceController.stop();
    }

    const gapDelay = 0; // seconds between messages (0 => immediately start next)
    const GAP_EXTRA_PX = 24; // additional px padding so text doesn't butt against edge
    let cancelled = false;

    function stopSequence() {
      cancelled = true;
      container.querySelectorAll(".marquee-inner").forEach((el) => {
        try {
          if (el._onAnimEnd)
            el.removeEventListener("animationend", el._onAnimEnd);
        } catch (e) {}
        try {
          if (el.parentNode) el.parentNode.removeChild(el);
        } catch (e) {}
      });
    }

    marqueeSequenceController = { stop: stopSequence };

    // Pause-on-hover support
    container.onmouseenter = () =>
      container.querySelectorAll(".marquee-inner").forEach((i) => {
        i.style.animationPlayState = "paused";
      });
    container.onmouseleave = () =>
      container.querySelectorAll(".marquee-inner").forEach((i) => {
        i.style.animationPlayState = "running";
      });

    async function showAtIndex(idx) {
      if (cancelled) return;
      const rawTxt = texts[idx];
      // support structured message objects { title, text, combined }
      let title = "";
      let msg = "";
      let combined = "";
      if (rawTxt && typeof rawTxt === "object") {
        title = rawTxt.title || "";
        msg = rawTxt.text || "";
        combined = rawTxt.combined || (title ? `${title} : ${msg}` : msg);
      } else {
        msg = String(rawTxt || "").trim();
        combined = msg;
      }
      if (!combined) {
        // move to next immediately
        showAtIndex((idx + 1) % texts.length);
        return;
      }

      container.textContent = ""; // ensure only one child
      const inner = document.createElement("div");
      inner.className = "marquee-inner";
      inner.setAttribute("role", "status");
      inner.setAttribute("aria-live", "polite");
      // enforce uniform font size for all languages (including Arabic)
      // font-size moved to shared CSS class
      inner.classList.add("announcement-item");

      // Create title span (bold) and message span (slightly larger)
      if (title) {
        const titleSpan = document.createElement("span");
        titleSpan.textContent = title + " : ";
        titleSpan.classList.add("announcement-title");
        inner.appendChild(titleSpan);
      }
      const msgSpan = document.createElement("span");
      msgSpan.textContent = msg || combined;
      inner.appendChild(msgSpan);

      // compute gap using container width for reliable spacing across sizes
      const containerWidth = Math.max(200, container.clientWidth || 600);
      const gapPx = containerWidth + GAP_EXTRA_PX;

      // Compute duration from message length (seconds) and clamp to min/max
      const len = combined && combined.length ? combined.length : 20;
      const duration = Math.max(
        MARQUEE_MIN_DURATION,
        Math.min(MARQUEE_MAX_DURATION, len * MARQUEE_CHAR_MULTIPLIER)
      );

      inner.style.animationTimingFunction = "linear";
      inner.style.animationDuration = duration + "s";
      inner.style.animationIterationCount = "1";
      inner.style.animationFillMode = "forwards";

      if (containsArabic(combined)) {
        inner.style.animationName = "marquee-ltr";
        inner.style.direction = "rtl";
        inner.style.paddingRight = gapPx + "px";
        inner.style.textAlign = "right";
      } else {
        inner.style.animationName = "marquee-rtl";
        inner.style.direction = "ltr";
        inner.style.paddingLeft = gapPx + "px";
        inner.style.textAlign = "left";
      }

      // Advance to next message when this animation ends. Rely solely on
      // the animationend event (no timers) so messages play sequentially
      // with no additional delays.
      const onEnd = () => {
        try {
          inner.removeEventListener("animationend", onEnd);
        } catch (e) {}
        if (cancelled) return;
        // Immediately show next message
        showAtIndex((idx + 1) % texts.length);
      };
      inner._onAnimEnd = onEnd;
      inner.addEventListener("animationend", onEnd);

      container.appendChild(inner);
    }

    // start sequence
    showAtIndex(0);
  }

  // containsArabic: detect presence of Arabic characters
  function containsArabic(s) {
    try {
      if (!s || typeof s !== "string") return false;
      return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(s);
    } catch (e) {
      return false;
    }
  }

  // renderMarqueeText: render a single marquee message into the container
  function renderMarqueeText(text) {
    const container = document.getElementById("announcement-marquee");
    if (!container) return;
    // Ensure we don't inject HTML — use textContent only
    container.textContent = "";
    if (!text) return;
    // support object with title/text or a plain string
    let title = "";
    let msg = "";
    let combined = "";
    if (text && typeof text === "object") {
      title = text.title || "";
      msg = text.text || "";
      combined = text.combined || (title ? `${title} : ${msg}` : msg);
    } else {
      combined = stripHtmlTags(text).trim();
      msg = combined;
    }
    if (!combined) return;

    const inner = document.createElement("div");
    inner.className = "marquee-inner";
    inner.setAttribute("role", "status");
    inner.setAttribute("aria-live", "polite");
    // enforce uniform font size for all languages (including Arabic)
    // font-size moved to shared CSS class
    inner.classList.add("announcement-item");

    if (title) {
      const titleSpan = document.createElement("span");
      titleSpan.textContent = title + " : ";
      titleSpan.classList.add("announcement-title");
      inner.appendChild(titleSpan);
    }
    const msgSpan = document.createElement("span");
    msgSpan.textContent = msg;
    inner.appendChild(msgSpan);

    // compute duration based on length to keep readable speed
    const len = combined && combined.length ? combined.length : 20;
    const duration = Math.max(
      MARQUEE_MIN_DURATION,
      Math.min(MARQUEE_MAX_DURATION, len * MARQUEE_CHAR_MULTIPLIER)
    );
    inner.style.animationTimingFunction = "linear";
    inner.style.animationDuration = duration + "s";
    inner.style.animationIterationCount = "infinite";
    inner.style.animationFillMode = "forwards";
    // Choose direction based on language: English -> rtl (move right->left), Arabic -> ltr
    if (containsArabic(combined)) {
      inner.style.animationName = "marquee-ltr";
      inner.style.direction = "rtl";
      inner.style.paddingRight = "100%";
      inner.style.textAlign = "right";
    } else {
      inner.style.animationName = "marquee-rtl";
      inner.style.direction = "ltr";
      inner.style.paddingLeft = "100%";
      inner.style.textAlign = "left";
    }
    container.appendChild(inner);

    // Ensure pause-on-hover also works for single marquee via JS
    container.onmouseenter = () =>
      container.querySelectorAll(".marquee-inner").forEach((i) => {
        i.style.animationPlayState = "paused";
      });
    container.onmouseleave = () =>
      container.querySelectorAll(".marquee-inner").forEach((i) => {
        i.style.animationPlayState = "running";
      });
  }

  // Initialize and refresh periodically (every 5 minutes)
  try {
    fetchAnnouncementOrWeather();
    setInterval(fetchAnnouncementOrWeather, 5 * 60 * 1000);
  } catch (e) {
    /* ignore init errors */
  }

  // ========== REST OF LOGIN PAGE CODE ==========

  // Deduplicate any duplicate password toggle
  setTimeout(() => {
    const passwordField = document.getElementById("password");
    if (passwordField) {
      const parent = passwordField.parentElement;
      if (parent) {
        const toggles = parent.querySelectorAll("#togglePassword");
        if (toggles.length > 1)
          toggles.forEach((b, i) => {
            if (i > 0) b.remove();
          });
      }
    }
  }, 0);

  // Login form handlers (kept intact)
  const form = document.getElementById("loginForm");
  const emailEl = document.getElementById("email");
  const passwordEl = document.getElementById("password");
  const loginBtn = document.getElementById("loginBtn");

  // Error display removed for login page (inline error UI was intentionally removed)

  // --- Shared toast helpers (use shared/toast.js) ---
  const showToast = (type, message, opts = {}) => {
    if (window.showToast) return window.showToast(type, message, opts);
    console.warn("Toast:", type, message);
    return null;
  };
  const dismissToast = (el) => {
    if (window.dismissToast) return window.dismissToast(el);
    if (el && el.remove) el.remove();
  };

  // validateEmail: basic email format check
  function validateEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  }
  // validatePassword: ensure password length >= 8
  function validatePassword(v) {
    return v.trim().length >= 8;
  }

  // validateField: validate specific input element by id
  function validateField(el) {
    if (!el) return true;
    if (el.id === "email") {
      return validateEmail(el.value);
    }
    if (el.id === "password") {
      return validatePassword(el.value);
    }
    return true;
  }

  [emailEl, passwordEl].forEach((i) => {
    if (i) i.addEventListener("input", () => validateField(i));
  });

  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      // Prevent double submissions from multiple clicks/keypresses
      if (window._loginSubmitting) return;
      window._loginSubmitting = true;
      // Validate each field and show errors for every failed validation via toast
      const errors = [];
      const emailOk = validateField(emailEl);
      const passwordOk = validateField(passwordEl);
      if (!emailOk) errors.push("Please enter a valid email address.");
      if (!passwordOk) errors.push("Password must be at least 8 characters.");
      if (errors.length) {
        showToast("error", errors.join("<br>"));
        return;
      }

      const email = emailEl.value.trim();
      const password = passwordEl.value.trim();
      const originalButtonHTML = `<span class="relative z-10 flex items-center justify-center"><i class="fas fa-sign-in-alt mr-2"></i>Sign in to your account</span>`;

      loginBtn.disabled = true;
      loginBtn.innerHTML = `<span class="flex items-center justify-center"><div class="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>Checking...</span>`;

      // Helper to perform login (with optional force flag)
      async function performLogin(force = false) {
        const res = await fetch(`${API_BASE}/api/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            password,
            ...(force ? { force: true } : {}),
          }),
          credentials: "include",
        });
        const data = await res.json().catch(() => ({}));
        return { res, data };
      }

      try {
        let { res, data } = await performLogin(false);
        if (!res.ok) {
          // Handle single active-session conflict (409)
          if (res.status === 409 && data && data.code === "ACTIVE_SESSION") {
            const modal = document.getElementById("sessionConflictModal");
            const msgEl = document.getElementById("sessionConflictMessage");
            const btnYes = document.getElementById("sessionConflictConfirm");
            const btnNo = document.getElementById("sessionConflictCancel");
            if (msgEl) {
              const name =
                (data.user && (data.user.displayName || data.user.username)) ||
                "this account";
              msgEl.textContent = `You're already signed in as ${name} on another device or browser. Continue here to sign out there and proceed with this login.`;
            }
            const closeModal = () => {
              if (modal) modal.classList.add("hidden");
            };
            const openModal = () => {
              if (modal) modal.classList.remove("hidden");
            };
            openModal();

            // Wire once for this attempt
            const onNo = (ev) => {
              ev.preventDefault();
              closeModal();
              loginBtn.disabled = false;
              loginBtn.innerHTML = originalButtonHTML;
              window._loginSubmitting = false;
              btnNo && btnNo.removeEventListener("click", onNo);
              btnYes && btnYes.removeEventListener("click", onYes);
            };
            const onYes = async (ev) => {
              ev.preventDefault();
              btnYes.disabled = true;
              try {
                const forced = await performLogin(true);
                if (!forced.res.ok) {
                  showToast(
                    "error",
                    forced.data && forced.data.message
                      ? forced.data.message
                      : "Unable to switch this account here."
                  );
                  btnYes.disabled = false;
                  return;
                }
                data = forced.data;
                closeModal();
              } catch (err) {
                btnYes.disabled = false;
                showToast("error", "Network error while switching session.");
                return;
              } finally {
                btnNo && btnNo.removeEventListener("click", onNo);
                btnYes && btnYes.removeEventListener("click", onYes);
              }

              // proceed to success flow below using updated data
              finalizeSuccess(data);
            };

            btnNo && btnNo.addEventListener("click", onNo, { once: true });
            btnYes && btnYes.addEventListener("click", onYes, { once: true });
            return; // wait for user choice
          }

          // Generic error fallback
          loginBtn.disabled = false;
          loginBtn.innerHTML = originalButtonHTML;
          window._loginSubmitting = false;

          if (res.status >= 500) {
            showToast(
              "error",
              "Server error while signing in. Please try again later."
            );
          } else {
            showToast(
              "error",
              data && data.message
                ? data.message
                : "Sign in failed. Please check your credentials."
            );
          }
          return;
        }
        // success
        finalizeSuccess(data);
      } catch (e) {
        loginBtn.disabled = false;
        loginBtn.innerHTML = originalButtonHTML;
        window._loginSubmitting = false;
        showToast("error", "Network error during login. Please try again.");
      }
    });
  }

  // forgot password link
  const forgotLink = document.getElementById("forgotPasswordLink");
  if (forgotLink)
    forgotLink.addEventListener("click", (e) => {
      e.preventDefault();
      window.open(
        "../forgot-password/forgot-password.html",
        "ForgotPassword",
        "width=500,height=600,top=100,left=100,resizable=yes,scrollbars=yes"
      );
    });

  // small UX enhancements
  [emailEl, passwordEl].forEach((input) => {
    if (input) {
      input.addEventListener("focus", () => {
        input.parentElement.classList.add("transform", "scale-[1.02]");
      });
      input.addEventListener("blur", () => {
        input.parentElement.classList.remove("transform", "scale-[1.02]");
      });
    }
  });

  // finalizeSuccess: handle post-login success flow and redirect
  function finalizeSuccess(data) {
    try {
      sessionStorage.setItem(
        "previousLogin",
        (data && data.user && data.user.lastLogin) || ""
      );
    } catch (_) {}
    // store per-tab access token (if provided) so this tab uses token auth
    try {
      if (data && data.accessToken) {
        sessionStorage.setItem("accessToken", data.accessToken);
      }
      // store a per-tab user id to help other tabs decide whether to reload
      try {
        if (data && data.user && data.user.id)
          sessionStorage.setItem("ptw:userId", String(data.user.id));
      } catch (_) {}
      // broadcast to other tabs that session changed; they may reload
      try {
        if (window.__ptw_broadcastSession)
          window.__ptw_broadcastSession({
            type: "login",
            userId: data && data.user && data.user.id,
          });
      } catch (_) {}
    } catch (_) {}
    showToast("success", "Signed in successfully");
    setTimeout(() => {
      const role = data && data.user && data.user.role;
      switch (role) {
        case "PreApprover":
          window.location.href = "../preapprover/preapprover.html";
          break;
        case "Approver":
          window.location.href = "../approver/approver.html";
          break;
        case "Admin":
          window.location.href = "../admin/admin.html";
          break;
        default:
          window.location.href = "../profile/profile.html";
      }
    }, 700);
  }

  // ----- Fix for sticky header overlap -----
  // Measure the sticky header height and reserve top padding so the
  // login card (and other content) isn't hidden under the header.
  // ensureHeaderSpacing: reserve top padding for sticky header
  (function ensureHeaderSpacing() {
    const header = document.getElementById("page-header");
    if (!header) return;

    function updateSpacing() {
      try {
        const h = header.offsetHeight || 64;
        // set a CSS var so theme rules can use it
        document.documentElement.style.setProperty(
          "--page-header-height",
          h + "px"
        );
        // add a helper class so theme.css applies padding-top
        document.body.classList.add("has-sticky-header");
      } catch (e) {
        /* ignore */
      }
    }

    // update on load and resize (debounced)
    let t = null;
    window.addEventListener("resize", () => {
      clearTimeout(t);
      t = setTimeout(updateSpacing, 120);
    });
    // run once now
    updateSpacing();
  })();

  // ----- Sign-up modal open/close wiring -----
  // wireSignupModal: open/close wiring for signup modal and focus trap
  (function wireSignupModal() {
    const modal = document.getElementById("signupModal");
    const openBtn = document.getElementById("openSignupModal");
    const closeBtn = document.getElementById("closeSignupModal");
    const overlay = document.getElementById("signupModalOverlay");
    if (!modal || !openBtn) return;

    let focusTrapCleanup = null;

    function enableFocusTrap(root) {
      const focusableSelector =
        'a[href], area[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';
      const prevActive = document.activeElement;
      const nodes = Array.from(root.querySelectorAll(focusableSelector)).filter(
        (n) => n.offsetParent !== null
      );
      if (!nodes.length)
        return () => {
          try {
            prevActive && prevActive.focus();
          } catch (_) {}
        };
      let first = nodes[0];
      let last = nodes[nodes.length - 1];

      function onKey(e) {
        if (e.key !== "Tab") return;
        if (nodes.length === 1) {
          e.preventDefault();
          nodes[0].focus();
          return;
        }
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }

      document.addEventListener("keydown", onKey);

      // focus first element
      try {
        first.focus();
      } catch (_) {}

      // return cleanup
      return () => {
        document.removeEventListener("keydown", onKey);
        try {
          prevActive && prevActive.focus();
        } catch (_) {}
      };
    }

    function openModal() {
      modal.classList.remove("hidden");
      // prevent background scroll while modal open
      document.body.classList.add("overflow-hidden");
      // enable focus trap and store cleanup
      focusTrapCleanup = enableFocusTrap(modal);
    }

    function closeModal() {
      modal.classList.add("hidden");
      document.body.classList.remove("overflow-hidden");
      // cleanup focus trap
      try {
        if (typeof focusTrapCleanup === "function") focusTrapCleanup();
      } catch (e) {}
      openBtn.focus();
    }

    openBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      openModal();
    });
    closeBtn &&
      closeBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        closeModal();
      });
    overlay && overlay.addEventListener("click", () => closeModal());

    // ESC to close
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && !modal.classList.contains("hidden"))
        closeModal();
    });

    // Close modal when signup succeeds (signup.js will dispatch 'signup:success')
    document.addEventListener("signup:success", (ev) => {
      // show success toast if available
      try {
        if (ev && ev.detail && ev.detail.message)
          showToast("success", ev.detail.message);
        else showToast("success", "Registration successful");
      } catch (_) {}
      closeModal();
    });
  })();
});
