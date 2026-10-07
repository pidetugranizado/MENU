// =====================================================================
// PARQUEADERO — módulo del vigilante
// Registra entradas y salidas. El pago se recibe en CAJA (admin.html →
// Parqueadero → "Marcar como pagado"). Aquí no hay funciones para recibir
// dinero, cambiar la tarifa, eliminar pagos ni ver el recaudo.
// Requiere iniciar sesión con un usuario admin o cajero.
// =====================================================================
(function () {
"use strict";

const {
  db, COL, NAME_MAX, money, esc, isValidPrice, timeLabel, dateLabel, toDate,
  friendlyError, toast
} = window.Core;
const { collection, query, where, onSnapshot, call } = window.Store;

const $ = sel => document.querySelector(sel);

const state = { active: [], ready: false, rate: null, saving: false };

/** "abc-123 " → "ABC123" (solo letras y números). */
const cleanPlate = raw => String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
const cleanName = raw => String(raw ?? "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
const when = ts => { const d = toDate(ts); return d ? `${timeLabel(d)} · ${dateLabel(d)}` : "—"; };
const statusPill = r => r.paid ? `<span class="st ok">🟢 PAGADO</span>` : `<span class="st pend">🔴 PENDIENTE DE PAGO</span>`;

// ---------- Sesión: solo admin o cajero ----------
window.Auth.require({
  roles: ["admin", "cajero"],
  title: "Parqueadero",
  subtitle: "Ingresa con un usuario de caja o administrador."
}).then(user => {
  $("#whoTag").textContent = user.name || user.email;
  $("#logoutBtn").hidden = false;
  $("#logoutBtn").addEventListener("click", () => { if (confirm("¿Cerrar sesión?")) window.Auth.logout(); });
  startListeners();
  renderExit();
  plateIn.focus();
});

// ---------- Datos en tiempo real ----------
function startListeners() {
  onSnapshot(query(collection(db, COL.parking), where("exited", "==", false)), snap => {
    const ms = r => toDate(r.entryAt)?.getTime() || 0;
    state.active = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => ms(b) - ms(a));
    state.ready = true;
    renderActive();
    renderExit();
  }, onError);

  onSnapshot(collection(db, COL.settings), snap => {
    const s = snap.docs.find(d => d.id === "parking");
    state.rate = s ? s.data().rate ?? null : null;
    $("#rateTag").textContent = isValidPrice(state.rate) && state.rate > 0 ? `Tarifa fija: ${money(state.rate)}` : "Tarifa sin configurar";
  }, onError);
}

function onError(err) {
  console.error(err);
  toast(friendlyError(err), { type: "error", duration: 6000 });
}

// ---------- Tabla de vehículos dentro ----------
function renderActive() {
  const box = $("#activeList");
  $("#countTag").textContent = state.ready ? `${state.active.length} vehículo${state.active.length === 1 ? "" : "s"}` : "";
  if (!state.active.length) { box.innerHTML = `<div class="empty">No hay vehículos dentro.</div>`; return; }
  box.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th>Placa</th><th>Nombre</th><th>Hora de entrada</th><th>Valor</th><th>Estado</th></tr></thead>
      <tbody>${state.active.map(r => `
        <tr data-plate="${esc(r.plate)}" title="Buscar para salida">
          <td><span class="plate">${esc(r.plate)}</span></td>
          <td class="name">${esc(r.customerName)}</td>
          <td>${when(r.entryAt)}</td>
          <td>${money(r.rate)}</td>
          <td>${statusPill(r)}</td>
        </tr>`).join("")}</tbody>
    </table></div>`;
}

$("#activeList").addEventListener("click", e => {
  const tr = e.target.closest("[data-plate]");
  if (!tr) return;
  $("#exitIn").value = tr.dataset.plate;
  renderExit();
  $("#exitIn").scrollIntoView({ behavior: "smooth", block: "center" });
});

// ---------- Entrada ----------
const plateIn = $("#plateIn");
plateIn.addEventListener("input", () => { plateIn.value = cleanPlate(plateIn.value); });

$("#entryForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (state.saving) return;
  const errEl = $("#entryError");
  const plate = cleanPlate(plateIn.value);
  const name = cleanName($("#nameIn").value);
  const fail = msg => { errEl.textContent = msg; errEl.hidden = false; };
  if (plate.length < 3) return fail("Escribe la placa del vehículo.");
  if (!name) return fail("Escribe el nombre del cliente.");
  errEl.hidden = true;

  const btn = $("#entryBtn");
  state.saving = true;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Registrando…`;
  try {
    // El servidor toma la tarifa vigente y verifica que la placa no esté ya dentro
    const { rate } = await call("/api/gz/parking-entry", { plate, customerName: name });
    plateIn.value = "";
    $("#nameIn").value = "";
    toast(`Entrada registrada: ${plate} · ${money(rate)} pendiente de pago en caja`, { type: "ok", duration: 4500 });
    plateIn.focus();
  } catch (err) {
    fail(err.message && !err.code ? err.message : friendlyError(err));
  } finally {
    state.saving = false;
    btn.disabled = false;
    btn.textContent = "REGISTRAR ENTRADA";
  }
});

// ---------- Salida ----------
const exitIn = $("#exitIn");
exitIn.addEventListener("input", () => { exitIn.value = cleanPlate(exitIn.value); renderExit(); });

function renderExit() {
  const box = $("#exitResult");
  const q = cleanPlate(exitIn.value);
  if (!q) { box.innerHTML = `<p class="hint">Escribe la placa o toca un vehículo de la tabla.</p>`; return; }
  const exact = state.active.find(r => r.plate === q);
  if (!exact) {
    const partial = state.active.filter(r => r.plate.includes(q));
    box.innerHTML = `
      <div class="exit-card none">
        No hay ningún vehículo dentro con la placa <b>${esc(q)}</b>.
        ${partial.length ? `<div class="exit-pick">¿Quisiste decir? ${partial.slice(0, 6).map(r =>
          `<button type="button" data-pick="${esc(r.plate)}"><span class="plate">${esc(r.plate)}</span></button>`).join("")}</div>` : ""}
      </div>`;
    return;
  }
  const r = exact;
  box.innerHTML = r.paid ? `
    <div class="exit-card ok">
      <span class="plate big">${esc(r.plate)}</span>
      <div class="exit-status">🟢 PAGADO</div>
      <p class="exit-msg">Puede salir. Registra la salida.</p>
      ${details(r)}
      <button class="btn btn-ok btn-lg btn-block" id="exitBtn" data-id="${esc(r.id)}">REGISTRAR SALIDA</button>
    </div>` : `
    <div class="exit-card pend">
      <span class="plate big">${esc(r.plate)}</span>
      <div class="exit-status">🔴 PENDIENTE DE PAGO</div>
      <p class="exit-msg">Debe pagar ${money(r.rate)} en caja antes de salir.</p>
      ${details(r)}
    </div>`;
}

function details(r) {
  return `
    <div class="exit-row"><span>Cliente</span><b class="name">${esc(r.customerName)}</b></div>
    <div class="exit-row"><span>Entrada</span><b>${when(r.entryAt)}</b></div>
    ${r.paid ? `<div class="exit-row"><span>Pago registrado</span><b>${when(r.paidAt)}</b></div>` : ""}
    <div class="exit-row"><span>Valor</span><b>${money(r.rate)}</b></div>`;
}

$("#exitResult").addEventListener("click", async e => {
  const pick = e.target.closest("[data-pick]");
  if (pick) { exitIn.value = pick.dataset.pick; renderExit(); return; }
  const btn = e.target.closest("#exitBtn");
  if (!btn) return;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Registrando salida…`;
  try {
    const { plate } = await call("/api/gz/parking-exit", { id: btn.dataset.id });
    exitIn.value = "";
    renderExit();
    toast(`Salida registrada: ${plate}`, { type: "ok" });
  } catch (err) {
    toast(err.message && !err.code ? err.message : friendlyError(err), { type: "error", duration: 5000 });
    renderExit();
  }
});

})();
