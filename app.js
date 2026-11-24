"use strict";

/* ===================================================================
   Eksoch Inventory Manager — products, stock, purchases, sales and
   profit for small businesses. Runs fully in the browser: everything
   lives in this device's localStorage, nothing is sent anywhere.

   Stock and costs are never stored as totals. They are worked out by
   replaying every stock change in date order (see calc()), so editing
   or deleting an old purchase or sale always gives correct numbers.
   Cost of goods sold uses the weighted average cost at the time of sale.
   =================================================================== */

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const main = $("#main");

// ---------- Storage (wrapped: storage can be blocked or full) ----------
const K = { data: "eiv.data", pro: "eiv.proCode" };
const store = {
  get(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set(k, v) {
    try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); return true; }
    catch { toast("Couldn't save: this device's storage is full or blocked. Download a backup."); return false; }
  },
  json(k, fallback) { try { return JSON.parse(store.get(k)) ?? fallback; } catch { return fallback; } },
};

// ?demo=1 opens a sample gift shop that lives in memory only: nothing is saved.
const DEMO = new URLSearchParams(location.search).get("demo") === "1";
// ?demo=1&sample=1 also pre-fills the sale form (used for the AppSumo screenshots).
const SAMPLE = DEMO && new URLSearchParams(location.search).get("sample") === "1";

// ---------- Pro (unlocked with an AppSumo code, checked on this device) ----------
// pro-codes.js holds one-way hashes of the valid codes, made by make_appsumo_codes.js.
const PRO_SALT = "eksoch-inventory-manager|";
const FREE = { products: 25 };
const normalizeCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
async function codeIsValid(code) {
  const norm = normalizeCode(code);
  if (norm.length < 10 || !self.PRO_CODE_HASHES || !crypto?.subtle) return false;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PRO_SALT + norm));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
  return self.PRO_CODE_HASHES.has(hex);
}
let proActive = false;
const hasPro = () => proActive || DEMO;
const canAddProduct = () => hasPro() || db.products.length < FREE.products;

// ---------- Helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const num = (v) => { const n = typeof v === "number" ? v : parseFloat(String(v ?? "").trim()); return Number.isFinite(n) ? n : NaN; };
const round2 = (n) => Math.round(n * 100) / 100;
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseD = (s) => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, m - 1, d); };
const today = () => ymd(new Date());
const addDays = (s, n) => { const d = parseD(s); d.setDate(d.getDate() + n); return ymd(d); };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(parseD(s));
const fmtDate = (s) => parseD(s).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const shortDate = (s) => parseD(s).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const fmtQty = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "—");
let moneyFmt = null;
function money(n) {
  if (!moneyFmt) {
    try { moneyFmt = new Intl.NumberFormat(undefined, { style: "currency", currency: db.settings.currency || "USD", currencyDisplay: "narrowSymbol" }); }
    catch { moneyFmt = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  }
  return moneyFmt.format(Number(n) || 0);
}

function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3200);
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// CSV with a BOM so Excel reads accents; text that looks like a formula is defused.
function csv(rows) {
  const cell = (v) => {
    if (typeof v === "number") return Number.isFinite(v) ? String(round2(v)) : "";
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

// ===================================================================
// Data
// ===================================================================
const MOVE_TYPES = ["opening", "purchase", "sale", "adjust"];
const TYPE_LABEL = { opening: "Opening stock", purchase: "Purchase", sale: "Sale", adjust: "Adjustment" };
const blank = () => ({ version: 1, settings: { shop: "", currency: "USD", notify: false, notified: [] }, products: [], moves: [] });

// Cleans anything loaded from storage or a backup file, so bad data can't break the app.
function normalize(d) {
  const b = blank();
  const s = d && typeof d.settings === "object" ? d.settings : {};
  const str = (v, max = 200) => String(v ?? "").slice(0, max);
  const n0 = (v) => (Number.isFinite(num(v)) ? num(v) : 0);
  const products = (Array.isArray(d?.products) ? d.products : []).filter((p) => p && p.id && p.name).map((p) => ({
    id: str(p.id, 40), name: str(p.name, 120), sku: str(p.sku, 60), category: str(p.category, 60), unit: str(p.unit, 20),
    cost: Math.max(0, n0(p.cost)), price: Math.max(0, n0(p.price)), reorder: Math.max(0, n0(p.reorder)),
    notes: str(p.notes, 1000), created: n0(p.created) || Date.now(),
  }));
  const ids = new Set(products.map((p) => p.id));
  const moves = (Array.isArray(d?.moves) ? d.moves : []).filter((m) => m && m.id && ids.has(m.productId) && MOVE_TYPES.includes(m.type)).map((m) => ({
    id: str(m.id, 40), productId: m.productId, type: m.type, qty: n0(m.qty),
    unitCost: Math.max(0, n0(m.unitCost)), unitPrice: Math.max(0, n0(m.unitPrice)),
    party: str(m.party, 120), note: str(m.note, 300), ref: str(m.ref, 40),
    date: isDate(m.date) ? m.date : today(), created: n0(m.created) || Date.now(),
  }));
  return {
    version: 1,
    settings: {
      shop: str(s.shop, 120), currency: /^[A-Z]{3}$/.test(s.currency) ? s.currency : b.settings.currency,
      notify: !!s.notify, notified: Array.isArray(s.notified) ? s.notified.filter((x) => ids.has(x)) : [],
    },
    products, moves,
  };
}

let db = DEMO ? demoData() : normalize(store.json(K.data, null) || blank());
const firstRun = () => !DEMO && !db.settings.shop;

// Derived numbers, rebuilt by calc() after every change.
let S = { stock: new Map(), info: new Map(), sorted: [] };
const byTime = (a, b) => a.date.localeCompare(b.date) || a.created - b.created;
const prod = (id) => db.products.find((p) => p.id === id);

function calc() {
  const stock = new Map(db.products.map((p) => [p.id, { qty: 0, avg: 0 }]));
  const info = new Map();
  const sorted = [...db.moves].sort(byTime);
  for (const m of sorted) {
    const s = stock.get(m.productId);
    const p = prod(m.productId);
    if (!s || !p) continue;
    if (m.type === "opening" || m.type === "purchase") {
      s.avg = s.qty > 0 ? (s.qty * s.avg + m.qty * m.unitCost) / (s.qty + m.qty) : m.unitCost;
      s.qty += m.qty;
      info.set(m.id, { after: s.qty, total: m.qty * m.unitCost });
    } else if (m.type === "sale") {
      const unitCogs = s.avg || p.cost || 0;
      const revenue = m.qty * m.unitPrice;
      const cogs = m.qty * unitCogs;
      s.qty -= m.qty;
      info.set(m.id, { after: s.qty, revenue, cogs, profit: revenue - cogs });
    } else {
      if (!s.avg) s.avg = p.cost || 0;
      s.qty += m.qty;
      info.set(m.id, { after: s.qty, value: m.qty * s.avg });
    }
  }
  S = { stock, info, sorted };
}
const qtyOf = (id) => S.stock.get(id)?.qty ?? 0;
const avgOf = (id) => { const s = S.stock.get(id); return s && s.avg ? s.avg : prod(id)?.cost || 0; };
const isLow = (p) => p.reorder > 0 && qtyOf(p.id) <= p.reorder;
const lowItems = () => db.products.filter(isLow).sort((a, b) => qtyOf(a.id) - qtyOf(b.id));

function save() {
  calc();
  if (DEMO) return true;
  return store.set(K.data, JSON.stringify(db));
}

function stockPill(p) {
  const q = qtyOf(p.id);
  if (q <= 0) return '<span class="pill out">Out of stock</span>';
  if (isLow(p)) return '<span class="pill low">Low</span>';
  return "";
}

// ---------- Date ranges (shared by the dashboard, lists and reports) ----------
const PERIODS = { today: "Today", "7d": "Last 7 days", month: "This month", "30d": "Last 30 days", year: "This year", all: "All time", custom: "Custom" };
const ui = { period: "30d", from: "", to: "", search: "", category: "", lowOnly: false, histProduct: "", histType: "", histLimit: 100 };
function range() {
  const t = today();
  switch (ui.period) {
    case "today": return [t, t];
    case "7d": return [addDays(t, -6), t];
    case "month": return [t.slice(0, 8) + "01", t];
    case "year": return [t.slice(0, 5) + "01-01", t];
    case "all": return [S.sorted[0]?.date < t ? S.sorted[0].date : t, t];
    case "custom": {
      const from = isDate(ui.from) ? ui.from : addDays(t, -29);
      const to = isDate(ui.to) ? ui.to : t;
      return from <= to ? [from, to] : [to, from];
    }
    default: return [addDays(t, -29), t];
  }
}
const rangeLabel = ([a, b]) => (a === b ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`);
function rangePicker() {
  const [from, to] = range();
  return `<div class="chips" role="group" aria-label="Date range">
    ${Object.entries(PERIODS).map(([k, v]) => `<button type="button" class="chip" data-period="${k}" aria-pressed="${ui.period === k}">${v}</button>`).join("")}
  </div>
  ${ui.period === "custom" ? `<div class="filters"><label>From<input type="date" id="rFrom" value="${from}"></label><label>To<input type="date" id="rTo" value="${to}"></label></div>` : ""}`;
}
function wireRange(rerender) {
  $$("[data-period]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.period === "custom" && ui.period !== "custom") { [ui.from, ui.to] = range(); }
    ui.period = b.dataset.period; rerender();
  }));
  const f = $("#rFrom"), t = $("#rTo");
  if (f) f.addEventListener("change", () => { ui.from = f.value; rerender(); });
  if (t) t.addEventListener("change", () => { ui.to = t.value; rerender(); });
}
const movesIn = (type, [from, to]) => S.sorted.filter((m) => m.type === type && m.date >= from && m.date <= to);
function totals(sales) {
  const t = { revenue: 0, cogs: 0, profit: 0, units: 0, orders: new Set() };
  for (const m of sales) {
    const i = S.info.get(m.id);
    t.revenue += i.revenue; t.cogs += i.cogs; t.profit += i.profit; t.units += m.qty; t.orders.add(m.ref || m.id);
  }
  return t;
}
// Profit grouped by a key (product id, category, customer).
function groupSales(sales, keyFn) {
  const g = new Map();
  for (const m of sales) {
    const k = keyFn(m);
    const i = S.info.get(m.id);
    const r = g.get(k) || { key: k, units: 0, revenue: 0, cogs: 0, profit: 0 };
    r.units += m.qty; r.revenue += i.revenue; r.cogs += i.cogs; r.profit += i.profit;
    g.set(k, r);
  }
  return [...g.values()].sort((a, b) => b.profit - a.profit);
}

// ---------- Low-stock alerts (badge + optional browser notification) ----------
function updateLowBadge() {
  const n = lowItems().length;
  const b = $("#lowBadge");
  b.hidden = !n;
  b.textContent = n;
  b.title = `${n} product${n === 1 ? "" : "s"} low on stock`;
}
async function showNotification(title, body) {
  const opts = { body, icon: "icons/icon-192.png", badge: "icons/icon-192.png", tag: "eiv-low-stock" };
  try {
    const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg) return await reg.showNotification(title, opts);
    const n = new Notification(title, opts);
    n.onclick = () => { window.focus(); location.hash = "#products/low"; n.close(); };
  } catch { /* some browsers only allow notifications from an installed app */ }
}
const notifyReady = () => db.settings.notify && "Notification" in window && Notification.permission === "granted";
// Notifies once per product each time it drops to its reorder level; restocking re-arms it.
function checkLowAlerts() {
  const low = lowItems();
  const lowIds = new Set(low.map((p) => p.id));
  const before = db.settings.notified.join();
  db.settings.notified = db.settings.notified.filter((id) => lowIds.has(id));
  const fresh = low.filter((p) => !db.settings.notified.includes(p.id));
  if (fresh.length && notifyReady()) {
    const title = fresh.length === 1 ? `Low stock: ${fresh[0].name}` : `${fresh.length} products are low on stock`;
    const body = fresh.slice(0, 4).map((p) => `${p.name}: ${fmtQty(qtyOf(p.id))} left (reorder at ${fmtQty(p.reorder)})`).join("\n")
      + (fresh.length > 4 ? `\n…and ${fresh.length - 4} more` : "");
    showNotification(title, body);
    db.settings.notified.push(...fresh.map((p) => p.id));
  }
  if (db.settings.notified.join() !== before) save();
  updateLowBadge();
}

// ===================================================================
// Views
// ===================================================================
const emptyState = (text, btn = "") => `<div class="empty"><p>${text}</p>${btn}</div>`;
const notFound = (what, back) => { main.innerHTML = `<div class="msg error">That ${what} doesn't exist any more.</div><a class="btn" href="${back}">Go back</a>`; };

// ---------- Welcome / first run ----------
const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "INR", "PKR", "BDT", "NPR", "LKR", "AED", "SAR", "SGD", "MYR", "PHP", "IDR", "THB", "JPY", "CNY", "HKD", "KRW", "ZAR", "NGN", "KES", "GHS", "EGP", "BRL", "MXN", "ARS", "CLP", "COP", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK", "TRY", "ILS"];
function currencyOptions(sel) {
  const names = (() => { try { return new Intl.DisplayNames(undefined, { type: "currency" }); } catch { return null; } })();
  return CURRENCIES.map((c) => `<option value="${c}" ${c === sel ? "selected" : ""}>${c}${names ? " · " + esc(names.of(c)) : ""}</option>`).join("");
}
function guessCurrency() {
  try {
    const r = (navigator.language || "en-US").split("-")[1];
    return { US: "USD", GB: "GBP", IN: "INR", CA: "CAD", AU: "AUD", NZ: "NZD", PK: "PKR", AE: "AED", SG: "SGD", ZA: "ZAR", NG: "NGN", PH: "PHP", JP: "JPY", BR: "BRL", MX: "MXN", DE: "EUR", FR: "EUR", ES: "EUR", IT: "EUR", NL: "EUR", IE: "EUR" }[r] || "USD";
  } catch { return "USD"; }
}

function viewWelcome() {
  main.innerHTML = `
    <div class="welcome">
      <h2>👋 Welcome to Eksoch Inventory Manager</h2>
      <div class="card">
        <p>Keep track of your products, stock and profit in one place:</p>
        <ul>
          <li>📦 Products with SKU, category, cost and sale price</li>
          <li>🚚 Purchases add stock, 🧾 sales take it away, automatically</li>
          <li>🔔 Low-stock warnings, with browser notifications if you like</li>
          <li>📊 Profit per sale and per product, using your real cost of goods</li>
        </ul>
        <p class="muted small">No account needed. Everything is saved only on this device.</p>
      </div>
      <form class="card" id="setup">
        <h3>Set up your shop</h3>
        <label>Business name<input name="shop" required maxlength="120" placeholder="e.g. Juniper &amp; Pine Gifts" autocomplete="organization"></label>
        <label>Currency<select name="currency">${currencyOptions(guessCurrency())}</select></label>
        <button class="btn primary">Start</button>
      </form>
      <div class="card">
        <h3>Just looking?</h3>
        <p>Try the app with a sample gift shop. Nothing you change in the demo is saved.</p>
        <div class="actions"><a class="btn" href="?demo=1#dashboard">Open the demo shop</a>
          <label class="btn" style="margin:0">Restore a backup<input type="file" id="restore" accept="application/json,.json" hidden></label></div>
      </div>
    </div>`;
  $("#setup").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const shop = String(f.get("shop")).trim();
    if (!shop) return;
    db.settings.shop = shop;
    db.settings.currency = String(f.get("currency"));
    moneyFmt = null;
    if (save()) { location.hash = "#products"; route(); toast("Your shop is ready. Add your first product."); }
  });
  $("#restore").addEventListener("change", restoreBackup);
}

// ---------- Dashboard ----------
function viewDashboard() {
  const r = range();
  const sales = movesIn("sale", r);
  const t = totals(sales);
  const purchases = movesIn("purchase", r).reduce((a, m) => a + S.info.get(m.id).total, 0);
  let stockValue = 0, retailValue = 0, units = 0;
  for (const p of db.products) {
    const q = Math.max(0, qtyOf(p.id));
    stockValue += q * avgOf(p.id); retailValue += q * p.price; units += q;
  }
  const low = lowItems();
  const best = groupSales(sales, (m) => m.productId).slice(0, 5);
  const recent = [...S.sorted].reverse().slice(0, 6);

  main.innerHTML = `
    <div class="head"><h2>📊 Dashboard</h2>
      <div class="actions"><a class="btn primary" href="#sell">+ Record sale</a><a class="btn" href="#buy">+ Record purchase</a></div></div>
    ${!db.products.length ? `<div class="msg warn">Start by <a href="#product-new">adding your first product</a>. Then record purchases and sales, and your numbers appear here.</div>` : ""}
    ${rangePicker()}
    <div class="grid kpis">
      <div class="kpi"><span>Sales</span><strong>${money(t.revenue)}</strong><small>${t.orders.size} order${t.orders.size === 1 ? "" : "s"}</small></div>
      <div class="kpi"><span>Gross profit</span><strong class="${t.profit < 0 ? "neg" : ""}">${money(t.profit)}</strong><small>${pct(t.profit, t.revenue)} margin</small></div>
      <div class="kpi"><span>Cost of goods sold</span><strong>${money(t.cogs)}</strong><small>${fmtQty(t.units)} units sold</small></div>
      <div class="kpi"><span>Purchases</span><strong>${money(purchases)}</strong><small>stock bought</small></div>
    </div>
    <div class="grid two">
      <div class="card"><div class="row spread"><h3>Sales and profit</h3>
        <div class="legend"><span><i style="background:var(--rev)"></i>Sales</span><span><i style="background:var(--profit)"></i>Profit</span></div></div>
        ${chart(sales, r)}</div>
      <div class="card"><div class="row spread"><h3>🔔 Low stock</h3>${low.length ? `<a class="small" href="#products/low">See all ${low.length}</a>` : ""}</div>
        ${low.length ? `<ul class="list">${low.slice(0, 6).map((p) => `<li><span class="grow"><a href="#product/${p.id}">${esc(p.name)}</a>
          <span class="sub muted small">${fmtQty(qtyOf(p.id))} ${esc(p.unit)} left · reorder at ${fmtQty(p.reorder)}</span></span>
          <a class="btn small" href="#buy/${p.id}">Restock</a></li>`).join("")}</ul>`
        : `<p class="muted">Nothing is low on stock. 🎉 Products appear here when they reach their reorder level.</p>`}</div>
    </div>
    <div class="grid kpis">
      <div class="kpi"><span>Stock value (at cost)</span><strong>${money(stockValue)}</strong><small>${fmtQty(units)} units on hand</small></div>
      <div class="kpi"><span>Stock at sale prices</span><strong>${money(retailValue)}</strong><small>${money(retailValue - stockValue)} potential profit</small></div>
      <div class="kpi"><span>Products</span><strong>${db.products.length}</strong><small>${hasPro() ? "unlimited with Pro" : `of ${FREE.products} on the free plan`}</small></div>
      <div class="kpi ${low.length ? "warn" : ""}"><span>Low or out of stock</span><strong>${low.length}</strong><small>${db.products.filter((p) => qtyOf(p.id) <= 0).length} out of stock</small></div>
    </div>
    <div class="grid two">
      <div class="card"><h3>🏆 Best sellers by profit</h3>
        ${best.length ? `<div class="table-wrap"><table><thead><tr><th>Product</th><th class="num">Sold</th><th class="num">Sales</th><th class="num">Profit</th></tr></thead><tbody>
          ${best.map((b) => { const p = prod(b.key); return `<tr><td><a class="name" href="#product/${b.key}">${esc(p?.name)}</a></td><td class="num">${fmtQty(b.units)}</td><td class="num">${money(b.revenue)}</td><td class="num">${money(b.profit)}</td></tr>`; }).join("")}
        </tbody></table></div>` : `<p class="muted">No sales in this period.</p>`}</div>
      <div class="card"><div class="row spread"><h3>🕘 Recent activity</h3><a class="small" href="#history">Stock history</a></div>
        ${recent.length ? `<ul class="list">${recent.map(activityItem).join("")}</ul>` : `<p class="muted">Nothing recorded yet.</p>`}</div>
    </div>`;
  wireRange(viewDashboard);
}
function activityItem(m) {
  const p = prod(m.productId);
  const sign = m.type === "sale" ? -m.qty : m.qty;
  return `<li><span class="grow">${typePill(m)} <a href="#product/${m.productId}">${esc(p?.name)}</a>
    <span class="sub muted small">${shortDate(m.date)}${m.party ? " · " + esc(m.party) : ""}</span></span>
    <span class="num ${sign < 0 ? "neg" : ""}">${sign > 0 ? "+" : ""}${fmtQty(sign)}</span></li>`;
}
const typePill = (m) => `<span class="pill ${m.type === "sale" ? "sale" : m.type === "adjust" ? "" : "in"}">${TYPE_LABEL[m.type]}</span>`;

// Daily (or monthly, for long ranges) sales and profit bars.
function chart(sales, [from, to]) {
  const days = Math.round((parseD(to) - parseD(from)) / 864e5) + 1;
  const monthly = days > 62;
  const buckets = new Map();
  if (monthly) {
    for (let d = parseD(from.slice(0, 8) + "01"); ymd(d) <= to; d.setMonth(d.getMonth() + 1)) buckets.set(ymd(d).slice(0, 7), { rev: 0, pro: 0 });
  } else {
    for (let s = from; s <= to; s = addDays(s, 1)) buckets.set(s, { rev: 0, pro: 0 });
  }
  for (const m of sales) {
    const b = buckets.get(monthly ? m.date.slice(0, 7) : m.date);
    if (b) { const i = S.info.get(m.id); b.rev += i.revenue; b.pro += i.profit; }
  }
  const keys = [...buckets.keys()];
  const max = Math.max(1, ...[...buckets.values()].map((b) => b.rev));
  const label = (k) => (monthly ? parseD(k + "-01").toLocaleDateString(undefined, { month: "short", year: "2-digit" }) : shortDate(k));
  if (!sales.length) return `<p class="muted">No sales in this period yet.</p>`;
  return `<div class="chart" role="img" aria-label="Sales and profit per ${monthly ? "month" : "day"}, ${esc(rangeLabel([from, to]))}">
    ${keys.map((k) => { const b = buckets.get(k); return `<div class="col" title="${esc(label(k))}: sales ${esc(money(b.rev))}, profit ${esc(money(b.pro))}">
      <div class="rev" style="height:${(b.rev / max) * 100}%"><div class="pro" style="height:${b.rev ? (Math.max(0, b.pro) / b.rev) * 100 : 0}%"></div></div></div>`; }).join("")}
  </div>
  <div class="axis"><span>${esc(label(keys[0]))}</span>${keys.length > 2 ? `<span>${esc(label(keys[Math.floor(keys.length / 2)]))}</span>` : ""}<span>${esc(label(keys[keys.length - 1]))}</span></div>`;
}

// ---------- Products ----------
function viewProducts(arg) {
  if (arg === "low") { ui.lowOnly = true; history.replaceState(null, "", "#products"); }
  const cats = [...new Set(db.products.map((p) => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (ui.category && !cats.includes(ui.category)) ui.category = "";
  main.innerHTML = `
    <div class="head"><h2>📦 Products <span class="muted small">(${db.products.length}${hasPro() ? "" : ` of ${FREE.products} free`})</span></h2>
      <div class="actions"><a class="btn primary" href="#product-new">+ Add product</a></div></div>
    ${!hasPro() && db.products.length >= FREE.products - 3 ? `<div class="msg warn">The free plan holds up to ${FREE.products} products. <a href="#pro">Unlock Pro</a> for unlimited products, profit reports and CSV export.</div>` : ""}
    ${db.products.length ? `<div class="card">
      <div class="filters">
        <label>Search<input type="search" id="q" value="${esc(ui.search)}" placeholder="Name, SKU or category"></label>
        <label>Category<select id="cat"><option value="">All categories</option>${cats.map((c) => `<option ${c === ui.category ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
        <label class="check"><input type="checkbox" id="lowOnly" ${ui.lowOnly ? "checked" : ""}> Low stock only</label>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Product</th><th class="hide-sm">Category</th><th class="num">In stock</th><th class="num hide-sm">Reorder at</th><th class="num hide-sm">Avg cost</th><th class="num">Price</th><th class="num hide-sm">Stock value</th></tr></thead>
        <tbody id="prows"></tbody></table></div></div>`
    : `<div class="card">${emptyState("No products yet. Add the things you sell, with their cost and sale price.", '<a class="btn primary" href="#product-new">+ Add your first product</a>')}</div>`}`;
  if (!db.products.length) return;
  const draw = () => {
    const q = ui.search.trim().toLowerCase();
    const rows = db.products
      .filter((p) => (!ui.category || p.category === ui.category) && (!ui.lowOnly || isLow(p) || qtyOf(p.id) <= 0)
        && (!q || `${p.name} ${p.sku} ${p.category}`.toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name));
    $("#prows").innerHTML = rows.length ? rows.map((p) => `<tr class="link" data-id="${p.id}">
      <td><a class="name" href="#product/${p.id}">${esc(p.name)}</a>${p.sku ? `<span class="sub">${esc(p.sku)}</span>` : ""}</td>
      <td class="hide-sm">${esc(p.category) || '<span class="muted">—</span>'}</td>
      <td class="num">${fmtQty(qtyOf(p.id))} ${esc(p.unit)} ${stockPill(p)}</td>
      <td class="num hide-sm">${p.reorder ? fmtQty(p.reorder) : '<span class="muted">—</span>'}</td>
      <td class="num hide-sm">${money(avgOf(p.id))}</td>
      <td class="num">${money(p.price)}</td>
      <td class="num hide-sm">${money(Math.max(0, qtyOf(p.id)) * avgOf(p.id))}</td></tr>`).join("")
      : `<tr><td colspan="7" class="empty">No products match.</td></tr>`;
  };
  draw();
  $("#q").addEventListener("input", (e) => { ui.search = e.target.value; draw(); });
  $("#cat").addEventListener("change", (e) => { ui.category = e.target.value; draw(); });
  $("#lowOnly").addEventListener("change", (e) => { ui.lowOnly = e.target.checked; draw(); });
  $("#prows").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr && !e.target.closest("a")) location.hash = "#product/" + tr.dataset.id;
  });
}

function viewProduct(id) {
  const p = prod(id);
  if (!p) return notFound("product", "#products");
  const moves = S.sorted.filter((m) => m.productId === id).reverse();
  const t = totals(moves.filter((m) => m.type === "sale"));
  const q = qtyOf(id);
  main.innerHTML = `
    <a class="back" href="#products">← Products</a>
    <div class="head"><h2>${esc(p.name)} ${stockPill(p)}</h2>
      <div class="actions"><a class="btn primary" href="#sell/${id}">Sell</a><a class="btn" href="#buy/${id}">Buy stock</a>
        <a class="btn" href="#adjust/${id}">Adjust stock</a><a class="btn" href="#product-edit/${id}">Edit</a></div></div>
    <p class="muted">${[p.sku && "SKU " + esc(p.sku), p.category && esc(p.category), p.unit && "sold per " + esc(p.unit)].filter(Boolean).join(" · ") || "No SKU or category yet"}</p>
    <div class="grid kpis">
      <div class="kpi ${isLow(p) ? "warn" : ""}"><span>In stock</span><strong>${fmtQty(q)} ${esc(p.unit)}</strong><small>${p.reorder ? `reorder at ${fmtQty(p.reorder)}` : "no reorder level set"}</small></div>
      <div class="kpi"><span>Average cost</span><strong>${money(avgOf(id))}</strong><small>last bought at ${money(p.cost)}</small></div>
      <div class="kpi"><span>Sale price</span><strong>${money(p.price)}</strong><small>${pct(p.price - avgOf(id), p.price)} margin</small></div>
      <div class="kpi"><span>Stock value</span><strong>${money(Math.max(0, q) * avgOf(id))}</strong><small>at average cost</small></div>
    </div>
    <div class="grid kpis">
      <div class="kpi"><span>Units sold (all time)</span><strong>${fmtQty(t.units)}</strong></div>
      <div class="kpi"><span>Sales (all time)</span><strong>${money(t.revenue)}</strong></div>
      <div class="kpi"><span>Cost of goods sold</span><strong>${money(t.cogs)}</strong></div>
      <div class="kpi"><span>Profit (all time)</span><strong class="${t.profit < 0 ? "neg" : ""}">${money(t.profit)}</strong><small>${pct(t.profit, t.revenue)} margin</small></div>
    </div>
    ${p.notes ? `<div class="card"><h3>Notes</h3><p style="white-space:pre-wrap;margin:0">${esc(p.notes)}</p></div>` : ""}
    <div class="card"><h3>Stock history</h3>
      ${moves.length ? historyTable(moves, false) : `<p class="muted">No stock changes yet. Record a purchase to add stock.</p>`}</div>
    <p><button class="btn danger small" id="del" type="button">Delete this product</button></p>`;
  $("#del").addEventListener("click", () => {
    const n = moves.length;
    if (!confirm(`Delete "${p.name}"${n ? ` and its ${n} stock record${n === 1 ? "" : "s"}` : ""}?${t.units ? " Its sales and profit will disappear from your reports." : ""} This can't be undone.`)) return;
    db.products = db.products.filter((x) => x.id !== id);
    db.moves = db.moves.filter((m) => m.productId !== id);
    db.settings.notified = db.settings.notified.filter((x) => x !== id);
    save(); updateLowBadge(); toast("Product deleted"); location.hash = "#products";
  });
}

function viewProductForm(id) {
  const p = id ? prod(id) : null;
  if (id && !p) return notFound("product", "#products");
  if (!p && !canAddProduct()) {
    main.innerHTML = `<a class="back" href="#products">← Products</a>
      <div class="card"><h2>You've reached ${FREE.products} products</h2>
      <p>The free plan holds up to ${FREE.products} products. Unlock Pro with your AppSumo code for unlimited products, profit reports and CSV export.</p>
      <a class="btn primary" href="#pro">⭐ Unlock Pro</a></div>`;
    return;
  }
  const cats = [...new Set(db.products.map((x) => x.category).filter(Boolean))].sort();
  const v = p || { name: "", sku: "", category: "", unit: "pcs", cost: "", price: "", reorder: 5, notes: "" };
  main.innerHTML = `
    <a class="back" href="${p ? "#product/" + p.id : "#products"}">← ${p ? esc(p.name) : "Products"}</a>
    <h2>${p ? "Edit product" : "Add a product"}</h2>
    <form class="card" id="pform" novalidate>
      <label>Product name<input name="name" required maxlength="120" value="${esc(v.name)}" placeholder="e.g. Ceramic mug, speckled"></label>
      <div class="grid three">
        <label>SKU <span class="hint">(your product code, optional)</span><input name="sku" maxlength="60" value="${esc(v.sku)}" autocomplete="off"></label>
        <label>Category <span class="hint">(optional)</span><input name="category" list="catList" maxlength="60" value="${esc(v.category)}" autocomplete="off"></label>
        <label>Unit<input name="unit" list="unitList" maxlength="20" value="${esc(v.unit)}" placeholder="pcs"></label>
      </div>
      <datalist id="catList">${cats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
      <datalist id="unitList">${["pcs", "pack", "box", "pair", "set", "kg", "g", "litre", "ml", "m", "jar", "bottle", "dozen"].map((u) => `<option value="${u}">`).join("")}</datalist>
      <div class="grid three">
        <label>Cost price <span class="hint">(what you pay per unit)</span><input name="cost" type="number" inputmode="decimal" min="0" step="any" value="${v.cost}"></label>
        <label>Sale price <span class="hint">(what customers pay)</span><input name="price" type="number" inputmode="decimal" min="0" step="any" value="${v.price}"></label>
        <label>Reorder level <span class="hint">(warn me at or below)</span><input name="reorder" type="number" inputmode="decimal" min="0" step="any" value="${v.reorder}"></label>
      </div>
      ${p ? `<p class="muted small">In stock: <b>${fmtQty(qtyOf(p.id))} ${esc(p.unit)}</b>. To change the quantity, record a purchase or sale, or <a href="#adjust/${p.id}">adjust the stock</a>.</p>`
        : `<label>Units in stock now <span class="hint">(opening stock, valued at the cost price)</span><input name="opening" type="number" inputmode="decimal" min="0" step="any" value="0"></label>`}
      <p class="muted small" id="margin"></p>
      <label>Notes <span class="hint">(optional: supplier, size, location on the shelf…)</span><textarea name="notes" maxlength="1000">${esc(v.notes)}</textarea></label>
      <div id="ferr"></div>
      <div class="actions"><button class="btn primary">${p ? "Save changes" : "Add product"}</button><a class="btn" href="${p ? "#product/" + p.id : "#products"}">Cancel</a></div>
    </form>`;
  const form = $("#pform");
  const showMargin = () => {
    const c = num(form.cost.value), pr = num(form.price.value);
    $("#margin").textContent = c >= 0 && pr > 0 ? `Profit per unit: ${money(pr - c)} (${pct(pr - c, pr)} margin)` : "";
  };
  form.addEventListener("input", showMargin);
  showMargin();
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const errs = [];
    const name = f.name.trim(), sku = f.sku.trim();
    const cost = f.cost === "" ? 0 : num(f.cost), price = f.price === "" ? 0 : num(f.price), reorder = f.reorder === "" ? 0 : num(f.reorder);
    const opening = p ? 0 : f.opening === "" ? 0 : num(f.opening);
    if (!name) errs.push("Enter a product name.");
    if (sku && db.products.some((x) => x !== p && x.sku.toLowerCase() === sku.toLowerCase())) errs.push(`Another product already uses the SKU "${sku}".`);
    if (!(cost >= 0)) errs.push("Cost price must be 0 or more.");
    if (!(price >= 0)) errs.push("Sale price must be 0 or more.");
    if (!(reorder >= 0)) errs.push("Reorder level must be 0 or more.");
    if (!(opening >= 0)) errs.push("Units in stock must be 0 or more.");
    $$("input", form).forEach((i) => i.removeAttribute("aria-invalid"));
    if (errs.length) { $("#ferr").innerHTML = `<div class="msg error">${errs.map(esc).join("<br>")}</div>`; return; }
    const fields = { name, sku, category: f.category.trim(), unit: f.unit.trim(), cost, price, reorder, notes: f.notes.trim() };
    let pid;
    if (p) { Object.assign(p, fields); pid = p.id; }
    else {
      pid = uid();
      db.products.push({ id: pid, ...fields, created: Date.now() });
      if (opening > 0) db.moves.push({ id: uid(), productId: pid, type: "opening", qty: opening, unitCost: cost, unitPrice: 0, party: "", note: "", ref: "", date: today(), created: Date.now() });
    }
    if (!save()) return;
    checkLowAlerts();
    toast(p ? "Product saved" : DEMO ? "Product added (demo: not saved)" : "Product added");
    location.hash = "#product/" + pid;
  });
  form.name.focus();
}

// ---------- Record a sale or purchase (several items at once) ----------
function viewTrade(kind, pid) {
  const isSale = kind === "sale";
  const back = isSale ? "#sales" : "#purchases";
  if (!db.products.length) {
    main.innerHTML = `<a class="back" href="${back}">← Back</a><div class="card">${emptyState("Add a product first, then you can record " + (isSale ? "sales." : "purchases."), '<a class="btn primary" href="#product-new">+ Add product</a>')}</div>`;
    return;
  }
  const products = [...db.products].sort((a, b) => a.name.localeCompare(b.name));
  const dflt = (p) => (p ? (isSale ? p.price : p.cost) : "");
  const first = prod(pid) || (products.length === 1 ? products[0] : null);
  const lines = [{ pid: first?.id || "", qty: "1", price: String(dflt(first)) }];
  const sample = SAMPLE && isSale && !pid;
  if (sample) lines.splice(0, 1, ...[["p0", 2], ["p3", 1], ["p13", 1]].map(([id, q]) => ({ pid: id, qty: String(q), price: String(prod(id).price) })));
  const parties = [...new Set(db.moves.filter((m) => m.type === kind && m.party).map((m) => m.party))].sort((a, b) => a.localeCompare(b));
  main.innerHTML = `
    <a class="back" href="${back}">← ${isSale ? "Sales" : "Purchases"}</a>
    <h2>${isSale ? "🧾 Record a sale" : "🚚 Record a purchase"}</h2>
    <p class="muted">${isSale ? "Stock goes down and profit is worked out from your average cost." : "Stock goes up, and the cost is used for your average cost and profit."}</p>
    <form class="card" id="tform" novalidate>
      <div class="grid two">
        <label>Date<input type="date" name="date" value="${today()}" required></label>
        <label>${isSale ? "Customer" : "Supplier"} <span class="hint">(optional)</span><input name="party" list="partyList" maxlength="120" autocomplete="off" value="${sample ? "Green Leaf Café" : ""}" placeholder="${isSale ? "Walk-in customer" : "e.g. Northwind Supplies"}"></label>
      </div>
      <datalist id="partyList">${parties.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
      <h3>Items</h3>
      <div class="lines" id="lines"></div>
      <button type="button" class="btn small" id="addLine">+ Add another item</button>
      <div class="summary" id="sum"></div>
      <label>Note <span class="hint">(optional, e.g. order or invoice number)</span><input name="note" maxlength="300"></label>
      <div id="ferr"></div>
      <div class="actions"><button class="btn primary">Save ${isSale ? "sale" : "purchase"}</button><a class="btn" href="${back}">Cancel</a></div>
    </form>`;
  const box = $("#lines");
  const opts = (sel) => `<option value="">Choose a product…</option>` + products.map((p) =>
    `<option value="${p.id}" ${p.id === sel ? "selected" : ""}>${esc(p.name)}${p.sku ? " · " + esc(p.sku) : ""} (${fmtQty(qtyOf(p.id))} in stock)</option>`).join("");
  const drawLines = () => {
    box.innerHTML = lines.map((l, i) => `<div class="line" data-i="${i}">
      <label class="pick">Product<select data-f="pid">${opts(l.pid)}</select></label>
      <label>Qty<input data-f="qty" type="number" inputmode="decimal" min="0" step="any" value="${esc(l.qty)}"></label>
      <label>${isSale ? "Price each" : "Cost each"}<input data-f="price" type="number" inputmode="decimal" min="0" step="any" value="${esc(l.price)}"></label>
      <div class="total" data-total></div>
      <button type="button" class="icon-btn" data-rm aria-label="Remove this item" title="Remove" ${lines.length === 1 ? "hidden" : ""}>✕</button>
    </div>`).join("");
    drawTotals();
  };
  const drawTotals = () => {
    let total = 0, cost = 0;
    lines.forEach((l, i) => {
      const q = num(l.qty), pr = num(l.price);
      const lt = q > 0 && pr >= 0 ? q * pr : 0;
      total += lt;
      if (l.pid && q > 0) cost += q * avgOf(l.pid);
      const el = $(`.line[data-i="${i}"] [data-total]`, box);
      if (el) el.textContent = money(lt);
    });
    $("#sum").innerHTML = isSale
      ? `<span>Total <b>${money(total)}</b></span><span>Estimated profit <b class="${total - cost < 0 ? "neg" : ""}">${money(total - cost)}</b></span>`
      : `<span>Total cost <b>${money(total)}</b></span>`;
  };
  box.addEventListener("input", (e) => {
    const f = e.target.dataset.f;
    if (!f) return;
    const i = +e.target.closest(".line").dataset.i;
    lines[i][f] = e.target.value;
    if (f === "pid") {
      lines[i].price = String(dflt(prod(e.target.value)));
      $(`.line[data-i="${i}"] [data-f="price"]`, box).value = lines[i].price;
    }
    drawTotals();
  });
  box.addEventListener("click", (e) => {
    if (!e.target.closest("[data-rm]")) return;
    lines.splice(+e.target.closest(".line").dataset.i, 1);
    drawLines();
  });
  $("#addLine").addEventListener("click", () => {
    lines.push({ pid: "", qty: "1", price: "" });
    drawLines();
    $(`.line[data-i="${lines.length - 1}"] select`, box).focus();
  });
  drawLines();

  $("#tform").addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.target;
    const date = form.date.value, party = form.party.value.trim(), note = form.note.value.trim();
    const errs = [];
    if (!isDate(date)) errs.push("Choose a date.");
    const used = lines.filter((l) => l.pid || num(l.qty) > 0);
    if (!used.length) errs.push("Add at least one item.");
    used.forEach((l, i) => {
      const n = `Item ${i + 1}`;
      if (!prod(l.pid)) errs.push(`${n}: choose a product.`);
      if (!(num(l.qty) > 0)) errs.push(`${n}: quantity must be more than 0.`);
      if (!(num(l.price) >= 0)) errs.push(`${n}: enter the ${isSale ? "price" : "cost"} (0 or more).`);
    });
    if (isSale && !errs.length) {
      const need = new Map();
      used.forEach((l) => need.set(l.pid, (need.get(l.pid) || 0) + num(l.qty)));
      for (const [id, q] of need) {
        if (q > qtyOf(id)) errs.push(`Only ${fmtQty(Math.max(0, qtyOf(id)))} of "${prod(id).name}" in stock. Record a purchase or adjust the stock first.`);
      }
    }
    if (errs.length) { $("#ferr").innerHTML = `<div class="msg error">${errs.map(esc).join("<br>")}</div>`; return; }
    const ref = uid();
    const now = Date.now();
    used.forEach((l, i) => {
      const q = num(l.qty), pr = num(l.price);
      db.moves.push({ id: uid() + i, productId: l.pid, type: kind, qty: q, unitCost: isSale ? 0 : pr, unitPrice: isSale ? pr : 0, party, note, ref, date, created: now + i });
      if (!isSale) prod(l.pid).cost = pr; // remember the latest cost price
    });
    if (!save()) return;
    checkLowAlerts();
    toast(`${isSale ? "Sale" : "Purchase"} saved${DEMO ? " (demo: not kept)" : ""}`);
    location.hash = back;
  });
}

// ---------- Adjust stock (count corrections, damage, returns) ----------
function viewAdjust(id) {
  const p = prod(id);
  if (!p) return notFound("product", "#products");
  const q = qtyOf(id);
  main.innerHTML = `
    <a class="back" href="#product/${id}">← ${esc(p.name)}</a>
    <h2>Adjust stock: ${esc(p.name)}</h2>
    <form class="card" id="aform" novalidate>
      <p>In stock now: <b>${fmtQty(q)} ${esc(p.unit)}</b></p>
      <fieldset style="border:0;padding:0;margin:0 0 12px">
        <legend class="sr-only">How to adjust</legend>
        <label class="check"><input type="radio" name="mode" value="set" checked> I counted the stock: set the quantity</label>
        <label class="check"><input type="radio" name="mode" value="change"> Add or remove a number of units</label>
      </fieldset>
      <div class="grid two">
        <label id="qLabel">Counted quantity<input name="qty" type="number" inputmode="decimal" step="any" value="${Math.max(0, q)}"></label>
        <label>Reason<select name="reason">${["Stock count", "Damaged or broken", "Lost or stolen", "Returned by customer", "Used in the business", "Gift or sample", "Other"].map((r) => `<option>${r}</option>`).join("")}</select></label>
      </div>
      <label>Date<input type="date" name="date" value="${today()}"></label>
      <label>Note <span class="hint">(optional)</span><input name="note" maxlength="300"></label>
      <p class="muted small" id="preview"></p>
      <div id="ferr"></div>
      <div class="actions"><button class="btn primary">Save adjustment</button><a class="btn" href="#product/${id}">Cancel</a></div>
    </form>
    <p class="muted small">Adjustments don't count as sales, so they don't change your profit. Stock removed here is valued at the average cost.</p>`;
  const form = $("#aform");
  const change = () => {
    const v = num(form.qty.value);
    return form.mode.value === "set" ? v - q : v;
  };
  const preview = () => {
    $("#qLabel").firstChild.textContent = form.mode.value === "set" ? "Counted quantity" : "Units to add (use a minus sign to remove, e.g. -2)";
    const c = change();
    $("#preview").textContent = Number.isFinite(c) ? `Change: ${c > 0 ? "+" : ""}${fmtQty(c)} → new stock ${fmtQty(q + c)} ${p.unit}` : "";
  };
  form.addEventListener("input", preview);
  preview();
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const c = change();
    const errs = [];
    if (!Number.isFinite(c) || c === 0) errs.push("Enter a quantity that changes the stock.");
    else if (q + c < 0) errs.push("Stock can't go below 0.");
    if (!isDate(form.date.value)) errs.push("Choose a date.");
    if (errs.length) { $("#ferr").innerHTML = `<div class="msg error">${errs.join("<br>")}</div>`; return; }
    const note = [form.reason.value, form.note.value.trim()].filter(Boolean).join(": ");
    db.moves.push({ id: uid(), productId: id, type: "adjust", qty: c, unitCost: 0, unitPrice: 0, party: "", note, ref: "", date: form.date.value, created: Date.now() });
    if (!save()) return;
    checkLowAlerts();
    toast("Stock adjusted");
    location.hash = "#product/" + id;
  });
}

// ---------- Edit or delete one stock record ----------
function viewMove(id) {
  const m = db.moves.find((x) => x.id === id);
  if (!m) return notFound("record", "#history");
  const p = prod(m.productId);
  const isSale = m.type === "sale", isAdj = m.type === "adjust";
  const back = isSale ? "#sales" : m.type === "purchase" ? "#purchases" : "#history";
  main.innerHTML = `
    <a class="back" href="${back}">← Back</a>
    <h2>Edit ${TYPE_LABEL[m.type].toLowerCase()}: ${esc(p.name)}</h2>
    <form class="card" id="mform" novalidate>
      <div class="grid two">
        <label>Date<input type="date" name="date" value="${m.date}"></label>
        <label>${isAdj ? "Change in units <span class=\"hint\">(minus to remove)</span>" : "Quantity"}<input name="qty" type="number" inputmode="decimal" step="any" value="${m.qty}"></label>
        ${isAdj ? "" : `<label>${isSale ? "Price each" : "Cost each"}<input name="price" type="number" inputmode="decimal" min="0" step="any" value="${isSale ? m.unitPrice : m.unitCost}"></label>`}
        ${isAdj || m.type === "opening" ? "" : `<label>${isSale ? "Customer" : "Supplier"}<input name="party" maxlength="120" value="${esc(m.party)}"></label>`}
      </div>
      <label>Note<input name="note" maxlength="300" value="${esc(m.note)}"></label>
      <div id="ferr"></div>
      <div class="actions"><button class="btn primary">Save changes</button><a class="btn" href="${back}">Cancel</a>
        <button type="button" class="btn danger" id="delMove">Delete</button></div>
    </form>`;
  const form = $("#mform");
  const backup = { ...m };
  // Rejects a change that would push stock below zero at any point after it.
  const stockOk = () => { calc(); let ok = true; let q = 0; for (const x of S.sorted) if (x.productId === m.productId) { q = S.info.get(x.id).after; if (q < -1e-9) ok = false; } return ok; };
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const qty = num(form.qty.value), price = isAdj ? 0 : num(form.price.value);
    const errs = [];
    if (!isDate(form.date.value)) errs.push("Choose a date.");
    if (isAdj ? !(qty !== 0 && Number.isFinite(qty)) : !(qty > 0)) errs.push(isAdj ? "Enter a change other than 0." : "Quantity must be more than 0.");
    if (!isAdj && !(price >= 0)) errs.push("Enter a price of 0 or more.");
    if (!errs.length) {
      Object.assign(m, { date: form.date.value, qty, note: form.note.value.trim() });
      if (form.party) m.party = form.party.value.trim();
      if (isSale) m.unitPrice = price; else if (!isAdj) m.unitCost = price;
      if (!stockOk()) { Object.assign(m, backup); calc(); errs.push(`This would make the stock of "${p.name}" go below 0.`); }
    }
    if (errs.length) { $("#ferr").innerHTML = `<div class="msg error">${errs.map(esc).join("<br>")}</div>`; return; }
    if (!save()) return;
    checkLowAlerts();
    toast("Saved");
    location.hash = back;
  });
  $("#delMove").addEventListener("click", () => {
    if (!confirm(`Delete this ${TYPE_LABEL[m.type].toLowerCase()} of ${fmtQty(m.qty)} × ${p.name}? Stock ${isSale ? "goes back up" : "changes back"}. This can't be undone.`)) return;
    db.moves = db.moves.filter((x) => x !== m);
    if (!stockOk() && !confirm(`Without this record, the stock of "${p.name}" goes below 0 at some point. Delete it anyway?`)) { db.moves.push(m); calc(); return; }
    save(); checkLowAlerts(); toast("Deleted"); location.hash = back;
  });
}

// ---------- Sales & purchases lists ----------
function viewSales() {
  const r = range();
  const sales = movesIn("sale", r).reverse();
  const t = totals(sales);
  main.innerHTML = `
    <div class="head"><h2>🧾 Sales</h2><a class="btn primary" href="#sell">+ Record sale</a></div>
    ${rangePicker()}
    <div class="grid kpis">
      <div class="kpi"><span>Sales</span><strong>${money(t.revenue)}</strong><small>${t.orders.size} order${t.orders.size === 1 ? "" : "s"}</small></div>
      <div class="kpi"><span>Cost of goods sold</span><strong>${money(t.cogs)}</strong></div>
      <div class="kpi"><span>Gross profit</span><strong class="${t.profit < 0 ? "neg" : ""}">${money(t.profit)}</strong><small>${pct(t.profit, t.revenue)} margin</small></div>
      <div class="kpi"><span>Units sold</span><strong>${fmtQty(t.units)}</strong></div>
    </div>
    <div class="card">${sales.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Product</th><th class="num">Qty</th><th class="num hide-sm">Price</th><th class="num">Sale</th><th class="num hide-sm">Cost (COGS)</th><th class="num">Profit</th><th><span class="sr-only">Edit</span></th></tr></thead>
      <tbody>${sales.map((m) => { const i = S.info.get(m.id); const p = prod(m.productId); return `<tr>
        <td>${shortDate(m.date)}</td>
        <td><a class="name" href="#product/${p.id}">${esc(p.name)}</a><span class="sub">${esc(m.party || "No customer name")}${m.note ? " · " + esc(m.note) : ""}</span></td>
        <td class="num">${fmtQty(m.qty)}</td><td class="num hide-sm">${money(m.unitPrice)}</td><td class="num">${money(i.revenue)}</td>
        <td class="num hide-sm">${money(i.cogs)}</td><td class="num ${i.profit < 0 ? "neg" : ""}">${money(i.profit)}</td>
        <td><a class="icon-btn" href="#move/${m.id}" title="Edit or delete" aria-label="Edit sale">✎</a></td></tr>`; }).join("")}</tbody>
      <tfoot><tr><td colspan="2">Total</td><td class="num">${fmtQty(t.units)}</td><td class="hide-sm"></td><td class="num">${money(t.revenue)}</td><td class="num hide-sm">${money(t.cogs)}</td><td class="num">${money(t.profit)}</td><td></td></tr></tfoot>
    </table></div>` : emptyState(`No sales between ${esc(rangeLabel(r))}.`, '<a class="btn primary" href="#sell">+ Record a sale</a>')}</div>`;
  wireRange(viewSales);
}

function viewPurchases() {
  const r = range();
  const list = movesIn("purchase", r).reverse();
  const total = list.reduce((a, m) => a + S.info.get(m.id).total, 0);
  const sups = new Set(list.map((m) => m.party).filter(Boolean));
  main.innerHTML = `
    <div class="head"><h2>🚚 Purchases</h2><a class="btn primary" href="#buy">+ Record purchase</a></div>
    ${rangePicker()}
    <div class="grid kpis">
      <div class="kpi"><span>Spent on stock</span><strong>${money(total)}</strong></div>
      <div class="kpi"><span>Units bought</span><strong>${fmtQty(list.reduce((a, m) => a + m.qty, 0))}</strong></div>
      <div class="kpi"><span>Deliveries</span><strong>${new Set(list.map((m) => m.ref || m.id)).size}</strong></div>
      <div class="kpi"><span>Suppliers</span><strong>${sups.size}</strong></div>
    </div>
    <div class="card">${list.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Product</th><th class="num">Qty</th><th class="num">Cost each</th><th class="num">Total</th><th><span class="sr-only">Edit</span></th></tr></thead>
      <tbody>${list.map((m) => { const p = prod(m.productId); return `<tr>
        <td>${shortDate(m.date)}</td>
        <td><a class="name" href="#product/${p.id}">${esc(p.name)}</a><span class="sub">${esc(m.party || "No supplier name")}${m.note ? " · " + esc(m.note) : ""}</span></td>
        <td class="num">${fmtQty(m.qty)}</td><td class="num">${money(m.unitCost)}</td><td class="num">${money(m.qty * m.unitCost)}</td>
        <td><a class="icon-btn" href="#move/${m.id}" title="Edit or delete" aria-label="Edit purchase">✎</a></td></tr>`; }).join("")}</tbody>
      <tfoot><tr><td colspan="4">Total</td><td class="num">${money(total)}</td><td></td></tr></tfoot>
    </table></div>` : emptyState(`No purchases between ${esc(rangeLabel(r))}.`, '<a class="btn primary" href="#buy">+ Record a purchase</a>')}</div>`;
  wireRange(viewPurchases);
}

// ---------- Stock history (every change) ----------
function historyTable(moves, showProduct) {
  return `<div class="table-wrap"><table>
    <thead><tr><th>Date</th>${showProduct ? "<th>Product</th>" : ""}<th>Type</th><th class="num">Change</th><th class="num">Stock after</th><th class="hide-sm">Details</th><th><span class="sr-only">Edit</span></th></tr></thead>
    <tbody>${moves.map((m) => {
      const i = S.info.get(m.id); const p = prod(m.productId);
      const ch = m.type === "sale" ? -m.qty : m.qty;
      const detail = m.type === "sale" ? `${fmtQty(m.qty)} × ${money(m.unitPrice)} · profit ${money(i.profit)}`
        : m.type === "adjust" ? "" : `${fmtQty(m.qty)} × ${money(m.unitCost)}`;
      return `<tr><td>${shortDate(m.date)}</td>
        ${showProduct ? `<td><a class="name" href="#product/${p.id}">${esc(p.name)}</a></td>` : ""}
        <td>${typePill(m)}</td>
        <td class="num ${ch < 0 ? "neg" : ""}">${ch > 0 ? "+" : ""}${fmtQty(ch)}</td>
        <td class="num">${fmtQty(i.after)}</td>
        <td class="hide-sm small">${[detail, esc(m.party), esc(m.note)].filter(Boolean).join(" · ")}</td>
        <td><a class="icon-btn" href="#move/${m.id}" title="Edit or delete" aria-label="Edit this record">✎</a></td></tr>`;
    }).join("")}</tbody></table></div>`;
}
function viewHistory() {
  const products = [...db.products].sort((a, b) => a.name.localeCompare(b.name));
  if (ui.histProduct && !prod(ui.histProduct)) ui.histProduct = "";
  const all = S.sorted.filter((m) => (!ui.histProduct || m.productId === ui.histProduct) && (!ui.histType || m.type === ui.histType)).reverse();
  const shown = all.slice(0, ui.histLimit);
  main.innerHTML = `
    <div class="head"><h2>🕘 Stock history</h2>${hasPro() ? '<button class="btn" id="csvHist" type="button">⬇️ Export CSV</button>' : ""}</div>
    <p class="muted">Every change to your stock: opening stock, purchases, sales and adjustments.</p>
    <div class="card">
      <div class="filters">
        <label>Product<select id="hp"><option value="">All products</option>${products.map((p) => `<option value="${p.id}" ${p.id === ui.histProduct ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
        <label>Type<select id="ht"><option value="">All types</option>${MOVE_TYPES.map((t) => `<option value="${t}" ${t === ui.histType ? "selected" : ""}>${TYPE_LABEL[t]}</option>`).join("")}</select></label>
      </div>
      ${shown.length ? historyTable(shown, true) : emptyState("No stock changes to show.")}
      ${all.length > shown.length ? `<p class="row spread"><span class="muted small">Showing ${shown.length} of ${all.length}</span><button class="btn small" id="more" type="button">Show more</button></p>` : ""}
    </div>`;
  $("#hp").addEventListener("change", (e) => { ui.histProduct = e.target.value; ui.histLimit = 100; viewHistory(); });
  $("#ht").addEventListener("change", (e) => { ui.histType = e.target.value; ui.histLimit = 100; viewHistory(); });
  $("#more")?.addEventListener("click", () => { ui.histLimit += 200; viewHistory(); });
  $("#csvHist")?.addEventListener("click", () => exportCsv("history"));
}

// ---------- Reports (Pro) ----------
function viewReports() {
  const r = range();
  const sales = movesIn("sale", r);
  const t = totals(sales);
  const byProduct = groupSales(sales, (m) => m.productId);
  const byCat = groupSales(sales, (m) => prod(m.productId)?.category || "Uncategorised");
  const byCust = groupSales(sales, (m) => m.party || "No customer name").slice(0, 10);
  const spent = movesIn("purchase", r).reduce((a, m) => a + S.info.get(m.id).total, 0);
  const adjLoss = movesIn("adjust", r).reduce((a, m) => a + Math.min(0, S.info.get(m.id).value), 0);
  const table = (rows, label, link) => rows.length ? `<div class="table-wrap"><table>
    <thead><tr><th>${label}</th><th class="num">Units</th><th class="num">Sales</th><th class="num hide-sm">COGS</th><th class="num">Profit</th><th class="num">Margin</th></tr></thead>
    <tbody>${rows.map((x) => `<tr><td>${link ? `<a class="name" href="#product/${x.key}">${esc(prod(x.key)?.name)}</a>` : esc(x.key)}</td>
      <td class="num">${fmtQty(x.units)}</td><td class="num">${money(x.revenue)}</td><td class="num hide-sm">${money(x.cogs)}</td>
      <td class="num ${x.profit < 0 ? "neg" : ""}">${money(x.profit)}</td><td class="num">${pct(x.profit, x.revenue)}</td></tr>`).join("")}</tbody>
    <tfoot><tr><td>Total</td><td class="num">${fmtQty(t.units)}</td><td class="num">${money(t.revenue)}</td><td class="num hide-sm">${money(t.cogs)}</td><td class="num">${money(t.profit)}</td><td class="num">${pct(t.profit, t.revenue)}</td></tr></tfoot>
  </table></div>` : `<p class="muted">No sales in this period.</p>`;
  const body = `
    <div class="grid kpis">
      <div class="kpi"><span>Sales</span><strong>${money(t.revenue)}</strong><small>${t.orders.size} order${t.orders.size === 1 ? "" : "s"}</small></div>
      <div class="kpi"><span>Cost of goods sold</span><strong>${money(t.cogs)}</strong></div>
      <div class="kpi"><span>Gross profit</span><strong class="${t.profit < 0 ? "neg" : ""}">${money(t.profit)}</strong><small>${pct(t.profit, t.revenue)} margin</small></div>
      <div class="kpi"><span>Stock written off</span><strong>${money(-adjLoss)}</strong><small>damage, loss, counts</small></div>
    </div>
    <div class="card"><div class="row spread"><h3>Profit by product</h3>${hasPro() ? '<button class="btn small" id="csvRep" type="button">⬇️ Export CSV</button>' : ""}</div>${table(byProduct, "Product", true)}</div>
    <div class="grid two">
      <div class="card"><h3>Profit by category</h3>${table(byCat, "Category", false)}</div>
      <div class="card"><h3>Top customers</h3>${table(byCust, "Customer", false)}</div>
    </div>
    <p class="muted small">Spent on stock in this period: <b>${money(spent)}</b>. Profit uses the cost of goods sold: each sale is costed at the product's weighted average purchase cost on the day it was sold.</p>`;
  main.innerHTML = `
    <div class="head"><h2>📈 Profit reports</h2></div>
    ${rangePicker()}
    <p class="muted">${esc(rangeLabel(r))}</p>
    ${hasPro() ? body : `<div class="locked"><div class="blur" aria-hidden="true">${body}</div>
      <div class="over"><div class="card"><h3>⭐ Profit reports are part of Pro</h3>
        <p>See profit and margin by product, category and customer for any dates, and export it all to CSV for your accountant.</p>
        <a class="btn primary" href="#pro">Unlock Pro with your AppSumo code</a></div></div></div>`}`;
  wireRange(viewReports);
  $("#csvRep")?.addEventListener("click", () => exportCsv("report"));
  if (!hasPro()) $$(".locked .blur a, .locked .blur button").forEach((el) => el.setAttribute("tabindex", "-1"));
}

// ---------- Pro ----------
const PRO_FEATURES = `<ul>
  <li><strong>Unlimited products</strong> (the free plan holds ${FREE.products})</li>
  <li><strong>Profit reports</strong> by product, category and customer, for any date range</li>
  <li><strong>CSV export</strong> of products, sales, purchases, stock history and reports, for Excel, Google Sheets or your accountant</li>
  <li>Every future update, with one lifetime code</li></ul>`;
function viewPro() {
  if (proActive) {
    main.innerHTML = `<h2>⭐ Pro</h2><div class="card">
      <p>✅ <strong>Pro is unlocked</strong> on this device.</p>${PRO_FEATURES}
      <p class="muted small">Your code is saved only on this device. To use Pro on another device, enter the same code there.</p>
      <button class="btn danger small" id="rmPro" type="button">Remove the code from this device</button></div>`;
    $("#rmPro").addEventListener("click", () => {
      if (!confirm("Remove your Pro code from this device? Keep a copy of it so you can enter it again.")) return;
      store.set(K.pro, ""); proActive = false; toast("Pro code removed"); route();
    });
    return;
  }
  main.innerHTML = `<h2>⭐ Unlock Pro</h2><div class="card">
    <p>${DEMO ? "Demo mode shows every Pro feature. " : ""}Products, stock, purchases, sales, low-stock alerts and the dashboard are free. Pro adds:</p>${PRO_FEATURES}
    <h3>Enter your AppSumo code</h3>
    <form id="proForm" class="row" novalidate>
      <label style="flex:1 1 240px;margin:0"><span class="sr-only">Pro code</span><input name="code" placeholder="EIV-XXXX-XXXX-XXXX" autocomplete="off" autocapitalize="characters" spellcheck="false"></label>
      <button class="btn primary">Unlock Pro</button>
    </form>
    <div id="proMsg" style="margin-top:12px"></div>
    <p class="muted small">Your code is checked on this device. Nothing is sent anywhere.</p></div>`;
  $("#proForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = e.target.code.value.trim();
    if (DEMO) { $("#proMsg").innerHTML = '<div class="msg warn">Leave demo mode (in Settings) to enter your code.</div>'; return; }
    if (await codeIsValid(code)) {
      store.set(K.pro, normalizeCode(code)); proActive = true;
      toast("Pro is unlocked. Thank you! ⭐"); route();
    } else {
      $("#proMsg").innerHTML = '<div class="msg error">That code isn\'t valid. Check it and try again: it looks like EIV-XXXX-XXXX-XXXX.</div>';
    }
  });
}

// ---------- Settings ----------
function viewSettings() {
  const notifSupported = "Notification" in window;
  const perm = notifSupported ? Notification.permission : "unsupported";
  main.innerHTML = `
    <h2>⚙️ Settings</h2>
    ${DEMO ? `<div class="card"><h3>Demo mode</h3><p>You're exploring a sample gift shop with every Pro feature on. Nothing you change is saved.</p>
      <a class="btn primary" href="${esc(location.pathname)}">Leave demo mode and use my own shop</a></div>` : ""}
    <form class="card" id="shopForm">
      <h3>Your business</h3>
      <div class="grid two">
        <label>Business name<input name="shop" maxlength="120" value="${esc(db.settings.shop)}" required></label>
        <label>Currency<select name="currency">${currencyOptions(db.settings.currency)}</select></label>
      </div>
      <button class="btn">Save</button>
    </form>
    <div class="card">
      <h3>🔔 Low-stock alerts</h3>
      <p class="muted small">Set a reorder level on each product. When stock falls to that level, the product shows as Low and is counted on the Products tab.
        You can also get a browser notification, once per product each time it runs low.</p>
      ${!notifSupported ? `<p>This browser doesn't support notifications. The Low badges still work.</p>`
        : perm === "denied" ? `<p class="msg warn">Notifications are blocked for this site. Allow them in your browser's site settings, then come back here.</p>`
        : db.settings.notify && perm === "granted"
          ? `<p>✅ Browser notifications are on.</p><div class="actions"><button class="btn" id="testNote" type="button">Send a test notification</button><button class="btn danger" id="notifyOff" type="button">Turn off</button></div>`
          : `<button class="btn primary" id="notifyOn" type="button">Turn on browser notifications</button>`}
    </div>
    <div class="card">
      <h3>Backup &amp; restore</h3>
      <p class="muted small">Your data is stored only in this browser on this device. Download a backup now and then, and use it to move to another device.</p>
      <div class="actions">
        <button class="btn" id="backup" type="button" ${DEMO ? "disabled" : ""}>⬇️ Download backup (.json)</button>
        <label class="btn" style="margin:0" ${DEMO ? 'aria-disabled="true"' : ""}>⬆️ Restore from file<input type="file" id="restore" accept="application/json,.json" hidden ${DEMO ? "disabled" : ""}></label>
      </div>
    </div>
    <div class="card">
      <h3>Export to CSV ${hasPro() ? "" : '<span class="pill">Pro</span>'}</h3>
      <p class="muted small">Open your data in Excel or Google Sheets, or send it to your accountant.</p>
      <div class="actions">
        ${[["products", "Products & stock"], ["sales", "Sales"], ["purchases", "Purchases"], ["history", "Stock history"]].map(([k, l]) =>
          `<button class="btn" type="button" data-csv="${k}" ${hasPro() ? "" : "disabled"}>⬇️ ${l}</button>`).join("")}
      </div>
      ${hasPro() ? "" : '<p class="small"><a href="#pro">Unlock Pro</a> to export CSV files.</p>'}
    </div>
    ${DEMO ? "" : `<div class="card"><h3>Delete data</h3>
      <p class="muted small">Removes every product, sale, purchase and setting from this device. Your Pro code is kept.</p>
      <button class="btn danger" id="wipe" type="button">Delete all my data from this device</button></div>`}
    <p class="muted small">Eksoch Inventory Manager · by Eksoch Analytics · <a href="privacy.html">Privacy policy</a></p>`;

  $("#shopForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const shop = String(f.get("shop")).trim();
    if (!shop) { toast("Enter your business name."); return; }
    db.settings.shop = shop; db.settings.currency = String(f.get("currency")); moneyFmt = null;
    if (save()) { updateChrome(); toast("Saved"); }
  });
  $("#notifyOn")?.addEventListener("click", async () => {
    let p = Notification.permission;
    if (p !== "granted") p = await Notification.requestPermission().catch(() => "denied");
    if (p === "granted") {
      db.settings.notify = true; db.settings.notified = []; save();
      toast("Notifications are on");
      checkLowAlerts();
    } else toast("Notifications weren't allowed.");
    viewSettings();
  });
  $("#notifyOff")?.addEventListener("click", () => { db.settings.notify = false; save(); toast("Notifications are off"); viewSettings(); });
  $("#testNote")?.addEventListener("click", () => {
    const low = lowItems();
    showNotification("Eksoch Inventory Manager", low.length ? `${low.length} product${low.length === 1 ? " is" : "s are"} low on stock right now.` : "Notifications work. You'll hear from us when stock runs low.");
  });
  $("#backup").addEventListener("click", () => {
    download(`inventory-backup-${today()}.json`, JSON.stringify({ app: "eksoch-inventory-manager", exported: new Date().toISOString(), ...db }, null, 1), "application/json");
    toast("Backup downloaded");
  });
  $("#restore").addEventListener("change", restoreBackup);
  $$("[data-csv]").forEach((b) => b.addEventListener("click", () => exportCsv(b.dataset.csv)));
  $("#wipe")?.addEventListener("click", () => {
    if (!confirm("Delete every product, sale, purchase and setting from this device? Download a backup first if you might need them. This can't be undone.")) return;
    store.set(K.data, "");
    db = blank(); calc(); moneyFmt = null;
    toast("All data deleted");
    location.hash = "";
    route();
  });
}

async function restoreBackup(e) {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file || DEMO) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.app !== "eksoch-inventory-manager" || !Array.isArray(data.products)) throw new Error("not a backup");
    const clean = normalize(data);
    if (!confirm(`Replace what's on this device with this backup (${clean.products.length} products, ${clean.moves.length} stock records${clean.settings.shop ? `, "${clean.settings.shop}"` : ""})?`)) return;
    db = clean; moneyFmt = null;
    if (!db.settings.shop) db.settings.shop = "My shop";
    save();
    toast("Backup restored ✅");
    location.hash = "#dashboard";
    route();
  } catch { toast("That file isn't an Inventory Manager backup."); }
}

function exportCsv(kind) {
  if (!hasPro()) { toast("CSV export is part of Pro."); location.hash = "#pro"; return; }
  const P = (id) => prod(id) || {};
  let rows, name;
  if (kind === "products") {
    name = "products";
    rows = [["Name", "SKU", "Category", "Unit", "In stock", "Reorder level", "Status", "Average cost", "Last cost price", "Sale price", "Stock value at cost", "Stock value at sale price", "Notes"],
      ...[...db.products].sort((a, b) => a.name.localeCompare(b.name)).map((p) => { const q = qtyOf(p.id); return [p.name, p.sku, p.category, p.unit, q, p.reorder,
        q <= 0 ? "Out of stock" : isLow(p) ? "Low" : "OK", round2(avgOf(p.id)), p.cost, p.price, Math.max(0, q) * avgOf(p.id), Math.max(0, q) * p.price, p.notes]; })];
  } else if (kind === "sales") {
    name = "sales";
    rows = [["Date", "Product", "SKU", "Category", "Customer", "Quantity", "Price each", "Sale total", "Cost of goods sold", "Profit", "Note", "Order ref"],
      ...S.sorted.filter((m) => m.type === "sale").map((m) => { const i = S.info.get(m.id), p = P(m.productId); return [m.date, p.name, p.sku, p.category, m.party, m.qty, m.unitPrice, i.revenue, i.cogs, i.profit, m.note, m.ref]; })];
  } else if (kind === "purchases") {
    name = "purchases";
    rows = [["Date", "Product", "SKU", "Category", "Supplier", "Quantity", "Cost each", "Total", "Note", "Delivery ref"],
      ...S.sorted.filter((m) => m.type === "purchase").map((m) => { const p = P(m.productId); return [m.date, p.name, p.sku, p.category, m.party, m.qty, m.unitCost, m.qty * m.unitCost, m.note, m.ref]; })];
  } else if (kind === "report") {
    const r = range();
    name = `profit-by-product-${r[0]}-to-${r[1]}`;
    rows = [["Product", "SKU", "Category", "Units sold", "Sales", "Cost of goods sold", "Profit", "Margin %"],
      ...groupSales(movesIn("sale", r), (m) => m.productId).map((x) => { const p = P(x.key); return [p.name, p.sku, p.category, x.units, x.revenue, x.cogs, x.profit, x.revenue ? round2((x.profit / x.revenue) * 100) : ""]; })];
  } else {
    name = "stock-history";
    rows = [["Date", "Product", "SKU", "Type", "Change", "Stock after", "Unit cost", "Unit price", "Sale total", "Cost of goods sold", "Profit", "Customer or supplier", "Note"],
      ...S.sorted.map((m) => { const i = S.info.get(m.id), p = P(m.productId); return [m.date, p.name, p.sku, TYPE_LABEL[m.type], m.type === "sale" ? -m.qty : m.qty, i.after,
        m.type === "sale" || m.type === "adjust" ? "" : m.unitCost, m.type === "sale" ? m.unitPrice : "", i.revenue ?? "", i.cogs ?? "", i.profit ?? "", m.party, m.note]; })];
  }
  download(`${name}-${today()}.csv`, csv(rows), "text/csv");
  toast("CSV downloaded");
}

// ===================================================================
// Demo shop (built fresh each time, relative to today, saved nowhere)
// ===================================================================
function demoData() {
  let seed = 20261124;
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const P = [
    ["Soy candle, lavender", "CND-LAV", "Candles", "pcs", 4.2, 14, 10, 6],
    ["Soy candle, sandalwood", "CND-SAN", "Candles", "pcs", 4.2, 14, 10, 5],
    ["Beeswax tea lights (12)", "CND-TEA", "Candles", "pack", 3.1, 9.5, 8, 4],
    ["Ceramic mug, speckled", "MUG-SPK", "Kitchen", "pcs", 5.5, 18, 8, 4],
    ["Hand-thrown bowl", "BWL-HTB", "Kitchen", "pcs", 8.75, 26, 5, 2],
    ["Linen tea towel", "TWL-LIN", "Kitchen", "pcs", 3.4, 12, 10, 3],
    ["Kraft notebook A5", "NTB-A5K", "Stationery", "pcs", 1.9, 7.5, 15, 8],
    ["Brass pen", "PEN-BRS", "Stationery", "pcs", 6, 22, 6, 2],
    ["Greeting card set (6)", "CRD-SET", "Stationery", "pack", 2.4, 9, 12, 5],
    ["Loose-leaf chai, 250 g", "TEA-CHI", "Pantry", "pack", 3.8, 11, 10, 5],
    ["Wildflower honey, 340 g", "HNY-WLD", "Pantry", "jar", 4.6, 13.5, 8, 3],
    ["Lavender bath salts", "BTH-LAV", "Bath", "jar", 3.2, 12, 8, 3],
    ["Olive oil soap bar", "SOP-OLV", "Bath", "pcs", 1.6, 6.5, 20, 7],
    ["Gift box, large", "GFT-LRG", "Packaging", "pcs", 1.2, 4, 15, 3],
  ];
  const SUP = { Candles: "Northwind Candle Co.", Kitchen: "Riverbend Pottery", Stationery: "Paper & Ink Wholesale", Pantry: "Valley Farm Foods", Bath: "Pure Botanicals", Packaging: "BoxCraft Supplies" };
  const CUST = ["Priya Shah", "Tom Becker", "Lena Ortiz", "Green Leaf Café", "Maple Street Dental", "Sam Okafor", "Ruth Klein", "Etsy order", "Instagram order", "Hannah Moore"];
  const keepLow = new Set(["PEN-BRS", "HNY-WLD", "CND-SAN"]);
  const D = 90, t0 = today(), base = Date.now() - 1e9;
  const day = (d) => addDays(t0, d - (D - 1));
  const products = P.map(([name, sku, category, unit, cost, price, reorder], i) => ({ id: "p" + i, name, sku, category, unit, cost, price, reorder, notes: "", created: base }));
  products[4].notes = "Each bowl is unique. Wrap in two layers of paper.";
  const weekly = P.map((r) => r[7]);
  const wSum = weekly.reduce((a, b) => a + b, 0);
  const moves = [];
  let seq = 0;
  const add = (o) => moves.push({ id: "m" + seq, created: base + seq++, note: "", ref: "", party: "", unitCost: 0, unitPrice: 0, ...o });
  const qty = products.map(() => 0);
  const due = products.map(() => 0); // day a restock arrives (0 = opening delivery)
  for (let d = 0; d < D; d++) {
    // deliveries, grouped by supplier
    const arriving = products.filter((p, i) => due[i] === d);
    for (const p of arriving) {
      const i = products.indexOf(p);
      const n = Math.round(weekly[i] * (d === 0 ? 5 : 4)) + p.reorder;
      const c = round2(P[i][4] * (0.96 + rnd() * 0.1));
      p.cost = c;
      add({ type: "purchase", productId: p.id, qty: n, unitCost: c, party: SUP[p.category], date: day(d), ref: `d${d}-${p.category}`, note: d === 0 ? "Opening order" : "" });
      qty[i] += n; due[i] = -1;
    }
    const dow = parseD(day(d)).getDay();
    const orders = 2 + Math.floor(rnd() * (dow === 0 || dow === 6 ? 6 : 4));
    for (let o = 0; o < orders; o++) {
      const ref = `o${d}-${o}`;
      const party = rnd() < 0.6 ? "Walk-in customer" : CUST[Math.floor(rnd() * CUST.length)];
      const nLines = rnd() < 0.35 ? 2 : 1;
      for (let l = 0; l < nLines; l++) {
        let r = rnd() * wSum, i = 0;
        while (r > weekly[i]) r -= weekly[i++];
        const n = rnd() < 0.2 ? 2 : 1;
        if (qty[i] < n) continue;
        const p = products[i];
        add({ type: "sale", productId: p.id, qty: n, unitPrice: rnd() < 0.08 ? round2(p.price * 0.9) : p.price, party, date: day(d), ref, note: "" });
        qty[i] -= n;
      }
    }
    if (d === 41) { add({ type: "adjust", productId: "p3", qty: -2, date: day(d), note: "Damaged or broken: chipped in delivery" }); qty[3] -= 2; }
    if (d === 70) { add({ type: "adjust", productId: "p6", qty: 1, date: day(d), note: "Stock count" }); qty[6] += 1; }
    products.forEach((p, i) => {
      if (qty[i] <= p.reorder && due[i] < 0 && d < D - 3 && !(keepLow.has(p.sku) && d >= D - 24)) due[i] = d + 3;
    });
  }
  return { version: 1, settings: { shop: "Juniper & Pine Gifts", currency: "USD", notify: false, notified: [] }, products, moves };
}

// ===================================================================
// Shell & routing
// ===================================================================
function updateChrome() {
  const setUp = !firstRun();
  $("#tabs").hidden = !setUp;
  $("#demoBadge").hidden = !DEMO;
  $("#proBadge").hidden = !proActive || DEMO;
  $("#shopLine").textContent = DEMO ? "Demo: a sample gift shop. Changes aren't saved" : setUp ? db.settings.shop : "Stock, sales and profit for your small business";
  $('#tabs a[data-page="reports"]').classList.toggle("locked-tab", !hasPro());
  updateLowBadge();
}

function route() {
  updateChrome();
  const [page, arg] = location.hash.slice(1).split("/");
  if (firstRun() && page !== "pro") return viewWelcome();
  const tab = { product: "products", "product-new": "products", "product-edit": "products", adjust: "products", sell: "sales", buy: "purchases", move: "history" }[page] || page;
  const known = ["dashboard", "products", "sales", "purchases", "history", "reports", "pro", "settings"];
  $$("#tabs a").forEach((a) => (a.dataset.page === (known.includes(tab) ? tab : "dashboard") ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  try {
    switch (page) {
      case "products": viewProducts(arg); break;
      case "product": viewProduct(arg); break;
      case "product-new": viewProductForm(); break;
      case "product-edit": viewProductForm(arg); break;
      case "sell": viewTrade("sale", arg); break;
      case "buy": viewTrade("purchase", arg); break;
      case "adjust": viewAdjust(arg); break;
      case "move": viewMove(arg); break;
      case "sales": viewSales(); break;
      case "purchases": viewPurchases(); break;
      case "history": viewHistory(); break;
      case "reports": viewReports(); break;
      case "pro": viewPro(); break;
      case "settings": viewSettings(); break;
      default: viewDashboard();
    }
  } catch (e) {
    console.error(e);
    main.innerHTML = `<div class="msg error">Something went wrong showing this page. Your data is safe. <a href="#dashboard">Go to the dashboard</a></div>`;
  }
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);
// Another tab changed the data: reload it so this tab doesn't overwrite it.
window.addEventListener("storage", (e) => {
  if (DEMO || (e.key !== K.data && e.key !== null)) return;
  db = normalize(store.json(K.data, null) || blank()); moneyFmt = null; calc(); route();
});

(async () => {
  calc();
  const saved = store.get(K.pro);
  proActive = !DEMO && !!saved && await codeIsValid(saved).catch(() => false);
  route();
  checkLowAlerts();
})();
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
