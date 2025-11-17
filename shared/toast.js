// showToast / dismissToast: lightweight toast UI helpers
(function () {
  if (typeof window !== "undefined" && typeof window.showToast === "function") {
    return;
  }

  // track currently visible toast
  let currentToast = null;

  function ensureToastContainer() {
    let c = document.getElementById("toastContainer");
    if (!c) {
      c = document.createElement("div");
      c.id = "toastContainer";
      c.setAttribute("aria-live", "polite");
      c.style.position = "fixed";
      // top-center placement (slightly below chrome)
      c.style.top = "24px";
      c.style.left = "50%";
      c.style.transform = "translateX(-50%)";
      c.style.zIndex = "9999";
      c.style.display = "flex";
      c.style.flexDirection = "column";
      c.style.gap = "8px";
      // container should not block pointer events; individual toasts receive pointer events
      c.style.pointerEvents = "none";
      document.body.appendChild(c);
    } else {
      try {
        c.style.position = "fixed";
        c.style.top = "24px";
        c.style.left = "50%";
        c.style.right = "";
        c.style.bottom = "";
        c.style.transform = "translateX(-50%)";
        c.style.zIndex = "9999";
        c.style.display = "flex";
        c.style.flexDirection = "column";
        c.style.gap = "8px";
        c.style.alignItems = "center";
        c.style.pointerEvents = "none";
      } catch (e) {}
    }
    return c;
  }

  function dismissToast(el) {
    if (!el) return;
    if (currentToast === el) currentToast = null;
    // Slide up animation on exit
    try {
      el.style.opacity = "0";
      el.style.transform = "translateY(-20px)";
    } catch (e) {}
    setTimeout(() => {
      try {
        el.remove();
      } catch (e) {}
    }, 300);
  }

  function makeToastEl(type, message) {
    const toast = document.createElement("div");
    toast.className = `toast toast--${type}`;
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    // Minimal inline styles - let theme.css handle most styling
    toast.style.opacity = "0";
    toast.style.transition =
      "opacity 300ms ease, transform 400ms cubic-bezier(0.34, 1.56, 0.64, 1)";
    toast.style.transform = "translateY(-30px)";
    // allow the toast to receive pointer events (so close button works)
    toast.style.pointerEvents = "auto";

    toast.innerHTML = `
            <div class="toast-icon">${
              type === "success"
                ? '<i class="fas fa-check-circle"></i>'
                : type === "info"
                ? '<i class="fas fa-info-circle"></i>'
                : '<i class="fas fa-exclamation-circle"></i>'
            }</div>
            <div class="toast-body">${String(message)}</div>
            <button class="toast-close" aria-label="Dismiss">&times;</button>
        `;
    const closeBtn = toast.querySelector(".toast-close");
    closeBtn.addEventListener("click", () => dismissToast(toast));
    // Use transitionend for our fade-out fallback
    toast.addEventListener("transitionend", (ev) => {
      if (ev.propertyName === "opacity" && toast.style.opacity === "0")
        toast.remove();
    });
    return toast;
  }

  function showToast(type, message, opts = {}) {
    try {
      const container = ensureToastContainer();
      // Remove any existing toast immediately to enforce singleton behavior
      if (currentToast && currentToast.parentNode) {
        try {
          currentToast.remove();
        } catch (_) {
          /* ignore */
        }
        currentToast = null;
      } else {
        // As a safety net, remove any lingering .toast elements
        Array.from(container.querySelectorAll(".toast")).forEach((el) => {
          try {
            el.remove();
          } catch (_) {}
        });
      }

      const t = makeToastEl(type, message);
      currentToast = t;
      container.insertBefore(t, container.firstChild);
      // Trigger slide-down entrance animation
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          t.style.opacity = "1";
          t.style.transform = "translateY(0)";
        });
      });
      const timeout = opts.timeout || (type === "success" ? 3000 : 5000);
      let to = setTimeout(() => dismissToast(t), timeout);
      t.addEventListener("mouseenter", () => {
        if (to) {
          clearTimeout(to);
          to = null;
        }
      });
      t.addEventListener("mouseleave", () => {
        if (!to) {
          to = setTimeout(() => dismissToast(t), 1600);
        }
      });
      t.addEventListener("removed", () => {
        if (currentToast === t) currentToast = null;
      });
      return t;
    } catch (e) {
      /* ignore */
    }
  }

  window.showToast = showToast;
  window.dismissToast = dismissToast;
})();
