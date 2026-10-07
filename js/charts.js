// =====================================================================
// GRÁFICAS SVG — columnas (agrupadas/apiladas), líneas y barras horizontales
// Sin librerías: devuelven HTML listo para insertar. Cada gráfica trae
// leyenda (si hay 2+ series), tooltip al pasar el mouse y su tabla de datos.
// =====================================================================
(function () {
"use strict";

const { esc } = window.Core;

// Paleta categórica validada (orden fijo, nunca se recicla) y tinta del gráfico
const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const POS = "#2a78d6";
const NEG = "#e34948";
const GRID = "#e1e0d9";
const AXIS = "#c3c2b7";
const MUTED = "#898781";

// Ancho del viewBox: cercano al ancho real de la tarjeta para que el texto
// conserve su tamaño (opts.wide = tarjeta de ancho completo).
let W = 560;
const setWidth = opts => { W = opts.wide ? 1100 : 560; };

function niceScale(min, max, count = 5) {
  if (min === max) max = min + 1;
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { lo, hi, ticks };
}

/** Moneda compacta para ejes: $1,2 M · $350 mil */
function compact(v) {
  const a = Math.abs(v), s = v < 0 ? "-" : "";
  if (a >= 1e6) return `${s}$${(a / 1e6).toLocaleString("es-CO", { maximumFractionDigits: 1 })} M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toLocaleString("es-CO", { maximumFractionDigits: 0 })} mil`;
  return `${s}$${Math.round(a)}`;
}

/** Barra con el extremo de datos redondeado (4px) y la base plana sobre la línea cero. */
function barPath(x, y0, y1, w) {
  const h = Math.abs(y1 - y0);
  if (h < 0.5 || w <= 0) return "";
  const r = Math.min(4, w / 2, h);
  const up = y1 < y0;
  const yr = up ? y1 + r : y1 - r;
  return `M${x},${y0}V${yr}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${yr}V${y0}Z`;
}
function hbarPath(x0, x1, y, h) {
  const w = x1 - x0;
  if (w < 0.5) return "";
  const r = Math.min(4, h / 2, w);
  return `M${x0},${y}H${x1 - r}Q${x1},${y} ${x1},${y + r}V${y + h - r}Q${x1},${y + h} ${x1 - r},${y + h}H${x0}Z`;
}

const tipAttr = lines => `data-tip="${esc(lines.join("\n"))}"`;

function legend(series) {
  if (series.length < 2) return "";
  return `<div class="chart-legend">${series.map(s =>
    `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>`;
}

function dataTable(categories, series, fmt, { total = false } = {}) {
  const sums = series.map(s => s.values.reduce((a, b) => a + (b || 0), 0));
  return `
    <details class="chart-table">
      <summary>Ver datos en tabla</summary>
      <div class="table-wrap"><table class="ctable">
        <thead><tr><th></th>${series.map(s => `<th>${esc(s.name)}</th>`).join("")}</tr></thead>
        <tbody>${categories.map((c, i) => `
          <tr><td>${esc(c)}</td>${series.map(s => `<td>${s.values[i] === null || s.values[i] === undefined ? "—" : fmt(s.values[i])}</td>`).join("")}</tr>`).join("")}
        </tbody>
        ${total ? `<tfoot><tr><td><b>Total</b></td>${sums.map(v => `<td><b>${fmt(v)}</b></td>`).join("")}</tr></tfoot>` : ""}
      </table></div>
    </details>`;
}

function yAxis(sc, y, m, axisFmt) {
  return sc.ticks.map(t => `
    <line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}" stroke="${t === 0 ? AXIS : GRID}" stroke-width="1"/>
    <text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end" class="ax">${esc(axisFmt(t))}</text>`).join("");
}

function xLabels(categories, xc, yPos) {
  const n = categories.length;
  const every = n > 24 ? Math.ceil(n / 12) : n > 14 ? 2 : 1;
  return categories.map((c, i) => i % every === 0
    ? `<text x="${xc(i)}" y="${yPos}" text-anchor="middle" class="ax">${esc(c)}</text>` : "").join("");
}

/**
 * Columnas verticales.
 * opts: { categories, series:[{name,color,values}], stacked, fmt, axisFmt, height, diverging, tipTitle(i) }
 * diverging: una sola serie; positivos en azul y negativos en rojo.
 */
function columns(opts) {
  setWidth(opts);
  const { categories, series, stacked = false, fmt, axisFmt = compact, height = 260, diverging = false } = opts;
  const tipTitle = opts.tipTitle || (i => categories[i]);
  const n = categories.length;
  const m = { t: 14, r: 10, b: 28, l: 62 };
  const ph = height - m.t - m.b, pw = W - m.l - m.r;
  let lo = 0, hi = 0;
  for (let i = 0; i < n; i++) {
    if (stacked) hi = Math.max(hi, series.reduce((s, x) => s + Math.max(0, x.values[i] || 0), 0));
    else series.forEach(s => { lo = Math.min(lo, s.values[i] || 0); hi = Math.max(hi, s.values[i] || 0); });
  }
  const sc = niceScale(lo, hi);
  const y = v => m.t + ph - (v - sc.lo) / (sc.hi - sc.lo) * ph;
  const band = pw / n;
  const groupW = Math.min(band * 0.72, stacked || series.length === 1 ? 44 : 22 * series.length + 2 * (series.length - 1));
  const xc = i => m.l + band * i + band / 2;
  const y0 = y(0);

  let marks = "";
  for (let i = 0; i < n; i++) {
    const gx = xc(i) - groupW / 2;
    if (stacked) {
      let acc = 0;
      const visible = series.filter(s => (s.values[i] || 0) > 0);
      visible.forEach((s, k) => {
        const v = s.values[i] || 0;
        const top = y(acc + v), bottom = y(acc) - (k > 0 ? 2 : 0); // 2px de separación entre segmentos
        acc += v;
        const isTop = k === visible.length - 1;
        marks += isTop
          ? `<path d="${barPath(gx, bottom, top, groupW)}" fill="${s.color}"/>`
          : bottom - top > 0.5 ? `<rect x="${gx}" y="${top}" width="${groupW}" height="${bottom - top}" fill="${s.color}"/>` : "";
      });
    } else {
      const k = series.length;
      const bw = (groupW - 2 * (k - 1)) / k;
      series.forEach((s, j) => {
        const v = s.values[i] || 0;
        const color = diverging ? (v < 0 ? NEG : POS) : s.color;
        marks += `<path d="${barPath(gx + j * (bw + 2), y0, y(v), bw)}" fill="${color}"/>`;
      });
    }
  }
  const hits = categories.map((c, i) => {
    const lines = [tipTitle(i), ...series.map(s => `${series.length > 1 ? s.name + ": " : ""}${fmt(s.values[i] || 0)}`)];
    if (stacked && series.length > 1) lines.push(`Total: ${fmt(series.reduce((a, s) => a + (s.values[i] || 0), 0))}`);
    return `<g class="hit" ${tipAttr(lines)}><rect class="hl" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ph}"/></g>`;
  }).join("");

  return `
    <svg class="chart-svg" viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(opts.label || "")}">
      ${yAxis(sc, y, m, axisFmt)}
      ${marks}
      ${xLabels(categories, xc, height - 8)}
      ${hits}
    </svg>
    ${legend(series)}
    ${dataTable(categories, series, fmt, { total: opts.tableTotal !== false })}`;
}

/**
 * Líneas (2px) con guía vertical y puntos al pasar el mouse.
 * Un valor null corta la línea (ej: meses o días que aún no han pasado).
 */
function lines(opts) {
  setWidth(opts);
  const { categories, series, fmt, axisFmt = compact, height = 260 } = opts;
  const tipTitle = opts.tipTitle || (i => categories[i]);
  const n = categories.length;
  const m = { t: 14, r: 14, b: 28, l: 62 };
  const ph = height - m.t - m.b, pw = W - m.l - m.r;
  let lo = 0, hi = 0;
  series.forEach(s => s.values.forEach(v => { lo = Math.min(lo, v || 0); hi = Math.max(hi, v || 0); }));
  const sc = niceScale(lo, hi);
  const y = v => m.t + ph - (v - sc.lo) / (sc.hi - sc.lo) * ph;
  const step = n > 1 ? pw / (n - 1) : 0;
  const xc = i => n > 1 ? m.l + step * i : m.l + pw / 2;
  const has = v => v !== null && v !== undefined;

  const paths = series.map(s => {
    let d = "", pen = false;
    s.values.forEach((v, i) => {
      if (!has(v)) { pen = false; return; }
      d += `${pen ? "L" : "M"}${xc(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    let last = -1;
    s.values.forEach((v, i) => { if (has(v)) last = i; });
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${last >= 0 ? `<circle cx="${xc(last)}" cy="${y(s.values[last])}" r="4" fill="${s.color}" stroke="#fff" stroke-width="2"/>` : ""}`;
  }).join("");
  const hw = n > 1 ? step : pw;
  const hits = categories.map((c, i) => {
    if (!series.some(s => has(s.values[i]))) return "";
    const tl = [tipTitle(i), ...series.map(s => `${series.length > 1 ? s.name + ": " : ""}${fmt(s.values[i] || 0)}`)];
    return `<g class="hit" ${tipAttr(tl)}>
      <rect class="hl-none" x="${Math.max(m.l, xc(i) - hw / 2)}" y="${m.t}" width="${hw}" height="${ph}" fill="transparent"/>
      <line class="on" x1="${xc(i)}" x2="${xc(i)}" y1="${m.t}" y2="${m.t + ph}" stroke="${AXIS}" stroke-width="1"/>
      ${series.filter(s => has(s.values[i])).map(s => `<circle class="on" cx="${xc(i)}" cy="${y(s.values[i])}" r="4.5" fill="${s.color}" stroke="#fff" stroke-width="2"/>`).join("")}
    </g>`;
  }).join("");

  return `
    <svg class="chart-svg" viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(opts.label || "")}">
      ${yAxis(sc, y, m, axisFmt)}
      ${paths}
      ${xLabels(categories, xc, height - 8)}
      ${hits}
    </svg>
    ${legend(series)}
    ${dataTable(categories, series, fmt, { total: opts.tableTotal !== false })}`;
}

/** Barras horizontales ordenadas (ranking). items: [{ label, value, sub }] */
function hbars(opts) {
  setWidth(opts);
  const { items, fmt, color = PALETTE[0], valueName = "Valor" } = opts;
  if (!items.length) return `<div class="chart-empty">Sin datos en este periodo.</div>`;
  const row = 30, m = { t: 6, r: 96, b: 6, l: 170 };
  const height = m.t + m.b + items.length * row;
  const max = Math.max(...items.map(x => x.value), 1);
  const x = v => m.l + (Math.max(0, v) / max) * (W - m.l - m.r);
  const trunc = s => (s.length > 24 ? s.slice(0, 23) + "…" : s);
  const body = items.map((it, i) => {
    const yy = m.t + i * row;
    return `<g class="hit" ${tipAttr([it.label, `${valueName}: ${fmt(it.value)}`, ...(it.sub ? [it.sub] : [])])}>
      <rect class="hl" x="0" y="${yy}" width="${W}" height="${row}"/>
      <text x="${m.l - 10}" y="${yy + row / 2 + 4}" text-anchor="end" class="lbl">${esc(trunc(it.label))}</text>
      <path d="${hbarPath(m.l, x(it.value), yy + 7, row - 14)}" fill="${color}"/>
      <text x="${x(it.value) + 8}" y="${yy + row / 2 + 4}" class="val">${esc(fmt(it.value))}</text>
    </g>`;
  }).join("");
  return `
    <svg class="chart-svg" viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(opts.label || "")}">
      <line x1="${m.l}" x2="${m.l}" y1="${m.t}" y2="${height - m.b}" stroke="${AXIS}"/>
      ${body}
    </svg>
    ${dataTable(items.map(i => i.label), [{ name: valueName, values: items.map(i => i.value) }], fmt)}`;
}

// ---------- Tooltip compartido ----------
let tipEl = null;
function tip() {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "chart-tip";
    tipEl.hidden = true;
    document.body.appendChild(tipEl);
  }
  return tipEl;
}
function place(e) {
  const t = tip();
  const pad = 14;
  let x = e.clientX + pad, y = e.clientY + pad;
  const r = t.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
  t.style.left = Math.max(8, x) + "px";
  t.style.top = Math.max(8, y) + "px";
}
document.addEventListener("pointerover", e => {
  const g = e.target.closest && e.target.closest(".chart-svg [data-tip]");
  const t = tip();
  if (!g) { t.hidden = true; return; }
  const [head, ...rest] = g.getAttribute("data-tip").split("\n");
  t.innerHTML = `<b>${esc(head)}</b>${rest.map(l => `<div>${esc(l)}</div>`).join("")}`;
  t.hidden = false;
  place(e);
});
document.addEventListener("pointermove", e => { if (tipEl && !tipEl.hidden) place(e); });
document.addEventListener("scroll", () => { if (tipEl) tipEl.hidden = true; }, true);

window.Charts = { PALETTE, POS, NEG, columns, lines, hbars, compact };
})();
