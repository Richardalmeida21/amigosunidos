"use strict";

const FAVORITES_STORAGE_KEY = "amigos-do-rich:favorites:v1";
const toolsContainer = document.querySelector("#tools");
const emptyState = document.querySelector("#empty");
const emptyTitle = emptyState?.querySelector("h3") || null;
const emptyDescription = emptyState?.querySelector("p") || null;
const allTab = document.querySelector("#tab-all");
const favoritesTab = document.querySelector("#tab-favorites");

let activeFilter = "all";
let favoriteIds = loadFavorites();

function loadFavorites() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

function saveFavorites() {
  try {
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([...favoriteIds]));
  } catch {
    // Favoritos continuam funcionando durante a sessão mesmo sem persistência.
  }
}

function cardToolId(card) {
  return String(card?.querySelector("[data-report-tool-id]")?.dataset?.reportToolId || "");
}

function updateFavoriteButton(button, toolId) {
  const isFavorite = favoriteIds.has(toolId);
  const nextText = isFavorite ? "★" : "☆";
  if (button.textContent !== nextText) button.textContent = nextText;
  button.classList.toggle("active", isFavorite);
  button.setAttribute("aria-pressed", isFavorite ? "true" : "false");
  button.setAttribute(
    "aria-label",
    isFavorite ? "Remover dos favoritos" : "Adicionar aos favoritos"
  );
  button.title = isFavorite ? "Remover dos favoritos" : "Adicionar aos favoritos";
}

function decorateCard(card) {
  if (!(card instanceof HTMLElement)) return;
  const toolId = cardToolId(card);
  if (!toolId) return;

  let button = card.querySelector(".favorite-button");
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "favorite-button";
    button.dataset.favoriteToolId = toolId;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (favoriteIds.has(toolId)) favoriteIds.delete(toolId);
      else favoriteIds.add(toolId);
      saveFavorites();
      updateFavoriteButton(button, toolId);
      applyFilter();
    });

    const head = card.querySelector(".account-head");
    if (head) head.append(button);
  }

  updateFavoriteButton(button, toolId);
}

function decorateCards() {
  if (!toolsContainer) return;
  for (const card of toolsContainer.querySelectorAll(".account-card")) {
    decorateCard(card);
  }
}

function setEmptyCopy(favoritesOnly) {
  if (!emptyTitle || !emptyDescription) return;
  if (favoritesOnly) {
    emptyTitle.textContent = "Nenhum favorito ainda";
    emptyDescription.textContent = "Clique na estrela de uma ferramenta para deixar ela aqui.";
  } else {
    emptyTitle.textContent = "Nenhuma ferramenta encontrada";
    emptyDescription.textContent = "Ajuste a busca ou atualize a lista.";
  }
}

function applyFilter() {
  if (!toolsContainer || !emptyState) return;
  decorateCards();

  const cards = [...toolsContainer.querySelectorAll(".account-card")];
  let visibleCount = 0;

  for (const card of cards) {
    const toolId = cardToolId(card);
    const visible = activeFilter !== "favorites" || favoriteIds.has(toolId);
    card.hidden = !visible;
    if (visible) visibleCount += 1;
  }

  const showEmpty = visibleCount === 0;
  toolsContainer.hidden = showEmpty;
  emptyState.hidden = !showEmpty;
  setEmptyCopy(activeFilter === "favorites");
}

function selectFilter(filter) {
  activeFilter = filter === "favorites" ? "favorites" : "all";
  const favoritesSelected = activeFilter === "favorites";
  allTab?.classList.toggle("active", !favoritesSelected);
  favoritesTab?.classList.toggle("active", favoritesSelected);
  allTab?.setAttribute("aria-pressed", favoritesSelected ? "false" : "true");
  favoritesTab?.setAttribute("aria-pressed", favoritesSelected ? "true" : "false");
  applyFilter();
}

allTab?.addEventListener("click", () => selectFilter("all"));
favoritesTab?.addEventListener("click", () => selectFilter("favorites"));

if (toolsContainer) {
  new MutationObserver(() => {
    decorateCards();
    applyFilter();
  }).observe(toolsContainer, { childList: true });
}

decorateCards();
applyFilter();
