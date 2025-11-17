(function () {
  try {
    const STORAGE_KEY = "theme";
    function getCurrentTheme() {
      const html = document.documentElement;
      return html.classList.contains("dark")
        ? "dark"
        : html.getAttribute("data-theme") || "light";
    }

    function persistTheme(theme) {
      try {
        localStorage.setItem(STORAGE_KEY, theme);
        sessionStorage.setItem(STORAGE_KEY, theme);
      } catch (_) {}
    }

    function applyTheme(theme) {
      const html = document.documentElement;
      html.classList.toggle("dark", theme === "dark");
      html.setAttribute("data-theme", theme);
      try {
        document.body.setAttribute("data-theme", theme);
      } catch (_) {}
      try {
        document.body.style.backgroundColor = "var(--bg-surface)";
        document.body.style.color = "var(--text-primary)";
      } catch (_) {}
    }

    function initFromStorageOrSystem() {
      try {
        const stored =
          localStorage.getItem(STORAGE_KEY) ||
          sessionStorage.getItem(STORAGE_KEY);
        if (stored === "dark" || stored === "light") {
          applyTheme(stored);
          return;
        }
      } catch (_) {}
      const prefersDark =
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches;
      applyTheme(prefersDark ? "dark" : "light");
    }

    function toggleTheme() {
      const next = getCurrentTheme() === "dark" ? "light" : "dark";
      applyTheme(next);
      persistTheme(next);
      try {
        window.dispatchEvent(
          new CustomEvent("theme:changed", { detail: { theme: next } })
        );
      } catch (_) {}
    }

    function updateToggleIcons() {
      const isDark = getCurrentTheme() === "dark";
      document.querySelectorAll("[data-theme-toggle]").forEach((el) => {
        const label = isDark ? "Dark mode" : "Light mode";
        el.setAttribute("aria-label", label);
        el.title = label;
        const icons = el.querySelectorAll(
          "i.fa-sun, i.fa-moon, i.icon-sun, i.icon-moon"
        );
        icons.forEach((ic) => {
          try {
            const style = window.getComputedStyle(ic);
            if (style && parseFloat(style.opacity) > 0) {
              ic.classList.add("rotating");
              setTimeout(() => ic.classList.remove("rotating"), 400);
            }
          } catch (_) {}
        });
      });
    }

    initFromStorageOrSystem();
    updateToggleIcons();

    document.querySelectorAll("[data-theme-toggle]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        toggleTheme();
        updateToggleIcons();
      });
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleTheme();
          updateToggleIcons();
        }
      });
    });

    try {
      const html = document.documentElement;
      const mo = new MutationObserver(() => updateToggleIcons());
      mo.observe(html, {
        attributes: true,
        attributeFilter: ["data-theme", "class"],
      });
      window.addEventListener("theme:changed", updateToggleIcons);
    } catch (_) {}
  } catch (_) {}
})();
