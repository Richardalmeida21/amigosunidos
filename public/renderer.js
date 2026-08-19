"use strict";

const POLL_INTERVAL_MS = 10_000;
const REPORT_COOLDOWN_MS = 10 * 60_000;
const REPORT_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const elements = {
  appView: document.querySelector("#app-view"),
  authView: document.querySelector("#auth-view"),
  connectionStatus: document.querySelector("#connection-status"),
  empty: document.querySelector("#empty"),
  loading: document.querySelector("#loading"),
  loginEmail: document.querySelector("#login-email"),
  loginError: document.querySelector("#login-error"),
  loginForm: document.querySelector("#login-form"),
  loginPassword: document.querySelector("#login-password"),
  loginSubmit: document.querySelector("#login-submit"),
  logout: document.querySelector("#logout"),
  maintenanceBanner: document.querySelector("#maintenance-banner"),
  maintenanceSummary: document.querySelector("#maintenance-summary"),
  refresh: document.querySelector("#refresh"),
  reportBackdrop: document.querySelector("#report-backdrop"),
  reportCancel: document.querySelector("#report-cancel"),
  reportClose: document.querySelector("#report-close"),
  reportCode: document.querySelector("#report-code"),
  reportConfirmation: document.querySelector("#report-confirmation"),
  reportDialog: document.querySelector("#report-dialog"),
  reportSubmit: document.querySelector("#report-submit"),
  reportToolName: document.querySelector("#report-tool-name"),
  search: document.querySelector("#search"),
  toast: document.querySelector("#toast"),
  toolCount: document.querySelector("#tool-count"),
  tools: document.querySelector("#tools"),
  userEmail: document.querySelector("#user-email")
};

const state = {
  authenticated: false,
  busyActions: new Map(),
  cooldowns: new Map(),
  currentUser: null,
  maintenanceIds: new Set(),
  recoveredIds: new Set(),
  reportCode: "",
  reportSubmitting: false,
  reportTool: null,
  reportTrigger: null,
  tools: []
};

let cooldownTimer = null;
let pollInFlight = false;
let pollTimer = null;
let toastTimer = null;

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function badge(text, kind) {
  return element("span", "badge" + (kind ? " " + kind : ""), text);
}

function initials(value) {
  const words = String(value || "?").trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "?";
}

function safeHostname(value) {
  const raw = String(value || "").trim();
  if (!raw) return "Domínio não informado";

  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname || "Domínio não informado";
  } catch {
    return "Domínio não informado";
  }
}

function normalizeTool(rawTool) {
  const raw = rawTool && typeof rawTool === "object" ? rawTool : {};
  const id = String(raw.id || raw.toolId || raw.tool_id || "");
  const isActive = Boolean(raw.isActive ?? raw.is_active ?? true);
  const inMaintenance = Boolean(raw.inMaintenance ?? raw.is_in_maintenance ?? false);

  return {
    id,
    name: String(raw.name || raw.toolName || raw.tool_name || "Ferramenta"),
    hostname: safeHostname(raw.hostname || raw.domain || raw.baseUrl || raw.base_url),
    category: String(raw.category || "Geral"),
    isActive,
    inMaintenance,
    canOpen: Boolean(raw.canOpen ?? raw.can_open ?? (isActive && !inMaintenance))
  };
}

function showToast(message, type = "success") {
  clearTimeout(toastTimer);
  elements.toast.textContent = String(message || "");
  elements.toast.className = "toast" + (type === "error" ? " error" : "");
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 5_200);
}

function showLoginError(message) {
  elements.loginError.textContent = String(message || "");
  elements.loginError.hidden = !message;
}

function isAuthenticationError(error) {
  const code = String(error?.code || "").toUpperCase();
  return [
    "AUTH_REQUIRED",
    "AUTH_EXPIRED",
    "UNAUTHENTICATED",
    "NOT_AUTHENTICATED",
    "SESSION_EXPIRED",
    "GATEWAY_HTTP_401",
    "GATEWAY_HTTP_403"
  ].includes(code);
}

function stopPolling() {
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = null;
  pollInFlight = false;
}

function syncPolling() {
  if (!state.authenticated || state.maintenanceIds.size === 0) {
    stopPolling();
    return;
  }

  if (pollTimer === null) {
    pollTimer = setInterval(pollMaintenance, POLL_INTERVAL_MS);
  }
}

function updateMaintenanceBanner() {
  const count = state.maintenanceIds.size;
  elements.maintenanceBanner.hidden = count === 0;
  if (count > 0) {
    elements.maintenanceSummary.textContent =
      `${count} ferramenta${count === 1 ? " está" : "s estão"} em manutenção. ` +
      "O painel verificará novamente a cada 10 segundos.";
  }
}

function applyMaintenanceIds(values, { announceRecovery = false } = {}) {
  const nextIds = new Set(
    Array.isArray(values) ? values.map((value) => String(value || "")).filter(Boolean) : []
  );
  const recovered = [...state.maintenanceIds].filter((id) => !nextIds.has(id));

  state.maintenanceIds = nextIds;
  for (const tool of state.tools) {
    if (nextIds.has(tool.id)) {
      tool.inMaintenance = true;
      tool.canOpen = false;
      state.recoveredIds.delete(tool.id);
    } else if (recovered.includes(tool.id)) {
      tool.inMaintenance = false;
      tool.canOpen = tool.isActive;
      state.recoveredIds.add(tool.id);
    }
  }

  updateMaintenanceBanner();
  renderTools();
  syncPolling();

  if (announceRecovery && recovered.length > 0) {
    const names = recovered
      .map((id) => state.tools.find((tool) => tool.id === id)?.name)
      .filter(Boolean);
    const description = names.length === 1 ? names[0] : `${recovered.length} ferramentas`;
    showToast(`${description} pronta${names.length === 1 ? "" : "s"} para reabrir. Clique em “Reabrir”.`);
  }
}

function showLogin(status = {}) {
  state.authenticated = false;
  state.currentUser = null;
  state.tools = [];
  state.maintenanceIds.clear();
  state.recoveredIds.clear();
  state.busyActions.clear();
  stopPolling();
  closeReport({ force: true, restoreFocus: false });

  elements.appView.hidden = true;
  elements.authView.hidden = false;
  elements.loginPassword.value = "";
  elements.userEmail.textContent = "";

  if (status.preferredEmail && !elements.loginEmail.value) {
    elements.loginEmail.value = String(status.preferredEmail);
  }

  requestAnimationFrame(() => {
    (elements.loginEmail.value ? elements.loginPassword : elements.loginEmail).focus();
  });
}

function showPanel(status) {
  state.authenticated = true;
  state.currentUser = status?.user || null;
  elements.userEmail.textContent = String(state.currentUser?.email || "Sessão autenticada");
  elements.authView.hidden = true;
  elements.appView.hidden = false;
  showLoginError("");
}

function canUseTool(tool) {
  return tool.isActive && !tool.inMaintenance && tool.canOpen;
}

function cooldownRemaining(toolId) {
  const deadline = state.cooldowns.get(toolId) || 0;
  return Math.max(0, deadline - Date.now());
}

function formatCountdown(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function normalizeCooldownDeadline(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1_000;
    if (milliseconds > Date.now()) return milliseconds;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > Date.now()
    ? parsed
    : Date.now() + REPORT_COOLDOWN_MS;
}

function syncCooldownTimer() {
  const hasActiveCooldown = [...state.cooldowns.values()].some((deadline) => deadline > Date.now());
  if (!hasActiveCooldown) {
    if (cooldownTimer !== null) clearInterval(cooldownTimer);
    cooldownTimer = null;
    return;
  }

  if (cooldownTimer === null) {
    cooldownTimer = setInterval(updateCooldownButtons, 1_000);
  }
}

function updateCooldownButtons() {
  let expired = false;
  for (const [toolId, deadline] of state.cooldowns) {
    if (deadline <= Date.now()) {
      state.cooldowns.delete(toolId);
      expired = true;
    }
  }

  if (expired) {
    renderTools();
  } else {
    for (const button of elements.tools.querySelectorAll("button[data-report-tool-id]")) {
      const remaining = cooldownRemaining(button.dataset.reportToolId);
      if (remaining > 0) button.textContent = `Aguarde ${formatCountdown(remaining)}`;
    }
  }
  syncCooldownTimer();
}

function createToolCard(tool) {
  const card = element("article", "account-card");
  if (tool.inMaintenance) card.classList.add("maintenance-card");

  const head = element("div", "account-head");
  const avatar = element("div", "tool-avatar", initials(tool.name));
  avatar.setAttribute("aria-hidden", "true");
  const title = element("div", "account-title");
  title.append(element("h4", "", tool.name), element("p", "", tool.category));
  head.append(avatar, title);

  const badges = element("div", "badges");
  badges.append(badge(tool.category, ""));
  badges.append(badge(tool.isActive ? "ativa" : "inativa", tool.isActive ? "ok" : "warning"));
  if (tool.inMaintenance) badges.append(badge("manutenção", "warning"));
  if (state.recoveredIds.has(tool.id)) badges.append(badge("pronta", "ok"));

  const domain = element("span", "domain", tool.hostname);
  const busyAction = state.busyActions.get(tool.id);
  const usable = canUseTool(tool) && !busyAction;

  let openLabel = state.recoveredIds.has(tool.id) ? "Reabrir ferramenta" : "Entrar na ferramenta";
  if (tool.inMaintenance) openLabel = "Login automático em andamento";
  else if (!canUseTool(tool)) openLabel = "Acesso indisponível";
  else if (busyAction === "open") openLabel = "Preparando sessão...";

  const openButton = element("button", "open-button", openLabel);
  openButton.type = "button";
  openButton.dataset.toolAction = "open";
  openButton.disabled = !usable;
  if (busyAction === "open") openButton.classList.add("loading");
  openButton.addEventListener("click", () => runToolAction(tool, "open"));

  const restartButton = element(
    "button",
    "restart-button",
    busyAction === "restart" ? "Reiniciando..." : "Reiniciar acesso"
  );
  restartButton.type = "button";
  restartButton.dataset.toolAction = "restart";
  restartButton.disabled = !usable;
  restartButton.title = "Fecha a janela desta ferramenta e solicita novamente a sessão";
  if (busyAction === "restart") restartButton.classList.add("loading");
  restartButton.addEventListener("click", () => runToolAction(tool, "restart"));

  const remaining = cooldownRemaining(tool.id);
  const reportButton = element(
    "button",
    "report-button",
    remaining > 0 ? `Aguarde ${formatCountdown(remaining)}` : "Reportar deslogada"
  );
  reportButton.type = "button";
  reportButton.dataset.reportToolId = tool.id;
  reportButton.disabled = !canUseTool(tool) || remaining > 0 || Boolean(busyAction);
  reportButton.addEventListener("click", () => openReport(tool, reportButton));

  const actions = element("div", "account-actions");
  actions.append(openButton, restartButton, reportButton);
  card.append(head, badges, domain, actions);
  return card;
}

function renderTools() {
  const query = normalizeText(elements.search.value);
  const filtered = state.tools.filter((tool) =>
    normalizeText([tool.name, tool.hostname, tool.category].join(" ")).includes(query)
  );

  elements.tools.replaceChildren(...filtered.map(createToolCard));
  elements.tools.hidden = filtered.length === 0;
  elements.empty.hidden = filtered.length !== 0;
  syncCooldownTimer();
}

async function runToolAction(tool, action) {
  if (!canUseTool(tool) || state.busyActions.has(tool.id)) return;
  state.busyActions.set(tool.id, action);
  renderTools();

  try {
    const result = action === "restart"
      ? await window.accountPanel.restartTool(tool.id)
      : await window.accountPanel.openTool(tool.id);

    if (result.loginDetected) {
      showToast(
        "A ferramenta abriu na tela de login. Se a sessão realmente estiver deslogada, use “Reportar deslogada” no cartão.",
        "error"
      );
    } else if (result.reused) {
      showToast("A janela já estava aberta e foi trazida para frente.");
    } else if (result.navigationWarning) {
      showToast("A janela abriu, mas o carregamento não foi concluído. Confira o navegador.", "error");
    } else {
      const skipped = Number(result.cookiesSkipped || 0);
      showToast(
        action === "restart"
          ? "Acesso reiniciado com a sessão mais recente."
          : "Ferramenta aberta em uma janela isolada." +
              (skipped > 0 ? ` ${skipped} cookie(s) inválido(s) foram ignorados.` : "")
      );
      state.recoveredIds.delete(tool.id);
    }
  } catch (error) {
    if (isAuthenticationError(error)) {
      showLogin();
      showLoginError("Sua sessão expirou. Entre novamente.");
    } else {
      showToast(error.message || "Não foi possível abrir a ferramenta.", "error");
    }
  } finally {
    state.busyActions.delete(tool.id);
    renderTools();
  }
}

function generateReportCode() {
  const values = new Uint32Array(4);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(values);
  } else {
    for (let index = 0; index < values.length; index += 1) {
      values[index] = Math.floor(Math.random() * 0xffffffff);
    }
  }

  return [...values]
    .map((value) => REPORT_CODE_ALPHABET[value % REPORT_CODE_ALPHABET.length])
    .join("");
}

function updateReportConfirmation() {
  const typed = elements.reportConfirmation.value.toUpperCase();
  elements.reportSubmit.disabled = state.reportSubmitting || typed !== state.reportCode;
}

function openReport(tool, trigger) {
  if (!tool.isActive || tool.inMaintenance || cooldownRemaining(tool.id) > 0) return;
  state.reportTool = tool;
  state.reportTrigger = trigger;
  state.reportCode = generateReportCode();
  state.reportSubmitting = false;

  elements.reportToolName.textContent = tool.name;
  elements.reportCode.textContent = state.reportCode;
  elements.reportConfirmation.value = "";
  elements.reportConfirmation.disabled = false;
  elements.reportSubmit.textContent = "Confirmar reporte";
  elements.reportSubmit.disabled = true;
  elements.reportClose.disabled = false;
  elements.reportCancel.disabled = false;
  elements.reportBackdrop.hidden = false;
  document.body.classList.add("modal-open");
  requestAnimationFrame(() => elements.reportConfirmation.focus());
}

function closeReport({ force = false, restoreFocus = true } = {}) {
  if (state.reportSubmitting && !force) return;
  const trigger = state.reportTrigger;
  state.reportTool = null;
  state.reportTrigger = null;
  state.reportCode = "";
  state.reportSubmitting = false;
  elements.reportConfirmation.value = "";
  elements.reportCode.textContent = "";
  elements.reportBackdrop.hidden = true;
  document.body.classList.remove("modal-open");
  if (restoreFocus && trigger?.isConnected) trigger.focus();
}

async function submitReport() {
  const tool = state.reportTool;
  const confirmationWord = state.reportCode;
  if (!tool || state.reportSubmitting) return;
  if (elements.reportConfirmation.value.toUpperCase() !== confirmationWord) return;

  state.reportSubmitting = true;
  elements.reportConfirmation.value = "";
  elements.reportConfirmation.disabled = true;
  elements.reportSubmit.disabled = true;
  elements.reportSubmit.textContent = "Enviando...";
  elements.reportCancel.disabled = true;
  elements.reportClose.disabled = true;

  try {
    const result = await window.accountPanel.reportTool({
      toolId: tool.id,
      confirmationWord
    });
    if (result?.success !== true) throw new Error("O reporte não foi confirmado pelo serviço.");

    state.cooldowns.set(tool.id, normalizeCooldownDeadline(result.cooldownUntil));
    const nextMaintenanceIds = new Set(state.maintenanceIds);
    if (result.maintenance !== false) nextMaintenanceIds.add(tool.id);
    applyMaintenanceIds([...nextMaintenanceIds]);
    closeReport({ force: true, restoreFocus: false });
    showToast("Reporte enviado. O login automático será acompanhado a cada 10 segundos.");
  } catch (error) {
    if (isAuthenticationError(error)) {
      closeReport({ force: true, restoreFocus: false });
      showLogin();
      showLoginError("Sua sessão expirou. Entre novamente.");
    } else {
      showToast(error.message || "Não foi possível reportar a ferramenta.", "error");
      state.reportSubmitting = false;
      elements.reportConfirmation.disabled = false;
      elements.reportSubmit.textContent = "Confirmar reporte";
      elements.reportCancel.disabled = false;
      elements.reportClose.disabled = false;
      updateReportConfirmation();
      elements.reportConfirmation.focus();
    }
  }
}

async function pollMaintenance() {
  if (pollInFlight || !state.authenticated || state.maintenanceIds.size === 0) return;
  pollInFlight = true;

  try {
    const result = await window.accountPanel.pollTools();
    const maintenanceIds = Array.isArray(result)
      ? result
      : result?.maintenanceIds;
    if (Array.isArray(maintenanceIds)) {
      applyMaintenanceIds(maintenanceIds, { announceRecovery: true });
    }
    if (result?.toolsChanged) await loadTools({ background: true });
  } catch (error) {
    if (isAuthenticationError(error)) {
      showLogin();
      showLoginError("Sua sessão expirou. Entre novamente.");
    }
  } finally {
    pollInFlight = false;
  }
}

async function loadTools({ background = false } = {}) {
  if (!background) {
    elements.refresh.disabled = true;
    elements.loading.hidden = false;
    elements.tools.hidden = true;
    elements.empty.hidden = true;
    elements.connectionStatus.textContent = "Carregando...";
  }

  try {
    const result = await window.accountPanel.listTools();
    const rawTools = Array.isArray(result) ? result : result?.tools;
    state.tools = (Array.isArray(rawTools) ? rawTools : [])
      .map(normalizeTool)
      .filter((tool) => tool.id);

    const maintenanceIds = Array.isArray(result?.maintenanceIds)
      ? result.maintenanceIds
      : state.tools.filter((tool) => tool.inMaintenance).map((tool) => tool.id);
    applyMaintenanceIds(maintenanceIds);

    elements.toolCount.textContent = String(state.tools.length);
    elements.connectionStatus.textContent = state.currentUser?.email
      ? `Sessão autenticada · ${state.currentUser.email}`
      : "Sessão autenticada";
    renderTools();
  } catch (error) {
    state.tools = [];
    elements.toolCount.textContent = "0";
    if (isAuthenticationError(error)) {
      showLogin();
      showLoginError("Sua sessão expirou. Entre novamente.");
    } else if (!background) {
      elements.connectionStatus.textContent = "Falha na conexão";
      elements.empty.hidden = false;
      showToast(error.message || "Não foi possível carregar as ferramentas.", "error");
    }
  } finally {
    if (!background) {
      elements.loading.hidden = true;
      elements.refresh.disabled = false;
    }
  }
}

function setLoginBusy(busy) {
  elements.loginEmail.disabled = busy;
  elements.loginPassword.disabled = busy;
  elements.loginSubmit.disabled = busy;
  elements.loginSubmit.classList.toggle("loading", busy);
  elements.loginSubmit.textContent = busy ? "Entrando..." : "Entrar";
}

async function submitLogin(event) {
  event.preventDefault();
  const email = elements.loginEmail.value.trim();
  const password = elements.loginPassword.value;
  elements.loginPassword.value = "";
  showLoginError("");

  if (!email || !password) {
    showLoginError("Informe o e-mail e a senha.");
    elements.loginPassword.focus();
    return;
  }

  setLoginBusy(true);
  try {
    const status = await window.accountPanel.login({ email, password });
    if (status?.authenticated !== true) throw new Error("O serviço não confirmou a autenticação.");
    showPanel(status);
    await loadTools();
  } catch (error) {
    showLoginError(error.message || "Não foi possível entrar. Confira os dados e tente novamente.");
    elements.loginPassword.focus();
  } finally {
    elements.loginPassword.value = "";
    setLoginBusy(false);
  }
}

async function logout() {
  elements.logout.disabled = true;
  try {
    const status = await window.accountPanel.logout();
    showLogin(status || {});
    showToast("Sessão encerrada.");
  } catch (error) {
    showToast(error.message || "Não foi possível encerrar a sessão.", "error");
  } finally {
    elements.logout.disabled = false;
  }
}

function handleDialogKeydown(event) {
  if (elements.reportBackdrop.hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeReport();
    return;
  }

  if (event.key !== "Tab") return;
  const focusable = [...elements.reportDialog.querySelectorAll("button:not(:disabled), input:not(:disabled)")];
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function initialize() {
  try {
    const status = await window.accountPanel.getAuthStatus();
    if (status?.preferredEmail) elements.loginEmail.value = String(status.preferredEmail);
    if (status?.authenticated) {
      showPanel(status);
      await loadTools();
    } else {
      showLogin(status || {});
    }
  } catch (error) {
    showLogin();
    showLoginError(error.message || "Não foi possível verificar a autenticação.");
  }
}

elements.loginForm.addEventListener("submit", submitLogin);
elements.logout.addEventListener("click", logout);
elements.search.addEventListener("input", renderTools);
elements.refresh.addEventListener("click", () => loadTools());
elements.reportConfirmation.addEventListener("input", () => {
  elements.reportConfirmation.value = elements.reportConfirmation.value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 4);
  updateReportConfirmation();
});
elements.reportConfirmation.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !elements.reportSubmit.disabled) submitReport();
});
elements.reportSubmit.addEventListener("click", submitReport);
elements.reportCancel.addEventListener("click", () => closeReport());
elements.reportClose.addEventListener("click", () => closeReport());
elements.reportBackdrop.addEventListener("click", (event) => {
  if (event.target === elements.reportBackdrop) closeReport();
});
document.addEventListener("keydown", handleDialogKeydown);
window.addEventListener("beforeunload", () => {
  elements.loginPassword.value = "";
  stopPolling();
  if (cooldownTimer !== null) clearInterval(cooldownTimer);
});

initialize();
