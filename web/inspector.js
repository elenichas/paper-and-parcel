"use strict";

// An execution viewer for real events from /api/chat/stream. It does not run tools.
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

    start(message, history) {
      const run = {
        id: `run-${++this.sequence}`, number: this.sequence, startedAt: new Date().toISOString(),
        message, history: history.map((turn) => ({ ...turn })), events: [], state: "sending",
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
      if (event.type === "answer") run.state = "completed";
      else if (event.type === "error") run.state = "error";
      else if (event.type === "cancelled") run.state = "cancelled";
      else if (run.state === "sending") run.state = "running";
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
      root.innerHTML = `
        <section class="inspector-card" aria-labelledby="inspector-title">
          <header class="inspector-heading"><div><h2 id="inspector-title">Execution trace</h2></div><span class="run-badge" id="inspector-state" role="status">Ready</span></header>
          <div class="inspector-config" id="inspector-config"></div>
          <div class="run-controls"><label for="inspector-run">Inspect a request</label><div class="select-control run-select"><select id="inspector-run" aria-label="Inspect a request"></select></div><button id="download-trace" type="button">Export JSON</button></div>
          <div id="inspector-content"></div>
        </section>
        <section class="inspector-card tool-catalog"><div class="inspector-section-title"><div><h2>Available tools</h2></div><span id="catalog-count"></span></div><p class="inspector-explainer">The model sees these function names, descriptions, and inputs. A function only runs when it is called.</p><div id="inspector-catalog"></div></section>
        <details class="inspector-card agent-instructions" data-detail-key="setup"><summary>Agent instructions & model settings</summary><div id="inspector-setup"></div></details>`;
      root.querySelector("#inspector-run").addEventListener("change", (event) => {
        this.selectedId = event.target.value;
        this.refresh();
      });
      root.querySelector("#download-trace").addEventListener("click", () => this.download());
      root.addEventListener("toggle", (event) => {
        const key = event.target.dataset?.detailKey;
        if (key) this.openDetails.set(key, event.target.open);
      }, true);
      this.refresh();
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
      this.root.querySelector("#inspector-config").innerHTML = this.definition
        ? `<span>${escape(this.definition.model)}</span><span>LangChain → Ollama</span><span>${this.definition.tools.length} Python tools</span>`
        : `<span>${this.definitionError ? "Agent setup unavailable — refresh the app to retry." : "Loading agent setup…"}</span>`;
      this.root.querySelector("#inspector-content").innerHTML = run ? this.runHTML(run) : `
        <div class="inspector-empty"><h3>No requests yet</h3><p>Send a chat message to inspect tool calls and results.</p><button type="button" data-question="What was our October profit, and which invoices are overdue?">Try profit + overdue invoices <span>↗</span></button></div>`;
      this.renderCatalog(run);
      if (this.openDetails.get("setup")) this.root.querySelector(".agent-instructions").open = true;
    }

    runHTML(run) {
      const events = run.events;
      const request = events.find((event) => event.type === "request");
      const results = events.filter((event) => event.type === "tool_result");
      const models = events.filter((event) => event.type === "model_start");
      const lastTimed = [...events].reverse().find((event) => event.elapsed_ms != null);
      const answer = events.find((event) => event.type === "answer");
      const scope = events.find((event) => event.type === "scope_result");
      const hasScope = events.some((event) => event.type === "scope_start");
      const guided = scope && ["outside_scope", "unsupported_action", "capabilities"].includes(scope.route);
      const stage = guided ? (answer ? 3 : 2) : (answer ? 4 : results.length ? 3 : events.some((event) => event.type === "tool_start") ? 2 : models.length ? 1 : 0) + (hasScope ? 1 : 0);
      const route = guided ? ["Request", "Scope check", "App guidance", "Answer"] : ["Request", ...(hasScope ? ["Scope check"] : []), "Model", "Python tools", "Model", "Answer"];
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
        } else if (event.type === "answer") {
          timeline += this.details(prefix + "answer",
            `<span class="step-heading">Answer sent to the chat<small>${event.duration_seconds}s in the agent · ${event.tool_calls.length} tool calls</small></span><time>${when(event)}</time>`,
            `<p class="inspector-final-answer">${escape(event.reply)}</p>`, "answer-step", true);
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

    renderCatalog(run) {
      const tools = this.definition?.tools || [];
      const used = new Set((run?.events || []).filter((event) => event.type === "tool_start").map((event) => event.name));
      const appUsed = new Set((run?.events || []).filter((event) => event.type === "guidance").map((event) => event.name));
      this.root.querySelector("#catalog-count").textContent = tools.length ? `${tools.length} registered` : "";
      this.root.querySelector("#inspector-catalog").innerHTML = tools.map((tool) => this.details(`catalog:${tool.name}`,
        `<span class="step-heading"><code>${escape(tool.name)}</code><small>${appUsed.has(tool.name) ? "Called directly by the app after the scope check" : used.has(tool.name) ? "Called in this request" : "Available · not called in this request"}</small></span>`,
        `<p>${escape(tool.description)}</p><div class="source-files">${tool.source_files.map((file) => `<span>${escape(file)}</span>`).join("")}</div><div class="json-label">INPUT SCHEMA SEEN BY THE MODEL</div><pre class="inspector-json">${json(tool.input_schema)}</pre>`, used.has(tool.name) || appUsed.has(tool.name) ? "catalog-used" : "")).join("") || `<p class="inspector-explainer">${this.definitionError ? "The tool catalog could not be loaded. Refresh to retry." : "Loading registered tools…"}</p>`;
      this.root.querySelector("#inspector-setup").innerHTML = this.definition ? `<div class="json-label">MODEL SETTINGS</div><pre class="inspector-json">${json({ model: this.definition.model, runner: this.definition.runner, framework: this.definition.framework, model_url: this.definition.model_url, context_tokens: this.definition.context_tokens, max_output_tokens: this.definition.max_output_tokens, temperature: this.definition.temperature })}</pre><div class="json-label">SCOPE CHECK</div><pre class="inspector-json">${json(this.definition.scope_check)}</pre><div class="json-label">OUR APP’S SYSTEM PROMPT</div><pre class="inspector-json system-prompt">${escape(this.definition.system_prompt)}</pre>` : "";
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
