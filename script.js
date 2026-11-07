
document.addEventListener("DOMContentLoaded", async () => {
  // Highlight the current navigation item.
  const current = document.body.dataset.page;
  document.querySelectorAll(".nav a").forEach(link => {
    if (link.dataset.page === current) link.classList.add("active");
  });

  const authStorageKeys = ["carWashToken", "carWashLoggedIn", "carWashUsername", "carWashRole"];
  const readAuthCookie = key => {
    const cookie = document.cookie.split("; ").find(item => item.startsWith(`${key}=`));
    return cookie ? decodeURIComponent(cookie.slice(key.length + 1)) : null;
  };
  const writeAuthCookie = (key, value) => {
    document.cookie = `${key}=${encodeURIComponent(value)}; Path=/; SameSite=Lax`;
  };
  const clearAuthCookie = key => {
    document.cookie = `${key}=; Max-Age=0; Path=/; SameSite=Lax`;
  };
  if (!localStorage.getItem("carWashToken")) {
    authStorageKeys.forEach(key => {
      const sessionValue = sessionStorage.getItem(key);
      const value = sessionValue !== null ? sessionValue : readAuthCookie(key);
      if (value !== null) localStorage.setItem(key, value);
    });
  }
  authStorageKeys.forEach(key => sessionStorage.removeItem(key));

  let loggedIn = localStorage.getItem("carWashLoggedIn") === "true";
  let currentRole = localStorage.getItem("carWashRole") || "user";
  let authCheckError = "";
  if ((current === "dashboard" || current === "user-dashboard") &&
      (!loggedIn || !localStorage.getItem("carWashToken"))) {
    try {
      const response = await fetch("/api/me", { cache: "no-store" });
      if (response.ok) {
        const account = await response.json();
        loggedIn = true;
        currentRole = account.role;
        localStorage.setItem("carWashLoggedIn", "true");
        localStorage.setItem("carWashUsername", account.username);
        localStorage.setItem("carWashRole", account.role);
        writeAuthCookie("carWashLoggedIn", "true");
        writeAuthCookie("carWashUsername", account.username);
        writeAuthCookie("carWashRole", account.role);
      } else if (response.status === 401) {
        loggedIn = false;
        authStorageKeys.forEach(key => {
          localStorage.removeItem(key);
          clearAuthCookie(key);
        });
      } else {
        authCheckError = "Unable to verify your sign-in. Please try again.";
      }
    } catch (error) {
      console.error("Could not verify the dashboard session:", error);
      authCheckError = "Unable to reach the server. Your dashboard session could not be verified.";
    }
  }
  document.querySelectorAll("[data-dashboard-link]").forEach(link => {
    const dashboardPage = currentRole === "admin" ? "dashboard" : "user-dashboard";
    link.hidden = false;
    link.href = loggedIn
      ? currentRole === "admin" ? "dashboard.html" : "user-dashboard.html"
      : "login.html?register=1";
    link.textContent = currentRole === "admin" && loggedIn ? "Admin dashboard" : "My dashboard";
    link.dataset.page = dashboardPage;
    link.classList.toggle("active", current === dashboardPage);
  });

  if (current === "dashboard" && !loggedIn && !authCheckError) {
    window.location.replace("login.html");
    return;
  }

  if (current === "dashboard" && loggedIn && currentRole !== "admin") {
    window.location.replace("user-dashboard.html");
    return;
  }

  if (current === "user-dashboard" && !loggedIn && !authCheckError) {
    window.location.replace("login.html");
    return;
  }

  if (current === "user-dashboard" && loggedIn && currentRole !== "user") {
    window.location.replace("dashboard.html");
    return;
  }

  document.querySelectorAll("[data-book]").forEach(button => {
    button.addEventListener("click", () => {
      const service = button.closest(".service-card")?.querySelector(".service-name")?.textContent.trim();
      const destination = new URL("appointment.html", window.location.href);
      if (service) destination.searchParams.set("service", service);
      destination.searchParams.set("source", current);
      window.location.href = destination.pathname + destination.search;
    });
  });

  const accountStorageKey = "carWashAccounts";
  const readAccounts = () => JSON.parse(localStorage.getItem(accountStorageKey) || "[]");
  const writeAccounts = (accounts) => localStorage.setItem(accountStorageKey, JSON.stringify(accounts));
  const tokenStorageKey = "carWashToken";
  const apiRequest = async (url, options = {}) => {
    const headers = { ...(options.headers || {}) };
    const token = localStorage.getItem(tokenStorageKey);
    if (token) headers.Authorization = "Bearer " + token;
    if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await fetch(url, { ...options, headers });
    } catch {
      throw new Error("Unable to reach the Car Wash server. Run `python server.py` and open http://127.0.0.1:8002.");
    }
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || "The request failed.");
      error.status = response.status;
      throw error;
    }
    return result;
  };
  const saveSession = ({ token, account }) => {
    const session = {
      [tokenStorageKey]: token,
      carWashLoggedIn: "true",
      carWashUsername: account.username,
      carWashRole: account.role,
    };
    Object.entries(session).forEach(([key, value]) => {
      localStorage.setItem(key, value);
      writeAuthCookie(key, value);
    });
  };

  const loginForm = document.querySelector("#loginForm");
  const registerForm = document.querySelector("#registerForm");
  const authToggles = document.querySelectorAll("[data-auth-toggle]");

  const setAuthMode = (mode) => {
    const isLogin = mode === "login";
    if (loginForm) loginForm.classList.toggle("hidden", !isLogin);
    if (registerForm) registerForm.classList.toggle("hidden", isLogin);
  };

  if (new URLSearchParams(window.location.search).get("register") === "1") {
    setAuthMode("register");
  }

  authToggles.forEach(button => {
    button.addEventListener("click", () => {
      const mode = button.dataset.authToggle;
      setAuthMode(mode);
      document.querySelectorAll(".login-message").forEach(message => {
        message.textContent = "";
        message.className = "login-message";
      });
    });
  });

  if (loginForm) {
    loginForm.addEventListener("submit", async event => {
      event.preventDefault();

      const username = loginForm.elements.username.value.trim();
      const password = loginForm.elements.password.value;
      const message = document.querySelector("#loginMessage");

      if (!username || !password) {
        message.textContent = "Please enter your username and password.";
        message.className = "login-message error";
        return;
      }

      try {
        const result = await apiRequest("/api/login", {
          method: "POST",
          body: JSON.stringify({ username, password })
        });
        saveSession(result);
        const destination = sessionStorage.getItem("carWashNext") || (result.account.role === "admin" ? "dashboard.html" : "user-dashboard.html");
        sessionStorage.removeItem("carWashNext");
        window.location.href = destination;
      } catch (error) {
        const legacyAccount = readAccounts().find(account =>
          account.username === username && account.password === password && account.role !== "admin"
        );
        if (error.status === 401 && legacyAccount) {
          try {
            const result = await apiRequest("/api/register", {
              method: "POST",
              body: JSON.stringify({ username, password })
            });
            writeAccounts(readAccounts().filter(account => account.username !== username));
            saveSession(result);
            const destination = sessionStorage.getItem("carWashNext") || "user-dashboard.html";
            sessionStorage.removeItem("carWashNext");
            window.location.href = destination;
            return;
          } catch (migrationError) {
            message.textContent = migrationError.message;
            message.className = "login-message error";
            return;
          }
        }
        message.textContent = error.message;
        message.className = "login-message error";
      }
    });
  }

  if (registerForm) {
    registerForm.addEventListener("submit", async event => {
      event.preventDefault();

      const username = registerForm.elements.username.value.trim();
      const password = registerForm.elements.password.value;
      const confirmPassword = registerForm.elements.confirmPassword.value;
      const message = document.querySelector("#registerMessage");

      if (!username || !password || !confirmPassword) {
        message.textContent = "Please complete all fields.";
        message.className = "login-message error";
        return;
      }

      if (password.length < 6) {
        message.textContent = "Password must be at least 6 characters long.";
        message.className = "login-message error";
        return;
      }

      if (password !== confirmPassword) {
        message.textContent = "Passwords do not match.";
        message.className = "login-message error";
        return;
      }

      try {
        const result = await apiRequest("/api/register", {
          method: "POST",
          body: JSON.stringify({ username, password })
        });
        saveSession(result);
        const destination = sessionStorage.getItem("carWashNext") || "user-dashboard.html";
        sessionStorage.removeItem("carWashNext");
        window.location.href = destination;
      } catch (error) {
        message.textContent = error.message;
        message.className = "login-message error";
      }
    });
  }

  const logoutButton = document.querySelector("[data-logout]");
  if (logoutButton) {
    logoutButton.addEventListener("click", async () => {
      try {
        await apiRequest("/api/logout", { method: "POST" });
      } catch (error) {
        console.error("Could not end the server session:", error);
      }
      authStorageKeys.forEach(key => {
        localStorage.removeItem(key);
        clearAuthCookie(key);
      });
      window.location.href = "index.html";
    });
  }

  let appointments = [];
  const appointmentMessage = document.querySelector("#appointmentMessage");
  const setAppointmentMessage = (message, isError = false) => {
    if (!appointmentMessage) return;
    appointmentMessage.textContent = message;
    appointmentMessage.className = isError ? "login-message error" : "login-message success";
  };
  if (authCheckError) setAppointmentMessage(authCheckError, true);
  const renderAppointments = () => {
    const rows = document.querySelector("#appointmentRows");
    if (!rows) return;

    const isUserDashboard = current === "user-dashboard";
    const visibleAppointments = appointments;
    const emptyState = document.querySelector("#emptyAppointments");
    const count = document.querySelector("#appointmentCount");
    const now = new Date();
    const today = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
    const scheduled = appointments.filter(item => item.status === "Scheduled");
    const visibleScheduled = visibleAppointments.filter(item => item.status === "Scheduled");

    document.querySelector("#totalCount").textContent = isUserDashboard ? visibleAppointments.length : appointments.length;
    document.querySelector("#todayCount").textContent = isUserDashboard
      ? visibleAppointments.filter(item => item.date === today).length
      : appointments.filter(item => item.date === today).length;
    document.querySelector("#scheduledCount").textContent = isUserDashboard ? visibleScheduled.length : scheduled.length;
    count.textContent = `${visibleAppointments.length} appointment${visibleAppointments.length === 1 ? "" : "s"}`;
    if (emptyState) {
      emptyState.hidden = visibleAppointments.length > 0;
      emptyState.textContent = isUserDashboard ? "No appointments yet for your account." : "No appointments yet. Add the first one below.";
    }
    rows.innerHTML = visibleAppointments.map(item => {
      const statusCell = isUserDashboard
        ? `<span class="status-text">${escapeHtml(item.status)}</span>`
        : `<select class="status-select" data-status-id="${item.id}" aria-label="Status for ${escapeHtml(item.customer)}">
            <option${item.status === "Scheduled" ? " selected" : ""}>Scheduled</option>
            <option${item.status === "In progress" ? " selected" : ""}>In progress</option>
            <option${item.status === "Completed" ? " selected" : ""}>Completed</option>
            <option${item.status === "Cancelled" ? " selected" : ""}>Cancelled</option>
          </select>`;
      const actionCell = isUserDashboard
        ? (item.status === "Scheduled"
            ? `<button class="cancel-appointment" type="button" data-cancel-id="${item.id}" aria-label="Cancel appointment for ${escapeHtml(item.customer)}">Cancel appointment</button>`
            : "")
        : `<button class="remove-booking" type="button" data-remove-id="${item.id}" aria-label="Remove appointment for ${escapeHtml(item.customer)}">Remove</button>`;

      return `
        <tr>
          <td><strong>${escapeHtml(item.customer)}</strong><span>${escapeHtml(item.vehicle)}</span></td>
          <td>${escapeHtml(item.service)}</td>
          <td>${escapeHtml(item.location || "—")}</td>
          <td>${formatDate(item.date)}<span>${escapeHtml(item.time)}</span></td>
          <td>${statusCell}</td>
          <td>${actionCell}</td>
        </tr>`;
    }).join("");
  };

  const loadAppointments = async () => {
    appointments = await apiRequest("/api/appointments");
    renderAppointments();
  };

  const saveAppointment = async form => {
    const formData = new FormData(form);
    await apiRequest("/api/appointments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer: formData.get("customer").trim(),
        vehicle: formData.get("vehicle").trim(),
        service: formData.get("service"),
        location: formData.get("location").trim(),
        date: formData.get("date"),
        time: formData.get("time"),
      })
    });
  };

  const bookingForm = document.querySelector("#bookingForm");
  const appointmentForm = document.querySelector("#appointmentForm");
  [bookingForm, appointmentForm].filter(Boolean).forEach(form => {
    const serviceInput = form.elements.service;
    const requestedService = new URLSearchParams(window.location.search).get("service");
    if (requestedService && [...serviceInput.options].some(option => option.value === requestedService)) {
      serviceInput.value = requestedService;
    }
    if (form === appointmentForm) {
      const dateInput = form.elements.date;
      const now = new Date();
      dateInput.min = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
    }

    form.addEventListener("submit", async event => {
      event.preventDefault();
      setAppointmentMessage("");
      try {
        await saveAppointment(form);
        form.reset();
        if (form === appointmentForm) {
          document.querySelector("#appointmentConfirmation").hidden = false;
          document.querySelector("#appointmentConfirmation").focus();
        } else {
          await loadAppointments();
          setAppointmentMessage("Appointment saved.");
        }
      } catch (error) {
        setAppointmentMessage(error.message, true);
      }
    });
  });

  const appointmentRows = document.querySelector("#appointmentRows");
  if (appointmentRows) {
    appointmentRows.addEventListener("change", async event => {
      if (currentRole !== "admin" || !event.target.matches("[data-status-id]")) return;
      const id = Number(event.target.dataset.statusId);
      try {
        await apiRequest(`/api/appointments/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: event.target.value })
        });
        await loadAppointments();
      } catch (error) {
        setAppointmentMessage(error.message, true);
      }
    });

    appointmentRows.addEventListener("click", async event => {
      const cancelButton = event.target.closest("[data-cancel-id]");
      const removeButton = event.target.closest("[data-remove-id]");
      const button = cancelButton || removeButton;
      if (!button) return;

      const id = Number(button.dataset.cancelId || button.dataset.removeId);
      const appointment = appointments.find(item => item.id === id);
      if (cancelButton && (current !== "user-dashboard" || !appointment || appointment.status !== "Scheduled")) return;
      if (removeButton && currentRole !== "admin") return;

      try {
        if (cancelButton) {
          await apiRequest(`/api/appointments/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "Cancelled" })
          });
        } else {
          await apiRequest(`/api/appointments/${id}`, { method: "DELETE" });
        }
        await loadAppointments();
      } catch (error) {
        setAppointmentMessage(error.message, true);
      }
    });

    loadAppointments().catch(error => setAppointmentMessage(error.message, true));
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function formatDate(value) {
    return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
      month: "short", day: "numeric", year: "numeric"
    });
  }
});
