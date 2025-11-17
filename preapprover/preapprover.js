import { checkSession, initIdleTimer } from "../shared/session.js";
import { formatDate24 } from "../date-utils.js";
import { API_BASE } from "../config.js";

let allPermits = [];
let currentUser = null;
let currentPermitId = null;
let pollId = null;
let statusChart = null;
let monthlyChart = null;
let approvedPermits = [];

function noop() {}

function debounce(fn, ms = 200) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function el(id) {
  return document.getElementById(id);
}

function setText(id, val) {
  const elmt = document.getElementById(id);
  if (!elmt) return;
  elmt.textContent =
    typeof val === "string" || typeof val === "number"
      ? val
      : String(val || "");
}

async function fetchPermits() {
  try {
    const res = await fetch(
      `${API_BASE}/preapprover/permits?filter=submitted`,
      {
        credentials: "include",
      }
    );
    if (!res.ok) {
      if (res.status === 401) {
        if (window.showToast)
          window.showToast("error", "Unauthorized - please sign in");
        allPermits = [];
        return;
      }
      throw new Error("failed to fetch permits");
    }
    const body = await res.json();
    allPermits = Array.isArray(body) ? body : body.permits || [];
  } catch (err) {
    console.error("preapprover: failed to fetch permits", err);
    allPermits = [];
  }
}

function ensureToasts(timeout = 3000) {
  return new Promise((resolve) => {
    if (typeof window !== "undefined" && typeof window.showToast === "function")
      return resolve(true);
    const existing = Array.from(document.getElementsByTagName("script")).find(
      (s) => s.src && s.src.indexOf("/shared/toast.js") !== -1
    );
    if (existing) {
      let waited = 0;
      const iv = setInterval(() => {
        if (typeof window.showToast === "function") {
          clearInterval(iv);
          return resolve(true);
        }
        waited += 100;
        if (waited >= timeout) {
          clearInterval(iv);
          return resolve(false);
        }
      }, 100);
      return;
    }
    const s = document.createElement("script");
    s.src = "/shared/toast.js";
    s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
    setTimeout(
      () =>
        resolve(!!(window.showToast && typeof window.showToast === "function")),
      timeout
    );
  });
}

async function fetchApprovedPermits() {
  try {
    const res = await fetch(`${API_BASE}/preapprover/my-actions`, {
      credentials: "include",
    });
    if (!res.ok) throw new Error("fetch approved failed");
    const body = await res.json();
    if (Array.isArray(body.preApproved) && body.preApproved.length) {
      approvedPermits = body.preApproved;
    } else if (Array.isArray(body.approved) && body.approved.length) {
      approvedPermits = body.approved;
    } else {
      approvedPermits = [];
    }
  } catch (err) {
    console.error("preapprover: failed to fetch approved permits", err);
    approvedPermits = [];
  }
}

function renderStats() {
  const total = allPermits.length;
  const pending = allPermits.filter(
    (p) => ((p.status || "") + "").toLowerCase() === "pending"
  ).length;
  const approved = allPermits.filter(
    (p) => ((p.status || "") + "").toLowerCase() === "approved"
  ).length;
  const rejected = allPermits.filter(
    (p) => ((p.status || "") + "").toLowerCase() === "rejected"
  ).length;

  setText("totalPermitsCount", total);
  setText("pendingReviewCount", pending);
  setText("preApprovedCount", approved);
  setText("rejectedByMeCount", rejected);
}

async function fetchStats() {
  try {
    const res = await fetch(`${API_BASE}/preapprover/stats`, {
      credentials: "include",
    });
    if (!res.ok) return;
    const body = await res.json();
    const total = Number(body.totalPermits || 0);
    const pending = Number(body.pendingReview || 0);
    const approved = Number(body.preApproved || 0);
    const rejected = Number(body.rejectedByMe || 0);
    setText("pendingReviewCount", pending);
    setText("preApprovedCount", approved);
    setText("rejectedByMeCount", rejected);
    setText("totalPermitsCount", total);
  } catch (err) {}
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function createPermitCard(p, idx) {
  const a = document.createElement("article");
  a.className =
    "rounded-xl bg-[var(--bg-surface)] p-4 border border-[var(--input-border)]";

  const hdr = document.createElement("div");
  hdr.className =
    "flex items-center justify-between mb-2 text-sm text-secondary";
  hdr.innerHTML = `<div>#${idx}</div><div class="permit-submitted text-xs text-secondary">${
    p.createdAt ? formatDate24(p.createdAt) : "—"
  }</div>`;
  const title = document.createElement("h3");
  title.className = "text-sm font-semibold mb-1";
  title.textContent = p.permitTitle || "Untitled permit";

  const requester = document.createElement("div");
  requester.className = "requester-name text-sm font-medium text-primary mb-2";
  requester.textContent = p.requester?.fullName || p.requester?.username || "-";

  const meta = document.createElement("div");
  meta.className =
    "flex items-center justify-between gap-2 text-xs text-secondary";

  const status = document.createElement("div");
  status.className = `status-badge ${(p.status || "")
    .toLowerCase()
    .replace(/\s+/g, "-")}`;
  status.textContent = p.status || "Pending";

  meta.appendChild(status);

  const actions = document.createElement("div");
  actions.className = "mt-3 flex gap-2";
  const view = document.createElement("button");
  view.className = "px-3 py-1 rounded bg-[var(--input-bg)] view-btn";
  view.textContent = "View";
  view.addEventListener("click", () => viewPermitDetails(p._id));
  actions.appendChild(view);

  a.appendChild(hdr);
  a.appendChild(title);
  a.appendChild(requester);
  a.appendChild(meta);
  a.appendChild(actions);
  return a;
}

function createPermitRow(p, idx) {
  const tr = document.createElement("tr");
  const submitted = p.createdAt ? formatDate24(p.createdAt) : "—";
  tr.innerHTML = `
 		<td class="px-6 py-3 text-sm">${idx}</td>
 		<td class="px-6 py-3 text-sm permit-submitted">${escapeHtml(submitted)}</td>
 		<td class="px-6 py-3 text-sm w-[320px] truncate">${escapeHtml(
      p.permitTitle || "-"
    )}</td>
 		<td class="px-6 py-3 text-sm"><span class="status-badge ${(p.status || "")
      .toLowerCase()
      .replace(/\s+/g, "-")}">${escapeHtml(p.status || "Pending")}</span></td>
 		<td class="px-6 py-3 text-sm requester-name">${escapeHtml(
      p.requester?.username || "-"
    )}</td>
 		<td class="px-6 py-3 text-sm"><button class="px-3 py-1 rounded bg-[var(--input-bg)] view-btn" data-action="view" data-id="${
      p._id
    }">View</button></td>
 	`;
  const btn = tr.querySelector('button[data-action="view"]');
  if (btn) btn.addEventListener("click", () => viewPermitDetails(p._id));
  return tr;
}

function renderPermits() {
  const grid = el("permitsGrid");
  const tbody = el("permitsTableBody");
  if (grid) grid.innerHTML = "";
  if (tbody) tbody.innerHTML = "";

  const search = (el("permitsSearchInput")?.value || "").toLowerCase();
  const statusFilter = (el("permitsStatusFilter")?.value || "").toLowerCase();

  let list = Array.isArray(allPermits) ? [...allPermits] : [];
  list = list.filter((p) => {
    const okSearch =
      !search ||
      (p.permitTitle || "").toLowerCase().includes(search) ||
      (p._id || "").toLowerCase().includes(search) ||
      (p.requester?.username || "").toLowerCase().includes(search);
    const okStatus =
      !statusFilter || ((p.status || "") + "").toLowerCase() === statusFilter;
    return okSearch && okStatus;
  });

  list = list.filter((p) => {
    const s = ((p.status || "") + "").toLowerCase();
    return s === "submitted" || s === "pending";
  });

  setText("permitsShowingCount", list.length);
  setText("permitsTotalCount", allPermits.length);

  list.forEach((p, i) => {
    if (grid) grid.appendChild(createPermitCard(p, i + 1));
    if (tbody) tbody.appendChild(createPermitRow(p, i + 1));
  });
}

function renderApprovedPermits() {
  const grid = el("approvedPermitsGrid");
  const tbody = el("approvedPermitsTableBody");
  if (grid) grid.innerHTML = "";
  if (tbody) tbody.innerHTML = "";

  setText(
    "approvedShowingCount",
    Array.isArray(approvedPermits) ? approvedPermits.length : 0
  );

  (approvedPermits || []).forEach((p, i) => {
    if (grid) grid.appendChild(createPermitCard(p, i + 1));
    if (tbody) tbody.appendChild(createPermitRow(p, i + 1));
  });
}

function openModal() {
  const m = el("permitDetailsModal");
  if (!m) return;
  m.classList.remove("hidden");
  m.classList.add("flex");
  m.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  setTimeout(() => m.classList.add("modal-show"), 20);
  setTimeout(() => enableModalFocusTrap(m), 100);
}

function closeModal() {
  const m = el("permitDetailsModal");
  if (!m) return;
  m.classList.remove("modal-show");
  disableModalFocusTrap(m);
  document.body.classList.remove("modal-open");
  setTimeout(() => {
    m.classList.add("hidden");
    m.classList.remove("flex");
    m.setAttribute("aria-hidden", "true");
  }, 280);
}

let _lastFocusedBeforeModal = null;
let _modalKeyHandler = null;
function enableModalFocusTrap(modalEl) {
  if (!modalEl) return;
  _lastFocusedBeforeModal = document.activeElement;

  const focusableSelector =
    'a[href], area[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const focusable = Array.from(
    modalEl.querySelectorAll(focusableSelector)
  ).filter((el) => el.offsetParent !== null);
  const first = focusable[0] || modalEl;
  const last = focusable[focusable.length - 1] || modalEl;

  if (first && typeof first.focus === "function") first.focus();

  _modalKeyHandler = function (e) {
    if (e.key === "Tab") {
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    }
  };

  modalEl.addEventListener("keydown", _modalKeyHandler);
}

function disableModalFocusTrap(modalEl) {
  if (!modalEl) return;
  if (_modalKeyHandler)
    modalEl.removeEventListener("keydown", _modalKeyHandler);
  _modalKeyHandler = null;
  if (
    _lastFocusedBeforeModal &&
    typeof _lastFocusedBeforeModal.focus === "function"
  ) {
    _lastFocusedBeforeModal.focus();
  }
  _lastFocusedBeforeModal = null;
}

async function viewPermitDetails(id) {
  if (!id) return;
  currentPermitId = id;
  const content = el("permitDetailsContent");
  if (!content) return;

  try {
    const res = await fetch(`${API_BASE}/api/permits/${id}`, {
      credentials: "include",
    });
    if (!res.ok) throw new Error("failed to fetch permit");
    const p = await res.json();

    const filesHtml = (p.files || [])
      .map(
        (f) =>
          `<li class="flex items-center justify-between py-1"><span class="truncate">${escapeHtml(
            f.originalName
          )}</span><a class="text-sm text-hia-blue" target="_blank" rel="noopener noreferrer" href="${escapeHtml(
            f.url
          )}">Download</a></li>`
      )
      .join("");

    const submittedLocal = p.createdAt
      ? new Date(p.createdAt).toLocaleString()
      : "-";
    const startDisplay = p.startDateTime
      ? new Date(p.startDateTime).toLocaleString()
      : "-";
    const endDisplay = p.endDateTime
      ? new Date(p.endDateTime).toLocaleString()
      : "-";
    const startInputValue = p.startDateTime
      ? new Date(p.startDateTime).toISOString().slice(0, 16)
      : "";
    const endInputValue = p.endDateTime
      ? new Date(p.endDateTime).toISOString().slice(0, 16)
      : "";

    function renderRequester(r) {
      if (!r)
        return '<div class="text-sm text-secondary">No requester data</div>';
      return `
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <div class="text-xs text-secondary">Full name</div>
                <div class="mt-1 text-sm">${escapeHtml(
                  r.fullName || r.username || "-"
                )}</div>
                <div class="text-xs text-secondary mt-2">Username</div>
                <div class="mt-1 text-sm">${escapeHtml(r.username || "-")}</div>
                <div class="text-xs text-secondary mt-2">Email</div>
                <div class="mt-1 text-sm">${escapeHtml(r.email || "-")}</div>
                <div class="text-xs text-secondary mt-2">Phone</div>
                <div class="mt-1 text-sm">${escapeHtml(r.phone || "-")}</div>
              </div>
              <div>
                <div class="text-xs text-secondary">Company</div>
                <div class="mt-1 text-sm">${escapeHtml(r.company || "-")}</div>
                <div class="text-xs text-secondary mt-2">Role</div>
                <div class="mt-1 text-sm">${escapeHtml(r.role || "-")}</div>
              </div>
            </div>`;
    }

    const workFields = [
      ["Permit Title", p.permitTitle],
      ["Permit Number", p.permitNumber],
      ["Status", p.status],
      ["Terminal", p.terminal],
      ["Facility", p.facility],
      ["Work Description", p.workDescription || p.description],
      ["Impact", p.impact],
      ["Equipment Type", p.equipmentTypeInput],
      ["Impact Details", p.impactDetailsInput],
      ["E-Permit", p.ePermit],
      ["FMM Workorder", p.fmmWorkorder],
      ["HSE Risk", p.hseRisk],
      ["Ops Risk", p.opRisk],
    ];

    const workHtml = workFields
      .map(
        ([label, val]) =>
          `<div class="mb-2"><div class="text-xs text-secondary">${escapeHtml(
            label
          )}</div><div class="mt-1 text-sm">${escapeHtml(
            val || "-"
          )}</div></div>`
      )
      .join("");

    const isReadOnlyModal = ["In Progress", "Approved"].includes(p.status);
    const preApproverName = p.preApprovedBy
      ? p.preApprovedBy.fullName || p.preApprovedBy.username || "-"
      : p.preApproverName || "-";
    const preApprovedAtDisplay = p.preApprovedAt
      ? new Date(p.preApprovedAt).toLocaleString()
      : "-";
    const preApproverComments = p.preApproverComments || "-";

    const approverName = p.approvedBy
      ? p.approvedBy.fullName || p.approvedBy.username || "-"
      : p.approverName || "-";
    const approvedAtDisplay = p.approvedAt
      ? new Date(p.approvedAt).toLocaleString()
      : "-";
    const approverComments = p.approverComments || "-";

    const bothApproved = p.preApprovedAt && p.approvedAt;
    const connectorColor = bothApproved
      ? "var(--hia-green)"
      : "var(--input-border)";

    const commentsSection = isReadOnlyModal
      ? `
            <div class="bg-[var(--bg-surface)] border border-[var(--input-border)] rounded-xl p-5">
              <h4 class="text-sm font-semibold text-primary mb-4">Approver Hierarchy</h4>
              <div class="approver-row">
                <div class="approver-card" role="group" aria-labelledby="preapprover-label">
                  <div id="preapprover-label" class="title">Pre-Approver</div>
                  <div class="name">${escapeHtml(preApproverName)}</div>
                  <div class="text-xs text-secondary mt-2">Pre-Approved</div>
                  <div class="mt-1 text-sm">${escapeHtml(
                    preApprovedAtDisplay
                  )}</div>
                  <div class="text-xs text-secondary mt-3">Comments</div>
                  <div class="mt-1 text-sm">${escapeHtml(
                    preApproverComments
                  )}</div>
                </div>
                <div class="connector-horizontal" aria-hidden="true" style="--connector-color: ${connectorColor}">
                  <div class="connector-line" aria-hidden="true">
                    <span class="connector-char" aria-hidden="true">🠖</span>
                  </div>
                </div>
                <div class="approver-card" role="group" aria-labelledby="approver-label">
                  <div id="approver-label" class="title">Approver</div>
                  <div class="name">${escapeHtml(approverName)}</div>
                  <div class="text-xs text-secondary mt-2">Approved</div>
                  <div class="mt-1 text-sm">${escapeHtml(
                    approvedAtDisplay
                  )}</div>
                  <div class="text-xs text-secondary mt-3">Comments</div>
                  <div class="mt-1 text-sm">${escapeHtml(
                    approverComments
                  )}</div>
                </div>
              </div>
            </div>
          `
      : `
            <div class="bg-[var(--bg-surface)] border border-[var(--input-border)] rounded-xl p-5">
              <h4 class="text-sm font-semibold text-primary mb-2">Comments</h4>
              <div>
                <label for="modalActionComments" class="block text-xs font-medium text-secondary mb-1">Action Comments</label>
                <textarea id="modalActionComments" rows="4" placeholder="Enter comments for Pre-Approve or Reject (required)" class="w-full p-3 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-md text-sm"></textarea>
                <div class="text-xs text-secondary mt-2">Provide at least 3 characters explaining your decision.</div>
              </div>
            </div>
          `;

    content.innerHTML = `
          <form id="permitModalForm" class="space-y-5">
            <!-- Header Card with Permit ID and Status -->
            <div class="bg-[var(--bg-surface)] border border-[var(--input-border)] rounded-xl p-5">
              <div class="flex items-start justify-between mb-4">
                <div>
                  <div class="text-xs text-secondary mb-1">Permit ID</div>
                  <div class="text-lg font-semibold permit-id-value">${escapeHtml(
                    p._id || "-"
                  )}</div>
                </div>
                <div class="text-right">
                  <div class="text-xs text-secondary mb-1">Status</div>
                  <span class="status-badge ${(p.status || "")
                    .toLowerCase()
                    .replace(/\s+/g, "-")}">${escapeHtml(
      p.status || "Pending"
    )}</span>
                </div>
              </div>

              <div class="modal-divider" aria-hidden="true"></div>

              <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                <div>
                  <label class="block text-xs font-medium text-secondary mb-1">Permit Title</label>
                  <div class="p-3 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-md text-sm">${escapeHtml(
                    p.permitTitle || "-"
                  )}</div>
                </div>
                <div>
                  <label class="block text-xs font-medium text-secondary mb-1">Permit Number</label>
                  <div class="p-3 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-md text-sm">${escapeHtml(
                    p.permitNumber || "-"
                  )}</div>
                </div>
              </div>
            </div>

            <!-- Requester Details Card -->
            <div class="bg-[var(--bg-surface)] border border-[var(--input-border)] rounded-xl p-5">
              <h4 class="text-sm font-semibold mb-4 text-primary">Requester Details</h4>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label class="block text-xs font-medium text-secondary mb-1">Full name</label>
                  <div class="p-3 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-md text-sm">${escapeHtml(
                    p.requester?.fullName || p.requester?.username || "-"
                  )}</div>
                </div>
                <div>
                  <label class="block text-xs font-medium text-secondary mb-1">Company</label>
                  <div class="p-3 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-md text-sm">${escapeHtml(
                    p.requester?.company || "-"
                  )}</div>
                </div>
                <div>
                  <label class="block text-xs font-medium text-secondary mb-1">Role</label>
                  <div class="p-3 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-md text-sm">${escapeHtml(
                    p.requester?.role || "-"
                  )}</div>
                </div>
                <div>
                  <label class="block text-xs font-medium text-secondary mb-1">Email</label>
                  <div class="p-3 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-md text-sm">${escapeHtml(
                    p.requester?.email || "-"
                  )}</div>
                </div>
                <div>
                  <label class="block text-xs font-medium text-secondary mb-1">Phone</label>
                  <div class="p-3 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-md text-sm">${
                    p.requester?.phone
                      ? `<a href="tel:${escapeHtml(
                          p.requester.phone
                        )}" class="text-hia-blue font-medium">${escapeHtml(
                          p.requester.phone
                        )}</a>`
                      : "-"
                  }</div>
                </div>
              </div>
            </div>

            <!-- Work Details Card -->
            <div class="bg-[var(--bg-surface)] border border-[var(--input-border)] rounded-xl p-5">
              <h4 class="text-sm font-semibold mb-4 text-primary">Work Details</h4>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                ${workFields
                  .map(
                    ([label, val]) => `
                  <div>
                    <label class="block text-xs font-medium text-secondary mb-1">${escapeHtml(
                      label
                    )}</label>
                    <div class="p-3 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-md text-sm">${escapeHtml(
                      val || "-"
                    )}</div>
                  </div>
                `
                  )
                  .join("")}
              </div>
            </div>

            <!-- Required Documents Card -->
            <div class="bg-[var(--bg-surface)] border border-[var(--input-border)] rounded-xl p-5">
              <div class="flex items-center justify-between mb-4">
                <h4 class="text-sm font-semibold text-primary">Required Documents</h4>
                <span class="text-xs text-secondary">${
                  (p.files || []).length
                } file(s)</span>
              </div>
              <div class="space-y-2">
                ${
                  (p.files || [])
                    .map(
                      (f) =>
                        `<div class="flex items-center justify-between p-3 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-md">
                        <span class="text-sm truncate flex-1">${escapeHtml(
                          f.originalName
                        )}</span>
                        <a class="ml-3 text-sm text-hia-blue font-medium" href="${escapeHtml(
                          f.url
                        )}" aria-label="Download ${escapeHtml(
                          f.originalName
                        )}" target="_blank" rel="noopener noreferrer">Download</a>
                      </div>`
                    )
                    .join("") ||
                  '<div class="p-3 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-md text-sm text-secondary">No files attached</div>'
                }
              </div>
            </div>

            <!-- Date & Time -->
            <div class="bg-[var(--bg-surface)] border border-[var(--input-border)] rounded-xl p-5">
              <div class="flex items-center justify-between mb-4">
                <h4 class="text-sm font-semibold text-primary">Date & Time</h4>
              </div>
              <!-- If permit is pre-approved/approved, show read-only display. Otherwise show editable inputs -->
              ${
                ["In Progress", "Approved"].includes(p.status)
                  ? `
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <div class="text-xs text-secondary">Submitted</div>
                    <div class="mt-1 p-3 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-md text-sm">${escapeHtml(
                      submittedLocal
                    )}</div>
                  </div>
                  <div>
                    <div class="text-xs text-secondary">Start</div>
                    <div class="mt-1 p-3 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-md text-sm">${escapeHtml(
                      startDisplay
                    )}</div>
                  </div>
                  <div>
                    <div class="text-xs text-secondary">End</div>
                    <div class="mt-1 p-3 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-md text-sm">${escapeHtml(
                      endDisplay
                    )}</div>
                  </div>
                </div>
              `
                  : `
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label class="block text-xs font-medium text-secondary mb-1">Submitted</label>
                    <div class="p-3 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-md text-sm">${escapeHtml(
                      submittedLocal
                    )}</div>
                  </div>
                  <div>
                    <label for="editStartDateTime" class="block text-xs font-medium text-secondary mb-1">Start</label>
                    <input id="editStartDateTime" type="text" class="w-full p-3 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-md text-sm flatpickr-input" placeholder="Select start date & time" value="${escapeHtml(
                      startInputValue
                    )}" />
                  </div>
                  <div>
                    <label for="editEndDateTime" class="block text-xs font-medium text-secondary mb-1">End</label>
                    <input id="editEndDateTime" type="text" class="w-full p-3 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-md text-sm flatpickr-input" placeholder="Select end date & time" value="${escapeHtml(
                      endInputValue
                    )}" />
                  </div>
                </div>
                <div class="mt-4 text-right">
                  <button type="button" id="saveTimesBtn" class="btn-submit px-3 py-2 rounded-md text-sm">Save Times</button>
                </div>
              `
              }
            </div>
            ${commentsSection}
          </form>
        `;
    const startInput = document.getElementById("editStartDateTime");
    const endInput = document.getElementById("editEndDateTime");
    let startPicker = null;
    let endPicker = null;
    try {
      if (startInput && endInput && window.flatpickr) {
        const now = new Date();
        const defaultStart = p.startDateTime ? new Date(p.startDateTime) : null;
        const defaultEnd = p.endDateTime ? new Date(p.endDateTime) : null;

        startPicker = window.flatpickr(startInput, {
          enableTime: true,
          dateFormat: "Y-m-d H:i",
          minDate: now,
          defaultDate: defaultStart,
          onChange: (selectedDates) => {
            const s = selectedDates && selectedDates[0];
            const minForEnd = s && s > now ? s : now;
            if (endPicker) endPicker.set("minDate", minForEnd);
            const currEnd = endPicker?.selectedDates?.[0];
            if (currEnd && s && currEnd < s) {
              endPicker.setDate(s, true);
            }
          },
          onOpen: () => {
            startPicker.set("minDate", new Date());
          },
        });

        endPicker = window.flatpickr(endInput, {
          enableTime: true,
          dateFormat: "Y-m-d H:i",
          minDate: defaultStart && defaultStart > now ? defaultStart : now,
          defaultDate: defaultEnd,
          onOpen: () => {
            const s = startPicker?.selectedDates?.[0];
            const minForEnd = s && s > new Date() ? s : new Date();
            endPicker.set("minDate", minForEnd);
          },
        });
      }
    } catch (_) {}

    const saveBtn = document.getElementById("saveTimesBtn");
    if (saveBtn) {
      saveBtn.addEventListener("click", async () => {
        try {
          const sDate =
            startPicker?.selectedDates?.[0] ||
            (startInput?.value ? new Date(startInput.value) : null);
          const eDate =
            endPicker?.selectedDates?.[0] ||
            (endInput?.value ? new Date(endInput.value) : null);
          if (
            !sDate ||
            !eDate ||
            isNaN(sDate.getTime()) ||
            isNaN(eDate.getTime())
          ) {
            return (
              window.showToast &&
              window.showToast(
                "error",
                "Please select valid start and end times"
              )
            );
          }
          const nowCheck = new Date();
          if (sDate < nowCheck || eDate < nowCheck) {
            return (
              window.showToast &&
              window.showToast("error", "Past date/time is not allowed")
            );
          }
          if (eDate < sDate) {
            return (
              window.showToast &&
              window.showToast("error", "End time must be after start time")
            );
          }
          const resp = await fetch(
            `${API_BASE}/preapprover/permit/${p._id}/times`,
            {
              method: "PATCH",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                startDateTime: sDate.toISOString(),
                endDateTime: eDate.toISOString(),
              }),
            }
          );
          if (!resp.ok) {
            const j = await resp.json().catch(() => ({}));
            throw new Error(j.error || "Failed to update times");
          }
          window.showToast && window.showToast("success", "Times updated");
          await refreshAndRender();
        } catch (e) {
          console.error("save times error", e);
          window.showToast &&
            window.showToast("error", e.message || "Failed to update times");
        }
      });
    }

    const isReadOnly = ["In Progress", "Approved"].includes(p.status);
    const approveBtn = document.getElementById("approveFromModal");
    const rejectBtn = document.getElementById("rejectFromModal");
    if (approveBtn) approveBtn.classList.toggle("hidden", isReadOnly);
    if (rejectBtn) rejectBtn.classList.toggle("hidden", isReadOnly);

    openModal();
  } catch (err) {
    console.error("view permit error", err);
    if (window.showToast)
      window.showToast("error", "Unable to load permit details");
  }
}

async function handlePermitAction(id, action) {
  if (!id) return false;
  try {
    const url =
      action === "preapprove"
        ? `${API_BASE}/preapprover/approve/${id}`
        : `${API_BASE}/preapprover/reject/${id}`;
    const commentsEl = document.getElementById("modalActionComments");
    const comments = commentsEl ? commentsEl.value : "";
    if (!comments || String(comments).trim().length < 3) {
      if (window.showToast)
        window.showToast("error", "Comments are required (min 3 characters)");
      return false;
    }
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comments }),
    });
    if (!res.ok) throw new Error("action failed");
    if (window.showToast) {
      const msg =
        action === "preapprove"
          ? "Permit pre-approved successfully"
          : "Permit rejected successfully";
      window.showToast("success", msg);
    }
    await refreshAndRender();
    return true;
  } catch (err) {
    console.error("action error", err);
    if (window.showToast)
      window.showToast("error", "Failed to submit action. Please try again");
    return false;
  }
}

async function refreshAndRender() {
  await fetchPermits();
  await fetchApprovedPermits();
  await fetchStats();
  await fetchAnalytics();
  renderPermits();
  renderApprovedPermits();
}

async function fetchAnalytics() {
  try {
    const res = await fetch(`${API_BASE}/preapprover/analytics`, {
      credentials: "include",
    });
    if (!res.ok) return;
    const body = await res.json();

    const counts = body.countsByStatus || {};
    const approved = Number(counts.Approved || 0);
    const inProgress = Number(counts["In Progress"] || 0);
    const pending = Number(counts.Pending || 0);
    const rejected = Number(counts.Rejected || 0);

    const statusCtx = document.getElementById("statusChart");
    if (statusCtx) {
      const ctx = statusCtx.getContext("2d");
      const data = [approved, inProgress, pending, rejected];
      const labels = ["Approved", "In Progress", "Pending", "Rejected"];
      const colors = ["#34d399", "#60a5fa", "#fbbf24", "#f87171"];
      if (statusChart) {
        statusChart.data.datasets[0].data = data;
        statusChart.update();
      } else {
        statusChart = new Chart(ctx, {
          type: "doughnut",
          data: {
            labels,
            datasets: [
              {
                data,
                backgroundColor: colors,
                borderWidth: 0,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: "60%",
            plugins: {
              legend: { position: "bottom" },
              tooltip: { mode: "index", intersect: false },
            },
          },
        });
      }
    }

    // Monthly line chart
    const months = body.monthlyCounts || [];
    const labels = months.map((m) => `${m.month}/${m.year}`);
    const dataSet = months.map((m) => m.count || 0);
    const monthlyCtxEl = document.getElementById("monthlyChart");
    if (monthlyCtxEl) {
      const ctx = monthlyCtxEl.getContext("2d");
      if (monthlyChart) {
        monthlyChart.data.labels = labels;
        monthlyChart.data.datasets[0].data = dataSet;
        monthlyChart.update();
      } else {
        monthlyChart = new Chart(ctx, {
          type: "line",
          data: {
            labels,
            datasets: [
              {
                label: "Permits",
                data: dataSet,
                borderColor: "#60a5fa",
                backgroundColor: "rgba(96,165,250,0.12)",
                fill: true,
                tension: 0.35,
                pointRadius: 4,
                pointBackgroundColor: "#fff",
                pointBorderColor: "#60a5fa",
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              x: { grid: { display: false } },
              y: { beginAtZero: true, ticks: { precision: 0 } },
            },
            plugins: { legend: { display: false } },
          },
        });
      }
    }
  } catch (err) {
    console.error("preapprover: analytics fetch failed", err);
  }
}

function setupUI() {
  const s = el("permitsSearchInput");
  if (s) s.addEventListener("input", debounce(renderPermits, 180));
  const f = el("permitsStatusFilter");
  if (f) f.addEventListener("change", renderPermits);
  document.addEventListener("click", (e) => {
    if (
      e.target.closest('[data-action="closePermitDetails"]') ||
      e.target.closest('[data-action="hidePermitDetails"]')
    )
      closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
  const appr = el("approveFromModal");
  if (appr)
    appr.addEventListener("click", async () => {
      if (!currentPermitId) return;
      const ok = await handlePermitAction(currentPermitId, "preapprove");
      if (ok) closeModal();
    });
  const rej = el("rejectFromModal");
  if (rej)
    rej.addEventListener("click", async () => {
      if (!currentPermitId) return;
      const ok = await handlePermitAction(currentPermitId, "reject");
      if (ok) closeModal();
    });
}

async function init() {
  try {
    const session = await checkSession();
    currentUser = session?.user || null;
  } catch (e) {
    currentUser = null;
  }
  initIdleTimer();
  await ensureToasts();
  setupUI();
  await refreshAndRender();
  if (pollId) clearInterval(pollId);
  pollId = setInterval(refreshAndRender, 15000);
}

window.viewPermitDetails = viewPermitDetails;
window.handlePermitAction = handlePermitAction;
if (typeof window !== "undefined") window.init = init;
document.addEventListener("DOMContentLoaded", () => {
  try {
    if (typeof init === "function") init();
  } catch (e) {
    console.error("preapprover init error", e);
  }
});
