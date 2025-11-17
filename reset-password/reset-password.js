const urlParams = new URLSearchParams(window.location.search);
const token = urlParams.get("token");

const newPasswordInput = document.getElementById("newPassword");
const confirmPasswordInput = document.getElementById("confirmPassword");
const strengthText = document.getElementById("strengthText");

const strongPasswordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/;

newPasswordInput.addEventListener("input", () => {
  const val = newPasswordInput.value;
  let strength = "";
  let color = "";

  if (!val) {
    strength = "";
  } else if (!strongPasswordRegex.test(val)) {
    strength =
      "Password must be at least 8 characters and must include One Uppercase, Lowercase, Number, and Special character.";
    color = "var(--error-color)";
  } else {
    strength = "Strong password ✔";
    color = "var(--success-color)";
  }

  strengthText.textContent = strength;
  strengthText.style.color = color;
});

// Toggle password visibility
function toggleVisibility(id) {
  const input = document.getElementById(id);
  input.type = input.type === "password" ? "text" : "password";
}

async function resetPassword() {
  const newPassword = newPasswordInput.value;
  const confirmPassword = confirmPasswordInput.value;
  const messageEl = document.getElementById("message");

  if (!newPassword || !confirmPassword) {
    messageEl.style.color = "var(--error-color)";
    messageEl.textContent = "Password fields can not blank.";
    return;
  }

  if (!strongPasswordRegex.test(newPassword)) {
    messageEl.style.color = "var(--error-color)";
    messageEl.textContent = "Password does not meet security requirements.";
    return;
  }

  if (newPassword !== confirmPassword) {
    messageEl.style.color = "var(--error-color)";
    messageEl.textContent = "Passwords do not match.";
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword }),
    });

    const data = await res.json();
    messageEl.style.color = res.ok
      ? "var(--success-color)"
      : "var(--error-color)";
    messageEl.textContent = data.message || "Something went wrong";

    if (res.ok) {
      setTimeout(() => {
        try {
          const { hostname, pathname } = window.location;
          let prefix = "";
          if (hostname.endsWith("github.io")) {
            const segments = pathname.split("/").filter(Boolean);
            if (segments.length > 0) prefix = `/${segments[0]}`;
          }
          window.location.assign(`${prefix}/login/index.html`);
        } catch (_) {
          window.location.assign("/login/index.html");
        }
      }, 2000);
    }
  } catch (err) {
    messageEl.style.color = "var(--error-color)";
    messageEl.textContent = "Error: " + err.message;
  }
}
