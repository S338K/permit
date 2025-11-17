import { checkSession, initIdleTimer, logoutUser } from "../shared/session.js";
import { formatDate24 } from "../date-utils.js";
import { API_BASE } from "../config.js";

let allPermits = [];
let allActivities = [];
let currentUser = null;

// showNotification: display a user-facing notification (toast/alert)
function showNotification(message, type = "info") {
  if (typeof window.showToast === "function") {
    const t =
      type === "error" ? "error" : type === "success" ? "success" : "info";
    window.showToast(t, message);
    return;
  }

  try {
    alert(message);
  } catch (e) {}
}

// updateStats: compute and update permit statistics in the UI
function updateStats(permits) {
  let approved = 0,
    rejected = 0,
    pending = 0,
    inProgress = 0,
    returnedForInfo = 0;
  permits.forEach((p) => {
    const status = (p.status || "").toLowerCase();
    if (status === "approved") approved++;
    else if (status === "rejected") rejected++;
    else if (status === "in progress") inProgress++;
    else if (status === "pending") pending++;
    else if (status === "returned for info") returnedForInfo++;
  });

  const total = permits.length;
  const approvedPercentage =
    total > 0 ? ((approved / total) * 100).toFixed(1) : 0;
  const rejectedPercentage =
    total > 0 ? ((rejected / total) * 100).toFixed(1) : 0;
  const pendingPercentage =
    total > 0 ? ((pending / total) * 100).toFixed(1) : 0;
  const returnedPercentage =
    total > 0 ? ((returnedForInfo / total) * 100).toFixed(1) : 0;

  const totalElement = document.getElementById("totalPermitsCount");
  const pendingElement = document.getElementById("pendingPermitsCount");
  const approvedElement = document.getElementById("approvedPermitsCount");
  const rejectedElement = document.getElementById("rejectedPermitsCount");
  const returnedForInfoElement = document.getElementById(
    "returnedForInfoCount"
  );

  const approvedPercentageElement =
    document.getElementById("approvedPercentage");
  const rejectedPercentageElement =
    document.getElementById("rejectedPercentage");
  const pendingPercentageElement = document.getElementById("pendingPercentage");
  const returnedPercentageElement =
    document.getElementById("returnedPercentage");

  if (totalElement) totalElement.textContent = total;
  if (pendingElement) pendingElement.textContent = pending;
  if (approvedElement) approvedElement.textContent = approved;
  if (rejectedElement) rejectedElement.textContent = rejected;
  if (returnedForInfoElement)
    returnedForInfoElement.textContent = returnedForInfo;
  if (approvedPercentageElement)
    approvedPercentageElement.textContent = approvedPercentage + "%";
  if (rejectedPercentageElement)
    rejectedPercentageElement.textContent = rejectedPercentage + "%";
  if (pendingPercentageElement)
    pendingPercentageElement.textContent = pendingPercentage + "%";
  if (returnedPercentageElement)
    returnedPercentageElement.textContent = returnedPercentage + "%";

  updateTaskProgress(approved, inProgress, pending);
}

// updateTaskProgress: update task progress UI bars and counters
function updateTaskProgress(completed, inProgress, upcoming) {
  const totalTasks = completed + inProgress + upcoming;
  const progressPercentage =
    totalTasks > 0 ? Math.round((completed / totalTasks) * 100) : 0;

  const progressElement = document.getElementById("taskProgressPercentage");
  const completedElement = document.getElementById("completedTasksCount");
  const inProgressElement = document.getElementById("inProgressTasksCount");
  const pendingElement = document.getElementById("pendingTasksCount");

  if (progressElement) progressElement.textContent = progressPercentage + "%";
  if (completedElement) completedElement.textContent = completed;
  if (inProgressElement) inProgressElement.textContent = inProgress;
  if (pendingElement) pendingElement.textContent = upcoming;

  const progressBarContainer = document.querySelector(
    ".progress-bar-container .progress"
  );
  if (progressBarContainer) {
    const progressBars = progressBarContainer.querySelectorAll(".progress-bar");
    if (totalTasks > 0) {
      const completedWidth = (completed / totalTasks) * 100;
      const inProgressWidth = (inProgress / totalTasks) * 100;
      const upcomingWidth = (upcoming / totalTasks) * 100;
      progressBars[0].style.width = completedWidth + "%";
      progressBars[1].style.width = inProgressWidth + "%";
      progressBars[2].style.width = upcomingWidth + "%";
    }
  }
}

// renderPermits: render permit list into the page
function renderPermits(permits) {
  console.debug("renderPermits called with", permits.length, "permits");
}

// renderActivityLog: render a simple activity list
function renderActivityLog(activities) {
  const log = document.getElementById("activityLog");
  if (!log) return;
  log.innerHTML = "";
  if (!activities.length) {
    log.innerHTML = '<li class="text-gray-400">No recent activity.</li>';
    return;
  }
  activities.forEach((act) => {
    log.innerHTML += `<li>${act}</li>`;
  });
}

// filterPermits: return permits matching the query
function filterPermits(query) {
  query = query.trim().toLowerCase();
  return allPermits.filter(
    (p) =>
      (p.permitTitle || "").toLowerCase().includes(query) ||
      (p.companyName || "").toLowerCase().includes(query) ||
      (p.status || "").toLowerCase().includes(query) ||
      (p._id || "").toLowerCase().includes(query)
  );
}

// fetchPermits: load permits from API and refresh UI
async function fetchPermits() {
  allPermits = [];
  try {
    const res = await fetch(`${API_BASE}/api/permits`, {
      credentials: "include",
    });
    if (!res.ok) throw new Error("Failed to fetch permits");
    const data = await res.json();
    allPermits = data.permits || data || [];
  } catch (err) {
    console.error("Error fetching permits:", err);
    allPermits = [];
    showNotification(
      "Could not load permits from server. Showing empty list.",
      "error"
    );
  }

  renderPermits(allPermits);
  updateStats(allPermits);
  updatePermitTables();
}

// updatePermitTables: split permits into pending/approved/rejected and populate tables
function updatePermitTables() {
  const pendingPermits = allPermits.filter((p) => p.status === "Pending");
  const approvedPermits = allPermits.filter((p) => p.status === "Approved");
  const rejectedPermits = allPermits.filter((p) => p.status === "Rejected");

  populateTableBody("pendingPermitsTable", pendingPermits, "pending");
  populateTableBody("approvedPermitsTable", approvedPermits, "approved");
  populateTableBody("rejectedPermitsTable", rejectedPermits, "rejected");
}

function populateTableBody(tableId, permits, type) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const tbody = table.querySelector("tbody");
  if (!tbody) return;

  if (!permits.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="text-center py-4">No ${type} permits found</td></tr>`;
    return;
  }

  tbody.innerHTML = "";
  permits.forEach((permit, index) => {
    const row = createPermitRow(permit, type, index + 1);
    tbody.appendChild(row);
  });
}

// createPermitRow: build a table row element for a permit
function createPermitRow(permit, type, index = 0) {
  const row = document.createElement("tr");

  const submittedDate = permit.createdAt
    ? new Date(permit.createdAt).toLocaleDateString() +
      " " +
      new Date(permit.createdAt).toLocaleTimeString()
    : "-";

  const preApprovedDate = permit.preApprovedAt
    ? new Date(permit.preApprovedAt).toLocaleDateString() +
      " " +
      new Date(permit.preApprovedAt).toLocaleTimeString()
    : "-";

  const approvedDate = permit.approvedAt
    ? new Date(permit.approvedAt).toLocaleDateString() +
      " " +
      new Date(permit.approvedAt).toLocaleTimeString()
    : "-";

  let preApproverName = "-";
  if (permit.preApprovedBy) {
    preApproverName =
      permit.preApprovedBy.fullName || permit.preApprovedBy.username || "-";
  } else if (permit.preApproverName) {
    preApproverName = permit.preApproverName;
  }

  if (type === "pending") {
    row.innerHTML = `
      <td class="small">${permit._id || "-"}</td>
      <td class="small">${permit.permitTitle || "-"}</td>
      <td class="small">${submittedDate}</td>
      <td class="small">${preApproverName}</td>
      <td class="small">${permit.preApproverComments || "-"}</td>
      <td class="small">
        <div class="btn-group btn-group-sm">
          <button class="btn btn-outline-primary btn-sm view-permit-btn" data-permit-id="${
            permit._id
          }">
            <i class="fas fa-eye"></i> View Details
          </button>
        </div>
      </td>
    `;
  } else if (type === "approved") {
    row.innerHTML = `
      <td class="text-center">${index}</td>
      <td class="text-center">
        <a href="#" class="permit-number-link view-permit-link" data-permit-id="${
          permit._id
        }">
          ${permit._id || permit.serialNo || "-"}
        </a>
      </td>
      <td class="text-left">${permit.permitTitle || "-"}</td>
      <td class="text-center small text-muted">${submittedDate}</td>
      <td class="text-center small text-muted">${approvedDate}</td>
    `;
  } else if (type === "rejected") {
    const rejectedDate = permit.rejectedAt || permit.approvedAt;
    const rejectedDateFormatted = rejectedDate
      ? new Date(rejectedDate).toLocaleDateString() +
        ", " +
        new Date(rejectedDate).toLocaleTimeString()
      : "-";

    row.innerHTML = `
      <td class="text-center">${index}</td>
      <td class="text-center">
        <a href="#" class="permit-number-link view-permit-link" data-permit-id="${
          permit._id
        }">
          ${permit._id || permit.serialNo || "-"}
        </a>
      </td>
      <td class="text-left">${permit.permitTitle || "-"}</td>
      <td class="text-center small text-muted">${rejectedDateFormatted}</td>
    `;
  }

  return row;
}

async function fetchActivityLog() {
  try {
    const res = await fetch(`${API_BASE}/api/activity`, {
      credentials: "include",
    });
    if (!res.ok) throw new Error("Failed to fetch activity log");
    const data = await res.json();
    allActivities = data.activities || data || [];
  } catch (err) {
    console.error("Error fetching activity log:", err);
    allActivities = [];
    showNotification("Could not load activity log.", "error");
  }
  renderActivityLog(allActivities);
}

async function fetchUserProfile() {
  // fetchUserProfile: load current user profile from API
  try {
    const response = await fetch(`${API_BASE}/api/profile`, {
      credentials: "include",
    });

    if (!response.ok) {
      throw new Error("Failed to fetch user profile");
    }

    const data = await response.json();
    console.debug("[fetchUserProfile] profile response:", data);
    const userObj = { ...data.user, role: data.session.role };
    if (userObj.profileUpdatedAt)
      userObj.profileUpdatedAt = new Date(userObj.profileUpdatedAt);
    if (userObj.passwordUpdatedAt)
      userObj.passwordUpdatedAt = new Date(userObj.passwordUpdatedAt);
    if (data.clientIp) userObj.clientIp = data.clientIp;

    currentUser = userObj;
    updateProfileDisplay(currentUser);

    if (currentUser.clientIp) {
      const normalizeIp = (ip) => {
        if (!ip) return ip;
        if (ip === "::1") return "127.0.0.1";
        if (ip.startsWith("::ffff:")) return ip.split(":").pop();
        return ip;
      };
      const existing = document.getElementById("clientIp");
      const displayIp = normalizeIp(currentUser.clientIp);
      if (existing) existing.textContent = `IP Address: ${displayIp}`;
      else {
        const lastLogin = document.querySelector(".last-login");
        if (lastLogin) {
          const ipEl = document.createElement("p");
          ipEl.className = "mb-1 text-muted small";
          ipEl.id = "clientIp";
          ipEl.textContent = `IP Address: ${displayIp}`;
          ipEl.title = `Raw IP: ${currentUser.clientIp}`;
          lastLogin.insertAdjacentElement("afterend", ipEl);
        }
      }
    }
  } catch (err) {
    console.error("Error fetching user profile:", err);
    showNotification("Could not load user profile.", "error");
  }
}

function updateProfileDisplay(user) {
  const usernameEl = document.getElementById("displayUsername");
  if (usernameEl) usernameEl.textContent = user.username || "N/A";

  const fullNameEl = document.getElementById("displayFullName");
  if (fullNameEl) fullNameEl.textContent = user.fullName || "N/A";

  const emailEl = document.getElementById("displayEmail");
  if (emailEl) emailEl.textContent = user.email || "N/A";

  const phoneEl = document.getElementById("displayPhone");
  if (phoneEl) phoneEl.textContent = user.phone || "N/A";

  const companyEl = document.getElementById("displayCompany");
  if (companyEl) companyEl.textContent = user.company || "N/A";

  const roleEl = document.getElementById("displayRole");
  if (roleEl) roleEl.textContent = user.role || "N/A";

  const lastLoginEl = document.getElementById("displayLastLogin");
  if (lastLoginEl)
    lastLoginEl.textContent = user.lastLogin
      ? formatDate24(new Date(user.lastLogin))
      : "N/A";

  const profileUpdatedEl = document.getElementById("displayProfileUpdatedAt");
  if (profileUpdatedEl)
    profileUpdatedEl.textContent = user.profileUpdatedAt
      ? formatDate24(user.profileUpdatedAt)
      : "N/A";

  const passwordUpdatedEl = document.getElementById("displayPasswordUpdatedAt");
  if (passwordUpdatedEl)
    passwordUpdatedEl.textContent = user.passwordUpdatedAt
      ? formatDate24(user.passwordUpdatedAt)
      : "N/A";
}

function exportToExcel() {
  if (!window.XLSX || !window.XLSX.utils) {
    showNotification("Excel library not loaded.", "error");
    return;
  }

  const visiblePermits = allPermits.map((p) => ({
    "Permit ID": p._id || "-",
    "Permit Title": p.permitTitle || "-",
    Status: p.status || "-",
    Company: p.companyName || "-",
    "Submitted Date": p.createdAt
      ? new Date(p.createdAt).toLocaleDateString()
      : "-",
    "Pre-Approved Date": p.preApprovedAt
      ? new Date(p.preApprovedAt).toLocaleDateString()
      : "-",
    "Approved Date": p.approvedAt
      ? new Date(p.approvedAt).toLocaleDateString()
      : "-",
  }));

  const worksheet = XLSX.utils.json_to_sheet(visiblePermits);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Permits");
  XLSX.writeFile(workbook, "Permits.xlsx");
  showNotification("Exported to Excel successfully!", "success");
}

function printTable() {
  const printContent = document.getElementById("permitTable").outerHTML;
  const newWindow = window.open("", "_blank");
  newWindow.document.write(`
    <html>
      <head>
        <title>Print Permits</title>
        <style>
          body { margin: 20px; }
          table { width: 100%; border-collapse: collapse; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background-color: #f2f2f2; font-weight: bold; }
        </style>
      </head>
      <body>
        ${printContent}
      </body>
    </html>
  `);
  newWindow.document.close();
  newWindow.print();
}

function sortTable(columnIndex) {
  const table = document.getElementById("permitTable");
  const tbody = table.querySelector("tbody");
  const rows = Array.from(tbody.querySelectorAll("tr"));

  const sortedRows = rows.sort((a, b) => {
    const cellA = a.querySelectorAll("td")[columnIndex].innerText.toLowerCase();
    const cellB = b.querySelectorAll("td")[columnIndex].innerText.toLowerCase();
    return cellA.localeCompare(cellB);
  });

  tbody.innerHTML = "";
  sortedRows.forEach((row) => tbody.appendChild(row));
  showNotification("Table sorted!", "info");
}

function validatePasswordStrength(password) {
  const strongRegex = new RegExp(
    "^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#$%^&*])(?=.{8,})"
  );
  return strongRegex.test(password);
}

async function updateProfile(event) {
  event.preventDefault();

  const fullName = document.getElementById("editFullName").value.trim();
  const email = document.getElementById("editEmail").value.trim();
  const phone = document.getElementById("editPhone").value.trim();
  const company = document.getElementById("editCompany").value.trim();

  if (!fullName || !email || !phone || !company) {
    showNotification("All fields are required.", "error");
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/api/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ fullName, email, phone, company }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || "Failed to update profile");
    }

    showNotification("Profile updated successfully!", "success");

    currentUser.fullName = fullName;
    currentUser.email = email;
    currentUser.phone = phone;
    currentUser.company = company;
    currentUser.profileUpdatedAt = new Date();

    updateProfileDisplay(currentUser);

    setTimeout(() => {
      const modal = document.getElementById("editProfileModal");
      if (modal) {
        const bsModal = bootstrap.Modal.getInstance(modal);
        if (bsModal) bsModal.hide();
      }
    }, 1500);
  } catch (err) {
    console.error("Error updating profile:", err);
    showNotification(err.message || "Failed to update profile.", "error");
  }
}

async function updatePassword(event) {
  event.preventDefault();

  const currentPassword = document
    .getElementById("currentPassword")
    .value.trim();
  const newPassword = document.getElementById("newPassword").value.trim();
  const confirmPassword = document
    .getElementById("confirmPassword")
    .value.trim();

  if (!currentPassword || !newPassword || !confirmPassword) {
    showNotification("All password fields are required.", "error");
    return;
  }

  if (newPassword !== confirmPassword) {
    showNotification("New passwords do not match.", "error");
    return;
  }

  if (!validatePasswordStrength(newPassword)) {
    showNotification(
      "Password must be at least 8 characters long and include uppercase, lowercase, number, and special character.",
      "error"
    );
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/api/profile/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ currentPassword, newPassword }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || "Failed to update password");
    }

    showNotification("Password updated successfully!", "success");

    currentUser.passwordUpdatedAt = new Date();
    updateProfileDisplay(currentUser);

    setTimeout(() => {
      const modal = document.getElementById("changePasswordModal");
      if (modal) {
        const bsModal = bootstrap.Modal.getInstance(modal);
        if (bsModal) bsModal.hide();
      }
      document.getElementById("currentPassword").value = "";
      document.getElementById("newPassword").value = "";
      document.getElementById("confirmPassword").value = "";
    }, 1500);
  } catch (err) {
    console.error("Error updating password:", err);
    showNotification(err.message || "Failed to update password.", "error");
  }
}

function togglePassword(buttonId, inputId) {
  const button = document.getElementById(buttonId);
  const input = document.getElementById(inputId);

  if (!button || !input) return;

  const icon = button.querySelector("i");
  if (input.type === "password") {
    input.type = "text";
    if (icon) {
      icon.classList.remove("fa-eye");
      icon.classList.add("fa-eye-slash");
    }
  } else {
    input.type = "password";
    if (icon) {
      icon.classList.remove("fa-eye-slash");
      icon.classList.add("fa-eye");
    }
  }
}

window.togglePassword = togglePassword;

document.addEventListener("DOMContentLoaded", async () => {
  currentUser = await checkSession();
  if (!currentUser) return;

  initIdleTimer();

  await Promise.all([fetchPermits(), fetchActivityLog(), fetchUserProfile()]);

  const exportBtn = document.getElementById("exportBtn");
  if (exportBtn) exportBtn.addEventListener("click", exportToExcel);

  const printBtn = document.getElementById("printBtn");
  if (printBtn) printBtn.addEventListener("click", printTable);

  const toggleCurrentPasswordBtn = document.getElementById(
    "toggleCurrentPassword"
  );
  if (toggleCurrentPasswordBtn)
    toggleCurrentPasswordBtn.addEventListener("click", () =>
      togglePassword("toggleCurrentPassword", "currentPassword")
    );

  const toggleNewPasswordBtn = document.getElementById("toggleNewPassword");
  if (toggleNewPasswordBtn)
    toggleNewPasswordBtn.addEventListener("click", () =>
      togglePassword("toggleNewPassword", "newPassword")
    );

  const toggleConfirmPasswordBtn = document.getElementById(
    "toggleConfirmPassword"
  );
  if (toggleConfirmPasswordBtn)
    toggleConfirmPasswordBtn.addEventListener("click", () =>
      togglePassword("toggleConfirmPassword", "confirmPassword")
    );

  const updateProfileForm = document.getElementById("updateProfileForm");
  if (updateProfileForm)
    updateProfileForm.addEventListener("submit", updateProfile);

  const updatePasswordForm = document.getElementById("updatePasswordForm");
  if (updatePasswordForm)
    updatePasswordForm.addEventListener("submit", updatePassword);

  document.addEventListener("click", (e) => {
    if (e.target.closest(".view-permit-btn")) {
      e.preventDefault();
      const btn = e.target.closest(".view-permit-btn");
      const permitId = btn.dataset.permitId;
      if (permitId) {
        console.log("View permit details for:", permitId);
        showNotification(`Viewing permit: ${permitId}`, "info");
      }
    }
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest(".view-permit-link")) {
      e.preventDefault();
      const link = e.target.closest(".view-permit-link");
      const permitId = link.dataset.permitId;
      if (permitId) {
        console.log("View permit details for:", permitId);
        showNotification(`Viewing permit: ${permitId}`, "info");
      }
    }
  });
});
