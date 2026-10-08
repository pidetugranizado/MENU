// =====================================================================
// GENERADOR DE EXCEL (.xlsx) — sin librerías ni internet
// Arma un libro Office Open XML con estilos (encabezados, moneda COP,
// porcentajes, fechas), fórmulas con su valor ya calculado, columnas
// fijas, celdas combinadas y configuración de impresión.
//
// Uso:
//   XlsxWriter.download("archivo.xlsx", [{
//     name: "Hoja", cols: [30, 14], freeze: { row: 5, col: 1 },
//     merges: ["A1:D1"], landscape: true,
//     rows: [ { height: 26, cells: [{ v: "Título", s: "title" }] },
//             [ "texto", 1500, { f: "SUM(B2:B3)", v: 1500, s: "money" } ] ]
//   }]);
// Celda: null | texto | número | { v, s, f }. Texto → estilo "text", número → "money".
// =====================================================================
(function () {
"use strict";

const enc = new TextEncoder();

// ---------- ZIP (sin compresión) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01

function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = enc.encode(f.data);
    const crc = crc32(data);

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);  // nombres en UTF-8
    lh.setUint16(8, 0, true);       // sin compresión
    lh.setUint16(10, 0, true);
    lh.setUint16(12, DOS_DATE, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, 0, true);
    ch.setUint16(14, DOS_DATE, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint16(30, 0, true);
    ch.setUint16(32, 0, true);
    ch.setUint16(34, 0, true);
    ch.setUint16(36, 0, true);
    ch.setUint32(38, 0, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);

    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, 0, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
}

// ---------- Estilos ----------
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;

const DARK = "FF1B1D29";
const BRAND = "FFE5295F";
const MUTED = "FF6B7086";

// numFmtId 164+ personalizados
const NUM_FMTS = {
  164: `"$"\\ #,##0;[Red]\\-"$"\\ #,##0;"$"\\ 0`,
  165: `0.0%;[Red]\\-0.0%;0.0%`,
  166: `dd/mm/yyyy`,
  167: `#,##0`
};
const FONTS = [
  `<font><sz val="11"/><color rgb="${DARK}"/><name val="Calibri"/><family val="2"/></font>`,              // 0 normal
  `<font><b/><sz val="11"/><color rgb="${DARK}"/><name val="Calibri"/><family val="2"/></font>`,          // 1 negrita
  `<font><b/><sz val="16"/><color rgb="${BRAND}"/><name val="Calibri"/><family val="2"/></font>`,         // 2 título
  `<font><i/><sz val="10"/><color rgb="${MUTED}"/><name val="Calibri"/><family val="2"/></font>`,         // 3 subtítulo
  `<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>`,         // 4 blanco
  `<font><b/><sz val="12"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>`,         // 5 blanco grande
  `<font><sz val="10"/><color rgb="${MUTED}"/><name val="Calibri"/><family val="2"/></font>`              // 6 gris
];
const solid = rgb => `<fill><patternFill patternType="solid"><fgColor rgb="${rgb}"/><bgColor indexed="64"/></patternFill></fill>`;
const FILLS = [
  `<fill><patternFill patternType="none"/></fill>`,
  `<fill><patternFill patternType="gray125"/></fill>`,
  solid(DARK),         // 2 encabezado
  solid("FFF1F3F8"),   // 3 sección
  solid(BRAND),        // 4 total general
  solid("FFFDE8EF"),   // 5 subtotal
  solid("FFE2F7FB")    // 6 resultado
];
const BORDERS = [
  `<border><left/><right/><top/><bottom/><diagonal/></border>`,
  `<border><left/><right/><top/><bottom style="thin"><color rgb="FFE6E8EF"/></bottom><diagonal/></border>`,
  `<border><left/><right/><top style="thin"><color rgb="${DARK}"/></top><bottom style="thin"><color rgb="${DARK}"/></bottom><diagonal/></border>`
];

// [nombre, numFmtId, fontId, fillId, borderId, alineación]
const XF = [
  ["default", 0, 0, 0, 0, ""],
  ["title", 0, 2, 0, 0, `<alignment vertical="center"/>`],
  ["subtitle", 0, 3, 0, 0, `<alignment vertical="center"/>`],
  ["header", 0, 4, 2, 0, `<alignment horizontal="center" vertical="center" wrapText="1"/>`],
  ["headerLeft", 0, 4, 2, 0, `<alignment horizontal="left" vertical="center" indent="1"/>`],
  ["text", 0, 0, 0, 1, `<alignment vertical="center"/>`],
  ["textIndent", 0, 0, 0, 1, `<alignment vertical="center" indent="2"/>`],
  ["textChild", 0, 6, 0, 1, `<alignment vertical="center" indent="4"/>`],
  ["money", 164, 0, 0, 1, ""],
  ["moneyChild", 164, 6, 0, 1, ""],
  ["section", 0, 1, 3, 1, `<alignment vertical="center"/>`],
  ["sectionFill", 0, 1, 3, 1, ""],
  ["groupLabel", 0, 1, 0, 1, `<alignment vertical="center" indent="2"/>`],
  ["groupMoney", 164, 1, 0, 1, ""],
  ["subLabel", 0, 1, 5, 2, `<alignment vertical="center"/>`],
  ["subMoney", 164, 1, 5, 2, ""],
  ["resultLabel", 0, 1, 6, 2, `<alignment vertical="center"/>`],
  ["resultMoney", 164, 1, 6, 2, ""],
  ["grandLabel", 0, 5, 4, 0, `<alignment vertical="center"/>`],
  ["grandMoney", 164, 5, 4, 0, `<alignment vertical="center"/>`],
  ["grandPct", 165, 5, 4, 0, `<alignment vertical="center"/>`],
  ["pct", 165, 6, 0, 1, ""],
  ["pctBold", 165, 1, 5, 2, ""],
  ["pctResult", 165, 1, 6, 2, ""],
  ["ratioLabel", 0, 3, 0, 1, `<alignment vertical="center" indent="2"/>`],
  ["ratio", 165, 3, 0, 1, ""],
  ["date", 166, 0, 0, 1, `<alignment horizontal="center"/>`],
  ["int", 167, 0, 0, 1, `<alignment horizontal="center"/>`],
  ["center", 0, 0, 0, 1, `<alignment horizontal="center"/>`],
  ["note", 0, 3, 0, 0, `<alignment vertical="top" wrapText="1"/>`],
  ["bold", 0, 1, 0, 1, ""],
  ["moneyBold", 164, 1, 0, 1, ""],
  ["intBold", 167, 1, 5, 2, `<alignment horizontal="center"/>`]
];
const STYLE = Object.fromEntries(XF.map(([n], i) => [n, i]));

function stylesXml() {
  const fmts = Object.entries(NUM_FMTS).map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${xmlEsc(code)}"/>`).join("");
  const xfs = XF.map(([, fmt, font, fill, border, align]) =>
    `<xf numFmtId="${fmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0"` +
    `${fmt ? ` applyNumberFormat="1"` : ""}${font ? ` applyFont="1"` : ""}${fill ? ` applyFill="1"` : ""}${border ? ` applyBorder="1"` : ""}` +
    (align ? ` applyAlignment="1">${align}</xf>` : `/>`)).join("");
  return XML_HEAD +
    `<styleSheet xmlns="${NS_MAIN}">` +
    `<numFmts count="${Object.keys(NUM_FMTS).length}">${fmts}</numFmts>` +
    `<fonts count="${FONTS.length}">${FONTS.join("")}</fonts>` +
    `<fills count="${FILLS.length}">${FILLS.join("")}</fills>` +
    `<borders count="${BORDERS.length}">${BORDERS.join("")}</borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="${XF.length}">${xfs}</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`;
}

// ---------- Hojas ----------
function xmlEsc(s) {
  return String(s ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function colName(i) { // 0 → A
  let s = "";
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

function cellXml(cell, ref) {
  if (cell === null || cell === undefined || cell === "") return "";
  const c = typeof cell === "object" ? cell : { v: cell };
  const isNum = typeof c.v === "number";
  const style = STYLE[c.s || (isNum || c.f ? "money" : "text")] ?? 0;
  if (c.f) {
    const v = typeof c.v === "number" && Number.isFinite(c.v) ? `<v>${c.v}</v>` : "";
    return `<c r="${ref}" s="${style}"><f>${xmlEsc(c.f)}</f>${v}</c>`;
  }
  if (isNum) {
    if (!Number.isFinite(c.v)) return `<c r="${ref}" s="${style}"/>`;
    return `<c r="${ref}" s="${style}"><v>${c.v}</v></c>`;
  }
  if (c.v === null || c.v === undefined || c.v === "") return `<c r="${ref}" s="${style}"/>`;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(c.v)}</t></is></c>`;
}

function sheetXml(sh) {
  const rows = sh.rows.map((row, ri) => {
    const r = Array.isArray(row) ? { cells: row } : row;
    const cells = (r.cells || []).map((c, ci) => cellXml(c, colName(ci) + (ri + 1))).join("");
    const ht = r.height ? ` ht="${r.height}" customHeight="1"` : "";
    return `<row r="${ri + 1}"${ht}>${cells}</row>`;
  }).join("");

  let pane = "";
  const fr = sh.freeze || {};
  if (fr.row || fr.col) {
    const x = fr.col || 0, y = fr.row || 0;
    const active = x && y ? "bottomRight" : y ? "bottomLeft" : "topRight";
    pane = `<pane${x ? ` xSplit="${x}"` : ""}${y ? ` ySplit="${y}"` : ""} topLeftCell="${colName(x)}${y + 1}" activePane="${active}" state="frozen"/>` +
      `<selection pane="${active}" activeCell="${colName(x)}${y + 1}" sqref="${colName(x)}${y + 1}"/>`;
  }
  const cols = (sh.cols || []).length
    ? `<cols>${sh.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
  const merges = (sh.merges || []).length
    ? `<mergeCells count="${sh.merges.length}">${sh.merges.map(m => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";
  return XML_HEAD +
    `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>` +
    `<sheetViews><sheetView workbookViewId="0" showGridLines="0" zoomScale="100">${pane}</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    cols +
    `<sheetData>${rows}</sheetData>` +
    merges +
    `<pageMargins left="0.4" right="0.4" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>` +
    `<pageSetup paperSize="1" orientation="${sh.landscape ? "landscape" : "portrait"}" fitToWidth="1" fitToHeight="0"/>` +
    `</worksheet>`;
}

function safeSheetName(name, used) {
  let n = String(name || "Hoja").replace(/[\[\]:*?\/\\]/g, " ").trim().slice(0, 31) || "Hoja";
  let base = n, i = 2;
  while (used.has(n.toLowerCase())) n = `${base.slice(0, 28)} ${i++}`;
  used.add(n.toLowerCase());
  return n;
}

function build(sheets) {
  const used = new Set();
  const names = sheets.map(s => safeSheetName(s.name, used));
  const files = [
    { name: "[Content_Types].xml", data: XML_HEAD +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
      `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
      `</Types>` },
    { name: "_rels/.rels", data: XML_HEAD +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
      `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>` +
      `</Relationships>` },
    { name: "docProps/core.xml", data: XML_HEAD +
      `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `<dc:title>Granizados</dc:title><dc:creator>Granizados · Portal del personal</dc:creator>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</dcterms:created>` +
      `</cp:coreProperties>` },
    { name: "docProps/app.xml", data: XML_HEAD +
      `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Excel</Application></Properties>` },
    { name: "xl/workbook.xml", data: XML_HEAD +
      `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
      `<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="15000" activeTab="0"/></bookViews>` +
      `<sheets>${names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>` +
      `<calcPr calcId="191029" fullCalcOnLoad="1"/>` +
      `</workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: XML_HEAD +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>` },
    { name: "xl/styles.xml", data: stylesXml() },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) }))
  ];
  return zip(files);
}

function download(filename, sheets) {
  const blob = build(sheets);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Fecha local → número de serie de Excel (días desde 1899-12-30). */
function excelDate(d) {
  if (!(d instanceof Date) || isNaN(d)) return NaN;
  const utc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
  return (utc - Date.UTC(1899, 11, 30)) / 86400000;
}

window.XlsxWriter = { build, download, colName, excelDate, STYLES: Object.keys(STYLE) };
})();
