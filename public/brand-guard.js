"use strict";

function sanitizeConnectionStatus() {
  const status = document.querySelector("#connection-status");
  if (!status) return;
  const text = String(status.textContent || "").trim();
  if (text.includes("@") || /^Sessão autenticada/i.test(text)) {
    status.textContent = "Conectado";
  }
}

function hideAccountIdentity() {
  const userArea = document.querySelector(".user-area");
  const userEmail = document.querySelector("#user-email");
  const logout = document.querySelector("#logout");
  if (userArea) userArea.hidden = true;
  if (userEmail) {
    userEmail.textContent = "";
    userEmail.hidden = true;
  }
  if (logout) logout.hidden = true;
}

hideAccountIdentity();
sanitizeConnectionStatus();

const connectionStatus = document.querySelector("#connection-status");
if (connectionStatus) {
  new MutationObserver(sanitizeConnectionStatus).observe(connectionStatus, {
    childList: true,
    characterData: true,
    subtree: true
  });
}

const userEmail = document.querySelector("#user-email");
if (userEmail) {
  new MutationObserver(hideAccountIdentity).observe(userEmail, {
    childList: true,
    characterData: true,
    subtree: true
  });
}
