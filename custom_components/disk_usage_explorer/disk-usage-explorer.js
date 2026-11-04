/* Disk Usage Explorer Lovelace card. */

const CARD_VERSION = "0.3.0";
// Results older than this are flagged as possibly out of date.
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const DOMAIN = "disk_usage_explorer";
const COLORS = ["#ff6263", "#ff9b54", "#ffd166", "#8bd17c", "#4ecdc4", "#55a6f7", "#8c7cf0", "#e779cf", "#6fd0a7", "#cf9cff"];
// Number of items drawn individually in the donut; the rest are grouped in "Other".
const CHART_ITEMS = COLORS.length;
// Reserved for the "Other" slice and the legend rows it groups; not part of COLORS.
const OTHER_COLOR = "#7d8794";
const LEGEND_ROWS = 30;

// UI strings. English is the fallback; add a language by adding a key.
const STRINGS = {
  en: {
    title: "Disk usage",
    path_label: "Folder to scan",
    path_placeholder: "/media/my_folder",
    scan: "Scan",
    cancel: "Cancel",
    not_ready: "The integration is not ready. Add Disk Usage Explorer in <b>Settings → Devices & services</b>.",
    scanning: "Scanning",
    items_scanned: (n) => `${n} items scanned`,
    cancelled: "Scan cancelled. Start it again to see the results.",
    scan_failed: "The scan failed.",
    preparing: "Preparing results…",
    idle: "Choose a folder Home Assistant can read, then start the scan.",
    start_failed: "Could not start the scan.",
    cancel_failed: "Could not cancel the scan.",
    load_failed: "Could not read the results.",
    bad_response: "The integration response does not contain the list of items.",
    in_folder: "in this folder",
    files: (n) => `${n} ${n === 1 ? "file" : "files"}`,
    folders: (n) => `${n} ${n === 1 ? "folder" : "folders"}`,
    scanned_at: (date) => `Scanned ${date}`,
    stale: "results may be out of date, scan again",
    root: "Root",
    other: "Other",
    empty: "Empty",
    hardlink: "hard link",
    hardlink_help: "Hard link: this data is already counted elsewhere in this scan",
    more_items: (n) => `${n} more items in this folder`,
    grouped: "The chart groups the remaining items under “Other”.",
    no_items: "No items in this folder.",
    truncated: (n) => `Partial results: limit of ${n} items reached`,
    warnings: (n) => `${n} ${n === 1 ? "warning" : "warnings"}`,
    hardlinks_counted: (n) => `${n} hard ${n === 1 ? "link" : "links"} counted once`,
    symlinks_skipped: (n) => `${n} symbolic ${n === 1 ? "link" : "links"} skipped`,
    largest: "Largest files",
    subfolders_included: "subfolders included",
    open_folder: (path) => `Open folder ${path}`,
    chart_label: "Disk space breakdown",
    chart_items: (n) => `${n} items`,
    units: ["B", "KB", "MB", "GB", "TB", "PB"],
    editor_title: "Title",
    editor_path: "Default folder",
    editor_entity: "Status entity",
    card_description: "Scan a folder and explore what takes up disk space.",
  },
  fr: {
    title: "Analyse du stockage",
    path_label: "Dossier à analyser",
    path_placeholder: "/media/mon_dossier",
    scan: "Analyser",
    cancel: "Annuler",
    not_ready: "L’intégration n’est pas prête. Ajoutez Disk Usage Explorer dans <b>Paramètres → Appareils et services</b>.",
    scanning: "Analyse en cours",
    items_scanned: (n) => `${n} éléments parcourus`,
    cancelled: "Analyse annulée. Relancez-la pour afficher les résultats.",
    scan_failed: "L’analyse a échoué.",
    preparing: "Préparation des résultats…",
    idle: "Choisissez un dossier lisible par Home Assistant, puis lancez l’analyse.",
    start_failed: "Impossible de démarrer l’analyse.",
    cancel_failed: "Impossible d’annuler l’analyse.",
    load_failed: "Impossible de lire les résultats.",
    bad_response: "La réponse de l’intégration ne contient pas la liste des éléments.",
    in_folder: "dans ce dossier",
    files: (n) => `${n} ${n > 1 ? "fichiers" : "fichier"}`,
    folders: (n) => `${n} ${n > 1 ? "dossiers" : "dossier"}`,
    scanned_at: (date) => `Analysé le ${date}`,
    stale: "résultats possiblement périmés, relancez l’analyse",
    root: "Racine",
    other: "Autres",
    empty: "Vide",
    hardlink: "lien physique",
    hardlink_help: "Lien physique : ces données sont déjà comptées ailleurs dans cette analyse",
    more_items: (n) => `${n} autres éléments dans ce dossier`,
    grouped: "Le graphique regroupe les autres éléments dans « Autres ».",
    no_items: "Aucun élément dans ce dossier.",
    truncated: (n) => `Résultats partiels : limite de ${n} éléments atteinte`,
    warnings: (n) => `${n} ${n > 1 ? "avertissements" : "avertissement"}`,
    hardlinks_counted: (n) => n > 1 ? `${n} liens physiques comptés une seule fois` : `${n} lien physique compté une seule fois`,
    symlinks_skipped: (n) => n > 1 ? `${n} liens symboliques ignorés` : `${n} lien symbolique ignoré`,
    largest: "Plus gros fichiers",
    subfolders_included: "sous-dossiers inclus",
    open_folder: (path) => `Ouvrir le dossier ${path}`,
    chart_label: "Répartition de l’espace disque",
    chart_items: (n) => `${n} éléments`,
    units: ["o", "Ko", "Mo", "Go", "To", "Po"],
    editor_title: "Titre",
    editor_path: "Dossier par défaut",
    editor_entity: "Entité d’état",
    card_description: "Analysez un dossier et explorez ce qui occupe l’espace disque.",
  },
};

const pickLanguage = (language) => {
  const base = String(language || "").toLowerCase().split("-")[0];
  return STRINGS[base] ? base : "en";
};

class DiskUsageExplorerCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._directory = null;
    this._currentPath = "";
    this._requestKey = "";
    this._error = "";
    this._pathValue = "/media";
  }

  static getStubConfig() {
    return { path: "/media" };
  }

  // Visual editor in the dashboard UI.
  static getConfigForm() {
    return {
      schema: [
        { name: "title", selector: { text: {} } },
        { name: "path", selector: { text: {} } },
        { name: "entity", selector: { entity: { integration: DOMAIN, domain: "sensor" } } },
      ],
      computeLabel: (schema, localize, hass) => {
        const t = STRINGS[pickLanguage(hass?.locale?.language || hass?.language)];
        return t[`editor_${schema.name}`] || schema.name;
      },
    };
  }

  setConfig(config) {
    this._config = config || {};
    this._entity = this._config.entity || "sensor.disk_usage_explorer_status";
    this._pathValue = this._config.path || "/media";
    this._render();
  }

  get _locale() {
    return this._hass?.locale?.language || this._hass?.language || navigator.language || "en";
  }

  // Look up a UI string in the Home Assistant language; functions take arguments.
  _t(key, ...args) {
    const value = STRINGS[pickLanguage(this._locale)][key] ?? STRINGS.en[key];
    return typeof value === "function" ? value(...args) : value;
  }

  _number(value, options) {
    return Number(value || 0).toLocaleString(this._locale, options);
  }

  set hass(hass) {
    const languageChanged = this._hass && (this._hass.locale?.language || this._hass.language) !== (hass.locale?.language || hass.language);
    this._hass = hass;
    if (languageChanged) this._lastRenderedKey = null;
    const state = hass.states[this._entity];
    if (!state) {
      // Only re-render when the entity disappears, not on every unrelated hass update.
      if (this._lastRenderedKey !== "missing") {
        this._lastRenderedKey = "missing";
        this._render();
      }
      return;
    }
    const attrs = state.attributes || {};
    const key = `${state.state}|${attrs.scan_id || ""}|${attrs.path || ""}`;
    if (state.state === "scanning" && attrs.scan_id !== this._activeScanId) {
      this._activeScanId = attrs.scan_id;
      this._directory = null;
      this._currentPath = "";
    }
    if (state.state === "completed" && key !== this._requestKey) {
      this._requestKey = key;
      this._currentPath = "";
      this._loadDirectory("");
    }
    if (key !== this._lastRenderedKey) {
      this._lastRenderedKey = key;
      this._render();
    } else if (state.state === "scanning") {
      const progress = this.shadowRoot.querySelector(".progress");
      if (progress) progress.textContent = this._t("items_scanned", this._number(attrs.items_scanned));
    }
  }

  getCardSize() { return 6; }

  async _startScan() {
    const input = this.shadowRoot.querySelector("#scan-path");
    const path = input?.value.trim();
    if (!path) return;
    this._pathValue = path;
    this._error = "";
    try {
      await this._hass.callService(DOMAIN, "scan", { path });
    } catch (error) {
      this._error = error?.message || this._t("start_failed");
      this._render();
    }
  }

  async _cancelScan() {
    try {
      await this._hass.callService(DOMAIN, "cancel", {});
    } catch (error) {
      this._error = error?.message || this._t("cancel_failed");
      this._render();
    }
  }

  async _suggestDirectories(path) {
    if (!this._hass) return;
    const request = (this._suggestionRequest || 0) + 1;
    this._suggestionRequest = request;
    try {
      const serviceResult = await this._hass.callService(
        DOMAIN,
        "suggest_directories",
        { path },
        undefined,
        false,
        true,
      );
      if (request !== this._suggestionRequest) return;
      const result = serviceResult?.response ?? serviceResult;
      const suggestionList = this.shadowRoot.querySelector("#path-suggestions");
      if (!suggestionList) return;
      const paths = result?.paths || [];
      suggestionList.replaceChildren(...paths.map((value, index) => {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "suggestion";
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", "false");
        option.dataset.path = value;
        option.textContent = value;
        option.addEventListener("mousedown", (event) => event.preventDefault());
        option.addEventListener("click", () => this._selectSuggestion(value));
        option.addEventListener("blur", () => this._scheduleHideSuggestions());
        option.addEventListener("keydown", (event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            suggestionList.querySelectorAll(".suggestion")[index + 1]?.focus();
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            if (index === 0) this.shadowRoot.querySelector("#scan-path")?.focus();
            else suggestionList.querySelectorAll(".suggestion")[index - 1]?.focus();
          } else if (event.key === "Escape") {
            event.preventDefault();
            this._hideSuggestions();
            this.shadowRoot.querySelector("#scan-path")?.focus();
          }
        });
        return option;
      }));
      suggestionList.hidden = paths.length === 0;
      this.shadowRoot.querySelector("#scan-path")?.setAttribute("aria-expanded", String(paths.length > 0));
    } catch (_error) {
      if (request === this._suggestionRequest) this._hideSuggestions();
    }
  }

  _selectSuggestion(path) {
    const input = this.shadowRoot.querySelector("#scan-path");
    if (!input) return;
    clearTimeout(this._suggestionTimer);
    input.value = path;
    this._pathValue = path;
    input.focus();
    input.setSelectionRange(path.length, path.length);
    this._suggestDirectories(path);
  }

  _scheduleHideSuggestions() {
    clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => {
      // Keep the list open while focus is on the input or one of the suggestions.
      const active = this.shadowRoot.activeElement;
      const list = this.shadowRoot.querySelector("#path-suggestions");
      if (active && (active.id === "scan-path" || list?.contains(active))) return;
      this._hideSuggestions();
    }, 150);
  }

  _hideSuggestions() {
    const list = this.shadowRoot.querySelector("#path-suggestions");
    if (list) {
      list.hidden = true;
      list.replaceChildren();
    }
    this.shadowRoot.querySelector("#scan-path")?.setAttribute("aria-expanded", "false");
  }

  async _loadDirectory(path) {
    if (!this._hass) return;
    try {
      const serviceResult = await this._hass.callService(
        DOMAIN,
        "browse",
        { path },
        undefined,
        false,
        true,
      );
      this._directory = serviceResult?.response ?? serviceResult;
      if (!Array.isArray(this._directory?.items)) {
        throw new Error(this._t("bad_response"));
      }
      this._currentPath = path;
      this._error = "";
    } catch (error) {
      this._directory = null;
      this._error = error?.message || this._t("load_failed");
    }
    this._render();
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;
    const state = this._hass?.states[this._entity];
    const attrs = state?.attributes || {};
    const status = state?.state || "unavailable";
    const heading = this._config.title || this._t("title");
    let content = "";

    if (!state) {
      content = `<div class="notice">${this._t("not_ready")}</div>`;
    } else if (status === "scanning") {
      content = `<div class="scan-state"><span class="spinner"></span><div><strong>${this._t("scanning")}</strong><div class="progress">${this._t("items_scanned", this._number(attrs.items_scanned))}</div></div><button class="secondary" id="cancel">${this._t("cancel")}</button></div>`;
    } else if (status === "cancelled") {
      content = `<div class="notice">${this._t("cancelled")}</div>`;
    } else if (status === "error") {
      content = `<div class="notice error">${this._escape(attrs.error || this._t("scan_failed"))}</div>`;
    } else if (status === "completed" && this._directory) {
      content = this._renderResults(attrs);
    } else if (status === "completed") {
      content = `<div class="scan-state"><span class="spinner"></span><div><strong>${this._t("preparing")}</strong></div></div>`;
    } else {
      content = `<div class="empty">${this._t("idle")}</div>`;
    }

    const error = this._error ? `<div class="notice error">${this._escape(this._error)}</div>` : "";
    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; color:var(--primary-text-color); }
        ha-card { padding:20px; overflow:visible; }
        .head { display:flex; align-items:center; gap:10px; margin-bottom:16px; }
        .head ha-icon { color:var(--primary-color); }
        h2 { font-size:18px; font-weight:600; margin:0; flex:1; }
        .form { display:flex; gap:8px; margin-bottom:14px; position:relative; z-index:3; }
        .path-wrap { min-width:0; flex:1; position:relative; }
        input { width:100%; box-sizing:border-box; min-width:0; background:var(--secondary-background-color); color:var(--primary-text-color); border:1px solid var(--divider-color); border-radius:8px; padding:11px 12px; font:inherit; }
        .suggestions { position:absolute; top:calc(100% + 5px); left:0; width:100%; max-height:260px; overflow:auto; box-sizing:border-box; padding:4px; border:1px solid var(--divider-color); border-radius:8px; background:var(--card-background-color, var(--ha-card-background, var(--primary-background-color))); box-shadow:0 8px 22px rgba(0,0,0,.35); z-index:20; }
        .suggestions[hidden] { display:none !important; }
        .suggestion { display:block; width:100%; padding:9px 10px; border:0; border-radius:5px; background:transparent; color:var(--primary-text-color); text-align:left; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .suggestion:hover,.suggestion:focus { outline:none; background:var(--secondary-background-color); }
        button { color:var(--primary-text-color); font:inherit; cursor:pointer; }
        .primary { border:0; border-radius:8px; background:var(--primary-color); color:var(--text-primary-color, white); padding:0 16px; font-weight:600; }
        .primary:disabled { opacity:.55; cursor:default; }
        .empty,.notice { padding:18px; border-radius:10px; background:var(--secondary-background-color); color:var(--secondary-text-color); }
        .error { color:var(--error-color, #d32f2f); margin:10px 0; white-space:pre-wrap; overflow-wrap:anywhere; }
        .scan-state { display:flex; align-items:center; gap:14px; padding:22px 8px; }
        .scan-state > div { flex:1; }
        .secondary { border:1px solid var(--divider-color); border-radius:8px; background:none; padding:8px 14px; }
        .secondary:hover { background:var(--secondary-background-color); }
        .spinner { width:24px; height:24px; border:3px solid var(--divider-color); border-top-color:var(--primary-color); border-radius:50%; animation:spin .8s linear infinite; }
        @keyframes spin { to { transform:rotate(360deg); } }
        .progress { color:var(--secondary-text-color); font-size:13px; margin-top:4px; }
        .summary { display:flex; align-items:baseline; justify-content:space-between; gap:12px; border-bottom:1px solid var(--divider-color); padding:0 0 12px; }
        .total { font-size:23px; font-weight:650; }
        .counts { color:var(--secondary-text-color); font-size:12px; text-align:right; }
        .crumbs { display:flex; gap:5px; flex-wrap:wrap; align-items:center; padding:12px 0 6px; color:var(--secondary-text-color); font-size:13px; }
        .crumb { border:0; background:none; color:var(--primary-color); padding:3px 1px; }
        .crumb.current { color:var(--primary-text-color); font-weight:600; cursor:default; }
        .viz { display:grid; grid-template-columns:minmax(180px, 1fr) minmax(180px, 1.2fr); align-items:center; gap:14px; }
        .chart { width:min(100%,260px); margin:auto; overflow:visible; }
        .slice { cursor:pointer; stroke:var(--card-background-color); stroke-width:1.2; transition:opacity .15s; }
        .slice:hover,.slice:focus-visible { opacity:.78; outline:none; } .slice.leaf { cursor:default; }
        .stale { color:var(--warning-color, #a66b00); }
        .chart-wrap { position:relative; }
        .chart { display:block; }
        .tip { position:absolute; pointer-events:none; z-index:5; max-width:220px; padding:6px 9px; border-radius:6px; background:var(--primary-text-color); color:var(--card-background-color, #fff); font-size:12px; line-height:1.3; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; transform:translate(-50%, calc(-100% - 10px)); box-shadow:0 4px 12px rgba(0,0,0,.25); }
        .tip[hidden] { display:none; }
        .largest { margin-top:14px; border-top:1px solid var(--divider-color); padding-top:10px; }
        .largest summary { cursor:pointer; font-weight:600; padding:4px 0 8px; }
        .item.big-file { grid-template-columns:minmax(0,1fr) auto; }
        .file-dir { display:block; font-size:11px; color:var(--secondary-text-color); overflow:hidden; text-overflow:ellipsis; }
        .chart-label { fill:var(--primary-text-color); font-size:13px; font-weight:600; text-anchor:middle; }
        .chart-sub { fill:var(--secondary-text-color); font-size:10px; text-anchor:middle; }
        .legend { max-height:250px; overflow:auto; }
        .item { width:100%; display:grid; grid-template-columns:10px minmax(0,1fr) auto; gap:9px; align-items:center; padding:8px 3px; text-align:left; border:0; border-bottom:1px solid var(--divider-color); background:none; }
        .item:hover { background:var(--secondary-background-color); }
        .dot { width:9px; height:9px; border-radius:50%; }
        .item-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .tag { font-size:11px; color:var(--secondary-text-color); }
        .item-size { color:var(--secondary-text-color); font-variant-numeric:tabular-nums; white-space:nowrap; }
        .small { color:var(--secondary-text-color); font-size:12px; padding:8px 2px; }
        .warnings { margin-top:10px; color:var(--warning-color, #a66b00); font-size:12px; }
        @media (max-width:560px) { ha-card{padding:16px} .viz{grid-template-columns:1fr} .chart{width:min(100%,230px)} .legend{max-height:220px} .primary{padding:0 12px} }
      </style>
      <ha-card>
        <div class="head"><ha-icon icon="mdi:chart-donut"></ha-icon><h2>${this._escape(heading)}</h2></div>
        <div class="form"><div class="path-wrap"><input id="scan-path" role="combobox" aria-autocomplete="list" aria-controls="path-suggestions" aria-expanded="false" autocomplete="off" aria-label="${this._escapeAttr(this._t("path_label"))}" value="${this._escapeAttr(this._pathValue)}" placeholder="${this._escapeAttr(this._t("path_placeholder"))}"><div id="path-suggestions" class="suggestions" role="listbox" hidden></div></div><button class="primary" id="scan" ${status === "scanning" ? "disabled" : ""}>${this._t("scan")}</button></div>
        ${error}${content}
      </ha-card>`;
    this.shadowRoot.querySelector("#scan")?.addEventListener("click", () => this._startScan());
    this.shadowRoot.querySelector("#cancel")?.addEventListener("click", () => this._cancelScan());
    const pathInput = this.shadowRoot.querySelector("#scan-path");
    pathInput?.addEventListener("focus", () => this._suggestDirectories(pathInput.value));
    pathInput?.addEventListener("blur", () => this._scheduleHideSuggestions());
    pathInput?.addEventListener("input", (event) => {
      this._pathValue = event.currentTarget.value;
      clearTimeout(this._suggestionTimer);
      const query = this._pathValue;
      this._suggestionTimer = setTimeout(() => this._suggestDirectories(query), 220);
    });
    pathInput?.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        const first = this.shadowRoot.querySelector("#path-suggestions .suggestion");
        if (first) { event.preventDefault(); first.focus(); }
      } else if (event.key === "Escape") {
        this._hideSuggestions();
      } else if (event.key === "Enter") {
        const first = this.shadowRoot.querySelector("#path-suggestions .suggestion");
        if (first && !this.shadowRoot.querySelector("#path-suggestions").hidden) {
          event.preventDefault();
          first.click();
        } else {
          this._startScan();
        }
      }
    });
    this._bindTooltip();
    this.shadowRoot.querySelector(".largest")?.addEventListener("toggle", (event) => {
      this._largestOpen = event.currentTarget.open;
    });
    this.shadowRoot.querySelectorAll("[data-path]").forEach((button) => {
      button.addEventListener("click", () => this._loadDirectory(button.dataset.path));
      if (button.classList.contains("slice")) {
        button.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this._loadDirectory(button.dataset.path);
          }
        });
      }
    });
  }

  _bindTooltip() {
    const wrap = this.shadowRoot.querySelector(".chart-wrap");
    const tip = wrap?.querySelector(".tip");
    if (!tip) return;
    const show = (slice, x, y) => {
      const box = wrap.getBoundingClientRect();
      tip.textContent = slice.dataset.label;
      tip.style.left = `${x - box.left}px`;
      tip.style.top = `${y - box.top}px`;
      tip.hidden = false;
    };
    wrap.querySelectorAll(".slice").forEach((slice) => {
      slice.addEventListener("pointermove", (event) => {
        if (event.pointerType === "mouse") show(slice, event.clientX, event.clientY);
      });
      slice.addEventListener("pointerleave", () => { tip.hidden = true; });
      // Keyboard users get the same label, anchored on the slice.
      slice.addEventListener("focus", () => {
        const rect = slice.getBoundingClientRect();
        show(slice, rect.left + rect.width / 2, rect.top + rect.height / 2);
      });
      slice.addEventListener("blur", () => { tip.hidden = true; });
    });
  }

  _renderResults(attrs) {
    const directory = this._directory;
    const items = directory.items || [];
    const parts = this._currentPath ? this._currentPath.split("/") : [];
    const crumbs = [`<button class="crumb ${parts.length ? "" : "current"}" data-path="">${this._escape(attrs.path || this._t("root"))}</button>`];
    let partial = "";
    parts.forEach((part, index) => {
      partial = partial ? `${partial}/${part}` : part;
      crumbs.push(`<span>›</span><button class="crumb ${index === parts.length - 1 ? "current" : ""}" data-path="${this._escapeAttr(partial)}">${this._escape(part)}</button>`);
    });
    const nonEmpty = items.filter((item) => item.size > 0);
    const chartItems = nonEmpty.slice(0, CHART_ITEMS);
    const hiddenSize = nonEmpty.slice(CHART_ITEMS).reduce((sum, item) => sum + item.size, 0);
    if (hiddenSize) chartItems.push({ name: this._t("other"), path: "", kind: "summary", size: hiddenSize });
    const svg = directory.total_bytes ? this._renderDonut(chartItems, directory.total_bytes) : `<svg class="chart" viewBox="0 0 240 240"><circle cx="120" cy="120" r="76" fill="none" stroke="var(--divider-color)" stroke-width="32"/><text x="120" y="117" class="chart-label">${this._t("empty")}</text></svg>`;
    const rows = items.slice(0, LEGEND_ROWS).map((item, index) => {
      // Items are sorted by size, so rows past CHART_ITEMS are the ones in "Other".
      const color = index < CHART_ITEMS && item.size > 0 ? COLORS[index] : OTHER_COLOR;
      const hardlink = item.hardlink ? ` <span class="tag" title="${this._escapeAttr(this._t("hardlink_help"))}">${this._t("hardlink")}</span>` : "";
      const action = item.kind === "directory" ? `data-path="${this._escapeAttr(item.path)}"` : "";
      return `<button class="item" ${action} ${item.kind === "file" ? "disabled" : ""}><span class="dot" style="background:${color}"></span><span class="item-name">${this._escape(item.name)}${item.kind === "directory" ? " /" : ""}${hardlink}</span><span class="item-size">${this._formatSize(item.size)}</span></button>`;
    }).join("");
    const more = items.length > LEGEND_ROWS ? `<div class="small">${this._t("more_items", this._number(items.length - LEGEND_ROWS))}</div>` : "";
    const chartLimit = hiddenSize ? `<div class="small">${this._t("grouped")}</div>` : "";
    const warningText = [
      attrs.truncated ? this._t("truncated", this._number(attrs.max_items)) : "",
      attrs.warning_count ? this._t("warnings", attrs.warning_count) : "",
      attrs.hardlinks_deduplicated ? this._t("hardlinks_counted", attrs.hardlinks_deduplicated) : "",
      attrs.symlinks_skipped ? this._t("symlinks_skipped", attrs.symlinks_skipped) : "",
    ].filter(Boolean).join(" · ");
    const warnings = warningText ? `<div class="warnings">${this._escape(warningText)}.</div>` : "";
    const largest = this._renderLargest(directory.largest_files || [], attrs);
    const finished = attrs.finished_at ? new Date(attrs.finished_at) : null;
    const isStale = finished && Date.now() - finished.getTime() > STALE_AFTER_MS;
    const dateText = finished
      ? `${this._t("scanned_at", finished.toLocaleString(this._locale, { dateStyle: "medium", timeStyle: "short" }))}${isStale ? ` · ${this._t("stale")}` : ""}`
      : "";
    const dateLine = dateText ? `<div class="small ${isStale ? "stale" : ""}">${this._escape(dateText)}</div>` : "";
    return `<div class="summary"><div><div class="total">${this._formatSize(directory.total_bytes)}</div><div class="small">${this._t("in_folder")}</div>${dateLine}</div><div class="counts">${this._t("files", directory.file_count || 0)}<br>${this._t("folders", directory.directory_count || 0)}</div></div><nav class="crumbs">${crumbs.join("")}</nav><div class="viz"><div class="chart-wrap">${svg}<div class="tip" role="tooltip" hidden></div></div><div class="legend">${rows || `<div class="small">${this._t("no_items")}</div>`}${more}${chartLimit}</div></div>${largest}${warnings}`;
  }

  _renderLargest(files, attrs) {
    if (!files.length) return "";
    const rows = files.map((file) => {
      const parent = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
      const hardlink = file.hardlink ? ` <span class="tag">${this._t("hardlink")}</span>` : "";
      return `<button class="item big-file" data-path="${this._escapeAttr(parent)}" title="${this._escapeAttr(this._t("open_folder", parent || attrs.path || this._t("root")))}"><span class="item-name">${this._escape(file.name)}${hardlink}<span class="file-dir">${this._escape(parent ? `${parent}/` : "./")}</span></span><span class="item-size">${this._formatSize(file.size)}</span></button>`;
    }).join("");
    return `<details class="largest" ${this._largestOpen ? "open" : ""}><summary>${this._t("largest")} <span class="tag">${this._t("subfolders_included")}</span></summary>${rows}</details>`;
  }

  _renderDonut(items, total) {
    let angle = -Math.PI / 2;
    const slices = items.map((item, index) => {
      const span = Math.max((item.size / total) * Math.PI * 2, 0.0001);
      const start = angle;
      const end = angle + span - 0.00001;
      angle += span;
      const path = this._arcPath(start, end);
      const percent = (item.size / total).toLocaleString(this._locale, { style: "percent", maximumFractionDigits: 1 });
      const label = `${item.name}${item.kind === "directory" ? " /" : ""} · ${this._formatSize(item.size)} · ${percent}`;
      const pathAttribute = item.kind === "directory"
        ? `data-path="${this._escapeAttr(item.path)}" tabindex="0" role="button" aria-label="${this._escapeAttr(this._t("open_folder", label))}"`
        : "";
      const fill = item.kind === "summary" ? OTHER_COLOR : COLORS[index];
      return `<path class="slice${item.kind === "directory" ? "" : " leaf"}" ${pathAttribute} data-label="${this._escapeAttr(label)}" fill="${fill}" d="${path}"/>`;
    }).join("");
    return `<svg class="chart" viewBox="0 0 240 240" role="img" aria-label="${this._escapeAttr(this._t("chart_label"))}">${slices}<text x="120" y="116" class="chart-label">${this._formatSize(total)}</text><text x="120" y="134" class="chart-sub">${this._t("chart_items", items.length)}</text></svg>`;
  }

  _arcPath(start, end) {
    const point = (radius, angle) => [120 + radius * Math.cos(angle), 120 + radius * Math.sin(angle)];
    const [x1, y1] = point(94, start);
    const [x2, y2] = point(94, end);
    const [x3, y3] = point(57, end);
    const [x4, y4] = point(57, start);
    const large = end - start > Math.PI ? 1 : 0;
    return `M ${x1} ${y1} A 94 94 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A 57 57 0 ${large} 0 ${x4} ${y4} Z`;
  }

  _formatSize(value) {
    const bytes = Number(value) || 0;
    const units = this._t("units");
    if (bytes < 1024) return `${this._number(bytes)} ${units[0]}`;
    let amount = bytes;
    let unit = 0;
    do { amount /= 1024; unit++; } while (amount >= 1024 && unit < units.length - 1);
    return `${this._number(amount, { maximumFractionDigits: amount < 10 ? 1 : 0 })} ${units[unit]}`;
  }

  _escape(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  _escapeAttr(value) { return this._escape(value); }
}

if (!customElements.get("disk-usage-explorer")) {
  customElements.define("disk-usage-explorer", DiskUsageExplorerCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "disk-usage-explorer",
  name: "Disk Usage Explorer",
  description: STRINGS[pickLanguage(document.documentElement.lang || navigator.language)].card_description,
  preview: true,
});
console.info(`%c DISK-USAGE-EXPLORER %c ${CARD_VERSION} `, "color:white;background:#526fe4;font-weight:bold", "color:#526fe4;background:white;font-weight:bold");
