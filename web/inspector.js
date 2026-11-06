"use strict";

// A viewer for real chat and Learning Lab execution events. It does not run tools.
(() => {
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const json = (value) => escape(JSON.stringify(value, null, 2));
  const when = (event) => event.elapsed_ms == null ? "Browser" : `+${(event.elapsed_ms / 1000).toFixed(2)}s`;
  const runStates = { sending: "Sending", running: "Running", completed: "Completed", error: "Failed", cancelled: "Stopped" };

  window.AgentInspector = class AgentInspector {
    constructor() {
      this.runs = [];
      this.sequence = 0;
      this.selectedId = null;
      this.definition = null;
      this.definitionError = false;
      this.root = null;
      this.openDetails = new Map();
      this.entries = [];
      this.entrySequence = 0;
      this.activeTab = "console";
      this.isOpen = false;
      this.paused = false;
      this.follow = true;
      this.filter = "all";
      this.search = "";
      this.started = performance.now();
      this.dockPreference = "right";
      this.width = 460;
      this.height = 340;
    }

    async loadDefinition() {
      try {
        const response = await fetch("/api/agent");
        if (!response.ok) throw new Error("Agent setup is unavailable");
        this.definition = await response.json();
        this.definitionError = false;
      } catch {
        this.definitionError = true;
      }
      this.refresh();
    }

    start(message, history, feature = null) {
      const run = {
        id: `run-${++this.sequence}`, number: this.sequence, startedAt: new Date().toISOString(),
        message, feature, history: history.map((turn) => ({ ...turn })), events: [], state: "sending",
      };
      this.runs.unshift(run);
      this.runs = this.runs.slice(0, 12);
      this.selectedId = run.id;
      this.refresh();
      return run.id;
    }

    record(id, event) {
      const run = this.runs.find((item) => item.id === id);
      if (!run) return;
      run.events.push(event);
      if (event.request_id) run.requestId = event.request_id;
      if (event.feature) run.feature = event.feature;
      if (event.type === "answer") run.state = "completed";
      else if (event.type === "error") run.state = "error";
      else if (event.type === "cancelled") run.state = "cancelled";
      else if (run.state === "sending") run.state = "running";
      this.logEvent(event, run);
      this.refresh();
    }

    browserFailure(id, error) {
      const run = this.runs.find((item) => item.id === id);
      if (!run || run.events.some((event) => event.type === "error")) return;
      this.record(id, {
        type: error.name === "AbortError" ? "cancelled" : "error", source: "browser",
        message: error.name === "AbortError" ? "The browser stopped waiting for this response." : error.message,
      });
    }

    mount(root) {
      this.root = root;
      try {
        const saved = JSON.parse(localStorage.getItem("paper-parcel-developer") || "{}");
        if (["right", "bottom"].includes(saved.dock)) this.dockPreference = saved.dock;
        if (Number.isFinite(saved.width)) this.width = saved.width;
        if (Number.isFinite(saved.height)) this.height = saved.height;
        this.restoreOpen = saved.open === true;
        if (["console", "trace", "tools"].includes(saved.tab)) this.activeTab = saved.tab;
      } catch {}
      root.innerHTML = `
        <div class="developer-resize" role="separator" tabindex="0" aria-label="Resize developer panel" aria-orientation="vertical" aria-valuemin="360" aria-valuemax="700" aria-valuenow="460" title="Drag to resize, or use arrow keys"></div>
        <header class="developer-header"><div class="developer-title"><span class="terminal-mark" aria-hidden="true">&gt;_</span><h2 id="developer-title">Agent inspector</h2><span class="developer-label">DEV</span></div><div class="developer-window-actions"><label class="sr-only" for="developer-dock">Dock position</label><div class="select-control"><select id="developer-dock"><option value="right">Dock right</option><option value="bottom">Dock bottom</option></select></div><button type="button" class="developer-icon" id="developer-close" aria-label="Close developer tools" title="Close · Esc">×</button></div></header>
        <div class="developer-tabbar" role="tablist" aria-label="Developer views"><button id="developer-tab-console" role="tab" aria-selected="true" aria-controls="developer-console">Console <span id="developer-event-count">0</span></button><button id="developer-tab-trace" role="tab" aria-selected="false" aria-controls="developer-trace" tabindex="-1">Request trace</button><button id="developer-tab-tools" role="tab" aria-selected="false" aria-controls="developer-tools" tabindex="-1">Tools & setup</button></div>
        <section id="developer-console" class="developer-pane console-pane" role="tabpanel" aria-labelledby="developer-tab-console">
          <div class="console-toolbar"><button type="button" id="console-clear" title="Clear console display; request traces are kept">Clear</button><button type="button" id="console-pause" aria-pressed="false">Pause</button><label class="console-follow"><input type="checkbox" id="console-follow" checked>Follow</label><span class="console-toolbar-spacer"></span><label class="sr-only" for="console-filter">Filter event type</label><div class="select-control"><select id="console-filter"><option value="all">All events</option><option value="network">Network</option><option value="model">Model</option><option value="tool">Tools</option><option value="graph">Graph & chains</option><option value="schema">Validation</option><option value="error">Errors</option></select></div></div>
          <label class="console-search"><span aria-hidden="true">⌕</span><input type="search" id="console-search" placeholder="Filter events…" aria-label="Search console events"></label>
          <div class="console-stream" id="console-stream" tabindex="0" aria-label="Live application events"></div>
        </section>
        <section id="developer-trace" class="developer-pane" role="tabpanel" aria-labelledby="developer-tab-trace" hidden>
          <section class="inspector-card" aria-labelledby="inspector-title"><header class="inspector-heading"><h2 id="inspector-title">Execution trace</h2><span class="run-badge" id="inspector-state" role="status">Ready</span></header><div class="inspector-config" id="inspector-config"></div><div class="run-controls"><label for="inspector-run">Inspect a request</label><div class="select-control run-select"><select id="inspector-run" aria-label="Inspect a request"></select></div><button id="download-trace" type="button">Export JSON</button></div><div id="inspector-content"></div></section>
        </section>
        <section id="developer-tools" class="developer-pane" role="tabpanel" aria-labelledby="developer-tab-tools" hidden><section class="inspector-card" id="catalog-context" aria-label="Setup context"></section><section class="inspector-card tool-catalog"><div class="inspector-section-title"><h2>Available tools</h2><span id="catalog-count"></span></div><p class="inspector-explainer">Actual registered functions and their input schemas.</p><div id="inspector-catalog"></div></section><details class="inspector-card agent-instructions" data-detail-key="setup"><summary>Instructions & model settings</summary><div id="inspector-setup"></div></details></section>
        <footer class="developer-footer"><span class="developer-live" id="developer-live">Listening</span><span id="developer-footnote">Local observer · Ctrl + \x60 to toggle</span></footer>`;
      root.querySelector("#inspector-run").addEventListener("change", event => { this.selectedId = event.target.value; this.refresh(); });
      root.querySelector("#download-trace").addEventListener("click", () => this.download());
      root.querySelector("#developer-close").addEventListener("click", () => this.close());
      root.querySelector("#developer-dock").addEventListener("change", event => { this.dockPreference = event.target.value; this.layout(); this.saveLayout(); });
      root.querySelectorAll('[role="tab"]').forEach((button, index, buttons) => {
        button.addEventListener("click", () => this.setTab(button.id.replace("developer-tab-", "")));
        button.addEventListener("keydown", event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next].click(); buttons[next].focus();
        });
      });
      root.querySelector("#console-clear").addEventListener("click", () => {
        this.entries = [];
        for (const key of this.openDetails.keys()) if (key.startsWith("console:")) this.openDetails.delete(key);
        root.querySelector("#console-stream").replaceChildren();
        root.querySelector("#developer-event-count").textContent = "0";
        this.renderConsole(); this.note("Console cleared · request traces kept");
      });
      root.querySelector("#console-pause").addEventListener("click", event => {
        this.paused = !this.paused; event.currentTarget.textContent = this.paused ? "Resume" : "Pause";
        event.currentTarget.setAttribute("aria-pressed", String(this.paused));
        root.querySelector("#developer-live").textContent = this.paused ? "Display paused" : "Listening";
        this.note(this.paused ? "Events are still being recorded" : "Local observer · Ctrl + ` to toggle");
        if (!this.paused) this.renderConsole();
      });
      root.querySelector("#console-follow").addEventListener("change", event => { this.follow = event.target.checked; if (this.follow) this.renderConsole(); });
      root.querySelector("#console-filter").addEventListener("change", event => { this.filter = event.target.value; this.renderConsole(); });
      root.querySelector("#console-search").addEventListener("input", event => { this.search = event.target.value.toLowerCase(); this.renderConsole(); });
      root.addEventListener("toggle", event => { const key = event.target.dataset?.detailKey; if (key) this.openDetails.set(key, event.target.open); }, true);
      root.addEventListener("click", event => {
        const button = event.target.closest("[data-inspect-run]");
        if (button) { this.selectedId = button.dataset.inspectRun; this.setTab("trace"); }
      });
      document.addEventListener("click", event => {
        const toggle = event.target.closest("[data-inspector-toggle]");
        const opener = event.target.closest("[data-inspector-open]");
        if (toggle) { this.opener = toggle; this.isOpen ? this.close() : this.open(); }
        if (opener) { this.opener = opener; this.open(opener.dataset.inspectorOpen || "console"); }
      });
      document.addEventListener("keydown", event => {
        if (event.ctrlKey && event.code === "Backquote") { event.preventDefault(); this.isOpen ? this.close() : this.open(); }
        if (event.key === "Escape" && this.isOpen && root.contains(document.activeElement)) { event.preventDefault(); this.close(); }
      });
      this.installResize();
      this.appObserver = new ResizeObserver(entries => {
        const width = entries[0].contentRect.width;
        const surface = document.querySelector("#app-surface");
        surface.classList.toggle("app-compact", width <= 1200);
        surface.classList.toggle("app-narrow", width <= 760);
        surface.classList.toggle("app-tiny", width <= 400);
      });
      this.appObserver.observe(document.querySelector("#app-surface"));
      window.addEventListener("resize", () => this.layout());
      this.layout(); this.setTab(this.activeTab);
      if (this.restoreOpen) this.open(this.activeTab, false);
    }

    open(tab = this.activeTab, focus = true) {
      this.isOpen = true; this.root.hidden = false;
      document.body.classList.add("developer-open");
      document.querySelectorAll("[data-inspector-toggle]").forEach(button => button.setAttribute("aria-expanded", "true"));
      this.layout(); this.setTab(tab);
      this.saveLayout();
      if (focus) this.root.querySelector(`#developer-tab-${this.activeTab}`).focus({preventScroll: true});
    }

    close() {
      this.isOpen = false; this.root.hidden = true;
      document.body.classList.remove("developer-open");
      document.querySelectorAll("[data-inspector-toggle]").forEach(button => button.setAttribute("aria-expanded", "false"));
      this.saveLayout();
      if (this.root.contains(document.activeElement)) (this.opener?.isConnected && this.opener.getClientRects().length ? this.opener : document.querySelector(".developer-peek")).focus({preventScroll: true});
    }

    setTab(tab) {
      if (!["console", "trace", "tools"].includes(tab)) return;
      this.activeTab = tab;
      this.root.querySelectorAll('[role="tab"]').forEach(button => {
        const active = button.id === `developer-tab-${tab}`;
        button.setAttribute("aria-selected", String(active)); button.tabIndex = active ? 0 : -1;
      });
      for (const name of ["console", "trace", "tools"]) this.root.querySelector(`#developer-${name}`).hidden = name !== tab;
      this.refresh(); if (tab === "console") this.renderConsole();
      this.saveLayout();
    }

    saveLayout() {
      try { localStorage.setItem("paper-parcel-developer", JSON.stringify({dock: this.dockPreference, width: this.width, height: this.height, open:this.isOpen, tab:this.activeTab})); } catch {}
    }

    layout() {
      if (!this.root) return;
      this.effectiveDock = window.innerWidth < 900 ? "bottom" : this.dockPreference;
      const widthLimit = this.effectiveDock === "right" ? Math.max(360, Math.min(800, window.innerWidth - 440)) : 800;
      this.width = Math.max(360, Math.min(this.width, widthLimit));
      this.height = Math.max(220, Math.min(this.height, window.innerHeight * .68));
      document.body.dataset.developerDock = this.effectiveDock;
      document.documentElement.style.setProperty("--developer-width", `${this.width}px`);
      document.documentElement.style.setProperty("--developer-height", `${this.height}px`);
      this.root.querySelector("#developer-dock").value = this.effectiveDock;
      this.root.querySelector('#developer-dock option[value="right"]').disabled = window.innerWidth < 900;
      const handle = this.root.querySelector(".developer-resize");
      const vertical = this.effectiveDock === "right";
      handle.setAttribute("aria-orientation", vertical ? "vertical" : "horizontal");
      handle.setAttribute("aria-valuemin", vertical ? "360" : "220");
      handle.setAttribute("aria-valuemax", String(Math.round(vertical ? Math.max(360, Math.min(800, window.innerWidth - 440)) : window.innerHeight * .68)));
      handle.setAttribute("aria-valuenow", String(Math.round(vertical ? this.width : this.height)));
    }

    installResize() {
      const handle = this.root.querySelector(".developer-resize");
      let drag = null;
      handle.addEventListener("pointerdown", event => { if (event.button !== 0) return; drag = {x:event.clientX, y:event.clientY, width:this.width, height:this.height}; handle.setPointerCapture(event.pointerId); event.preventDefault(); });
      handle.addEventListener("pointermove", event => {
        if (!drag) return;
        if (this.effectiveDock === "right") this.width = drag.width + drag.x - event.clientX;
        else this.height = drag.height + drag.y - event.clientY;
        this.layout();
      });
      handle.addEventListener("pointerup", () => { drag = null; this.saveLayout(); });
      handle.addEventListener("pointercancel", () => { drag = null; });
      handle.addEventListener("keydown", event => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        if (this.effectiveDock === "right") this.width += event.key === "ArrowLeft" ? 24 : event.key === "ArrowRight" ? -24 : 0;
        else this.height += event.key === "ArrowUp" ? 24 : event.key === "ArrowDown" ? -24 : 0;
        this.layout(); this.saveLayout();
      });
    }

    note(message) { if (this.root) this.root.querySelector("#developer-footnote").textContent = message; }

    observeNetwork() {
      const original = window.fetch.bind(window);
      window.fetch = async (input, options) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href);
        if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return original(input, options);
        const started = performance.now();
        const method = options?.method || (input instanceof Request ? input.method : "GET");
        this.addEntry("network", `${method} ${url.pathname}`, {type:"http_request", method, path:url.pathname});
        try {
          const response = await original(input, options);
          const elapsed = Math.round(performance.now() - started);
          const stream = response.headers.get("content-type")?.includes("text/event-stream");
          this.addEntry(response.ok ? "network" : "error", `${response.status} ${method} ${url.pathname} · ${elapsed}ms${stream ? " · stream connected" : ""}`, {type:"http_response", method, path:url.pathname, status:response.status, headers_ms:elapsed, streaming:Boolean(stream)});
          return response;
        } catch (error) {
          this.addEntry(error.name === "AbortError" ? "app" : "error", `${method} ${url.pathname} · ${error.name === "AbortError" ? "cancelled" : "failed"}`, {type:"http_error", method, path:url.pathname, error:error.message});
          throw error;
        }
      };
    }

    logClient(type, payload) { this.addEntry("app", `${type} → ${payload.view || "app"}`, {type, ...payload}); }

    logEvent(event, run) {
      const categories = {request:"app", status:"app", scope_start:"model", scope_result:"model", model_start:"model", model_end:"model", tool_start:"tool", tool_result:"tool", graph_node:"graph", graph_route:"graph", chain_step:"graph", validation:"schema", structured_output:"schema", answer:"app", guidance:"app", error:"error", cancelled:"error"};
      let label = event.type.replaceAll("_", ".");
      if (event.type === "request") label = `${event.method} ${event.endpoint} · ${run.message}`;
      else if (event.type === "tool_start") label = `call ${event.name}(${JSON.stringify(event.args)})`;
      else if (event.type === "tool_result") label = `${event.name} → ${event.status === "error" ? "ERROR" : "returned"}`;
      else if (event.type === "scope_result") label = `scope → ${event.route}`;
      else if (event.type === "model_start") label = `model.call #${event.step} · started`;
      else if (event.type === "model_end") label = `model.call #${event.step} → ${event.tool_count} tool requests${event.output_tokens != null ? ` · ${event.output_tokens} tokens out` : ""}`;
      else if (event.type === "validation") label = `${event.name} → ${event.valid ? "PASS" : "FAIL"}`;
      else if (event.type === "graph_node") label = `graph.${event.node} · ${event.state}`;
      else if (event.type === "graph_route") label = `${event.from} → ${event.to}`;
      else if (event.type === "chain_step") label = `${event.component} · ${event.name} · ${event.state}`;
      else if (event.type === "structured_output") label = `${event.name} · ${event.parsed == null ? "JSON parsing failed" : "JSON parsed"}`;
      else if (event.type === "answer") label = `response → frontend · ${event.duration_seconds}s${event.artifact ? ` · ${event.artifact.kind}` : ""}`;
      else if (event.message) label = event.message;
      const failed = event.type === "tool_result" && event.status === "error" || event.type === "validation" && !event.valid || event.type === "structured_output" && event.parsed == null;
      this.addEntry(failed ? "error" : categories[event.type] || "app", label, event, run.id);
    }

    addEntry(category, label, data, runId = null) {
      this.entries.push({id:++this.entrySequence, time:performance.now()-this.started, category, label, data, runId});
      if (this.entries.length > 600) this.openDetails.delete(`console:${this.entries.shift().id}`);
      if (this.root) this.root.querySelector("#developer-event-count").textContent = this.entries.length;
      if (!this.paused) this.renderConsole();
    }

    renderConsole() {
      if (!this.root || this.paused || this.activeTab !== "console") return;
      const stream = this.root.querySelector("#console-stream");
      this.root.querySelector("#developer-event-count").textContent = this.entries.length;
      const scroll = stream.scrollTop;
      stream.querySelectorAll("details[open]").forEach(item => this.openDetails.set(item.dataset.detailKey, true));
      const entries = this.entries.filter(entry => (this.filter === "all" || entry.category === this.filter) && (!this.search || `${entry.label} ${JSON.stringify(entry.data)}`.toLowerCase().includes(this.search)));
      stream.innerHTML = entries.length ? entries.map(entry => this.details(`console:${entry.id}`, `<span class="console-time">${(entry.time/1000).toFixed(2)}</span><span class="console-category ${entry.category}">${entry.category}</span><span class="console-message">${escape(entry.label)}</span>`, `<pre class="inspector-json">${json(entry.data)}</pre>${entry.runId ? `<button type="button" class="console-inspect" data-inspect-run="${escape(entry.runId)}">Inspect request →</button>` : ""}`, "console-entry")).join("") : `<div class="console-empty"><span aria-hidden="true">&gt;_</span><p>${this.filter !== "all" || this.search ? "No events match this filter." : "Listening for activity. Use the shop or run an analysis."}</p></div>`;
      stream.scrollTop = this.follow ? stream.scrollHeight : scroll;
    }

    details(key, summary, content, extraClass = "", initiallyOpen = false) {
      const open = this.openDetails.has(key) ? this.openDetails.get(key) : initiallyOpen;
      return `<details class="execution-step ${extraClass}" data-detail-key="${escape(key)}" ${open ? "open" : ""}><summary>${summary}</summary><div class="execution-detail">${content}</div></details>`;
    }

    refresh() {
      if (!this.root || !this.root.isConnected || !this.root.querySelector("#inspector-content")) return;
      // Preserve expanded/collapsed JSON while new events arrive.
      this.root.querySelectorAll("details[data-detail-key]").forEach((element) => this.openDetails.set(element.dataset.detailKey, element.open));
      const run = this.runs.find((item) => item.id === this.selectedId);
      const select = this.root.querySelector("#inspector-run");
      const signature = this.runs.map((item) => item.id).join(",");
      if (select.dataset.runs !== signature) {
        select.innerHTML = this.runs.length ? this.runs.map((item) => `<option value="${item.id}">#${String(item.number).padStart(2, "0")} · ${escape(item.message.slice(0, 64))}</option>`).join("") : '<option value="">No requests yet</option>';
        select.dataset.runs = signature;
      }
      select.disabled = !this.runs.length;
      if (run) select.value = run.id;
      this.root.querySelector("#download-trace").disabled = !run;
      const state = this.root.querySelector("#inspector-state");
      state.textContent = run ? runStates[run.state] : "Ready";
      state.className = `run-badge ${run?.state || ""}`;
      const feature = run ? run.feature : this.contextFeature;
      const toolsCount = feature ? this.definition?.learning?.tools?.[feature]?.length || 0 : this.definition?.tools.length;
      this.root.querySelector("#inspector-config").innerHTML = this.definition
        ? `<span>${escape(this.definition.model)}</span><span>${feature ? "Explicit LangGraph" : "LangChain → Ollama"}</span><span>${feature === "report" ? "4 parallel record branches" : `${toolsCount} Python tools`}</span>`
        : `<span>${this.definitionError ? "Agent setup unavailable — refresh the app to retry." : "Loading agent setup…"}</span>`;
      if (this.activeTab === "trace") this.root.querySelector("#inspector-content").innerHTML = run ? this.runHTML(run) : this.contextFeature ? `<div class="inspector-empty"><h3>No learning runs yet</h3><p>Choose a feature and select Run analysis. Its graph, model, tool, and validation events will appear here.</p></div>` : `
        <div class="inspector-empty"><h3>No requests yet</h3><p>Send a chat message to inspect tool calls and results.</p><button type="button" data-question="What was our October profit, and which invoices are overdue?">Try profit + overdue invoices <span>↗</span></button></div>`;
      if (this.activeTab === "tools") this.renderCatalog(run);
      if (this.openDetails.get("setup")) this.root.querySelector(".agent-instructions").open = true;
      this.root.querySelector("#developer-event-count").textContent = this.entries.length;
    }

    runHTML(run) {
      if (run.feature) return this.learningRunHTML(run);
      const events = run.events;
      const request = events.find((event) => event.type === "request");
      const results = events.filter((event) => event.type === "tool_result");
      const models = events.filter((event) => event.type === "model_start");
      const lastTimed = [...events].reverse().find((event) => event.elapsed_ms != null);
      const answer = events.find((event) => event.type === "answer");
      const scope = events.find((event) => event.type === "scope_result");
      const hasScope = events.some((event) => event.type === "scope_start");
      const guided = scope && ["outside_scope", "unsupported_action", "capabilities", "chart_clarification"].includes(scope.route);
      const stage = guided ? (answer ? 3 : 2) : (answer ? 4 : results.length ? 3 : events.some((event) => event.type === "tool_start") ? 2 : models.length ? 1 : 0) + (hasScope ? 1 : 0);
      const route = guided ? ["Request", "Scope check", "App guidance", "Answer"] : ["Request", ...(hasScope ? ["Scope check"] : []), "Model", "Python tools", "Model", ...(events.some(event => event.type === "validation") ? ["Validate chart"] : []), "Answer"];
      let timeline = "";
      const prefix = `${run.id}:`;

      for (const event of events) {
        if (event.type === "request") {
          timeline += this.details(prefix + "request",
            `<span class="step-heading">Request received<small>FastAPI · ${escape(event.method)} ${escape(event.endpoint)}</small></span><time>${when(event)}</time>`,
            `<p>The backend validated your message and prepared this conversation for the agent.</p><div class="json-label">INPUT TO THE AGENT</div><pre class="inspector-json">${json(event.payload)}</pre>`, "request-step");
        } else if (event.type === "scope_start") {
          timeline += this.details(prefix + "scope",
            `<span class="step-heading">Scope check<small>${scope ? escape(scope.route.replaceAll("_", " ")) : "Classifying the latest request…"}</small></span><time>${when(event)}</time>`,
            `<p>A separate call to the local model classifies the latest request before the shop agent runs. History helps with follow-ups; it does not make every question a shop question.</p><div class="json-label">STRUCTURED ROUTE</div><pre class="inspector-json">${scope ? json({route:scope.route}) : "Waiting for classification…"}</pre>`);
        } else if (event.type === "guidance") {
          timeline += this.details(prefix + "guidance",
            `<span class="step-heading">App guidance<small>No business tools called</small></span><time>${when(event)}</time>`,
            `<p>The app called redirect_to_shop after the scope check. No shop records were accessed and the app supplied the response and suggested questions directly.</p><pre class="inspector-json">${json({reason:event.reason, reply:event.reply, suggested_questions:event.suggested_questions})}</pre>`, "guidance-step");
        } else if (event.type === "model_start") {
          const end = events.find((item) => item.type === "model_end" && item.step === event.step);
          const interrupted = ["error", "cancelled"].includes(run.state);
          const label = end ? (end.tool_count ? `Requested ${end.tool_count} ${end.tool_count === 1 ? "tool" : "tools"}` : "Returned an answer draft") : interrupted ? "No model response received" : "Running on your Mac…";
          const tokens = end && end.input_tokens != null ? `<div class="token-note">Reported usage: ${end.input_tokens} input tokens · ${end.output_tokens ?? "—"} output tokens</div>` : "";
          timeline += this.details(prefix + `model:${event.step}`,
            `<span class="step-heading">Model call ${event.step}<small>${label}</small></span><time>${when(event)}</time>`,
            `<p>${event.step === 1 ? "The model receives the instructions, conversation, and tool descriptions. It can request functions through LangChain’s tool-calling interface." : "The model receives the updated conversation, including tool results or a verification instruction, and prepares the next response."}</p><div class="model-detail-tags"><span>${escape(request?.model || this.definition?.model || "Local model")}</span><span>Attempt ${event.attempt}</span></div>${tokens}`, end || interrupted ? "" : "step-running");
        } else if (event.type === "tool_start") {
          const result = events.find((item) => item.type === "tool_result" && item.id === event.id);
          const definition = this.definition?.tools.find((item) => item.name === event.name);
          const isError = result?.status === "error";
          const status = result ? (isError ? "Error returned" : "Result returned") : ["error", "cancelled"].includes(run.state) ? "No result received" : "Running…";
          timeline += this.details(prefix + `tool:${event.id}`,
            `<span class="step-heading"><code>${escape(event.name)}</code><small>Python function · ${status}</small></span><time>${when(event)}</time>`,
            `<p>${escape(definition?.description.split("\n")[0] || "A Python function selected by the model.")}</p>${definition?.purpose === "guidance" ? "<p>No shop records accessed. This function returns guidance and suggested questions.</p>" : ""}<div class="source-files">${(definition?.source_files || []).map((file) => `<span>${escape(file)}</span>`).join("")}</div><div class="json-label">ARGUMENTS CHOSEN BY THE MODEL</div><pre class="inspector-json">${json(event.args)}</pre><div class="json-label">${isError ? "ERROR RETURNED TO THE MODEL" : "DATA RETURNED TO THE MODEL"}${result ? `<span>${when(result)}</span>` : ""}</div><pre class="inspector-json ${isError ? "json-error" : ""}">${result ? json(result.result) : "Waiting for a tool result…"}</pre>`, `tool-step ${isError ? "step-error" : ""}`, true);
        } else if (event.type === "status" && event.phase === "verification") {
          timeline += `<div class="execution-notice"><div><strong>Tool verification requested</strong><p>The first draft skipped the tools. It was withheld while the model was asked to use a business tool or redirect an unsupported request.</p></div><time>${when(event)}</time></div>`;
        } else if (event.type === "status" && event.phase === "queue") {
          timeline += `<div class="execution-notice"><div><strong>Waiting for the local model</strong><p>Another app request is using it. The agent will start when it is available.</p></div><time>${when(event)}</time></div>`;
        } else if (event.type === "validation") {
          timeline += this.details(prefix + "validation",
            `<span class="step-heading">${escape(event.name)}<small>${event.valid ? "Pydantic validation passed" : "Validation failed"}</small></span><time>${when(event)}</time>`,
            `<p>The browser draws the chart from these validated tool values.</p><pre class="inspector-json">${json(event.output || event.errors)}</pre><details><summary>Validation schema</summary><pre class="inspector-json">${json(event.schema)}</pre></details>`, "validation-step");
        } else if (event.type === "answer") {
          timeline += this.details(prefix + "answer",
            `<span class="step-heading">Answer sent to the chat<small>${event.duration_seconds}s in the agent · ${event.tool_calls.length} tool calls</small></span><time>${when(event)}</time>`,
            `<p class="inspector-final-answer">${escape(event.reply)}</p>${event.artifact ? `<div class="json-label">JSON USED TO RENDER THE CHART</div><pre class="inspector-json">${json(event.artifact)}</pre>` : ""}`, "answer-step", true);
        } else if (event.type === "error" || event.type === "cancelled") {
          timeline += `<div class="execution-notice notice-error"><div><strong>${event.type === "cancelled" ? "Request stopped" : "Request failed"}</strong><p>${escape(event.message)}</p></div><time>${when(event)}</time></div>`;
        }
      }

      return `<div class="execution-route" aria-label="Execution flow">${route.map((name, index) => `<span class="${index < stage || answer ? "done" : index === stage ? "current" : ""}">${name}</span>`).join('<i aria-hidden="true">→</i>')}</div>
        <div class="run-question"><span>YOUR QUESTION</span><p>${escape(run.message)}</p><small>Request ${escape(run.requestId || "pending")} · ${run.history.length} previous messages sent</small></div>
        <div class="run-metrics"><div><strong>${models.length + (hasScope ? 1 : 0)}</strong><span>Model calls</span></div><div><strong>${results.length}</strong><span>Tool results received</span></div><div><strong>${lastTimed ? (lastTimed.elapsed_ms / 1000).toFixed(1) + "s" : "—"}</strong><span>${run.state === "completed" ? "Request elapsed" : "Latest backend event"}</span></div></div>
        <div class="execution-timeline">${timeline || '<p class="inspector-waiting">Sending the request to the backend…</p>'}</div>
        ${this.details(prefix + "raw", `<span class="step-heading">Raw event stream<small>${events.length} events · times measured by the backend</small></span>`, `<pre class="inspector-json raw-events">${events.map((event) => json(event)).join("\n\n")}</pre>`, "raw-step")}
        <p class="inspector-footnote">Times mark backend events, not Python execution durations. The last 12 requests remain until the page reloads.</p>`;
    }

    learningRunHTML(run) {
      const events=run.events,prefix=`${run.id}:`,scope=events.find(event=>event.type==="scope_result");
      const feature=this.definition?.learning?.features?.[run.feature];
      const last=[...events].reverse().find(event=>event.elapsed_ms!=null);
      const modelCalls=events.filter(event=>event.type==="model_start"||event.type==="scope_start").length;
      const results=events.filter(event=>event.type==="tool_result").length;
      const path=events.filter(event=>event.type==="graph_node"&&event.state==="start").map(event=>event.node);
      let timeline="";
      for (const [index,event] of events.entries()) {
        let summary="",content="",key=`${prefix}event:${index}`,extra="";
        if(event.type==="request"){
          summary="Request received";content=`<p>FastAPI validated the LearningRequest before starting the graph.</p><pre class="inspector-json">${json(event.payload)}</pre>`;
        }else if(event.type==="graph_node"&&event.state==="start"){
          const end=events.find(item=>item.type==="graph_node"&&item.node===event.node&&item.state==="end");
          summary=`${escape(event.node)} <span class="learning-step-tag">StateGraph node · ${end?"completed":"started"}</span>`;
          content=`<p>This is a node in our explicitly authored graph in shop/learning.py. Conditional edges choose one analysis branch before validation.</p><div class="json-label">NODE INPUT</div><pre class="inspector-json">${json(event.input)}</pre>`;
        }else if(event.type==="graph_route"){
          summary=`Route: ${escape(event.from)} → ${escape(event.to)}`;
          content=`<p>The graph evaluated its conditional edge using the validated scope decision.</p><pre class="inspector-json">${json({reason:event.reason,from:event.from,to:event.to})}</pre>`;
        }else if(event.type==="chain_step"&&event.state==="start"){
          const end=events.find(item=>item.type==="chain_step"&&item.name===event.name&&item.state==="end");
          summary=`${escape(event.name)} <span class="learning-step-tag">${escape(event.component)}${event.branch?" · parallel branch":""}</span>`;
          content=`<p>${event.component==="RunnableParallel"?"Independent branches receive the same input and execute concurrently. The next sequence step waits for all their results.":event.component==="RunnableSequence"?"The output of each stage becomes the next stage’s input. This report uses a fixed sequence, not agent-selected tool order.":"This callable is wrapped in a real RunnableLambda."}</p>${event.input?`<div class="json-label">INPUT</div><pre class="inspector-json">${json(event.input)}</pre>`:""}<div class="json-label">OUTPUT${end?.duration_ms!=null?`<span>${end.duration_ms} ms wall time</span>`:""}</div><pre class="inspector-json">${end?.output?json(end.output):end?"Completed":"Running…"}</pre>`;
        }else if(event.type==="scope_start"){
          summary="Scope check · structured output";content=`<p>The local model returns a Pydantic-validated route.</p><pre class="inspector-json">${scope?json({route:scope.route}):"Waiting…"}</pre>`;
        }else if(event.type==="model_start"){
          const end=events.find(item=>item.type==="model_end"&&item.step===event.step);
          summary=`Model call ${event.step} <span class="learning-step-tag">${end?`${end.tool_count} tool requests`:"running"}</span>`;
          content=`<p>${escape(event.purpose||"The agent receives tool descriptions and decides which function to call. A later model call reads the returned data.")}</p>${end?`<pre class="inspector-json">${json(end)}</pre>`:""}`;
        }else if(event.type==="tool_start"){
          const result=events.find(item=>item.type==="tool_result"&&item.id===event.id);
          summary=`<code>${escape(event.name)}</code><small>${result?result.status==="error"?"Tool error returned":"Result returned":"Running…"}</small>`;
          content=`<div class="json-label">MODEL-SELECTED ARGUMENTS</div><pre class="inspector-json">${json(event.args)}</pre><div class="json-label">RETURNED DATA</div><pre class="inspector-json">${result?json(result.result):"Waiting…"}</pre>`;
          if(result?.status==="error")extra="step-error";
        }else if(event.type==="structured_output"){
          summary=`${escape(event.name)} · JSON parsing`;
          content=`<p>with_structured_output uses the schema to parse and validate the model response. Here are the actual response and parsed object.</p><div class="json-label">MODEL RESPONSE</div><pre class="inspector-json">${typeof event.raw_output==="string"?escape(event.raw_output):json(event.raw_output)}</pre><div class="json-label">PARSED OBJECT</div><pre class="inspector-json">${json(event.parsed)}</pre><details><summary>Pydantic JSON schema</summary><pre class="inspector-json">${json(event.schema)}</pre></details>`;
        }else if(event.type==="validation"){
          summary=`<span class="${event.valid?"validation-passed":"validation-failed"}">${escape(event.name)} · ${event.valid?"validation passed":"validation failed"}</span>`;
          content=`<p>${event.valid?"The result passed the Pydantic contract before it was sent to the frontend. Structure is checked; model-written prose still needs to be compared with the source data.":"The invalid result was withheld."}</p><div class="json-label">${event.valid?"VALIDATED OUTPUT":"ERRORS"}</div><pre class="inspector-json">${json(event.valid?event.output:event.errors)}</pre>${event.schema?`<details><summary>Validation schema</summary><pre class="inspector-json">${json(event.schema)}</pre></details>`:""}`;
          if(!event.valid)extra="step-error";
        }else if(event.type==="answer"){
          summary="Validated result sent to the frontend";
          content=`<p class="inspector-final-answer">${escape(event.reply)}</p><div class="json-label">JSON USED TO RENDER THE RESULT</div><pre class="inspector-json">${json(event.artifact)}</pre>`;
        }else if(["error","cancelled","status"].includes(event.type)){
          summary=event.type==="error"?"Request failed":event.type==="cancelled"?"Stopped":"Status";
          content=`<p>${escape(event.message)}</p>`;
          if(event.type==="error")extra="step-error";
        }else continue;
        timeline+=this.details(key,`<span class="step-heading">${summary}</span><time>${when(event)}</time>`,content,extra,event.type==="structured_output"||event.type==="validation");
      }
      return `<div class="execution-route" aria-label="Observed graph path">${path.map(name=>`<span class="done">${escape(name)}</span>`).join('<i aria-hidden="true">→</i>')}</div><div class="run-question"><span>${escape(feature?.title||run.feature)}</span><p>${escape(run.message)}</p><small>Request ${escape(run.requestId||"pending")} · ${escape(feature?.source||"shop/learning.py")}</small></div><div class="run-metrics"><div><strong>${modelCalls}</strong><span>Model calls</span></div><div><strong>${results}</strong><span>Tool results</span></div><div><strong>${last?(last.elapsed_ms/1000).toFixed(1)+"s":"—"}</strong><span>Latest event</span></div></div><div class="execution-timeline">${timeline||"<p>Sending the request…</p>"}</div>${this.details(prefix+"raw",`<span class="step-heading">Raw event stream<small>${events.length} events</small></span>`,`<pre class="inspector-json raw-events">${events.map(json).join("\n\n")}</pre>`,"raw-step")}<p class="inspector-footnote">The same events are logged to the backend terminal and .runtime/events.jsonl. Timestamps are backend event times. The last 12 runs remain until reload.</p>`;
    }

    renderCatalog(run) {
      const feature = run ? run.feature : this.contextFeature;
      const mode = feature ? this.definition?.learning?.features?.[feature]?.title || feature : "Shop chat";
      this.root.querySelector("#catalog-context").innerHTML = run
        ? `<header class="inspector-heading"><h2>Request #${String(run.number).padStart(2, "0")}</h2><span class="run-badge ${escape(run.state)}">${runStates[run.state]}</span></header><div class="run-question"><span>${escape(mode)}${run.id === this.runs[0]?.id ? " · Latest request" : " · Earlier request"}</span><p>${escape(run.message)}</p><button type="button" data-inspect-run="${escape(run.id)}">View request trace →</button></div><p class="inspector-explainer">Call markers update from this request’s events. Schemas, instructions, and model settings describe the app configuration; they usually stay the same between requests.</p>`
        : `<header class="inspector-heading"><h2>${escape(mode)} setup</h2></header><p class="inspector-explainer">No request selected. Showing the app configuration for this view. Send a request to see which tools it calls.</p>`;
      const tools = feature ? this.definition?.learning?.tools?.[feature] || [] : this.definition?.tools || [];
      this.root.querySelector(".tool-catalog h2").textContent = feature === "report" ? "Fixed report chain" : "Available tools";
      this.root.querySelector(".tool-catalog .inspector-explainer").textContent = feature === "report" ? "The report reads sales, profit, stock, and invoices through fixed RunnableParallel branches. The model writes a structured summary after they join." : "The model sees these function names, descriptions, and inputs. A function only runs when it is called.";
      const used = new Set((run?.events || []).filter((event) => event.type === "tool_start").map((event) => event.name));
      const appUsed = new Set((run?.events || []).filter((event) => event.type === "guidance").map((event) => event.name));
      this.root.querySelector("#catalog-count").textContent = tools.length ? `${tools.length} registered` : "";
      this.root.querySelector("#inspector-catalog").innerHTML = tools.map((tool) => this.details(`catalog:${tool.name}`,
        `<span class="step-heading"><code>${escape(tool.name)}</code><small>${appUsed.has(tool.name) ? "Called directly by the app after the scope check" : used.has(tool.name) ? "Called in this request" : !run ? "Available" : ["sending", "running"].includes(run.state) ? "Available · not called yet" : "Available · not called in this request"}</small></span>`,
        `<p>${escape(tool.description)}</p><div class="source-files">${tool.source_files.map((file) => `<span>${escape(file)}</span>`).join("")}</div><div class="json-label">INPUT SCHEMA SEEN BY THE MODEL</div><pre class="inspector-json">${json(tool.input_schema)}</pre>`, used.has(tool.name) || appUsed.has(tool.name) ? "catalog-used" : "")).join("") || `<p class="inspector-explainer">${feature === "report" ? "Open the request trace to see each parallel branch’s input and returned records." : this.definitionError ? "The tool catalog could not be loaded. Refresh to retry." : "Loading registered tools…"}</p>`;
      this.root.querySelector("#inspector-setup").innerHTML = this.definition ? `<div class="json-label">MODEL SETTINGS</div><pre class="inspector-json">${json(feature ? this.definition.learning.model_settings : { model: this.definition.model, runner: this.definition.runner, framework: this.definition.framework, model_url: this.definition.model_url, context_tokens: this.definition.context_tokens, max_output_tokens: this.definition.max_output_tokens, temperature: this.definition.temperature })}</pre><div class="json-label">SCOPE CHECK</div><pre class="inspector-json">${json(this.definition.scope_check)}</pre><div class="json-label">${feature ? "SELECTED ANALYSIS SYSTEM PROMPT" : "OUR APP’S SYSTEM PROMPT"}</div><pre class="inspector-json system-prompt">${escape(feature ? this.definition.learning.system_prompts[feature] : this.definition.system_prompt)}</pre>` : "";
    }

    download() {
      const run = this.runs.find((item) => item.id === this.selectedId);
      if (!run) return;
      const blob = new Blob([JSON.stringify({ request: run, agent: this.definition }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `paper-parcel-${run.requestId || run.id}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  };
})();
