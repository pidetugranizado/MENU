// =====================================================================
// NÚCLEO COMPARTIDO — usado por pedidos.html, admin.html y parqueadero.html
// Colecciones, roles, formatos, cálculos y componentes comunes.
// =====================================================================
(function () {
"use strict";

const { collection, onSnapshot } = window.Store;

const db = window.Store.db;

const COL = {
  products: "products",
  toppings: "toppings",
  orders: "orders",
  counters: "counters",
  supplies: "supplies",   // insumos (costeo)
  overheads: "overheads", // mano de obra y costos indirectos
  sides: "sides",         // acompañantes / aperitivos (papitas, etc.)
  promos: "promos",       // promociones que se muestran al inicio del menú
  parking: "parking",     // vehículos del parqueadero
  settings: "settings",   // configuración general (doc "parking": tarifa)
  extras: "extras",           // bebidas, cocteles, dulces…: se venden en caja y, si se marca, en pedidos
  extraSales: "extraSales",   // ventas de extras hechas por el cajero
  incomes: "incomes",         // contabilidad: ingresos registrados a mano
  expenses: "expenses",       // contabilidad: gastos registrados a mano
  inventoryMoves: "inventoryMoves" // inventario: compras, entradas, salidas por ventas y ajustes
};

// Campos de inventario guardados en insumos, extras y acompañantes.
// Cambiar solo estos campos (cada venta descuenta stock) no cambia el menú.
const STOCK_FIELDS = new Set(["stock", "minStock", "trackStock", "stockUnit", "supplier",
  "lastPurchasePrice", "lastPurchaseUnit", "lastPurchaseQty", "lastPurchaseAt"]);
/** Firma de una lista sin los campos de inventario (para saber si cambió algo más). */
function catalogSig(list) {
  return JSON.stringify(list, (k, v) => (STOCK_FIELDS.has(k) ? undefined : v));
}

// El primer pedido será #1001
const ORDER_COUNTER_START = 1000;
const NAME_MAX = 30;
const MAX_UNITS_PER_LINE = 20;
const MAX_SIDE_QTY = 20;

// Roles del personal y módulos de admin.html a los que entra cada uno.
// (El servidor aplica los mismos permisos: esto solo decide qué se muestra.)
const ROLE_LABELS = { admin: "Administrador", cajero: "Cajero", preparacion: "Área de preparación" };
const ROLE_TABS = {
  admin: ["parqueadero", "caja", "extras", "prep", "historial", "productos", "toppings", "acompanantes",
    "promos", "costeo", "inventario", "contabilidad", "usuarios"],
  // En "productos" caja y preparación solo marcan disponible / AGOTADO
  cajero: ["parqueadero", "caja", "extras", "prep", "productos"],
  preparacion: ["prep", "productos"]
};

const PAYMENT_METHODS = ["efectivo", "transferencia"];
const PAYMENT_LABELS = { efectivo: "Efectivo", transferencia: "Transferencia" };

// Modos de toppings de un producto
const TOPPING_MODE = { perUnit: "perUnit", shared: "shared" };

// ---------- Formatos ----------

/** Pesos colombianos enteros: 21500 → "$21.500" */
function money(value) {
  const n = Math.round(Number(value) || 0);
  const sign = n < 0 ? "-" : "";
  return sign + "$" + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** Convierte "8.000", "$ 8000", "8000" → 8000 (entero). Devuelve NaN si no hay dígitos. */
function parseMoney(text) {
  const digits = String(text ?? "").replace(/\D/g, "");
  return digits ? parseInt(digits, 10) : NaN;
}

function isValidPrice(n) {
  return Number.isInteger(n) && n >= 0 && n <= 100000000;
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Minúsculas y sin tildes, para búsquedas. */
function normalize(text) {
  return String(text ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function pad2(n) { return String(n).padStart(2, "0"); }

/** Fecha local → "2026-10-03" */
function dateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function timeLabel(date) {
  return date ? `${pad2(date.getHours())}:${pad2(date.getMinutes())}` : "--:--";
}

function dateLabel(date) {
  return date ? `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()}` : "";
}

/** Timestamp de Firestore | Date | null → Date | null */
function toDate(ts) {
  if (!ts) return null;
  if (ts instanceof Date) return ts;
  if (typeof ts.toDate === "function") return ts.toDate();
  return null;
}

function byDisplayOrder(a, b) {
  return (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.name).localeCompare(String(b.name), "es");
}

// ---------- Tamaños (onzas del vaso) ----------

// Tamaños sugeridos al crear un producto (todo se puede editar)
const DEFAULT_SIZES = ["12 oz", "16 oz", "22 oz"];

/**
 * Tamaños de un producto: [{ id, name, price, costing, unitCost }].
 * Productos creados antes de los tamaños se ven como uno solo ("Único").
 */
function productSizes(p) {
  if (!p) return [];
  if (Array.isArray(p.sizes) && p.sizes.length) return p.sizes;
  return [{ id: "unico", name: "Único", price: p.price, costing: p.costing || {}, unitCost: p.unitCost ?? null }];
}

/** Tamaños que el cliente puede elegir (nombre y precio válido). */
function sellableSizes(p) {
  return productSizes(p).filter(s => s && s.id && String(s.name || "").trim() && isValidPrice(s.price) && s.price > 0);
}

function findSize(p, sizeId) {
  return productSizes(p).find(s => s.id === sizeId) || null;
}

// ---------- Cálculo de precios (enteros) ----------

function unitTotal(basePrice, toppings) {
  return toppings.reduce((sum, t) => sum + t.price, basePrice);
}

/** Total de un pedido ya guardado (snapshot). */
function itemsTotal(items) {
  return items.reduce((sum, item) => sum + item.subtotal, 0);
}

// ---------- Catálogo en tiempo real ----------

/**
 * Escucha productos, toppings, acompañantes y promociones (y extras si se pide).
 * cb({ products, toppings, sides, promos, extras, ready, stockOnly }) se llama cada
 * vez que cambian. Con ignoreStock (por defecto) no avisa cuando solo cambió
 * el inventario; si no, avisa con stockOnly = true. Devuelve función para cancelar.
 */
function watchCatalog(cb, onError, { ignoreStock = true, extras = false } = {}) {
  const keys = ["products", "toppings", "sides", "promos", ...(extras ? ["extras"] : [])];
  const state = {};
  const sigs = {};
  const ready = new Set();
  keys.forEach(k => { state[k] = []; });
  const emit = stockOnly => cb({ ...state, ready: ready.size === keys.length, stockOnly });
  const toList = snap => snap.docs.map(d => ({ id: d.id, ...d.data() })).sort(byDisplayOrder);
  const unsubs = keys.map(k => onSnapshot(collection(db, COL[k]), snap => {
    state[k] = toList(snap);
    const sig = catalogSig(state[k]);
    const stockOnly = ready.has(k) && sig === sigs[k];
    sigs[k] = sig;
    ready.add(k);
    if (stockOnly && ignoreStock) return;
    emit(stockOnly);
  }, onError));
  return () => unsubs.forEach(u => u());
}

// ---------- Componentes HTML compartidos ----------

/**
 * Detalle de productos de un pedido (formato snapshot):
 * items: [{ name, basePrice, quantity, subtotal, units: [{ toppings:[{name,price}], total }] }]
 */
function renderItemsDetail(items) {
  return items.map(item => `
      <div class="rx-item">
        <div class="rx-item-head">${item.quantity} × ${esc(item.name)}${item.sizeName ? ` <span class="rx-size">${esc(item.sizeName)}</span>` : ""}</div>
        ${renderUnitsDetail(item)}
      </div>`).join("");
}

/** Unidades de un producto (base + toppings + total) y su subtotal. */
function renderUnitsDetail(item) {
  const units = item.units.map((u, i) => `
      <div class="rx-unit">
        <div class="rx-unit-title">Unidad ${i + 1}</div>
        <div class="rx-row"><span>${item.sizeName ? `Tamaño ${esc(item.sizeName)}` : "Base"}</span><span>${money(item.basePrice)}</span></div>
        ${u.mix ? `
          <div class="rx-row rx-mix"><span>🌀 MODO MIX · sabores al reclamar</span><span></span></div>` : ""}
        ${u.toppings.map(t => `
          <div class="rx-row rx-top"><span>${esc(t.name)}</span><span>+${money(t.price)}</span></div>`).join("")}
        <div class="rx-row rx-unit-total"><span>Total unidad</span><span>${money(u.total)}</span></div>
      </div>`).join("");
  return `${units}
      <div class="rx-row rx-subtotal"><span>Subtotal</span><span>${money(item.subtotal)}</span></div>`;
}

/** Acompañantes de un pedido: sides: [{ name, price, quantity, subtotal }] */
function renderSidesDetail(sides) {
  if (!sides || !sides.length) return "";
  return `
      <div class="rx-item rx-sides">
        <div class="rx-item-head">🍟 Acompañantes</div>
        ${sides.map(s => `
          <div class="rx-row"><span>${s.quantity} × ${esc(s.name)} <small class="rx-each">(${money(s.price)} c/u)</small></span><span>${money(s.subtotal)}</span></div>`).join("")}
      </div>`;
}

/** Extras pedidos desde la web, agrupados por su categoría (ej: "Cocteles"). */
function renderExtrasDetail(extras) {
  if (!extras || !extras.length) return "";
  const groups = new Map();
  extras.forEach(x => {
    const cat = String(x.category || "").trim() || "Extras";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(x);
  });
  return [...groups].map(([cat, list]) => `
      <div class="rx-item rx-sides">
        <div class="rx-item-head">🛍️ ${esc(cat)}</div>
        ${list.map(x => `
          <div class="rx-row"><span>${x.quantity} × ${esc(x.name)} <small class="rx-each">(${money(x.price)} c/u)</small></span><span>${money(x.subtotal)}</span></div>`).join("")}
      </div>`).join("");
}

/** Pantalla de error/configuración a página completa. */
function showFatal(container, title, message) {
  container.innerHTML = `
    <div class="fatal">
      <div class="fatal-icon">⚠️</div>
      <h2>${esc(title)}</h2>
      <p>${message}</p>
    </div>`;
}

/** Mensaje de error amigable. */
function friendlyError(err) {
  const code = err && err.code ? String(err.code) : "";
  if (code.includes("unavailable") || code.includes("network")) return "Sin conexión con el servidor. Revisa tu internet e inténtalo de nuevo.";
  if (code.includes("unauthenticated")) return "Tu sesión terminó. Inicia sesión de nuevo.";
  if (code.includes("permission-denied")) return (err && err.message) || "No tienes permiso para realizar esta acción.";
  if (code.includes("aborted")) return "Hubo mucha actividad al mismo tiempo. Inténtalo de nuevo.";
  if (code.includes("resource-exhausted")) return "Demasiadas solicitudes seguidas. Espera unos segundos e inténtalo de nuevo.";
  return (err && err.message) ? err.message : "Ocurrió un error inesperado.";
}

let toastTimer = null;
/** Notificación breve. action = { label, onClick } opcional. */
function toast(message, { type = "info", action = null, duration = 3200 } = {}) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.className = `toast show toast-${type}`;
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ""}`;
  if (action) el.querySelector("button").onclick = () => { el.classList.remove("show"); action.onClick(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), duration);
}

window.Core = {
  db, COL, STOCK_FIELDS, catalogSig, ORDER_COUNTER_START, NAME_MAX, MAX_UNITS_PER_LINE, MAX_SIDE_QTY,
  PAYMENT_METHODS, PAYMENT_LABELS, TOPPING_MODE, ROLE_LABELS, ROLE_TABS,
  DEFAULT_SIZES, productSizes, sellableSizes, findSize,
  money, parseMoney, isValidPrice, esc, normalize, pad2, dateKey, timeLabel, dateLabel, toDate,
  byDisplayOrder, unitTotal, itemsTotal, watchCatalog, renderItemsDetail, renderUnitsDetail, renderSidesDetail, renderExtrasDetail,
  showFatal, friendlyError, toast
};
})();