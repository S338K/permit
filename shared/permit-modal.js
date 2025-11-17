import { API_BASE } from "../config.js";

const _tmpl = `
<div id="permitDetailsModal" class="modal fixed inset-0 bg-[var(--overlay-bg)] hidden z-50 items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="permitDetailsTitle" aria-hidden="true">
  <div class="modal-panel bg-[var(--bg-surface)] rounded-2xl shadow-2xl border border-[var(--input-border)] w-full max-w-4xl max-h-[90vh] overflow-y-auto">
    <div class="bg-gradient-to-r from-hia-blue/10 to-hia-light-blue/10 px-6 py-4 border-b border-[var(--input-border)] flex items-center justify-between">
      <h3 id="permitDetailsTitle" class="text-xl font-bold text-hia-blue">Permit Details</h3>
      <button data-action="hidePermitDetails" aria-label="Close permit details" class="hover-lite rounded-md p-2"><i class="fas fa-times" aria-hidden="true"></i></button>
    </div>
    <div id="permitDetailsContent" class="p-6">
      <div class="text-center text-[var(--text-secondary)]">Loading...</div>
    </div>
    <div class="p-4 border-t border-[var(--input-border)] flex gap-2 justify-end">
      <button data-action="closePermitDetails" aria-label="Close permit details" class="btn-secondary px-4 py-2 rounded-lg">Close</button>
      <button id="approveFromModal" aria-label="Pre-approve permit" class="btn-submit px-4 py-2 rounded-lg">Pre-Approve</button>
      <button id="rejectFromModal" aria-label="Reject permit" class="btn-delete px-4 py-2 rounded-lg">Reject</button>
    </div>
  </div>
</div>
`;

// escapeHtml: escape text for safe HTML insertion
function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function appendTemplateIfMissing() {
  if (document.getElementById("permitDetailsModal")) return;
  const wrapper = document.createElement("div");
  wrapper.innerHTML = _tmpl;
  document.body.appendChild(wrapper.firstElementChild);
}
function injectModalStyles() {
  if (document.getElementById("shared-permit-modal-styles")) return;
  const css = `
  #permitDetailsModal {
    transition: opacity .24s ease, visibility .24s ease;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
  }
  #permitDetailsModal.modal-show {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
  }
  #permitDetailsModal .modal-panel {
    transform: translateY(12px) scale(.98);
    opacity: 0;
    transition: transform .28s cubic-bezier(.2,.8,.2,1), opacity .28s ease;
  }
  #permitDetailsModal.modal-show .modal-panel {
    transform: translateY(0) scale(1);
    opacity: 1;
  }
  `;
  const s = document.createElement("style");
  s.id = "shared-permit-modal-styles";
  s.appendChild(document.createTextNode(css));
  document.head.appendChild(s);
}

function openModalShell() {
  const m = document.getElementById("permitDetailsModal");
  if (!m) return;
  m.classList.remove("hidden");
  m.classList.add("flex");
  m.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  setTimeout(() => m.classList.add("modal-show"), 20);
}
function closeModalShell() {
  const m = document.getElementById("permitDetailsModal");
  if (!m) return;
  m.classList.remove("modal-show");
  document.body.classList.remove("modal-open");
  setTimeout(() => {
    m.classList.add("hidden");
    m.classList.remove("flex");
    m.setAttribute("aria-hidden", "true");
    const content = document.getElementById("permitDetailsContent");
    if (content) content.innerHTML = "";
  }, 280);
}
// fetchAndShowPermit: fetch permit details and render into modal
async function fetchAndShowPermit(id) {
  if (!id) return;
  const content = document.getElementById("permitDetailsContent");
  if (!content) return;
  content.innerHTML =
    '<div class="text-center text-[var(--text-secondary)]">Loading...</div>';
  try {
    const res = await fetch(`${API_BASE}/api/permits/${id}`, {
      credentials: "include",
    });
    if (!res.ok) throw new Error("failed to fetch permit");
    const p = await res.json();

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

    const filesHtml =
      (p.files || [])
        .map(
          (f) =>
            `<div class="flex items-center justify-between p-3 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-md"><span class="text-sm truncate flex-1">${escapeHtml(
              f.originalName
            )}</span><a class="ml-3 text-sm text-hia-blue font-medium" href="${escapeHtml(
              f.url
            )}" aria-label="Download ${escapeHtml(
              f.originalName
            )}" target="_blank" rel="noopener noreferrer">Download</a></div>`
        )
        .join("") ||
      '<div class="p-3 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-md text-sm text-secondary">No files attached</div>';

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

    const isReadOnlyModal = ["In Progress", "Approved"].includes(p.status);

    const commentsSection = isReadOnlyModal
      ? `
        <div class="bg-[var(--bg-surface)] border border-[var(--input-border)] rounded-xl p-5">
          <h4 class="text-sm font-semibold text-primary mb-4">Approver Hierarchy</h4>
          <div class="approver-row flex items-center gap-4">
            <div class="approver-card" role="group" aria-labelledby="preapprover-label">
              <div id="preapprover-label" class="title">Pre-Approver</div>
              <div class="name">${escapeHtml(preApproverName)}</div>
              <div class="text-xs text-secondary mt-2">Pre-Approved</div>
              <div class="mt-1 text-sm">${escapeHtml(
                preApprovedAtDisplay
              )}</div>
              <div class="text-xs text-secondary mt-3">Comments</div>
              <div class="mt-1 text-sm">${escapeHtml(preApproverComments)}</div>
            </div>
            <div class="connector-horizontal" aria-hidden="true" style="--connector-color: ${connectorColor}">
              <div class="connector-line" aria-hidden="true"><span class="connector-char" aria-hidden="true">🠖</span></div>
            </div>
            <div class="approver-card" role="group" aria-labelledby="approver-label">
              <div id="approver-label" class="title">Approver</div>
              <div class="name">${escapeHtml(approverName)}</div>
              <div class="text-xs text-secondary mt-2">Approved</div>
              <div class="mt-1 text-sm">${escapeHtml(approvedAtDisplay)}</div>
              <div class="text-xs text-secondary mt-3">Comments</div>
              <div class="mt-1 text-sm">${escapeHtml(approverComments)}</div>
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

        <div class="bg-[var(--bg-surface)] border border-[var(--input-border)] rounded-xl p-5">
          <h4 class="text-sm font-semibold mb-4 text-primary">Requester Details</h4>
          ${renderRequester(p.requester)}
        </div>

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

        <div class="bg-[var(--bg-surface)] border border-[var(--input-border)] rounded-xl p-5">
          <div class="flex items-center justify-between mb-4">
            <h4 class="text-sm font-semibold text-primary">Required Documents</h4>
            <span class="text-xs text-secondary">${
              (p.files || []).length
            } file(s)</span>
          </div>
          <div class="space-y-2">${filesHtml}</div>
        </div>

        <div class="bg-[var(--bg-surface)] border border-[var(--input-border)] rounded-xl p-5">
          <div class="flex items-center justify-between mb-4">
            <h4 class="text-sm font-semibold text-primary">Date & Time</h4>
          </div>
          ${
            isReadOnlyModal
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

    // Hide Pre-Approve / Reject buttons for read-only (pre-approved/approved) permits
    const isReadOnly = ["In Progress", "Approved"].includes(p.status);
    const approveBtn = document.getElementById("approveFromModal");
    const rejectBtn = document.getElementById("rejectFromModal");
    if (approveBtn) approveBtn.classList.toggle("hidden", isReadOnly);
    if (rejectBtn) rejectBtn.classList.toggle("hidden", isReadOnly);

    openModalShell();
  } catch (err) {
    console.error("shared permit-modal: failed to load permit", err);
    const content = document.getElementById("permitDetailsContent");
    if (content)
      content.innerHTML =
        '<div class="text-sm text-error-color">Unable to load permit details.</div>';
  }
}

// Public API: window.viewPermitDetails(id)
function _expose() {
  window.viewPermitDetails = function (id) {
    fetchAndShowPermit(id);
  };

  document.addEventListener("profile:view-permit", (ev) => {
    const id = ev?.detail?.id;
    if (id) fetchAndShowPermit(id);
  });

  // wire shell-level close actions for pages that don't attach handlers
  document.addEventListener("click", (e) => {
    if (
      e.target.closest('[data-action="closePermitDetails"]') ||
      e.target.closest('[data-action="hidePermitDetails"]')
    )
      closeModalShell();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    appendTemplateIfMissing();
    injectModalStyles();
    _expose();
  });
} else {
  appendTemplateIfMissing();
  injectModalStyles();
  _expose();
}

export {};
