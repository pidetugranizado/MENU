// =====================================================================
// PORTAL ADMINISTRATIVO (personal)
// Caja (pedidos y pagos) · Preparación · Historial · Productos · Toppings
// =====================================================================
(function () {
"use strict";

const {
  db, COL, PAYMENT_METHODS, PAYMENT_LABELS, TOPPING_MODE, DEFAULT_SIZES, productSizes, catalogSig, ROLE_TABS,
  money, parseMoney, isValidPrice, esc, normalize, dateKey, timeLabel, dateLabel, toDate,
  watchCatalog, renderItemsDetail, renderSidesDetail, friendlyError, toast
} = window.Core;
const Stock = window.Stock;
const {
  collection, doc, query, where, orderBy, limit, onSnapshot, getDoc, getDocs,
  addDoc, setDoc, updateDoc, deleteDoc, writeBatch, runTransaction, serverTimestamp,
  Timestamp, arrayUnion, arrayRemove, deleteField, call
} = window.Store;
const Costing = window.Costing;
const { moneyDec, pct } = Costing;

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const TAB_KEY = "granizados.admin.tab";
const TABS = ROLE_TABS.admin;
// Pestañas que viven en su propio archivo (extras.js, inventario.js, usuarios.js, contabilidad.js) y se registran con AdminKit.registerTab
const tabModules = {};
const PRODUCT_IMG = { maxSide: 720, quality: 0.75 };
const TOPPING_IMG = { maxSide: 200, quality: 0.8 };
const SIDE_IMG = { maxSide: 480, quality: 0.75 };
const PROMO_IMG = { maxSide: 720, quality: 0.75 };
const MAX_IMAGE_CHARS = 400000; // el navegador guarda ~5 MB en total

const state = {
  user: null,          // { id, email, name, role } después de iniciar sesión
  tab: (() => { try { const t = localStorage.getItem(TAB_KEY); return TABS.includes(t) ? t : "caja"; } catch { return "caja"; } })(),
  products: [],
  toppings: [],
  sides: [],           // acompañantes / aperitivos
  promos: [],          // promociones del menú
  catalogReady: false,
  recent: [],          // pedidos de las últimas 24 h (tiempo real)
  recentReady: false,
  knownIds: null,      // para resaltar pedidos nuevos
  prepSeen: null,      // pedidos que ya entraron a preparación (para el sonido)
  freshIds: new Set(),
  parking: {
    active: [],        // vehículos dentro (tiempo real)
    ready: false,
    rate: null,        // tarifa fija configurada
    today: null,       // { revenue, count } recaudo de hoy
    report: null       // resultados de la búsqueda de historial
  },
  cajaFilter: "pendientes",
  cajaQuery: "",
  history: { results: null, loading: false },
  supplies: [],        // insumos (costeo e inventario)
  supplySig: null,     // firma de los insumos sin campos de inventario
  overheads: [],       // gastos generales del negocio (arriendo, servicios, nómina…)
  costingReady: false,
  costTab: "resumen",
  costMonth: dateKey(new Date()).slice(0, 7), // mes del resumen de costeo (AAAA-MM)
  recipeEditors: new Set(), // editores de receta abiertos (se refrescan si cambian insumos)
  derivedSynced: false,
  unsubs: []
};

const suppliesById = () => new Map(state.supplies.map(s => [s.id, s]));
/** Costeo de un tamaño: costo directo (receta + merma), margen bruto y precio. */
const sizeCost = s => Costing.productCost({ price: s.price, costing: s.costing || {} }, suppliesById());
const sizeCostOf = (_p, s) => sizeCost(s);
const toppingCostOf = t => Costing.toppingCost(t, suppliesById());

// =====================================================================
// ARRANQUE: inicio de sesión y módulos según el rol
// =====================================================================
/** ¿El usuario actual puede abrir este módulo? (el servidor también lo valida) */
const can = tab => !!state.user && (ROLE_TABS[state.user.role] || []).includes(tab);
const authListeners = [];

async function start() {
  $("#bootScreen").hidden = true;
  const user = await window.Auth.require({
    roles: Object.keys(ROLE_TABS),
    title: "Portal del personal",
    subtitle: "Ingresa con el correo y la contraseña que te asignó el administrador."
  });
  state.user = user;
  // Solo se muestran los módulos del rol
  $$(".nav-btn").forEach(b => { b.hidden = !can(b.dataset.tab); });
  $("#whoName").textContent = user.name || user.email;
  $("#whoRole").textContent = window.Auth.roleLabel(user.role);
  $("#logoutBtn").addEventListener("click", () => {
    if (confirm("¿Cerrar sesión?")) window.Auth.logout();
  });
  $("#shell").hidden = false;
  startListeners();
  authListeners.forEach(fn => { try { fn(user); } catch (err) { console.error(err); } });
  showTab(can(state.tab) ? state.tab : ROLE_TABS[user.role][0]);
}

// =====================================================================
// DATOS EN TIEMPO REAL
// =====================================================================
function startListeners() {
  const role = state.user.role;
  // Catálogo, insumos y gastos generales: solo el administrador los usa
  if (role === "admin") startAdminListeners();
  // Parqueadero: admin y cajero
  if (can("parqueadero")) startParkingListeners();
  // Pedidos recientes: caja y preparación
  startOrderListener();
}

function startAdminListeners() {
  state.unsubs.push(watchCatalog(({ products, toppings, sides, promos, ready, stockOnly }) => {
    state.products = products;
    state.toppings = toppings;
    state.sides = sides;
    state.promos = promos;
    state.catalogReady = ready;
    emit("catalog");
    if (stockOnly) return; // solo cambió el inventario (ventas): no hace falta redibujar
    if (ready && ["productos", "toppings", "historial", "costeo", "acompanantes", "promos"].includes(state.tab)) renderCurrentTab();
    maybeInitialSync();
  }, onListenError, { ignoreStock: false }));

  // Insumos (costeo e inventario) y gastos generales
  let sReady = false, oReady = false;
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), "es");
  state.unsubs.push(onSnapshot(collection(db, COL.supplies), snap => {
    state.supplies = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort(byName);
    sReady = true; state.costingReady = sReady && oReady;
    emit("supplies");
    // Las ventas solo cambian el stock: el costeo se recalcula si cambió algo más
    const sig = catalogSig(state.supplies);
    if (sig === state.supplySig) return;
    state.supplySig = sig;
    onCostingDataChange();
  }, onListenError));
  state.unsubs.push(onSnapshot(collection(db, COL.overheads), snap => {
    state.overheads = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort(byName);
    oReady = true; state.costingReady = sReady && oReady;
    onCostingDataChange();
  }, onListenError));
}

/** Parqueadero: vehículos dentro y tarifa. */
function startParkingListeners() {
  state.unsubs.push(onSnapshot(query(collection(db, COL.parking), where("exited", "==", false)), snap => {
    const ms = r => toDate(r.entryAt)?.getTime() || 0;
    state.parking.active = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => ms(a) - ms(b));
    state.parking.ready = true;
    setBadge("parqueadero", state.parking.active.filter(r => !r.paid).length);
    if (state.tab === "parqueadero") { renderParkingActive(); refreshParkingToday(); }
  }, onListenError));
  state.unsubs.push(onSnapshot(collection(db, COL.settings), snap => {
    const s = snap.docs.find(d => d.id === "parking");
    state.parking.rate = s ? s.data().rate ?? null : null;
    if (state.tab === "parqueadero" && document.activeElement?.id !== "pkRate") {
      const inp = $("#pkRate");
      if (inp) inp.value = isValidPrice(state.parking.rate) ? thousands(state.parking.rate) : "";
      const ro = $("#pkRateRo");
      if (ro) ro.textContent = isValidPrice(state.parking.rate) && state.parking.rate > 0 ? money(state.parking.rate) : "Sin configurar";
    }
  }, onListenError));
}

/** Pedidos de las últimas 24 h en tiempo real (caja, preparación y sonidos). */
function startOrderListener() {
  const since = Timestamp.fromDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const q = query(collection(db, COL.orders), where("createdAt", ">=", since), orderBy("createdAt", "desc"));
  state.unsubs.push(onSnapshot(q, snap => {
    const orders = snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    if (state.knownIds) {
      const arrived = orders.filter(o => !state.knownIds.has(o.id));
      arrived.forEach(o => state.freshIds.add(o.id));
      if (can("caja") && arrived.some(o => !o.paid)) playNewOrderSound();
    }
    state.knownIds = new Set(orders.map(o => o.id));
    // Sonido de Sonic cuando entra un pedido nuevo a preparación
    const prepIds = orders.filter(o => o.paid && !o.prepared).map(o => o.id);
    if (state.prepSeen) {
      const queued = prepIds.filter(id => !state.prepSeen.has(id));
      queued.forEach(id => state.freshIds.add(id));
      if (queued.length) playSound(prepSound);
    } else {
      state.prepSeen = new Set();
    }
    prepIds.forEach(id => state.prepSeen.add(id));
    state.recent = orders;
    state.recentReady = true;
    updateBadges();
    if (state.tab === "caja") renderCajaList();
    if (state.tab === "prep") renderPrep();
    if (state.freshIds.size) setTimeout(() => state.freshIds.clear(), 4000);
  }, onListenError));
}

// ---------- Avisos entre módulos (inventario escucha catálogo, insumos y extras) ----------
const kitListeners = {};
function on(name, fn) { (kitListeners[name] || (kitListeners[name] = [])).push(fn); }
function emit(name) {
  (kitListeners[name] || []).forEach(fn => { try { fn(); } catch (err) { console.error(err); } });
}

// ---------- Sonidos: pedido nuevo (caja) y pedido a preparación (Sonic) ----------
// Los navegadores bloquean el audio hasta que la persona toca la página una vez;
// por eso se "desbloquea" con el primer clic o tecla.
const newOrderSound = new Audio("sounds/nuevo-pedido.mp3");
const prepSound = new Audio("sounds/sonic-ring.mp3");
[newOrderSound, prepSound].forEach(a => { a.preload = "auto"; });
let soundUnlocked = false;
let soundHintShown = false;
function unlockSound() {
  if (soundUnlocked) return;
  Promise.all([newOrderSound, prepSound].map(a => {
    a.muted = true;
    return a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; })
      .catch(err => { a.muted = false; throw err; });
  })).then(() => { soundUnlocked = true; }).catch(() => { /* se reintenta en el próximo toque */ });
}
["pointerdown", "keydown"].forEach(ev => document.addEventListener(ev, unlockSound, { capture: true }));

function playNewOrderSound() { playSound(newOrderSound); }

function playSound(audio) {
  audio.currentTime = 0;
  audio.play().catch(() => {
    if (soundHintShown) return;
    soundHintShown = true;
    toast("🔔 Toca cualquier parte de la página para activar el sonido de pedidos nuevos.", { duration: 6000 });
  });
}

function stopListeners() {
  state.unsubs.forEach(u => u());
  state.unsubs = [];
  state.recent = [];
  state.recentReady = false;
  state.knownIds = null;
  state.prepSeen = null;
  state.catalogReady = false;
}

function onListenError(err) {
  console.error(err);
  const msg = friendlyError(err);
  $("#globalError").textContent = msg;
  $("#globalError").hidden = false;
}

function updateBadges() {
  const pending = state.recent.filter(o => !o.paid).length;
  const toPrep = state.recent.filter(o => o.paid && !o.prepared).length;
  setBadge("caja", pending);
  setBadge("prep", toPrep);
  document.title = (pending + toPrep ? `(${pending + toPrep}) ` : "") + "Granizados · Personal";
}
function setBadge(tab, n) {
  $$(`[data-badge="${tab}"]`).forEach(el => { el.textContent = n; el.hidden = n === 0; });
}

// =====================================================================
// NAVEGACIÓN
// =====================================================================
function showTab(tab) {
  // Un módulo que el rol no tiene no se abre (el servidor tampoco entrega sus datos)
  if (!can(tab)) tab = (ROLE_TABS[state.user?.role] || ["prep"])[0];
  state.tab = tab;
  try { localStorage.setItem(TAB_KEY, tab); } catch { /* nada */ }
  $$(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".view").forEach(v => { v.hidden = v.id !== `view-${tab}`; });
  renderCurrentTab(true);
}

function renderCurrentTab(full = false) {
  switch (state.tab) {
    case "caja": if (full || !$("#cajaSearch")) renderCaja(); else renderCajaList(); break;
    case "prep": renderPrep(); break;
    case "historial": if (full || !$("#histForm")) renderHistory(); else refreshHistoryProductOptions(); break;
    case "productos": renderProducts(); break;
    case "toppings": renderToppings(); break;
    case "acompanantes": renderSides(); break;
    case "promos": renderPromos(); break;
    case "costeo": renderCosteo(); break;
    case "parqueadero": renderParking(); break;
    default: tabModules[state.tab]?.(full);
  }
}

// =====================================================================
// COMPONENTES DE PEDIDO
// =====================================================================
function orderSearchText(o) {
  const d = toDate(o.createdAt);
  return normalize([
    o.number, `#${o.number}`, o.customerName,
    ...(o.items || []).map(i => `${i.name} ${i.sizeName || ""}`),
    ...(o.sides || []).map(s => s.name),
    PAYMENT_LABELS[o.paymentMethod] || "",
    d ? `${dateLabel(d)} ${dateKey(d)} ${timeLabel(d)}` : ""
  ].join(" "));
}

function matchesQuery(o, q) {
  const tokens = normalize(q).replace(/^#/, "").split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const hay = orderSearchText(o);
  return tokens.every(t => hay.includes(t));
}

function paymentBlock(o) {
  if (!o.paid) {
    return `
      <div class="o-pay pending">
        <div class="o-pay-row"><span>FORMA DE PAGO</span><strong>${(PAYMENT_LABELS[o.paymentMethod] || "").toUpperCase()}</strong></div>
        <div class="o-pay-status">⏳ Pago pendiente${o.paymentMethod === "transferencia" ? " — verificar transferencia" : ""}</div>
        <button class="btn btn-lg btn-block" data-act="pay" data-id="${esc(o.id)}">CONFIRMAR PAGO</button>
      </div>`;
  }
  const paidAt = toDate(o.paidAt);
  const method = o.paidMethod || o.paymentMethod;
  return `
    <div class="o-pay paid">
      <div class="o-pay-status">✓ PAGADO ${paidAt ? `· ${timeLabel(paidAt)}` : ""} · ${esc(PAYMENT_LABELS[method] || "")}</div>
      ${method !== o.paymentMethod ? `<div class="o-pay-note">El cliente había seleccionado ${esc(PAYMENT_LABELS[o.paymentMethod])}</div>` : ""}
      ${Number.isInteger(o.cashReceived) ? `
        <div class="o-pay-row"><span>Efectivo recibido</span><strong>${money(o.cashReceived)}</strong></div>
        <div class="o-pay-row"><span>Cambio</span><strong>${money(o.change)}</strong></div>` : ""}
      <div class="o-prep ${o.prepared ? "done" : ""}">${o.prepared
        ? `✓ Preparado ${toDate(o.preparedAt) ? `· ${timeLabel(toDate(o.preparedAt))}` : ""}`
        : "🍧 En preparación"}</div>
    </div>`;
}

function orderCard(o, { showCost = false } = {}) {
  const d = toDate(o.createdAt);
  const costLine = showCost && Number.isFinite(o.costTotal)
    ? `<div class="o-cost">Costo registrado al vender: <b>${moneyDec(o.costTotal)}</b> · Ganancia: <b>${moneyDec(o.total - o.costTotal)}</b></div>`
    : "";
  return `
    <article class="order ${o.paid ? "is-paid" : "is-pending"} ${state.freshIds.has(o.id) ? "flash" : ""}">
      <header class="o-head">
        <div>
          <div class="o-no">PEDIDO #${o.number}</div>
          <div class="o-time">${timeLabel(d)} · ${dateLabel(d)}</div>
        </div>
        <span class="pay-badge ${esc(o.paymentMethod)}">${o.paymentMethod === "efectivo" ? "💵" : "📲"} ${esc((PAYMENT_LABELS[o.paymentMethod] || "").toUpperCase())}</span>
      </header>
      <div class="o-client"><span>CLIENTE</span><strong>${esc(o.customerName)}</strong></div>
      <div class="o-items">${renderItemsDetail(o.items || [])}${renderSidesDetail(o.sides)}</div>
      <div class="o-total"><span>TOTAL</span><strong>${money(o.total)}</strong></div>
      ${costLine}
      ${paymentBlock(o)}
    </article>`;
}

function findOrder(id) {
  return state.recent.find(o => o.id === id) || (state.history.results || []).find(o => o.id === id) || null;
}

// Acciones sobre pedidos (delegación global)
document.addEventListener("click", e => {
  const btn = e.target.closest("[data-act]");
  if (!btn || !state.user) return;
  const { act, id } = btn.dataset;
  if (act === "pay") {
    const o = findOrder(id);
    if (o) openPaymentModal(o);
  } else if (act === "prepared") {
    markPrepared(id, btn);
  }
});

// =====================================================================
// CAJA
// =====================================================================
function renderCaja() {
  $("#view-caja").innerHTML = `
    <div class="toolbar caja-toolbar">
      <div class="search-wrap">
        <span class="search-icon">🔎</span>
        <input id="cajaSearch" class="search" type="search" autocomplete="off" spellcheck="false"
          placeholder="Buscar pedido…" value="${esc(state.cajaQuery)}">
      </div>
      <div class="chips" id="cajaChips">
        <button data-f="pendientes">Por pagar</button>
        <button data-f="pagados">Pagados</button>
        <button data-f="todos">Todos</button>
      </div>
    </div>
    <div id="cajaList" class="orders-grid"></div>`;

  const input = $("#cajaSearch");
  input.addEventListener("input", () => { state.cajaQuery = input.value; renderCajaList(); });
  input.addEventListener("keydown", e => { if (e.key === "Escape") { input.value = ""; state.cajaQuery = ""; renderCajaList(); } });
  $("#cajaChips").addEventListener("click", e => {
    const b = e.target.closest("[data-f]");
    if (!b) return;
    state.cajaFilter = b.dataset.f;
    renderCajaList();
  });
  renderCajaList();
  if (window.matchMedia("(min-width: 700px)").matches) input.focus();
}

function renderCajaList() {
  const list = $("#cajaList");
  if (!list) return;
  $$("#cajaChips [data-f]").forEach(b => b.classList.toggle("active", b.dataset.f === state.cajaFilter && !state.cajaQuery.trim()));
  if (!state.recentReady) { list.innerHTML = `<div class="loading-screen"><div class="spinner dark"></div></div>`; return; }

  const q = state.cajaQuery.trim();
  let orders = state.recent;
  if (q) {
    // Con búsqueda se buscan todos los pedidos recientes (pagados o no)
    orders = orders.filter(o => matchesQuery(o, q));
  } else if (state.cajaFilter === "pendientes") {
    orders = orders.filter(o => !o.paid);
  } else if (state.cajaFilter === "pagados") {
    orders = orders.filter(o => o.paid);
  }

  if (!orders.length) {
    list.innerHTML = `<div class="empty-box">${q
      ? `No hay pedidos recientes para “${esc(q)}”. Prueba en <b>Historial</b>.`
      : state.cajaFilter === "pendientes" ? "No hay pedidos pendientes de pago." : "No hay pedidos."}</div>`;
    return;
  }
  list.innerHTML = orders.map(orderCard).join("");
}

// ---------- Modal de pago ----------
function quickAmounts(total) {
  const set = new Set([total]);
  for (const step of [1000, 5000, 10000, 20000, 50000, 100000]) set.add(Math.ceil(total / step) * step);
  return [...set].filter(v => v >= total).sort((a, b) => a - b).slice(0, 5);
}

function thousands(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "."); }

function bindMoneyInput(input, onChange) {
  input.addEventListener("input", () => {
    const n = parseMoney(input.value);
    input.value = Number.isNaN(n) ? "" : thousands(n);
    onChange?.(n);
  });
}

function openPaymentModal(order) {
  if (order.paid) { toast("Este pedido ya está pagado."); return; }
  let method = order.paymentMethod;
  const total = order.total;

  const body = () => `
    <div class="pay-modal">
      <div class="pm-client">#${order.number} · <strong>${esc(order.customerName)}</strong></div>
      <div class="pm-total"><span>TOTAL</span><strong>${money(total)}</strong></div>
      <div class="seg" role="group" aria-label="Forma de pago">
        ${PAYMENT_METHODS.map(m => `<button type="button" data-m="${m}" class="${m === method ? "active" : ""}">${m === "efectivo" ? "💵" : "📲"} ${PAYMENT_LABELS[m].toUpperCase()}</button>`).join("")}
      </div>
      ${method !== order.paymentMethod ? `<p class="pm-warn">El cliente seleccionó ${PAYMENT_LABELS[order.paymentMethod]}. Se registrará como ${PAYMENT_LABELS[method]}.</p>` : ""}
      ${method === "efectivo" ? `
        <label class="field">
          <span>EFECTIVO RECIBIDO</span>
          <div class="money-input"><span>$</span><input id="cashInput" inputmode="numeric" autocomplete="off" placeholder="0"></div>
        </label>
        <div class="quick">${quickAmounts(total).map(v => `<button type="button" data-q="${v}">${v === total ? "Exacto" : money(v)}</button>`).join("")}</div>
        <div class="pm-change"><span>CAMBIO</span><strong id="changeOut">—</strong></div>
        <p class="pm-error" id="cashError" hidden>El valor recibido es menor al total.</p>
      ` : `
        <div class="pm-transfer">
          <p><b>Verifica que la transferencia por ${money(total)} fue recibida</b> antes de confirmar el pago.</p>
        </div>
      `}
    </div>`;

  openModal({
    title: "Registrar pago",
    body: body(),
    footer: `<button class="btn btn-ghost" data-close>Cancelar</button>
             <button class="btn btn-ok btn-lg" id="confirmPayBtn">CONFIRMAR PAGO</button>`,
    onMount: mount
  });

  function mount(root) {
    const confirmBtn = root.querySelector("#confirmPayBtn");
    const cashInput = root.querySelector("#cashInput");
    const received = () => (cashInput ? parseMoney(cashInput.value) : NaN);

    const update = () => {
      if (method !== "efectivo") { confirmBtn.disabled = false; return; }
      const r = received();
      const ok = Number.isInteger(r) && r >= total;
      root.querySelector("#changeOut").textContent = ok ? money(r - total) : "—";
      root.querySelector("#cashError").hidden = !(Number.isInteger(r) && r < total);
      confirmBtn.disabled = !ok;
    };

    root.querySelector(".seg").addEventListener("click", e => {
      const b = e.target.closest("[data-m]");
      if (!b || b.dataset.m === method) return;
      method = b.dataset.m;
      root.querySelector(".modal-body").innerHTML = body();
      mount(root);
    });
    if (cashInput) {
      bindMoneyInput(cashInput, update);
      root.querySelector(".quick").addEventListener("click", e => {
        const b = e.target.closest("[data-q]");
        if (!b) return;
        cashInput.value = thousands(Number(b.dataset.q));
        update();
      });
      cashInput.addEventListener("keydown", e => { if (e.key === "Enter" && !confirmBtn.disabled) confirmBtn.click(); });
      setTimeout(() => cashInput.focus(), 50);
    }
    update();

    confirmBtn.onclick = async () => {
      if (confirmBtn.disabled) return;
      let cash = null;
      if (method === "efectivo") {
        cash = received();
        if (!Number.isInteger(cash) || cash < total) { update(); return; }
      }
      confirmBtn.disabled = true;
      confirmBtn.innerHTML = `<span class="spinner"></span> Guardando…`;
      try {
        await confirmPayment(order.id, method, cash);
        closeModal();
        toast(`Pago confirmado · #${order.number} pasa a preparación`, {
          type: "ok", duration: 6000,
          action: { label: "Deshacer", onClick: () => undoPayment(order.id) }
        });
        if (state.tab === "historial") runHistorySearch();
      } catch (err) {
        console.error(err);
        toast(err.message && !err.code ? err.message : friendlyError(err), { type: "error", duration: 5000 });
        confirmBtn.disabled = false;
        confirmBtn.textContent = "CONFIRMAR PAGO";
      }
    };
  }
}

/**
 * Confirma el pago en el servidor. En la misma transacción se descuentan del
 * inventario los ingredientes de cada receta, los toppings y los acompañantes.
 */
async function confirmPayment(orderId, method, cashReceived) {
  await call("/api/gz/pay", { orderId: String(orderId), method, cashReceived: method === "efectivo" ? cashReceived : null });
}

async function undoPayment(orderId) {
  try {
    await call("/api/gz/unpay", { orderId: String(orderId) });
    toast("Pago anulado");
    if (state.tab === "historial") runHistorySearch();
  } catch (err) {
    toast(err.message && !err.code ? err.message : friendlyError(err), { type: "error" });
  }
}

// =====================================================================
// PREPARACIÓN
// =====================================================================
function renderPrep() {
  const view = $("#view-prep");
  if (!state.recentReady) { view.innerHTML = `<div class="loading-screen"><div class="spinner dark"></div></div>`; return; }
  const millis = o => toDate(o.paidAt)?.getTime() || 0;
  const queue = state.recent.filter(o => o.paid && !o.prepared).sort((a, b) => millis(a) - millis(b));
  if (!queue.length) {
    view.innerHTML = `<div class="empty-box big">🍧<br>No hay pedidos por preparar.</div>`;
    return;
  }
  view.innerHTML = `
    <div class="tickets">
      ${queue.map(o => `
        <article class="ticket ${state.freshIds.has(o.id) ? "flash" : ""}">
          <header class="t-head">
            <div class="t-no">PEDIDO #${o.number}</div>
            <div class="t-time">Pagado ${timeLabel(toDate(o.paidAt))}</div>
          </header>
          <div class="t-client"><span>CLIENTE</span><strong>${esc(o.customerName)}</strong></div>
          ${(o.items || []).map(item => `
            <section class="t-prod">
              <h3>${esc(item.name)}${item.sizeName ? ` <em class="t-size">${esc(item.sizeName)}</em>` : ""} <span>× ${item.quantity}</span></h3>
              ${item.units.map((u, i) => `
                <div class="t-unit">
                  <div class="t-unit-h">Unidad ${i + 1}</div>
                  ${item.sizeName ? `<div>Tamaño: <b>${esc(item.sizeName)}</b></div>` : `<div>Base: <b>${esc(item.name)}</b></div>`}
                  ${u.mix ? `<div class="t-mix">🌀 <b>MODO MIX</b> — preguntar al cliente qué sabores revolver al entregar</div>` : ""}
                  ${u.toppings.length
                    ? `<div class="t-tops-h">Toppings:</div><ul>${u.toppings.map(t => `<li>${esc(t.name)}</li>`).join("")}</ul>`
                    : `<div class="t-none">Sin toppings</div>`}
                </div>`).join("")}
            </section>`).join("")}
          ${(o.sides || []).length ? `
            <section class="t-sides">
              <h3>🍟 Acompañantes <small>(no son granizados)</small></h3>
              <ul>${o.sides.map(s => `<li><span>${s.quantity} ×</span> ${esc(s.name)}</li>`).join("")}</ul>
            </section>` : ""}
          <button class="btn btn-ok btn-lg btn-block" data-act="prepared" data-id="${esc(o.id)}">✓ PEDIDO PREPARADO</button>
        </article>`).join("")}
    </div>`;
}

async function markPrepared(orderId, btn) {
  btn.disabled = true;
  try {
    await call("/api/gz/prepared", { orderId: String(orderId), prepared: true });
    const o = findOrder(orderId);
    toast(`Pedido #${o ? o.number : orderId} preparado`, {
      type: "ok", duration: 6000,
      action: {
        label: "Deshacer",
        onClick: () => call("/api/gz/prepared", { orderId: String(orderId), prepared: false })
          .catch(err => toast(err.message && !err.code ? err.message : friendlyError(err), { type: "error" }))
      }
    });
  } catch (err) {
    btn.disabled = false;
    toast(err.message && !err.code ? err.message : friendlyError(err), { type: "error" });
  }
}

// =====================================================================
// HISTORIAL
// =====================================================================
function renderHistory() {
  const today = dateKey(new Date());
  $("#view-historial").innerHTML = `
    <form id="histForm" class="hist-form panel">
      <label class="field"><span>Buscar</span>
        <input id="hQ" type="search" autocomplete="off"></label>
      <label class="field"><span>Desde</span><input id="hFrom" type="date" value="${today}" max="${today}"></label>
      <label class="field"><span>Hasta</span><input id="hTo" type="date" value="${today}" max="${today}"></label>
      <label class="field"><span>Forma de pago</span>
        <select id="hPay"><option value="">Todas</option>${PAYMENT_METHODS.map(m => `<option value="${m}">${PAYMENT_LABELS[m]}</option>`).join("")}</select></label>
      <label class="field"><span>Producto</span><select id="hProd"></select></label>
      <button class="btn" type="submit" id="hBtn">Buscar</button>
    </form>
    <div id="histSummary" class="subtle"></div>
    <div id="histList" class="hist-list"></div>`;
  refreshHistoryProductOptions();
  $("#histForm").addEventListener("submit", e => { e.preventDefault(); runHistorySearch(); });
  runHistorySearch();
}

function refreshHistoryProductOptions() {
  const sel = $("#hProd");
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = `<option value="">Todos</option>` +
    state.products.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  sel.value = state.products.some(p => p.id === current) ? current : "";
}

async function runHistorySearch() {
  if (!$("#histForm")) return;
  const q = $("#hQ").value.trim();
  const fromStr = $("#hFrom").value;
  const toStr = $("#hTo").value;
  const pay = $("#hPay").value;
  const productId = $("#hProd").value;
  const list = $("#histList");
  const btn = $("#hBtn");

  if (!fromStr || !toStr || fromStr > toStr) {
    toast("Revisa el rango de fechas.", { type: "error" });
    return;
  }
  const [fy, fm, fd] = fromStr.split("-").map(Number);
  const [ty, tm, td] = toStr.split("-").map(Number);
  const from = new Date(fy, fm - 1, fd);
  const to = new Date(ty, tm - 1, td + 1);

  btn.disabled = true;
  list.innerHTML = `<div class="loading-screen"><div class="spinner dark"></div></div>`;
  try {
    const snap = await getDocs(query(collection(db, COL.orders),
      where("createdAt", ">=", Timestamp.fromDate(from)),
      where("createdAt", "<", Timestamp.fromDate(to)),
      orderBy("createdAt", "desc"), limit(3000)));
    const map = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data({ serverTimestamps: "estimate" }) }]));

    // Número de pedido: búsqueda directa sin importar la fecha
    const num = q.replace(/^#/, "");
    let direct = null;
    if (/^\d+$/.test(num)) {
      const ds = await getDoc(doc(db, COL.orders, num));
      if (ds.exists()) direct = { id: ds.id, ...ds.data({ serverTimestamps: "estimate" }) };
    }

    let results = [...map.values()].filter(o =>
      matchesQuery(o, q) &&
      (!pay || o.paymentMethod === pay) &&
      (!productId || (o.items || []).some(i => i.productId === productId)));
    if (direct && !results.some(o => o.id === direct.id) &&
        (!pay || direct.paymentMethod === pay) &&
        (!productId || (direct.items || []).some(i => i.productId === productId))) {
      results.unshift(direct);
    }
    state.history.results = results;
    renderHistoryResults();
  } catch (err) {
    console.error(err);
    list.innerHTML = `<div class="empty-box">${esc(friendlyError(err))}</div>`;
  } finally {
    btn.disabled = false;
  }
}

function renderHistoryResults() {
  const results = state.history.results || [];
  const total = results.reduce((s, o) => s + (o.total || 0), 0);
  $("#histSummary").textContent = results.length
    ? `${results.length} pedido${results.length === 1 ? "" : "s"} · ${money(total)}`
    : "";
  $("#histList").innerHTML = results.length
    ? results.map(o => {
        const d = toDate(o.createdAt);
        return `
          <details class="hist-row">
            <summary>
              <span class="h-no">#${o.number}</span>
              <span class="h-date">${dateLabel(d)} ${timeLabel(d)}</span>
              <span class="h-name">${esc(o.customerName)}</span>
              <span class="h-pay">${esc(PAYMENT_LABELS[o.paymentMethod] || "")}</span>
              <span class="h-status ${o.paid ? "ok" : "pend"}">${o.paid ? (o.prepared ? "Pagado · Preparado" : "Pagado") : "Sin pagar"}</span>
              <span class="h-total">${money(o.total)}</span>
            </summary>
            ${orderCard(o, { showCost: true })}
          </details>`;
      }).join("")
    : `<div class="empty-box">No se encontraron pedidos con esos criterios.</div>`;
}

// =====================================================================
// IMÁGENES (se comprimen en el navegador y se guardan en la base de datos)
// =====================================================================
async function imageFileToDataUrl(file, { maxSide, quality }) {
  if (!file || !file.type.startsWith("image/")) throw new Error("El archivo seleccionado no es una imagen.");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("No se pudo leer la imagen."));
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    let q = quality;
    let out = canvas.toDataURL("image/jpeg", q);
    while (out.length > MAX_IMAGE_CHARS && q > 0.35) {
      q -= 0.1;
      out = canvas.toDataURL("image/jpeg", q);
    }
    if (out.length > MAX_IMAGE_CHARS) throw new Error("La imagen es demasiado pesada. Usa una más pequeña.");
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function isValidImageValue(v) {
  return v === "" || /^https:\/\/\S+$/i.test(v) || /^data:image\/(jpeg|png|webp|gif|svg\+xml)[;,]/i.test(v);
}

/** Bloque reutilizable de imagen (vista previa + subir archivo + enlace + quitar). */
function imagePicker(current, label) {
  return `
    <div class="img-picker">
      <div class="img-preview" id="imgPreview">${current ? `<img src="${esc(current)}" alt="">` : "<span>Sin imagen</span>"}</div>
      <div class="img-actions">
        <span class="field-label">${label}</span>
        <label class="btn btn-ghost btn-sm file-btn">📷 Cargar imagen<input type="file" id="imgFile" accept="image/*" hidden></label>
        <input id="imgUrl" type="url" placeholder="o pega un enlace https://…" value="${current && !current.startsWith("data:") ? esc(current) : ""}">
        <button type="button" class="btn btn-danger btn-sm" id="imgRemove" ${current ? "" : "hidden"}>Quitar imagen</button>
        <small class="field-hint" id="imgStatus"></small>
      </div>
    </div>`;
}

function bindImagePicker(root, initial, opts) {
  let value = initial || "";
  const preview = root.querySelector("#imgPreview");
  const urlInput = root.querySelector("#imgUrl");
  const removeBtn = root.querySelector("#imgRemove");
  const status = root.querySelector("#imgStatus");
  const show = () => {
    preview.innerHTML = value ? `<img src="${esc(value)}" alt="">` : "<span>Sin imagen</span>";
    removeBtn.hidden = !value;
  };
  root.querySelector("#imgFile").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    status.textContent = "Procesando imagen…";
    try {
      value = await imageFileToDataUrl(file, opts);
      urlInput.value = "";
      status.textContent = `Imagen lista (${Math.round(value.length * 0.75 / 1024)} KB)`;
      show();
    } catch (err) {
      status.textContent = err.message;
    }
    e.target.value = "";
  });
  urlInput.addEventListener("change", () => {
    const v = urlInput.value.trim();
    if (!v) return;
    if (!/^https:\/\/\S+$/i.test(v)) { status.textContent = "El enlace debe comenzar con https://"; return; }
    value = v;
    status.textContent = "";
    show();
  });
  removeBtn.addEventListener("click", () => { value = ""; urlInput.value = ""; status.textContent = ""; show(); });
  return () => value;
}

// =====================================================================
// PRODUCTOS
// =====================================================================
/** Etiqueta corta de costo y margen para las listas. */
function costTag(p) {
  if (!state.costingReady) return "";
  const sizes = productSizes(p);
  const rs = sizes.map(s => sizeCostOf(p, s)).filter(r => r.hasRecipe);
  if (!rs.length) return ` <small class="cost-tag none">sin costeo</small>`;
  const m = rs.map(r => r.realMargin).filter(Number.isFinite);
  const lo = Math.min(...m), hi = Math.max(...m);
  const range = !m.length ? "—" : Math.abs(hi - lo) < 0.005 ? pct(lo) : `${pct(lo)} – ${pct(hi)}`;
  const missing = sizes.length - rs.length;
  return ` <small class="cost-tag ${rs.some(r => r.profit < 0) ? "bad" : ""}">margen ${range}${missing ? ` · ${missing} tamaño(s) sin costeo` : ""}</small>`;
}
function toppingCostTag(t) {
  if (!state.costingReady) return "";
  const r = toppingCostOf(t);
  if (!r.hasRecipe) return ` <small class="cost-tag none">sin costeo</small>`;
  return ` <small class="cost-tag ${r.profit < 0 ? "bad" : ""}">costo ${moneyDec(r.cost)} · margen ${pct(r.margin)}</small>`;
}
function renderProducts() {
  const view = $("#view-productos");
  if (!state.catalogReady) { view.innerHTML = `<div class="loading-screen"><div class="spinner dark"></div></div>`; return; }
  const tName = new Map(state.toppings.map(t => [t.id, t.name]));
  view.innerHTML = `
    <div class="toolbar">
      <h2 class="view-title">Productos <small>${state.products.length}</small></h2>
      <button class="btn" id="newProductBtn">+ Nuevo producto</button>
    </div>
    ${state.products.length ? `
    <div class="cat-list">
      ${state.products.map(p => {
        const tops = (p.toppingIds || []).filter(id => tName.has(id));
        return `
        <article class="cat-item ${p.active === false ? "inactive" : ""}">
          <div class="ci-img">${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : "🍧"}</div>
          <div class="ci-main">
            <div class="ci-name">${esc(p.name)}</div>
            <div class="ci-meta">${esc(p.category || "Sin categoría")} · Orden ${Number(p.order) || 0} · ${tops.length} topping${tops.length === 1 ? "" : "s"}${Number(p.maxToppings) > 0 ? ` (máx. ${Number(p.maxToppings)})` : ""}${p.allowMix ? " · 🌀 MIX" : ""}</div>
            <div class="ci-sizes">${productSizes(p).map(s => `<span><b>${esc(s.name)}</b> ${money(s.price)}</span>`).join("")}</div>
            <div>${costTag(p)}</div>
          </div>
          <div class="ci-actions">
            <label class="switch" title="Disponible">
              <input type="checkbox" data-toggle-product="${esc(p.id)}" ${p.active !== false ? "checked" : ""}>
              <span></span><em>${p.active !== false ? "Activo" : "Inactivo"}</em>
            </label>
            <button class="btn btn-ghost btn-sm" data-edit-product="${esc(p.id)}">Editar</button>
          </div>
        </article>`;
      }).join("")}
    </div>` : `<div class="empty-box">Aún no hay productos.</div>`}`;

  $("#newProductBtn").onclick = () => openProductModal(null);
  view.querySelectorAll("[data-edit-product]").forEach(b => {
    b.onclick = () => openProductModal(state.products.find(p => p.id === b.dataset.editProduct));
  });
  view.querySelectorAll("[data-toggle-product]").forEach(inp => {
    inp.onchange = async () => {
      inp.disabled = true;
      try {
        await updateDoc(doc(db, COL.products, inp.dataset.toggleProduct), { active: inp.checked, updatedAt: serverTimestamp() });
        toast(inp.checked ? "Producto activado" : "Producto desactivado", { type: "ok", duration: 1800 });
      } catch (err) {
        inp.checked = !inp.checked;
        inp.disabled = false;
        toast(friendlyError(err), { type: "error" });
      }
    };
  });
}

function openProductModal(product, { focusCosting = false } = {}) {
  const p = product || {};
  const isNew = !product;
  const categories = [...new Set(state.products.map(x => (x.category || "").trim()).filter(Boolean))];
  const selected = new Set(p.toppingIds || []);
  const nextOrder = state.products.reduce((m, x) => Math.max(m, Number(x.order) || 0), 0) + 1;

  openModal({
    title: isNew ? "Nuevo producto" : "Editar producto",
    wide: true,
    body: `
      <form id="productForm" class="form-grid" novalidate>
        <label class="field span2"><span>Nombre *</span>
          <input name="name" maxlength="60" required value="${esc(p.name || "")}"></label>
        <label class="field span2"><span>Descripción</span>
          <textarea name="description" maxlength="200" rows="2">${esc(p.description || "")}</textarea></label>
        <label class="field"><span>Categoría</span>
          <input name="category" maxlength="40" list="catOptions" value="${esc(p.category || "")}">
          <datalist id="catOptions">${categories.map(c => `<option value="${esc(c)}">`).join("")}</datalist></label>
        <label class="field"><span>Orden de aparición</span>
          <input name="order" type="number" min="0" max="9999" step="1" value="${Number.isFinite(Number(p.order)) && p.order !== undefined ? Number(p.order) : nextOrder}"></label>
        <div class="field"><span>Disponibilidad</span>
          <label class="switch big"><input type="checkbox" name="active" ${p.active !== false ? "checked" : ""}><span></span><em>Disponible en el menú</em></label></div>
        <div class="span2">${imagePicker(p.image || "", "Imagen del producto")}</div>

        <fieldset class="span2 fs">
          <legend>🥤 Tamaños y precios</legend>
          <div id="sizeRows"></div>
        </fieldset>

        <fieldset class="span2 fs">
          <legend>Toppings permitidos</legend>
          ${state.toppings.length ? `
            <div class="check-grid">
              ${state.toppings.map(t => `
                <label class="check ${t.active === false ? "inactive" : ""}">
                  <input type="checkbox" name="toppingIds" value="${esc(t.id)}" ${selected.has(t.id) ? "checked" : ""}>
                  <span>${esc(t.name)} <small>+${money(t.price)}${t.active === false ? " · inactivo" : ""}</small></span>
                </label>`).join("")}
            </div>` : `<p class="field-hint">Aún no hay toppings. Créalos en la pestaña Toppings.</p>`}
        </fieldset>

        <fieldset class="span2 fs">
          <legend>Configuración de toppings</legend>
          <label class="radio"><input type="radio" name="toppingMode" value="${TOPPING_MODE.perUnit}" ${p.toppingMode !== TOPPING_MODE.shared ? "checked" : ""}>
            <span><b>Por unidad</b></span></label>
          <label class="radio"><input type="radio" name="toppingMode" value="${TOPPING_MODE.shared}" ${p.toppingMode === TOPPING_MODE.shared ? "checked" : ""}>
            <span><b>Iguales para todas las unidades</b></span></label>
          <label class="field inline"><span>Cantidad máxima de toppings por unidad (0 = sin límite)</span>
            <input name="maxToppings" type="number" min="0" max="50" step="1" value="${Number(p.maxToppings) > 0 ? Number(p.maxToppings) : 0}"></label>
        </fieldset>

        <fieldset class="span2 fs">
          <legend>🌀 MIX de sabores</legend>
          <label class="switch big"><input type="checkbox" name="allowMix" ${p.allowMix ? "checked" : ""}><span></span><em>Se puede pedir MIX</em></label>
        </fieldset>

        <fieldset class="span2 fs costing-fs" id="costingFs">
          <legend>💰 Costeo por tamaño · costo directo y margen bruto</legend>
          <div class="chips size-tabs" id="sizeTabs"></div>
          <div id="sizeCosting"></div>
        </fieldset>
        <p class="form-error span2" id="formError" hidden></p>
      </form>`,
    footer: `
      ${isNew ? "" : `<button class="btn btn-danger" id="deleteBtn">Eliminar</button>`}
      <span class="spacer"></span>
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn" id="saveBtn">Guardar</button>`,
    onMount(root) {
      const form = root.querySelector("#productForm");
      form.addEventListener("submit", e => e.preventDefault());
      const getImage = bindImagePicker(root, p.image || "", PRODUCT_IMG);
      const sizesUI = bindProductSizes(root, p);
      if (focusCosting) setTimeout(() => root.querySelector("#costingFs").scrollIntoView({ block: "start" }), 30);
      const errEl = root.querySelector("#formError");
      const saveBtn = root.querySelector("#saveBtn");

      saveBtn.onclick = async () => {
        const fd = new FormData(form);
        const sized = sizesUI.read();
        if (sized.error) { errEl.textContent = sized.error; errEl.hidden = false; return; }
        const data = {
          name: String(fd.get("name") || "").trim(),
          description: String(fd.get("description") || "").trim(),
          category: String(fd.get("category") || "").trim(),
          order: parseInt(fd.get("order"), 10),
          active: form.active.checked,
          image: getImage(),
          toppingIds: fd.getAll("toppingIds").map(String).filter(id => state.toppings.some(t => t.id === id)),
          toppingMode: fd.get("toppingMode") === TOPPING_MODE.shared ? TOPPING_MODE.shared : TOPPING_MODE.perUnit,
          maxToppings: parseInt(fd.get("maxToppings"), 10),
          allowMix: form.allowMix.checked,
          sizes: sized.sizes
        };
        const error =
          !data.name ? "El nombre es obligatorio." :
          !Number.isInteger(data.order) || data.order < 0 ? "El orden debe ser un número entero (0 o mayor)." :
          !Number.isInteger(data.maxToppings) || data.maxToppings < 0 ? "La cantidad máxima de toppings debe ser 0 o mayor." :
          !isValidImageValue(data.image) ? "La imagen no es válida." : "";
        if (error) { errEl.textContent = error; errEl.hidden = false; return; }
        errEl.hidden = true;

        saveBtn.disabled = true;
        saveBtn.innerHTML = `<span class="spinner"></span> Guardando…`;
        try {
          if (isNew) {
            await addDoc(collection(db, COL.products), { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
          } else {
            // Los campos de precio/costeo único (antes de los tamaños) y la antigua
            // asignación de mano de obra/indirectos ya no se usan
            await updateDoc(doc(db, COL.products, product.id), {
              ...data, price: deleteField(), costing: deleteField(), unitCost: deleteField(),
              excludedOverheadIds: deleteField(), updatedAt: serverTimestamp()
            });
          }
          closeModal();
          toast(isNew ? "Producto creado" : "Producto actualizado", { type: "ok" });
          const priceKey = list => JSON.stringify((list || []).map(s => [s.id, s.price]));
          await waitForState(() => state.products.some(x => x.name === data.name && priceKey(x.sizes) === priceKey(data.sizes)));
          syncDerived();
        } catch (err) {
          console.error(err);
          errEl.textContent = friendlyError(err);
          errEl.hidden = false;
          saveBtn.disabled = false;
          saveBtn.textContent = "Guardar";
        }
      };

      const delBtn = root.querySelector("#deleteBtn");
      if (delBtn) delBtn.onclick = async () => {
        if (!confirm(`¿Eliminar "${product.name}"?\n\nLos pedidos anteriores no se modifican. Si solo quieres ocultarlo, desactívalo.`)) return;
        delBtn.disabled = true;
        try {
          await deleteDoc(doc(db, COL.products, product.id));
          closeModal();
          toast("Producto eliminado", { type: "ok" });
        } catch (err) {
          delBtn.disabled = false;
          toast(friendlyError(err), { type: "error" });
        }
      };
    }
  });
}

// =====================================================================
// COSTEO — componentes reutilizables
// =====================================================================
const SUPPLY_CATEGORIES = ["Ingrediente", "Empaque", "Topping", "Otro"];
const unitLabel = u => (Costing.UNITS[u] ? Costing.UNITS[u].label : u);
const decimalInput = v => (Number.isFinite(Number(v)) && v !== "" && v !== null && v !== undefined ? String(v) : "");
const toNumber = v => { const n = parseFloat(String(v ?? "").replace(",", ".")); return Number.isFinite(n) ? n : NaN; };

/** Explicación de una línea de receta: "$25.000 ÷ 1.000 ml = $25/ml × 50 ml". */
function lineFormula(r) {
  return `${moneyDec(Number(r.supply.purchasePrice))} ÷ ${Costing.qty(r.purchaseBaseQty)} ${esc(r.base)} = ${moneyDec(r.per)}/${esc(r.base)} × ${Costing.qty(r.baseQty)} ${esc(r.base)}`;
}

// ---------- Campos de insumo (modal e inline) ----------
function supplyFieldsHTML(s = {}) {
  const cats = [...new Set([...SUPPLY_CATEGORIES, ...state.supplies.map(x => x.category).filter(Boolean)])];
  const std = Costing.STANDARD_UNITS.includes(s.purchaseUnit || "und") || !s.purchaseUnit;
  return `
    <div class="sup-grid">
      <label class="field sup-name"><span>Nombre del insumo *</span>
        <input data-k="name" maxlength="60" value="${esc(s.name || "")}"></label>
      <label class="field"><span>Categoría</span>
        <input data-k="category" maxlength="30" list="supCats" value="${esc(s.category || "")}">
        <datalist id="supCats">${cats.map(c => `<option value="${esc(c)}">`).join("")}</datalist></label>
      <label class="field"><span>Cantidad comprada *</span>
        <input data-k="purchaseQty" type="number" min="0" step="any" value="${decimalInput(s.purchaseQty)}" placeholder="1"></label>
      <label class="field"><span>Unidad de compra *</span>
        <select data-k="purchaseUnitSel">
          ${Costing.STANDARD_UNITS.map(u => `<option value="${esc(u)}" ${std && (s.purchaseUnit || "und") === u ? "selected" : ""}>${esc(unitLabel(u))}</option>`).join("")}
          <option value="__other" ${std ? "" : "selected"}>Otra unidad…</option>
        </select>
        <input data-k="purchaseUnitOther" maxlength="20" value="${std ? "" : esc(s.purchaseUnit)}" ${std ? "hidden" : ""}></label>
      <label class="field"><span>Precio de compra *</span>
        <div class="money-input"><span>$</span><input data-k="purchasePrice" inputmode="numeric" value="${isValidPrice(s.purchasePrice) ? thousands(s.purchasePrice) : ""}" placeholder="0"></div></label>
      <div class="sup-preview" data-k="preview"></div>
    </div>`;
}

function bindSupplyFields(root) {
  const q = k => root.querySelector(`[data-k="${k}"]`);
  const read = () => ({
    name: q("name").value.trim(),
    category: q("category").value.trim(),
    purchaseQty: toNumber(q("purchaseQty").value),
    purchaseUnit: q("purchaseUnitSel").value === "__other" ? q("purchaseUnitOther").value.trim() : q("purchaseUnitSel").value,
    purchasePrice: parseMoney(q("purchasePrice").value)
  });
  const preview = () => {
    const s = read();
    const per = Costing.supplyUnitCost(s);
    const base = Costing.baseUnit(s.purchaseUnit);
    q("preview").innerHTML = Number.isFinite(per) && s.purchaseUnit
      ? `Costo por ${esc(base)}: <b>${moneyDec(per)}</b> <small>(${moneyDec(s.purchasePrice)} ÷ ${Costing.qty(s.purchaseQty * Costing.unitInfo(s.purchaseUnit).f)} ${esc(base)})</small>`
      : `<small>Completa cantidad, unidad y precio para ver el costo por unidad.</small>`;
  };
  q("purchaseUnitSel").addEventListener("change", () => {
    q("purchaseUnitOther").hidden = q("purchaseUnitSel").value !== "__other";
    preview();
  });
  bindMoneyInput(q("purchasePrice"), preview);
  ["purchaseQty", "purchaseUnitOther"].forEach(k => q(k).addEventListener("input", preview));
  preview();
  const validate = s =>
    !s.name ? "El nombre del insumo es obligatorio." :
    !(s.purchaseQty > 0) ? "La cantidad comprada debe ser mayor a 0." :
    !s.purchaseUnit ? "Indica la unidad de compra." :
    !isValidPrice(s.purchasePrice) ? "Ingresa el precio de compra." : "";
  return { read, validate };
}

// ---------- Editor de receta (productos y toppings) ----------
function recipeEditor(container, initialRecipe, onChange) {
  let lines = (initialRecipe || []).map(l => ({ supplyId: l.supplyId || "", qty: decimalInput(l.qty), unit: l.unit || "" }));
  const map = () => suppliesById();

  function supplyOptions(selId) {
    const groups = new Map();
    for (const s of state.supplies) {
      const c = s.category || "Sin categoría";
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(s);
    }
    const missing = selId && !map().has(selId);
    return `<option value="">— Elige un insumo —</option>
      ${missing ? `<option value="${esc(selId)}" selected>(insumo eliminado)</option>` : ""}
      ${[...groups].map(([c, list]) => `<optgroup label="${esc(c)}">${list.map(s =>
        `<option value="${esc(s.id)}" ${s.id === selId ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</optgroup>`).join("")}`;
  }
  function unitOptions(line) {
    const s = map().get(line.supplyId);
    const list = s ? Costing.compatibleUnits(s.purchaseUnit) : [];
    return list.map(u => `<option value="${esc(u)}" ${u === line.unit ? "selected" : ""}>${esc(u)}</option>`).join("");
  }
  function costCell(line) {
    if (!line.supplyId) return `<span class="rc-hint">Elige un insumo</span>`;
    const r = Costing.lineCost({ ...line, qty: toNumber(line.qty) }, map());
    if (!r.ok) return `<span class="rc-err">${esc(r.error)}</span>`;
    return `<b>${moneyDec(r.cost)}</b><small>${lineFormula(r)}</small>`;
  }
  const totalHTML = () => {
    const r = Costing.recipeCost(get(), map());
    return `Costo de la receta: <b>${moneyDec(r.direct)}</b>${r.packaging ? ` <small>(insumos ${moneyDec(r.ingredients)} + empaque ${moneyDec(r.packaging)})</small>` : ""}`;
  };

  function render() {
    container.innerHTML = `
      ${lines.length ? `
      <div class="rc-head"><span>Insumo</span><span>Cantidad usada</span><span>Unidad</span><span>Costo</span><span></span></div>
      ${lines.map((l, i) => `
        <div class="rc-row" data-i="${i}">
          <select data-f="supply" aria-label="Insumo">${supplyOptions(l.supplyId)}</select>
          <input data-f="qty" type="number" min="0" step="any" value="${esc(l.qty)}" placeholder="0" aria-label="Cantidad">
          <select data-f="unit" aria-label="Unidad" ${l.supplyId ? "" : "disabled"}>${unitOptions(l)}</select>
          <div class="rc-cost" data-f="cost">${costCell(l)}</div>
          <button type="button" class="icon-x small" data-f="del" aria-label="Quitar">×</button>
        </div>`).join("")}
      <div class="rc-total" data-f="total">${totalHTML()}</div>` : `<p class="field-hint">Sin insumos.</p>`}
      <div class="rc-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-f="add" ${state.supplies.length ? "" : "disabled"}>+ Agregar insumo</button>
        <button type="button" class="btn btn-ghost btn-sm" data-f="new">+ Crear insumo nuevo</button>
      </div>
      <div class="rc-new" data-f="newForm" hidden>
        <div class="rc-new-title">Nuevo insumo</div>
        ${supplyFieldsHTML()}
        <p class="form-error" data-f="newErr" hidden></p>
        <div class="rc-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-f="newCancel">Cancelar</button>
          <button type="button" class="btn btn-sm" data-f="newSave">Guardar insumo y agregarlo</button>
        </div>
      </div>`;
    const nf = container.querySelector('[data-f="newForm"]');
    newFields = bindSupplyFields(nf);
  }
  let newFields = null;

  function updateRow(i) {
    const row = container.querySelector(`.rc-row[data-i="${i}"]`);
    if (row) row.querySelector('[data-f="cost"]').innerHTML = costCell(lines[i]);
    const t = container.querySelector('[data-f="total"]');
    if (t) t.innerHTML = totalHTML();
  }

  container.addEventListener("input", e => {
    const row = e.target.closest(".rc-row");
    if (row && e.target.dataset.f === "qty") {
      lines[Number(row.dataset.i)].qty = e.target.value;
      updateRow(Number(row.dataset.i));
      onChange();
    }
  });
  container.addEventListener("change", e => {
    const row = e.target.closest(".rc-row");
    if (!row) return;
    const i = Number(row.dataset.i);
    if (e.target.dataset.f === "supply") {
      lines[i].supplyId = e.target.value;
      const s = map().get(e.target.value);
      lines[i].unit = s ? Costing.baseUnit(s.purchaseUnit) : "";
      render();
      container.querySelector(`.rc-row[data-i="${i}"] [data-f="qty"]`)?.focus();
    } else if (e.target.dataset.f === "unit") {
      lines[i].unit = e.target.value;
      updateRow(i);
    }
    onChange();
  });
  container.addEventListener("click", async e => {
    const f = e.target.closest("[data-f]")?.dataset.f;
    if (!f) return;
    if (f === "del") {
      lines.splice(Number(e.target.closest(".rc-row").dataset.i), 1);
      render(); onChange();
    } else if (f === "add") {
      lines.push({ supplyId: "", qty: "", unit: "" });
      render();
      container.querySelector(`.rc-row[data-i="${lines.length - 1}"] [data-f="supply"]`)?.focus();
    } else if (f === "new") {
      container.querySelector('[data-f="newForm"]').hidden = false;
      container.querySelector('[data-f="newForm"] [data-k="name"]').focus();
    } else if (f === "newCancel") {
      container.querySelector('[data-f="newForm"]').hidden = true;
    } else if (f === "newSave") {
      const s = newFields.read();
      const err = newFields.validate(s);
      const errEl = container.querySelector('[data-f="newErr"]');
      if (err) { errEl.textContent = err; errEl.hidden = false; return; }
      e.target.disabled = true;
      try {
        const ref = await addDoc(collection(db, COL.supplies), { ...s, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        if (!state.supplies.some(x => x.id === ref.id)) state.supplies.push({ id: ref.id, ...s });
        lines.push({ supplyId: ref.id, qty: "", unit: Costing.baseUnit(s.purchaseUnit) });
        render(); onChange();
        container.querySelector(`.rc-row[data-i="${lines.length - 1}"] [data-f="qty"]`)?.focus();
        toast("Insumo creado", { type: "ok", duration: 1600 });
      } catch (err2) {
        errEl.textContent = friendlyError(err2); errEl.hidden = false; e.target.disabled = false;
      }
    }
  });

  function get() {
    return lines.filter(l => l.supplyId).map(l => ({ supplyId: l.supplyId, qty: toNumber(l.qty) || 0, unit: l.unit }));
  }
  const api = {
    get,
    refresh() {
      const nf = container.querySelector('[data-f="newForm"]');
      if (nf && !nf.hidden) return; // no interrumpir mientras se crea un insumo
      render(); onChange();
    }
  };
  state.recipeEditors.add(api);
  render();
  return api;
}

// ---------- Resumen del costeo de un producto ----------
function costRow(label, value, note = "", cls = "") {
  return `<div class="cs-row ${cls}"><span>${label}${note ? `<small>${note}</small>` : ""}</span><b>${value}</b></div>`;
}

function productSummaryHTML(r) {
  const warn = [];
  if (!r.hasRecipe) warn.push("Agrega la receta (ingredientes, vaso, tapa, pitillo…) para conocer el costo directo.");
  if (r.recipe.errors.length) warn.push(`${r.recipe.errors.length} línea(s) de la receta sin calcular: ${esc(r.recipe.errors.map(e => e.error).join(", "))}.`);
  if (r.auto && !Number.isFinite(r.suggested)) warn.push("Para usar el precio automático se necesita un costo mayor a $0 y un margen menor a 100%.");
  if (Number.isFinite(r.profit) && r.profit < 0) warn.push("El precio de venta es menor que el costo directo: este producto da pérdida.");
  const wasteNote = r.wasteMode === "percent" ? `${pct(r.wasteValue || 0)} de ${moneyDec(r.recipe.direct)}`
    : r.wasteMode === "amount" ? "monto fijo por unidad" : "sin merma";
  const marginOk = Number.isFinite(r.realMargin);
  const costW = marginOk ? Math.max(0, Math.min(100, r.costPct)) : 0;
  return `
    <div class="cs-title">Costo directo y margen bruto</div>
    ${costRow("Ingredientes / materia prima", moneyDec(r.recipe.ingredients))}
    ${costRow("Vaso, tapa, pitillo y empaques", moneyDec(r.recipe.packaging), r.recipe.packaging ? "insumos de categoría Empaque" : "sin empaques en la receta")}
    ${r.waste ? costRow("Merma", moneyDec(r.waste), wasteNote) : ""}
    ${costRow("COSTO DIRECTO", moneyDec(r.total), "suma de todos los insumos utilizados", "cs-total")}
    <div class="cs-sep"></div>
    ${costRow("Margen deseado", Number.isFinite(r.margin) ? pct(r.margin) : "—")}
    ${costRow("Precio calculado", Number.isFinite(r.suggested) ? moneyDec(r.suggested) : "—",
      Number.isFinite(r.suggested) ? `${moneyDec(r.total)} ÷ (1 − ${String(r.margin / 100).replace(".", ",")})` : "")}
    ${costRow("Precio de venta", Number.isFinite(r.salePrice) ? moneyDec(r.salePrice) : "—", r.auto ? "automático (precio calculado)" : "manual", "cs-price")}
    ${costRow("Margen bruto", Number.isFinite(r.profit) ? moneyDec(r.profit) : "—",
      Number.isFinite(r.profit) ? `${moneyDec(r.salePrice)} − ${moneyDec(r.total)}` : "", r.profit < 0 ? "cs-bad" : "cs-good")}
    ${costRow("Margen bruto %", marginOk ? pct(r.realMargin) : "—",
      marginOk ? `${moneyDec(r.profit)} ÷ ${moneyDec(r.salePrice)} × 100` : "", r.profit < 0 ? "cs-bad" : "cs-good")}
    ${marginOk ? `
      <div class="cs-bar" title="Costo directo vs. margen bruto">
        <span class="cs-bar-cost" style="width:${costW}%"></span><span class="cs-bar-profit" style="width:${100 - costW}%"></span>
      </div>
      <div class="cs-bar-legend"><span>Costo ${pct(r.costPct)}</span><span>Margen ${pct(r.realMargin)}</span></div>` : ""}
    <p class="cs-note">Arriendo, servicios y nómina no se suman aquí: van en Costeo → Gastos generales.</p>
    ${warn.length ? `<div class="cs-warn">${warn.map(w => `<p>⚠️ ${w}</p>`).join("")}</div>` : ""}`;
}

// ---------- Tamaños + costeo por tamaño dentro del modal de producto ----------
const MAX_SIZES = 6;
const newSizeId = () => "z" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** Panel de costeo del tamaño seleccionado. */
function sizeCostingHTML(size, others) {
  const c = size.costing || {};
  const w = c.waste || {};
  const wm = w.mode || "none";
  return `
    <div class="cost-layout">
      <div class="cost-main">
        <h4 class="cost-h">1 · Receta de un vaso de ${esc(size.name || "este tamaño")} <small>ingredientes, vaso, tapa, pitillo y otros insumos</small></h4>
        ${others.length ? `
          <div class="copy-recipe">
            <select data-k="copyFrom" aria-label="Copiar receta de otro tamaño">
              <option value="">↧ Copiar receta de otro tamaño…</option>
              ${others.map(o => `<option value="${o.i}">${esc(o.name || `Tamaño ${o.i + 1}`)}</option>`).join("")}
            </select>
          </div>` : ""}
        <div class="rcp" id="productRecipe"></div>

        <h4 class="cost-h">2 · Merma <small>opcional</small></h4>
        <div class="opt-row">
          <label class="radio"><input type="radio" name="__wasteMode" data-k="wasteMode" value="none" ${wm === "none" ? "checked" : ""}><span>Sin merma</span></label>
          <label class="radio"><input type="radio" name="__wasteMode" data-k="wasteMode" value="percent" ${wm === "percent" ? "checked" : ""}><span>Porcentaje</span></label>
          <label class="radio"><input type="radio" name="__wasteMode" data-k="wasteMode" value="amount" ${wm === "amount" ? "checked" : ""}><span>Cantidad fija ($)</span></label>
          <input class="small-input" data-k="wasteValue" type="number" min="0" step="any" value="${decimalInput(w.value)}" placeholder="0" ${wm === "none" ? "hidden" : ""}>
        </div>

        <h4 class="cost-h">3 · Margen y precio de venta de este tamaño</h4>
        <div class="opt-row">
          <label class="field inline-field"><span>Margen deseado (%)</span>
            <input class="small-input" data-k="targetMargin" type="number" min="0" max="95" step="any" value="${decimalInput(c.targetMargin)}" placeholder="40"></label>
        </div>
        <div class="opt-col">
          <label class="radio"><input type="radio" name="__priceMode" data-k="priceMode" value="manual" ${c.priceMode !== "auto" ? "checked" : ""}>
            <span><b>Precio manual</b></span></label>
          <label class="radio"><input type="radio" name="__priceMode" data-k="priceMode" value="auto" ${c.priceMode === "auto" ? "checked" : ""}>
            <span><b>Precio automático</b></span></label>
        </div>
      </div>
      <aside class="cost-summary" id="productSummary"></aside>
    </div>`;
}

/**
 * Editor de tamaños del producto: nombre y precio de cada tamaño, y el
 * costeo (receta, merma, margen, precio automático) de cada uno.
 */
function bindProductSizes(root, p) {
  const isNew = !p.id;
  const numOrNaN = v => (v === null || v === undefined || v === "" ? NaN : Number(v));
  const cloneCosting = c => {
    c = c || {};
    const w = c.waste || {};
    return {
      recipe: (Array.isArray(c.recipe) ? c.recipe : []).map(l => ({ ...l })),
      waste: { mode: w.mode || "none", value: Number(w.value) || 0 },
      targetMargin: numOrNaN(c.targetMargin),
      priceMode: c.priceMode === "auto" ? "auto" : "manual"
    };
  };
  const sizes = (isNew ? DEFAULT_SIZES.map(name => ({ name })) : productSizes(p)).map(s => ({
    id: s.id || newSizeId(),
    name: s.name || "",
    price: isValidPrice(s.price) ? s.price : NaN,
    costing: cloneCosting(s.costing)
  }));
  let cur = 0;
  let editor = null;
  const rowsBox = root.querySelector("#sizeRows");
  const tabsBox = root.querySelector("#sizeTabs");
  const panel = root.querySelector("#sizeCosting");
  const q = k => panel.querySelector(`[data-k="${k}"]`);
  const compute = s => sizeCost(s);
  const label = (s, i) => s.name.trim() || `Tamaño ${i + 1}`;

  /** Pasa al modelo lo escrito en el panel de costeo del tamaño seleccionado. */
  function capture() {
    if (!editor || !q("priceMode")) return;
    const c = sizes[cur].costing;
    c.recipe = editor.get();
    c.waste = { mode: panel.querySelector('[data-k="wasteMode"]:checked').value, value: toNumber(q("wasteValue").value) || 0 };
    c.targetMargin = toNumber(q("targetMargin").value);
    c.priceMode = panel.querySelector('[data-k="priceMode"]:checked').value;
  }

  function renderRows() {
    rowsBox.innerHTML = `
      <div class="size-head"><span>Nombre del tamaño</span><span>Precio de venta</span><span></span></div>
      ${sizes.map((s, i) => `
        <div class="size-row ${i === cur ? "current" : ""}" data-i="${i}">
          <input data-s="name" maxlength="20" value="${esc(s.name)}" aria-label="Nombre del tamaño">
          <div class="money-input"><span>$</span><input data-s="price" inputmode="numeric" placeholder="0" aria-label="Precio de venta"></div>
          <button type="button" class="icon-x small" data-s="del" aria-label="Quitar tamaño" ${sizes.length <= 1 ? "disabled" : ""}>×</button>
          <small class="size-note" data-s="note"></small>
        </div>`).join("")}
      <button type="button" class="btn btn-ghost btn-sm" data-s="add" ${sizes.length >= MAX_SIZES ? "disabled" : ""}>+ Agregar tamaño</button>`;
    sizes.forEach((_, i) => refreshRow(i));
  }

  function refreshRow(i) {
    const row = rowsBox.querySelector(`.size-row[data-i="${i}"]`);
    if (!row) return;
    const s = sizes[i];
    const auto = s.costing.priceMode === "auto";
    const input = row.querySelector('[data-s="price"]');
    input.readOnly = auto;
    input.closest(".money-input").classList.toggle("is-auto", auto);
    if (auto || document.activeElement !== input) input.value = Number.isFinite(s.price) ? thousands(s.price) : "";
    const r = compute(s);
    row.querySelector('[data-s="note"]').innerHTML = (auto ? "Precio automático · " : "") +
      (r.hasRecipe ? `costo directo ${moneyDec(r.total)} · margen bruto <b class="${r.profit < 0 ? "neg" : ""}">${moneyDec(r.profit)} (${pct(r.realMargin)})</b>` : "sin costeo");
  }

  function renderTabs() {
    tabsBox.innerHTML = sizes.map((s, i) =>
      `<button type="button" data-sz="${i}" class="${i === cur ? "active" : ""}">${esc(label(s, i))}</button>`).join("");
  }

  function renderPanel() {
    if (editor) state.recipeEditors.delete(editor);
    const others = sizes.map((s, i) => ({ i, name: label(s, i) })).filter(o => o.i !== cur);
    panel.innerHTML = sizeCostingHTML(sizes[cur], others);
    editor = recipeEditor(panel.querySelector("#productRecipe"), sizes[cur].costing.recipe, update);
    update();
  }

  const renderAll = () => { renderRows(); renderTabs(); renderPanel(); };

  function selectSize(i) {
    if (i === cur || !sizes[i]) return;
    capture();
    cur = i;
    renderTabs();
    rowsBox.querySelectorAll(".size-row").forEach(r => r.classList.toggle("current", Number(r.dataset.i) === cur));
    renderPanel();
  }

  /** Recalcula precios automáticos de todos los tamaños y el resumen del seleccionado. */
  function update() {
    capture();
    for (const s of sizes) {
      if (s.costing.priceMode !== "auto") continue;
      const sug = compute(s).suggested;
      s.price = Number.isFinite(sug) ? sug : NaN;
    }
    const r = compute(sizes[cur]);
    q("wasteValue").hidden = sizes[cur].costing.waste.mode === "none";
    panel.querySelector("#productSummary").innerHTML = productSummaryHTML(r);
    sizes.forEach((_, i) => refreshRow(i));
  }

  // ----- Eventos del panel de costeo -----
  panel.addEventListener("change", e => {
    const t = e.target;
    if (t.dataset.k === "copyFrom") {
      const j = Number(t.value);
      if (t.value === "" || !sizes[j]) return;
      capture();
      sizes[cur].costing.recipe = sizes[j].costing.recipe.map(l => ({ ...l }));
      renderPanel();
      toast(`Receta copiada de ${label(sizes[j], j)}. Ajusta las cantidades para ${label(sizes[cur], cur)}.`, { duration: 4000 });
      return;
    }
    if (["wasteMode", "priceMode", "wasteValue", "targetMargin"].includes(t.dataset.k)) update();
  });
  panel.addEventListener("input", e => {
    if (["wasteValue", "targetMargin"].includes(e.target.dataset.k)) update();
  });

  // ----- Eventos de la lista de tamaños -----
  rowsBox.addEventListener("input", e => {
    const row = e.target.closest(".size-row");
    if (!row) return;
    const i = Number(row.dataset.i);
    if (e.target.dataset.s === "name") {
      sizes[i].name = e.target.value;
      renderTabs();
    } else if (e.target.dataset.s === "price") {
      const n = parseMoney(e.target.value);
      e.target.value = Number.isNaN(n) ? "" : thousands(n);
      sizes[i].price = Number.isNaN(n) ? NaN : n;
      if (i === cur) update(); else refreshRow(i);
    }
  });
  // Al escribir en un tamaño, su costeo se muestra abajo
  rowsBox.addEventListener("focusin", e => {
    const row = e.target.closest(".size-row");
    if (row && e.target.dataset.s !== "del") selectSize(Number(row.dataset.i));
  });
  rowsBox.addEventListener("click", e => {
    const act = e.target.closest("[data-s]")?.dataset.s;
    if (act === "del") {
      const i = Number(e.target.closest(".size-row").dataset.i);
      const s = sizes[i];
      if (sizes.length <= 1) return;
      if ((s.costing.recipe.length || Number.isFinite(s.price)) && !confirm(`¿Quitar el tamaño "${label(s, i)}" con su precio y costeo?`)) return;
      capture();
      sizes.splice(i, 1);
      if (i < cur || cur >= sizes.length) cur = Math.max(0, cur - 1);
      renderAll();
    } else if (act === "add") {
      if (sizes.length >= MAX_SIZES) return;
      capture();
      const base = sizes[cur].costing;
      sizes.push({ id: newSizeId(), name: "", price: NaN,
        costing: { recipe: [], waste: { ...base.waste }, targetMargin: base.targetMargin, priceMode: "manual" } });
      cur = sizes.length - 1;
      renderAll();
      rowsBox.querySelector(`.size-row[data-i="${cur}"] [data-s="name"]`)?.focus();
    }
  });
  tabsBox.addEventListener("click", e => {
    const b = e.target.closest("[data-sz]");
    if (b) selectSize(Number(b.dataset.sz));
  });

  // Si cambian los costos de los insumos mientras el modal está abierto
  state.recipeEditors.add({ refresh: () => { if (editor) update(); } });
  renderAll();

  /** Valida y devuelve { sizes } o { error }. */
  function read() {
    update();
    const names = new Set();
    const fail = (i, msg) => { selectSize(i); return { error: msg }; };
    for (const [i, s] of sizes.entries()) {
      const n = s.name.trim();
      const c = s.costing;
      if (!n) return fail(i, `Escribe el nombre del tamaño ${i + 1} (ej: 16 oz).`);
      if (names.has(n.toLowerCase())) return fail(i, `Hay dos tamaños llamados "${n}".`);
      names.add(n.toLowerCase());
      if (c.waste.mode === "percent" && !(c.waste.value >= 0 && c.waste.value < 100)) return fail(i, `${n}: la merma en porcentaje debe estar entre 0 y 99.`);
      if (c.waste.mode === "amount" && !(c.waste.value >= 0)) return fail(i, `${n}: la merma en pesos debe ser 0 o mayor.`);
      if (Number.isFinite(c.targetMargin) && !(c.targetMargin >= 0 && c.targetMargin <= 95)) return fail(i, `${n}: el margen deseado debe estar entre 0% y 95%.`);
      if (c.priceMode === "auto" && !Number.isFinite(s.price)) return fail(i, `${n}: para usar el precio automático, agrega la receta (costo mayor a $0) y un margen deseado.`);
      if (!isValidPrice(s.price) || s.price === 0) return fail(i, `${n}: ingresa un precio de venta válido (mayor a $0).`);
    }
    return {
      sizes: sizes.map(s => ({
        id: s.id,
        name: s.name.trim(),
        price: s.price,
        costing: {
          recipe: s.costing.recipe,
          waste: s.costing.waste,
          targetMargin: Number.isFinite(s.costing.targetMargin) ? s.costing.targetMargin : null,
          priceMode: s.costing.priceMode
        },
        unitCost: s.costing.recipe.length ? Costing.round2(compute(s).total) : null
      }))
    };
  }
  return { read };
}

// ---------- Sección "Costeo del topping" ----------
function bindToppingCosting(root, t, form) {
  const priceInput = form.querySelector('[name="price"]');
  let editor = null;
  const compute = () => Costing.toppingCost({ price: parseMoney(priceInput.value), costing: { recipe: editor ? editor.get() : [] } }, suppliesById());
  function update() {
    const r = compute();
    const ok = Number.isFinite(r.margin);
    root.querySelector("#toppingSummary").innerHTML = `
      <div class="cs-title">Rentabilidad del topping</div>
      ${costRow("Costo real", moneyDec(r.cost), r.hasRecipe ? "según la receta" : "sin receta")}
      ${costRow("Precio adicional al cliente", Number.isFinite(r.price) ? "+" + moneyDec(r.price) : "—")}
      ${costRow("Ganancia", Number.isFinite(r.profit) ? moneyDec(r.profit) : "—",
        Number.isFinite(r.profit) ? `${moneyDec(r.price)} − ${moneyDec(r.cost)}` : "", r.profit < 0 ? "cs-bad" : "cs-good")}
      ${costRow("Margen", ok ? pct(r.margin) : "—", ok ? `(${moneyDec(r.price)} − ${moneyDec(r.cost)}) ÷ ${moneyDec(r.price)} × 100` : "", r.profit < 0 ? "cs-bad" : "cs-good")}
      ${r.recipe.errors.length ? `<div class="cs-warn"><p>⚠️ ${esc(r.recipe.errors.map(e => e.error).join(", "))}</p></div>` : ""}`;
  }
  editor = recipeEditor(root.querySelector("#toppingRecipe"), t.costing && t.costing.recipe, update);
  priceInput.addEventListener("input", update);
  update();
  return { read: () => ({ recipe: editor.get() }), compute };
}

// ---------- Recalcular costos guardados y precios automáticos ----------
/**
 * Guarda en cada producto/topping su costo unitario actual (unitCost) y,
 * si el producto usa precio automático, su nuevo precio. Los pedidos ya
 * realizados no cambian: guardaron su propia copia de precios y costos.
 */
async function syncDerived() {
  if (!state.catalogReady || !state.costingReady) return;
  const batch = writeBatch(db);
  let n = 0;
  for (const p of state.products) {
    // Productos creados antes de los tamaños se convierten a un tamaño "Único"
    const legacy = !Array.isArray(p.sizes) || !p.sizes.length;
    let changed = legacy;
    const sizes = productSizes(p).map(s => {
      const r = sizeCostOf(p, s);
      const out = { ...s, unitCost: r.hasRecipe ? Costing.round2(r.total) : null };
      if (s.costing && s.costing.priceMode === "auto" && Number.isFinite(r.suggested) && r.suggested > 0) out.price = r.suggested;
      if ((s.unitCost ?? null) !== out.unitCost || s.price !== out.price) changed = true;
      return out;
    });
    if (!changed) continue;
    const upd = { sizes };
    if (legacy) Object.assign(upd, { price: deleteField(), costing: deleteField(), unitCost: deleteField() });
    batch.update(doc(db, COL.products, p.id), upd);
    n++;
  }
  for (const t of state.toppings) {
    const r = toppingCostOf(t);
    const unitCost = r.hasRecipe ? Costing.round2(r.cost) : null;
    if ((t.unitCost ?? null) !== unitCost) { batch.update(doc(db, COL.toppings, t.id), { unitCost }); n++; }
  }
  if (n) {
    try { await batch.commit(); } catch (err) { console.error(err); toast(friendlyError(err), { type: "error" }); }
  }
  return n;
}

function maybeInitialSync() {
  if (state.derivedSynced || !state.catalogReady || !state.costingReady) return;
  state.derivedSynced = true;
  syncDerived();
}

// Si cambia el costo de un insumo (por ejemplo, una compra en Inventario),
// se recalculan solos los costos y precios automáticos que lo usan.
let syncTimer = null;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncDerived(); }, 400);
}

function onCostingDataChange() {
  if (state.derivedSynced) scheduleSync(); else maybeInitialSync();
  state.recipeEditors.forEach(e => e.refresh());
  if (["costeo", "productos", "toppings"].includes(state.tab)) renderCurrentTab();
}

// =====================================================================
// PESTAÑA COSTEO
// Resumen · Granizados · Extras · Acompañantes · Insumos · Gastos generales
// Granizados: costo directo = receta (ingredientes + vaso, tapa, pitillo…)
// Extras y acompañantes: costo directo = precio de compra unitario
// Margen bruto = precio de venta − costo directo. Los gastos generales se
// manejan aparte: el margen de todo lo vendido debe cubrirlos.
// =====================================================================
const COST_TABS = ["resumen", "granizados", "extras", "acompanantes", "insumos", "gastos"];
const extrasList = () => window.AdminKit?.extrasList?.() || [];
const avgOf = list => (list.length ? list.reduce((s, v) => s + v, 0) / list.length : NaN);

/** Mientras se edita una fila de la tabla no se redibuja (se hace al salir de ella). */
const costInlineBusy = () => !!document.activeElement?.closest?.("#view-costeo [data-inline-row]");

function renderCosteo() {
  const view = $("#view-costeo");
  if (!state.catalogReady || !state.costingReady) { view.innerHTML = `<div class="loading-screen"><div class="spinner dark"></div></div>`; return; }
  if (costInlineBusy()) { state.costPending = true; return; }
  state.costPending = false;
  if (!COST_TABS.includes(state.costTab)) state.costTab = "resumen";
  const sizesCount = state.products.reduce((n, p) => n + productSizes(p).length, 0);
  const tabs = [
    ["resumen", "📊 Resumen"],
    ["granizados", `🍧 Granizados (${sizesCount})`],
    ["extras", `🛍️ Extras (${extrasList().length})`],
    ["acompanantes", `🍟 Acompañantes (${state.sides.length})`],
    ["insumos", `🧂 Insumos (${state.supplies.length})`],
    ["gastos", `🏢 Gastos generales (${state.overheads.length})`]
  ];
  view.innerHTML = `
    <div class="toolbar">
      <h2 class="view-title">Costeo</h2>
      <div class="chips cost-tabs" id="costTabs">${tabs.map(([k, l]) => `<button data-ct="${k}" class="${state.costTab === k ? "active" : ""}">${l}</button>`).join("")}</div>
    </div>
    <div id="costBody"></div>`;
  view.querySelector("#costTabs").onclick = e => {
    const b = e.target.closest("[data-ct]");
    if (b) { state.costTab = b.dataset.ct; renderCosteo(); }
  };
  const body = view.querySelector("#costBody");
  // Al salir de una fila en edición se aplica el redibujo pendiente
  body.addEventListener("focusout", () => setTimeout(() => {
    if (state.costPending && state.tab === "costeo" && !costInlineBusy()) renderCosteo();
  }, 0));
  ({
    resumen: renderCostSummary,
    granizados: renderProfitBoard,
    extras: b => renderItemCosting(b, "extras"),
    acompanantes: b => renderItemCosting(b, "sides"),
    insumos: renderSupplies,
    gastos: renderGeneralExpenses
  })[state.costTab](body);
}

function marginBar(m) {
  if (!Number.isFinite(m)) return "—";
  const w = Math.max(0, Math.min(100, m));
  return `<div class="mcell-in"><div class="mbar ${m < 0 ? "neg" : m < 30 ? "low" : ""}"><span style="width:${w}%"></span></div><b>${pct(m)}</b></div>`;
}

// ---------- Resumen: margen del catálogo y cobertura de gastos generales ----------
const generalTotal = () => state.overheads
  .filter(o => o.active !== false)
  .reduce((s, o) => s + (Number.isFinite(Costing.generalMonthly(o)) ? Costing.generalMonthly(o) : 0), 0);

function renderCostSummary(box) {
  const sizeRs = state.products.flatMap(p => productSizes(p).map(s => sizeCostOf(p, s)));
  const gz = sizeRs.filter(r => r.hasRecipe && Number.isFinite(r.realMargin)).map(r => r.realMargin);
  const exs = extrasList().map(Costing.itemCost).filter(r => Number.isFinite(r.margin)).map(r => r.margin);
  const sds = state.sides.map(Costing.itemCost).filter(r => Number.isFinite(r.margin)).map(r => r.margin);
  const general = generalTotal();
  const incomplete = state.overheads.filter(o => o.active !== false && !Number.isFinite(Costing.generalMonthly(o))).length;
  const thisMonth = dateKey(new Date()).slice(0, 7);
  const kpi = (cls, label, value, small) => `<div class="kpi ${cls}"><span>${label}</span><b>${value}</b><small>${small}</small></div>`;
  box.innerHTML = `
    <h3 class="sub-title">Margen bruto del catálogo <small>precio de venta − costo directo</small></h3>
    <div class="kpis">
      ${kpi("", "🍧 Granizados", pct(avgOf(gz)), `promedio · ${gz.length} de ${sizeRs.length} tamaños costeados`)}
      ${kpi("", "🛍️ Extras", pct(avgOf(exs)), `promedio · ${exs.length} de ${extrasList().length} con precio de compra`)}
      ${kpi("", "🍟 Acompañantes", pct(avgOf(sds)), `promedio · ${sds.length} de ${state.sides.length} con costo`)}
      ${kpi("warn", "🏢 Gastos generales", money(general), `al mes${incomplete ? ` · ${incomplete} sin valor` : ""}`)}
    </div>
    <div class="toolbar cov-bar">
      <h3 class="sub-title grow">¿El margen cubre los gastos generales? <small>con las ventas reales del mes</small></h3>
      <label class="field inline-field"><span>Mes</span>
        <input type="month" id="costMonth" value="${esc(state.costMonth)}" max="${thisMonth}"></label>
    </div>
    <div id="costCoverage"><div class="loading-screen small"><div class="spinner dark"></div></div></div>`;
  box.querySelector("#costMonth").addEventListener("change", e => {
    if (!/^\d{4}-\d{2}$/.test(e.target.value)) return;
    state.costMonth = e.target.value;
    paintCoverage();
  });
  paintCoverage();
}

/** Ventas, costo directo registrado y margen bruto del mes por categoría. */
async function monthSales(ym) {
  const [y, m] = ym.split("-").map(Number);
  const from = Timestamp.fromDate(new Date(y, m - 1, 1)), to = Timestamp.fromDate(new Date(y, m, 1));
  const [orders, extraSales, expenses] = await Promise.all([
    getDocs(query(collection(db, COL.orders), where("paidAt", ">=", from), where("paidAt", "<", to))),
    getDocs(query(collection(db, COL.extraSales), where("createdAt", ">=", from), where("createdAt", "<", to))),
    getDocs(query(collection(db, COL.expenses), where("date", ">=", from), where("date", "<", to)))
  ]);
  const cats = {};
  ["granizados", "acompanantes", "extras"].forEach(k => { cats[k] = { sales: 0, cost: 0, costed: 0, missing: 0 }; });
  const add = (k, amount, cost) => {
    const c = cats[k];
    c.sales += amount || 0;
    if (typeof cost === "number" && Number.isFinite(cost)) { c.cost += cost; c.costed += amount || 0; } else c.missing += amount || 0;
  };
  orders.docs.map(d => d.data()).filter(o => o.paid).forEach(o => {
    (o.items || []).forEach(i => add("granizados", i.subtotal, i.costSubtotal));
    (o.sides || []).forEach(s => add("acompanantes", s.subtotal, s.costSubtotal));
  });
  extraSales.docs.map(d => d.data()).filter(s => !s.voided).forEach(s => (s.items || []).forEach(i => add("extras", i.subtotal, i.costSubtotal)));
  const opex = expenses.docs.map(d => d.data()).filter(e => e.type === "operacional").reduce((s, e) => s + (e.amount || 0), 0);
  return { cats, opex };
}

async function paintCoverage() {
  const out = $("#costCoverage");
  if (!out) return;
  const token = (state.costToken = (state.costToken || 0) + 1);
  const ym = state.costMonth;
  let data;
  try { data = await monthSales(ym); } catch (err) {
    console.error(err);
    if ($("#costCoverage")) $("#costCoverage").innerHTML = `<div class="empty-box">${esc(friendlyError(err))}</div>`;
    return;
  }
  if (token !== state.costToken || !$("#costCoverage")) return;
  const { cats, opex } = data;
  const labels = { granizados: "🍧 Granizados", acompanantes: "🍟 Acompañantes", extras: "🛍️ Extras" };
  const rows = Object.entries(cats).map(([k, c]) => ({ k, ...c, profit: c.costed - c.cost }));
  const T = rows.reduce((t, r) => ({ sales: t.sales + r.sales, cost: t.cost + r.cost, costed: t.costed + r.costed, missing: t.missing + r.missing, profit: t.profit + r.profit }),
    { sales: 0, cost: 0, costed: 0, missing: 0, profit: 0 });
  const mPct = r => (r.costed > 0 ? r.profit / r.costed * 100 : NaN);
  const general = generalTotal();
  const result = T.profit - general;
  const totalPct = mPct(T);
  const breakEven = general > 0 && totalPct > 0 ? general / (totalPct / 100) : NaN;
  const coverage = general > 0 ? T.profit / general * 100 : NaN;
  const [y, m] = ym.split("-").map(Number);
  const now = new Date();
  const current = y === now.getFullYear() && m === now.getMonth() + 1;
  const days = new Date(y, m, 0).getDate();
  $("#costCoverage").innerHTML = `
    <div class="table-wrap"><table class="ctable cov-table">
      <thead><tr><th>Categoría</th><th class="num">Ventas</th><th class="num">Costo directo</th><th class="num">Margen bruto</th><th>Margen bruto %</th></tr></thead>
      <tbody>${rows.map(r => `
        <tr><td><b>${labels[r.k]}</b>${r.missing ? `<div class="pk-sub">${money(r.missing)} vendidos sin costo registrado</div>` : ""}</td>
          <td class="num">${money(r.sales)}</td><td class="num">${moneyDec(r.cost)}</td>
          <td class="num ${r.profit < 0 ? "neg" : "pos"}">${moneyDec(r.profit)}</td>
          <td class="mcell">${marginBar(mPct(r))}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td>TOTAL</td><td class="num">${money(T.sales)}</td><td class="num">${moneyDec(T.cost)}</td><td class="num">${moneyDec(T.profit)}</td><td>${pct(totalPct)}</td></tr></tfoot>
    </table></div>
    <div class="cov-grid">
      <div class="cov-step"><span>Margen bruto del mes</span><b>${moneyDec(T.profit)}</b></div>
      <div class="cov-op">−</div>
      <div class="cov-step"><span>Gastos generales del mes</span><b>${money(general)}</b></div>
      <div class="cov-op">=</div>
      <div class="cov-step ${result < 0 ? "bad" : "good"}"><span>${result < 0 ? "Falta para cubrirlos" : "Utilidad después de gastos"}</span><b>${moneyDec(result)}</b></div>
    </div>
    <div class="kpis">
      <div class="kpi ${coverage >= 100 ? "good" : "warn"}"><span>Cobertura de gastos generales</span><b>${pct(coverage)}</b><small>margen bruto ÷ gastos generales</small></div>
      <div class="kpi"><span>Punto de equilibrio</span><b>${Number.isFinite(breakEven) ? money(Math.ceil(breakEven)) : "—"}</b><small>${Number.isFinite(breakEven) ? `ventas al mes para cubrir gastos (con margen ${pct(totalPct)})` : "necesita ventas con costo y gastos generales"}</small></div>
      <div class="kpi"><span>Gastos operacionales reales</span><b>${money(opex)}</b><small>registrados en Contabilidad este mes</small></div>
    </div>
    ${current ? `<p class="subtle">Mes en curso: día ${now.getDate()} de ${days}. El margen sigue sumando con cada venta.</p>` : ""}
    ${T.missing ? `<p class="acc-note">⚠️ ${money(T.missing)} en ventas no tienen costo registrado (productos sin receta o sin precio de compra al venderse); no suman al margen.</p>` : ""}
    ${!state.overheads.length ? `<p class="acc-note">Registra arriendo, servicios, nómina y otros en <button class="link" data-goto="gastos">Gastos generales</button> para ver la cobertura.</p>` : ""}`;
  $("#costCoverage").querySelector("[data-goto]")?.addEventListener("click", () => { state.costTab = "gastos"; renderCosteo(); });
}

// ---------- Granizados: costo directo y margen bruto por tamaño ----------
function renderProfitBoard(box) {
  const rows = state.products.flatMap(p => productSizes(p).map(s => ({ p, s, r: sizeCostOf(p, s) })));
  const title = ({ p, s }) => `${esc(p.name)} <small class="size-tag">${esc(s.name)}</small>`;
  const costed = rows.filter(x => x.r.hasRecipe && Number.isFinite(x.r.realMargin));
  costed.sort((a, b) => b.r.realMargin - a.r.realMargin);
  const pending = rows.filter(x => !costed.includes(x));
  const avg = avgOf(costed.map(x => x.r.realMargin));
  const tops = state.toppings.map(t => ({ t, r: toppingCostOf(t) }))
    .sort((a, b) => (Number.isFinite(b.r.margin) ? b.r.margin : -1e9) - (Number.isFinite(a.r.margin) ? a.r.margin : -1e9));

  box.innerHTML = `
    <div class="kpis">
      <div class="kpi"><span>Tamaños costeados</span><b>${costed.length} / ${rows.length}</b></div>
      <div class="kpi good"><span>Mayor margen bruto</span><b>${costed[0] ? title(costed[0]) : "—"}</b><small>${costed[0] ? pct(costed[0].r.realMargin) : ""}</small></div>
      <div class="kpi warn"><span>Menor margen bruto</span><b>${costed.length ? title(costed[costed.length - 1]) : "—"}</b><small>${costed.length ? pct(costed[costed.length - 1].r.realMargin) : ""}</small></div>
      <div class="kpi"><span>Margen bruto promedio</span><b>${pct(avg)}</b></div>
    </div>
    <p class="subtle">Costo directo = ingredientes + vaso, tapa, pitillo y otros insumos de la receta. El costo de cada insumo sale de su última compra en Inventario. Toca un producto para editar su receta.</p>

    <h3 class="sub-title">Granizados por tamaño</h3>
    ${rows.length ? `
    <div class="table-wrap"><table class="ctable">
      <thead><tr><th>Producto · tamaño</th><th>Precio de venta</th><th>Costo directo</th><th>Margen bruto</th><th>Margen bruto %</th><th>Precio</th></tr></thead>
      <tbody>
        ${costed.map(({ p, s, r }) => `
          <tr data-open-product="${esc(p.id)}" class="clickable ${r.profit < 0 ? "row-bad" : ""}">
            <td><b>${title({ p, s })}</b>${p.active === false ? ` <small class="muted-tag">inactivo</small>` : ""}${r.recipe.errors.length ? ` <small class="err-tag">receta incompleta</small>` : ""}
              <div class="pk-sub">ingredientes ${moneyDec(r.recipe.ingredients)} · empaque ${moneyDec(r.recipe.packaging)}${r.waste ? ` · merma ${moneyDec(r.waste)}` : ""}</div></td>
            <td>${moneyDec(r.salePrice)}</td><td>${moneyDec(r.total)}</td>
            <td class="${r.profit < 0 ? "neg" : "pos"}">${moneyDec(r.profit)}</td>
            <td class="mcell">${marginBar(r.realMargin)}</td>
            <td><small class="mode-tag">${r.auto ? "Automático" : "Manual"}</small></td>
          </tr>`).join("")}
        ${pending.map(({ p, s }) => `
          <tr data-open-product="${esc(p.id)}" class="clickable row-pending">
            <td><b>${title({ p, s })}</b></td><td>${money(s.price)}</td>
            <td colspan="4"><small class="err-tag">Sin receta</small> Toca para registrar sus insumos</td>
          </tr>`).join("")}
      </tbody></table></div>` : `<div class="empty-box">Aún no hay granizados. Créalos en Productos.</div>`}

    <h3 class="sub-title">Toppings <small>se suman al costo directo del granizado cuando el cliente los elige</small></h3>
    ${tops.length ? `
    <div class="table-wrap"><table class="ctable">
      <thead><tr><th>Topping</th><th>Costo directo</th><th>Precio adicional</th><th>Margen bruto</th><th>Margen bruto %</th></tr></thead>
      <tbody>${tops.map(({ t, r }) => `
        <tr data-open-topping="${esc(t.id)}" class="clickable ${r.hasRecipe ? (r.profit < 0 ? "row-bad" : "") : "row-pending"}">
          <td><b>${esc(t.name)}</b>${r.hasRecipe ? "" : ` <small class="err-tag">sin receta</small>`}</td>
          <td>${r.hasRecipe ? moneyDec(r.cost) : "—"}</td><td>+${money(t.price)}</td>
          <td class="${r.profit < 0 ? "neg" : "pos"}">${r.hasRecipe ? moneyDec(r.profit) : "—"}</td>
          <td class="mcell">${r.hasRecipe ? marginBar(r.margin) : "—"}</td>
        </tr>`).join("")}</tbody></table></div>` : `<div class="empty-box">Aún no hay toppings.</div>`}`;

  box.querySelectorAll("[data-open-product]").forEach(tr => {
    tr.onclick = () => openProductModal(state.products.find(p => p.id === tr.dataset.openProduct), { focusCosting: true });
  });
  box.querySelectorAll("[data-open-topping]").forEach(tr => {
    tr.onclick = () => openToppingModal(state.toppings.find(t => t.id === tr.dataset.openTopping), { focusCosting: true });
  });
}

// ---------- Extras y acompañantes: precio de compra, precio de venta y margen ----------
/**
 * Tabla editable: unidad, precio de compra (costo directo) y precio de venta.
 * Mientras se escribe, el margen se recalcula; al salir del campo se guarda.
 * El precio de compra es el mismo campo que actualiza cada compra en Inventario.
 */
function renderItemCosting(box, col) {
  const isExtra = col === "extras";
  const list = isExtra ? extrasList() : state.sides;
  const noun = isExtra ? "extra" : "acompañante";
  const rows = list.map(x => ({ x, r: Costing.itemCost(x) }));
  const withMargin = rows.filter(({ r }) => Number.isFinite(r.margin)).sort((a, b) => b.r.margin - a.r.margin);
  const best = withMargin[0], worst = withMargin[withMargin.length - 1];
  const costInput = x => (x.unitCost !== null && x.unitCost !== undefined && Number(x.unitCost) >= 0 ? thousands(Math.round(Number(x.unitCost))) : "");
  box.innerHTML = `
    <div class="kpis">
      <div class="kpi"><span>${isExtra ? "Extras" : "Acompañantes"} con costo</span><b>${withMargin.length} / ${rows.length}</b></div>
      <div class="kpi good"><span>Mayor margen bruto</span><b>${best ? esc(best.x.name) : "—"}</b><small>${best ? pct(best.r.margin) : ""}</small></div>
      <div class="kpi warn"><span>Menor margen bruto</span><b>${worst ? esc(worst.x.name) : "—"}</b><small>${worst ? pct(worst.r.margin) : ""}</small></div>
      <div class="kpi"><span>Margen bruto promedio</span><b>${pct(avgOf(withMargin.map(({ r }) => r.margin)))}</b></div>
    </div>
    <div class="toolbar">
      <p class="subtle grow">Costo directo = ${isExtra ? "precio de compra unitario" : "precio de compra o costo de preparación por unidad"}.
        Se actualiza solo con cada compra registrada en <b>Inventario</b>. Edita los valores directamente en la tabla.</p>
      <button class="btn" id="newItemBtn">+ Nuevo ${noun}</button>
    </div>
    ${rows.length ? `
    <datalist id="countUnits">${Stock.COUNT_UNITS.map(u => `<option value="${esc(u)}">`).join("")}</datalist>
    <div class="table-wrap"><table class="ctable inline-table">
      <thead><tr><th>Nombre</th><th>Cantidad / unidad</th><th>${isExtra ? "Precio de compra" : "Compra o preparación"}</th><th>Precio de venta</th><th class="num">Margen bruto</th><th>Margen bruto %</th><th></th></tr></thead>
      <tbody>${rows.map(({ x, r }) => `
        <tr data-inline-row="${esc(x.id)}" class="${r.profit < 0 ? "row-bad" : ""}">
          <td><b>${esc(x.name)}</b>${x.active === false ? ` <small class="muted-tag">inactivo</small>` : ""}${isExtra && x.category ? `<div class="pk-sub">${esc(x.category)}</div>` : ""}</td>
          <td><input class="inl-input inl-unit" data-f="unit" maxlength="20" list="countUnits" value="${esc(x.unit || "und")}" aria-label="Unidad"></td>
          <td><div class="money-input inl-money"><span>$</span><input data-f="unitCost" inputmode="numeric" placeholder="—" value="${costInput(x)}" aria-label="Precio de compra"></div></td>
          <td><div class="money-input inl-money"><span>$</span><input data-f="price" inputmode="numeric" placeholder="0" value="${isValidPrice(x.price) ? thousands(x.price) : ""}" aria-label="Precio de venta"></div></td>
          <td class="num" data-out="profit">${outProfit(r)}</td>
          <td class="mcell" data-out="margin">${marginBar(r.margin)}</td>
          <td class="pk-act"><button class="link" data-edit-item="${esc(x.id)}">Editar</button></td>
        </tr>`).join("")}</tbody>
    </table></div>` : `<div class="empty-box">Aún no hay ${isExtra ? "extras" : "acompañantes"}.</div>`}`;

  const byId = id => (isExtra ? extrasList() : state.sides).find(x => x.id === id);
  const open = x => (isExtra ? window.AdminKit.openExtraModal?.(x) : openSideModal(x));
  box.querySelector("#newItemBtn").onclick = () => open(null);
  box.querySelectorAll("[data-edit-item]").forEach(b => { b.onclick = () => open(byId(b.dataset.editItem) || null); });

  const rowValues = tr => ({
    unitCost: parseMoney(tr.querySelector('[data-f="unitCost"]').value),
    price: parseMoney(tr.querySelector('[data-f="price"]').value)
  });
  const repaintRow = tr => {
    const v = rowValues(tr);
    const r = Costing.itemCost({ unitCost: Number.isNaN(v.unitCost) ? null : v.unitCost, price: v.price });
    tr.querySelector('[data-out="profit"]').innerHTML = outProfit(r);
    tr.querySelector('[data-out="margin"]').innerHTML = marginBar(r.margin);
    tr.classList.toggle("row-bad", r.profit < 0);
  };
  box.addEventListener("input", e => {
    const tr = e.target.closest("[data-inline-row]");
    const f = e.target.dataset.f;
    if (!tr || (f !== "unitCost" && f !== "price")) return;
    const n = parseMoney(e.target.value);
    e.target.value = Number.isNaN(n) ? "" : thousands(n);
    repaintRow(tr);
  });
  box.addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target.closest("[data-inline-row]")) e.target.blur();
  });
  box.addEventListener("change", async e => {
    const tr = e.target.closest("[data-inline-row]");
    const f = e.target.dataset.f;
    if (!tr || !f) return;
    const x = byId(tr.dataset.inlineRow);
    if (!x) return;
    let value;
    if (f === "unit") {
      value = e.target.value.trim().replace(/\s+/g, " ").slice(0, 20) || "und";
      e.target.value = value;
    } else if (f === "unitCost") {
      const n = parseMoney(e.target.value);
      value = Number.isNaN(n) ? null : n;
      if (value !== null && !isValidPrice(value)) { toast("El precio de compra no es válido.", { type: "error" }); return; }
    } else if (f === "price") {
      value = parseMoney(e.target.value);
      if (!isValidPrice(value) || value === 0) {
        toast("El precio de venta debe ser mayor a $0.", { type: "error" });
        e.target.value = isValidPrice(x.price) ? thousands(x.price) : "";
        repaintRow(tr);
        return;
      }
    } else return;
    try {
      await updateDoc(doc(db, col, x.id), { [f]: value, updatedAt: serverTimestamp() });
      toast(`${x.name}: ${f === "unit" ? "unidad" : f === "price" ? "precio de venta" : "precio de compra"} guardado`, { type: "ok", duration: 1500 });
    } catch (err) {
      toast(friendlyError(err), { type: "error" });
    }
  });
}
function outProfit(r) {
  return Number.isFinite(r.profit) ? `<b class="${r.profit < 0 ? "neg" : "pos"}">${moneyDec(r.profit)}</b>` : `<small class="err-tag">falta costo</small>`;
}

function supplyUsage(supplyId) {
  const uses = r => (r && r.costing && Array.isArray(r.costing.recipe) ? r.costing.recipe : []).some(l => l.supplyId === supplyId);
  return [
    ...state.products.flatMap(p => productSizes(p).filter(uses).map(s => `${p.name} ${s.name}`)),
    ...state.toppings.filter(uses).map(t => `${t.name} (topping)`)
  ];
}

function renderSupplies(box) {
  box.innerHTML = `
    <div class="toolbar">
      <p class="subtle grow">Ingredientes, vasos, tapas, pitillos y demás insumos de las recetas. El precio de compra se actualiza solo
        con cada compra registrada en <b>Inventario</b> y todas las recetas que lo usan se recalculan.</p>
      <button class="btn" id="newSupplyBtn">+ Nuevo insumo</button>
    </div>
    ${state.supplies.length ? `
    <div class="table-wrap"><table class="ctable">
      <thead><tr><th>Insumo</th><th>Categoría</th><th>Cantidad comprada</th><th>Precio de compra</th><th>Costo por unidad</th><th>Usado en</th></tr></thead>
      <tbody>${state.supplies.map(s => {
        const per = Costing.supplyUnitCost(s);
        const base = Costing.baseUnit(s.purchaseUnit);
        const used = supplyUsage(s.id);
        return `
        <tr data-edit-supply="${esc(s.id)}" class="clickable">
          <td><b>${esc(s.name)}</b></td><td>${esc(s.category || "—")}</td>
          <td>${Costing.qty(Number(s.purchaseQty))} ${esc(s.purchaseUnit)}</td>
          <td>${money(s.purchasePrice)}</td>
          <td>${Number.isFinite(per) ? `${moneyDec(per)} / ${esc(base)}` : `<small class="err-tag">incompleto</small>`}</td>
          <td><small>${used.length ? esc(used.join(", ")) : "—"}</small></td>
        </tr>`;
      }).join("")}</tbody></table></div>` : `<div class="empty-box">Aún no hay insumos. Crea el primero con “+ Nuevo insumo”.</div>`}`;
  box.querySelector("#newSupplyBtn").onclick = () => openSupplyModal(null);
  box.querySelectorAll("[data-edit-supply]").forEach(tr => {
    tr.onclick = () => openSupplyModal(state.supplies.find(s => s.id === tr.dataset.editSupply));
  });
}

function openSupplyModal(supply) {
  const isNew = !supply;
  const used = isNew ? [] : supplyUsage(supply.id);
  openModal({
    title: isNew ? "Nuevo insumo" : "Editar insumo",
    wide: true,
    body: `
      ${supplyFieldsHTML(supply || {})}
      ${used.length ? `<p class="field-hint">Usado en: <b>${esc(used.join(", "))}</b></p>` : ""}
      <p class="form-error" id="formError" hidden></p>`,
    footer: `
      ${isNew ? "" : `<button class="btn btn-danger" id="deleteBtn">Eliminar</button>`}
      <span class="spacer"></span>
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn" id="saveBtn">Guardar</button>`,
    onMount(root) {
      const fields = bindSupplyFields(root.querySelector(".modal-body"));
      const errEl = root.querySelector("#formError");
      const saveBtn = root.querySelector("#saveBtn");
      saveBtn.onclick = async () => {
        const s = fields.read();
        const err = fields.validate(s);
        if (err) { errEl.textContent = err; errEl.hidden = false; return; }
        saveBtn.disabled = true;
        try {
          let id = supply && supply.id;
          // Si la unidad de compra cambia de tipo (ej. g → und), el stock pasa a llevarse en la nueva unidad
          const fresh = !isNew && state.supplies.find(x => x.id === id);
          const unitKindChanged = !!fresh &&
            Costing.unitInfo(Stock.stockUnit("supplies", fresh)).dim !== Costing.unitInfo(s.purchaseUnit).dim;
          if (isNew) id = (await addDoc(collection(db, COL.supplies), { ...s, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })).id;
          else await updateDoc(doc(db, COL.supplies, id), { ...s, ...(unitKindChanged ? { stockUnit: s.purchaseUnit } : {}), updatedAt: serverTimestamp() });
          closeModal();
          await waitForState(() => state.supplies.some(x => x.id === id && x.name === s.name && x.purchaseQty === s.purchaseQty &&
            x.purchaseUnit === s.purchaseUnit && x.purchasePrice === s.purchasePrice));
          const n = await syncDerived();
          if (unitKindChanged && Stock.isTracked(fresh)) {
            toast(`"${s.name}" cambió de tipo de unidad: revisa su stock en Inventario (ahora se cuenta en ${s.purchaseUnit}).`, { type: "error", duration: 7000 });
          } else {
            toast(isNew ? "Insumo creado" : `Insumo actualizado${n ? ` · ${n} costo(s) recalculado(s)` : ""}`, { type: "ok" });
          }
        } catch (e) {
          errEl.textContent = friendlyError(e); errEl.hidden = false; saveBtn.disabled = false;
        }
      };
      const delBtn = root.querySelector("#deleteBtn");
      if (delBtn) delBtn.onclick = async () => {
        const msg = used.length
          ? `"${supply.name}" se usa en: ${used.join(", ")}.\n\nSi lo eliminas, esas recetas quedarán incompletas hasta que lo reemplaces. ¿Eliminar de todas formas?`
          : `¿Eliminar el insumo "${supply.name}"?`;
        if (!confirm(msg)) return;
        delBtn.disabled = true;
        try {
          await deleteDoc(doc(db, COL.supplies, supply.id));
          closeModal();
          await waitForState(() => !state.supplies.some(x => x.id === supply.id));
          await syncDerived();
          toast("Insumo eliminado", { type: "ok" });
        } catch (e) { delBtn.disabled = false; toast(friendlyError(e), { type: "error" }); }
      };
    }
  });
}

/** Espera a que el estado en tiempo real refleje un cambio recién guardado. */
async function waitForState(cond, timeout = 2000) {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < timeout) await new Promise(r => setTimeout(r, 30));
}

// ---------- Gastos generales del negocio ----------
/**
 * Arriendo, servicios, nómina y otros gastos operativos (valor mensual).
 * NO se suman al costo de ningún producto: el margen bruto de granizados,
 * extras y acompañantes, en conjunto, debe cubrirlos (ver Resumen).
 */
function renderGeneralExpenses(box) {
  const cats = Costing.GENERAL_CATEGORIES;
  const list = state.overheads.map(o => ({ o, cat: Costing.generalCategory(o), value: Costing.generalMonthly(o) }));
  const active = list.filter(x => x.o.active !== false);
  const totalOf = arr => arr.reduce((s, x) => s + (Number.isFinite(x.value) ? x.value : 0), 0);
  const total = totalOf(active);
  box.innerHTML = `
    <div class="kpis">
      <div class="kpi warn"><span>Total mensual</span><b>${money(total)}</b><small>${active.length} gasto${active.length === 1 ? "" : "s"} activo${active.length === 1 ? "" : "s"}</small></div>
      ${Object.entries(cats).map(([k, l]) => `<div class="kpi"><span>${esc(l)}</span><b>${money(totalOf(active.filter(x => x.cat === k)))}</b></div>`).join("")}
    </div>
    <div class="acc-note">
      <p><b>Estos gastos no se suman al costo de cada producto.</b> Granizados, extras y acompañantes generan margen bruto
        y, en conjunto, ese margen debe cubrirlos. Mira la cobertura del mes en <button class="link" data-goto="resumen">Resumen</button>.</p>
    </div>
    <div class="toolbar">
      <span class="grow"></span>
      <button class="btn" id="newGeneralBtn">+ Nuevo gasto general</button>
    </div>
    ${list.length ? `
    <div class="table-wrap"><table class="ctable">
      <thead><tr><th>Gasto</th><th>Categoría</th><th class="num">Valor mensual</th><th>Estado</th><th></th></tr></thead>
      <tbody>${Object.keys(cats).flatMap(k => list.filter(x => x.cat === k)).map(({ o, cat, value }) => `
        <tr class="${o.active === false ? "row-pending" : ""}">
          <td><b>${esc(o.name)}</b>${o.note ? `<div class="pk-sub">${esc(o.note)}</div>` : ""}</td>
          <td>${esc(cats[cat])}</td>
          <td class="num">${Number.isFinite(value) ? `<b>${money(value)}</b>` : `<small class="err-tag">falta el valor mensual</small>`}</td>
          <td><label class="switch" title="Incluir en el total mensual">
            <input type="checkbox" data-toggle-general="${esc(o.id)}" ${o.active !== false ? "checked" : ""}>
            <span></span><em>${o.active !== false ? "Activo" : "Inactivo"}</em></label></td>
          <td class="pk-act"><button class="link" data-edit-general="${esc(o.id)}">Editar</button></td>
        </tr>`).join("")}</tbody>
      <tfoot><tr><td colspan="2">TOTAL MENSUAL (activos)</td><td class="num">${money(total)}</td><td colspan="2"></td></tr></tfoot>
    </table></div>`
    : `<div class="empty-box">Aún no hay gastos generales. Registra el arriendo, los servicios, la nómina y otros gastos del mes.</div>`}`;
  box.querySelector("[data-goto]").onclick = () => { state.costTab = "resumen"; renderCosteo(); };
  box.querySelector("#newGeneralBtn").onclick = () => openGeneralModal(null);
  box.querySelectorAll("[data-edit-general]").forEach(b => {
    b.onclick = () => openGeneralModal(state.overheads.find(o => o.id === b.dataset.editGeneral));
  });
  box.querySelectorAll("[data-toggle-general]").forEach(inp => {
    inp.onchange = async () => {
      inp.disabled = true;
      try {
        await updateDoc(doc(db, COL.overheads, inp.dataset.toggleGeneral), { active: inp.checked, updatedAt: serverTimestamp() });
      } catch (err) { inp.checked = !inp.checked; inp.disabled = false; toast(friendlyError(err), { type: "error" }); }
    };
  });
}

function openGeneralModal(item) {
  const o = item || { active: true };
  const isNew = !item;
  const cur = Costing.generalCategory(o);
  const value = Costing.generalMonthly(o);
  openModal({
    title: isNew ? "Nuevo gasto general" : "Editar gasto general",
    body: `
      <div class="form-grid one">
        <label class="field"><span>Nombre *</span>
          <input data-k="name" maxlength="60" value="${esc(o.name || "")}" placeholder="Ej: Arriendo del local"></label>
        <label class="field"><span>Categoría</span>
          <select data-k="category">${Object.entries(Costing.GENERAL_CATEGORIES).map(([k, l]) =>
            `<option value="${k}" ${k === cur ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
        <div class="field"><span>Valor mensual *</span>
          <div class="money-input"><span>$</span><input data-k="monthlyAmount" inputmode="numeric" value="${Number.isFinite(value) ? thousands(Math.round(value)) : ""}" placeholder="0"></div></div>
        <label class="field"><span>Nota</span>
          <input data-k="note" maxlength="120" value="${esc(o.note || "")}"></label>
        <div class="field"><span>Estado</span>
          <label class="switch big"><input type="checkbox" data-k="active" ${o.active !== false ? "checked" : ""}><span></span><em>Incluir en el total mensual</em></label></div>
        <p class="field-hint">No se suma al costo de los productos: el margen bruto de todo lo que vendes debe cubrirlo.</p>
        <p class="form-error" id="formError" hidden></p>
      </div>`,
    footer: `
      ${isNew ? "" : `<button class="btn btn-danger" id="deleteBtn">Eliminar</button>`}
      <span class="spacer"></span>
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn" id="saveBtn">Guardar</button>`,
    onMount(root) {
      const q = k => root.querySelector(`[data-k="${k}"]`);
      bindMoneyInput(q("monthlyAmount"));
      const errEl = root.querySelector("#formError");
      const saveBtn = root.querySelector("#saveBtn");
      saveBtn.onclick = async () => {
        const data = {
          name: q("name").value.trim(),
          category: Costing.GENERAL_CATEGORIES[q("category").value] ? q("category").value : "otros",
          monthlyAmount: parseMoney(q("monthlyAmount").value),
          note: q("note").value.trim(),
          active: q("active").checked
        };
        const err = !data.name ? "El nombre es obligatorio." :
          !isValidPrice(data.monthlyAmount) ? "Escribe el valor mensual." : "";
        if (err) { errEl.textContent = err; errEl.hidden = false; return; }
        saveBtn.disabled = true;
        try {
          if (isNew) {
            await addDoc(collection(db, COL.overheads), { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
          } else {
            // Los campos del antiguo reparto por unidad ya no se usan
            await updateDoc(doc(db, COL.overheads, item.id), {
              ...data, kind: deleteField(), method: deleteField(), amount: deleteField(), percent: deleteField(),
              monthlyCost: deleteField(), monthlyUnits: deleteField(), updatedAt: serverTimestamp()
            });
          }
          closeModal();
          toast(isNew ? "Gasto general creado" : "Gasto general actualizado", { type: "ok" });
        } catch (e) { errEl.textContent = friendlyError(e); errEl.hidden = false; saveBtn.disabled = false; }
      };
      const delBtn = root.querySelector("#deleteBtn");
      if (delBtn) delBtn.onclick = async () => {
        if (!confirm(`¿Eliminar el gasto general "${item.name}"?`)) return;
        delBtn.disabled = true;
        try {
          await deleteDoc(doc(db, COL.overheads, item.id));
          closeModal();
          toast("Gasto general eliminado", { type: "ok" });
        } catch (e) { delBtn.disabled = false; toast(friendlyError(e), { type: "error" }); }
      };
    }
  });
}

// =====================================================================
// TOPPINGS
// =====================================================================
function productsWithTopping(toppingId) {
  return state.products.filter(p => (p.toppingIds || []).includes(toppingId));
}

function renderToppings() {
  const view = $("#view-toppings");
  if (!state.catalogReady) { view.innerHTML = `<div class="loading-screen"><div class="spinner dark"></div></div>`; return; }
  view.innerHTML = `
    <div class="toolbar">
      <h2 class="view-title">Toppings <small>${state.toppings.length}</small></h2>
      <button class="btn" id="newToppingBtn">+ Nuevo topping</button>
    </div>
    ${state.toppings.length ? `
    <div class="cat-list">
      ${state.toppings.map(t => {
        const prods = productsWithTopping(t.id);
        return `
        <article class="cat-item small ${t.active === false ? "inactive" : ""}">
          <div class="ci-img">${t.image ? `<img src="${esc(t.image)}" alt="" loading="lazy">` : "✨"}</div>
          <div class="ci-main">
            <div class="ci-name">${esc(t.name)}</div>
            <div class="ci-meta">Orden ${Number(t.order) || 0} · ${prods.length ? esc(prods.map(p => p.name).join(", ")) : "Sin productos asignados"}</div>
            <div class="ci-price">+${money(t.price)}${toppingCostTag(t)}</div>
          </div>
          <div class="ci-actions">
            <label class="switch" title="Disponible">
              <input type="checkbox" data-toggle-topping="${esc(t.id)}" ${t.active !== false ? "checked" : ""}>
              <span></span><em>${t.active !== false ? "Activo" : "Inactivo"}</em>
            </label>
            <button class="btn btn-ghost btn-sm" data-edit-topping="${esc(t.id)}">Editar</button>
          </div>
        </article>`;
      }).join("")}
    </div>` : `<div class="empty-box">Aún no hay toppings. Crea el primero con “+ Nuevo topping”.</div>`}`;

  $("#newToppingBtn").onclick = () => openToppingModal(null);
  view.querySelectorAll("[data-edit-topping]").forEach(b => {
    b.onclick = () => openToppingModal(state.toppings.find(t => t.id === b.dataset.editTopping));
  });
  view.querySelectorAll("[data-toggle-topping]").forEach(inp => {
    inp.onchange = async () => {
      inp.disabled = true;
      try {
        await updateDoc(doc(db, COL.toppings, inp.dataset.toggleTopping), { active: inp.checked, updatedAt: serverTimestamp() });
        toast(inp.checked ? "Topping activado" : "Topping desactivado", { type: "ok", duration: 1800 });
      } catch (err) {
        inp.checked = !inp.checked;
        inp.disabled = false;
        toast(friendlyError(err), { type: "error" });
      }
    };
  });
}

function openToppingModal(topping, { focusCosting = false } = {}) {
  const t = topping || {};
  const isNew = !topping;
  const assigned = new Set(isNew ? [] : productsWithTopping(t.id).map(p => p.id));
  const nextOrder = state.toppings.reduce((m, x) => Math.max(m, Number(x.order) || 0), 0) + 1;

  openModal({
    title: isNew ? "Nuevo topping" : "Editar topping",
    wide: true,
    body: `
      <form id="toppingForm" class="form-grid" novalidate>
        <label class="field span2"><span>Nombre *</span>
          <input name="name" maxlength="40" required value="${esc(t.name || "")}"></label>
        <label class="field"><span>Precio adicional *</span>
          <div class="money-input"><span>+$</span><input name="price" inputmode="numeric" required value="${isValidPrice(t.price) ? thousands(t.price) : ""}" placeholder="0"></div></label>
        <label class="field"><span>Orden de aparición</span>
          <input name="order" type="number" min="0" max="9999" step="1" value="${t.order !== undefined && Number.isFinite(Number(t.order)) ? Number(t.order) : nextOrder}"></label>
        <div class="field span2"><span>Disponibilidad</span>
          <label class="switch big"><input type="checkbox" name="active" ${t.active !== false ? "checked" : ""}><span></span><em>Disponible</em></label></div>
        <div class="span2">${imagePicker(t.image || "", "Imagen (opcional)")}</div>
        <fieldset class="span2 fs">
          <legend>Productos a los que puede aplicarse</legend>
          ${state.products.length ? `
            <div class="check-grid">
              ${state.products.map(p => `
                <label class="check ${p.active === false ? "inactive" : ""}">
                  <input type="checkbox" name="productIds" value="${esc(p.id)}" ${assigned.has(p.id) ? "checked" : ""}>
                  <span>${esc(p.name)}${p.active === false ? " <small>· inactivo</small>" : ""}</span>
                </label>`).join("")}
            </div>
            <div class="mini-actions"><button type="button" class="link" id="checkAll">Seleccionar todos</button> · <button type="button" class="link" id="checkNone">Ninguno</button></div>`
          : `<p class="field-hint">Aún no hay productos.</p>`}
        </fieldset>
        <fieldset class="span2 fs costing-fs" id="costingFs">
          <legend>💰 Costeo del topping</legend>
          <div class="cost-layout">
            <div class="cost-main">
              <h4 class="cost-h">Receta por porción</h4>
              <div class="rcp" id="toppingRecipe"></div>
            </div>
            <aside class="cost-summary" id="toppingSummary"></aside>
          </div>
        </fieldset>
        <p class="form-error span2" id="formError" hidden></p>
      </form>`,
    footer: `
      ${isNew ? "" : `<button class="btn btn-danger" id="deleteBtn">Eliminar</button>`}
      <span class="spacer"></span>
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn" id="saveBtn">Guardar</button>`,
    onMount(root) {
      const form = root.querySelector("#toppingForm");
      form.addEventListener("submit", e => e.preventDefault());
      const getImage = bindImagePicker(root, t.image || "", TOPPING_IMG);
      bindMoneyInput(form.price);
      const costing = bindToppingCosting(root, t, form);
      if (focusCosting) setTimeout(() => root.querySelector("#costingFs").scrollIntoView({ block: "start" }), 30);
      const errEl = root.querySelector("#formError");
      const saveBtn = root.querySelector("#saveBtn");
      const setAll = v => form.querySelectorAll('input[name="productIds"]').forEach(i => { i.checked = v; });
      root.querySelector("#checkAll")?.addEventListener("click", () => setAll(true));
      root.querySelector("#checkNone")?.addEventListener("click", () => setAll(false));

      saveBtn.onclick = async () => {
        const fd = new FormData(form);
        const data = {
          name: String(fd.get("name") || "").trim(),
          price: parseMoney(fd.get("price")),
          order: parseInt(fd.get("order"), 10),
          active: form.active.checked,
          image: getImage(),
          costing: costing.read()
        };
        data.unitCost = data.costing.recipe.length ? Costing.round2(costing.compute().cost) : null;
        const productIds = new Set(fd.getAll("productIds").map(String));
        const error =
          !data.name ? "El nombre es obligatorio." :
          !isValidPrice(data.price) ? "Ingresa un precio válido (puede ser $0)." :
          !Number.isInteger(data.order) || data.order < 0 ? "El orden debe ser un número entero (0 o mayor)." :
          !isValidImageValue(data.image) ? "La imagen no es válida." : "";
        if (error) { errEl.textContent = error; errEl.hidden = false; return; }
        errEl.hidden = true;

        saveBtn.disabled = true;
        saveBtn.innerHTML = `<span class="spinner"></span> Guardando…`;
        try {
          const batch = writeBatch(db);
          const ref = isNew ? doc(collection(db, COL.toppings)) : doc(db, COL.toppings, t.id);
          if (isNew) batch.set(ref, { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
          else batch.update(ref, { ...data, updatedAt: serverTimestamp() });
          // La relación topping ↔ producto se guarda en el producto (toppingIds)
          for (const p of state.products) {
            const has = (p.toppingIds || []).includes(ref.id);
            const want = productIds.has(p.id);
            if (want && !has) batch.update(doc(db, COL.products, p.id), { toppingIds: arrayUnion(ref.id) });
            if (!want && has) batch.update(doc(db, COL.products, p.id), { toppingIds: arrayRemove(ref.id) });
          }
          await batch.commit();
          closeModal();
          toast(isNew ? "Topping creado" : "Topping actualizado", { type: "ok" });
          await waitForState(() => state.toppings.some(x => x.id === ref.id && x.price === data.price));
          syncDerived();
        } catch (err) {
          console.error(err);
          errEl.textContent = friendlyError(err);
          errEl.hidden = false;
          saveBtn.disabled = false;
          saveBtn.textContent = "Guardar";
        }
      };

      const delBtn = root.querySelector("#deleteBtn");
      if (delBtn) delBtn.onclick = async () => {
        if (!confirm(`¿Eliminar el topping "${topping.name}"?\n\nSe quitará de todos los productos. Los pedidos anteriores no se modifican.`)) return;
        delBtn.disabled = true;
        try {
          const batch = writeBatch(db);
          for (const p of productsWithTopping(topping.id)) {
            batch.update(doc(db, COL.products, p.id), { toppingIds: arrayRemove(topping.id) });
          }
          batch.delete(doc(db, COL.toppings, topping.id));
          await batch.commit();
          closeModal();
          toast("Topping eliminado", { type: "ok" });
        } catch (err) {
          delBtn.disabled = false;
          toast(friendlyError(err), { type: "error" });
        }
      };
    }
  });
}

// =====================================================================
// ACOMPAÑANTES (papitas, aperitivos… se piden aparte del granizado)
// =====================================================================
/** Interruptor activo/inactivo de una lista del catálogo. */
function bindActiveToggles(view, attr, col, labels) {
  view.querySelectorAll(`[${attr}]`).forEach(inp => {
    inp.onchange = async () => {
      inp.disabled = true;
      try {
        await updateDoc(doc(db, col, inp.getAttribute(attr)), { active: inp.checked, updatedAt: serverTimestamp() });
        toast(inp.checked ? labels[0] : labels[1], { type: "ok", duration: 1800 });
      } catch (err) {
        inp.checked = !inp.checked;
        inp.disabled = false;
        toast(friendlyError(err), { type: "error" });
      }
    };
  });
}

/** "Margen bruto: $1.500 (37,5%)" para los formularios de extras y acompañantes. */
function marginPreview(r) {
  if (!Number.isFinite(r.profit)) return `<small>Escribe el precio de compra y el de venta para ver el margen bruto.</small>`;
  return `<b class="${r.profit < 0 ? "neg-val" : ""}">${moneyDec(r.profit)}</b> · ${pct(r.margin)}
    <small>(${moneyDec(r.price)} − ${moneyDec(r.cost)})</small>`;
}

function renderSides() {
  const view = $("#view-acompanantes");
  if (!state.catalogReady) { view.innerHTML = `<div class="loading-screen"><div class="spinner dark"></div></div>`; return; }
  view.innerHTML = `
    <div class="toolbar">
      <h2 class="view-title">Acompañantes <small>${state.sides.length}</small></h2>
      <button class="btn" id="newSideBtn">+ Nuevo acompañante</button>
    </div>
    ${state.sides.length ? `
    <div class="cat-list">
      ${state.sides.map(s => `
        <article class="cat-item small ${s.active === false ? "inactive" : ""}">
          <div class="ci-img">${s.image ? `<img src="${esc(s.image)}" alt="" loading="lazy">` : "🍟"}</div>
          <div class="ci-main">
            <div class="ci-name">${esc(s.name)}</div>
            <div class="ci-meta">${esc(s.unit || "und")} · Orden ${Number(s.order) || 0}${s.description ? ` · ${esc(s.description)}` : ""}</div>
            <div class="ci-price">${money(s.price)}${Number.isFinite(s.unitCost)
              ? ` <small class="cost-tag ${s.unitCost > s.price ? "bad" : ""}">costo ${money(s.unitCost)} · margen bruto ${pct(Costing.itemCost(s).margin)}</small>`
              : ` <small class="cost-tag none">sin costo</small>`}</div>
          </div>
          <div class="ci-actions">
            <label class="switch" title="Disponible">
              <input type="checkbox" data-toggle-side="${esc(s.id)}" ${s.active !== false ? "checked" : ""}>
              <span></span><em>${s.active !== false ? "Activo" : "Inactivo"}</em>
            </label>
            <button class="btn btn-ghost btn-sm" data-edit-side="${esc(s.id)}">Editar</button>
          </div>
        </article>`).join("")}
    </div>` : `<div class="empty-box">Aún no hay acompañantes.</div>`}`;
  $("#newSideBtn").onclick = () => openSideModal(null);
  view.querySelectorAll("[data-edit-side]").forEach(b => {
    b.onclick = () => openSideModal(state.sides.find(s => s.id === b.dataset.editSide));
  });
  bindActiveToggles(view, "data-toggle-side", COL.sides, ["Acompañante activado", "Acompañante desactivado"]);
}

function openSideModal(side) {
  const s = side || {};
  const isNew = !side;
  const nextOrder = state.sides.reduce((m, x) => Math.max(m, Number(x.order) || 0), 0) + 1;
  openModal({
    title: isNew ? "Nuevo acompañante" : "Editar acompañante",
    wide: true,
    body: `
      <form id="sideForm" class="form-grid" novalidate>
        <label class="field span2"><span>Nombre *</span>
          <input name="name" maxlength="40" required value="${esc(s.name || "")}"></label>
        <label class="field span2"><span>Descripción</span>
          <textarea name="description" maxlength="120" rows="2">${esc(s.description || "")}</textarea></label>
        <label class="field"><span>Precio de compra o costo de preparación (por unidad)</span>
          <div class="money-input"><span>$</span><input name="unitCost" inputmode="numeric" value="${Number(s.unitCost) >= 0 && s.unitCost !== null && s.unitCost !== undefined ? thousands(Math.round(Number(s.unitCost))) : ""}" placeholder="0"></div>
          <small class="field-hint">Se actualiza solo con cada compra registrada en Inventario.</small></label>
        <label class="field"><span>Precio de venta *</span>
          <div class="money-input"><span>$</span><input name="price" inputmode="numeric" value="${isValidPrice(s.price) ? thousands(s.price) : ""}" placeholder="0"></div></label>
        <label class="field"><span>Cantidad / unidad</span>
          <input name="unit" maxlength="20" list="sideUnits" value="${esc(s.unit || "und")}">
          <datalist id="sideUnits">${Stock.COUNT_UNITS.map(u => `<option value="${esc(u)}">`).join("")}</datalist></label>
        <div class="field"><span>Margen bruto</span><div class="sup-preview" id="sideMargin"></div></div>
        <label class="field"><span>Orden de aparición</span>
          <input name="order" type="number" min="0" max="9999" step="1" value="${s.order !== undefined && Number.isFinite(Number(s.order)) ? Number(s.order) : nextOrder}"></label>
        <div class="field"><span>Disponibilidad</span>
          <label class="switch big"><input type="checkbox" name="active" ${s.active !== false ? "checked" : ""}><span></span><em>Disponible en el menú</em></label></div>
        <div class="span2">${imagePicker(s.image || "", "Imagen (opcional)")}</div>
        <p class="form-error span2" id="formError" hidden></p>
      </form>`,
    footer: `
      ${isNew ? "" : `<button class="btn btn-danger" id="deleteBtn">Eliminar</button>`}
      <span class="spacer"></span>
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn" id="saveBtn">Guardar</button>`,
    onMount(root) {
      const form = root.querySelector("#sideForm");
      form.addEventListener("submit", e => e.preventDefault());
      const getImage = bindImagePicker(root, s.image || "", SIDE_IMG);
      const showMargin = () => {
        const cost = parseMoney(form.unitCost.value);
        root.querySelector("#sideMargin").innerHTML = marginPreview(Costing.itemCost({ unitCost: Number.isNaN(cost) ? null : cost, price: parseMoney(form.price.value) }));
      };
      bindMoneyInput(form.price, showMargin);
      bindMoneyInput(form.unitCost, showMargin);
      showMargin();
      const errEl = root.querySelector("#formError");
      const saveBtn = root.querySelector("#saveBtn");
      saveBtn.onclick = async () => {
        const fd = new FormData(form);
        const cost = parseMoney(fd.get("unitCost"));
        const data = {
          name: String(fd.get("name") || "").trim(),
          description: String(fd.get("description") || "").trim(),
          price: parseMoney(fd.get("price")),
          unitCost: Number.isNaN(cost) ? null : cost,
          unit: String(fd.get("unit") || "").trim().replace(/\s+/g, " ").slice(0, 20) || "und",
          order: parseInt(fd.get("order"), 10),
          active: form.active.checked,
          image: getImage()
        };
        const error =
          !data.name ? "El nombre es obligatorio." :
          !isValidPrice(data.price) || data.price === 0 ? "Ingresa un precio de venta válido (mayor a $0)." :
          data.unitCost !== null && !isValidPrice(data.unitCost) ? "El costo no es válido." :
          !Number.isInteger(data.order) || data.order < 0 ? "El orden debe ser un número entero (0 o mayor)." :
          !isValidImageValue(data.image) ? "La imagen no es válida." : "";
        if (error) { errEl.textContent = error; errEl.hidden = false; return; }
        saveBtn.disabled = true;
        try {
          if (isNew) await addDoc(collection(db, COL.sides), { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
          else await updateDoc(doc(db, COL.sides, side.id), { ...data, updatedAt: serverTimestamp() });
          closeModal();
          toast(isNew ? "Acompañante creado" : "Acompañante actualizado", { type: "ok" });
        } catch (err) {
          errEl.textContent = friendlyError(err); errEl.hidden = false; saveBtn.disabled = false;
        }
      };
      const delBtn = root.querySelector("#deleteBtn");
      if (delBtn) delBtn.onclick = async () => {
        if (!confirm(`¿Eliminar "${side.name}"?\n\nLos pedidos anteriores no se modifican. Si solo quieres ocultarlo, desactívalo.`)) return;
        delBtn.disabled = true;
        try {
          await deleteDoc(doc(db, COL.sides, side.id));
          closeModal();
          toast("Acompañante eliminado", { type: "ok" });
        } catch (err) { delBtn.disabled = false; toast(friendlyError(err), { type: "error" }); }
      };
    }
  });
}

// =====================================================================
// PROMOCIONES (aparecen de primeras en el menú de pedidos)
// =====================================================================
const PROMO_COLORS = { rosa: "#ff2e88", lima: "#c6ff3d", amarillo: "#ffe14d", cian: "#22e8ff" };

function renderPromos() {
  const view = $("#view-promos");
  if (!state.catalogReady) { view.innerHTML = `<div class="loading-screen"><div class="spinner dark"></div></div>`; return; }
  const productName = id => state.products.find(p => p.id === id)?.name;
  const activeCount = state.promos.filter(p => p.active !== false).length;
  view.innerHTML = `
    <div class="toolbar">
      <h2 class="view-title">Promociones <small>${activeCount} activa${activeCount === 1 ? "" : "s"}</small></h2>
      <a class="btn btn-ghost" href="pedidos.html" target="_blank" rel="noopener">👀 Ver menú</a>
      <button class="btn" id="newPromoBtn">+ Nueva promo</button>
    </div>
    ${state.promos.length ? `
    <div class="cat-list">
      ${state.promos.map(pr => `
        <article class="cat-item ${pr.active === false ? "inactive" : ""}">
          <div class="ci-img promo-thumb" style="--pc:${PROMO_COLORS[pr.color] || PROMO_COLORS.rosa}">
            ${pr.image ? `<img src="${esc(pr.image)}" alt="" loading="lazy">` : `<b>${esc(pr.badge || "🔥")}</b>`}
          </div>
          <div class="ci-main">
            <div class="ci-name">${pr.badge ? `<span class="promo-chip">${esc(pr.badge)}</span> ` : ""}${esc(pr.title || "")}</div>
            <div class="ci-meta">${esc(pr.description || "")}</div>
            <div class="ci-meta">Orden ${Number(pr.order) || 0}${pr.productId ? ` · Botón “¡La quiero!” → ${esc(productName(pr.productId) || "producto eliminado")}` : " · Solo aviso (sin botón)"}</div>
          </div>
          <div class="ci-actions">
            <label class="switch" title="Mostrar en el menú">
              <input type="checkbox" data-toggle-promo="${esc(pr.id)}" ${pr.active !== false ? "checked" : ""}>
              <span></span><em>${pr.active !== false ? "Activa" : "Inactiva"}</em>
            </label>
            <button class="btn btn-ghost btn-sm" data-edit-promo="${esc(pr.id)}">Editar</button>
          </div>
        </article>`).join("")}
    </div>` : `<div class="empty-box">Aún no hay promociones.</div>`}`;
  $("#newPromoBtn").onclick = () => openPromoModal(null);
  view.querySelectorAll("[data-edit-promo]").forEach(b => {
    b.onclick = () => openPromoModal(state.promos.find(p => p.id === b.dataset.editPromo));
  });
  bindActiveToggles(view, "data-toggle-promo", COL.promos, ["Promo activada: ya aparece en el menú", "Promo desactivada"]);
}

function openPromoModal(promo) {
  const pr = promo || { color: "rosa", active: true };
  const isNew = !promo;
  const nextOrder = state.promos.reduce((m, x) => Math.max(m, Number(x.order) || 0), 0) + 1;
  openModal({
    title: isNew ? "Nueva promoción" : "Editar promoción",
    wide: true,
    body: `
      <form id="promoForm" class="form-grid" novalidate>
        <label class="field"><span>Texto grande</span>
          <input name="badge" maxlength="12" value="${esc(pr.badge || "")}"></label>
        <label class="field"><span>Etiqueta pequeña</span>
          <input name="tag" maxlength="24" value="${esc(pr.tag || "")}"></label>
        <label class="field span2"><span>Título *</span>
          <input name="title" maxlength="60" value="${esc(pr.title || "")}"></label>
        <label class="field span2"><span>Descripción</span>
          <textarea name="description" maxlength="160" rows="2">${esc(pr.description || "")}</textarea></label>
        <label class="field"><span>Botón “¡La quiero!” abre el producto…</span>
          <select name="productId">
            <option value="">— Ninguno (solo aviso) —</option>
            ${state.products.map(p => `<option value="${esc(p.id)}" ${p.id === pr.productId ? "selected" : ""}>${esc(p.name)}${p.active === false ? " (inactivo)" : ""}</option>`).join("")}
          </select></label>
        <label class="field"><span>Orden de aparición</span>
          <input name="order" type="number" min="0" max="9999" step="1" value="${pr.order !== undefined && Number.isFinite(Number(pr.order)) ? Number(pr.order) : nextOrder}"></label>
        <div class="field span2"><span>Color del aviso</span>
          <div class="opt-row">${Object.entries(PROMO_COLORS).map(([k, c]) => `
            <label class="radio color-pick"><input type="radio" name="color" value="${k}" ${(pr.color || "rosa") === k ? "checked" : ""}>
              <span class="swatch" style="background:${c}"></span><span>${k[0].toUpperCase() + k.slice(1)}</span></label>`).join("")}
          </div></div>
        <div class="field span2"><span>Estado</span>
          <label class="switch big"><input type="checkbox" name="active" ${pr.active !== false ? "checked" : ""}><span></span><em>Promo activa</em></label></div>
        <div class="span2">${imagePicker(pr.image || "", "Imagen de la promo (opcional)")}</div>
        <p class="form-error span2" id="formError" hidden></p>
      </form>`,
    footer: `
      ${isNew ? "" : `<button class="btn btn-danger" id="deleteBtn">Eliminar</button>`}
      <span class="spacer"></span>
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn" id="saveBtn">Guardar</button>`,
    onMount(root) {
      const form = root.querySelector("#promoForm");
      form.addEventListener("submit", e => e.preventDefault());
      const getImage = bindImagePicker(root, pr.image || "", PROMO_IMG);
      const errEl = root.querySelector("#formError");
      const saveBtn = root.querySelector("#saveBtn");
      saveBtn.onclick = async () => {
        const fd = new FormData(form);
        const data = {
          badge: String(fd.get("badge") || "").trim().toUpperCase(),
          tag: String(fd.get("tag") || "").trim(),
          title: String(fd.get("title") || "").trim(),
          description: String(fd.get("description") || "").trim(),
          productId: String(fd.get("productId") || ""),
          order: parseInt(fd.get("order"), 10),
          color: Object.keys(PROMO_COLORS).includes(fd.get("color")) ? fd.get("color") : "rosa",
          active: form.active.checked,
          image: getImage()
        };
        const error =
          !data.title ? "El título es obligatorio." :
          !Number.isInteger(data.order) || data.order < 0 ? "El orden debe ser un número entero (0 o mayor)." :
          !isValidImageValue(data.image) ? "La imagen no es válida." : "";
        if (error) { errEl.textContent = error; errEl.hidden = false; return; }
        saveBtn.disabled = true;
        try {
          if (isNew) await addDoc(collection(db, COL.promos), { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
          else await updateDoc(doc(db, COL.promos, promo.id), { ...data, updatedAt: serverTimestamp() });
          closeModal();
          toast(isNew ? "Promo creada" : "Promo actualizada", { type: "ok" });
        } catch (err) {
          errEl.textContent = friendlyError(err); errEl.hidden = false; saveBtn.disabled = false;
        }
      };
      const delBtn = root.querySelector("#deleteBtn");
      if (delBtn) delBtn.onclick = async () => {
        if (!confirm(`¿Eliminar la promo "${promo.title || promo.badge}"?`)) return;
        delBtn.disabled = true;
        try {
          await deleteDoc(doc(db, COL.promos, promo.id));
          closeModal();
          toast("Promo eliminada", { type: "ok" });
        } catch (err) { delBtn.disabled = false; toast(friendlyError(err), { type: "error" }); }
      };
    }
  });
}

// =====================================================================
// PARQUEADERO (admin): tarifa, vehículos dentro, pagos, recaudo e historial
// El vigilante usa parqueadero.html (solo entradas y salidas, sin dinero).
// =====================================================================
const parkingStatus = r => r.exited
  ? `<span class="pk-status out">SALIÓ</span>`
  : r.paid ? `<span class="pk-status ok">🟢 PAGADO</span>` : `<span class="pk-status pend">🔴 PENDIENTE DE PAGO</span>`;
const dateTime = ts => { const d = toDate(ts); return d ? `${dateLabel(d)} ${timeLabel(d)}` : "—"; };
function stayLabel(r) {
  const from = toDate(r.entryAt);
  if (!from) return "—";
  const mins = Math.max(0, Math.round(((toDate(r.exitAt) || new Date()) - from) / 60000));
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

function renderParking() {
  const view = $("#view-parqueadero");
  const today = dateKey(new Date());
  const rate = state.parking.rate;
  view.innerHTML = `
    <div class="toolbar">
      <h2 class="view-title">Parqueadero</h2>
      <a class="btn btn-ghost" href="parqueadero.html" target="_blank" rel="noopener">🚧 Abrir módulo del vigilante</a>
    </div>
    <div class="pk-top">
      ${state.user.role === "admin" ? `
      <form class="panel pk-rate" id="pkRateForm">
        <label class="field"><span>TARIFA FIJA DEL PARQUEADERO</span>
          <div class="money-input"><span>$</span><input id="pkRate" inputmode="numeric" autocomplete="off" placeholder="0" value="${isValidPrice(rate) ? thousands(rate) : ""}"></div></label>
        <button class="btn" type="submit" id="pkRateBtn">Guardar tarifa</button>
      </form>` : `
      <div class="panel pk-rate"><span class="field-label">TARIFA FIJA DEL PARQUEADERO</span>
        <b class="pk-rate-ro" id="pkRateRo">${isValidPrice(rate) && rate > 0 ? money(rate) : "Sin configurar"}</b>
        <small class="field-hint">Solo el administrador puede cambiarla.</small></div>`}
      <div class="kpis pk-kpis" id="pkKpis"></div>
    </div>

    <h3 class="sub-title">Vehículos dentro</h3>
    <div id="pkActive"></div>

    <h3 class="sub-title">Pagos, recaudo e historial</h3>
    <form id="pkHistForm" class="panel pk-hist-form">
      <label class="field"><span>Placa o cliente</span><input id="pkQ" type="search" autocomplete="off"></label>
      <label class="field"><span>Desde</span><input id="pkFrom" type="date" value="${today}" max="${today}"></label>
      <label class="field"><span>Hasta</span><input id="pkTo" type="date" value="${today}" max="${today}"></label>
      <button class="btn" type="submit" id="pkHistBtn">Buscar</button>
    </form>
    <div id="pkReport"></div>`;

  const rateInput = $("#pkRate");
  if (rateInput) bindMoneyInput(rateInput);
  $("#pkRateForm")?.addEventListener("submit", async e => {
    e.preventDefault();
    const n = parseMoney(rateInput.value);
    if (!isValidPrice(n) || n === 0) { toast("Escribe una tarifa válida (mayor a $0).", { type: "error" }); return; }
    const btn = $("#pkRateBtn");
    btn.disabled = true;
    try {
      await setDoc(doc(db, COL.settings, "parking"), { rate: n, updatedAt: serverTimestamp() });
      toast(`Tarifa guardada: ${money(n)}`, { type: "ok" });
    } catch (err) { toast(friendlyError(err), { type: "error" }); }
    finally { btn.disabled = false; }
  });
  $("#pkHistForm").addEventListener("submit", e => { e.preventDefault(); runParkingReport(); });
  $("#pkActive").addEventListener("click", e => {
    const b = e.target.closest("[data-pk]");
    if (!b) return;
    if (b.dataset.pk === "pay") markParkingPaid(b.dataset.id, b);
    if (b.dataset.pk === "unpay") undoParkingPaid(b.dataset.id);
  });
  renderParkingActive();
  refreshParkingToday();
  runParkingReport();
}

function renderParkingKpis() {
  const box = $("#pkKpis");
  if (!box) return;
  const a = state.parking.active;
  const pend = a.filter(r => !r.paid).length;
  const t = state.parking.today;
  box.innerHTML = `
    <div class="kpi"><span>Dentro ahora</span><b>${a.length}</b></div>
    <div class="kpi warn"><span>Pendientes de pago</span><b>${pend}</b></div>
    <div class="kpi good"><span>Pagados (por salir)</span><b>${a.length - pend}</b></div>
    <div class="kpi good"><span>Recaudo de hoy</span><b>${t ? money(t.revenue) : "…"}</b><small>${t ? `${t.count} pago${t.count === 1 ? "" : "s"}` : ""}</small></div>`;
}

function renderParkingActive() {
  const box = $("#pkActive");
  if (!box) return;
  renderParkingKpis();
  if (!state.parking.ready) { box.innerHTML = `<div class="loading-screen"><div class="spinner dark"></div></div>`; return; }
  const list = state.parking.active;
  if (!list.length) { box.innerHTML = `<div class="empty-box">No hay vehículos dentro del parqueadero.</div>`; return; }
  box.innerHTML = `
    <div class="table-wrap"><table class="ctable pk-table">
      <thead><tr><th>Placa</th><th>Cliente</th><th>Entrada</th><th>Tiempo</th><th>Valor</th><th>Estado</th><th></th></tr></thead>
      <tbody>${list.map(r => `
        <tr class="${r.paid ? "" : "pk-row-pend"}">
          <td><span class="plate">${esc(r.plate)}</span></td>
          <td class="pk-name">${esc(r.customerName)}</td>
          <td>${dateTime(r.entryAt)}</td>
          <td>${stayLabel(r)}</td>
          <td><b>${money(r.rate)}</b></td>
          <td>${parkingStatus(r)}${r.paid ? `<div class="pk-sub">Pagado ${timeLabel(toDate(r.paidAt))}</div>` : ""}</td>
          <td class="pk-act">${r.paid
            ? `<button class="link" data-pk="unpay" data-id="${esc(r.id)}">Anular pago</button>`
            : `<button class="btn btn-ok btn-sm" data-pk="pay" data-id="${esc(r.id)}">MARCAR COMO PAGADO</button>`}</td>
        </tr>`).join("")}</tbody>
    </table></div>`;
}

async function markParkingPaid(id, btn) {
  const r = state.parking.active.find(x => x.id === id);
  if (!r) return;
  if (!confirm(`¿Confirmas que el cliente pagó ${money(r.rate)} del vehículo ${r.plate}?`)) return;
  btn.disabled = true;
  try {
    await call("/api/gz/parking-pay", { id });
    toast(`🟢 ${r.plate} pagado · ya puede salir`, { type: "ok", duration: 6000, action: { label: "Deshacer", onClick: () => undoParkingPaid(id, true) } });
    runParkingReport();
  } catch (err) {
    btn.disabled = false;
    toast(err.message && !err.code ? err.message : friendlyError(err), { type: "error" });
  }
}

async function undoParkingPaid(id, skipConfirm = false) {
  const r = state.parking.active.find(x => x.id === id);
  if (!skipConfirm && !confirm(`¿Anular el pago del vehículo ${r ? r.plate : ""}?`)) return;
  try {
    await call("/api/gz/parking-unpay", { id });
    toast("Pago del parqueadero anulado");
    runParkingReport();
  } catch (err) {
    toast(err.message && !err.code ? err.message : friendlyError(err), { type: "error" });
  }
}

const dayStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

async function refreshParkingToday() {
  try {
    const from = dayStart(new Date());
    const snap = await getDocs(query(collection(db, COL.parking), where("paidAt", ">=", Timestamp.fromDate(from))));
    const paid = snap.docs.map(d => d.data()).filter(r => r.paid);
    state.parking.today = { revenue: paid.reduce((s, r) => s + (r.rate || 0), 0), count: paid.length };
  } catch (err) { console.error(err); }
  renderParkingKpis();
}

async function runParkingReport() {
  const box = $("#pkReport");
  if (!box) return;
  const fromStr = $("#pkFrom").value, toStr = $("#pkTo").value;
  if (!fromStr || !toStr || fromStr > toStr) { toast("Revisa el rango de fechas.", { type: "error" }); return; }
  const q = normalize($("#pkQ").value).replace(/[\s-]/g, "");
  const [fy, fm, fd] = fromStr.split("-").map(Number);
  const [ty, tm, td] = toStr.split("-").map(Number);
  const from = Timestamp.fromDate(new Date(fy, fm - 1, fd));
  const to = Timestamp.fromDate(new Date(ty, tm - 1, td + 1));
  const btn = $("#pkHistBtn");
  btn.disabled = true;
  box.innerHTML = `<div class="loading-screen"><div class="spinner dark"></div></div>`;
  try {
    const range = field => getDocs(query(collection(db, COL.parking), where(field, ">=", from), where(field, "<", to), orderBy(field, "desc"), limit(3000)));
    const [entries, payments] = await Promise.all([range("entryAt"), range("paidAt")]);
    const match = r => !q || normalize(r.plate).includes(q) || normalize(r.customerName).replace(/\s/g, "").includes(q);
    const rows = entries.docs.map(d => ({ id: d.id, ...d.data() })).filter(match);
    const paid = payments.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => r.paid && match(r));
    const revenue = paid.reduce((s, r) => s + (r.rate || 0), 0);
    state.parking.report = { rows, paid };
    box.innerHTML = `
      <div class="kpis">
        <div class="kpi good"><span>Recaudo del periodo</span><b>${money(revenue)}</b><small>${paid.length} pago${paid.length === 1 ? "" : "s"}</small></div>
        <div class="kpi"><span>Entradas</span><b>${rows.length}</b></div>
        <div class="kpi"><span>Salidas</span><b>${rows.filter(r => r.exited).length}</b></div>
        <div class="kpi warn"><span>Sin pagar</span><b>${rows.filter(r => !r.paid).length}</b></div>
      </div>
      <h4 class="pk-h">Pagos registrados</h4>
      ${paid.length ? `
      <div class="table-wrap"><table class="ctable pk-table">
        <thead><tr><th>Hora del pago</th><th>Placa</th><th>Cliente</th><th>Valor</th></tr></thead>
        <tbody>${paid.map(r => `
          <tr><td>${dateTime(r.paidAt)}</td><td><span class="plate">${esc(r.plate)}</span></td><td class="pk-name">${esc(r.customerName)}</td><td><b>${money(r.rate)}</b></td></tr>`).join("")}
        </tbody>
        <tfoot><tr><td colspan="3"><b>TOTAL RECAUDADO</b></td><td><b>${money(revenue)}</b></td></tr></tfoot>
      </table></div>` : `<div class="empty-box">No hay pagos en ese periodo.</div>`}
      <h4 class="pk-h">Historial de entradas y salidas</h4>
      ${rows.length ? `
      <div class="table-wrap"><table class="ctable pk-table">
        <thead><tr><th>Placa</th><th>Cliente</th><th>Entrada</th><th>Pago</th><th>Salida</th><th>Tiempo</th><th>Valor</th><th>Estado</th></tr></thead>
        <tbody>${rows.map(r => `
          <tr>
            <td><span class="plate">${esc(r.plate)}</span></td><td class="pk-name">${esc(r.customerName)}</td>
            <td>${dateTime(r.entryAt)}</td><td>${r.paid ? dateTime(r.paidAt) : "—"}</td><td>${r.exited ? dateTime(r.exitAt) : "—"}</td>
            <td>${stayLabel(r)}</td><td>${money(r.rate)}</td><td>${parkingStatus(r)}</td>
          </tr>`).join("")}</tbody>
      </table></div>` : `<div class="empty-box">No hay entradas en ese periodo.</div>`}`;
  } catch (err) {
    console.error(err);
    box.innerHTML = `<div class="empty-box">${esc(friendlyError(err))}</div>`;
  } finally {
    btn.disabled = false;
  }
}

// =====================================================================
// MODAL GENÉRICO
// =====================================================================
function openModal({ title, body, footer, wide = false, onMount }) {
  const modal = $("#modal");
  modal.innerHTML = `
    <div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header class="modal-head"><h3>${esc(title)}</h3><button class="icon-x" data-close aria-label="Cerrar">×</button></header>
      <div class="modal-body">${body}</div>
      <footer class="modal-foot">${footer}</footer>
    </div>`;
  modal.hidden = false;
  document.body.classList.add("no-scroll");
  modal.querySelectorAll("[data-close]").forEach(b => { b.onclick = closeModal; });
  onMount?.(modal);
}

function closeModal() {
  const modal = $("#modal");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  modal.innerHTML = "";
  state.recipeEditors.clear();
  document.body.classList.remove("no-scroll");
}

document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !$("#modal").hidden) closeModal();
});

// =====================================================================
// INICIO
// =====================================================================
$$(".nav-btn").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));
// Atajo: "/" enfoca la búsqueda de caja
document.addEventListener("keydown", e => {
  if (e.key === "/" && !/input|textarea|select/i.test(document.activeElement?.tagName || "") && $("#modal").hidden && state.user) {
    e.preventDefault();
    if (state.tab !== "caja") showTab("caja");
    $("#cajaSearch")?.focus();
  }
});

// Costeo de extras: se redibuja cuando cambia su catálogo (precio de compra, precio de venta…)
on("extras", () => {
  if (state.tab === "costeo" && ["extras", "resumen"].includes(state.costTab)) renderCosteo();
});

// Herramientas compartidas con los módulos extras.js, inventario.js y contabilidad.js
window.AdminKit = {
  state, openModal, closeModal, bindMoneyInput, thousands, quickAmounts, waitForState,
  on, emit, setBadge, showTab, syncDerived, suppliesById, decimalInput, toNumber, unitLabel,
  supplyFieldsHTML, bindSupplyFields, openSupplyModal, openSideModal, marginPreview,
  isTab: tab => state.tab === tab,
  can,
  user: () => state.user,
  /** fn(user) se llama al iniciar sesión (antes de abrir la primera pestaña). */
  onAuth(fn) { if (state.user) fn(state.user); else authListeners.push(fn); },
  /** render(full) se llama al mostrar la pestaña (full = true) o al refrescarla. */
  registerTab(tab, render) { tabModules[tab] = render; }
};
// Arranca cuando ya cargaron todos los scripts (los módulos se registran antes)
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
})();