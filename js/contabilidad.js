// =====================================================================
// CONTABILIDAD — Ingresos · Gastos · Estado de resultados · Gráficas
//
// Reúne todo el ecosistema del negocio:
//   • Pedidos web pagados  → Granizados (un solo rubro) y Acompañantes (por nombre)
//   • Ventas de Extras     → Extras (por nombre)
//   • Parqueadero pagado   → Parqueadero
//   • Ingresos manuales    → al rubro que se elija (u "Otros ingresos")
//   • Gastos manuales      → costo de ventas, operacionales, no operacionales e impuestos
// Un ingreso cuenta en la fecha en que se recibió el dinero (fecha de pago).
// El estado de resultados es mensual y acumulado del 1 de enero al 31 de diciembre.
// =====================================================================
(function () {
"use strict";

const {
  db, COL, money, parseMoney, isValidPrice, esc, normalize, dateKey, timeLabel, dateLabel, toDate, friendlyError, toast
} = window.Core;
const { collection, doc, query, where, getDocs, addDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp } = window.Store;
const Kit = window.AdminKit;
const Charts = window.Charts;
const XL = window.XlsxWriter;
const $ = sel => document.querySelector(sel);

const BUSINESS = "Granizados";
const MONTHS = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const MONTHS_SHORT = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const WEEKDAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

const RUBROS = {
  granizados: "Granizados",
  acompanantes: "Acompañantes",
  extras: "Extras",
  parqueadero: "Parqueadero",
  otros: "Otros ingresos"
};
const SOURCES = { pedido: "Pedido", extra: "Venta extra", parqueadero: "Parqueadero", manual: "Manual" };
const PAY = { efectivo: "Efectivo", transferencia: "Transferencia", tarjeta: "Tarjeta", otro: "Otro" };
const EXP_TYPES = {
  costo: {
    label: "Costo de ventas",
    hint: "Lo que compras para producir o revender: insumos, empaques, mercancía de extras.",
    cats: ["Insumos y materia prima", "Empaques y desechables", "Mercancía para extras", "Mercancía para acompañantes", "Hielo y agua", "Otros costos de venta"]
  },
  operacional: {
    label: "Gasto operacional",
    hint: "Lo que cuesta mantener el negocio funcionando.",
    cats: ["Arriendo", "Servicios públicos", "Nómina y salarios", "Seguridad social y prestaciones", "Mantenimiento y reparaciones",
      "Publicidad y redes", "Transporte y domicilios", "Aseo y cafetería", "Papelería", "Software y suscripciones", "Otros gastos operacionales"]
  },
  no_operacional: {
    label: "Gasto no operacional",
    hint: "Gastos financieros y otros que no son de la operación.",
    cats: ["Gastos bancarios", "Comisiones de datáfono", "Intereses", "Multas y sanciones", "Otros gastos no operacionales"]
  },
  impuestos: {
    label: "Impuestos",
    hint: "Impuestos a cargo del negocio.",
    cats: ["Impuesto de renta", "Industria y comercio (ICA)", "Impuesto al consumo", "Otros impuestos"]
  }
};
const COST_METHODS = {
  compras: "Compras registradas en Gastos",
  recetas: "Costeo de recetas de cada venta"
};
const COST_KEY = "granizados.acc.costMethod";
const MAX_HISTORY_ROWS = 400;

// ---------- Utilidades ----------
const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
const sum = arr => arr.reduce((s, v) => s + (v || 0), 0);
const ymd = s => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const pctTxt = v => (Number.isFinite(v) ? `${(v * 100).toLocaleString("es-CO", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%` : "—");
const share = (v, total) => (total ? v / total : NaN);
const plural = (n, one, many) => `${n.toLocaleString("es-CO")} ${n === 1 ? one : many}`;
const moneyCell = v => `<span class="${v < 0 ? "neg-val" : ""}">${money(v)}</span>`;
const kpiMoney = v => `<b class="${v < 0 ? "neg-val" : ""}">${money(v)}</b>`;
/** Al agrupar por nombre, prefiere el nombre del catálogo sobre el escrito a mano. */
const betterLabel = (cur, l) => (cur.manual && l.source !== "manual" ? { label: l.concept, manual: false } : null);
const spinner = `<div class="loading-screen small"><div class="spinner dark"></div></div>`;
const readPref = (k, def) => { try { return localStorage.getItem(k) || def; } catch { return def; } };
const savePref = (k, v) => { try { localStorage.setItem(k, v); } catch { /* nada */ } };

const now = new Date();
const acc = {
  sub: "ingresos",                       // ingresos | gastos | resultados | graficas
  from: dateKey(new Date(now.getFullYear(), now.getMonth(), 1)),
  to: dateKey(now),
  period: null, periodKey: "",
  hq: "", hsrc: "",                      // filtros del historial de ingresos
  gq: "", gtype: "",                     // filtros del historial de gastos
  year: now.getFullYear(),
  month: now.getMonth(),
  erView: "mes",                         // mes | anual
  costMethod: readPref(COST_KEY, "compras") === "recetas" ? "recetas" : "compras",
  gMonth: "",                            // gráficas: "" = todo el año, o 0..11
  years: new Map(),                      // caché por año
  token: 0
};

// =====================================================================
// DATOS: une pedidos, extras, parqueadero, ingresos y gastos manuales
// =====================================================================
async function loadRange(from, to) {
  const ts = d => Timestamp.fromDate(d);
  const range = (col, field) => getDocs(query(collection(db, col), where(field, ">=", ts(from)), where(field, "<", ts(to))));
  const [orders, extraSales, parking, incomes, expenses] = await Promise.all([
    range(COL.orders, "paidAt"),
    range(COL.extraSales, "createdAt"),
    range(COL.parking, "paidAt"),
    range(COL.incomes, "date"),
    range(COL.expenses, "date")
  ]);
  const lines = [];

  for (const d of orders.docs) {
    const o = d.data();
    const date = toDate(o.paidAt);
    if (!o.paid || !date) continue;
    const base = { date, source: "pedido", txId: "o" + d.id, ref: `Pedido #${o.number}`, method: o.paidMethod || o.paymentMethod || "", who: o.customerName || "" };
    (o.items || []).forEach(i => lines.push({
      ...base, rubro: "granizados", concept: i.sizeName ? `${i.name} · ${i.sizeName}` : i.name, product: i.name,
      qty: i.quantity || 0, amount: i.subtotal || 0, cost: num(i.costSubtotal)
    }));
    (o.sides || []).forEach(s => lines.push({
      ...base, rubro: "acompanantes", concept: s.name, product: s.name,
      qty: s.quantity || 0, amount: s.subtotal || 0, cost: num(s.costSubtotal)
    }));
    // Extras pedidos desde la web: mismo rubro que los vendidos en caja
    (o.extras || []).forEach(x => lines.push({
      ...base, rubro: "extras", concept: x.name, product: x.name,
      qty: x.quantity || 0, amount: x.subtotal || 0, cost: num(x.costSubtotal)
    }));
  }

  for (const d of extraSales.docs) {
    const s = d.data();
    const date = toDate(s.createdAt);
    if (s.voided || !date) continue;
    const base = { date, source: "extra", txId: "e" + d.id, ref: `Extra E-${s.number}`, method: s.paymentMethod || "", who: s.customerName || "" };
    (s.items || []).forEach(i => lines.push({
      ...base, rubro: "extras", concept: i.name, product: i.name,
      qty: i.quantity || 0, amount: i.subtotal || 0, cost: num(i.costSubtotal)
    }));
  }

  for (const d of parking.docs) {
    const r = d.data();
    const date = toDate(r.paidAt);
    if (!r.paid || !date) continue;
    lines.push({
      date, source: "parqueadero", txId: "p" + d.id, ref: `Placa ${r.plate || ""}`, method: "", who: r.customerName || "",
      rubro: "parqueadero", concept: "Parqueadero", product: "Parqueadero", qty: 1, amount: r.rate || 0, cost: 0
    });
  }

  for (const d of incomes.docs) {
    const r = d.data();
    const date = toDate(r.date);
    if (!date) continue;
    const rubro = RUBROS[r.rubro] ? r.rubro : "otros";
    const concept = String(r.concept || "").trim() || RUBROS[rubro];
    lines.push({
      date, source: "manual", txId: "m" + d.id, id: d.id, ref: "Registro manual", method: r.paymentMethod || "", who: "",
      rubro, concept, product: concept, qty: num(r.quantity), amount: r.amount || 0, cost: num(r.cost),
      note: r.note || "", raw: { id: d.id, ...r }
    });
  }

  const exp = expenses.docs.map(d => ({ id: d.id, ...d.data() }))
    .map(e => ({ ...e, date: toDate(e.date), type: EXP_TYPES[e.type] ? e.type : "operacional" }))
    .filter(e => e.date);

  lines.sort((a, b) => b.date - a.date);
  exp.sort((a, b) => b.date - a.date);
  return { lines, expenses: exp };
}

/** Datos de un año completo (con caché corta para no recargar al cambiar de vista). */
function yearData(year) {
  const c = acc.years.get(year);
  if (c && Date.now() - c.at < 20000) return c.p;
  const p = loadRange(new Date(year, 0, 1), new Date(year + 1, 0, 1));
  acc.years.set(year, { at: Date.now(), p });
  p.catch(() => acc.years.delete(year));
  return p;
}

function invalidate() {
  acc.years.clear();
  acc.period = null;
  acc.periodKey = "";
}

/** Agrupa ingresos por rubro; acompañantes, extras y otros se separan por nombre. */
function groupIncome(lines) {
  const g = {};
  Object.keys(RUBROS).forEach(r => { g[r] = { amount: 0, qty: 0, count: 0, items: new Map() }; });
  for (const l of lines) {
    const r = g[l.rubro] || g.otros;
    r.amount += l.amount;
    r.qty += l.qty || 0;
    r.count++;
    const key = normalize(l.rubro === "granizados" ? l.product : l.concept);
    const it = r.items.get(key) || { label: l.rubro === "granizados" ? l.product : l.concept, manual: l.source === "manual", amount: 0, qty: 0 };
    if (l.rubro !== "granizados") Object.assign(it, betterLabel(it, l));
    it.amount += l.amount;
    it.qty += l.qty || 0;
    r.items.set(key, it);
  }
  Object.values(g).forEach(r => { r.list = [...r.items.values()].sort((a, b) => b.amount - a.amount); });
  return g;
}

/** Estructura del informe por rubro (para pantalla y Excel). */
function incomeStructure(g) {
  return [
    { label: "Granizados", qty: g.granizados.qty, value: g.granizados.amount, children: [] },
    { label: "Acompañantes", qty: g.acompanantes.qty, value: g.acompanantes.amount, children: g.acompanantes.list.map(i => ({ label: i.label, qty: i.qty, value: i.amount })) },
    { label: "Extras", qty: g.extras.qty, value: g.extras.amount, children: g.extras.list.map(i => ({ label: i.label, qty: i.qty, value: i.amount })) },
    { label: "Parqueadero", qty: g.parqueadero.qty, value: g.parqueadero.amount, children: [] },
    ...(g.otros.count ? [{ label: "Otros ingresos", qty: g.otros.qty, value: g.otros.amount, children: g.otros.list.map(i => ({ label: i.label, qty: i.qty, value: i.amount })) }] : [])
  ];
}

function expenseStructure(expenses) {
  return Object.entries(EXP_TYPES).map(([k, t]) => {
    const list = expenses.filter(e => e.type === k);
    const cats = new Map();
    list.forEach(e => {
      const key = normalize(e.category || "Sin categoría");
      const c = cats.get(key) || { label: e.category || "Sin categoría", value: 0, qty: 0 };
      c.value += e.amount || 0;
      c.qty++;
      cats.set(key, c);
    });
    return { label: t.label, qty: list.length, value: sum(list.map(e => e.amount)), children: [...cats.values()].sort((a, b) => b.value - a.value) };
  });
}

// =====================================================================
// ESTADO DE RESULTADOS (modelo compartido por pantalla, gráficas y Excel)
// =====================================================================
function buildStatement({ lines, expenses }, method) {
  const zero = () => Array(12).fill(0);
  const monthly = (list, val) => { const v = zero(); list.forEach(x => { v[x.date.getMonth()] += val(x) || 0; }); return v; };
  const named = (list, keyFn, val) => {
    const map = new Map();
    list.forEach(x => {
      const label = String(keyFn(x) || "Sin categoría").trim() || "Sin categoría";
      const k = normalize(label);
      if (!map.has(k)) map.set(k, { label, manual: x.source === "manual", items: [] });
      const e = map.get(k);
      if (e.manual && x.source && x.source !== "manual") { e.label = label; e.manual = false; }
      e.items.push(x);
    });
    return [...map.values()].map(e => ({ label: e.label, values: monthly(e.items, val) }))
      .sort((a, b) => sum(b.values) - sum(a.values));
  };
  const rows = [];
  const byId = new Map();
  let seq = 0;
  const add = (kind, label, extra = {}) => {
    const r = { id: ++seq, kind, label, values: zero(), ...extra };
    rows.push(r);
    byId.set(r.id, r);
    return r;
  };
  const group = (label, children) => {
    const g = add("group", label, { children: [] });
    children.forEach(c => g.children.push(add("child", c.label, { values: c.values }).id));
    g.values = zero().map((_, i) => sum(children.map(c => c.values[i])));
    return g;
  };
  const combine = (kind, label, ids, signs = []) => {
    const terms = ids.map((id, i) => [signs[i] ?? 1, id]);
    return add(kind, label, { terms, values: zero().map((_, m) => sum(terms.map(([s, id]) => s * byId.get(id).values[m]))) });
  };
  const byR = r => lines.filter(l => l.rubro === r);
  const amount = l => l.amount;
  const warnings = [];

  add("section", "Ingresos operacionales");
  const gz = add("line", "Granizados", { values: monthly(byR("granizados"), amount) });
  const ac = group("Acompañantes", named(byR("acompanantes"), l => l.concept, amount));
  const ex = group("Extras", named(byR("extras"), l => l.concept, amount));
  const pk = add("line", "Parqueadero", { values: monthly(byR("parqueadero"), amount) });
  const ti = combine("total", "Total ingresos operacionales", [gz.id, ac.id, ex.id, pk.id]);

  add("section", "Costo de ventas");
  let costIds;
  const purchases = expenses.filter(e => e.type === "costo");
  if (method === "recetas") {
    const cost = l => l.cost || 0;
    costIds = [
      add("line", "Costo de granizados", { values: monthly(byR("granizados"), cost) }).id,
      add("line", "Costo de acompañantes", { values: monthly(byR("acompanantes"), cost) }).id,
      add("line", "Costo de extras", { values: monthly(byR("extras"), cost) }).id
    ];
    const missing = lines.filter(l => ["granizados", "acompanantes", "extras"].includes(l.rubro) && l.cost === null);
    if (missing.length) warnings.push(`${plural(missing.length, "línea vendida no tiene", "líneas vendidas no tienen")} costeo registrado (${money(sum(missing.map(amount)))} en ventas); su costo cuenta como $0. Configura las recetas en Costeo o los costos en Acompañantes/Extras.`);
    if (purchases.length) warnings.push(`Las compras registradas como “Costo de ventas” (${money(sum(purchases.map(e => e.amount)))}) no se restan aquí para no contar dos veces el costo.`);
  } else {
    const cats = named(purchases, e => e.category, e => e.amount);
    costIds = cats.length
      ? cats.map(c => add("line", c.label, { values: c.values }).id)
      : [add("line", "Compras de insumos y mercancía").id];
    if (!purchases.length && lines.length) warnings.push("No hay compras registradas como “Costo de ventas” en este año. Regístralas en Gastos o cambia el método a “costeo de recetas”.");
  }
  const tc = combine("total", "Total costo de ventas", costIds);
  const ub = combine("result", "Utilidad bruta", [ti.id, tc.id], [1, -1]);
  add("ratio", "Margen bruto", { ratio: [ub.id, ti.id] });

  add("section", "Gastos operacionales");
  const opCats = named(expenses.filter(e => e.type === "operacional"), e => e.category, e => e.amount);
  const opIds = opCats.length ? opCats.map(c => add("line", c.label, { values: c.values }).id) : [add("line", "Gastos de administración y ventas").id];
  const tgo = combine("total", "Total gastos operacionales", opIds);
  const uo = combine("result", "Utilidad operacional", [ub.id, tgo.id], [1, -1]);
  add("ratio", "Margen operacional", { ratio: [uo.id, ti.id] });

  add("section", "Ingresos y gastos no operacionales");
  const oi = group("Otros ingresos", named(byR("otros"), l => l.concept, amount));
  const og = group("Otros gastos", named(expenses.filter(e => e.type === "no_operacional"), e => e.category, e => e.amount));
  const uai = combine("result", "Utilidad antes de impuestos", [uo.id, oi.id, og.id], [1, 1, -1]);

  add("section", "Impuestos");
  const imp = group("Impuestos", named(expenses.filter(e => e.type === "impuestos"), e => e.category, e => e.amount));
  const un = combine("grand", "Utilidad neta del ejercicio", [uai.id, imp.id], [1, -1]);
  add("ratio", "Margen neto", { ratio: [un.id, ti.id] });

  return { rows, byId, ids: { ti, tc, ub, tgo, uo, oi, og, uai, imp, un }, warnings };
}

/** Valor de una fila sumando los meses indicados (los márgenes se recalculan, no se suman). */
function cellValue(st, row, months) {
  if (row.kind === "ratio") {
    const n = sum(months.map(m => st.byId.get(row.ratio[0]).values[m]));
    const d = sum(months.map(m => st.byId.get(row.ratio[1]).values[m]));
    return d ? n / d : NaN;
  }
  return sum(months.map(m => row.values[m]));
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const ALL_MONTHS = range(0, 11);

// =====================================================================
// PESTAÑA
// =====================================================================
function render(full) {
  const view = $("#view-contabilidad");
  if (!view) return;
  if (full) invalidate();
  const tabs = [["ingresos", "💵 Ingresos"], ["gastos", "🧾 Gastos"], ["resultados", "📑 Estado de resultados"], ["graficas", "📈 Gráficas"]];
  view.innerHTML = `
    <div class="toolbar">
      <h2 class="view-title">Contabilidad</h2>
      <div class="chips acc-tabs" id="accTabs">${tabs.map(([k, l]) => `<button data-sub="${k}" class="${acc.sub === k ? "active" : ""}">${l}</button>`).join("")}</div>
      <button class="btn btn-ghost btn-sm" id="accRefresh" title="Volver a leer los datos">⟳ Actualizar</button>
    </div>
    <div id="accBody"></div>`;
  view.querySelector("#accTabs").onclick = e => {
    const b = e.target.closest("[data-sub]");
    if (!b || b.dataset.sub === acc.sub) return;
    acc.sub = b.dataset.sub;
    view.querySelectorAll("#accTabs [data-sub]").forEach(x => x.classList.toggle("active", x === b));
    renderBody();
  };
  view.querySelector("#accRefresh").onclick = () => { invalidate(); renderBody(); toast("Datos actualizados", { duration: 1500 }); };
  renderBody();
}

function renderBody() {
  const body = $("#accBody");
  if (!body) return;
  acc.token++;
  ({ ingresos: renderIncome, gastos: renderExpenses, resultados: renderStatement, graficas: renderCharts })[acc.sub](body);
}

// ---------- Filtro de periodo (Ingresos y Gastos) ----------
function periodFilterHTML(extraButtons) {
  const today = dateKey(new Date());
  return `
    <form class="panel acc-filter" id="accFilter">
      <label class="field"><span>Desde</span><input type="date" id="accFrom" value="${esc(acc.from)}"></label>
      <label class="field"><span>Hasta</span><input type="date" id="accTo" value="${esc(acc.to)}" max="${today}"></label>
      <div class="chips acc-quick">
        <button type="button" data-p="hoy">Hoy</button>
        <button type="button" data-p="mes">Este mes</button>
        <button type="button" data-p="mesant">Mes anterior</button>
        <button type="button" data-p="anio">Este año</button>
      </div>
      <button class="btn" type="submit">Consultar</button>
      <span class="spacer"></span>
      ${extraButtons}
    </form>
    <div id="accOut">${spinner}</div>`;
}

function bindPeriodFilter(body, repaint) {
  const form = body.querySelector("#accFilter");
  const apply = (from, to) => {
    if (!from || !to || from > to) { toast("Revisa el rango de fechas.", { type: "error" }); return; }
    acc.from = from; acc.to = to;
    form.querySelector("#accFrom").value = from;
    form.querySelector("#accTo").value = to;
    repaint();
  };
  form.addEventListener("submit", e => { e.preventDefault(); apply(form.querySelector("#accFrom").value, form.querySelector("#accTo").value); });
  form.querySelector(".acc-quick").addEventListener("click", e => {
    const b = e.target.closest("[data-p]");
    if (!b) return;
    const t = new Date();
    const y = t.getFullYear(), m = t.getMonth();
    const p = b.dataset.p;
    if (p === "hoy") apply(dateKey(t), dateKey(t));
    if (p === "mes") apply(dateKey(new Date(y, m, 1)), dateKey(t));
    if (p === "mesant") apply(dateKey(new Date(y, m - 1, 1)), dateKey(new Date(y, m, 0)));
    if (p === "anio") apply(dateKey(new Date(y, 0, 1)), dateKey(t));
  });
}

async function withPeriod(paint) {
  const token = acc.token;
  const out = $("#accOut");
  const key = `${acc.from}|${acc.to}`;
  if (!acc.period || acc.periodKey !== key) {
    out.innerHTML = spinner;
    try {
      const data = await loadRange(ymd(acc.from), addDays(ymd(acc.to), 1));
      if (token !== acc.token) return;
      acc.period = data;
      acc.periodKey = key;
    } catch (err) {
      console.error(err);
      if (token === acc.token) out.innerHTML = `<div class="empty-box">${esc(friendlyError(err))}</div>`;
      return;
    }
  }
  if (token !== acc.token || !$("#accOut")) return;
  paint($("#accOut"));
}

const periodLabel = () => acc.from === acc.to
  ? dateLabel(ymd(acc.from))
  : `${dateLabel(ymd(acc.from))} al ${dateLabel(ymd(acc.to))}`;

/** Tabla jerárquica (rubro → detalle) con participación. */
function structureTable(groups, { first = "Rubro", qtyLabel = "Cantidad", totalLabel = "TOTAL" } = {}) {
  const total = sum(groups.map(g => g.value));
  const bar = v => {
    const s = share(v, total);
    return `<div class="share-cell"><div class="share"><span style="width:${Number.isFinite(s) ? Math.max(0, Math.min(100, s * 100)) : 0}%"></span></div><b>${pctTxt(s)}</b></div>`;
  };
  return `
    <div class="table-wrap"><table class="ctable acc-table">
      <thead><tr><th>${esc(first)}</th><th class="num">${esc(qtyLabel)}</th><th class="num">Valor</th><th>Participación</th></tr></thead>
      <tbody>${groups.map(g => `
        <tr class="acc-main"><td>${esc(g.label)}</td><td class="num">${(g.qty || 0).toLocaleString("es-CO")}</td><td class="num">${moneyCell(g.value)}</td><td>${bar(g.value)}</td></tr>
        ${g.children.map(c => `
          <tr class="acc-child"><td>${esc(c.label)}</td><td class="num">${(c.qty || 0).toLocaleString("es-CO")}</td><td class="num">${money(c.value)}</td><td>${bar(c.value)}</td></tr>`).join("")}`).join("")}
      </tbody>
      <tfoot><tr><td>${esc(totalLabel)}</td><td class="num">${sum(groups.map(g => g.qty)).toLocaleString("es-CO")}</td><td class="num">${moneyCell(total)}</td><td></td></tr></tfoot>
    </table></div>`;
}

// =====================================================================
// INGRESOS
// =====================================================================
function renderIncome(body) {
  body.innerHTML = periodFilterHTML(`
    <button type="button" class="btn btn-ghost" id="accIncExport">⬇ Excel</button>
    <button type="button" class="btn" id="accIncNew">+ Ingreso manual</button>`);
  bindPeriodFilter(body, () => withPeriod(paintIncome));
  body.querySelector("#accIncNew").onclick = () => openIncomeModal(null);
  body.querySelector("#accIncExport").onclick = () => withPeriod(() => exportIncome());
  withPeriod(paintIncome);
}

function paintIncome(out) {
  const { lines } = acc.period;
  const g = groupIncome(lines);
  const total = sum(lines.map(l => l.amount));
  const tx = new Set(lines.map(l => l.txId)).size;
  const kpi = (cls, label, value, small) => `<div class="kpi ${cls}"><span>${label}</span><b>${money(value)}</b><small>${small}</small></div>`;
  out.innerHTML = `
    <div class="kpis">
      ${kpi("good", "Total ingresos", total, plural(tx, "transacción", "transacciones"))}
      ${kpi("", "🍧 Granizados", g.granizados.amount, plural(g.granizados.qty, "unidad", "unidades"))}
      ${kpi("", "🍟 Acompañantes", g.acompanantes.amount, plural(g.acompanantes.qty, "unidad", "unidades"))}
      ${kpi("", "🛍️ Extras", g.extras.amount, plural(g.extras.qty, "unidad", "unidades"))}
      ${kpi("", "🚗 Parqueadero", g.parqueadero.amount, plural(g.parqueadero.qty, "vehículo", "vehículos"))}
      ${g.otros.count ? kpi("", "➕ Otros ingresos", g.otros.amount, plural(g.otros.count, "registro", "registros")) : ""}
    </div>
    <h3 class="sub-title">Ingresos por rubro <small>${esc(periodLabel())}</small></h3>
    ${structureTable(incomeStructure(g), { totalLabel: "TOTAL INGRESOS" })}

    <div class="toolbar acc-hist-bar">
      <h3 class="sub-title grow">Historial de ingresos <small>${plural(lines.length, "movimiento", "movimientos")}</small></h3>
      <input id="accHq" class="acc-search" type="search" placeholder="Buscar…" value="${esc(acc.hq)}">
      <select id="accHsrc" class="acc-select">
        <option value="">Todos los orígenes</option>
        ${Object.entries(SOURCES).map(([k, l]) => `<option value="${k}" ${acc.hsrc === k ? "selected" : ""}>${l}</option>`).join("")}
      </select>
    </div>
    <div id="accHist"></div>`;
  out.querySelector("#accHq").addEventListener("input", e => { acc.hq = e.target.value; paintIncomeHistory(); });
  out.querySelector("#accHsrc").addEventListener("change", e => { acc.hsrc = e.target.value; paintIncomeHistory(); });
  out.querySelector("#accHist").addEventListener("click", e => {
    const tr = e.target.closest("[data-edit-income]");
    if (!tr) return;
    const l = acc.period.lines.find(x => x.id === tr.dataset.editIncome);
    if (l) openIncomeModal(l.raw);
  });
  paintIncomeHistory();
}

function paintIncomeHistory() {
  const box = $("#accHist");
  if (!box || !acc.period) return;
  const q = normalize(acc.hq);
  const list = acc.period.lines.filter(l =>
    (!acc.hsrc || l.source === acc.hsrc) &&
    (!q || normalize(`${l.concept} ${l.ref} ${l.who} ${RUBROS[l.rubro]} ${l.note || ""}`).includes(q)));
  const shown = list.slice(0, MAX_HISTORY_ROWS);
  box.innerHTML = list.length ? `
    <div class="table-wrap"><table class="ctable acc-table acc-hist">
      <thead><tr><th>Fecha</th><th>Origen</th><th>Referencia</th><th>Rubro</th><th>Concepto</th><th class="num">Cant.</th><th>Pago</th><th class="num">Valor</th><th></th></tr></thead>
      <tbody>${shown.map(l => `
        <tr ${l.source === "manual" ? `data-edit-income="${esc(l.id)}" class="clickable"` : ""}>
          <td class="nowrap">${dateLabel(l.date)}${l.source === "manual" ? "" : ` <small>${timeLabel(l.date)}</small>`}</td>
          <td><span class="src-tag src-${l.source}">${SOURCES[l.source]}</span></td>
          <td class="nowrap">${esc(l.ref)}${l.who ? `<div class="pk-sub">${esc(l.who)}</div>` : ""}</td>
          <td>${esc(RUBROS[l.rubro])}</td>
          <td>${esc(l.concept)}${l.note ? `<div class="pk-sub">${esc(l.note)}</div>` : ""}</td>
          <td class="num">${l.qty ?? "—"}</td>
          <td>${esc(PAY[l.method] || "—")}</td>
          <td class="num"><b>${money(l.amount)}</b></td>
          <td class="pk-act">${l.source === "manual" ? `<button class="link">Editar</button>` : ""}</td>
        </tr>`).join("")}</tbody>
      <tfoot><tr><td colspan="7">TOTAL ${acc.hq || acc.hsrc ? "FILTRADO" : ""}</td><td class="num">${money(sum(list.map(l => l.amount)))}</td><td></td></tr></tfoot>
    </table></div>
    ${list.length > shown.length ? `<p class="subtle">Se muestran los ${MAX_HISTORY_ROWS} más recientes de ${list.length}. Exporta a Excel para ver todos.</p>` : ""}`
    : `<div class="empty-box">No hay ingresos ${acc.hq || acc.hsrc ? "con esos filtros" : "en este periodo"}.</div>`;
}

// ---------- Ingreso manual ----------
function conceptSuggestions(rubro) {
  switch (rubro) {
    case "granizados": return ["Granizados"];
    case "acompanantes": return Kit.state.sides.map(s => s.name);
    case "extras": return (Kit.extrasList?.() || []).map(x => x.name);
    case "parqueadero": return ["Parqueadero"];
    default: return ["Arrendamiento de espacio", "Rendimientos financieros", "Reintegros", "Venta de activos", "Otros"];
  }
}

function openIncomeModal(rec) {
  const r = rec || { rubro: "otros", paymentMethod: "efectivo" };
  const isNew = !rec;
  const d = toDate(r.date) || new Date();
  Kit.openModal({
    title: isNew ? "Registrar ingreso manual" : "Editar ingreso manual",
    wide: true,
    body: `
      <form id="incForm" class="form-grid" novalidate>
        <label class="field"><span>Fecha *</span><input name="date" type="date" value="${dateKey(d)}"></label>
        <label class="field"><span>Rubro *</span>
          <select name="rubro">${Object.entries(RUBROS).map(([k, l]) => `<option value="${k}" ${r.rubro === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="field span2"><span>Concepto *</span>
          <input name="concept" maxlength="60" list="incConcepts" value="${esc(r.concept || "")}">
          <datalist id="incConcepts"></datalist></label>
        <label class="field"><span>Cantidad</span><input name="quantity" type="number" min="0" step="1" value="${Number.isFinite(r.quantity) ? r.quantity : ""}"></label>
        <label class="field"><span>Valor total *</span>
          <div class="money-input"><span>$</span><input name="amount" inputmode="numeric" value="${isValidPrice(r.amount) ? Kit.thousands(r.amount) : ""}" placeholder="0"></div></label>
        <label class="field"><span>Costo</span>
          <div class="money-input"><span>$</span><input name="cost" inputmode="numeric" value="${isValidPrice(r.cost) ? Kit.thousands(r.cost) : ""}" placeholder="0"></div></label>
        <label class="field"><span>Forma de pago</span>
          <select name="paymentMethod">${Object.entries(PAY).map(([k, l]) => `<option value="${k}" ${r.paymentMethod === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="field span2"><span>Nota</span><textarea name="note" rows="2" maxlength="160">${esc(r.note || "")}</textarea></label>
        <p class="form-error span2" id="formError" hidden></p>
      </form>`,
    footer: `
      ${isNew ? "" : `<button class="btn btn-danger" id="deleteBtn">Eliminar</button>`}
      <span class="spacer"></span>
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn" id="saveBtn">Guardar</button>`,
    onMount(root) {
      const form = root.querySelector("#incForm");
      form.addEventListener("submit", e => e.preventDefault());
      Kit.bindMoneyInput(form.amount);
      Kit.bindMoneyInput(form.cost);
      const fillConcepts = () => {
        root.querySelector("#incConcepts").innerHTML = [...new Set(conceptSuggestions(form.rubro.value))].map(c => `<option value="${esc(c)}">`).join("");
      };
      form.rubro.addEventListener("change", fillConcepts);
      fillConcepts();
      const errEl = root.querySelector("#formError");
      const saveBtn = root.querySelector("#saveBtn");
      saveBtn.onclick = async () => {
        const rubro = RUBROS[form.rubro.value] ? form.rubro.value : "otros";
        const qty = form.quantity.value === "" ? null : parseInt(form.quantity.value, 10);
        const cost = parseMoney(form.cost.value);
        const data = {
          dateKey: form.date.value,
          rubro,
          concept: form.concept.value.trim() || (["granizados", "parqueadero"].includes(rubro) ? RUBROS[rubro] : ""),
          quantity: qty,
          amount: parseMoney(form.amount.value),
          cost: Number.isNaN(cost) ? null : cost,
          paymentMethod: PAY[form.paymentMethod.value] ? form.paymentMethod.value : "otro",
          note: form.note.value.trim()
        };
        const error =
          !/^\d{4}-\d{2}-\d{2}$/.test(data.dateKey) ? "Elige la fecha del ingreso." :
          !data.concept ? "Escribe el concepto." :
          qty !== null && (!Number.isInteger(qty) || qty < 0) ? "La cantidad debe ser un número entero." :
          !isValidPrice(data.amount) || data.amount === 0 ? "Escribe un valor mayor a $0." :
          data.cost !== null && !isValidPrice(data.cost) ? "El costo no es válido." : "";
        if (error) { errEl.textContent = error; errEl.hidden = false; return; }
        const [y, m, dd] = data.dateKey.split("-").map(Number);
        data.date = Timestamp.fromDate(new Date(y, m - 1, dd, 12, 0));
        saveBtn.disabled = true;
        try {
          if (isNew) await addDoc(collection(db, COL.incomes), { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
          else await updateDoc(doc(db, COL.incomes, rec.id), { ...data, updatedAt: serverTimestamp() });
          Kit.closeModal();
          toast(isNew ? "Ingreso registrado" : "Ingreso actualizado", { type: "ok" });
          invalidate();
          renderBody();
        } catch (err) {
          errEl.textContent = friendlyError(err); errEl.hidden = false; saveBtn.disabled = false;
        }
      };
      const delBtn = root.querySelector("#deleteBtn");
      if (delBtn) delBtn.onclick = async () => {
        if (!confirm(`¿Eliminar el ingreso "${rec.concept}" por ${money(rec.amount)}?`)) return;
        delBtn.disabled = true;
        try {
          await deleteDoc(doc(db, COL.incomes, rec.id));
          Kit.closeModal();
          toast("Ingreso eliminado", { type: "ok" });
          invalidate();
          renderBody();
        } catch (err) { delBtn.disabled = false; toast(friendlyError(err), { type: "error" }); }
      };
    }
  });
}

// =====================================================================
// GASTOS
// =====================================================================
function renderExpenses(body) {
  body.innerHTML = periodFilterHTML(`
    <button type="button" class="btn btn-ghost" id="accExpExport">⬇ Excel</button>
    <button type="button" class="btn" id="accExpNew">+ Registrar gasto</button>`);
  bindPeriodFilter(body, () => withPeriod(paintExpenses));
  body.querySelector("#accExpNew").onclick = () => openExpenseModal(null);
  body.querySelector("#accExpExport").onclick = () => withPeriod(() => exportExpenses());
  withPeriod(paintExpenses);
}

function paintExpenses(out) {
  const { expenses } = acc.period;
  const total = sum(expenses.map(e => e.amount));
  const byType = k => sum(expenses.filter(e => e.type === k).map(e => e.amount));
  out.innerHTML = `
    <div class="kpis">
      <div class="kpi warn"><span>Total gastos</span><b>${money(total)}</b><small>${plural(expenses.length, "registro", "registros")}</small></div>
      ${Object.entries(EXP_TYPES).map(([k, t]) => `<div class="kpi"><span>${esc(t.label)}</span><b>${money(byType(k))}</b><small>${pctTxt(share(byType(k), total))}</small></div>`).join("")}
    </div>
    <h3 class="sub-title">Gastos por tipo y categoría <small>${esc(periodLabel())}</small></h3>
    ${structureTable(expenseStructure(expenses), { first: "Tipo · categoría", qtyLabel: "Registros", totalLabel: "TOTAL GASTOS" })}

    <div class="toolbar acc-hist-bar">
      <h3 class="sub-title grow">Historial de gastos <small>${plural(expenses.length, "registro", "registros")}</small></h3>
      <input id="accGq" class="acc-search" type="search" placeholder="Buscar…" value="${esc(acc.gq)}">
      <select id="accGtype" class="acc-select">
        <option value="">Todos los tipos</option>
        ${Object.entries(EXP_TYPES).map(([k, t]) => `<option value="${k}" ${acc.gtype === k ? "selected" : ""}>${esc(t.label)}</option>`).join("")}
      </select>
    </div>
    <div id="accExpHist"></div>`;
  out.querySelector("#accGq").addEventListener("input", e => { acc.gq = e.target.value; paintExpenseHistory(); });
  out.querySelector("#accGtype").addEventListener("change", e => { acc.gtype = e.target.value; paintExpenseHistory(); });
  out.querySelector("#accExpHist").addEventListener("click", e => {
    const tr = e.target.closest("[data-edit-expense]");
    if (!tr) return;
    const x = acc.period.expenses.find(z => z.id === tr.dataset.editExpense);
    if (x) openExpenseModal(x);
  });
  paintExpenseHistory();
}

function paintExpenseHistory() {
  const box = $("#accExpHist");
  if (!box || !acc.period) return;
  const q = normalize(acc.gq);
  const list = acc.period.expenses.filter(e =>
    (!acc.gtype || e.type === acc.gtype) &&
    (!q || normalize(`${e.concept} ${e.category} ${e.supplier || ""} ${e.note || ""}`).includes(q)));
  const shown = list.slice(0, MAX_HISTORY_ROWS);
  box.innerHTML = list.length ? `
    <div class="table-wrap"><table class="ctable acc-table acc-hist">
      <thead><tr><th>Fecha</th><th>Tipo</th><th>Categoría</th><th>Concepto</th><th>Proveedor</th><th>Pago</th><th class="num">Valor</th><th></th></tr></thead>
      <tbody>${shown.map(e => `
        <tr data-edit-expense="${esc(e.id)}" class="clickable">
          <td class="nowrap">${dateLabel(e.date)}</td>
          <td><span class="src-tag exp-${e.type}">${esc(EXP_TYPES[e.type].label)}</span></td>
          <td>${esc(e.category || "—")}</td>
          <td>${esc(e.concept || "")}${e.source === "inventario" ? ` <span class="src-tag src-extra">📦 Inventario</span>` : ""}${e.note ? `<div class="pk-sub">${esc(e.note)}</div>` : ""}</td>
          <td>${esc(e.supplier || "—")}</td>
          <td>${esc(PAY[e.paymentMethod] || "—")}</td>
          <td class="num"><b>${money(e.amount)}</b></td>
          <td class="pk-act"><button class="link">Editar</button></td>
        </tr>`).join("")}</tbody>
      <tfoot><tr><td colspan="6">TOTAL ${acc.gq || acc.gtype ? "FILTRADO" : ""}</td><td class="num">${money(sum(list.map(e => e.amount)))}</td><td></td></tr></tfoot>
    </table></div>
    ${list.length > shown.length ? `<p class="subtle">Se muestran los ${MAX_HISTORY_ROWS} más recientes de ${list.length}. Exporta a Excel para ver todos.</p>` : ""}`
    : `<div class="empty-box">No hay gastos ${acc.gq || acc.gtype ? "con esos filtros" : "en este periodo"}.</div>`;
}

function openExpenseModal(rec) {
  const r = rec || { type: "operacional", paymentMethod: "efectivo" };
  const isNew = !rec;
  const d = r.date instanceof Date ? r.date : toDate(r.date) || new Date();
  Kit.openModal({
    title: isNew ? "Registrar gasto" : "Editar gasto",
    wide: true,
    body: `
      <form id="expForm" class="form-grid" novalidate>
        <label class="field"><span>Fecha *</span><input name="date" type="date" value="${dateKey(d)}"></label>
        <label class="field"><span>Tipo *</span>
          <select name="type">${Object.entries(EXP_TYPES).map(([k, t]) => `<option value="${k}" ${r.type === k ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select></label>
        <label class="field"><span>Categoría *</span>
          <input name="category" maxlength="40" list="expCats" value="${esc(r.category || "")}">
          <datalist id="expCats"></datalist></label>
        <label class="field"><span>Concepto *</span>
          <input name="concept" maxlength="60" value="${esc(r.concept || "")}"></label>
        <label class="field"><span>Proveedor / beneficiario</span>
          <input name="supplier" maxlength="50" value="${esc(r.supplier || "")}"></label>
        <label class="field"><span>Valor *</span>
          <div class="money-input"><span>$</span><input name="amount" inputmode="numeric" value="${isValidPrice(r.amount) ? Kit.thousands(r.amount) : ""}" placeholder="0"></div></label>
        <label class="field"><span>Forma de pago</span>
          <select name="paymentMethod">${Object.entries(PAY).map(([k, l]) => `<option value="${k}" ${r.paymentMethod === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="field span2"><span>Nota</span><textarea name="note" rows="2" maxlength="160">${esc(r.note || "")}</textarea></label>
        <p class="form-error span2" id="formError" hidden></p>
      </form>`,
    footer: `
      ${isNew ? "" : `<button class="btn btn-danger" id="deleteBtn">Eliminar</button>`}
      <span class="spacer"></span>
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn" id="saveBtn">Guardar</button>`,
    onMount(root) {
      const form = root.querySelector("#expForm");
      form.addEventListener("submit", e => e.preventDefault());
      Kit.bindMoneyInput(form.amount);
      const fillCats = () => {
        const t = EXP_TYPES[form.type.value];
        root.querySelector("#expCats").innerHTML = t.cats.map(c => `<option value="${esc(c)}">`).join("");
      };
      form.type.addEventListener("change", fillCats);
      fillCats();
      const errEl = root.querySelector("#formError");
      const saveBtn = root.querySelector("#saveBtn");
      saveBtn.onclick = async () => {
        const data = {
          dateKey: form.date.value,
          type: EXP_TYPES[form.type.value] ? form.type.value : "operacional",
          category: form.category.value.trim(),
          concept: form.concept.value.trim(),
          supplier: form.supplier.value.trim(),
          amount: parseMoney(form.amount.value),
          paymentMethod: PAY[form.paymentMethod.value] ? form.paymentMethod.value : "otro",
          note: form.note.value.trim()
        };
        const error =
          !/^\d{4}-\d{2}-\d{2}$/.test(data.dateKey) ? "Elige la fecha del gasto." :
          !data.category ? "Elige o escribe la categoría." :
          !data.concept ? "Escribe el concepto." :
          !isValidPrice(data.amount) || data.amount === 0 ? "Escribe un valor mayor a $0." : "";
        if (error) { errEl.textContent = error; errEl.hidden = false; return; }
        const [y, m, dd] = data.dateKey.split("-").map(Number);
        data.date = Timestamp.fromDate(new Date(y, m - 1, dd, 12, 0));
        saveBtn.disabled = true;
        try {
          if (isNew) await addDoc(collection(db, COL.expenses), { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
          else await updateDoc(doc(db, COL.expenses, rec.id), { ...data, updatedAt: serverTimestamp() });
          Kit.closeModal();
          toast(isNew ? "Gasto registrado" : "Gasto actualizado", { type: "ok" });
          invalidate();
          renderBody();
        } catch (err) {
          errEl.textContent = friendlyError(err); errEl.hidden = false; saveBtn.disabled = false;
        }
      };
      const delBtn = root.querySelector("#deleteBtn");
      if (delBtn) delBtn.onclick = async () => {
        if (!confirm(`¿Eliminar el gasto "${rec.concept}" por ${money(rec.amount)}?`)) return;
        delBtn.disabled = true;
        try {
          await deleteDoc(doc(db, COL.expenses, rec.id));
          Kit.closeModal();
          toast("Gasto eliminado", { type: "ok" });
          invalidate();
          renderBody();
        } catch (err) { delBtn.disabled = false; toast(friendlyError(err), { type: "error" }); }
      };
    }
  });
}

// =====================================================================
// ESTADO DE RESULTADOS (pantalla)
// =====================================================================
function yearOptions(selected) {
  const y = new Date().getFullYear();
  return range(y - 5, y + 1).reverse().map(v => `<option value="${v}" ${v === selected ? "selected" : ""}>${v}</option>`).join("");
}

function renderStatement(body) {
  body.innerHTML = `
    <form class="panel acc-filter er-filter" id="erForm">
      <label class="field"><span>Año</span><select id="erYear">${yearOptions(acc.year)}</select></label>
      <label class="field"><span>Mes</span><select id="erMonth">${MONTHS.map((m, i) => `<option value="${i}" ${i === acc.month ? "selected" : ""}>${m}</option>`).join("")}</select></label>
      <div class="field"><span>Vista</span>
        <div class="chips" id="erView">
          <button type="button" data-v="mes" class="${acc.erView === "mes" ? "active" : ""}">Mes y acumulado</button>
          <button type="button" data-v="anual" class="${acc.erView === "anual" ? "active" : ""}">12 meses</button>
        </div></div>
      <label class="field er-method"><span>Costo de ventas</span>
        <select id="erMethod">${Object.entries(COST_METHODS).map(([k, l]) => `<option value="${k}" ${acc.costMethod === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
      <span class="spacer"></span>
      <button type="button" class="btn btn-ok" id="erExport">⬇ Exportar a Excel</button>
    </form>
    <div id="accOut">${spinner}</div>`;
  const form = body.querySelector("#erForm");
  form.querySelector("#erYear").onchange = e => { acc.year = Number(e.target.value); paintStatement(); };
  form.querySelector("#erMonth").onchange = e => { acc.month = Number(e.target.value); paintStatement(); };
  form.querySelector("#erMethod").onchange = e => { acc.costMethod = e.target.value; savePref(COST_KEY, acc.costMethod); paintStatement(); };
  form.querySelector("#erView").onclick = e => {
    const b = e.target.closest("[data-v]");
    if (!b) return;
    acc.erView = b.dataset.v;
    form.querySelectorAll("#erView [data-v]").forEach(x => x.classList.toggle("active", x === b));
    paintStatement();
  };
  form.querySelector("#erExport").onclick = exportStatement;
  paintStatement();
}

async function paintStatement() {
  const token = acc.token;
  const out = $("#accOut");
  if (!out) return;
  out.classList.add("is-loading");
  let data;
  try { data = await yearData(acc.year); } catch (err) {
    console.error(err);
    if (token === acc.token) out.innerHTML = `<div class="empty-box">${esc(friendlyError(err))}</div>`;
    return;
  }
  if (token !== acc.token || !$("#accOut")) return;
  out.classList.remove("is-loading");
  const st = buildStatement(data, acc.costMethod);
  const m = acc.month;
  const { ti, un } = st.ids;
  const ytd = range(0, m);
  const v = (row, months) => cellValue(st, row, months);
  const isCurrentYear = acc.year === new Date().getFullYear();

  const cols = acc.erView === "mes"
    ? [
        { label: `${MONTHS[m]} ${acc.year}`, months: [m], pct: true },
        { label: `Acumulado ene–${MONTHS_SHORT[m].toLowerCase()}`, months: ytd, pct: true },
        { label: `Total año (al 31 dic)`, months: ALL_MONTHS, pct: true }
      ]
    : [...MONTHS_SHORT.map((s, i) => ({ label: s, months: [i], current: isCurrentYear && i === new Date().getMonth() })),
       { label: "Total año", months: ALL_MONTHS, pct: true }];
  const colCount = 1 + cols.reduce((s, c) => s + (c.pct ? 2 : 1), 0);

  const rowHTML = r => {
    if (r.kind === "section") return `<tr class="er-section"><td colspan="${colCount}">${esc(r.label)}</td></tr>`;
    const cells = cols.map(c => {
      const val = v(r, c.months);
      const main = r.kind === "ratio" ? pctTxt(val) : moneyCell(val);
      const pct = c.pct ? `<td class="er-pct">${r.kind === "ratio" ? "" : pctTxt(share(val, v(ti, c.months)))}</td>` : "";
      return `<td class="${c.current ? "er-cur" : ""}">${main}</td>${pct}`;
    }).join("");
    return `<tr class="er-${r.kind}"><td>${esc(r.label)}</td>${cells}</tr>`;
  };

  const kp = (label, value, small, cls = "") => `<div class="kpi ${cls}"><span>${label}</span>${kpiMoney(value)}<small>${small}</small></div>`;
  const unM = v(un, [m]), unY = v(un, ALL_MONTHS);
  out.innerHTML = `
    <div class="kpis">
      ${kp(`Ingresos ${MONTHS[m].toLowerCase()}`, v(ti, [m]), "operacionales")}
      ${kp(`Utilidad neta ${MONTHS[m].toLowerCase()}`, unM, `margen ${pctTxt(share(unM, v(ti, [m])))}`, unM < 0 ? "warn" : "good")}
      ${kp(`Ingresos acumulados ${acc.year}`, v(ti, ALL_MONTHS), "1 ene – 31 dic")}
      ${kp(`Utilidad neta acumulada ${acc.year}`, unY, `margen ${pctTxt(share(unY, v(ti, ALL_MONTHS)))}`, unY < 0 ? "warn" : "good")}
    </div>
    ${st.warnings.length ? `<div class="acc-note">${st.warnings.map(w => `<p>⚠️ ${esc(w)}</p>`).join("")}</div>` : ""}
    <div class="er-sheet">
      <div class="er-head">
        <div><b>${esc(BUSINESS.toUpperCase())}</b><span>Estado de resultados ${acc.erView === "mes" ? `· ${MONTHS[m]} ${acc.year}` : `· Año ${acc.year}`}</span></div>
        <small>Cifras en pesos colombianos (COP) · Del 1 de enero al 31 de diciembre de ${acc.year}<br>Costo de ventas: ${esc(COST_METHODS[acc.costMethod].toLowerCase())}</small>
      </div>
      <div class="table-wrap er-wrap"><table class="er-table ${acc.erView === "anual" ? "er-anual" : ""}">
        <thead><tr><th>Concepto</th>${cols.map(c => `<th class="${c.current ? "er-cur" : ""}">${esc(c.label)}</th>${c.pct ? `<th class="er-pct">%</th>` : ""}`).join("")}</tr></thead>
        <tbody>${st.rows.map(rowHTML).join("")}</tbody>
      </table></div>
    </div>`;
}

// =====================================================================
// GRÁFICAS DE COMPORTAMIENTO
// =====================================================================
function renderCharts(body) {
  body.innerHTML = `
    <form class="panel acc-filter" id="gForm">
      <label class="field"><span>Año</span><select id="gYear">${yearOptions(acc.year)}</select></label>
      <label class="field"><span>Periodo de análisis</span>
        <select id="gMonth"><option value="">Todo el año</option>${MONTHS.map((mm, i) => `<option value="${i}" ${String(i) === String(acc.gMonth) ? "selected" : ""}>${mm}</option>`).join("")}</select></label>
    </form>
    <div id="accOut">${spinner}</div>`;
  body.querySelector("#gYear").onchange = e => { acc.year = Number(e.target.value); paintCharts(); };
  body.querySelector("#gMonth").onchange = e => { acc.gMonth = e.target.value; paintCharts(); };
  paintCharts();
}

async function paintCharts() {
  const token = acc.token;
  const out = $("#accOut");
  if (!out) return;
  out.classList.add("is-loading");
  let data;
  try { data = await yearData(acc.year); } catch (err) {
    console.error(err);
    if (token === acc.token) out.innerHTML = `<div class="empty-box">${esc(friendlyError(err))}</div>`;
    return;
  }
  if (token !== acc.token || !$("#accOut")) return;
  out.classList.remove("is-loading");

  const st = buildStatement(data, acc.costMethod);
  const { ti, tc, tgo, oi, og, imp, un } = st.ids;
  const P = Charts.PALETTE;
  const monthIdx = acc.gMonth === "" ? null : Number(acc.gMonth);
  const scopeMonths = monthIdx === null ? ALL_MONTHS : [monthIdx];
  const scopeName = monthIdx === null ? `año ${acc.year}` : `${MONTHS[monthIdx].toLowerCase()} ${acc.year}`;
  const inScope = d => monthIdx === null || d.getMonth() === monthIdx;
  const lines = data.lines.filter(l => inScope(l.date));
  const sales = lines.filter(l => l.source !== "manual");          // comportamiento real de caja
  const expenses = data.expenses.filter(e => inScope(e.date));

  const incomeM = ALL_MONTHS.map(i => ti.values[i] + oi.values[i]);
  const spendM = ALL_MONTHS.map(i => tc.values[i] + tgo.values[i] + og.values[i] + imp.values[i]);
  const incomeS = sum(scopeMonths.map(i => incomeM[i]));
  const spendS = sum(scopeMonths.map(i => spendM[i]));
  const netS = sum(scopeMonths.map(i => un.values[i]));
  const tickets = new Set(sales.filter(l => l.source === "pedido" || l.source === "extra").map(l => l.txId));
  const ticketSales = sum(sales.filter(l => l.source === "pedido" || l.source === "extra").map(l => l.amount));

  // Rubros por mes
  const rubroKeys = Object.keys(RUBROS);
  const rubroSeries = rubroKeys.map((k, i) => ({
    name: RUBROS[k], color: P[i],
    values: ALL_MONTHS.map(m => sum(data.lines.filter(l => l.rubro === k && l.date.getMonth() === m).map(l => l.amount)))
  })).filter(s => s.name !== RUBROS.otros || sum(s.values) > 0);

  // Tendencia: diaria (mes) o acumulada (año)
  // En el año/mes en curso la línea se corta en hoy (no se dibuja el futuro)
  const today = new Date();
  const lastMonth = acc.year < today.getFullYear() ? 11 : acc.year > today.getFullYear() ? -1 : today.getMonth();
  let trend;
  if (monthIdx === null) {
    let a = 0, b = 0;
    trend = {
      title: "Acumulado del año",
      sub: "",
      html: Charts.lines({
        categories: MONTHS_SHORT, wide: true,
        series: [
          { name: "Ingresos acumulados", color: P[0], values: incomeM.map((x, i) => (i <= lastMonth ? (a += x) : null)) },
          { name: "Gastos acumulados", color: P[1], values: spendM.map((x, i) => (i <= lastMonth ? (b += x) : null)) }
        ],
        fmt: money, tipTitle: i => `${MONTHS[i]} ${acc.year}`, tableTotal: false, label: "Acumulado del año"
      })
    };
  } else {
    const days = new Date(acc.year, monthIdx + 1, 0).getDate();
    const daily = Array(days).fill(0);
    sales.forEach(l => { daily[l.date.getDate() - 1] += l.amount; });
    const isNow = acc.year === today.getFullYear() && monthIdx === today.getMonth();
    const future = acc.year > today.getFullYear() || (acc.year === today.getFullYear() && monthIdx > today.getMonth());
    trend = {
      title: `Ventas diarias de ${MONTHS[monthIdx].toLowerCase()}`,
      sub: "",
      html: Charts.lines({
        categories: range(1, days).map(String), wide: true,
        series: [{ name: "Ventas", color: P[0], values: daily.map((v, i) => (future || (isNow && i + 1 > today.getDate()) ? null : v)) }],
        fmt: money, tipTitle: i => `${i + 1} de ${MONTHS[monthIdx].toLowerCase()}`, label: "Ventas diarias"
      })
    };
  }

  // Hora del día y día de la semana
  const hours = Array(24).fill(0);
  const weekday = Array(7).fill(0);
  sales.forEach(l => { hours[l.date.getHours()] += l.amount; weekday[(l.date.getDay() + 6) % 7] += l.amount; });
  const active = hours.map((v, h) => (v ? h : -1)).filter(h => h >= 0);
  const h0 = active.length ? Math.min(...active, 8) : 8;
  const h1 = active.length ? Math.max(...active, 21) : 21;
  const hourCats = range(h0, h1);

  // Rankings
  const rank = (list, keyFn) => {
    const map = new Map();
    list.forEach(l => {
      const k = normalize(keyFn(l));
      const r = map.get(k) || { label: keyFn(l), manual: l.source === "manual", value: 0, qty: 0 };
      if (r.manual && l.source !== "manual") { r.label = keyFn(l); r.manual = false; }
      r.value += l.amount; r.qty += l.qty || 0;
      map.set(k, r);
    });
    return [...map.values()].sort((a, b) => b.value - a.value).slice(0, 10)
      .map(r => ({ label: r.label, value: r.value, sub: plural(r.qty, "unidad", "unidades") }));
  };
  const topGranizados = rank(lines.filter(l => l.rubro === "granizados"), l => l.product);
  const topOthers = rank(lines.filter(l => l.rubro === "acompanantes" || l.rubro === "extras"), l => l.concept);
  const expCats = (() => {
    const map = new Map();
    expenses.forEach(e => {
      const label = e.category || "Sin categoría";
      const k = normalize(label);
      const r = map.get(k) || { label, value: 0, n: 0 };
      r.value += e.amount || 0; r.n++;
      map.set(k, r);
    });
    return [...map.values()].sort((a, b) => b.value - a.value).slice(0, 10)
      .map(r => ({ label: r.label, value: r.value, sub: plural(r.n, "registro", "registros") }));
  })();

  const card = (title, sub, html, wide = false) => `
    <section class="chart-card ${wide ? "wide" : ""}">
      <header><h3>${esc(title)}</h3>${sub ? `<p>${esc(sub)}</p>` : ""}</header>
      ${html}
    </section>`;

  out.innerHTML = `
    <div class="kpis">
      <div class="kpi good"><span>Ingresos · ${esc(scopeName)}</span><b>${money(incomeS)}</b><small>operacionales + otros</small></div>
      <div class="kpi warn"><span>Gastos y costos</span><b>${money(spendS)}</b><small>${pctTxt(share(spendS, incomeS))} de los ingresos</small></div>
      <div class="kpi ${netS < 0 ? "warn" : "good"}"><span>Utilidad neta</span>${kpiMoney(netS)}<small>margen ${pctTxt(share(netS, incomeS))}</small></div>
      <div class="kpi"><span>Ticket promedio</span><b>${money(tickets.size ? Math.round(ticketSales / tickets.size) : 0)}</b><small>${plural(tickets.size, "venta", "ventas")} (pedidos + extras)</small></div>
    </div>
    <div class="chart-grid">
      ${card(`Ingresos vs. gastos por mes · ${acc.year}`, "",
        Charts.columns({
          categories: MONTHS_SHORT,
          series: [{ name: "Ingresos", color: P[0], values: incomeM }, { name: "Gastos", color: P[1], values: spendM }],
          fmt: money, wide: true, tipTitle: i => `${MONTHS[i]} ${acc.year}`, label: "Ingresos vs gastos por mes"
        }), true)}
      ${card(`Utilidad neta por mes · ${acc.year}`, "Azul: ganancia · Rojo: pérdida",
        Charts.columns({
          categories: MONTHS_SHORT, series: [{ name: "Utilidad neta", color: Charts.POS, values: un.values }],
          diverging: true, fmt: money, tipTitle: i => `${MONTHS[i]} ${acc.year}`, label: "Utilidad neta por mes"
        }))}
      ${card(`Ingresos por rubro · ${acc.year}`, "",
        Charts.columns({
          categories: MONTHS_SHORT, series: rubroSeries, stacked: true,
          fmt: money, tipTitle: i => `${MONTHS[i]} ${acc.year}`, label: "Ingresos por rubro"
        }))}
      ${card(trend.title, trend.sub, trend.html, true)}
      ${card(`Ventas por hora del día · ${scopeName}`, "",
        Charts.columns({
          categories: hourCats.map(h => `${h}h`), series: [{ name: "Ventas", color: P[0], values: hourCats.map(h => hours[h]) }],
          fmt: money, tipTitle: i => `${hourCats[i]}:00 – ${hourCats[i]}:59`, label: "Ventas por hora"
        }))}
      ${card(`Ventas por día de la semana · ${scopeName}`, "",
        Charts.columns({
          categories: WEEKDAYS, series: [{ name: "Ventas", color: P[0], values: weekday }],
          fmt: money, label: "Ventas por día de la semana"
        }))}
      ${card(`Granizados más vendidos · ${scopeName}`, "",
        Charts.hbars({ items: topGranizados, fmt: money, valueName: "Vendido", label: "Granizados más vendidos" }))}
      ${card(`Acompañantes y extras más vendidos · ${scopeName}`, "",
        Charts.hbars({ items: topOthers, fmt: money, valueName: "Vendido", label: "Acompañantes y extras más vendidos" }))}
      ${card(`Gastos por categoría · ${scopeName}`, "",
        Charts.hbars({ items: expCats, fmt: money, valueName: "Gastado", label: "Gastos por categoría", wide: true }), true)}
    </div>`;
}

// =====================================================================
// EXPORTAR A EXCEL
// =====================================================================
const stamp = () => { const d = new Date(); return `${dateLabel(d)} ${timeLabel(d)}`; };
const fileStamp = s => String(s).replace(/[^\w-]+/g, "-");
const dayOnly = d => XL.excelDate(new Date(d.getFullYear(), d.getMonth(), d.getDate()));

function titleRows(title, sub1, sub2, width) {
  return {
    rows: [
      { height: 28, cells: [{ v: title, s: "title" }] },
      { cells: [{ v: sub1, s: "subtitle" }] },
      { cells: [{ v: sub2, s: "subtitle" }] },
      []
    ],
    merges: [`A1:${XL.colName(width - 1)}1`, `A2:${XL.colName(width - 1)}2`, `A3:${XL.colName(width - 1)}3`]
  };
}

const STYLE_BY_KIND = {
  line: ["textIndent", "money", "pct"],
  child: ["textChild", "moneyChild", "pct"],
  group: ["groupLabel", "groupMoney", "pct"],
  total: ["subLabel", "subMoney", "pctBold"],
  result: ["resultLabel", "resultMoney", "pctResult"],
  grand: ["grandLabel", "grandMoney", "grandPct"],
  ratio: ["ratioLabel", "ratio", "ratio"]
};

function statementSheet(st, year) {
  const WIDTH = 15; // A + 12 meses + acumulado + %
  const head = titleRows(`${BUSINESS.toUpperCase()} — ESTADO DE RESULTADOS ${year}`,
    `Del 1 de enero al 31 de diciembre de ${year} · Cifras en pesos colombianos (COP)`,
    `Costo de ventas: ${COST_METHODS[acc.costMethod].toLowerCase()} · Generado el ${stamp()}`, WIDTH);
  const rows = head.rows;
  rows.push({ height: 24, cells: [{ v: "CONCEPTO", s: "headerLeft" }, ...MONTHS_SHORT.map(m => ({ v: m.toUpperCase(), s: "header" })),
    { v: "ACUMULADO AÑO", s: "header" }, { v: "% INGRESOS", s: "header" }] });
  const first = rows.length + 1;
  const rn = new Map(st.rows.map((r, i) => [r.id, first + i]));
  const C = XL.colName;
  const N = C(13), O = C(14);
  const tiRow = rn.get(st.ids.ti.id);
  const tiTotal = sum(st.ids.ti.values);

  st.rows.forEach(r => {
    const row = rn.get(r.id);
    if (r.kind === "section") {
      rows.push({ height: 20, cells: [{ v: r.label.toUpperCase(), s: "section" }, ...Array(WIDTH - 1).fill({ v: "", s: "sectionFill" })] });
      return;
    }
    const [ls, ms, ps] = STYLE_BY_KIND[r.kind];
    const cells = [{ v: r.kind === "total" || r.kind === "result" || r.kind === "grand" ? r.label.toUpperCase() : r.label, s: ls }];
    for (let m = 0; m < 12; m++) {
      const c = C(m + 1);
      if (r.kind === "ratio") {
        const val = cellValue(st, r, [m]);
        cells.push({ f: `IFERROR(${c}${rn.get(r.ratio[0])}/${c}${rn.get(r.ratio[1])},0)`, v: Number.isFinite(val) ? val : 0, s: ms });
      } else if (r.kind === "group" && r.children.length) {
        cells.push({ f: `SUM(${c}${rn.get(r.children[0])}:${c}${rn.get(r.children[r.children.length - 1])})`, v: r.values[m], s: ms });
      } else if (r.terms) {
        cells.push({ f: r.terms.map(([s, id], k) => `${s < 0 ? "-" : k ? "+" : ""}${c}${rn.get(id)}`).join(""), v: r.values[m], s: ms });
      } else {
        cells.push({ v: r.values[m], s: ms });
      }
    }
    if (r.kind === "ratio") {
      const val = cellValue(st, r, ALL_MONTHS);
      cells.push({ f: `IFERROR(${N}${rn.get(r.ratio[0])}/${N}${rn.get(r.ratio[1])},0)`, v: Number.isFinite(val) ? val : 0, s: ms });
      cells.push({ v: "", s: ps });
    } else {
      const total = sum(r.values);
      cells.push({ f: `SUM(${C(1)}${row}:${C(12)}${row})`, v: total, s: ms });
      cells.push({ f: `IFERROR(${N}${row}/${N}$${tiRow},0)`, v: tiTotal ? total / tiTotal : 0, s: ps });
    }
    rows.push({ height: r.kind === "grand" ? 24 : 18, cells });
  });

  rows.push([]);
  rows.push({ cells: [{ v: "Notas:", s: "bold" }] });
  const notes = [
    "Los ingresos se reconocen en la fecha de pago. Las ventas anuladas no suman.",
    "Granizados agrupa todos los sabores y tamaños (incluye toppings). Acompañantes y Extras se detallan por producto.",
    "Los porcentajes se calculan sobre el total de ingresos operacionales del año.",
    ...st.warnings
  ];
  notes.forEach(n => {
    rows.push({ height: 30, cells: [{ v: "• " + n, s: "note" }] });
    head.merges.push(`A${rows.length}:${C(WIDTH - 1)}${rows.length}`);
  });
  return {
    name: "Estado de resultados", rows, merges: head.merges, landscape: true,
    cols: [40, ...Array(12).fill(13), 16, 11], freeze: { row: 5, col: 1 }
  };
}

function summarySheet({ name, title, subtitle, first, qtyLabel, groups, totalLabel }) {
  const head = titleRows(title, subtitle, `Generado el ${stamp()}`, 4);
  const rows = head.rows;
  rows.push({ height: 24, cells: [{ v: first.toUpperCase(), s: "headerLeft" }, { v: qtyLabel.toUpperCase(), s: "header" }, { v: "VALOR", s: "header" }, { v: "PARTICIPACIÓN", s: "header" }] });
  // Fila de total: se calcula antes para las fórmulas de participación
  const start = rows.length + 1;
  const count = groups.reduce((s, g) => s + 1 + g.children.length, 0);
  const totalRow = start + count;
  const grandTotal = sum(groups.map(g => g.value));
  const tops = [];
  let r = start;
  groups.forEach(g => {
    const row = r++;
    tops.push(row);
    const kids = g.children.length;
    const pf = { f: `IFERROR(C${row}/C$${totalRow},0)`, v: grandTotal ? g.value / grandTotal : 0, s: "pct" };
    rows.push({ height: 19, cells: [
      { v: g.label, s: "groupLabel" },
      kids ? { f: `SUM(B${row + 1}:B${row + kids})`, v: g.qty || 0, s: "int" } : { v: g.qty || 0, s: "int" },
      kids ? { f: `SUM(C${row + 1}:C${row + kids})`, v: g.value, s: "groupMoney" } : { v: g.value, s: "groupMoney" },
      pf
    ] });
    g.children.forEach(c => {
      const cr = r++;
      rows.push([{ v: c.label, s: "textChild" }, { v: c.qty || 0, s: "int" }, { v: c.value, s: "moneyChild" },
        { f: `IFERROR(C${cr}/C$${totalRow},0)`, v: grandTotal ? c.value / grandTotal : 0, s: "pct" }]);
    });
  });
  const ref = col => tops.length ? tops.map(t => `${col}${t}`).join("+") : "0";
  rows.push({ height: 22, cells: [
    { v: totalLabel, s: "grandLabel" },
    { f: ref("B"), v: sum(groups.map(g => g.qty || 0)), s: "grandLabel" },
    { f: ref("C"), v: grandTotal, s: "grandMoney" },
    { f: `IF(C${totalRow}=0,0,1)`, v: grandTotal ? 1 : 0, s: "grandPct" }
  ] });
  return { name, rows, merges: head.merges, cols: [42, 14, 18, 16], freeze: { row: 5 } };
}

function incomeDetailSheet(lines, title, subtitle) {
  const WIDTH = 10;
  const head = titleRows(title, subtitle, `Generado el ${stamp()} · Ingresos reconocidos en la fecha de pago`, WIDTH);
  const rows = head.rows;
  rows.push({ height: 24, cells: ["FECHA", "HORA", "ORIGEN", "REFERENCIA", "RUBRO", "CONCEPTO", "CANT.", "FORMA DE PAGO", "VALOR", "COSTO REGISTRADO"]
    .map((h, i) => ({ v: h, s: i === 5 ? "headerLeft" : "header" })) });
  const first = rows.length + 1;
  const sorted = [...lines].sort((a, b) => a.date - b.date);
  sorted.forEach(l => rows.push([
    { v: dayOnly(l.date), s: "date" },
    { v: l.source === "manual" ? "—" : timeLabel(l.date), s: "center" },
    { v: SOURCES[l.source], s: "text" },
    { v: l.ref + (l.who ? ` · ${l.who}` : ""), s: "text" },
    { v: RUBROS[l.rubro], s: "text" },
    { v: l.concept + (l.note ? ` (${l.note})` : ""), s: "text" },
    l.qty === null || l.qty === undefined ? { v: "", s: "int" } : { v: l.qty, s: "int" },
    { v: PAY[l.method] || "—", s: "center" },
    { v: l.amount, s: "money" },
    l.cost === null ? { v: "", s: "money" } : { v: l.cost, s: "money" }
  ]));
  const last = rows.length;
  const has = sorted.length > 0;
  rows.push({ height: 22, cells: [
    { v: "TOTAL", s: "grandLabel" }, ...Array(5).fill({ v: "", s: "grandLabel" }),
    has ? { f: `SUM(G${first}:G${last})`, v: sum(sorted.map(l => l.qty || 0)), s: "grandLabel" } : { v: 0, s: "grandLabel" },
    { v: "", s: "grandLabel" },
    has ? { f: `SUM(I${first}:I${last})`, v: sum(sorted.map(l => l.amount)), s: "grandMoney" } : { v: 0, s: "grandMoney" },
    has ? { f: `SUM(J${first}:J${last})`, v: sum(sorted.map(l => l.cost || 0)), s: "grandMoney" } : { v: 0, s: "grandMoney" }
  ] });
  return { name: "Detalle ingresos", rows, merges: head.merges, landscape: true, cols: [12, 8, 13, 26, 15, 38, 8, 15, 15, 17], freeze: { row: 5 } };
}

function expenseDetailSheet(expenses, title, subtitle) {
  const WIDTH = 8;
  const head = titleRows(title, subtitle, `Generado el ${stamp()}`, WIDTH);
  const rows = head.rows;
  rows.push({ height: 24, cells: ["FECHA", "TIPO", "CATEGORÍA", "CONCEPTO", "PROVEEDOR", "FORMA DE PAGO", "NOTA", "VALOR"]
    .map((h, i) => ({ v: h, s: i === 3 ? "headerLeft" : "header" })) });
  const first = rows.length + 1;
  const sorted = [...expenses].sort((a, b) => a.date - b.date);
  sorted.forEach(e => rows.push([
    { v: dayOnly(e.date), s: "date" },
    { v: EXP_TYPES[e.type].label, s: "text" },
    { v: e.category || "", s: "text" },
    { v: e.concept || "", s: "text" },
    { v: e.supplier || "", s: "text" },
    { v: PAY[e.paymentMethod] || "—", s: "center" },
    { v: e.note || "", s: "text" },
    { v: e.amount || 0, s: "money" }
  ]));
  const last = rows.length;
  rows.push({ height: 22, cells: [
    { v: "TOTAL GASTOS", s: "grandLabel" }, ...Array(6).fill({ v: "", s: "grandLabel" }),
    sorted.length ? { f: `SUM(H${first}:H${last})`, v: sum(sorted.map(e => e.amount)), s: "grandMoney" } : { v: 0, s: "grandMoney" }
  ] });
  return { name: "Detalle gastos", rows, merges: head.merges, landscape: true, cols: [12, 20, 26, 34, 22, 15, 28, 16], freeze: { row: 5 } };
}

function safeDownload(filename, sheets) {
  try {
    XL.download(filename, sheets);
    toast("Archivo de Excel descargado", { type: "ok" });
  } catch (err) {
    console.error(err);
    toast("No se pudo generar el archivo de Excel.", { type: "error" });
  }
}

function exportIncome() {
  const { lines } = acc.period;
  const sub = `Periodo: ${periodLabel()} · Cifras en pesos colombianos (COP)`;
  safeDownload(`Ingresos_${fileStamp(acc.from)}_a_${fileStamp(acc.to)}.xlsx`, [
    summarySheet({
      name: "Ingresos por rubro", title: `${BUSINESS.toUpperCase()} — INGRESOS POR RUBRO`, subtitle: sub,
      first: "Rubro", qtyLabel: "Cantidad", groups: incomeStructure(groupIncome(lines)), totalLabel: "TOTAL INGRESOS"
    }),
    incomeDetailSheet(lines, `${BUSINESS.toUpperCase()} — HISTORIAL DE INGRESOS`, sub)
  ]);
}

function exportExpenses() {
  const { expenses } = acc.period;
  const sub = `Periodo: ${periodLabel()} · Cifras en pesos colombianos (COP)`;
  safeDownload(`Gastos_${fileStamp(acc.from)}_a_${fileStamp(acc.to)}.xlsx`, [
    summarySheet({
      name: "Gastos por categoría", title: `${BUSINESS.toUpperCase()} — GASTOS POR TIPO Y CATEGORÍA`, subtitle: sub,
      first: "Tipo · categoría", qtyLabel: "Registros", groups: expenseStructure(expenses), totalLabel: "TOTAL GASTOS"
    }),
    expenseDetailSheet(expenses, `${BUSINESS.toUpperCase()} — HISTORIAL DE GASTOS`, sub)
  ]);
}

async function exportStatement() {
  const btn = $("#erExport");
  if (btn) btn.disabled = true;
  try {
    const year = acc.year;
    const data = await yearData(year);
    const st = buildStatement(data, acc.costMethod);
    const sub = `Del 1 de enero al 31 de diciembre de ${year} · Cifras en pesos colombianos (COP)`;
    safeDownload(`Estado_de_resultados_${year}.xlsx`, [
      statementSheet(st, year),
      summarySheet({
        name: "Ingresos por rubro", title: `${BUSINESS.toUpperCase()} — INGRESOS POR RUBRO ${year}`, subtitle: sub,
        first: "Rubro", qtyLabel: "Cantidad", groups: incomeStructure(groupIncome(data.lines)), totalLabel: "TOTAL INGRESOS"
      }),
      incomeDetailSheet(data.lines, `${BUSINESS.toUpperCase()} — DETALLE DE INGRESOS ${year}`, sub),
      expenseDetailSheet(data.expenses, `${BUSINESS.toUpperCase()} — DETALLE DE GASTOS ${year}`, sub)
    ]);
  } catch (err) {
    console.error(err);
    toast(friendlyError(err), { type: "error" });
  } finally {
    if (btn) btn.disabled = false;
  }
}

Kit.registerTab("contabilidad", render);
})();
