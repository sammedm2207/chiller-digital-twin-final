/* =========================================================
   Chiller IoT Monitoring System — Frontend Logic
   Vanilla JS. No frameworks. SSE for real-time updates.
   ========================================================= */

const API = {
  latest: "/api/latest",
  history: "/api/history",
  alarms: "/api/alarms",
  config: "/api/config",
  stream: "/api/stream",
  exportExcel: "/api/export/excel",
  demoMode: "/api/config/demo_mode",
};

let CFG = null;                 // cached /api/config response
let liveChart = null;           // Chart.js instance for the dashboard live graph
let liveRange = "1min";
let analyticsRange = "1hour";
let analyticsCharts = {};       // { COP: chart, Cap: chart, Power: chart, DT: chart, Temps: chart }

const SENSOR_KEYS = ["T1", "T2", "T3", "T4", "T5", "T6"];
const SENSOR_COLORS = {
  T1: "#38d4e0", T2: "#ef4a5f", T3: "#f2b705",
  T4: "#33d17a", T5: "#3b82f6", T6: "#a78bfa",
};

/* ---------------------------------------------------------
   INIT
--------------------------------------------------------- */
document.addEventListener("DOMContentLoaded", async () => {
  setupNav();
  setupLiveRangeButtons();
  setupAnalyticsRangeButtons();
  setupReportButtons();
  setupDemoToggle();
  tickClock();
  setInterval(tickClock, 1000);

  await loadConfig();
  buildMachineInfo();
  buildTempCards();
  buildVCC();
  buildWaterFlow();
  buildSettingsView();
  initLiveChart();

  await refreshLatest();
  await loadLiveHistory();

  connectSSE();

  // Fallback polling in case SSE drops (keeps status chips accurate)
  setInterval(refreshLatest, 5000);
});

/* ---------------------------------------------------------
   NAVIGATION
--------------------------------------------------------- */
function setupNav() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const view = btn.dataset.view;
      document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
      document.getElementById("view-" + view).classList.add("active");

      if (view === "analytics") loadAnalytics();
      if (view === "reports") loadRecentTable();
      if (window.ChillerTwin && typeof window.ChillerTwin.setActive === "function") {
        window.ChillerTwin.setActive(view === "twin");
      }
    });
  });
}

function tickClock() {
  const now = new Date();
  document.getElementById("clock").textContent = now.toLocaleTimeString("en-GB");
}

/* ---------------------------------------------------------
   CONFIG
--------------------------------------------------------- */
async function loadConfig() {
  const res = await fetch(API.config);
  CFG = await res.json();
  document.getElementById("institutionName").textContent = CFG.institution;
  document.getElementById("projectSubtitle").textContent = CFG.project_subtitle;
  document.title = CFG.project_title + " | " + CFG.institution;
  document.getElementById("demoToggle").checked = !!CFG.demo_mode;
  if (window.ChillerTwin && typeof window.ChillerTwin.setConfig === "function") {
    window.ChillerTwin.setConfig(CFG);
  }
}

function buildMachineInfo() {
  const grid = document.getElementById("machineInfoGrid");
  const info = CFG.machine_info;
  const labels = {
    manufacturer: "Manufacturer", model: "Model", cooling_capacity: "Cooling Capacity",
    refrigerant: "Refrigerant", power_supply: "Power Supply", rated_current: "Rated Current",
    machine_id: "Machine ID",
  };
  grid.innerHTML = "";
  Object.keys(labels).forEach((k) => {
    grid.innerHTML += `<div class="info-item"><div class="k">${labels[k]}</div><div class="v">${info[k] ?? "N/A"}</div></div>`;
  });
}

function buildTempCards() {
  const grid = document.getElementById("tempGrid");
  grid.innerHTML = "";
  SENSOR_KEYS.forEach((key) => {
    const label = CFG.sensor_short_labels[key] || key;
    grid.innerHTML += `
      <div class="temp-card status-normal" id="tempCard-${key}">
        <div class="tc-id">${key}</div>
        <div class="tc-name">${label}</div>
        <div class="tc-value" id="tempVal-${key}">N/A</div>
        <div class="tc-time" id="tempTime-${key}">--:--:--</div>
      </div>`;
  });
}

function buildSettingsView() {
  document.getElementById("settingsMachineInfo").innerHTML =
    document.getElementById("machineInfoGrid").innerHTML;

  const sMap = document.getElementById("settingsSensorMap");
  sMap.innerHTML = "";
  Object.entries(CFG.sensor_labels).forEach(([k, v]) => {
    sMap.innerHTML += `<div class="mapping-row"><span class="m-key">${k}</span><span class="m-val">${v}</span></div>`;
  });

  const th = document.getElementById("settingsThresholds");
  th.innerHTML = "";
  Object.entries(CFG.thresholds).forEach(([k, v]) => {
    th.innerHTML += `<div class="mapping-row"><span class="m-key">${k.replace(/_/g, " ")}</span><span class="m-val">${v}</span></div>`;
  });

  const c = document.getElementById("settingsConstants");
  c.innerHTML = `
    <div class="mapping-row"><span class="m-key">Water Density</span><span class="m-val">${CFG.water_density} kg/m&sup3;</span></div>
    <div class="mapping-row"><span class="m-key">Water Cp</span><span class="m-val">${CFG.water_cp} kJ/kg&middot;K</span></div>
    <div class="mapping-row"><span class="m-key">ESP32 Timeout</span><span class="m-val">${CFG.esp32_timeout} s</span></div>
  `;
}

function setupDemoToggle() {
  document.getElementById("demoToggle").addEventListener("change", async (e) => {
    await fetch(API.demoMode, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: e.target.checked }),
    });
  });
}

/* ---------------------------------------------------------
   VAPOR COMPRESSION CYCLE ANIMATION (pure SVG/CSS, no images)
   Layout: Condenser (top, w/ fans) -> Dryer -> Expansion Valve
   -> Evaporator (bottom-left, w/ water in/out) -> Accumulator
   -> Compressor (bottom-right) -> back to Condenser.
   Red pipe  = hot high-pressure discharge gas (Compressor -> Condenser)
   Blue pipe = everything else (liquid line + low-pressure return gas)
--------------------------------------------------------- */
function buildVCC() {
  const wrap = document.getElementById("vccWrap");
  wrap.innerHTML = `
  <svg class="cycle-svg" viewBox="0 0 720 400" xmlns="http://www.w3.org/2000/svg">

    <!-- ===== STATIC PIPE TRACKS ===== -->
    <!-- Hot discharge line: compressor top -> condenser bottom -->
    <path class="pipe-hot" d="M 620 260 V 110" />
    <!-- Cold line part A: condenser outlet -> dryer -> expansion valve -> evaporator inlet -->
    <path class="pipe-cold" d="M 450 110 V 190 M 450 216 V 226 L 200 226 V 270" />
    <!-- Cold line part B: evaporator outlet -> accumulator -> compressor suction -->
    <path class="pipe-cold" d="M 340 300 H 560" />

    <!-- ===== ANIMATED FLOW OVERLAYS ===== -->
    <path id="flow-hot" class="flow-hot" d="M 620 260 V 110" />
    <path id="flow-cold-a" class="flow-cold" d="M 450 110 V 190 M 450 216 V 226 L 200 226 V 270" />
    <path id="flow-cold-b" class="flow-cold" d="M 340 300 H 560" />

    <!-- ===== CONDENSER (top) ===== -->
    <g id="node-condenser">
      <rect x="420" y="40" width="220" height="70" rx="8" class="cycle-node" />
      <g class="fan-spin" id="fanSpin1" transform="translate(470,75)">
        <circle r="17" fill="none" stroke="#7fb3c9" stroke-width="2"/>
        <path d="M -17 0 H 17 M 0 -17 V 17" stroke="#7fb3c9" stroke-width="2"/>
      </g>
      <g class="fan-spin" id="fanSpin2" transform="translate(540,75)">
        <circle r="17" fill="none" stroke="#7fb3c9" stroke-width="2"/>
        <path d="M -17 0 H 17 M 0 -17 V 17" stroke="#7fb3c9" stroke-width="2"/>
      </g>
      <text x="530" y="128" text-anchor="middle" class="cycle-box-label">CONDENSER</text>
    </g>

    <!-- ===== DRYER ===== -->
    <g id="node-dryer">
      <rect x="420" y="140" width="60" height="26" rx="4" class="cycle-node" />
      <text x="450" y="182" text-anchor="middle" class="cycle-sub-label">Dryer</text>
    </g>

    <!-- Condenser outlet / T3 sensor -->
    <circle cx="450" cy="120" r="11" class="sensor-badge sensor-ref" id="sb-T3"/>
    <text x="450" y="124" text-anchor="middle" class="sensor-badge-text">T3</text>
    <text x="415" y="105" text-anchor="end" class="cycle-value-label" id="vcc-T3">N/A</text>

    <!-- ===== EXPANSION VALVE ===== -->
    <g id="node-valve">
      <path d="M 435 190 L 465 190 L 450 216 Z" class="valve-icon" />
      <text x="450" y="245" text-anchor="middle" class="cycle-sub-label">Expansion Valve</text>
    </g>

    <!-- T4 sensor: evaporator inlet -->
    <circle cx="300" cy="226" r="11" class="sensor-badge sensor-ref" id="sb-T4"/>
    <text x="300" y="230" text-anchor="middle" class="sensor-badge-text">T4</text>
    <text x="300" y="210" text-anchor="middle" class="cycle-value-label" id="vcc-T4">N/A</text>

    <!-- ===== EVAPORATOR (bottom-left) ===== -->
    <g id="node-evaporator">
      <rect x="160" y="270" width="180" height="50" rx="25" class="cycle-node" />
      <text x="250" y="340" text-anchor="middle" class="cycle-box-label">EVAPORATOR</text>
    </g>

    <!-- Water In / Water Out sensors above evaporator -->
    <text x="200" y="228" text-anchor="middle" class="water-label">Water In</text>
    <circle cx="200" cy="245" r="10" class="sensor-badge sensor-water" id="sb-T5"/>
    <text x="200" y="249" text-anchor="middle" class="sensor-badge-text">T5</text>
    <text x="200" y="264" text-anchor="middle" class="cycle-value-label water-value" id="vcc-T5">N/A</text>

    <text x="290" y="228" text-anchor="middle" class="water-label">Water Out</text>
    <circle cx="290" cy="245" r="10" class="sensor-badge sensor-water" id="sb-T6"/>
    <text x="290" y="249" text-anchor="middle" class="sensor-badge-text">T6</text>
    <text x="290" y="264" text-anchor="middle" class="cycle-value-label water-value" id="vcc-T6">N/A</text>

    <!-- ===== ACCUMULATOR ===== -->
    <g id="node-accumulator">
      <ellipse cx="420" cy="300" rx="18" ry="24" class="cycle-node" />
      <text x="420" y="345" text-anchor="middle" class="cycle-sub-label">Accumulator</text>
    </g>

    <!-- T1 sensor: compressor suction -->
    <circle cx="500" cy="300" r="11" class="sensor-badge sensor-ref" id="sb-T1"/>
    <text x="500" y="304" text-anchor="middle" class="sensor-badge-text">T1</text>
    <text x="500" y="284" text-anchor="middle" class="cycle-value-label" id="vcc-T1">N/A</text>

    <!-- ===== COMPRESSOR (bottom-right) ===== -->
    <g id="node-compressor">
      <rect x="560" y="260" width="120" height="90" rx="10" class="cycle-node" />
      <g id="compressorSpin" class="compressor-spin" transform="translate(620,300)">
        <circle r="15" fill="none" stroke="#38d4e0" stroke-width="3" stroke-dasharray="6 6"/>
      </g>
      <text x="620" y="368" text-anchor="middle" class="cycle-box-label">COMPRESSOR</text>
    </g>

    <!-- T2 sensor: compressor discharge -->
    <circle cx="620" cy="240" r="11" class="sensor-badge sensor-ref" id="sb-T2"/>
    <text x="620" y="244" text-anchor="middle" class="sensor-badge-text">T2</text>
    <text x="655" y="244" text-anchor="start" class="cycle-value-label" id="vcc-T2">N/A</text>

    <text x="360" y="20" text-anchor="middle" class="cycle-sub-label" id="vccStatusLabel">CYCLE STATUS: --</text>
  </svg>`;
}

function updateVCC(reading, alarmSeverity) {
  const map = { T1: "vcc-T1", T2: "vcc-T2", T3: "vcc-T3", T4: "vcc-T4", T5: "vcc-T5", T6: "vcc-T6" };
  Object.entries(map).forEach(([k, id]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = fmtVal(reading[k], "°C");
  });

  const running = !!reading.compressor_status;

  const spin = document.getElementById("compressorSpin");
  if (spin) spin.classList.toggle("stopped", !running);
  ["fanSpin1", "fanSpin2"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("stopped", !running);
  });

  ["flow-hot", "flow-cold-a", "flow-cold-b"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("stopped", !running);
  });

  const label = document.getElementById("vccStatusLabel");
  if (label) label.textContent = "CYCLE STATUS: " + (running ? "RUNNING" : "STOPPED");

  ["node-compressor", "node-condenser", "node-valve", "node-evaporator", "node-dryer", "node-accumulator"].forEach((gid) => {
    const g = document.getElementById(gid);
    if (!g) return;
    const shape = g.querySelector("rect, ellipse");
    if (!shape) return;
    shape.classList.remove("running", "alarm-WARNING", "alarm-CRITICAL");
    if (alarmSeverity === "CRITICAL") shape.classList.add("alarm-CRITICAL");
    else if (alarmSeverity === "WARNING") shape.classList.add("alarm-WARNING");
    else if (running) shape.classList.add("running");
  });
}

/* ---------------------------------------------------------
   CHILLED WATER FLOW ANIMATION
--------------------------------------------------------- */
function buildWaterFlow() {
  const wrap = document.getElementById("waterWrap");
  wrap.innerHTML = `
  <svg class="cycle-svg" viewBox="0 0 640 260" xmlns="http://www.w3.org/2000/svg">
    <path class="pipe" d="M 110 50 H 530" />
    <path class="pipe" d="M 530 50 V 200" />
    <path class="pipe" d="M 530 200 H 110" />
    <path class="pipe" d="M 110 200 V 50" />

    <path id="wflow-top" class="flow-dash" d="M 110 50 H 530" />
    <path id="wflow-right" class="flow-dash" d="M 530 50 V 200" />
    <path id="wflow-bottom" class="flow-dash" d="M 530 200 H 110" />
    <path id="wflow-left" class="flow-dash reverse" d="M 110 200 V 50" />

    <g transform="translate(110,50)">
      <rect x="-60" y="-28" width="120" height="56" rx="10" class="cycle-node running"/>
      <text x="0" y="4" text-anchor="middle" class="cycle-box-label">EVAPORATOR</text>
      <text x="0" y="-38" text-anchor="middle" class="cycle-sub-label">Water Return (T6)</text>
      <text x="0" y="38" text-anchor="middle" class="cycle-value-label" id="wf-T6-in">N/A</text>
    </g>

    <g transform="translate(530,50)">
      <rect x="-70" y="-28" width="140" height="56" rx="10" class="cycle-node running"/>
      <text x="0" y="4" text-anchor="middle" class="cycle-box-label">CHW OUTLET</text>
      <text x="0" y="-38" text-anchor="middle" class="cycle-sub-label">Water Outlet (T5)</text>
      <text x="0" y="38" text-anchor="middle" class="cycle-value-label" id="wf-T5-out">N/A</text>
    </g>

    <g transform="translate(530,200)">
      <rect x="-45" y="-28" width="90" height="56" rx="10" class="cycle-node running"/>
      <text x="0" y="4" text-anchor="middle" class="cycle-box-label">LOAD</text>
      <text x="0" y="38" text-anchor="middle" class="cycle-sub-label">AHU / FCU</text>
    </g>

    <g transform="translate(110,200)">
      <rect x="-70" y="-28" width="140" height="56" rx="10" class="cycle-node running"/>
      <text x="0" y="4" text-anchor="middle" class="cycle-box-label">WATER RETURN</text>
      <text x="0" y="38" text-anchor="middle" class="cycle-sub-label">Flow</text>
      <text x="0" y="52" text-anchor="middle" class="cycle-value-label" id="wf-flow">N/A</text>
    </g>

    <text x="320" y="130" text-anchor="middle" class="cycle-sub-label">&Delta;T</text>
    <text x="320" y="148" text-anchor="middle" class="cycle-value-label" id="wf-dt">N/A</text>
  </svg>`;
}

function updateWaterFlow(reading) {
  setText("wf-T6-in", fmtVal(reading.T6, "°C"));
  setText("wf-T5-out", fmtVal(reading.T5, "°C"));
  setText("wf-flow", fmtVal(reading.flow_rate, "L/min"));
  setText("wf-dt", fmtVal(reading.delta_t, "°C"));

  const running = !!reading.compressor_status && (reading.flow_rate ?? 0) > 0;
  ["wflow-top", "wflow-right", "wflow-bottom", "wflow-left"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("stopped", !running);
  });
}

/* ---------------------------------------------------------
   SSE — real time updates
--------------------------------------------------------- */
function connectSSE() {
  const es = new EventSource(API.stream);
  es.onmessage = (evt) => {
    if (!evt.data || evt.data.startsWith(":")) return;
    try {
      const payload = JSON.parse(evt.data);
      if (payload.type === "reading") {
        renderReading(payload.data, payload.alarms || []);
        pushLivePoint(payload.data);
      }
    } catch (e) {
      console.error("SSE parse error", e);
    }
  };
  es.onerror = () => {
    // browser auto-reconnects EventSource; nothing else needed
  };
}

/* ---------------------------------------------------------
   RENDER A READING TO THE WHOLE DASHBOARD
--------------------------------------------------------- */
function renderReading(reading, alarms) {
  if (!reading) return;

  // Performance cards
  document.getElementById("copValue").textContent = fmtVal(reading.cop, "");
  document.getElementById("capValue").textContent = fmtVal(reading.cooling_capacity, "kW");
  document.getElementById("dtValue").textContent = fmtVal(reading.delta_t, "°C");
  document.getElementById("powerValue").textContent = fmtVal(reading.power_kw, "kW");
  document.getElementById("flowValue").textContent = fmtVal(reading.flow_rate, "L/min");
  document.getElementById("compValue").textContent = reading.compressor_status ? "RUNNING" : "STOPPED";

  const modeTag = reading.mode === "DEMO" ? "SIMULATED" : "CALCULATED";
  const tagClass = reading.mode === "DEMO" ? "tag demo" : "tag";
  document.getElementById("copTag").textContent = modeTag;
  document.getElementById("copTag").className = tagClass;
  document.getElementById("capTag").textContent = modeTag;
  document.getElementById("capTag").className = tagClass;

  // Temperature cards
  const worstSeverity = alarms.reduce((acc, a) => {
    if (a.severity === "CRITICAL") return "CRITICAL";
    if (a.severity === "WARNING" && acc !== "CRITICAL") return "WARNING";
    return acc;
  }, null);

  SENSOR_KEYS.forEach((key) => {
    const valEl = document.getElementById("tempVal-" + key);
    const timeEl = document.getElementById("tempTime-" + key);
    const cardEl = document.getElementById("tempCard-" + key);
    if (!valEl) return;
    valEl.textContent = fmtVal(reading[key], "°C");
    timeEl.textContent = reading.timestamp ? new Date(reading.timestamp).toLocaleTimeString("en-GB") : "--:--:--";

    let status = "normal";
    const relevantAlarm = alarms.find((a) => a.message.includes(sensorAlarmHint(key)));
    if (relevantAlarm) status = relevantAlarm.severity === "CRITICAL" ? "critical" : "warning";
    cardEl.className = "temp-card status-" + status;
  });

  // VCC & water flow
  updateVCC(reading, worstSeverity);
  updateWaterFlow(reading);

  // Alarms panel
  renderAlarms(alarms);

  // Mode pill
  const pill = document.getElementById("modePill");
  if (reading.mode === "DEMO") {
    pill.textContent = "● DEMO MODE";
    pill.className = "mode-pill demo";
  } else {
    pill.textContent = "● LIVE MODE";
    pill.className = "mode-pill live";
  }

  // Machine status
  setMachineStatusBadge(reading.machine_status);

  document.getElementById("lastUpdate").textContent =
    reading.timestamp ? new Date(reading.timestamp).toLocaleTimeString("en-GB") : "--:--:--";

  // 3D Digital Twin (reuses this same computed reading — no duplicate calculations)
  if (window.ChillerTwin && typeof window.ChillerTwin.updateReading === "function") {
    window.ChillerTwin.updateReading(reading, alarms);
  }
}

function sensorAlarmHint(key) {
  const hints = {
    T2: "Compressor Discharge", T3: "Condenser Outlet",
  };
  return hints[key] || "___NOMATCH___";
}

function setMachineStatusBadge(status) {
  const el = document.getElementById("machineStatus");
  el.textContent = status || "--";
  const map = {
    RUNNING: "badge-running", STOPPED: "badge-stopped",
    WARNING: "badge-warning", FAULT: "badge-fault", OFFLINE: "badge-offline",
  };
  el.className = "badge " + (map[status] || "badge-neutral");
}

function renderAlarms(alarms) {
  const list = document.getElementById("alarmList");
  if (!alarms || alarms.length === 0) {
    list.innerHTML = `<div class="alarm-empty">No active alarms &mdash; system normal</div>`;
    return;
  }
  list.innerHTML = alarms.map((a) => `
    <div class="alarm-item sev-${a.severity}">
      <div class="alarm-sev sev-${a.severity}">${a.severity}</div>
      <div class="alarm-msg">${a.message}</div>
      <div class="alarm-val">${a.value}</div>
      <div class="alarm-time">${a.time}</div>
    </div>`).join("");
}

/* ---------------------------------------------------------
   /api/latest polling (status chips, initial paint)
--------------------------------------------------------- */
async function refreshLatest() {
  try {
    const res = await fetch(API.latest);
    const data = await res.json();

    setChip("backendChip", true, "BACKEND", "ONLINE");
    setChip("esp32Chip", data.esp32_status === "CONNECTED", "ESP32", data.esp32_status);

    if (data.reading) {
      renderReading(data.reading, data.alarms || []);
    }
  } catch (e) {
    setChip("backendChip", false, "BACKEND", "OFFLINE");
  }
}

function setChip(id, ok, label, text) {
  const el = document.getElementById(id);
  el.innerHTML = `<span class="dot ${ok ? "dot-green" : "dot-red"}"></span> ${label}: <b>${text}</b>`;
}

/* ---------------------------------------------------------
   FORMAT HELPERS
--------------------------------------------------------- */
function fmtVal(v, unit) {
  if (v === null || v === undefined || Number.isNaN(v)) return "N/A";
  const num = typeof v === "number" ? v : parseFloat(v);
  if (Number.isNaN(num)) return "N/A";
  return `${num.toFixed(2)}${unit ? " " + unit : ""}`;
}
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/* ---------------------------------------------------------
   LIVE DASHBOARD TEMPERATURE CHART
--------------------------------------------------------- */
function initLiveChart() {
  const ctx = document.getElementById("liveTempChart").getContext("2d");
  liveChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: SENSOR_KEYS.map((k) => ({
        label: k,
        data: [],
        borderColor: SENSOR_COLORS[k],
        backgroundColor: "transparent",
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.3,
      })),
    },
    options: chartOptions(),
  });
}

function chartOptions() {
  return {
    responsive: true,
    animation: false,
    interaction: { mode: "index", intersect: false },
    scales: {
      x: { ticks: { color: "#5c7086", maxTicksLimit: 8 }, grid: { color: "#132234" } },
      y: { ticks: { color: "#5c7086" }, grid: { color: "#132234" } },
    },
    plugins: {
      legend: { labels: { color: "#9fb3c8", boxWidth: 12, font: { size: 10.5 } } },
    },
  };
}

function setupLiveRangeButtons() {
  document.querySelectorAll("#liveRangeButtons button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      document.querySelectorAll("#liveRangeButtons button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      liveRange = btn.dataset.range;
      await loadLiveHistory();
    });
  });
}

async function loadLiveHistory() {
  const res = await fetch(`${API.history}?range=${liveRange}&limit=${CFG?.max_live_points || 720}`);
  const data = await res.json();
  const labels = data.rows.map((r) => new Date(r.timestamp).toLocaleTimeString("en-GB"));
  liveChart.data.labels = labels;
  SENSOR_KEYS.forEach((k, i) => {
    liveChart.data.datasets[i].data = data.rows.map((r) => r[k]);
  });
  liveChart.update();
}

function pushLivePoint(reading) {
  if (!liveChart) return;
  const maxPts = CFG?.max_live_points || 720;
  liveChart.data.labels.push(new Date(reading.timestamp).toLocaleTimeString("en-GB"));
  SENSOR_KEYS.forEach((k, i) => {
    liveChart.data.datasets[i].data.push(reading[k]);
  });
  if (liveChart.data.labels.length > maxPts) {
    liveChart.data.labels.shift();
    liveChart.data.datasets.forEach((ds) => ds.data.shift());
  }
  liveChart.update("none");
}

/* ---------------------------------------------------------
   ANALYTICS VIEW
--------------------------------------------------------- */
function setupAnalyticsRangeButtons() {
  document.querySelectorAll("#analyticsRangeButtons button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#analyticsRangeButtons button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      analyticsRange = btn.dataset.range;
      loadAnalytics();
    });
  });
}

async function loadAnalytics() {
  const res = await fetch(`${API.history}?range=${analyticsRange}&limit=5000`);
  const data = await res.json();
  const rows = data.rows;
  const labels = rows.map((r) => new Date(r.timestamp).toLocaleString("en-GB"));

  buildOrUpdateChart("COP", "chartCOP", labels, [{ label: "COP", data: rows.map((r) => r.cop), color: "#38d4e0" }]);
  buildOrUpdateChart("Cap", "chartCap", labels, [{ label: "Cooling Capacity (kW)", data: rows.map((r) => r.cooling_capacity), color: "#33d17a" }]);
  buildOrUpdateChart("Power", "chartPower", labels, [{ label: "Power (kW)", data: rows.map((r) => r.power_kw), color: "#f2b705" }]);
  buildOrUpdateChart("DT", "chartDT", labels, [{ label: "Water ΔT (°C)", data: rows.map((r) => r.delta_t), color: "#3b82f6" }]);
  buildOrUpdateChart("Temps", "chartTemps", labels, SENSOR_KEYS.map((k) => ({
    label: k, data: rows.map((r) => r[k]), color: SENSOR_COLORS[k],
  })));
}

function buildOrUpdateChart(key, canvasId, labels, series) {
  if (analyticsCharts[key]) {
    analyticsCharts[key].data.labels = labels;
    analyticsCharts[key].data.datasets.forEach((ds, i) => { ds.data = series[i].data; });
    analyticsCharts[key].update();
    return;
  }
  const ctx = document.getElementById(canvasId).getContext("2d");
  analyticsCharts[key] = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: series.map((s) => ({
        label: s.label, data: s.data, borderColor: s.color, backgroundColor: "transparent",
        borderWidth: 2, pointRadius: 0, tension: 0.25,
      })),
    },
    options: chartOptions(),
  });
}

/* ---------------------------------------------------------
   REPORTS VIEW
--------------------------------------------------------- */
function setupReportButtons() {
  document.querySelectorAll(".report-buttons .btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      window.location.href = `${API.exportExcel}?range=${btn.dataset.range}`;
    });
  });

  document.getElementById("btnCustomDownload").addEventListener("click", () => {
    const start = document.getElementById("customStart").value;
    const end = document.getElementById("customEnd").value;
    if (!start || !end) {
      alert("Please select both a start and end date/time.");
      return;
    }
    window.location.href = `${API.exportExcel}?range=custom&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
  });
}

async function loadRecentTable() {
  const res = await fetch(`${API.history}?range=1hour&limit=50`);
  const data = await res.json();
  const rows = [...data.rows].reverse();
  const tbody = document.getElementById("recentTableBody");
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td>${new Date(r.timestamp).toLocaleTimeString("en-GB")}</td>
      <td>${fmtCell(r.T1)}</td><td>${fmtCell(r.T2)}</td><td>${fmtCell(r.T3)}</td>
      <td>${fmtCell(r.T4)}</td><td>${fmtCell(r.T5)}</td><td>${fmtCell(r.T6)}</td>
      <td>${fmtCell(r.flow_rate)}</td><td>${fmtCell(r.power_kw)}</td>
      <td>${fmtCell(r.cooling_capacity)}</td><td>${fmtCell(r.delta_t)}</td><td>${fmtCell(r.cop)}</td>
    </tr>`).join("");
}

function fmtCell(v) {
  return v === null || v === undefined ? "N/A" : Number(v).toFixed(2);
}
