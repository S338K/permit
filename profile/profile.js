import { checkSession, initIdleTimer, logoutUser } from "../shared/session.js";
import { formatDate24, formatLastLogin } from "../date-utils.js";
import { API_BASE } from "../config.js";

document.addEventListener("DOMContentLoaded", async function () {
  // Keep the latest data in memory for charts/toggles
  let latestUserPermits = [];
  let latestStats = { Approved: 0, Pending: 0, Rejected: 0 };

  // Global chart instances to prevent duplicates
  window.chartInstances = window.chartInstances || {};

  // Track which lazy inits have already run
  const lazyInitCalled = new Set();

  // Lazy init registry: map a sectionId to a function that initializes charts/content when opened
  const lazyInitMap = {
    permitAnalytics: () => createPermitCharts(),
    approvalAnalytics: () => {
      // approval time chart initializes when permits data arrives; placeholder
    },
  };

  // Page-specific layout adjustments that were previously inline in profile.html
  function markAsProfilePage() {
    try {
      const layoutWrapper = document.querySelector("[data-layout-wrapper]");
      if (layoutWrapper) {
        layoutWrapper.classList.remove("container");
        layoutWrapper.classList.add("w-full");
      }

      const mainContent = document.getElementById("main-content");
      if (mainContent) {
        mainContent.classList.remove("admin-full-width");
      }

      const pageMain = document.querySelector("main");
      if (pageMain) pageMain.classList.add("w-full");
    } catch (e) {
      console.warn("markAsProfilePage failed", e);
    }
  }

  // Ensure we run the layout adjustments now and when the shared layout mounts
  try {
    // If we're still loading, wait; otherwise run immediately
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", markAsProfilePage);
    } else {
      markAsProfilePage();
    }
  } catch (e) {
    console.warn("profile layout init failed", e);
  }

  // When the shared layout script dispatches its mount event, re-run adjustments
  window.addEventListener("layout:mounted", markAsProfilePage);

  // Permits table sort/filter state
  let _permitsSortField = null;
  let _permitsSortOrder = "asc";
  let _permitsCurrentPage = 1;
  let _permitsPerPage = 10;

  // Debounce helper
  function debounce(fn, wait = 200) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  // Simple HTML escape used when inserting fetched values
  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Fallback view trigger used by action buttons
  function triggerView(id) {
    try {
      if (typeof window.viewPermitDetails === "function") {
        window.viewPermitDetails(id);
        return;
      }
    } catch (e) {}
    const ev = new CustomEvent("profile:view-permit", { detail: { id } });
    document.dispatchEvent(ev);
  }

  // The shared permit modal (shared/permit-modal.js) provides the
  // view behavior and `window.viewPermitDetails(id)`. This file uses
  // `triggerView(id)` (defined above) which will call the shared API
  // when present, or dispatch `profile:view-permit` for backwards
  // compatibility.

  // Helpers for analytics
  function monthKeyFromDate(d) {
    const dt = new Date(d);
    if (isNaN(dt)) return null;
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
  }

  function percentChange(curr, prev) {
    if (prev === 0 && curr === 0) return 0;
    if (prev === 0) return 100;
    return Math.round(((curr - prev) / Math.abs(prev)) * 100);
  }

  function formatDurationHours(hours) {
    if (hours === "--" || hours === undefined || hours === null) return "--";
    if (typeof hours !== "number") return String(hours);
    if (hours < 1) {
      const mins = Math.round(hours * 60);
      return `${mins}m`;
    }
    if (hours < 24) return `${Math.round(hours)}h`;
    const days = Math.round(hours / 24);
    return `${days}d`;
  }

  function renderSparkline(canvasId, values, color) {
    // Render a small inline SVG sparkline for crisp rendering at small sizes.
    const el = document.getElementById(canvasId);
    if (!el) return;
    // Prefer using the element's client size; fall back to sensible defaults.
    const parent = el.parentElement || document.body;
    const width = Math.max(
      40,
      Math.round(parent.clientWidth || el.clientWidth || 140)
    );
    // Determine height from computed style or breakpoints
    const computedHeight = parseInt(getComputedStyle(el).height, 10);
    const height =
      Number.isFinite(computedHeight) && computedHeight > 0
        ? computedHeight
        : window.matchMedia("(min-width: 768px)").matches
        ? 32
        : 24;

    // Normalize values: keep null/undefined as gaps
    const nums = Array.isArray(values)
      ? values.map((v) => (v === undefined ? null : v))
      : [];
    const valid = nums
      .filter((v) => v !== null && Number.isFinite(v))
      .map(Number);
    const min = valid.length ? Math.min(...valid) : 0;
    const max = valid.length ? Math.max(...valid) : min + 1;
    const range = max - min || 1;

    const padding = 4;
    const innerW = Math.max(1, width - padding * 2);
    const innerH = Math.max(1, height - padding * 2);

    const n = nums.length || 1;
    const step = n > 1 ? innerW / (n - 1) : innerW;

    const points = [];
    for (let i = 0; i < n; i++) {
      const v = nums[i];
      const x = Math.round(padding + (n === 1 ? innerW / 2 : i * step));
      const y =
        v === null || v === undefined
          ? null
          : Math.round(padding + innerH - ((Number(v) - min) / range) * innerH);
      points.push({ x, y });
    }

    // Build path and area (break on nulls)
    let lineD = "";
    let areaD = "";
    const firstIdx = points.findIndex((p) => p.y !== null && p.y !== undefined);
    const lastIdx = (() => {
      for (let i = points.length - 1; i >= 0; i--)
        if (points[i].y !== null && points[i].y !== undefined) return i;
      return -1;
    })();

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.y === null || p.y === undefined) continue;
      if (
        i === 0 ||
        points[i - 1].y === null ||
        points[i - 1].y === undefined
      ) {
        lineD += `M ${p.x} ${p.y} `;
      } else {
        lineD += `L ${p.x} ${p.y} `;
      }
    }

    if (firstIdx !== -1 && lastIdx !== -1) {
      const baseY = height - padding;
      areaD = `M ${points[firstIdx].x} ${baseY} `;
      for (let i = firstIdx; i <= lastIdx; i++) {
        const p = points[i];
        if (p.y === null || p.y === undefined) continue;
        areaD += `L ${p.x} ${p.y} `;
      }
      areaD += `L ${points[lastIdx].x} ${baseY} Z`;
    }

    // Create SVG elements
    const SVG_NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");

    // defs for gradient fill
    const defs = document.createElementNS(SVG_NS, "defs");
    const grad = document.createElementNS(SVG_NS, "linearGradient");
    const gradId = `g_${canvasId}`;
    grad.setAttribute("id", gradId);
    grad.setAttribute("x1", "0");
    grad.setAttribute("y1", "0");
    grad.setAttribute("x2", "0");
    grad.setAttribute("y2", "1");
    const stop1 = document.createElementNS(SVG_NS, "stop");
    stop1.setAttribute("offset", "0%");
    stop1.setAttribute("stop-color", color);
    stop1.setAttribute("stop-opacity", "0.12");
    const stop2 = document.createElementNS(SVG_NS, "stop");
    stop2.setAttribute("offset", "100%");
    stop2.setAttribute("stop-color", color);
    stop2.setAttribute("stop-opacity", "0");
    grad.appendChild(stop1);
    grad.appendChild(stop2);
    defs.appendChild(grad);
    svg.appendChild(defs);

    // area path
    if (areaD) {
      const areaPath = document.createElementNS(SVG_NS, "path");
      areaPath.setAttribute("d", areaD);
      areaPath.setAttribute("fill", `url(#${gradId})`);
      areaPath.setAttribute("stroke", "none");
      svg.appendChild(areaPath);
    }

    // line path
    if (lineD) {
      const linePath = document.createElementNS(SVG_NS, "path");
      linePath.setAttribute("d", lineD);
      linePath.setAttribute("fill", "none");
      linePath.setAttribute("stroke", color);
      linePath.setAttribute("stroke-width", "1.5");
      linePath.setAttribute("stroke-linecap", "round");
      linePath.setAttribute("stroke-linejoin", "round");
      svg.appendChild(linePath);
    }

    // replace existing element content
    try {
      // If the target is already an <svg>, replace its contents; otherwise replace the element with new svg
      if (el.tagName && el.tagName.toLowerCase() === "svg") {
        el.innerHTML = "";
        // copy attributes from created svg to existing element
        el.setAttribute("viewBox", svg.getAttribute("viewBox"));
        el.setAttribute("preserveAspectRatio", "none");
        while (svg.firstChild) el.appendChild(svg.firstChild);
      } else {
        el.parentNode.replaceChild(svg, el);
      }
    } catch (err) {
      console.warn("renderSparkline SVG failed", err);
    }
  }

  // Center-text plugin for doughnut chart (renders center value)
  const centerTextPlugin = {
    id: "centerText",
    beforeDraw(chart) {
      const opts = chart.options.plugins && chart.options.plugins.centerText;
      if (!opts) return;
      const value = opts.value !== undefined ? opts.value : "";
      const color =
        opts.color ||
        getComputedStyle(document.documentElement).getPropertyValue(
          "--hia-blue"
        ) ||
        "#273172";
      const font = opts.font || "600 20px system-ui, -apple-system, 'Segoe UI'";
      const ctx = chart.ctx;
      const x = chart.width / 2;
      const y = chart.height / 2;
      ctx.save();
      ctx.fillStyle = color.trim() || "#273172";
      ctx.font = font;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(value), x, y);
      ctx.restore();
    },
  };

  function animateDoughnutCenter(chart, fromVal, toVal, duration = 700) {
    if (!chart) return;
    const start = performance.now();
    const diff = toVal - fromVal;
    function step(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // easeInOutQuad-like
      const current = Math.round(fromVal + diff * eased);
      chart.options.plugins = chart.options.plugins || {};
      chart.options.plugins.centerText = chart.options.plugins.centerText || {};
      chart.options.plugins.centerText.value = current;
      chart.update("none");
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // Render permits table from `latestUserPermits` applying filters and sort
  function renderPermitsTable() {
    const tbody = document.querySelector("#permitsTableBody");
    if (!tbody) return;

    const searchTerm = (
      document.getElementById("permitsSearchInput")?.value || ""
    ).toLowerCase();
    const statusFilter =
      document.getElementById("permitsStatusFilter")?.value || "";

    let list = Array.isArray(latestUserPermits) ? [...latestUserPermits] : [];

    // Filter
    list = list.filter((p) => {
      const matchesSearch =
        !searchTerm ||
        (p.permitTitle && p.permitTitle.toLowerCase().includes(searchTerm)) ||
        (p.permitNumber && p.permitNumber.toLowerCase().includes(searchTerm));
      const matchesStatus =
        !statusFilter || (p.status || "").toString() === statusFilter;
      return matchesSearch && matchesStatus;
    });

    // Sort
    if (_permitsSortField) {
      const field = _permitsSortField;
      list.sort((a, b) => {
        let aVal = "";
        let bVal = "";
        if (field === "submitted") {
          aVal = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          bVal = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        } else if (field === "title") {
          aVal = (a.permitTitle || "").toString().toLowerCase();
          bVal = (b.permitTitle || "").toString().toLowerCase();
        } else if (field === "status") {
          aVal = (a.status || "").toString().toLowerCase();
          bVal = (b.status || "").toString().toLowerCase();
        } else if (field === "permitNumber") {
          aVal = (a.permitNumber || "").toString().toLowerCase();
          bVal = (b.permitNumber || "").toString().toLowerCase();
        }
        if (aVal < bVal) return _permitsSortOrder === "asc" ? -1 : 1;
        if (aVal > bVal) return _permitsSortOrder === "asc" ? 1 : -1;
        return 0;
      });
    }

    // Pagination
    const total = list.length;
    const totalPages = Math.max(1, Math.ceil(total / _permitsPerPage));
    if (_permitsCurrentPage > totalPages) _permitsCurrentPage = totalPages;
    const start = (_permitsCurrentPage - 1) * _permitsPerPage;
    const end = start + _permitsPerPage;
    const paginated = list.slice(start, end);

    // Update counts and pagination UI
    const showingCountEl = document.getElementById("permitsShowingCount");
    const totalCountEl = document.getElementById("permitsTotalCount");
    if (showingCountEl) showingCountEl.textContent = paginated.length;
    if (totalCountEl) totalCountEl.textContent = total;
    renderPermitsPagination(totalPages);

    // Build desktop grid cards (render into #permitsGrid) and table rows (mobile/fallback)
    const grid = document.getElementById("permitsGrid");
    if (grid) grid.innerHTML = "";

    // Build table rows
    tbody.innerHTML = "";
    paginated.forEach((permit, idx) => {
      // Create a card for desktop grid
      if (grid) {
        const card = document.createElement("article");
        card.className = "permit-card";

        const hdr = document.createElement("div");
        hdr.className = "permit-card-header";

        const serial = document.createElement("div");
        serial.className = "text-sm text-[var(--text-secondary)]";
        serial.textContent = `#${start + idx + 1}`;

        const submitted = document.createElement("div");
        submitted.className = "text-sm text-[var(--text-secondary)]";
        submitted.textContent = permit.createdAt
          ? formatDate24(permit.createdAt)
          : "—";

        hdr.appendChild(serial);
        hdr.appendChild(submitted);

        const titleEl = document.createElement("h3");
        titleEl.className = "permit-title";
        titleEl.textContent = permit.permitTitle || "—";

        // Permit number shown under the title
        const numberSpan = document.createElement("div");
        numberSpan.className =
          "permit-number text-sm text-[var(--text-secondary)]";
        if (permit.status === "Approved" && permit.permitNumber) {
          numberSpan.textContent = permit.permitNumber;
        } else {
          numberSpan.textContent = "—";
        }

        // Title block: title then permit number
        const titleBlock = document.createElement("div");
        titleBlock.className = "permit-title-block";
        titleBlock.appendChild(titleEl);
        titleBlock.appendChild(numberSpan);

        const meta = document.createElement("div");
        meta.className = "permit-meta";
        const statusValue = permit.status || "Pending";
        const badge = document.createElement("span");
        badge.textContent = statusValue;
        const statusClass = statusValue.toLowerCase().replace(/\s+/g, "-");
        badge.classList.add("status-badge", statusClass);
        meta.appendChild(badge);

        const actions = document.createElement("div");
        actions.className = "permit-actions";
        const viewBtn = document.createElement("button");
        viewBtn.className =
          "inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--muted-100)] text-[var(--muted-700)] btn-view";
        viewBtn.type = "button";
        viewBtn.title = "View Permit";
        viewBtn.textContent = "View";
        viewBtn.addEventListener("click", (e) => {
          e.preventDefault();
          triggerView(permit._id);
        });
        actions.appendChild(viewBtn);
        if (permit.status === "Approved" && permit.permitNumber) {
          const dlBtn = document.createElement("button");
          dlBtn.className =
            "inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-white text-hia-blue btn-download btn-submit";
          dlBtn.type = "button";
          dlBtn.title = "Download PDF";

          dlBtn.textContent = "Download";
          dlBtn.addEventListener("click", (e) => {
            handlePermitClick(e, permit._id, permit.permitNumber);
          });
          actions.appendChild(dlBtn);
        }

        card.appendChild(hdr);
        card.appendChild(titleBlock);
        card.appendChild(meta);
        card.appendChild(actions);

        grid.appendChild(card);
      }

      const row = document.createElement("tr");

      const serialTd = document.createElement("td");
      serialTd.setAttribute("data-label", "Serial Number");
      serialTd.textContent = start + idx + 1;

      const submittedTd = document.createElement("td");
      submittedTd.setAttribute("data-label", "Submitted On");
      submittedTd.textContent = permit.createdAt
        ? formatDate24(permit.createdAt)
        : "—";

      const titleTd = document.createElement("td");
      titleTd.setAttribute("data-label", "Permit Title");
      titleTd.className = "w-[320px] md:w-[420px] lg:w-[520px]";
      const titleText = permit.permitTitle || "—";
      const titleWrap = document.createElement("span");
      titleWrap.className = "truncate block w-full";
      titleWrap.textContent = titleText;
      titleWrap.title = titleText;
      titleTd.appendChild(titleWrap);

      const statusTd = document.createElement("td");
      statusTd.setAttribute("data-label", "Status");
      const statusValue = permit.status || "Pending";
      const badge = document.createElement("span");
      badge.textContent = statusValue;
      const statusClass = statusValue.toLowerCase().replace(/\s+/g, "-");
      badge.classList.add("status-badge", statusClass);
      statusTd.appendChild(badge);

      const numberTd = document.createElement("td");
      numberTd.setAttribute("data-label", "Permit Number");
      if (permit.status === "Approved" && permit.permitNumber) {
        // Display only the permit number (download via action button)
        numberTd.textContent = permit.permitNumber;
      } else {
        numberTd.textContent = "—";
      }

      const actionTd = document.createElement("td");
      actionTd.setAttribute("data-label", "Action");
      // Simple actions: View and Download (if approved)
      const viewBtn = document.createElement("button");
      viewBtn.className =
        "inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium btn-view";
      viewBtn.type = "button";
      viewBtn.title = "View Permit";
      viewBtn.textContent = "View";
      viewBtn.addEventListener("click", (e) => {
        e.preventDefault();
        triggerView(permit._id);
      });
      actionTd.appendChild(viewBtn);
      if (permit.status === "Approved" && permit.permitNumber) {
        const dlBtn = document.createElement("button");
        dlBtn.className =
          "inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-hia-blue text-white ml-2 btn-download btn-submit";
        dlBtn.type = "button";
        dlBtn.title = "Download PDF";
        dlBtn.textContent = "Download";
        dlBtn.addEventListener("click", (e) => {
          handlePermitClick(e, permit._id, permit.permitNumber);
        });
        actionTd.appendChild(dlBtn);
      }

      row.appendChild(serialTd);
      row.appendChild(submittedTd);
      row.appendChild(titleTd);
      row.appendChild(statusTd);
      row.appendChild(numberTd);
      row.appendChild(actionTd);

      tbody.appendChild(row);
    });

    // If grid exists and there are no permits, show empty state
    if (grid && paginated.length === 0) {
      const empty = document.createElement("div");
      empty.className = "text-center text-[var(--text-secondary)] p-6";
      empty.textContent = "No permits found.";
      grid.appendChild(empty);
    }
  }

  // Attach filters and header sort handlers for permits
  function setupPermitsFilters() {
    const search = document.getElementById("permitsSearchInput");
    const status = document.getElementById("permitsStatusFilter");
    if (search)
      search.addEventListener(
        "input",
        debounce(() => {
          _permitsCurrentPage = 1;
          renderPermitsTable();
        }, 180)
      );
    if (status)
      status.addEventListener("change", () => {
        _permitsCurrentPage = 1;
        renderPermitsTable();
      });

    // header sorts
    const headers = Array.from(
      document.querySelectorAll("#permitsTable thead [data-sort]")
    );
    headers.forEach((th, index) => {
      // make focusable for keyboard navigation
      th.setAttribute("tabindex", "0");
      th.addEventListener("click", () => {
        const field = th.getAttribute("data-sort");
        if (_permitsSortField === field) {
          _permitsSortOrder = _permitsSortOrder === "asc" ? "desc" : "asc";
        } else {
          _permitsSortField = field;
          _permitsSortOrder = "asc";
        }
        // update icons
        document
          .querySelectorAll(
            "#permitsTable thead i.fas.fa-sort, #permitsTable thead i.fas.fa-sort-up, #permitsTable thead i.fas.fa-sort-down"
          )
          .forEach((i) => {
            i.classList.remove("fa-sort-up", "fa-sort-down");
            i.classList.add("fa-sort");
          });
        const icon = th.querySelector("i.fas");
        if (icon) {
          icon.classList.remove("fa-sort");
          icon.classList.add(
            _permitsSortOrder === "asc" ? "fa-sort-up" : "fa-sort-down"
          );
        }
        renderPermitsTable();
      });

      // keyboard navigation for headers
      th.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          th.click();
        } else if (ev.key === "ArrowRight" || ev.key === "ArrowDown") {
          ev.preventDefault();
          const next = headers[(index + 1) % headers.length];
          if (next) next.focus();
        } else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") {
          ev.preventDefault();
          const prev = headers[(index - 1 + headers.length) % headers.length];
          if (prev) prev.focus();
        }
      });
    });

    // Pagination click handler (attach once)
    const paginationContainer = document.getElementById("permitsPagination");
    if (paginationContainer && !paginationContainer._permitsBound) {
      paginationContainer._permitsBound = true;
      paginationContainer.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-page]");
        if (!btn) return;
        const page = parseInt(btn.getAttribute("data-page"), 10);
        if (isNaN(page)) return;
        _permitsCurrentPage = Math.max(1, page);
        renderPermitsTable();
      });
    }
  }

  // Render pagination controls for permits
  function renderPermitsPagination(totalPages) {
    const container = document.getElementById("permitsPagination");
    if (!container) return;

    if (totalPages <= 1) {
      container.innerHTML = "";
      return;
    }

    let html = [];

    // Previous button
    html.push(`
      <button class="px-3 py-1.5 rounded-lg border border-[var(--input-border)] text-sm font-medium transition-colors ${
        _permitsCurrentPage === 1
          ? "opacity-50 cursor-not-allowed"
          : "hover:bg-[var(--input-bg)]"
      }" ${_permitsCurrentPage === 1 ? "disabled" : ""} data-action="permitsChangePage" data-page="${_permitsCurrentPage - 1}">
        <i class="fas fa-chevron-left text-xs"></i>
      </button>
    `);

    // Page numbers (limit to first 5 for brevity)
    const maxPagesToShow = Math.min(totalPages, 5);
    for (let i = 1; i <= maxPagesToShow; i++) {
      html.push(`
        <button class="px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${
          i === _permitsCurrentPage
            ? "bg-hia-blue text-white border-hia-blue"
            : "border-[var(--input-border)] hover:bg-[var(--input-bg)]"
        }" data-action="permitsChangePage" data-page="${i}">${i}</button>
      `);
    }

    if (totalPages > 5) {
      html.push('<span class="px-2 text-[var(--text-secondary)]">...</span>');
      html.push(`
        <button class="px-3 py-1.5 rounded-lg border border-[var(--input-border)] text-sm font-medium hover:bg-[var(--input-bg)]" data-action="permitsChangePage" data-page="${totalPages}">${totalPages}</button>
      `);
    }

    // Next button
    html.push(`
      <button class="px-3 py-1.5 rounded-lg border border-[var(--input-border)] text-sm font-medium transition-colors ${
        _permitsCurrentPage === totalPages
          ? "opacity-50 cursor-not-allowed"
          : "hover:bg-[var(--input-bg)]"
      }" ${_permitsCurrentPage === totalPages ? "disabled" : ""} data-action="permitsChangePage" data-page="${_permitsCurrentPage + 1}">
        <i class="fas fa-chevron-right text-xs"></i>
      </button>
    `);

    container.innerHTML = html.join("");
  }

  // ========== CENTRAL EVENT DELEGATION FOR [data-action] ==========
  document.addEventListener("click", function (e) {
    let el = e.target;
    // Traverse up to find [data-action] (in case of icon inside button, etc)
    while (el && el !== document) {
      if (el.dataset && el.dataset.action) {
        // Support multiple actions in data-action (space/comma separated)
        const actions = el.dataset.action.split(/[ ,]+/);
        const section = el.dataset.section;
        const actionMap = {
          toggleSection: (sectionId) => toggleSection(sectionId),
          "toggle-section": (sectionId) => toggleSection(sectionId),
          submitNewRequest: () => submitNewRequest(),
          "submit-new-request": () => submitNewRequest(),
          downloadActivity: () => downloadActivity(),
          "download-activity": () => downloadActivity(),
          showUpdatePasswordModal: () => showUpdatePasswordModal(),
          "show-update-password-modal": () => showUpdatePasswordModal(),
          logoutUser: () => logoutUser(),
          "logout-user": () => logoutUser(),
          hideProfileSettings: () => hideProfileSettings(),
          "hide-profile-settings": () => hideProfileSettings(),
          showProfileSettings: () => showProfileSettings(),
          "show-profile-settings": () => showProfileSettings(),
        };
        let handled = false;
        for (const action of actions) {
          if (actionMap[action]) {
            e.preventDefault();
            e.stopPropagation();
            if (action === "toggleSection" || action === "toggle-section") {
              actionMap[action](section);
            } else {
              actionMap[action]();
            }
            handled = true;
          }
        }
        if (handled) break;
      }
      el = el.parentElement;
    }
  });
  // Toggle icon handling removed for profile page (chevrons not used)

  // Attach safe handlers for inline-onclick buttons (module scope can make inline handlers fail)
  function attachInlineHandlers() {
    // mapping: attribute substring -> function to call
    const map = {
      submitNewRequest: submitNewRequest,
      downloadActivity: downloadActivity,
      toggleSection: toggleSection,
      showUpdatePasswordModal: showUpdatePasswordModal,
      logoutUser: logoutUser,
      hideProfileSettings: hideProfileSettings,
    };

    Object.keys(map).forEach((key) => {
      try {
        const els = document.querySelectorAll(`[onclick*="${key}"]`);
        els.forEach((el) => {
          // avoid double-binding
          if (!el.dataset.boundInline) {
            el.addEventListener("click", (e) => {
              e.preventDefault();
              try {
                map[key]();
              } catch (err) {
                console.error("inline handler error", key, err);
              }
            });
            el.dataset.boundInline = "1";
          }
        });
      } catch (err) {
        console.warn("attachInlineHandlers error for", key, err);
      }
    });
  }

  attachInlineHandlers();

  const user = await checkSession();
  if (!user) return;
  initIdleTimer();

  /* ===== Populate Profile Card ===== */
  const fullNameEl = document.getElementById("profileFullName");
  if (fullNameEl)
    fullNameEl.textContent = user.fullName || user.username || "—";

  const emailEl = document.getElementById("profileEmail");
  if (emailEl) emailEl.textContent = user.email || "—";

  const companyEl = document.getElementById("profileCompany");
  // company display removed from profile overview

  /* ===== Populate Avatar and Display Names ===== */
  const profileInitials = (user.fullName || user.username || "U")
    .charAt(0)
    .toUpperCase();

  // Update main profile avatar
  const profileInitialsEl = document.getElementById("profileInitials");
  if (profileInitialsEl) profileInitialsEl.textContent = profileInitials;

  // Update large avatar in profile card
  const profileAvatarLarge = document.getElementById("profileAvatarLarge");
  if (profileAvatarLarge) profileAvatarLarge.textContent = profileInitials;

  // Header display name moved into dropdown; ensure main header element is not modified here
  const profileDisplayNameMain = document.getElementById(
    "profileDisplayNameMain"
  );
  if (profileDisplayNameMain)
    profileDisplayNameMain.textContent =
      user.fullName || user.username || "User";

  /* ===== Populate Hover Tooltip Elements ===== */
  const hoverInitials = document.getElementById("hoverInitials");
  if (hoverInitials) hoverInitials.textContent = profileInitials;

  const hoverName = document.getElementById("hoverName");
  if (hoverName)
    hoverName.textContent = user.fullName || user.username || "User";

  const hoverRole = document.getElementById("hoverRole");
  if (hoverRole) hoverRole.textContent = "System User";

  const hoverEmail = document.getElementById("hoverEmail");
  if (hoverEmail) hoverEmail.textContent = user.email || "—";

  const hoverPhone = document.getElementById("hoverPhone");
  // Accept mobile, mobileNumber, phoneNumber, contact objects
  const phoneVal =
    user.mobile ||
    user.mobileNumber ||
    user.phone ||
    user.phoneNumber ||
    (user.contact && (user.contact.mobile || user.contact.phone)) ||
    "Not provided";
  if (hoverPhone) hoverPhone.textContent = phoneVal;

  const hoverJoinDate = document.getElementById("hoverJoinDate");
  if (hoverJoinDate) {
    // Prefer createdAt from user record and format as 'Month Year'
    const created =
      user.createdAt || user.created_at || user.joinDate || user.registeredAt;
    if (created) {
      const d = new Date(created);
      try {
        const monthYear = d.toLocaleString(undefined, {
          month: "long",
          year: "numeric",
        });
        hoverJoinDate.textContent = `Member since ${monthYear}`;
      } catch (e) {
        hoverJoinDate.textContent = `Member since ${d.getFullYear()}`;
      }
    } else {
      hoverJoinDate.textContent = "Member since Unknown";
    }
  }

  // Populate IP address (server should send client IP on session)
  const hoverIp = document.getElementById("hoverIp");
  if (hoverIp) {
    // Prefer server-provided client IP fields if available
    let ip =
      user.clientIp ||
      user.ip ||
      user.ipAddress ||
      user.ip_address ||
      user.remoteAddress ||
      null;
    if (ip) {
      hoverIp.textContent = `IP Address: ${ip}`;
    } else {
      // Try a backend endpoint that returns the client IP (non-blocking)
      fetch(`${API_BASE}/api/client-ip`, { credentials: "include" })
        .then((res) => {
          if (!res.ok) throw new Error("no-ip-endpoint");
          return res.json();
        })
        .then((data) => {
          if (data && (data.ip || data.clientIp)) {
            hoverIp.textContent = `IP Address: ${data.ip || data.clientIp}`;
          }
        })
        .catch(() => {
          // Optional public fallback. If you prefer not to call external services, remove this block
          fetch("https://api.ipify.org?format=json")
            .then((r) => r.json())
            .then((d) => {
              if (d && d.ip) hoverIp.textContent = `IP Address: ${d.ip}`;
            })
            .catch(() => {
              hoverIp.textContent = "IP Address: Unknown";
            });
        });
    }
  }

  // Set active/inactive status badge
  const hoverStatusBadge = document.getElementById("hoverStatusBadge");
  const hoverStatusText = document.getElementById("hoverStatusText");
  const hoverStatusDot = document.getElementById("hoverStatusDot");
  const statusVal =
    user.userStatus ||
    user.status ||
    user.user_status ||
    user.userState ||
    "Active";
  if (hoverStatusText)
    hoverStatusText.textContent =
      statusVal === "Inactive" ? "Inactive" : "Active User";
  if (hoverStatusBadge) {
    if (statusVal === "Inactive") {
      hoverStatusBadge.classList.remove("bg-green-100");
      hoverStatusBadge.classList.add("bg-red-100");
      if (hoverStatusText) hoverStatusText.classList.remove("text-green-700");
      if (hoverStatusText) hoverStatusText.classList.add("text-red-600");
    } else {
      hoverStatusBadge.classList.remove("bg-red-100");
      hoverStatusBadge.classList.add("bg-green-100");
      if (hoverStatusText) hoverStatusText.classList.remove("text-red-600");
      if (hoverStatusText) hoverStatusText.classList.add("text-green-700");
    }
  }

  // Compute last login text
  let lastLoginText = "Never";
  if (user.prevLogin) {
    lastLoginText = formatLastLogin(user.prevLogin);
  } else if (user.lastLogin) {
    lastLoginText = formatLastLogin(user.lastLogin);
  } else if (user.last_login) {
    lastLoginText = formatLastLogin(user.last_login);
  }

  const lastLoginDiv = document.getElementById("profileLastLogin");
  if (lastLoginDiv) {
    lastLoginDiv.textContent = `Last Login: ${lastLoginText}`;
  }

  // Also populate hover tooltip last login in format: Last Login at <time> on <day>
  const hoverLastLogin = document.getElementById("hoverLastLogin");
  if (hoverLastLogin) {
    // Determine source date value
    let sourceDate = null;
    if (user.prevLogin) sourceDate = new Date(user.prevLogin);
    else if (user.lastLogin) sourceDate = new Date(user.lastLogin);
    else if (user.last_login) sourceDate = new Date(user.last_login);

    if (sourceDate && !isNaN(sourceDate.getTime())) {
      const now = new Date();
      const timePart = sourceDate.toLocaleTimeString(undefined, {
        hour12: false,
      });
      const isSameDay =
        sourceDate.getFullYear() === now.getFullYear() &&
        sourceDate.getMonth() === now.getMonth() &&
        sourceDate.getDate() === now.getDate();
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      const isYesterday =
        sourceDate.getFullYear() === yesterday.getFullYear() &&
        sourceDate.getMonth() === yesterday.getMonth() &&
        sourceDate.getDate() === yesterday.getDate();

      let dayPart;
      if (isSameDay) dayPart = "Today";
      else if (isYesterday) dayPart = "Yesterday";
      else
        dayPart = sourceDate.toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "2-digit",
        });

      hoverLastLogin.textContent = `Last Login at ${timePart} on ${dayPart}`;
    } else {
      hoverLastLogin.textContent = "Last Login: Never";
    }
  }

  /* ===== Load Submitted Permit Details table ===== */
  if (document.getElementById("permitsTable")) {
    try {
      const res = await fetch(`${API_BASE}/api/permit`, {
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        // support both array responses and { permits } envelope
        const list = Array.isArray(data) ? data : data.permits || [];
        const tbody =
          document.querySelector("#permitsTableBody") ||
          document.querySelector("#permitsTable tbody");
        tbody.innerHTML = "";

        // determine current user id from session user object
        const currentUserId =
          (user && (user._id || user.id || user.userId || user._id)) ||
          sessionStorage.getItem("userId");

        // filter permits to only those submitted by current user
        const userPermits = list.filter((p) => {
          if (!p) return false;
          // check common requester shapes: object or id
          if (p.requester) {
            if (typeof p.requester === "object") {
              const rid = p.requester._id || p.requester.id || p.requester;
              return String(rid) === String(currentUserId);
            }
            return String(p.requester) === String(currentUserId);
          }
          if (p.requesterId)
            return String(p.requesterId) === String(currentUserId);
          if (p.owner) return String(p.owner) === String(currentUserId);
          return false;
        });

        // compute stats for analytics
        const stats = { Approved: 0, Pending: 0, Rejected: 0 };
        userPermits.forEach((p) => {
          const st = p.status || "Pending";
          if (stats[st] === undefined) stats[st] = 0;
          stats[st]++;
        });

        // Save latest data for rendering and charts
        latestUserPermits = userPermits;
        latestStats = stats;

        // Update permit analytics with all user permits
        updatePermitAnalytics(stats, userPermits);
        createPermitCharts();

        // Setup filters and render the table
        setupPermitsFilters();
        renderPermitsTable();
      } else {
        console.warn("Failed to load permits");
      }
    } catch (err) {
      console.warn("Error fetching permits:", err);
    }
  }

  //===============PDF Download============//
  async function handlePermitClick(e, permitId, permitNumber) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) {
      return;
    }
    e.preventDefault();

    try {
      const res = await fetch(`${API_BASE}/api/permit/${permitId}/pdf`, {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/pdf" },
      });

      const contentType = res.headers.get("content-type") || "";

      if (!res.ok) {
        if (contentType.includes("application/json")) {
          const err = await res.json();
          alert(err.message || "Server error while generating PDF");
          return;
        }
        throw new Error("Server returned " + res.status);
      }

      if (contentType.includes("application/json")) {
        const err = await res.json();
        alert(err.message || "Unable to download PDF");
        return;
      }

      const blob = await res.blob();

      // derive filename from Content-Disposition if present
      let filename = `${permitNumber || permitId}.pdf`;
      const cd = res.headers.get("content-disposition");
      if (cd) {
        const m = cd.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
        if (m) filename = decodeURIComponent(m[1] || m[2]);
      }

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();

      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Error downloading PDF:", err);
      alert("Error downloading PDF");
    }
  }

  /* ===== Open shared permit modal (no redirect) ===== */
  function openPermitModal() {
    try {
      const trigger = document.querySelector(
        '[data-action="submit-new-request"]'
      );
      if (trigger) {
        trigger.click();
        return true;
      }
    } catch (_) {
      /* ignore */
    }
    return false;
  }

  const submitPtw = document.getElementById("sbmtptw");
  if (submitPtw) {
    submitPtw.addEventListener("click", function (e) {
      e.preventDefault();
      // Use shared layout modal instead of navigation
      openPermitModal();
    });
  }

  // ===== Logout button =====
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      // logout

      logoutUser();
    });
  }

  // Enhanced Profile Display Updates //
  if (typeof updateEnhancedProfileDisplay === "function") {
    try {
      updateEnhancedProfileDisplay(user);
    } catch (e) {
      console.warn("updateEnhancedProfileDisplay threw an error:", e);
    }
  }

  // Modal Form Handlers
  setupModalForms();

  // Initialize charts
  createPermitCharts();

  // Modal Functions
  function showProfileSettings() {
    const modal = document.getElementById("profileSettingsModal");
    if (modal) {
      modal.classList.remove("hidden");
    }
  }

  function hideProfileSettings() {
    const modal = document.getElementById("profileSettingsModal");
    if (modal) {
      modal.classList.add("hidden");
    }
  }

  function showUpdatePasswordModal() {
    // Delegate to shared layout's global opener
    if (window.openUpdatePasswordModal) {
      window.openUpdatePasswordModal();
    } else {
      // fallback: try to click any shared trigger if present
      const t = document.querySelector("[data-update-password-trigger]");
      if (t) t.click();
    }
  }

  function hideUpdatePasswordModal() {
    // Close the shared modal if open
    const m = document.getElementById("update-password-modal");
    if (m && !m.classList.contains("hidden")) m.classList.add("hidden");
  }

  function downloadActivity() {
    // Placeholder UI action — admin will implement server-side export
    alert("Download feature coming soon!");
  }
  // Setup Modal Forms
  function setupModalForms() {
    // Password update logic moved to shared layout; no per-page wiring needed here
  }

  // Permit Analytics Functions
  function updatePermitAnalytics(stats, permits) {
    // Update analytics numbers and compute month-over-month changes
    const total = Array.isArray(permits) ? permits.length : 0;
    const approved = stats.Approved || 0;
    const pending = stats.Pending || 0;
    const inProgress =
      stats["In Progress"] ||
      stats["In progress"] ||
      stats["in progress"] ||
      stats.InProgress ||
      stats["In Review"] ||
      stats["In review"] ||
      stats["in review"] ||
      0;
    const rejected = stats.Rejected || 0;

    const totalPermitsEl = document.getElementById("totalPermits");
    const approvedPermitsEl = document.getElementById("approvedPermits");
    const pendingPermitsEl = document.getElementById("pendingPermits");
    const inProgressPermitsEl = document.getElementById("inProgressPermits");
    const rejectedPermitsEl = document.getElementById("rejectedPermits");

    if (totalPermitsEl) totalPermitsEl.textContent = total;
    if (approvedPermitsEl) approvedPermitsEl.textContent = approved;
    if (pendingPermitsEl) pendingPermitsEl.textContent = pending;
    if (inProgressPermitsEl) inProgressPermitsEl.textContent = inProgress;
    if (rejectedPermitsEl) rejectedPermitsEl.textContent = rejected;

    // Compute month keys (last 6 months) for sparklines and comparisons
    const monthsBack = 6;
    const now = new Date();
    const monthKeys = [];
    for (let i = monthsBack - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      monthKeys.push(
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
      );
    }

    const counts = {
      total: monthKeys.map(() => 0),
      Approved: monthKeys.map(() => 0),
      Pending: monthKeys.map(() => 0),
      "In Progress": monthKeys.map(() => 0),
      Rejected: monthKeys.map(() => 0),
    };

    (permits || []).forEach((p) => {
      const key = monthKeyFromDate(p.createdAt || p.submittedAt || p.created);
      const idx = monthKeys.indexOf(key);
      if (idx === -1) return;
      counts.total[idx] = (counts.total[idx] || 0) + 1;
      const st = p.status || "Pending";
      const norm = st === "In progress" ? "In Progress" : st;
      if (counts[norm] !== undefined)
        counts[norm][idx] = (counts[norm][idx] || 0) + 1;
      else {
        // fallback: if unknown status, count in total only
      }
    });

    // Compute percent change comparing latest month to previous month
    function updateChangeElement(id, arr) {
      const el = document.getElementById(id);
      if (!el || !Array.isArray(arr)) return;
      const latest = arr[arr.length - 1] || 0;
      const prev = arr[arr.length - 2] || 0;
      const pct = percentChange(latest, prev);
      el.textContent = (pct > 0 ? "+" : "") + pct + "%";
      el.style.color = pct >= 0 ? "var(--hia-blue)" : "var(--danger-text)";
    }

    updateChangeElement("totalPermitsChange", counts.total);
    updateChangeElement("approvedPermitsChange", counts.Approved);
    updateChangeElement("pendingPermitsChange", counts.Pending);
    updateChangeElement("inProgressPermitsChange", counts["In Progress"]);
    updateChangeElement("rejectedPermitsChange", counts.Rejected);

    // Render small sparklines using last 6 months data
    try {
      renderSparkline("totalPermitsSpark", counts.total, "#273172");
      renderSparkline("approvedPermitsSpark", counts.Approved, "#10b981");
      renderSparkline("pendingPermitsSpark", counts.Pending, "#f59e0b");
      renderSparkline(
        "inProgressPermitsSpark",
        counts["In Progress"],
        "#06b6d4"
      );
      renderSparkline("rejectedPermitsSpark", counts.Rejected, "#ef4444");
    } catch (e) {
      console.warn("Failed to render sparklines", e);
    }

    // Update approval time analytics (formatting will be improved)
    updateApprovalTimeAnalytics(permits);

    // Refresh main charts (permit distribution & monthly trends)
    try {
      createPermitCharts();
    } catch (e) {
      console.warn("createPermitCharts failed", e);
    }
  }

  // Recent activity UI and rendering removed from profile.js per request

  // Approval Time Analytics
  function updateApprovalTimeAnalytics(permits) {
    // Use createdAt as a fallback for submittedAt when computing durations
    const approvedPermits = permits.filter(
      (p) =>
        p &&
        p.status === "Approved" &&
        p.approvedAt &&
        (p.submittedAt || p.createdAt)
    );

    if (approvedPermits.length === 0) {
      updateApprovalMetrics("--", "--");
      createApprovalTimeChart([]);
      return;
    }

    // Calculate approval times in hours (floating, more precise)
    const approvalTimes = approvedPermits
      .map((permit) => {
        const submitted = new Date(permit.submittedAt || permit.createdAt);
        const approved = new Date(permit.approvedAt);
        if (isNaN(submitted.getTime()) || isNaN(approved.getTime()))
          return null;
        return (approved - submitted) / (1000 * 60 * 60); // hours (float)
      })
      .filter((v) => v !== null && Number.isFinite(v));

    if (approvalTimes.length === 0) {
      updateApprovalMetrics("--", "--");
      createApprovalTimeChart([]);
      return;
    }

    // Calculate metrics with one decimal precision
    const avgTime =
      approvalTimes.reduce((a, b) => a + b, 0) / approvalTimes.length;
    const fastestTime = Math.min(...approvalTimes);

    updateApprovalMetrics(
      formatDurationHours(avgTime),
      formatDurationHours(fastestTime)
    );

    // Create trend chart
    createApprovalTimeChart(approvedPermits);
  }

  function updateApprovalMetrics(avgTime, fastestTime) {
    const avgEl = document.getElementById("avgApprovalTime");
    const fastestEl = document.getElementById("fastestApproval");

    if (avgEl) avgEl.textContent = avgTime;
    if (fastestEl) fastestEl.textContent = fastestTime;
  }

  function createApprovalTimeChart(approvedPermits) {
    const averageCtx = document.getElementById("approvalTimeChart");

    if (!averageCtx && !fastestCtx) {
      console.warn("Cannot create approval charts - missing canvas elements");
      return;
    }

    const showNoDataMessage = (canvas, message) => {
      if (!canvas || !canvas.parentElement) return;
      let note = canvas.parentElement.querySelector("[data-no-data-message]");
      if (!note) {
        note = document.createElement("p");
        note.dataset.noDataMessage = "true";
        note.className = "text-sm text-center text-gray-500 py-6";
        canvas.parentElement.appendChild(note);
      }
      note.textContent = message;
      note.classList.remove("hidden");
      canvas.classList.add("hidden");
    };

    const hideNoDataMessage = (canvas) => {
      if (!canvas || !canvas.parentElement) return;
      const note = canvas.parentElement.querySelector("[data-no-data-message]");
      if (note) {
        note.classList.add("hidden");
      }
      canvas.classList.remove("hidden");
    };

    const updateTrendLabel = (labelId, baseText, days) => {
      const labelEl = document.getElementById(labelId);
      if (!labelEl) return;
      const safeDays = Math.max(1, days);
      labelEl.textContent = `${baseText} (Last ${safeDays} Day${
        safeDays === 1 ? "" : "s"
      })`;
    };

    const DEFAULT_DAYS = 30; // fallback when no approvals present
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const today = new Date();

    const ensureChartsReady = () => {
      if (!window.Chart) {
        console.warn(
          "Chart.js not available for approval charts, retrying in 100ms..."
        );
        setTimeout(ensureChartsReady, 100);
        return;
      }

      if (!Array.isArray(approvedPermits)) approvedPermits = [];

      const buildTimelineData = (days) => {
        const timeline = [];
        for (let i = days - 1; i >= 0; i--) {
          const date = new Date(today);
          date.setDate(today.getDate() - i);
          timeline.push({
            iso: date.toISOString().split("T")[0],
            label: date.toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            }),
            approvals: [],
          });
        }

        approvedPermits.forEach((permit) => {
          // Accept either submittedAt or createdAt as the submission timestamp
          if (
            !permit ||
            !permit.approvedAt ||
            !(permit.submittedAt || permit.createdAt)
          )
            return;
          const approvedDate = new Date(permit.approvedAt);
          if (Number.isNaN(approvedDate.getTime())) return;
          const approvedIso = approvedDate.toISOString().split("T")[0];
          const entry = timeline.find((day) => day.iso === approvedIso);
          if (!entry) return;
          const submittedDate = new Date(
            permit.submittedAt || permit.createdAt
          );
          if (Number.isNaN(submittedDate.getTime())) return;
          const hours = Math.round(
            (approvedDate - submittedDate) / (1000 * 60 * 60)
          );
          entry.approvals.push(hours);
        });

        const averageData = timeline.map((day) => {
          if (!day.approvals.length) return null;
          const sum = day.approvals.reduce((acc, hours) => acc + hours, 0);
          return Math.round(sum / day.approvals.length);
        });

        const fastestData = timeline.map((day) => {
          if (!day.approvals.length) return null;
          return Math.min(...day.approvals);
        });

        const hasAverageData = averageData.some((value) => value !== null);
        const hasFastestData = fastestData.some((value) => value !== null);

        return {
          timeline,
          averageData,
          fastestData,
          hasAverageData,
          hasFastestData,
        };
      };

      destroyChart("approvalTime");
      destroyChart("fastestApproval");

      // Show full time range for approval time chart: compute days from earliest approval to today
      let windowDays = DEFAULT_DAYS;
      if (Array.isArray(approvedPermits) && approvedPermits.length > 0) {
        const earliestApproved = approvedPermits.reduce((earliest, permit) => {
          if (!permit.approvedAt) return earliest;
          const approvedDate = new Date(permit.approvedAt);
          if (Number.isNaN(approvedDate.getTime())) return earliest;
          if (!earliest || approvedDate < earliest) return approvedDate;
          return earliest;
        }, null);
        if (earliestApproved) {
          const diffDays =
            Math.floor((today - earliestApproved) / MS_PER_DAY) + 1;
          // Use the full range (all-time) so the chart shows all approvals
          windowDays = Math.max(1, diffDays);
        }
      }

      const dataBundle = buildTimelineData(windowDays);
      if (!dataBundle) {
        console.warn("Unable to compute approval time data");
        return;
      }

      let {
        timeline,
        averageData,
        fastestData,
        hasAverageData,
        hasFastestData,
      } = dataBundle;

      // Aggregate timeline into weekly or monthly buckets for long ranges
      const AGGREGATE_WEEK_THRESHOLD = 120; // days
      const AGGREGATE_MONTH_THRESHOLD = 365; // days

      function aggregateWeekly(timeline) {
        const labels = [];
        const avg = [];
        const fast = [];
        for (let i = 0; i < timeline.length; i += 7) {
          const chunk = timeline.slice(i, i + 7);
          const mergedApprovals = chunk.flatMap((d) => d.approvals || []);
          const label =
            chunk[0].label +
            (chunk.length > 1 ? ` - ${chunk[chunk.length - 1].label}` : "");
          if (mergedApprovals.length) {
            const sum = mergedApprovals.reduce((a, b) => a + b, 0);
            avg.push(Math.round(sum / mergedApprovals.length));
            fast.push(Math.min(...mergedApprovals));
          } else {
            avg.push(null);
            fast.push(null);
          }
          labels.push(label);
        }
        return { labels, averageData: avg, fastestData: fast };
      }

      function aggregateMonthly(timeline) {
        const map = new Map();
        timeline.forEach((day) => {
          const iso = day.iso; // YYYY-MM-DD
          const key = iso.slice(0, 7); // YYYY-MM
          if (!map.has(key)) map.set(key, []);
          map.get(key).push(...(day.approvals || []));
        });
        const labels = [];
        const avg = [];
        const fast = [];
        Array.from(map.entries()).forEach(([key, arr]) => {
          const d = new Date(key + "-01");
          const label = d.toLocaleString(undefined, {
            month: "short",
            year: "numeric",
          });
          labels.push(label);
          if (arr.length) {
            const sum = arr.reduce((a, b) => a + b, 0);
            avg.push(Math.round(sum / arr.length));
            fast.push(Math.min(...arr));
          } else {
            avg.push(null);
            fast.push(null);
          }
        });
        return { labels, averageData: avg, fastestData: fast };
      }

      // decide whether to aggregate
      const totalDays = timeline.length;
      let aggregated = null;
      if (totalDays > AGGREGATE_MONTH_THRESHOLD) {
        aggregated = aggregateMonthly(timeline);
      } else if (totalDays > AGGREGATE_WEEK_THRESHOLD) {
        aggregated = aggregateWeekly(timeline);
      }

      if (aggregated) {
        // override variables used later
        averageData = aggregated.averageData;
        fastestData = aggregated.fastestData;
        // use aggregated labels for charts
        timeline = aggregated.labels.map((l) => ({ label: l }));
        hasAverageData = averageData.some((v) => v !== null);
        hasFastestData = fastestData.some((v) => v !== null);
      }

      updateTrendLabel("approvalTrendLabel", "Approval Time Trend", windowDays);
      updateTrendLabel(
        "fastestTrendLabel",
        "Fastest Approval Time Trend",
        windowDays
      );

      const commonOptions = (tooltipFormatter) => ({
        responsive: true,
        maintainAspectRatio: false,
        resizeDelay: 0,
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: "index",
            intersect: false,
            callbacks: {
              label: function (context) {
                if (context.parsed.y === null) return "No approvals";
                return tooltipFormatter(context.parsed.y);
              },
            },
          },
        },
        interaction: {
          mode: "nearest",
          axis: "x",
          intersect: false,
        },
        onResize: function (chart) {
          chart.canvas.style.height = "100%";
          chart.canvas.style.maxHeight = "100%";
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { maxRotation: 45 },
          },
          y: {
            beginAtZero: true,
            grid: { color: "rgba(0,0,0,0.1)" },
            ticks: {
              callback: function (value) {
                return `${value}h`;
              },
            },
          },
        },
      });

      if (averageCtx) {
        if (!hasAverageData) {
          showNoDataMessage(
            averageCtx,
            "No approvals recorded in this period."
          );
        } else {
          hideNoDataMessage(averageCtx);
          window.chartInstances.approvalTime = new Chart(averageCtx, {
            type: "line",
            data: {
              labels: timeline.map((day) => day.label),
              datasets: [
                {
                  label: "Avg Approval Time (hours)",
                  data: averageData,
                  borderColor: "#273172",
                  backgroundColor: "rgba(39, 49, 114, 0.12)",
                  borderWidth: 2,
                  fill: true,
                  tension: 0.4,
                  pointBackgroundColor: "#273172",
                  pointBorderColor: "#fff",
                  pointBorderWidth: 2,
                  pointRadius: 4,
                  pointHoverRadius: 6,
                },
              ],
            },
            options: commonOptions((value) => `Avg: ${value} hours`),
          });
        }
      }

      // fastestApproval chart removed — only rendering main approval time chart

      console.log("Approval time charts created successfully");
    };

    ensureChartsReady();
  }

  // Activity logging removed from profile.js (moved to admin/permitform)

  // Expand/Collapse Section Functionality
  function toggleSection(sectionId) {
    const content = document.getElementById(`${sectionId}Content`);
    if (!content) return;
    const isCollapsed = content.classList.contains("hidden");
    if (isCollapsed) {
      content.classList.remove("hidden");
      // run lazy init for this section if present and not yet called
      try {
        if (
          typeof lazyInitMap !== "undefined" &&
          lazyInitMap[sectionId] &&
          typeof lazyInitCalled !== "undefined" &&
          !lazyInitCalled.has(sectionId)
        ) {
          lazyInitMap[sectionId]();
          lazyInitCalled.add(sectionId);
        }
      } catch (err) {
        console.warn("Lazy init for", sectionId, "failed", err);
      }
    } else {
      content.classList.add("hidden");
    }
  }

  // Submit New Request Function
  function submitNewRequest(e) {
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    // Use shared layout modal instead of redirecting
    if (!openPermitModal()) {
      console.warn("Permit modal trigger not found in shared layout.");
    }
  }

  // Unified Chart Management System
  function destroyChart(chartId) {
    if (!window.chartInstances) {
      window.chartInstances = {};
      return;
    }
    if (window.chartInstances[chartId]) {
      window.chartInstances[chartId].destroy();
      delete window.chartInstances[chartId];
      console.log(`Destroyed chart: ${chartId}`);
    }
  }

  // Create Charts for Permit Statistics
  function createPermitCharts() {
    const statusCtx = document.getElementById("permitStatusChart");
    const trendCtx = document.getElementById("monthlyTrendChart");

    // Resolve theme colors for charts so we follow CSS variables
    const __css = getComputedStyle(document.documentElement);
    const __textPrimary = (
      __css.getPropertyValue("--text-primary") || "#273172"
    ).trim();
    const __inputBorder = (
      __css.getPropertyValue("--input-border") || "rgba(0,0,0,0.06)"
    ).trim();
    const __hiaBlue = (
      __css.getPropertyValue("--hia-blue") || __textPrimary
    ).trim();

    // Status Distribution (live)
    if (statusCtx) {
      destroyChart("statusChart");
      if (!window.Chart) return;

      // Count statuses from latestUserPermits (normalize)
      // Initialize with common statuses to ensure they always appear
      const statusCounts = {
        Pending: 0,
        "In Progress": 0,
        Approved: 0,
        Rejected: 0,
      };

      (latestUserPermits || []).forEach((p) => {
        const s = p && p.status ? String(p.status) : "Pending";
        statusCounts[s] = (statusCounts[s] || 0) + 1;
      });

      // Filter out statuses with 0 count (optional: remove this filter to always show all statuses)
      const labels = Object.keys(statusCounts).filter(
        (key) => statusCounts[key] > 0
      );
      const data = labels.map((l) => statusCounts[l]);

      // Color mapping with sensible defaults
      const colorMap = {
        Approved: "#10b981",
        Pending: "#f59e0b",
        Rejected: "#ef4444",
        "In Review": "#3b82f6",
        "In Progress": "#0ea5e9",
      };
      const palette = [
        "#06b6d4",
        "#8b5cf6",
        "#f43f5e",
        "#22c55e",
        "#eab308",
        "#3b82f6",
        "#f97316",
      ];
      const bgColors = labels.map(
        (l, i) => colorMap[l] || palette[i % palette.length]
      );

      // Register centerText plugin locally and include it in the chart
      const plugins = [centerTextPlugin];
      const totalCount = data.reduce((a, b) => a + b, 0);

      // Resolve theme colors from CSS variables so charts follow the active theme
      const _css = getComputedStyle(document.documentElement);
      const _textPrimary = (
        _css.getPropertyValue("--text-primary") || "#273172"
      ).trim();
      const _inputBorder = (
        _css.getPropertyValue("--input-border") || "rgba(0,0,0,0.06)"
      ).trim();
      const _centerColor = (
        _css.getPropertyValue("--hia-blue") || _textPrimary
      ).trim();

      window.chartInstances.statusChart = new Chart(statusCtx, {
        type: "doughnut",
        data: {
          labels,
          datasets: [
            {
              data,
              backgroundColor: bgColors,
              borderWidth: 0,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "60%",
          // Use a single plugins object so our centerText and legend/tooltip options coexist
          plugins: {
            centerText: {
              value: totalCount,
              color: _centerColor,
              font: "600 20px system-ui, -apple-system, 'Segoe UI'",
            },
            legend: {
              position: "bottom",
              labels: {
                padding: 12,
                usePointStyle: true,
                font: { size: 12 },
                color: _textPrimary,
              },
            },
            tooltip: {
              enabled: true,
              titleColor: _textPrimary,
              bodyColor: _textPrimary,
              callbacks: {
                label: function (context) {
                  const label = context.label || "";
                  const value = context.parsed || 0;
                  const total = context.chart._metasets
                    ? context.chart._metasets[0].total
                    : context.dataset.data.reduce((a, b) => a + b, 0);
                  const pct = total ? Math.round((value / total) * 100) : 0;
                  return `${label}: ${value} (${pct}%)`;
                },
              },
            },
          },
          animation: { duration: 420 },
          layout: { padding: 6 },
        },
        plugins,
      });

      // ensure the parent wrapper limits overflow (helps on small screens)
      try {
        const wrapper =
          statusCtx &&
          statusCtx.parentElement &&
          statusCtx.parentElement.closest(".permit-status-wrapper");
        if (wrapper) wrapper.style.maxWidth = "320px";
      } catch (e) {}

      // Animate center counter from previous value
      try {
        const prev = window.chartInstances.statusTotalPrev || 0;
        const curr = data.reduce((a, b) => a + b, 0);
        window.chartInstances.statusTotalPrev = curr;
        animateDoughnutCenter(
          window.chartInstances.statusChart,
          prev,
          curr,
          700
        );
      } catch (e) {
        console.warn("center animation failed", e);
      }
    }

    // Monthly Trends (live: submitted vs approved vs rejected counts per recent months)
    if (trendCtx) {
      destroyChart("trendChart");
      if (!window.Chart) return;

      const monthsBack = 6; // show last 6 months including current
      const now = new Date();
      const monthKeys = [];
      const labels = [];
      for (let i = monthsBack - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
          2,
          "0"
        )}`;
        monthKeys.push(key);
        labels.push(d.toLocaleString(undefined, { month: "short" }));
      }

      const submittedCounts = monthKeys.map(() => 0);
      const approvedCounts = monthKeys.map(() => 0);
      const rejectedCounts = monthKeys.map(() => 0);

      (latestUserPermits || []).forEach((p) => {
        if (!p) return;
        // Submitted by createdAt
        if (p.createdAt) {
          const dc = new Date(p.createdAt);
          if (!isNaN(dc)) {
            const key = `${dc.getFullYear()}-${String(
              dc.getMonth() + 1
            ).padStart(2, "0")}`;
            const idx = monthKeys.indexOf(key);
            if (idx !== -1) submittedCounts[idx] += 1;
          }
        }
        // Approved by approvedAt
        if (p.status === "Approved" && p.approvedAt) {
          const da = new Date(p.approvedAt);
          if (!isNaN(da)) {
            const keyA = `${da.getFullYear()}-${String(
              da.getMonth() + 1
            ).padStart(2, "0")}`;
            const idxA = monthKeys.indexOf(keyA);
            if (idxA !== -1) approvedCounts[idxA] += 1;
          }
        }
        // Rejected by rejectedAt or updatedAt if status is Rejected
        if (p.status === "Rejected") {
          const dr = new Date(p.rejectedAt || p.updatedAt);
          if (!isNaN(dr)) {
            const keyR = `${dr.getFullYear()}-${String(
              dr.getMonth() + 1
            ).padStart(2, "0")}`;
            const idxR = monthKeys.indexOf(keyR);
            if (idxR !== -1) rejectedCounts[idxR] += 1;
          }
        }
      });

      window.chartInstances.trendChart = new Chart(trendCtx, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: "Permits Submitted",
              data: submittedCounts,
              borderColor: "#3b82f6",
              backgroundColor: "rgba(59,130,246,0.12)",
              fill: true,
              tension: 0.36,
              pointRadius: 2,
              pointHoverRadius: 5,
            },
            {
              label: "Permits Approved",
              data: approvedCounts,
              borderColor: "#10b981",
              backgroundColor: "rgba(16,185,129,0.12)",
              fill: true,
              tension: 0.36,
              pointRadius: 2,
              pointHoverRadius: 5,
            },
            {
              label: "Permits Rejected",
              data: rejectedCounts,
              borderColor: "#ef4444",
              backgroundColor: "rgba(239,68,68,0.12)",
              fill: true,
              tension: 0.36,
              pointRadius: 2,
              pointHoverRadius: 5,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          aspectRatio: 2,
          scales: {
            y: {
              beginAtZero: true,
              grid: { color: "rgba(0,0,0,0.06)" },
              ticks: { precision: 0 },
            },
            x: { grid: { display: false }, ticks: { maxRotation: 0 } },
          },
          plugins: {
            legend: {
              position: "top",
              labels: { padding: 10, usePointStyle: true, font: { size: 11 } },
            },
            tooltip: { mode: "index", intersect: false },
          },
          animation: { duration: 420 },
          layout: { padding: 4 },
        },
      });
    }
  }

  // ========== GLOBAL FUNCTION EXPORTS ==========
  window.showProfileSettings = showProfileSettings;
  window.hideProfileSettings = hideProfileSettings;
  window.showUpdatePasswordModal = showUpdatePasswordModal;
  window.hideUpdatePasswordModal = hideUpdatePasswordModal;
  window.toggleSection = toggleSection;
  window.submitNewRequest = submitNewRequest;
  window.downloadActivity = downloadActivity;
  // expose some helpers used by inline onclicks
  window.logoutUser =
    typeof logoutUser === "function" ? logoutUser : window.logoutUser;
  window.showProfileSettings =
    typeof showProfileSettings === "function"
      ? showProfileSettings
      : window.showProfileSettings;
  // Ensure logoutUser is available globally for inline onclick handlers
  try {
    if (typeof logoutUser === "function") {
      window.logoutUser = logoutUser;
    }
  } catch (e) {
    console.warn("logoutUser not available to expose on window yet", e);
  }
});
