"use strict";

const $ = (selector) => document.querySelector(selector);
const money = (value) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(Number(value));
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const dateLabel = (value) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(`${value}T12:00:00`));
const appearanceQuery = matchMedia("(prefers-color-scheme: dark)");
const compactNavigation = matchMedia("(max-width: 1000px)");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

function applyAppearance(appearance) {
  document.documentElement.dataset.appearance = appearance;
  const theme = appearance === "system" ? (appearanceQuery.matches ? "dark" : "light") : appearance;
  document.documentElement.dataset.theme = theme;
  $("#appearance-select").value = appearance;
  document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#141416" : "#f5f5f7";
}
applyAppearance(document.documentElement.dataset.appearance || "system");
appearanceQuery.addEventListener("change", () => applyAppearance($("#appearance-select").value));
$("#appearance-select").addEventListener("change", (event) => {
  applyAppearance(event.target.value);
  try { localStorage.setItem("paper-parcel-appearance", event.target.value); } catch {}
});

function setNavigation(open) {
  $(".sidebar").classList.toggle("navigation-open", open);
  $("#sidebar-toggle").setAttribute("aria-expanded", String(open));
  $("#sidebar-toggle").setAttribute("aria-label", open ? "Hide navigation" : "Show navigation");
  $("#sidebar-toggle").title = open ? "Hide navigation" : "Show navigation";
}
$("#sidebar-toggle").addEventListener("click", () => setNavigation(!$(".sidebar").classList.contains("navigation-open")));
compactNavigation.addEventListener("change", () => setNavigation(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $(".sidebar").classList.contains("navigation-open")) {
    setNavigation(false);
    $("#sidebar-toggle").focus();
  }
});
$(".skip-link").addEventListener("click", (event) => {
  event.preventDefault();
  $("#main-content").focus();
});
document.querySelectorAll("[data-focus-chat]").forEach((button) => button.addEventListener("click", () => {
  setNavigation(false);
  $(".assistant-panel").scrollIntoView({behavior: "instant", block: window.innerWidth <= 760 ? "start" : "nearest"});
  $("#chat-input").focus({preventScroll: true});
}));
const viewTitles = {
  overview: ["Overview", "Overview", "October 2026 business records."],
  sales: ["Sales & profit", "Sales & profit", "Paid sales and profit for October 2026."],
  inventory: ["Products & stock", "Products & stock", "Stock after October’s paid sales."],
  invoices: ["Invoices", "Invoices", "Unpaid wholesale invoices, as of 3 November 2026."],
  "how-it-works": ["How it works", "How it works", "Follow a question from your browser to your shop’s records."],
  "agent-inspector": ["Agent inspector", "Agent inspector", "Inspect requests, tool calls, and returned data."],
};
const toolLabels = {
  get_sales_summary: "Read sales records",
  get_profit_summary: "Calculate profit",
  get_unpaid_invoices: "Check unpaid invoices",
  get_stock_status: "Check product stock",
  redirect_to_shop: "Suggest supported questions",
};

let data = null;
let currentView = "overview";
let chartMetric = "revenue";
let busy = false;
let activeController = null;
let history = [];
const welcomeHTML = $("#chat-messages").innerHTML;
const inspector = new window.AgentInspector();
let lastShopView = "overview";

function statsHTML() {
  const cards = [
    ["Paid revenue", money(data.sales.revenue_gbp), `Across ${data.sales.paid_sale_count} paid sale records`, ""],
    ["Shop profit", money(data.profit.profit_gbp), "After product costs & expenses", "profit"],
    ["Unpaid invoices", money(data.invoices.total_gbp), `${data.invoices.invoices.filter((row) => row.is_overdue).length} overdue · ${money(data.invoices.invoices.filter((row) => row.is_overdue).reduce((sum, row) => sum + Number(row.amount_gbp), 0))}`, ""],
    ["Items sold", data.sales.units_sold, `Across ${data.stock.products.length} stationery products`, ""],
  ];
  return `<div class="stats-grid">${cards.map(([label, value, note, extra]) => `<div class="stat-card ${extra}"><div class="stat-top"><span>${label}</span></div><div class="stat-value">${escapeHTML(value)}</div><div class="stat-bottom"><span>${escapeHTML(note)}</span></div></div>`).join("")}</div>`;
}

function chartHTML() {
  const key = chartMetric === "revenue" ? "revenue_gbp" : "units_sold";
  const products = [...data.sales.products].sort((a, b) => Number(b[key]) - Number(a[key]));
  const max = Math.max(...products.map((row) => Number(row[key])), 1);
  return `<section class="card"><div class="card-header"><div><h2>Product sales</h2></div><div class="segmented" aria-label="Chart measure"><button data-metric="revenue" class="${chartMetric === "revenue" ? "active" : ""}" aria-pressed="${chartMetric === "revenue"}">Revenue</button><button data-metric="units" class="${chartMetric === "units" ? "active" : ""}" aria-pressed="${chartMetric === "units"}">Units</button></div></div><div class="chart">${products.map((row) => `<div class="bar-row"><span class="bar-name">${escapeHTML(row.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${Number(row[key]) / max * 100}%"></div></div><span class="bar-value">${chartMetric === "revenue" ? money(row[key]) : row[key]}</span></div>`).join("")}</div><div class="chart-footer"><span class="legend-square"></span>${chartMetric === "revenue" ? "Paid sales revenue" : "Units sold"} · October 2026</div></section>`;
}

function invoicesHTML(full = false) {
  const rows = data.invoices.invoices;
  return `<section class="card"><div class="card-header"><div><h2>${full ? "Unpaid wholesale invoices" : "Unpaid invoices"}</h2><p class="card-subtitle">${full ? "These invoices are separate from your paid sales." : `${rows.length} outstanding invoices.`}</p></div>${full ? `<button class="text-button" data-question="Who has overdue invoices and how much do they owe?">Ask assistant</button>` : `<button class="text-button" data-go="invoices">View all ${icon("arrow")}</button>`}</div><div class="table-wrap" tabindex="0" role="region" aria-label="Invoice records"><table class="data-table"><caption class="sr-only">Unpaid wholesale invoices</caption><thead><tr><th scope='col'>Customer</th><th scope='col'>Status</th>${full ? "<th scope='col'>Due date</th>" : ""}<th scope='col' class="amount">Amount</th></tr></thead><tbody>${rows.map((row) => `<tr><td class="primary-cell">${escapeHTML(row.customer)}<span class="subtext">${escapeHTML(row.invoice_id)}</span></td><td><span class="badge ${row.is_overdue ? "amber" : "gray"}">${row.is_overdue ? `${row.days_overdue} days overdue` : "Not yet due"}</span></td>${full ? `<td>${dateLabel(row.due_date)}</td>` : ""}<td class="amount">${money(row.amount_gbp)}</td></tr>`).join("")}</tbody></table></div><div class="table-footer">As of 3 Nov 2026 · Unpaid invoices aren’t included in revenue or profit.</div></section>`;
}

function stockNudgeHTML() {
  const items = data.stock.products.filter((row) => row.needs_restock);
  if (!items.length) return `<div class="stock-nudge"><div><h3>Stock levels</h3><p>All products are above their reorder level.</p></div></div>`;
  const first = items[0];
  return `<div class="stock-nudge"><div><h3>Low stock</h3><p>${escapeHTML(first.name)}: ${first.remaining_stock} remaining.</p></div><button class="text-button" data-go="inventory">View stock ${icon("arrow")}</button></div>`;
}

function inventoryHTML() {
  return `<section class="card"><div class="card-header"><div><h2>Inventory</h2></div><button class="text-button" data-question="Which products should we restock, and why?">Ask about stock</button></div><div class="table-wrap" tabindex="0" role="region" aria-label="Stock records"><table class="data-table"><caption class="sr-only">Product stock after October sales</caption><thead><tr><th scope='col'>Product</th><th scope='col'>Sold</th><th scope='col'>Left</th><th scope='col'>Reorder at</th><th scope='col'>Status</th></tr></thead><tbody>${data.stock.products.map((row) => `<tr><td class="primary-cell">${escapeHTML(row.name)}<span class="subtext">${escapeHTML(row.product_id)}</span></td><td>${row.units_sold}</td><td>${row.remaining_stock}</td><td>${row.reorder_level}</td><td><span class="badge ${row.needs_restock ? "amber" : "green"}">${row.needs_restock ? "Restock" : "In stock"}</span></td></tr>`).join("")}</tbody></table></div><div class="table-footer">31 Oct snapshot · Opening stock minus paid quantities sold. No restocks or returns.</div></section>`;
}

function profitHTML() {
  const rows = [["Paid revenue", data.profit.revenue_gbp], ["− Product costs", data.profit.product_costs_gbp], ["Gross profit", data.profit.gross_profit_gbp], ["− Operating expenses", data.profit.operating_expenses_gbp], ["Shop profit", data.profit.profit_gbp]];
  return `<section class="card"><div class="card-header"><div><h2>Profit calculation</h2></div><button class="text-button" data-question="Explain our October profit calculation.">Explain this</button></div><div class="breakdown">${rows.map(([label, value], index) => `<div class="breakdown-row ${index === rows.length - 1 ? "total" : ""}"><span>${label}</span><span>${money(value)}</span></div>`).join("")}</div><div class="table-footer">Sample calculation · Unpaid invoices and VAT excluded.</div></section>`;
}

function salesRecordsHTML() {
  return `<section class="card"><div class="card-header"><div><h2>Sales records</h2><p class="card-subtitle">Every paid sale in October.</p></div></div><div class="table-wrap" tabindex="0" role="region" aria-label="Sales records"><table class="data-table"><caption class="sr-only">Paid October sales</caption><thead><tr><th scope='col'>Date</th><th scope='col'>Product</th><th scope='col'>Qty</th><th scope='col' class="amount">Revenue</th></tr></thead><tbody>${[...data.sale_records].reverse().map((row) => `<tr><td>${dateLabel(row.date)}</td><td class="primary-cell">${escapeHTML(row.product_name)}<span class="subtext">${escapeHTML(row.sale_id)}</span></td><td>${row.quantity}</td><td class="amount">${money(row.quantity * Number(row.unit_price_gbp))}</td></tr>`).join("")}</tbody></table></div></section>`;
}

function howItWorksHTML() {
  const steps = [
    ["You ask a question", "This browser sends your message to the Python backend through <code>/api/chat/stream</code>."],
    ["The backend checks the scope", "A separate local model call classifies the request. Unrelated topics receive app-written guidance and suggested questions; shop questions continue to the agent."],
    ["Qwen3 chooses a tool", "Ollama runs the model on your Mac. The model can choose four business tools or a guidance tool for unsupported requests."],
    ["Python runs the function", "Business tools read the CSV files and calculate results using exact decimal amounts. The guidance tool suggests supported questions without reading any records."],
    ["The assistant explains the answer", "The model reads the tool’s result and writes a reply. Open the tool cards in the chat to inspect the actual inputs and returned records."],
  ];
  return `<section class="card"><div class="card-header"><div><h2>Request flow</h2><p class="card-subtitle">Try asking: “What was October’s profit?”</p></div></div><div class="flow-list">${steps.map(([title, description], index) => `<div class="flow-step"><span class="flow-number">${index + 1}</span><div><strong>${title}</strong><p>${description}</p></div></div>`).join("")}</div><p class="learning-footnote">The dashboard reads the same business functions directly. The chat lets the model choose them. Your local Qwen3 model uses no paid API. All names and transactions are fictional.<br><a href="/docs" target="_blank" rel="noopener">Explore the backend API documentation ↗</a></p></section><section class="card"><div class="card-header"><h2>Available tools</h2></div><div class="flow-list">${Object.entries(toolLabels).map(([name, label]) => `<div class="flow-step"><div><strong>${label}</strong><p><code>${name}</code></p></div></div>`).join("")}</div></section>`;
}

function renderBusiness() {
  if (!data && currentView !== "agent-inspector") return;
  const inspecting = currentView === "agent-inspector";
  document.body.classList.toggle("inspecting", inspecting);
  $("#chat-view-button").setAttribute("aria-pressed", String(!inspecting));
  $("#inspector-view-button").setAttribute("aria-pressed", String(inspecting));
  const [breadcrumb, title, description] = viewTitles[currentView];
  $("#breadcrumb-view").textContent = breadcrumb;
  $("#page-title").textContent = title;
  $("#page-description").textContent = description;
  document.querySelectorAll("[data-view]").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === currentView);
    if (item.dataset.view === currentView) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  if (inspecting) {
    inspector.mount($("#business-content"));
    return;
  }
  const views = {
    overview: () => statsHTML() + chartHTML() + stockNudgeHTML() + invoicesHTML(),
    sales: () => profitHTML() + chartHTML() + salesRecordsHTML(),
    inventory: () => stockNudgeHTML() + inventoryHTML(),
    invoices: () => `<div class="card summary-strip"><div><small>Outstanding balance</small><strong>${money(data.invoices.total_gbp)}</strong></div><div><small>Overdue balance</small><strong>${money(data.invoices.invoices.filter((row) => row.is_overdue).reduce((sum, row) => sum + Number(row.amount_gbp), 0))}</strong></div></div>` + invoicesHTML(true),
    "how-it-works": howItWorksHTML,
  };
  $("#business-content").innerHTML = views[currentView]();
}

function navigate(event) {
  const requested = location.hash.slice(1) || "overview";
  currentView = Object.hasOwn(viewTitles, requested) ? requested : "overview";
  if (currentView !== "agent-inspector") lastShopView = currentView;
  renderBusiness();
  setNavigation(false);
  if (event) {
    $("#page-title").focus({preventScroll: true});
    if (compactNavigation.matches) $(".page-heading").scrollIntoView({block: "start"});
  }
}

async function loadDashboard() {
  const button = $("#refresh-button");
  button.disabled = true;
  button.classList.add("spinning");
  try {
    const response = await fetch("/api/dashboard");
    if (!response.ok) throw new Error("The shop records couldn’t be loaded. Please try Refresh.");
    data = await response.json();
    $("#dashboard-error").hidden = true;
    $("#stock-nav-count").textContent = data.stock.restock_count;
    $("#invoice-nav-count").textContent = data.invoices.invoice_count;
    renderBusiness();
  } catch (error) {
    $("#dashboard-error").textContent = error.message;
    $("#dashboard-error").hidden = false;
  } finally {
    button.disabled = false;
    button.classList.remove("spinning");
  }
}

async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) throw new Error("Backend unavailable");
    const health = await response.json();
    $("#model-status").classList.toggle("offline", health.status !== "ready");
    $("#model-status-text").textContent = health.status === "ready" ? "Local AI ready" : "Local AI offline";
    $("#model-status").title = health.message;
  } catch {
    $("#model-status").classList.add("offline");
    $("#model-status-text").textContent = "Connection lost";
  }
}

function inlineText(element, text) {
  for (const piece of text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g)) {
    if (piece.startsWith("**") && piece.endsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = piece.slice(2, -2);
      element.append(strong);
    } else if (piece.startsWith("*") && piece.endsWith("*")) {
      const emphasis = document.createElement("em");
      emphasis.textContent = piece.slice(1, -1);
      element.append(emphasis);
    } else if (piece.startsWith("`") && piece.endsWith("`")) {
      const code = document.createElement("code");
      code.textContent = piece.slice(1, -1);
      element.append(code);
    } else element.append(document.createTextNode(piece));
  }
}

function renderReply(element, text) {
  element.replaceChildren();
  let list = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) { list = null; continue; }
    const bullet = trimmed.match(/^(?:[-*•]|\d+\.)\s+(.+)/);
    if (bullet) {
      if (!list) { list = document.createElement("ul"); element.append(list); }
      const item = document.createElement("li");
      inlineText(item, bullet[1]); list.append(item);
    } else {
      list = null;
      const paragraph = document.createElement("p");
      inlineText(paragraph, trimmed.replace(/^#{1,4}\s+/, ""));
      element.append(paragraph);
    }
  }
}

function scrollChat() {
  const messages = $("#chat-messages");
  messages.scrollTop = messages.scrollHeight;
}

function setBusy(value) {
  busy = value;
  $("#chat-messages").setAttribute("aria-busy", String(value));
  $("#new-chat").disabled = value;
  $("#send-button").classList.toggle("busy", value);
  $("#send-button").setAttribute("aria-label", value ? "Stop response" : "Send question");
  $("#send-button").title = value ? "Stop response" : "Send question";
  $("#chat-hint").textContent = value ? "Working on your question…" : "Enter to send · Shift + Enter for a new line";
  document.querySelectorAll("[data-question]").forEach((button) => { button.disabled = value; });
}

async function askQuestion(question) {
  const message = question.trim();
  if (!message || busy) return;
  $("#chat-welcome")?.remove();
  $("#chat-input").value = "";
  $("#input-count").textContent = "0/2000";
  setBusy(true);
  const runId = inspector.start(message, history);

  const turn = document.createElement("div");
  turn.className = "chat-turn";
  const user = document.createElement("div"); user.className = "user-message"; user.textContent = message;
  const label = document.createElement("div"); label.className = "message-label"; label.textContent = "Assistant";
  const trace = document.createElement("div"); trace.className = "tool-trace";
  const thinking = document.createElement("div"); thinking.className = "thinking"; thinking.innerHTML = '<span class="pulse"></span><span>Thinking about your question…</span>';
  const reply = document.createElement("div"); reply.className = "reply-body";
  turn.append(user, label, trace, thinking, reply);
  $("#chat-messages").append(turn);
  scrollChat();
  if (window.innerWidth <= 760) turn.scrollIntoView({ behavior: reducedMotion.matches ? "instant" : "smooth", block: "nearest" });

  const controller = new AbortController();
  activeController = controller;
  let completed = false;
  const toolElements = new Map();

  function handleEvent(event) {
    inspector.record(runId, event);
    if (event.type === "status") thinking.lastElementChild.textContent = event.message;
    else if (event.type === "scope_start") thinking.lastElementChild.textContent = "Checking whether I can help…";
    else if (event.type === "tool_start") {
      const details = document.createElement("details"); details.className = "tool-event";
      const summary = document.createElement("summary");
      const check = document.createElement("span"); check.className = "tool-check running"; check.textContent = "○";
      summary.append(check, document.createTextNode(toolLabels[event.name] || event.name));
      const code = document.createElement("pre"); code.textContent = `Function: ${event.name}\nInputs: ${JSON.stringify(event.args, null, 2)}\n\nWaiting for result…`;
      details.append(summary, code); trace.append(details);
      toolElements.set(event.id, { check, code, name: event.name, args: event.args });
      thinking.lastElementChild.textContent = event.name === "redirect_to_shop" ? "Finding questions I can help with…" : "Reading the records…";
    } else if (event.type === "tool_result") {
      const tool = toolElements.get(event.id);
      if (tool) {
        tool.check.textContent = event.status === "error" ? "!" : "✓";
        tool.check.classList.remove("running");
        tool.code.textContent = `Function: ${tool.name}\nInputs: ${JSON.stringify(tool.args, null, 2)}\n\nResult:\n${JSON.stringify(event.result, null, 2)}`;
      }
      thinking.lastElementChild.textContent = "Putting the answer together…";
    } else if (event.type === "answer") {
      completed = true;
      thinking.remove();
      renderReply(reply, event.reply);
      if (event.suggested_questions?.length) {
        const suggestions = document.createElement("div");
        suggestions.className = "suggestions reply-suggestions";
        suggestions.setAttribute("role", "group");
        suggestions.setAttribute("aria-label", "Suggested shop questions");
        for (const question of event.suggested_questions) {
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.question = question;
          button.textContent = question;
          button.disabled = busy;
          suggestions.append(button);
        }
        reply.append(suggestions);
      }
      const meta = document.createElement("div"); meta.className = "message-meta";
      meta.textContent = `${event.duration_seconds}s · ${event.tool_calls.length} tool ${event.tool_calls.length === 1 ? "call" : "calls"} · Local model`;
      turn.append(meta);
      history.push({ role: "user", content: message }, { role: "assistant", content: event.reply });
      history = history.slice(-6);
    } else if (event.type === "error") throw new Error(event.message);
    scrollChat();
  }

  try {
    const response = await fetch("/api/chat/stream", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history }), signal: controller.signal,
    });
    if (!response.ok) throw new Error(response.status === 422 ? "Please keep your question under 2,000 characters." : "The assistant is unavailable. Please try again.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const payload = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
        if (payload) handleEvent(JSON.parse(payload));
      }
      if (done) break;
    }
    if (!completed) throw new Error("The response ended early. Please try again.");
  } catch (error) {
    inspector.browserFailure(runId, error);
    thinking.remove();
    reply.className = "reply-error";
    reply.textContent = error.name === "AbortError" ? "Response stopped." : error.message;
    const retry = document.createElement("button"); retry.textContent = "Try again"; retry.type = "button";
    retry.addEventListener("click", () => askQuestion(message)); reply.append(retry);
    for (const tool of toolElements.values()) {
      if (tool.check.classList.contains("running")) { tool.check.textContent = "–"; tool.check.classList.remove("running"); }
    }
  } finally {
    activeController = null;
    setBusy(false);
    scrollChat();
    $("#chat-input").focus({ preventScroll: true });
  }
}

document.addEventListener("click", (event) => {
  const questionButton = event.target.closest("[data-question]");
  if (questionButton) askQuestion(questionButton.dataset.question);
  const viewButton = event.target.closest("[data-go]");
  if (viewButton) location.hash = viewButton.dataset.go;
  const metricButton = event.target.closest("[data-metric]");
  if (metricButton) { chartMetric = metricButton.dataset.metric; renderBusiness(); }
});
$("#chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy) activeController?.abort();
  else askQuestion($("#chat-input").value);
});
$("#chat-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!busy) askQuestion(event.currentTarget.value);
  }
});
$("#chat-input").addEventListener("input", () => { $("#input-count").textContent = `${$("#chat-input").value.length}/2000`; });
$("#new-chat").addEventListener("click", () => {
  if (busy) return;
  history = [];
  $("#chat-messages").innerHTML = welcomeHTML;
  $("#chat-input").value = "";
  $("#input-count").textContent = "0/2000";
  $("#chat-input").focus({ preventScroll: true });
});
$("#refresh-button").addEventListener("click", () => { loadDashboard(); checkHealth(); });
$("#inspector-view-button").addEventListener("click", () => { location.hash = "agent-inspector"; });
$("#chat-view-button").addEventListener("click", () => {
  if (currentView === "agent-inspector") location.hash = lastShopView;
  else $("#chat-input").focus({ preventScroll: true });
});
$("#period-select").addEventListener("change", loadDashboard);
window.addEventListener("hashchange", navigate);
navigate();
loadDashboard();
checkHealth();
inspector.loadDefinition();
setInterval(() => { if (!document.hidden) checkHealth(); }, 30000);
