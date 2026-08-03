(() => {
  const API_BASE_URL = ["localhost", "127.0.0.1"].includes(window.location.hostname)
    ? "http://localhost:8080"
    : "";

  const loginForm = document.getElementById("login-form");
  const signupForm = document.getElementById("signup-form");
  const loginEmailInput = document.getElementById("login-email");
  const signupEmailInput = document.getElementById("signup-email");
  const showSignupButton = document.getElementById("show-signup");
  const showLoginButton = document.getElementById("show-login");
  const loginSubmitButton = document.getElementById("login-submit");
  const signupSubmitButton = document.getElementById("signup-submit");
  const errorDialog = document.getElementById("error-dialog");
  const errorMessage = document.getElementById("error-message");
  const errorConfirmButton = document.getElementById("error-confirm");
  const signupSuccessDialog = document.getElementById("signup-success-dialog");
  const signupSuccessConfirmButton = document.getElementById("signup-success-confirm");

  let previouslyFocusedElement = null;
  let pendingSignupEmail = "";

  const setView = (view) => {
    const showLogin = view === "login";

    loginForm.hidden = !showLogin;
    signupForm.hidden = showLogin;
    document.title = showLogin ? "TGG Chat | 로그인" : "TGG Chat | 회원가입";

    if (showLogin) {
      loginEmailInput.focus();
    } else {
      signupEmailInput.focus();
    }
  };

  const setSubmitting = (button, submitting, activeLabel) => {
    if (!button.dataset.defaultLabel) {
      button.dataset.defaultLabel = button.textContent;
    }

    button.disabled = submitting;
    button.textContent = submitting ? activeLabel : button.dataset.defaultLabel;
  };

  const showError = (message) => {
    previouslyFocusedElement = document.activeElement;
    errorMessage.textContent = message;
    errorDialog.hidden = false;
    errorConfirmButton.focus();
  };

  const closeError = () => {
    errorDialog.hidden = true;

    if (previouslyFocusedElement instanceof HTMLElement) {
      previouslyFocusedElement.focus();
    }
  };

  const showSignupSuccess = (email) => {
    pendingSignupEmail = email;
    signupSuccessDialog.hidden = false;
    signupSuccessConfirmButton.focus();
  };

  const confirmSignupSuccess = () => {
    signupSuccessDialog.hidden = true;
    loginEmailInput.value = pendingSignupEmail;
    pendingSignupEmail = "";
    signupForm.reset();
    setView("login");
  };

  const request = async (path, options) => {
    let response;

    try {
      response = await fetch(`${API_BASE_URL}${path}`, {
        ...options,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...options.headers
        }
      });
    } catch {
      throw new Error("서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.");
    }

    const isJson = response.headers.get("content-type")?.includes("application/json");
    const responseBody = isJson ? await response.json() : null;

    if (!response.ok) {
      throw new Error(responseBody?.message || "요청을 처리하는 중 오류가 발생했습니다.");
    }

    return responseBody;
  };

  showSignupButton.addEventListener("click", () => {
    signupForm.reset();
    signupEmailInput.value = loginEmailInput.value.trim();
    setView("signup");
  });

  showLoginButton.addEventListener("click", () => {
    setView("login");
  });

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const formData = new FormData(loginForm);
    const requestBody = {
      email: formData.get("email").trim(),
      password: formData.get("password")
    };

    setSubmitting(loginSubmitButton, true, "로그인 중");

    try {
      const responseBody = await request("/login", {
        method: "POST",
        body: JSON.stringify(requestBody)
      });

      sessionStorage.setItem("accessToken", responseBody.accessToken);
      window.location.replace("chat.html");
    } catch (error) {
      showError(error.message);
    } finally {
      setSubmitting(loginSubmitButton, false, "로그인 중");
    }
  });

  signupForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const formData = new FormData(signupForm);
    const requestBody = {
      email: formData.get("email").trim(),
      password: formData.get("password"),
      username: formData.get("username").trim()
    };

    setSubmitting(signupSubmitButton, true, "가입 중");

    try {
      await request("/user", {
        method: "POST",
        body: JSON.stringify(requestBody)
      });
      showSignupSuccess(requestBody.email);
    } catch (error) {
      showError(error.message);
    } finally {
      setSubmitting(signupSubmitButton, false, "가입 중");
    }
  });

  errorConfirmButton.addEventListener("click", closeError);
  signupSuccessConfirmButton.addEventListener("click", confirmSignupSuccess);

  errorDialog.addEventListener("click", (event) => {
    if (event.target === errorDialog) {
      closeError();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !errorDialog.hidden) {
      closeError();
    }
  });
})();