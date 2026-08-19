"use strict";

const elements = {
  accounts: document.querySelector("#accounts"),
  accountCount: document.querySelector("#account-count"),
  connectionStatus: document.querySelector("#connection-status"),
  empty: document.querySelector("#empty"),
  loading: document.querySelector("#loading"),
  refresh: document.querySelector("#refresh"),
  search: document.querySelector("#search"),
  securityBanner: document.querySelector("#security-banner"),
  toast: document.querySelector("#toast")
};

let allAccounts = [];
let toastTimer = null;

function normalized(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function formatUpdatedAt(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(timestamp));
}

function freshnessBadge(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const ageMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (ageMinutes < 5) return { text: "dados recentes", kind: "ok" };
  if (ageMinutes < 60) return { text: "dados " + ageMinutes + "min", kind: "ok" };
  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 24) return { text: "dados " + ageHours + "h", kind: "ok" };
  return { text: "dados " + Math.floor(ageHours / 24) + "d", kind: "warning" };
}

function initials(value) {
  const words = String(value || "?").trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "?";
}

function hostname(account) {
  if (account.tool?.hostname) return account.tool.hostname;
  const value = account.tool?.baseUrl || account.tool?.loginUrl;
  if (!value) return "URL não configurada";
  try {
    return new URL(value).hostname;
  } catch {
    return "URL inválida";
  }
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

function showToast(message, type = "success") {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = "toast" + (type === "error" ? " error" : "");
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 5200);
}

function setCardBusy(card, account, busy) {
  for (const candidate of card.querySelectorAll("button[data-account-action]")) {
    candidate.disabled = busy || !canOpen(account);
  }
}

async function openAccount(account, button, card) {
  const originalLabel = button.textContent;
  setCardBusy(card, account, true);
  button.classList.add("loading");
  button.textContent = "Preparando sessão...";

  try {
    const result = await window.accountPanel.openAccount(account.id);
    if (result.loginDetected) {
      const savedAt = formatUpdatedAt(result.sessionUpdatedAt);
      showToast(
        "O site abriu na tela de login." +
          (savedAt ? " O bundle usado foi salvo em " + savedAt + "." : "") +
          " Use “Reiniciar acesso” para consultar novamente.",
        "error"
      );
    } else if (result.reused) {
      showToast("A janela dessa conta já estava aberta e foi trazida para frente.");
    } else if (result.navigationWarning) {
      showToast(
        "A janela foi aberta, mas o site não concluiu o carregamento. Confira a janela do Chrome.",
        "error"
      );
    } else {
      const skipped = result.cookiesSkipped > 0
        ? " " + result.cookiesSkipped + " cookie(s) inválido(s) foram ignorados."
        : "";
      showToast("Conta aberta em uma janela isolada do Chrome." + skipped);
    }
  } catch (error) {
    showToast(error.message || "Não foi possível abrir a conta.", "error");
  } finally {
    button.classList.remove("loading");
    button.textContent = originalLabel;
    setCardBusy(card, account, false);
  }
}

async function restartAccount(account, button, card) {
  const originalLabel = button.textContent;
  setCardBusy(card, account, true);
  button.classList.add("loading");
  button.textContent = "Reiniciando...";

  try {
    const previousUpdatedAt = account.updatedAt || null;
    const result = await window.accountPanel.restartAccount(account.id);
    const databaseChanged = Boolean(
      result.sessionUpdatedAt && result.sessionUpdatedAt !== previousUpdatedAt
    );
    if (result.sessionUpdatedAt) account.updatedAt = result.sessionUpdatedAt;
    if (result.loginDetected) {
      const savedAt = formatUpdatedAt(result.sessionUpdatedAt);
      showToast(
        databaseChanged
          ? "O banco forneceu um bundle novo, mas o site ainda o recusou. Os cookies ou tokens também podem estar expirados ou revogados."
          : "A consulta foi feita novamente, mas o banco ainda contém o mesmo bundle" +
              (savedAt ? " de " + savedAt : "") +
              ". Um worker precisa renovar a sessão.",
        "error"
      );
    } else if (result.navigationWarning) {
      showToast(
        "A sessão foi recriada, mas o site não concluiu o carregamento.",
        "error"
      );
    } else {
      showToast(
        databaseChanged
          ? "Sessão reiniciada com um bundle novo do Supabase."
          : "Acesso reaberto com o mesmo bundle que já estava salvo no banco."
      );
    }
  } catch (error) {
    showToast(error.message || "Não foi possível reiniciar a sessão.", "error");
  } finally {
    button.classList.remove("loading");
    button.textContent = originalLabel;
    setCardBusy(card, account, false);
  }
}

function canOpen(account) {
  return account.canOpen === true;
}

function createCard(account) {
  const card = element("article", "account-card");
  const head = element("div", "account-head");
  const avatar = element("div", "tool-avatar", initials(account.tool?.name));
  avatar.setAttribute("aria-hidden", "true");

  const title = element("div", "account-title");
  title.append(
    element("h4", "", account.accountName),
    element("p", "", account.tool?.name || "Ferramenta não vinculada")
  );
  head.append(avatar, title);

  const badges = element("div", "badges");
  badges.append(
    badge(account.loginMethod || "sem método", account.loginMethod === "cookie" ? "ok" : "warning"),
    badge(account.isActive ? "ativa" : "inativa", account.isActive ? "ok" : "warning")
  );
  if (account.tool?.inMaintenance) badges.append(badge("manutenção", "warning"));
  if (account.tool && !account.tool.isActive) badges.append(badge("ferramenta inativa", "warning"));
  const freshness = freshnessBadge(account.updatedAt);
  if (freshness) badges.append(badge(freshness.text, freshness.kind));

  const domain = element("span", "domain", hostname(account));
  const button = element("button", "open-button", canOpen(account) ? "Entrar nesta conta" : "Acesso indisponível");
  button.type = "button";
  button.dataset.accountAction = "open";
  button.disabled = !canOpen(account);
  button.addEventListener("click", () => openAccount(account, button, card));

  const restartButton = element("button", "restart-button", "Reiniciar acesso");
  restartButton.type = "button";
  restartButton.dataset.accountAction = "restart";
  restartButton.disabled = !canOpen(account);
  restartButton.title = "Fecha a janela desta conta e reaplica os dados mais recentes";
  restartButton.addEventListener("click", () =>
    restartAccount(account, restartButton, card)
  );

  const actions = element("div", "account-actions");
  actions.append(button, restartButton);

  card.append(head, badges, domain, actions);
  return card;
}

function render() {
  const query = normalized(elements.search.value);
  const accounts = allAccounts.filter((account) => {
    const haystack = normalized(
      [account.accountName, account.tool?.name, account.workerTag, hostname(account)].join(" ")
    );
    return haystack.includes(query);
  });

  elements.accounts.replaceChildren(...accounts.map(createCard));
  elements.accounts.hidden = accounts.length === 0;
  elements.empty.hidden = accounts.length !== 0;
}

async function loadAccounts() {
  elements.refresh.disabled = true;
  elements.loading.hidden = false;
  elements.accounts.hidden = true;
  elements.empty.hidden = true;
  elements.connectionStatus.textContent = "Conectando...";

  try {
    const result = await window.accountPanel.listAccounts();
    allAccounts = result.accounts;
    elements.accountCount.textContent = String(allAccounts.length);
    elements.connectionStatus.textContent =
      (result.connection.authenticated ? "Sessão autenticada" : "Acesso anônimo") +
      " · configuração: " +
      result.connection.source;
    elements.securityBanner.hidden = result.connection.authenticated;
    render();
  } catch (error) {
    allAccounts = [];
    elements.accountCount.textContent = "0";
    elements.connectionStatus.textContent = "Falha na conexão";
    elements.empty.hidden = false;
    showToast(error.message || "Não foi possível carregar as contas.", "error");
  } finally {
    elements.loading.hidden = true;
    elements.refresh.disabled = false;
  }
}

elements.search.addEventListener("input", render);
elements.refresh.addEventListener("click", loadAccounts);
loadAccounts();
