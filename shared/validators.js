(function () {
  function validateName(name) {
    return /^[A-Za-zÁÉÍÓÚáéíóúÑñ\s]{2,50}$/.test(String(value || "").trim());
  }
  // validateCompany: validate company name
  function validateCompany(value) {
    return /^[A-Za-zÁÉÍÓÚáéíóúÑñ0-9\s]{2,50}$/.test(String(value || "").trim());
  }
  // validateEmail: basic email format check
  function validateEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
  }
  // validatePhone: basic phone number check (Qatar +974 expected)
  function validatePhone(value) {
    try {
      const cleaned = String(value || "").replace(/[\s\-()]/g, "");
      return /^\+974\d{8,}$/.test(cleaned);
    } catch (_) {
      return false;
    }
  }
  // validatePassword: strong password policy and checks against name/email
  function validatePassword(value, name, email) {
    const strongPattern =
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
    if (!strongPattern.test(String(value || ""))) return false;
    const lower = String(value || "").toLowerCase();
    if (name && lower.includes(String(name || "").toLowerCase())) return false;
    if (
      validateEmail(email) &&
      lower.includes(
        String(email || "")
          .split("@")[0]
          .toLowerCase()
      )
    )
      return false;
    return true;
  }
  // validateConfirmPassword: ensure passwords match
  function validateConfirmPassword(pass, confirm) {
    return (
      String(pass || "") === String(confirm || "") &&
      String(confirm || "").length > 0
    );
  }
  // validateTerms: checkbox must be truthy
  function validateTerms(checked) {
    return !!checked;
  }

  // Attach to window for non-module consumers
  try {
    if (typeof window !== "undefined") {
      window.PTW_VALIDATORS = window.PTW_VALIDATORS || {};
      Object.assign(window.PTW_VALIDATORS, {
        validateName,
        validateCompany,
        validateEmail,
        validatePhone,
        validatePassword,
        validateConfirmPassword,
        validateTerms,
      });
    }
  } catch (_) {}
})();
