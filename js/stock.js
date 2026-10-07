// =====================================================================
// MOTOR DE INVENTARIO — stock de insumos, extras y acompañantes
//
// El stock vive en el mismo documento del artículo (insumo, extra o
// acompañante), así no hay datos duplicados: el costo de compra que usa el
// costeo es el mismo que actualiza cada compra del inventario.
//   • stock, minStock, trackStock (control activo), stockUnit (solo insumos)
//   • supplier, lastPurchasePrice / Unit / Qty / At
// Cada movimiento (compra, entrada, salida, venta, devolución, ajuste) queda
// en la colección inventoryMoves con sus líneas: stock anterior → nuevo.
// Los granizados no tienen stock propio: se descuentan sus ingredientes.
// =====================================================================
(function () {
"use strict";

const { db, COL, findSize } = window.Core;
const { doc, collection, serverTimestamp } = window.Store;
const C = window.Costing;

/** Colecciones con inventario (los nombres coinciden con COL). */
const KINDS = {
  supplies: "Materia prima / insumo",
  extras: "Extra",
  sides: "Acompañante"
};
const STATUS = { ok: "Disponible", bajo: "Bajo stock", agotado: "Agotado", none: "Sin control" };
const MOVE_TYPES = {
  compra: "Compra",
  entrada: "Entrada",
  salida: "Salida",
  ajuste: "Ajuste (conteo)",
  venta: "Salida por venta",
  devolucion: "Devolución (venta anulada)"
};
/** Unidades sugeridas para extras y acompañantes (se cuentan, no se convierten). */
const COUNT_UNITS = ["und", "paquete", "lata", "botella", "bolsa", "porción", "caja"];

const roundQty = n => Math.round(n * 1e6) / 1e6;
const isTracked = item => !!item && item.trackStock === true;
const stockOf = item => { const n = Number(item && item.stock); return Number.isFinite(n) ? n : 0; };
const minOf = item => { const n = Number(item && item.minStock); return Number.isFinite(n) && n > 0 ? n : 0; };

/** Convierte una cantidad entre unidades de la misma dimensión (NaN si no se puede). */
function convert(qty, from, to) {
  const a = C.unitInfo(from), b = C.unitInfo(to);
  if (a.dim !== b.dim) return NaN;
  return qty * a.f / b.f;
}

/**
 * Unidad en que se lleva el stock.
 * Insumos: la elegida (si es compatible con la de compra) o la de compra.
 * Extras y acompañantes: su unidad de venta (und, lata, paquete…).
 */
function stockUnit(col, item) {
  if (!item) return "und";
  if (col === "supplies") {
    const pu = String(item.purchaseUnit || "").trim() || "und";
    const su = String(item.stockUnit || "").trim();
    return su && C.unitInfo(su).dim === C.unitInfo(pu).dim ? su : pu;
  }
  return String(item.unit || "").trim() || "und";
}

/** Disponible / Bajo stock (llegó al mínimo) / Agotado / Sin control. */
function status(item) {
  if (!isTracked(item)) return "none";
  const s = stockOf(item);
  if (s <= 0) return "agotado";
  const min = minOf(item);
  if (min > 0 && s <= min) return "bajo";
  return "ok";
}

/** Costo de compra actual por unidad de stock (el mismo que usa el costeo). */
function unitCost(col, item) {
  if (!item) return NaN;
  if (col === "supplies") {
    const perBase = C.supplyUnitCost(item);
    return Number.isFinite(perBase) ? perBase * C.unitInfo(stockUnit(col, item)).f : NaN;
  }
  const c = item.unitCost;
  return c === null || c === undefined || c === "" || !(Number(c) >= 0) ? NaN : Number(c);
}

// ---------- Consumo ----------
/** needs: Map "col/id" → { col, id, parts: [{ qty, unit }] } */
function addNeed(needs, col, id, qty, unit) {
  if (!id || !(qty > 0) || !KINDS[col]) return;
  const k = col + "/" + id;
  if (!needs.has(k)) needs.set(k, { col, id, parts: [] });
  needs.get(k).parts.push({ qty, unit: unit || null });
}

function addRecipe(needs, recipe, times) {
  (Array.isArray(recipe) ? recipe : []).forEach(l => addNeed(needs, "supplies", l.supplyId, Number(l.qty) * times, l.unit));
}

/**
 * Lo que consume un pedido: la receta de cada tamaño × unidades, la receta
 * de cada topping elegido y los acompañantes. Usa las recetas vigentes.
 */
function orderNeeds(order, productsById, toppingsById) {
  const needs = new Map();
  for (const item of order.items || []) {
    const units = Array.isArray(item.units) ? item.units : [];
    const p = productsById.get(item.productId);
    const size = p ? findSize(p, item.sizeId) : null;
    if (size) addRecipe(needs, size.costing && size.costing.recipe, units.length || Number(item.quantity) || 0);
    for (const u of units) {
      for (const t of u.toppings || []) {
        const top = toppingsById.get(t.id);
        if (top) addRecipe(needs, top.costing && top.costing.recipe, 1);
      }
    }
  }
  for (const s of order.sides || []) addNeed(needs, "sides", s.sideId, Number(s.quantity), null);
  return needs;
}

/** Necesidades a partir de las líneas de un movimiento (para devolver lo descontado). */
function needsFromLines(lines) {
  const needs = new Map();
  (lines || []).forEach(l => addNeed(needs, l.col, l.id, Math.abs(Number(l.qty)), l.unit));
  return needs;
}

/** Cantidad total de una necesidad en la unidad de stock del artículo. */
function needQty(col, item, parts) {
  const unit = stockUnit(col, item);
  let qty = 0;
  for (const part of parts) {
    // Extras y acompañantes se cuentan: su unidad es solo un nombre
    const q = col === "supplies" && part.unit ? convert(part.qty, part.unit, unit) : part.qty;
    if (Number.isFinite(q)) qty += q;
  }
  return { qty: roundQty(qty), unit };
}

// ---------- Transacciones (primero todas las lecturas, luego las escrituras) ----------
/** Lecturas: trae los artículos involucrados. */
async function prepare(tx, needs) {
  const list = [...needs.values()];
  const snaps = await Promise.all(list.map(n => tx.get(doc(db, n.col, n.id))));
  return list.map((n, i) => ({ ...n, snap: snaps[i] }));
}

/**
 * Escrituras: sign = -1 descuenta (venta) · +1 devuelve (anulación).
 * Solo toca artículos con control de stock. Guarda un movimiento con
 * stock anterior y nuevo de cada línea y devuelve su id (o null si no hubo nada).
 */
function commit(tx, prepared, sign, meta) {
  const lines = [];
  for (const p of prepared) {
    if (!p.snap.exists()) continue;
    const item = p.snap.data();
    if (!isTracked(item)) continue;
    const { qty, unit } = needQty(p.col, item, p.parts);
    if (!(qty > 0)) continue;
    const before = stockOf(item);
    const after = roundQty(before + sign * qty);
    tx.update(doc(db, p.col, p.id), { stock: after });
    lines.push({ col: p.col, id: p.id, name: item.name || "", qty: roundQty(sign * qty), unit, before, after });
  }
  if (!lines.length) return null;
  const ref = doc(collection(db, COL.inventoryMoves));
  tx.set(ref, { ...meta, lines, date: serverTimestamp(), createdAt: serverTimestamp() });
  return ref.id;
}

window.Stock = {
  KINDS, STATUS, MOVE_TYPES, COUNT_UNITS,
  roundQty, isTracked, stockOf, minOf, convert, stockUnit, status, unitCost,
  addNeed, orderNeeds, needsFromLines, needQty, prepare, commit
};
})();
