document.addEventListener("DOMContentLoaded", () => {
  const sendTokenBtn = document.getElementById("send-token");
  const updatePasswordBtn = document.getElementById("update-password");
  const tokenSection = document.getElementById("token-section");
  const msgBox = document.getElementById("msg-box");

  function showMessage(msg, type) {
    msgBox.textContent = msg;
    msgBox.style.background = type === "success" ? "#d4edda" : "#f8d7da";
    msgBox.style.color = type === "success" ? "#155724" : "#721c24";
    msgBox.style.border =
      type === "success" ? "1px solid #c3e6cb" : "1px solid #f5c6cb";
  }

  sendTokenBtn.addEventListener("click", async () => {
    const email = document.getElementById("reset-email").value.trim();
    if (!email) return showMessage("Please enter your email", "error");

    try {
      const res = await fetch(
        "https://ptw-yu8u.onrender.com/api/forgot-password",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        }
      );
      const data = await res.json();

      if (res.ok) {
        showMessage(
          "Reset token generated. Check your email (or see alert for testing).",
          "success"
        );
        alert("Token (testing only): " + data.token);
        tokenSection.classList.remove("hidden");
      } else {
        showMessage(data.message || "Error generating token", "error");
      }
    } catch (err) {
      console.error("Error sending token:", err);
      showMessage("Server error while generating token", "error");
    }
  });

  updatePasswordBtn.addEventListener("click", async () => {
    const token = document.getElementById("reset-token").value.trim();
    const newPassword = document.getElementById("new-password").value.trim();

    if (!token || !newPassword) {
      return showMessage("Please fill in all fields", "error");
    }

    const passwordRegex = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[@$!%*?&]).{8,}$/;
    if (!passwordRegex.test(newPassword)) {
      return showMessage(
        "Password must be at least 8 characters long and include a letter, number, and special character.",
        "error"
      );
    }

    try {
      const res = await fetch("/api/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword }),
      });
      const data = await res.json();

      if (res.ok) {
        const container = document.querySelector(".container");
        container.style.transition = "opacity 0.8s ease";
        container.style.opacity = "0";

        setTimeout(() => {
          let countdown = 10;
          container.innerHTML = `
          <div class="success-message">
            <h2>Password Reset Successful ✅</h2>
            <p>You can now log in with your new password.</p>
            <p>This window will close automatically in <span id="countdown">${countdown}</span> seconds...</p>
          </div>
        `;

          container.style.opacity = "0";
          container.offsetHeight; // force reflow
          container.style.opacity = "1";

          const countdownEl = document.getElementById("countdown");
          const timer = setInterval(() => {
            countdown--;
            countdownEl.textContent = countdown;
            if (countdown <= 0) {
              clearInterval(timer);
              if (window.opener) {
                window.opener.location.reload();
              }
              window.close();
            }
          }, 1000);
        }, 800);
      } else {
        showMessage(data.message || "Error updating password", "error");
      }
    } catch (err) {
      console.error("Error updating password:", err);
      showMessage(
        "Something went wrong while updating password, try again later",
        "error"
      );
    }
  });
});
