(function () {
  const form = document.getElementById("publicSignupForm");
  const btn = document.getElementById("createAccountBtn");

  function showToast(type, message) {
    if (typeof window.showToast === "function") {
      window.showToast(type, message);
    } else {
      alert(message);
    }
  }

  function validate() {
    const alphaRe = /^[A-Za-z\s]+$/;
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    const phoneRe = /^\+974\d{8,}$/;
    const passwordRe =
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
    const fullName = form.fullName.value.trim();
    const email = form.email.value.trim();
    const phone = form.phone.value.trim().replace(/[\s\-()]/g, "");
    const company = form.company.value.trim();
    const password = form.password.value;
    const confirmPassword = form.confirmPassword.value;
    const termsAccepted = form.acceptTerms.checked;

    if (!fullName) {
      showToast("error", "Full name is required");
      return false;
    }
    if (!alphaRe.test(fullName)) {
      showToast("error", "Full name should contain letters and spaces only");
      return false;
    }
    if (!email) {
      showToast("error", "Email is required");
      return false;
    }
    if (!emailRe.test(email)) {
      showToast("error", "Please enter a valid email address");
      return false;
    }
    if (!phone) {
      showToast("error", "Phone number is required");
      return false;
    }
    if (!phoneRe.test(phone)) {
      showToast("error", "Phone format: +974 followed by at least 8 digits");
      return false;
    }
    if (company && !alphaRe.test(company)) {
      showToast("error", "Company name should contain letters and spaces only");
      return false;
    }
    if (!password) {
      showToast("error", "Password is required");
      return false;
    }
    if (!passwordRe.test(password)) {
      showToast(
        "error",
        "Password must be at least 8 characters with uppercase, lowercase, number, and special character"
      );
      return false;
    }
    if (!confirmPassword) {
      showToast("error", "Please confirm your password");
      return false;
    }
    if (password !== confirmPassword) {
      showToast("error", "Passwords do not match");
      return false;
    }
    if (!termsAccepted) {
      showToast("error", "You must accept the terms and conditions");
      return false;
    }
    return true;
  }

  async function submit(e) {
    e.preventDefault();
    if (!validate()) return;

    if (window._signupSubmitting) return;
    window._signupSubmitting = true;

    if (window._signupEmailExists) {
      showToast("error", "Email is already in use");
      window._signupSubmitting = false;
      return;
    }
    if (window._signupPhoneExists) {
      showToast("error", "Phone number is already in use");
      window._signupSubmitting = false;
      return;
    }

    btn.disabled = true;
    btn.classList.add("loading");
    const orig = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Creating...';

    const payload = {
      username: form.fullName.value.trim(),
      email: form.email.value.trim(),
      phone: form.phone.value.trim(),
      company: form.company.value.trim(),
      password: form.password.value,
      confirmPassword: form.confirmPassword.value,
      role: "Requester",
    };

    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        showToast(
          "success",
          data.message || "Registration successful! Redirecting to login..."
        );
        setTimeout(() => {
          window.location.href = "../login/index.html";
        }, 1500);
      } else {
        showToast(
          "error",
          data.message || data.error || "Registration failed. Please try again."
        );
      }
    } catch (err) {
      console.error(err);
      showToast(
        "error",
        "Network error. Please check your connection and try again."
      );
    } finally {
      btn.disabled = false;
      btn.classList.remove("loading");
      btn.innerHTML = orig;
      window._signupSubmitting = false;
    }
  }

  form.addEventListener("submit", submit);
  const emailEl = document.getElementById("email");
  const phoneEl = document.getElementById("phone");

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

  async function checkEmailUnique() {
    try {
      const v = emailEl && emailEl.value ? String(emailEl.value).trim() : "";
      if (!v) {
        window._signupEmailExists = false;
        if (emailEl) emailEl.classList.remove("border-red-500");
        return;
      }
      const res = await fetch(
        `/api/check-email?email=${encodeURIComponent(v)}`
      );
      if (!res.ok) return;
      const j = await res.json();
      window._signupEmailExists = !!j.exists;
      if (j.exists) {
        if (window.showToast)
          window.showToast("error", "Email is already registered");
        if (emailEl) emailEl.classList.add("border-red-500");
      } else {
        if (emailEl) emailEl.classList.remove("border-red-500");
      }
    } catch (e) {
      console.warn("checkEmailUnique error", e);
    }
  }

  async function checkPhoneUnique() {
    try {
      const v = phoneEl && phoneEl.value ? String(phoneEl.value).trim() : "";
      if (!v) {
        window._signupPhoneExists = false;
        if (phoneEl) phoneEl.classList.remove("border-red-500");
        return;
      }
      const res = await fetch(
        `/api/check-phone?phone=${encodeURIComponent(v)}`
      );
      if (!res.ok) return;
      const j = await res.json();
      window._signupPhoneExists = !!j.exists;
      if (j.exists) {
        if (window.showToast)
          window.showToast("error", "Phone number is already registered");
        if (phoneEl) phoneEl.classList.add("border-red-500");
      } else {
        if (phoneEl) phoneEl.classList.remove("border-red-500");
      }
    } catch (e) {
      console.warn("checkPhoneUnique error", e);
    }
  }

  if (emailEl) {
    const debouncedEmail = debounce(checkEmailUnique, 200);
    emailEl.addEventListener("blur", debouncedEmail);
    emailEl.addEventListener("input", () => {
      window._signupEmailExists = false;
      if (emailEl) emailEl.classList.remove("border-red-500");
    });
  }
  if (phoneEl) {
    const debouncedPhone = debounce(checkPhoneUnique, 200);
    phoneEl.addEventListener("blur", debouncedPhone);
    phoneEl.addEventListener("input", () => {
      window._signupPhoneExists = false;
      if (phoneEl) phoneEl.classList.remove("border-red-500");
    });
  }
})();
