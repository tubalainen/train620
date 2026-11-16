"use strict";

const $ = (id) => document.getElementById(id);
const nf = (n) => n.toLocaleString("sv-SE");
let trains = [];

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, credentials: "same-origin" });
  if (res.status === 401 && !path.endsWith("/login")) { showView("login"); throw new Error("Du har loggats ut. Logga in igen."); }
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail ?? detail; } catch { /* inget JSON-svar */ }
    throw new Error(typeof detail === "string" ? detail : "Något gick fel");
  }
  return res.status === 204 ? null : res.json();
}
const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

function showMessage(text, ok = false) {
  const m = $("message");
  m.textContent = text;
  m.className = "message" + (ok ? " ok" : "");
  m.hidden = !text;
}

function showView(view) {
  $("disabled").hidden = view !== "disabled";
  $("login").hidden = view !== "login";
  $("panel").hidden = view !== "panel";
  $("logout").hidden = view !== "panel";
  if (view === "login") $("password").focus();
}

const fmtDate = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" });

// ------------------------------------------------------------------- tåg
async function loadTrains() {
  trains = await api("/api/trains");
  const rows = $("train-rows");
  rows.replaceChildren();
  if (!trains.length) rows.append(el("tr", {}, el("td", { colspan: 5, text: "Inga tåg bevakas." })));
  for (const t of trains) {
    rows.append(el("tr", {},
      el("td", {}, el("strong", { text: t.ident })),
      el("td", { class: "route", text: t.origin ? `${t.origin} → ${t.destination}` : "Inga uppgifter från Trafikverket ännu" }),
      el("td", { class: "num", text: nf(t.journeys) }),
      el("td", { text: t.first_date ? fmtDate(t.first_date) : "–" }),
      el("td", { class: "actions" }, el("button", { type: "button", class: "remove-btn", text: "Ta bort", onclick: () => removeTrain(t.ident) }))));
  }
  const select = $("import-train");
  const previous = select.value;
  select.replaceChildren(...trains.map((t) => el("option", { value: t.ident, text: t.origin ? `${t.ident} · ${t.origin} → ${t.destination}` : t.ident })));
  if (trains.some((t) => t.ident === previous)) select.value = previous;
}

async function removeTrain(ident) {
  if (!confirm(`Ta bort tåg ${ident}? All insamlad och importerad data för tåget raderas.`)) return;
  try {
    await api(`/api/trains/${ident}`, { method: "DELETE" });
    showMessage(`Tåg ${ident} togs bort.`, true);
    await loadTrains();
  } catch (e) { showMessage(e.message); }
}

$("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = e.target.querySelector("button");
  button.disabled = true;
  try {
    const added = await post("/api/trains", { ident: $("add-input").value.trim() });
    $("add-input").value = "";
    showMessage(added.found
      ? `Tåg ${added.ident} bevakas nu.`
      : `Tåg ${added.ident} bevakas nu, men Trafikverket har inga uppgifter om det just nu.`, Boolean(added.found));
    await loadTrains();
    $("import-train").value = added.ident;
  } catch (err) { showMessage(err.message); }
  button.disabled = false;
});

// ---------------------------------------------------------------- import
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const mentions = (name, ident) => new RegExp(`(^|\\D)${ident}(\\D|$)`).test(name);

async function loadImportFile(file) {
  if (!file) return;
  const info = $("drop-info");
  info.hidden = false;
  if (file.size > MAX_IMPORT_BYTES) { info.textContent = `${file.name} är för stor (högst 2 MB).`; return; }
  const text = (await file.text()).replace(/^﻿/, "");
  if (text.includes("\u0000")) { info.textContent = `${file.name} ser inte ut att vara en textfil.`; return; }
  $("import-text").value = text.trim();
  const rows = text.split(/\r?\n/).filter((l) => /^\s*\d{4}-\d{2}-\d{2}/.test(l)).length;
  info.textContent = `${file.name} – ${nf(rows)} rader med datum. Granska nedan och klicka på Importera.`;
  // Pekar filnamnet på exakt ett bevakat tåg väljs det; annars varnas om det verkar fel.
  const matches = trains.filter((t) => mentions(file.name, t.ident));
  if (matches.length === 1 && matches[0].ident !== $("import-train").value) {
    $("import-train").value = matches[0].ident;
    showMessage(`Tåg ${matches[0].ident} valdes utifrån filnamnet. Kontrollera innan du importerar.`, true);
  } else {
    showMessage("");
  }
}

const drop = $("drop");
$("import-file").addEventListener("change", (e) => { loadImportFile(e.target.files[0]); e.target.value = ""; });
for (const type of ["dragenter", "dragover"]) drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add("over"); });
for (const type of ["dragleave", "drop"]) drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.remove("over"); });
drop.addEventListener("drop", (e) => loadImportFile(e.dataTransfer.files[0]));
// En fil som släpps utanför rutan ska inte öppnas av webbläsaren i stället för sidan.
for (const type of ["dragover", "drop"]) window.addEventListener(type, (e) => e.preventDefault());

$("import-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ident = $("import-train").value;
  if (!ident) return showMessage("Lägg till ett tåg innan du importerar.");
  try {
    const res = await post(`/api/trains/${ident}/import`, { csv: $("import-text").value, source: $("import-source").value.trim() || "import" });
    showMessage(`${nf(res.imported)} dagar importerades till tåg ${ident}.` +
      (res.skipped_lines.length ? ` Rader som inte gick att tolka: ${res.skipped_lines.join(", ")}.` : ""), !res.skipped_lines.length);
    if (res.imported) { $("import-text").value = ""; $("drop-info").hidden = true; }
    await loadTrains();
  } catch (err) { showMessage(err.message); }
});

// ---------------------------------------------------------------- radera
$("reset-confirm").addEventListener("input", (e) => { $("reset-button").disabled = e.target.value.trim() !== "RADERA"; });
$("reset-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!confirm("Radera alla tåg och all data? Det går inte att ångra.")) return;
  try {
    const res = await post("/api/admin/reset", { confirm: $("reset-confirm").value });
    $("reset-confirm").value = "";
    $("reset-button").disabled = true;
    showMessage(`All data är raderad. Insamlingen börjar om för tåg ${res.trains.join(", ") || "–"}.`, true);
    $("initial-trains").textContent = res.trains.join(", ") || "inga";
    await loadTrains();
  } catch (err) { showMessage(err.message); }
});

// --------------------------------------------------------------- inloggning
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = e.target.querySelector("button");
  button.disabled = true;
  try {
    await post("/api/admin/login", { password: $("password").value });
    $("password").value = "";
    showMessage("");
    await enterPanel();
  } catch (err) { showMessage(err.message); $("password").select(); }
  button.disabled = false;
});

$("logout").addEventListener("click", async () => {
  await post("/api/admin/logout");
  showMessage("Du är utloggad.", true);
  showView("login");
});

// ---------------------------------------------------------------- hämtning
function renderPoll(h) {
  const status = $("poll-status");
  const t = h.last_poll_ok
    ? new Date(h.last_poll_ok).toLocaleString("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : null;
  status.textContent = (t ? `Senast hämtat ${t}.` : "Ingen hämtning har lyckats ännu.") +
    (h.last_error ? " Senaste försöket misslyckades." : "");
  status.classList.toggle("err", Boolean(h.last_error));
}

$("refresh").addEventListener("click", async (e) => {
  e.target.disabled = true;
  try {
    renderPoll(await api("/api/refresh", { method: "POST" }));
    await loadTrains();
  } catch (err) { showMessage(err.message); }
  e.target.disabled = false;
});

async function enterPanel() {
  showView("panel");
  await Promise.all([loadTrains(), api("/api/health").then(renderPoll)]);
}

(async function start() {
  try {
    const s = await api("/api/admin/session");
    if (!s.enabled) return showView("disabled");
    $("initial-trains").textContent = s.initial_trains.join(", ") || "inga";
    if (!s.logged_in) return showView("login");
    await enterPanel();
  } catch (e) { showMessage(e.message); }
})();
