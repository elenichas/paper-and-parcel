"use strict";

(() => {
  const escape = value => String(value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
  const json = value => escape(JSON.stringify(value, null, 2));
  const money = value => new Intl.NumberFormat("en-GB", {style:"currency",currency:"GBP"}).format(Number(value));
  const modes = {
    report: {label:"Report chain", question:"Generate the October 2026 shop report.", description:"Four record reads run in parallel. Their results join before the model writes a structured report.", concepts:"RunnableSequence · RunnableParallel · Structured output · Pydantic"},
    sql: {label:"SQL agent", question:"Which products generated the most revenue in October?", description:"The agent inspects table schemas, writes a read-only SQL query, and answers from its results.", concepts:"LangChain agent · SQLite · Tool calling · Pydantic"},
    chart: {label:"Pandas charts", question:"Show October revenue by product as a bar chart.", description:"The agent chooses a pandas aggregation. Python calculates the values, validates a ChartSpec, and the browser draws it.", concepts:"LangChain agent · pandas · ChartSpec · Pydantic"},
  };
  const nodeInfo = {
    classify:["Classify","Structured scope check"], report:["Report","RunnableSequence"], sql:["SQL","LangChain agent"],
    chart:["Chart","pandas tools"], guidance:["Guide","Supported questions"], validate:["Validate","Pydantic"], respond:["Respond","JSON → frontend"],
  };

  window.LearningLab = class LearningLab {
    constructor(inspector) {
      this.inspector = inspector;
      this.feature = "report";
      this.question = modes.report.question;
      this.busy = false;
      this.result = null;
      this.error = "";
      this.status = "Ready";
      this.nodes = new Map();
      this.definition = null;
      this.controller = null;
    }

    async loadDefinition() {
      try {
        const response = await fetch("/api/learning/definition");
        if (!response.ok) throw new Error("Learning setup is unavailable.");
        this.definition = await response.json();
      } catch (error) { this.setupError = error.message; }
      this.refresh();
    }

    mount(root) {
      this.root = root;
      root.innerHTML = `<div class="learning-layout"><div class="learning-main">
        <section class="card lab-controls"><div class="card-header"><h2>Try a course concept</h2><button type="button" class="text-button" data-inspector-open="trace">Inspect execution</button></div>
          <div class="lab-mode-switch segmented" role="group" aria-label="Learning feature">${Object.entries(modes).map(([id,mode])=>`<button type="button" data-lab-mode="${id}" aria-pressed="${id===this.feature}">${mode.label}</button>`).join("")}</div>
          <p id="lab-description" class="lab-description"></p><p id="lab-concepts" class="lab-concepts"></p>
          <form id="learning-form"><label for="learning-question">Question</label><textarea id="learning-question" maxlength="2000" rows="3" required aria-describedby="lab-description"></textarea>
            <div class="lab-examples" id="lab-examples"></div><div class="lab-actions"><button type="submit" class="primary-button" id="learning-run">Run analysis</button><button type="button" id="learning-stop" hidden>Stop</button><span id="learning-status" role="status"></span></div>
          </form><p class="lab-dataset">Sample records: October 2026. Each learning run starts a new conversation.</p>
        </section>
        <div id="learning-result"></div>
        <section class="card"><div class="card-header"><h2>Workflow</h2><span class="lab-caption">Explicit LangGraph StateGraph</span></div><div id="learning-graph" class="learning-graph"></div></section>
        <details class="card lab-terminal"><summary>See the same events in the backend</summary><div><p>The app terminal prints each event with its request ID. A local JSONL copy is kept in <code>.runtime/events.jsonl</code>.</p><pre class="inspector-json">tail -f .runtime/events.jsonl</pre><p>The graph, chains, tool calls, JSON parsing, and validation shown here are real execution events.</p></div></details>
      </div></div>`;
      this.inspector.contextFeature = this.feature;
      this.inspector.refresh();
      root.querySelector("#learning-question").value = this.question;
      root.querySelector("#learning-question").addEventListener("input", event => { this.question=event.target.value; });
      root.querySelectorAll("[data-lab-mode]").forEach(button=>button.addEventListener("click",()=>{
        if(this.busy)return;
        this.feature=button.dataset.labMode;this.question=modes[this.feature].question;
        this.result=null;this.error="";this.nodes.clear();this.status="Ready";
        this.inspector.contextFeature=this.feature;this.inspector.refresh();
        root.querySelector("#learning-question").value=this.question;
        this.refresh();
      }));
      root.querySelector("#learning-form").addEventListener("submit",event=>{event.preventDefault();this.run();});
      root.querySelector("#learning-stop").addEventListener("click",()=>this.controller?.abort());
      root.querySelector("#lab-examples").addEventListener("click",event=>{
        const button=event.target.closest("[data-lab-example]");
        if(button&&!this.busy){this.question=button.dataset.labExample;root.querySelector("#learning-question").value=this.question;}
      });
      this.refresh();
    }

    refresh() {
      if(!this.root?.isConnected || !this.root.querySelector("#learning-result"))return;
      const mode=modes[this.feature];
      this.root.querySelector("#lab-description").textContent=mode.description;
      this.root.querySelector("#lab-concepts").textContent=mode.concepts;
      this.root.querySelectorAll("[data-lab-mode]").forEach(button=>{button.disabled=this.busy;button.setAttribute("aria-pressed",String(button.dataset.labMode===this.feature));});
      this.root.querySelector("#learning-question").disabled=this.busy;
      this.root.querySelector("#learning-question").readOnly=this.feature==="report";
      this.root.querySelector("#learning-run").disabled=this.busy||!!this.setupError;
      this.root.querySelector("#learning-stop").hidden=!this.busy;
      this.root.querySelector("#learning-status").textContent=this.setupError||this.status;
      const examples=this.feature==="sql"?["Which products generated the most revenue in October?","Which invoices are overdue, and how much is owed?"]:this.feature==="chart"?["Show October revenue by product as a bar chart.","Show daily October revenue as a line chart.","Compare October units sold by product."]:[];
      this.root.querySelector("#lab-examples").innerHTML=examples.map(question=>`<button type="button" data-lab-example="${escape(question)}" ${this.busy?"disabled":""}>${escape(question)}</button>`).join("");
      const node=name=>{const [title,subtitle]=nodeInfo[name];const state=this.nodes.get(name)||"pending";const label={pending:"Pending",running:"Running",done:"Completed",skipped:"Not selected",failed:"Failed",stopped:"Stopped"}[state];return `<span class="workflow-node ${state}"><strong>${title}</strong><small>${subtitle}</small><span class="workflow-state">${label}</span></span>`;};
      this.root.querySelector("#learning-graph").innerHTML=this.definition?`<div class="workflow-row">${node("classify")}</div><span class="workflow-arrow" aria-hidden="true">↓</span><div class="workflow-branches">${this.definition.graph.edges.filter(edge=>edge.source==="classify").map(edge=>node(edge.target)).join("")}</div><span class="workflow-arrow" aria-hidden="true">↓</span><div class="workflow-row">${node("validate")}<span aria-hidden="true">→</span>${node("respond")}</div>`:`<p class="lab-description">${escape(this.setupError||"Loading the compiled graph…")}</p>`;
      this.root.querySelector("#learning-result").innerHTML=this.error?`<div class="error-banner" role="alert">${escape(this.error)}</div>`:this.result?this.resultHTML(this.result):`<section class="card lab-placeholder"><h2>Your result appears here</h2><p>Choose an action and run it. Follow its execution in the inspector.</p></section>`;
    }

    async run() {
      if(this.busy||!this.question.trim())return;
      this.busy=true;this.result=null;this.error="";this.nodes.clear();this.status="Starting…";this.refresh();
      const runId=this.inspector.start(this.question,[],this.feature);
      const controller=new AbortController();this.controller=controller;
      let completed=false;
      const handle=event=>{
        this.inspector.record(runId,event);
        if(event.type==="graph_node") {this.nodes.set(event.node,event.state==="start"?"running":"done");this.status=`${event.node}: ${event.state==="start"?"running":"completed"}`;}
        if(event.type==="graph_route"){for(const name of ["report","sql","chart","guidance"])if(name!==event.to)this.nodes.set(name,"skipped");}
        if(event.type==="status")this.status=event.message;
        if(event.type==="tool_start")this.status=`Running ${event.name}…`;
        if(event.type==="answer"){completed=true;this.result=event.artifact;this.status=`Completed in ${event.duration_seconds}s`;}
        if(event.type==="error")throw new Error(event.message);
        this.refresh();
      };
      try {
        const response=await fetch("/api/learning/stream",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({feature:this.feature,message:this.question}),signal:controller.signal});
        if(!response.ok)throw new Error(response.status===422?"Enter a question under 2,000 characters.":"The learning workflow is unavailable.");
        const reader=response.body.getReader(),decoder=new TextDecoder();let buffer="";
        try {
          while(true){
            const {done,value}=await reader.read();buffer+=done?decoder.decode():decoder.decode(value,{stream:true});let boundary;
            while((boundary=buffer.indexOf("\n\n"))!==-1){const block=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const payload=block.split("\n").filter(line=>line.startsWith("data: ")).map(line=>line.slice(6)).join("\n");if(payload)handle(JSON.parse(payload));}
            if(done)break;
          }
        } finally {reader.releaseLock();}
        if(!completed)throw new Error("The analysis ended before a validated result arrived. Try again.");
      } catch(error){
        for(const [name,state] of this.nodes)if(state==="running")this.nodes.set(name,error.name==="AbortError"?"stopped":"failed");
        this.inspector.browserFailure(runId,error);this.error=error.name==="AbortError"?"Analysis stopped.":error.message;this.status=error.name==="AbortError"?"Stopped":"Failed";
      } finally {this.busy=false;this.controller=null;this.refresh();}
    }

    resultHTML(result) {
      const raw=`<details class="card lab-json"><summary>Validated result JSON</summary><pre class="inspector-json">${json(result)}</pre></details>`;
      if(result.kind==="guidance")return `<section class="card lab-result"><h2>Supported questions</h2><p>${escape(result.reply)}</p><ul>${result.suggested_questions.map(question=>`<li>${escape(question)}</li>`).join("")}</ul></section>${raw}`;
      if(result.kind==="report"){
        const metrics=[["Paid revenue",money(result.metrics.revenue_gbp)],["Profit",money(result.metrics.profit_gbp)],["Unpaid invoices",money(result.metrics.unpaid_gbp)],["Overdue invoices",money(result.metrics.overdue_gbp)],["Units sold",result.metrics.units_sold],["Products to restock",result.metrics.restock_count]];
        return `<section class="card lab-result"><div class="lab-result-heading"><h2>${escape(result.narrative.title)}</h2><span class="badge green">Validated</span></div><p class="lab-caption">October 2026 · Figures calculated from source records</p><div class="report-metrics">${metrics.map(([label,value])=>`<div><span>${label}</span><strong>${escape(value)}</strong></div>`).join("")}</div><h3>Model summary</h3><p>${escape(result.narrative.summary)}</p><h3>Suggested next steps</h3><ul>${result.narrative.next_steps.map(step=>`<li>${escape(step)}</li>`).join("")}</ul><p class="lab-caption">Profit excludes unpaid invoices and VAT. Invoice status is as of 3 November 2026.</p></section>${raw}`;
      }
      if(result.kind==="sql")return `<section class="card lab-result"><div class="lab-result-heading"><h2>Database answer</h2><span class="badge green">Validated</span></div><p class="lab-answer">${escape(result.answer)}</p><p class="lab-caption">SQLite snapshot: October sales and expenses; invoices as of 3 November 2026. Money is stored as integer pence.</p>${result.queries.map((query,index)=>`<h3>Query ${index+1}</h3><pre class="inspector-json">${escape(query.query)}</pre><div class="table-wrap" tabindex="0" role="region" aria-label="SQL query ${index+1} results"><table class="data-table"><caption class="sr-only">SQL query ${index+1} result</caption><thead><tr>${query.columns.map(column=>`<th scope="col">${escape(column)}</th>`).join("")}</tr></thead><tbody>${query.rows.map(row=>`<tr>${row.map((value,i)=>`<td>${escape(value==null?"—":query.columns[i].endsWith("_gbp")?money(value):value)}</td>`).join("")}</tr>`).join("")||`<tr><td colspan="${query.columns.length}">No rows returned. Only the stated sample period is available.</td></tr>`}</tbody></table></div>${query.truncated?"<p>First 100 rows shown.</p>":""}`).join("")}</section>${raw}`;
      if(result.kind==="chart")return `<section class="card lab-result"><div class="lab-result-heading"><h2>${escape(result.chart.title)}</h2><span class="badge green">Validated</span></div>${this.chartHTML(result.chart)}<p class="lab-answer">${escape(result.answer)}</p><details class="chart-data"><summary>Chart data and pandas operation</summary><p><code>${escape(result.operation)}</code></p><p>${result.input_rows} sales rows · ${result.source_files.map(escape).join(", ")}</p><table class="data-table"><caption class="sr-only">Values used to render the chart</caption><thead><tr><th scope="col">${escape(result.chart.grouping)}</th><th scope="col">${escape(result.chart.unit)}</th></tr></thead><tbody>${result.chart.labels.map((label,i)=>`<tr><td>${escape(label)}</td><td>${result.chart.unit==="GBP"?money(result.chart.values[i]):result.chart.values[i]}</td></tr>`).join("")}</tbody></table></details><p class="lab-caption">Paid October sales only. Dates without a recorded sale are not added.</p></section>${raw}`;
      return raw;
    }

    chartHTML(chart, titleId = "lab-chart-title") {
      const max=Math.max(...chart.values,1),fmt=value=>chart.unit==="GBP"?money(value):String(value);
      if(chart.kind==="bar")return `<div class="lab-bar-chart" role="img" aria-label="${escape(chart.title)}">${chart.labels.map((label,i)=>`<div class="lab-bar-row"><span>${escape(label)}</span><div class="bar-track"><div class="bar-fill" style="width:${chart.values[i]/max*100}%"></div></div><strong>${escape(fmt(chart.values[i]))}</strong></div>`).join("")}</div>`;
      const w=640,h=300,left=55,right=20,top=25,bottom=65;
      const dates=chart.labels.map(label=>Date.parse(label)),start=dates[0],span=Math.max(1,dates.at(-1)-start);
      const x=i=>left+(dates[i]-start)*(w-left-right)/span,y=value=>h-bottom-value/max*(h-top-bottom);
      const ticks=[0,.25,.5,.75,1].map(fraction=>`<line x1="${left}" y1="${y(max*fraction)}" x2="${w-right}" y2="${y(max*fraction)}" class="chart-grid"/><text x="${left-8}" y="${y(max*fraction)+4}" text-anchor="end">${escape(chart.unit==="GBP"?`£${(max*fraction).toFixed(0)}`:(max*fraction).toFixed(0))}</text>`).join("");
      return `<svg class="lab-line-chart" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="${escape(titleId)}"><title id="${escape(titleId)}">${escape(chart.title)}</title>${ticks}<polyline points="${chart.values.map((value,i)=>`${x(i)},${y(value)}`).join(" ")}" class="chart-line"/>${chart.values.map((value,i)=>`<circle cx="${x(i)}" cy="${y(value)}" r="4" class="chart-point"><title>${escape(chart.labels[i])}: ${escape(fmt(value))}</title></circle><text x="${x(i)}" y="${h-bottom+20}" transform="rotate(-40 ${x(i)} ${h-bottom+20})" text-anchor="end">${escape(chart.labels[i].slice(5))}</text>`).join("")}</svg>`;
    }
  };
})();
