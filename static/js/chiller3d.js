/* =========================================================
   chiller3d.js
   3D Digital Twin of the water chiller — Three.js, procedural
   geometry only (no Blender / .glb / .obj files required).

   Public API (window.ChillerTwin):
     setActive(bool)          - called when the "3D Digital Twin"
                                 nav tab becomes active/inactive
     setConfig(cfg)           - passes /api/config data
     updateReading(reading, alarms) - passes the SAME processed
                                 reading object app.js already
                                 receives over SSE. No values are
                                 recalculated here.

   If Three.js cannot be loaded (offline / blocked CDN), a 2D
   engineering-schematic fallback is shown instead and the rest
   of the dashboard is completely unaffected.
========================================================= */
(function () {
  "use strict";

  const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js";
  const ORBIT_URL = "https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js";
  const LOAD_TIMEOUT_MS = 9000;
  const REF_FLOW = 120; // L/min — reference used to normalize water particle speed

  /* ---------------------------------------------------------
     STATE
  --------------------------------------------------------- */
  const state = {
    active: false,
    initialized: false,
    initializing: false,
    fallback: false,
    cfg: null,
    reading: null,
    alarms: [],
    cutaway: false,
    showWater: true,
    showRefrigerant: true,
    showLabels: true,
    sequenceMode: null,      // 'water' | 'refrigerant' | 'presentation' | null
    sequenceTimer: null,
    reducedMotion: !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches),
  };

  // Populated once Three.js has loaded and the scene is built
  let renderer, scene, camera, controls, clock;
  let modelGroup, casingGroup, internalsGroup;
  let refrigerantParticles = [], waterParticles = [];
  let refrigerantCurve, waterLoopCurve;
  let raycaster, pointer;
  let clickableMeshes = [];
  let labelSprites = {};
  let componentMeshMap = {};
  let rafId = null;
  let resizeObserver = null;
  let selectedId = null;

  // DOM refs
  let canvasWrap, loadingEl, infoPanel, infoTitle, infoBody, infoClose;
  let seqBanner, seqStep, seqText;

  const COMPONENT_INFO = {
    compressor: { title: "Compressor", desc: "Raises refrigerant pressure and temperature by mechanical compression, driving flow around the refrigeration circuit." },
    condenser: { title: "Condenser", desc: "Rejects heat from the hot, high-pressure refrigerant gas to the surroundings, condensing it to a liquid." },
    valve: { title: "Expansion Valve", desc: "Throttles the high-pressure liquid refrigerant, sharply reducing its pressure and temperature before the evaporator." },
    filterDrier: { title: "Filter Drier", desc: "Removes moisture and contaminants from the liquid refrigerant before the expansion valve." },
    evaporator: { title: "Evaporator", desc: "Absorbs heat from the chilled water as the cold, low-pressure refrigerant evaporates, cooling the water." },
    accumulator: { title: "Suction Accumulator", desc: "Separates residual liquid from the low-pressure suction gas before it reaches the compressors." },
    waterIn: { title: "Chilled Water Inlet (Return)", desc: "Warm water returning from the building load enters the evaporator here to be cooled." },
    waterOut: { title: "Chilled Water Outlet (Supply)", desc: "Cooled water leaves the evaporator here and is pumped to the building load / AHU." },
    load: { title: "Load / AHU", desc: "Represents the air-handling unit or process load that absorbs heat from the chilled water supply, returning it warmer." },
  };

  const FLOW_STEPS = {
    water: [
      { id: "waterIn", text: "Chilled-water return: warm water re-enters the evaporator." },
      { id: "evaporator", text: "Refrigerant inside the evaporator absorbs heat from the water." },
      { id: "waterOut", text: "Chilled-water outlet: cooled water leaves the evaporator (supply)." },
      { id: "load", text: "Water flows to the Load / AHU, absorbing heat from the space." },
      { id: "waterIn", text: "Warmed water returns to the evaporator to be cooled again." },
    ],
    refrigerant: [
      { id: "compressor", text: "Compressor raises refrigerant pressure and temperature." },
      { id: "condenser", text: "Condenser rejects heat as refrigerant condenses to a liquid." },
      { id: "filterDrier", text: "Filter drier removes moisture and protects the expansion device." },
      { id: "valve", text: "Expansion valve reduces pressure and temperature." },
      { id: "evaporator", text: "Evaporator absorbs heat from the chilled water." },
      { id: "accumulator", text: "Accumulator protects the compressor from liquid carryover." },
      { id: "compressor", text: "Refrigerant vapor returns to the compressor to repeat the cycle." },
    ],
  };
  FLOW_STEPS.presentation = FLOW_STEPS.refrigerant.concat(FLOW_STEPS.water);

  /* ---------------------------------------------------------
     PUBLIC API
  --------------------------------------------------------- */
  window.ChillerTwin = { setActive, setConfig, updateReading: updateLiveData };

  /* ---------------------------------------------------------
     DOM WIRING (buttons exist immediately — no Three.js needed)
  --------------------------------------------------------- */
  document.addEventListener("DOMContentLoaded", () => {
    canvasWrap = document.getElementById("twinCanvasWrap");
    loadingEl = document.getElementById("twinLoading");
    infoPanel = document.getElementById("twinInfoPanel");
    infoTitle = document.getElementById("twinInfoTitle");
    infoBody = document.getElementById("twinInfoBody");
    infoClose = document.getElementById("twinInfoClose");
    seqBanner = document.getElementById("twinSequenceBanner");
    seqStep = document.getElementById("twinSeqStep");
    seqText = document.getElementById("twinSeqText");

    if (infoClose) infoClose.addEventListener("click", hideInfoPanel);

    buildReadoutGrid();
    wireToolbar();
  });

  function buildReadoutGrid() {
    const grid = document.getElementById("twinReadoutGrid");
    if (!grid) return;
    const items = [
      ["T1", "T1 Suction"], ["T2", "T2 Discharge"], ["T3", "T3 Cond. Outlet"],
      ["T4", "T4 Evap. Inlet"], ["T5", "T5 Water In"], ["T6", "T6 Water Out"],
      ["flow", "Flow Rate"], ["power", "Power"], ["current", "Comp. Current"],
      ["comp", "Compressor"], ["cap", "Cooling Cap."], ["dt", "Water ΔT"], ["cop", "COP"],
    ];
    grid.innerHTML = items.map(([id, label]) =>
      `<div class="twin-readout-item"><div class="k">${label}</div><div class="v" id="twin-val-${id}">N/A</div></div>`
    ).join("");
  }

  function wireToolbar() {
    const toolbar = document.getElementById("twinToolbar");
    if (!toolbar) return;
    toolbar.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      handleAction(btn.dataset.action, btn);
    });
  }

  function handleAction(action, btn) {
    switch (action) {
      case "reset": viewReset(); break;
      case "front": viewFront(); break;
      case "top": viewTop(); break;
      case "side": viewSide(); break;
      case "fit": viewFit(); break;
      case "cutaway": enableCutawayMode(!state.cutaway, btn); break;
      case "showInternal": enableCutawayMode(true); syncCutawayButton(); break;
      case "showExternal": enableCutawayMode(false); syncCutawayButton(); break;
      case "toggleWater": toggleShow("water", btn); break;
      case "toggleRefrigerant": toggleShow("refrigerant", btn); break;
      case "toggleLabels": toggleShow("labels", btn); break;
      case "followWater": followWaterFlow(btn); break;
      case "followRefrigerant": followRefrigerantFlow(btn); break;
      case "presentation": toggleSequence("presentation", btn); break;
      case "arview": handleARView(); break;
    }
  }

  function syncCutawayButton() {
    const b = document.getElementById("btnCutaway");
    if (b) b.classList.toggle("active-mode", state.cutaway);
  }

  /* ---------------------------------------------------------
     PUBLIC: setActive / setConfig / updateLiveData
  --------------------------------------------------------- */
  function setActive(isActive) {
    state.active = isActive;
    if (!isActive) { stopLoop(); return; }
    if (state.fallback) return;
    if (!state.initialized && !state.initializing) {
      state.initializing = true;
      ensureThree()
        .then(() => {
          initScene();
          state.initialized = true;
          state.initializing = false;
          startLoop();
          updateLiveData(state.reading, state.alarms);
        })
        .catch((err) => {
          console.warn("ChillerTwin: Three.js failed to load, using 2D fallback.", err);
          state.initializing = false;
          enableFallback();
        });
    } else if (state.initialized) {
      startLoop();
    }
  }

  function setConfig(cfg) {
    state.cfg = cfg;
  }

  function updateLiveData(reading, alarms) {
    if (reading) state.reading = reading;
    state.alarms = alarms || [];
    updateReadoutGridValues(state.reading);
    if (state.initialized) {
      updateLabelValues();
      updateNodeAlarmHighlighting();
    }
    if (state.fallback) updateFallbackReading(state.reading);
    if (selectedId) refreshInfoPanel(selectedId);
  }

  function updateReadoutGridValues(r) {
    if (!r) return;
    ["T1", "T2", "T3", "T4", "T5", "T6"].forEach((k) => setReadout(k, fmt(r[k], "°C")));
    setReadout("flow", fmt(r.flow_rate, "L/min"));
    setReadout("power", fmt(r.power_kw, "kW"));
    setReadout("current", fmt(r.compressor_current, "A"));
    setReadout("comp", r.compressor_status ? "RUNNING" : "STOPPED");
    setReadout("cap", fmt(r.cooling_capacity, "kW"));
    setReadout("dt", fmt(r.delta_t, "°C"));
    setReadout("cop", r.cop === null || r.cop === undefined ? "N/A" : Number(r.cop).toFixed(2));
  }

  function setReadout(id, text) {
    const el = document.getElementById("twin-val-" + id);
    if (el) el.textContent = text;
  }

  function fmt(v, unit) {
    if (v === null || v === undefined) return "N/A";
    const n = Number(v);
    if (Number.isNaN(n)) return "N/A";
    return n.toFixed(2) + (unit ? " " + unit : "");
  }

  /* ---------------------------------------------------------
     LOAD THREE.JS (graceful fallback if it fails)
  --------------------------------------------------------- */
  function ensureThree() {
    if (window.THREE && window.THREE.OrbitControls) return Promise.resolve();
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout loading Three.js")), LOAD_TIMEOUT_MS));
    const load = loadScript(THREE_URL).then(() => loadScript(ORBIT_URL));
    return Promise.race([load, timeout]);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load " + src));
      document.head.appendChild(s);
    });
  }

  /* ---------------------------------------------------------
     FALLBACK 2D SCHEMATIC (Three.js unavailable)
  --------------------------------------------------------- */
  function enableFallback() {
    state.fallback = true;
    if (loadingEl) loadingEl.classList.add("hidden");
    if (!canvasWrap) return;
    canvasWrap.innerHTML = `
      <div class="twin-fallback">
        <div class="twin-fallback-msg">3D engine unavailable (offline or blocked) &mdash; showing 2D engineering schematic instead. The rest of the dashboard is unaffected.</div>
        <svg class="cycle-svg" viewBox="0 0 720 340" xmlns="http://www.w3.org/2000/svg">
          <path class="pipe-hot" d="M 600 250 V 110" />
          <path class="pipe-cold" d="M 430 110 V 190 M 430 216 V 226 L 220 226 V 260" />
          <path class="pipe-cold" d="M 340 290 H 540" />
          <path id="fb-flow-hot" class="flow-hot" d="M 600 250 V 110" />
          <path id="fb-flow-cold-a" class="flow-cold" d="M 430 110 V 190 M 430 216 V 226 L 220 226 V 260" />
          <path id="fb-flow-cold-b" class="flow-cold" d="M 340 290 H 540" />
          <rect x="400" y="40" width="220" height="70" rx="8" class="cycle-node" />
          <text x="510" y="128" text-anchor="middle" class="cycle-box-label">CONDENSER</text>
          <rect x="140" y="260" width="180" height="50" rx="25" class="cycle-node" />
          <text x="230" y="330" text-anchor="middle" class="cycle-box-label">EVAPORATOR</text>
          <rect x="540" y="250" width="120" height="90" rx="10" class="cycle-node" />
          <text x="600" y="358" text-anchor="middle" class="cycle-box-label">COMPRESSOR</text>
          <path d="M 415 190 L 445 190 L 430 216 Z" class="valve-icon" />
          <text x="430" y="245" text-anchor="middle" class="cycle-sub-label">Expansion Valve</text>
          <text x="600" y="234" text-anchor="middle" class="cycle-value-label" id="fb-T2">N/A</text>
          <text x="395" y="105" text-anchor="end" class="cycle-value-label" id="fb-T3">N/A</text>
          <text x="220" y="245" text-anchor="middle" class="cycle-value-label" id="fb-T4">N/A</text>
          <text x="480" y="284" text-anchor="middle" class="cycle-value-label" id="fb-T1">N/A</text>
          <text x="180" y="248" text-anchor="middle" class="water-value" id="fb-T5">N/A</text>
          <text x="270" y="248" text-anchor="middle" class="water-value" id="fb-T6">N/A</text>
        </svg>
      </div>`;
    updateFallbackReading(state.reading);
  }

  function updateFallbackReading(r) {
    if (!r) return;
    ["T1", "T2", "T3", "T4", "T5", "T6"].forEach((k) => {
      const el = document.getElementById("fb-" + k);
      if (el) el.textContent = fmt(r[k], "°C");
    });
    const running = !!r.compressor_status;
    ["fb-flow-hot", "fb-flow-cold-a", "fb-flow-cold-b"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle("stopped", !running);
    });
  }

  /* ---------------------------------------------------------
     3D SCENE CONSTRUCTION
  --------------------------------------------------------- */
  function initScene() {
    const T = window.THREE;
    const width = canvasWrap.clientWidth || 800;
    const height = canvasWrap.clientHeight || 560;

    renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = false;
    canvasWrap.appendChild(renderer.domElement);

    scene = new T.Scene();
    camera = new T.PerspectiveCamera(42, width / height, 0.1, 200);

    controls = new T.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 3;
    controls.maxDistance = 30;
    controls.target.set(0, 1, 0);

    clock = new T.Clock();

    scene.add(new T.AmbientLight(0x9fb3c8, 0.55));
    const key = new T.DirectionalLight(0xffffff, 0.9);
    key.position.set(6, 10, 6);
    scene.add(key);
    const fill = new T.DirectionalLight(0x38d4e0, 0.35);
    fill.position.set(-6, 4, -4);
    scene.add(fill);
    const rim = new T.PointLight(0x3ba6ef, 0.4, 30);
    rim.position.set(0, 5, -6);
    scene.add(rim);

    const grid = new T.GridHelper(16, 24, 0x1c2e42, 0x101c2a);
    grid.position.y = -0.01;
    scene.add(grid);

    modelGroup = new T.Group();
    casingGroup = new T.Group();
    internalsGroup = new T.Group();
    modelGroup.add(casingGroup, internalsGroup);
    scene.add(modelGroup);

    componentMeshMap = {};
    clickableMeshes = [];
    labelSprites = {};

    createChillerBody(T);
    createCompressor(T);
    createCondenser(T);
    createExpansionValve(T);
    createEvaporator(T);
    createAccumulator(T);
    createFilterDrier(T);
    createLoad(T);
    createPortBasedRefrigerantPipes(T);
    createWaterPipes(T);
    createFlowParticles(T);
    createLabels(T);

    raycaster = new T.Raycaster();
    pointer = new T.Vector2();
    renderer.domElement.addEventListener("click", onCanvasClick);

    setupResize();
    viewReset();

    if (loadingEl) loadingEl.classList.add("hidden");
  }

  function metalMat(T, color, opts) {
    opts = opts || {};
    return new T.MeshStandardMaterial({
      color, metalness: opts.metalness ?? 0.55, roughness: opts.roughness ?? 0.4,
      transparent: !!opts.transparent, opacity: opts.opacity ?? 1,
      emissive: opts.emissive ?? 0x000000, emissiveIntensity: opts.emissiveIntensity ?? 0,
    });
  }

  function pipeMat(T, color, emissive, intensity) {
    return metalMat(T, color, {
      metalness: 0.68,
      roughness: 0.24,
      transparent: true,
      opacity: 0.38,
      emissive,
      emissiveIntensity: intensity,
    });
  }

  function registerClickable(id, mesh, group) {
    mesh.userData.componentId = id;
    clickableMeshes.push(mesh);
    if (!componentMeshMap[id]) componentMeshMap[id] = { meshes: [], group: group || mesh };
    componentMeshMap[id].meshes.push(mesh);
  }

  /* ---- Outer chiller enclosure / casing (cutaway target) ---- */
  function createChillerBody(T) {
    const frameMat = metalMat(T, 0xb8c4cc, { metalness: 0.78, roughness: 0.3 });
    const darkMat = metalMat(T, 0x172331, { metalness: 0.65, roughness: 0.45 });
    const baseRails = new T.Group();
    [-1.5, 1.5].forEach((z) => {
      const rail = new T.Mesh(new T.BoxGeometry(7.8, 0.22, 0.24), darkMat);
      rail.position.set(0, 0.12, z);
      baseRails.add(rail);
    });
    [-3.35, 0, 3.35].forEach((x) => {
      const cross = new T.Mesh(new T.BoxGeometry(0.24, 0.22, 3.24), darkMat);
      cross.position.set(x, 0.12, 0);
      baseRails.add(cross);
    });
    casingGroup.add(baseRails);
    [-3.35, 3.35].forEach((x) => [-1.5, 1.5].forEach((z) => {
      const foot = new T.Mesh(new T.BoxGeometry(0.42, 0.5, 0.42), frameMat);
      foot.position.set(x, -0.18, z);
      casingGroup.add(foot);
    }));
    [-3.35, 3.35].forEach((x) => [-1.65, 1.65].forEach((z) => {
      const post = new T.Mesh(new T.BoxGeometry(0.16, 2.9, 0.16), frameMat);
      post.position.set(x, 1.55, z);
      casingGroup.add(post);
    }));
    [-1.65, 1.65].forEach((z) => {
      const rail = new T.Mesh(new T.BoxGeometry(7.0, 0.14, 0.14), frameMat);
      rail.position.set(0, 2.8, z);
      casingGroup.add(rail);
    });
    const panel = new T.Mesh(new T.BoxGeometry(0.12, 1.55, 1.25), metalMat(T, 0x657687, { metalness: 0.55, roughness: 0.38 }));
    panel.position.set(3.48, 1.65, -0.55);
    casingGroup.add(panel);
    for (let i = 0; i < 4; i++) {
      const vent = new T.Mesh(new T.BoxGeometry(0.03, 0.06, 0.8), darkMat);
      vent.position.set(3.56, 1.25 + i * 0.15, -0.55);
      casingGroup.add(vent);
    }
    for (let i = 0; i < 10; i++) {
      const bolt = new T.Mesh(new T.CylinderGeometry(0.035, 0.035, 0.06, 8), frameMat);
      bolt.rotation.x = Math.PI / 2;
      bolt.position.set(-2.7 + i * 0.6, 2.86, 1.68);
      casingGroup.add(bolt);
    }

    const skinMat = metalMat(T, 0x526575, { metalness: 0.62, roughness: 0.38, transparent: true, opacity: 0.88 });
    const sideLeft = new T.Mesh(new T.BoxGeometry(0.12, 2.55, 3.18), skinMat);
    sideLeft.position.set(-3.5, 1.55, 0);
    sideLeft.userData.isExternalShell = true;
    casingGroup.add(sideLeft);
    const sideRight = new T.Mesh(new T.BoxGeometry(0.12, 2.55, 3.18), skinMat.clone());
    sideRight.position.set(3.5, 1.55, 0);
    sideRight.userData.isExternalShell = true;
    casingGroup.add(sideRight);
    const rearPanel = new T.Mesh(new T.BoxGeometry(6.9, 2.4, 0.1), skinMat.clone());
    rearPanel.position.set(0, 1.55, -1.7);
    rearPanel.userData.isExternalShell = true;
    casingGroup.add(rearPanel);
    const lowerFront = new T.Mesh(new T.BoxGeometry(6.9, 0.72, 0.1), skinMat.clone());
    lowerFront.position.set(0, 0.62, 1.7);
    lowerFront.userData.isExternalShell = true;
    casingGroup.add(lowerFront);
    const serviceDoor = new T.Mesh(new T.BoxGeometry(6.9, 1.45, 0.1), skinMat.clone());
    serviceDoor.material.opacity = 0.34;
    serviceDoor.position.set(0, 1.65, 1.7);
    serviceDoor.userData.isExternalShell = true;
    casingGroup.add(serviceDoor);
    [-2.8, -1.4, 0, 1.4, 2.8].forEach((x) => {
      const louver = new T.Mesh(new T.BoxGeometry(0.9, 0.06, 0.06), darkMat);
      louver.position.set(x, 1.3 + (x === 0 ? 0.35 : 0), 1.77);
      casingGroup.add(louver);
    });
  }

  /* ---- Lower compressor bank: multiple mounted industrial screw compressors ---- */
  function createCompressor(T) {
    const root = new T.Group();
    componentMeshMap.compressor = { meshes: [], group: root, units: [], anchorDischarges: [], anchorSuctions: [], focus: new T.Vector3(0, 0.92, -0.25) };
    [-2.35, 0, 2.35].forEach((x, index) => {
      const g = new T.Group();
      g.position.set(x, 0.92, -0.25);
      const body = new T.Mesh(new T.CylinderGeometry(0.48, 0.54, 1.45, 26), metalMat(T, 0x657687, { metalness: 0.72, roughness: 0.3 }));
      body.rotation.z = Math.PI / 2;
      g.add(body);
      registerClickable("compressor", body, root);
      const motor = new T.Mesh(new T.CylinderGeometry(0.38, 0.38, 0.55, 22), metalMat(T, 0x2b3a4c, { metalness: 0.76, roughness: 0.28 }));
      motor.rotation.z = Math.PI / 2;
      motor.position.x = 0.78;
      g.add(motor);
      for (let i = 0; i < 8; i++) {
        const fin = new T.Mesh(new T.TorusGeometry(0.4, 0.014, 6, 20), metalMat(T, 0x1c2e42, { metalness: 0.4, roughness: 0.5 }));
        fin.rotation.y = Math.PI / 2;
        fin.position.x = 0.35 + i * 0.055;
        g.add(fin);
      }
      const rail = new T.Mesh(new T.BoxGeometry(2.0, 0.12, 1.05), metalMat(T, 0x101c2a, { metalness: 0.35, roughness: 0.68 }));
      rail.position.y = -0.66;
      g.add(rail);
      [-0.72, 0.72].forEach((footX) => {
        const foot = new T.Mesh(new T.BoxGeometry(0.22, 0.18, 0.62), metalMat(T, 0xb8c4cc, { metalness: 0.72, roughness: 0.3 }));
        foot.position.set(footX, -0.78, 0);
        g.add(foot);
      });
      const discharge = new T.Vector3(x + 0.9, 1.22, -0.25);
      const suction = new T.Vector3(x - 0.9, 0.92, -0.25);
      const service = new T.Vector3(x, 1.25, 0.2);
      addNozzle(T, discharge, new T.Vector3(1, 0, 0), 0.1, 0.22, 0xb87333, root);
      addNozzle(T, suction, new T.Vector3(-1, 0, 0), 0.1, 0.22, 0x8da2b3, root);
      addNozzle(T, service, new T.Vector3(0, 1, 0), 0.07, 0.14, 0xd2a74c, root);
      root.add(g);
      componentMeshMap.compressor.units.push({ group: g, discharge, suction });
      componentMeshMap.compressor.anchorDischarges.push(discharge);
      componentMeshMap.compressor.anchorSuctions.push(suction);
      if (index === 0) {
        componentMeshMap.compressor.anchorDischarge = discharge;
        componentMeshMap.compressor.anchorSuction = suction;
      }
    });
    internalsGroup.add(root);
  }

  /* ---- Upper air-cooled condenser: three V-shaped coil banks and four fans ---- */
  function createCondenser(T) {
    const g = new T.Group();
    g.position.set(0, 1.95, -0.85);
    const casingMat = metalMat(T, 0xc5cdd2, { metalness: 0.68, roughness: 0.32 });
    const finMat = metalMat(T, 0x374858, { metalness: 0.48, roughness: 0.42 });
    const deck = new T.Group();
    const frontBeam = new T.Mesh(new T.BoxGeometry(7.25, 0.16, 0.16), casingMat);
    frontBeam.position.set(0, 0.82, -1.75);
    deck.add(frontBeam);
    const rearBeam = new T.Mesh(new T.BoxGeometry(7.25, 0.16, 0.16), casingMat);
    rearBeam.position.set(0, 0.82, 0.05);
    deck.add(rearBeam);
    [-3.62, 3.62].forEach((x) => {
      const sideBeam = new T.Mesh(new T.BoxGeometry(0.16, 0.16, 1.8), casingMat);
      sideBeam.position.set(x, 0.82, -0.85);
      deck.add(sideBeam);
    });
    registerClickable("condenser", frontBeam, g);
    [-2.55, -0.85, 0.85, 2.55].forEach((x) => {
      const fanMount = new T.Mesh(new T.TorusGeometry(0.68, 0.07, 10, 28), casingMat);
      fanMount.rotation.x = Math.PI / 2;
      fanMount.position.set(x, 0.84, -0.85);
      deck.add(fanMount);
    });
    g.add(deck);
    [-2.3, 0, 2.3].forEach((x) => {
      [-1, 1].forEach((side) => {
        const bank = new T.Group();
        bank.position.set(x, 0.04, -0.85 + side * 0.42);
        bank.rotation.x = side * 0.38;
        const panel = new T.Mesh(new T.BoxGeometry(2.05, 1.35, 0.12), casingMat);
        bank.add(panel);
        for (let i = 0; i < 12; i++) {
          const fin = new T.Mesh(new T.BoxGeometry(0.045, 1.22, 0.14), finMat);
          fin.position.x = -0.92 + i * 0.17;
          bank.add(fin);
        }
        const copperMat = metalMat(T, 0xb87333, { metalness: 0.82, roughness: 0.24 });
        for (let row = 0; row < 4; row++) {
          const tube = makePipe(T, [
            new T.Vector3(-0.94, -0.48 + row * 0.32, 0.09),
            new T.Vector3(0, -0.48 + row * 0.32, 0.09),
            new T.Vector3(0.94, -0.48 + row * 0.32, 0.09),
          ], 0.035, copperMat, bank);
          tube.mesh.userData.isCondenserTube = true;
        }
        [-0.96, 0.96].forEach((headerX) => {
          const headerTube = new T.Mesh(new T.CylinderGeometry(0.07, 0.07, 1.2, 12), copperMat);
          headerTube.position.set(headerX, 0, 0.1);
          bank.add(headerTube);
        });
        g.add(bank);
      });
      const brace = new T.Mesh(new T.BoxGeometry(0.12, 1.65, 0.12), casingMat);
      brace.position.set(x, 0.05, -0.85);
      g.add(brace);
      const support = new T.Mesh(new T.BoxGeometry(0.18, 1.25, 0.18), casingMat);
      support.position.set(x, -0.58, -0.85);
      g.add(support);
    });
    state.fans = [];
    [-2.55, -0.85, 0.85, 2.55].forEach((x) => {
      const fanGroup = new T.Group();
      fanGroup.position.set(x, 0.98, -0.85);
      const ring = new T.Mesh(new T.TorusGeometry(0.58, 0.06, 10, 24), metalMat(T, 0x1c2e42, { metalness: 0.55, roughness: 0.42 }));
      ring.rotation.x = Math.PI / 2;
      fanGroup.add(ring);
      for (let spoke = 0; spoke < 8; spoke++) {
        const guard = new T.Mesh(new T.BoxGeometry(1.05, 0.018, 0.025), metalMat(T, 0x8a97a6, { metalness: 0.72, roughness: 0.3 }));
        guard.rotation.y = spoke * Math.PI / 8;
        fanGroup.add(guard);
      }
      const hub = new T.Group();
      const motor = new T.Mesh(new T.CylinderGeometry(0.16, 0.16, 0.22, 16), metalMat(T, 0x536578, { metalness: 0.7, roughness: 0.3 }));
      motor.rotation.x = Math.PI / 2;
      hub.add(motor);
      for (let b = 0; b < 5; b++) {
        const blade = new T.Mesh(new T.BoxGeometry(0.42, 0.025, 0.1), metalMat(T, 0x8a97a6, { metalness: 0.62, roughness: 0.35 }));
        blade.position.set(0.24, 0, 0);
        blade.rotation.y = (b / 5) * Math.PI * 2;
        hub.add(blade);
      }
      fanGroup.add(hub);
      const mount = new T.Mesh(new T.BoxGeometry(0.22, 0.12, 0.22), casingMat);
      mount.position.y = -0.72;
      fanGroup.add(mount);
      g.add(fanGroup);
      state.fans.push(hub);
    });

    internalsGroup.add(g);
    componentMeshMap.condenser.anchorInlet = new T.Vector3(3.62, 1.95, -0.85);
    componentMeshMap.condenser.anchorOutlet = new T.Vector3(-3.62, 1.88, -0.85);
    addNozzle(T, componentMeshMap.condenser.anchorInlet, new T.Vector3(1, 0, 0), 0.1, 0.24, 0x8d9aa5, internalsGroup);
    addNozzle(T, componentMeshMap.condenser.anchorOutlet, new T.Vector3(-1, 0, 0), 0.1, 0.24, 0x8d9aa5, internalsGroup);
  }

  /* ---- Expansion valve ---- */
  function createExpansionValve(T) {
    const g = new T.Group();
    g.position.set(-2.45, 0.98, 0.2);
    const body = new T.Mesh(new T.CylinderGeometry(0.14, 0.18, 0.32, 16), metalMat(T, 0xf2b705, { metalness: 0.5, roughness: 0.35 }));
    g.add(body);
    registerClickable("valve", body, g);
    const knob = new T.Mesh(new T.CylinderGeometry(0.08, 0.08, 0.16, 10), metalMat(T, 0x8a5a02, { metalness: 0.6, roughness: 0.3 }));
    knob.position.y = 0.24;
    g.add(knob);
    internalsGroup.add(g);
    componentMeshMap.valve.anchorIn = new T.Vector3(-2.45, 1.17, 0.2);
    componentMeshMap.valve.anchorOut = new T.Vector3(-2.45, 0.79, 0.2);
    addNozzle(T, componentMeshMap.valve.anchorIn, new T.Vector3(0, -1, 0), 0.09, 0.16, 0xb8c4cc, internalsGroup);
    addNozzle(T, componentMeshMap.valve.anchorOut, new T.Vector3(0, 1, 0), 0.09, 0.16, 0xb8c4cc, internalsGroup);
  }

  /* ---- Evaporator: shell-and-tube cylinder + water stubs ---- */
  function createEvaporator(T) {
    const g = new T.Group();
    g.position.set(-1.7, 0.86, 0.7);

    const shell = new T.Mesh(new T.CylinderGeometry(0.52, 0.52, 2.6, 26), metalMat(T, 0x657687, { metalness: 0.68, roughness: 0.32 }));
    shell.userData.isInternalShell = true;
    shell.rotation.z = Math.PI / 2;
    g.add(shell);
    for (let i = -1; i <= 1; i++) {
      const tube = new T.Mesh(new T.CylinderGeometry(0.045, 0.045, 2.25, 10), metalMat(T, 0x38d4e0, { metalness: 0.35, roughness: 0.3, emissive: 0x063a42, emissiveIntensity: 0.35, transparent: true, opacity: 0.8 }));
      tube.rotation.z = Math.PI / 2;
      tube.position.set(i * 0.18, 0, 0);
      g.add(tube);
    }
    registerClickable("evaporator", shell, g);

    [-1.32, 1.32].forEach((x) => {
      const cap = new T.Mesh(new T.CylinderGeometry(0.5, 0.5, 0.16, 26), metalMat(T, 0x2b3a4c, { metalness: 0.65, roughness: 0.3 }));
      cap.rotation.z = Math.PI / 2;
      cap.position.x = x;
      g.add(cap);
      for (let b = 0; b < 8; b++) {
        const bolt = new T.Mesh(new T.CylinderGeometry(0.035, 0.035, 0.08, 8), metalMat(T, 0xb8c4cc, { metalness: 0.75, roughness: 0.3 }));
        bolt.rotation.z = Math.PI / 2;
        bolt.position.set(x + (x > 0 ? 0.1 : -0.1), 0.36 * Math.cos(b * Math.PI / 4), 0.36 * Math.sin(b * Math.PI / 4));
        g.add(bolt);
      }
    });

    for (let i = -1; i <= 1; i++) {
      const band = new T.Mesh(new T.TorusGeometry(0.535, 0.035, 8, 24), metalMat(T, 0x1c2e42, { metalness: 0.3, roughness: 0.6 }));
      band.rotation.y = Math.PI / 2;
      band.position.x = i * 0.65;
      g.add(band);
    }

    internalsGroup.add(g);
    componentMeshMap.evaporator.anchorRefIn = new T.Vector3(-2.8, 1.0, 0.7);
    componentMeshMap.evaporator.anchorRefOut = new T.Vector3(-0.6, 1.0, 0.7);
    componentMeshMap.evaporator.anchorWaterIn = new T.Vector3(-1.7, 0.66, 1.25);
    componentMeshMap.evaporator.anchorWaterOut = new T.Vector3(-1.7, 0.98, 1.25);

    const saddleMat = metalMat(T, 0x172331, { metalness: 0.62, roughness: 0.42 });
    [-0.72, 0.72].forEach((x) => {
      const saddle = new T.Mesh(new T.BoxGeometry(0.28, 0.38, 0.92), saddleMat);
      saddle.position.set(x, -0.62, 0);
      g.add(saddle);
      const saddleFoot = new T.Mesh(new T.BoxGeometry(0.58, 0.08, 1.05), saddleMat);
      saddleFoot.position.set(x, -0.82, 0);
      g.add(saddleFoot);
    });

    const inStub = new T.Mesh(new T.CylinderGeometry(0.14, 0.14, 0.38, 16), metalMat(T, 0x22c1d6, { metalness: 0.4, roughness: 0.35 }));
    inStub.rotation.x = Math.PI / 2;
    inStub.position.set(0, -0.20, 0.55);
    g.add(inStub);
    registerClickable("waterIn", inStub, g);

    const outStub = new T.Mesh(new T.CylinderGeometry(0.14, 0.14, 0.38, 16), metalMat(T, 0x22c1d6, { metalness: 0.4, roughness: 0.35 }));
    outStub.rotation.x = Math.PI / 2;
    outStub.position.set(0, 0.12, 0.55);
    g.add(outStub);
    registerClickable("waterOut", outStub, g);
    addNozzle(T, componentMeshMap.evaporator.anchorRefIn, new T.Vector3(-1, 0, 0), 0.1, 0.22, 0x8d9aa5, internalsGroup);
    addNozzle(T, componentMeshMap.evaporator.anchorRefOut, new T.Vector3(1, 0, 0), 0.1, 0.22, 0x8d9aa5, internalsGroup);
  }

  function createAccumulator(T) {
    const g = new T.Group();
    g.position.set(0.65, 1.0, 1.35);
    const body = new T.Mesh(new T.CylinderGeometry(0.32, 0.36, 1.35, 22), metalMat(T, 0x566a7b, { metalness: 0.7, roughness: 0.32 }));
    g.add(body);
    registerClickable("accumulator", body, g);
    const cap = new T.Mesh(new T.SphereGeometry(0.34, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), metalMat(T, 0x2b3a4c, { metalness: 0.7, roughness: 0.3 }));
    cap.position.y = 0.66;
    g.add(cap);
    const base = new T.Mesh(new T.BoxGeometry(0.85, 0.12, 0.72), metalMat(T, 0x172331, { metalness: 0.45, roughness: 0.55 }));
    base.position.y = -0.72;
    g.add(base);
    componentMeshMap.accumulator.anchorIn = new T.Vector3(0.65, 0.42, 1.35);
    componentMeshMap.accumulator.anchorOut = new T.Vector3(0.65, 1.72, 1.35);
    addNozzle(T, componentMeshMap.accumulator.anchorIn, new T.Vector3(0, -1, 0), 0.1, 0.2, 0x8d9aa5, internalsGroup);
    addNozzle(T, componentMeshMap.accumulator.anchorOut, new T.Vector3(0, 1, 0), 0.1, 0.2, 0x8d9aa5, internalsGroup);
    internalsGroup.add(g);
  }

  function createFilterDrier(T) {
    const g = new T.Group();
    g.position.set(-2.65, 1.45, -0.2);
    const body = new T.Mesh(new T.CylinderGeometry(0.15, 0.15, 0.55, 18), metalMat(T, 0xd2a74c, { metalness: 0.65, roughness: 0.32 }));
    g.add(body);
    registerClickable("filterDrier", body, g);
    const bracket = new T.Mesh(new T.BoxGeometry(0.38, 0.08, 0.3), metalMat(T, 0x172331, { metalness: 0.5, roughness: 0.5 }));
    bracket.position.y = -0.34;
    g.add(bracket);
    componentMeshMap.filterDrier.anchorIn = new T.Vector3(-2.65, 1.75, -0.2);
    componentMeshMap.filterDrier.anchorOut = new T.Vector3(-2.65, 1.15, -0.2);
    addNozzle(T, componentMeshMap.filterDrier.anchorIn, new T.Vector3(0, 1, 0), 0.07, 0.14, 0xd2a74c, internalsGroup);
    addNozzle(T, componentMeshMap.filterDrier.anchorOut, new T.Vector3(0, -1, 0), 0.07, 0.14, 0xd2a74c, internalsGroup);
    internalsGroup.add(g);
  }

  /* ---- Load / AHU representation ---- */
  function createLoad(T) {
    const g = new T.Group();
    g.position.set(-1.7, 0.75, 3.05);
    const box = new T.Mesh(new T.BoxGeometry(1.1, 1.3, 0.9), metalMat(T, 0x2b3a4c, { metalness: 0.4, roughness: 0.55 }));
    g.add(box);
    registerClickable("load", box, g);
    for (let i = 0; i < 5; i++) {
      const louver = new T.Mesh(new T.BoxGeometry(1.12, 0.03, 0.92), metalMat(T, 0x101c2a, { metalness: 0.3, roughness: 0.7 }));
      louver.position.y = -0.5 + i * 0.25;
      g.add(louver);
    }
    scene.add(g);
    componentMeshMap.load.anchorIn = new T.Vector3(-1.7, 1.0, 2.55);
    componentMeshMap.load.anchorOut = new T.Vector3(-1.7, 0.5, 2.55);
  }

  function addNozzle(T, position, direction, radius, length, color, parent) {
    const dir = direction.clone().normalize();
    const mesh = new T.Mesh(new T.CylinderGeometry(radius, radius, length, 14), metalMat(T, color, { metalness: 0.7, roughness: 0.3 }));
    mesh.position.copy(position).add(dir.clone().multiplyScalar(length * 0.5));
    mesh.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), dir);
    (parent || internalsGroup).add(mesh);
    const flange = new T.Mesh(new T.CylinderGeometry(radius * 1.35, radius * 1.35, 0.07, 14), metalMat(T, 0xb8c4cc, { metalness: 0.8, roughness: 0.28 }));
    flange.position.copy(position).add(dir.clone().multiplyScalar(length * 0.18));
    flange.quaternion.copy(mesh.quaternion);
    (parent || internalsGroup).add(flange);
  }

  function makePipe(T, points, radius, material, parent) {
    const curve = new T.CatmullRomCurve3(points);
    const geom = new T.TubeGeometry(curve, Math.max(20, points.length * 8), radius, 8, false);
    const mesh = new T.Mesh(geom, material);
    mesh.userData.isPhysicalPipe = true;
    mesh.userData.pipePath = curve;
    mesh.renderOrder = 2;
    mesh.material.depthWrite = false;
    mesh.material.depthTest = true;
    mesh.material.side = T.DoubleSide;
    (parent || internalsGroup).add(mesh);
    return { mesh, curve };
  }

  function makePort(id, position, direction, diameter) {
    return {
      componentId: id.split(".")[0],
      portId: id,
      position: position.clone(),
      direction: direction.clone().normalize(),
      diameter,
    };
  }

  function routePortToPort(T, startPort, endPort, points, material, parent) {
    const routePoints = [startPort.position].concat(points || [], [endPort.position]);
    const startError = routePoints[0].distanceTo(startPort.position);
    const endError = routePoints[routePoints.length - 1].distanceTo(endPort.position);
    if (startError > 0.001 || endError > 0.001) return null;
    const route = makePipe(T, routePoints, (startPort.diameter + endPort.diameter) * 0.25, material, parent);
    route.startPort = startPort;
    route.endPort = endPort;
    route.mesh.userData.startPort = startPort.portId;
    route.mesh.userData.endPort = endPort.portId;
    route.mesh.userData.route = route;
    return route;
  }

  function registerPipeRoute(list, route) {
    if (!route) return false;
    list.push(route);
    return true;
  }

  function addPipeSupport(T, position, pipeRadius, axis, parent) {
    const supportMat = metalMat(T, 0x263646, { metalness: 0.66, roughness: 0.42 });
    const post = new T.Mesh(new T.BoxGeometry(0.1, 0.42, 0.1), supportMat);
    post.position.set(position.x, position.y - 0.21, position.z);
    (parent || internalsGroup).add(post);
    const foot = new T.Mesh(new T.BoxGeometry(0.42, 0.07, 0.32), supportMat);
    foot.position.set(position.x, position.y - 0.44, position.z);
    (parent || internalsGroup).add(foot);
    const clamp = new T.Mesh(new T.TorusGeometry(pipeRadius * 1.18, 0.025, 8, 16), supportMat);
    if (axis === "z") clamp.rotation.x = Math.PI / 2;
    else clamp.rotation.y = Math.PI / 2;
    clamp.position.copy(position);
    (parent || internalsGroup).add(clamp);
  }

  function addInlineValve(T, position, direction, radius, parent) {
    const valveMat = metalMat(T, 0x8d9aa5, { metalness: 0.72, roughness: 0.3 });
    const dir = direction.clone().normalize();
    const body = new T.Mesh(new T.CylinderGeometry(radius * 1.3, radius * 1.3, radius * 2.8, 16), valveMat);
    body.position.copy(position);
    body.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), dir);
    (parent || scene).add(body);
    const handle = new T.Mesh(new T.BoxGeometry(radius * 2.8, radius * 0.12, radius * 0.12), metalMat(T, 0xf2b705, { metalness: 0.55, roughness: 0.34 }));
    handle.position.copy(position).add(new T.Vector3(0, radius * 1.8, 0));
    (parent || scene).add(handle);
  }

  function addPipeCoupling(T, position, radius, axis, parent) {
    const couplingMat = metalMat(T, 0xb8c4cc, { metalness: 0.82, roughness: 0.28 });
    const ring = new T.Mesh(new T.TorusGeometry(radius * 1.18, radius * 0.22, 8, 16), couplingMat);
    if (axis === "y") ring.rotation.x = Math.PI / 2;
    else if (axis === "z") ring.rotation.y = Math.PI / 2;
    ring.position.copy(position);
    (parent || internalsGroup).add(ring);
  }

  /* ---- Refrigerant piping: compressor -> condenser -> valve -> evaporator -> compressor ---- */
  function createRefrigerantPipes(T) {
    const hotMat = pipeMat(T, 0xb87333, 0x4a1017, 0.18);
    const coldMat = pipeMat(T, 0x8da2b3, 0x0d2a4a, 0.14);
    const cm = componentMeshMap;

    const dischargeHeaderStart = new T.Vector3(-1.45, 1.58, 0.72);
    const dischargeHeaderEnd = new T.Vector3(2.8, 1.58, 0.72);
    cm.compressor.anchorDischarges.forEach((port) => {
      makePipe(T, [port, new T.Vector3(port.x + 0.15, 1.42, 0.15), new T.Vector3(port.x * 0.45, 1.58, 0.72)], 0.075, hotMat);
    });
    const hotPoints = [
      cm.compressor.anchorDischarge,
      new T.Vector3(cm.compressor.anchorDischarge.x * 0.45, 1.58, 0.72),
      dischargeHeaderStart,
      dischargeHeaderEnd,
      new T.Vector3(3.62, 1.58, -0.38),
      cm.condenser.anchorInlet,
    ];
    const dischargePipe = makePipe(T, hotPoints, 0.12, hotMat);
    dischargePipe.mesh.name = "physicalUpperDischargePipe";
    state.upperDischargePipe = dischargePipe;
    [dischargeHeaderStart, dischargeHeaderEnd, new T.Vector3(3.62, 1.45, -0.85)].forEach((point) => addPipeCoupling(T, point, 0.09, "x"));

    const liquidPoints = [cm.condenser.anchorOutlet, new T.Vector3(-3.35, 1.95, -0.95), new T.Vector3(-3.35, 1.45, -0.2), cm.filterDrier.anchorIn, cm.filterDrier.anchorOut, new T.Vector3(-2.65, 1.0, 0.2), cm.valve.anchorIn, cm.valve.anchorOut, new T.Vector3(-2.45, 0.72, 0.7), cm.evaporator.anchorRefIn];
    const liquidPipe = makePipe(T, liquidPoints, 0.075, coldMat);
    [cm.filterDrier.anchorIn, cm.filterDrier.anchorOut, cm.valve.anchorIn, cm.valve.anchorOut].forEach((point) => addPipeCoupling(T, point, 0.075, "y"));

    const suctionHeaderStart = new T.Vector3(-3.25, 0.55, -0.25);
    const suctionHeaderEnd = new T.Vector3(0.45, 0.55, -0.25);
    cm.compressor.anchorSuctions.forEach((port) => {
      makePipe(T, [new T.Vector3(port.x * 0.8, 0.55, -0.25), port], 0.075, coldMat);
    });
    makePipe(T, [suctionHeaderStart, suctionHeaderEnd], 0.09, coldMat);
    const suctionPoints = [cm.evaporator.anchorRefOut, new T.Vector3(-0.6, 1.0, 0.7), new T.Vector3(-0.6, 0.42, 1.35), cm.accumulator.anchorIn, cm.accumulator.anchorOut, new T.Vector3(0.65, 0.55, 1.35), suctionHeaderEnd, new T.Vector3(0.45, 0.55, -0.25), cm.compressor.anchorSuction];
    const suctionPipe = makePipe(T, suctionPoints, 0.085, coldMat);
    [cm.accumulator.anchorIn, cm.accumulator.anchorOut, suctionHeaderEnd].forEach((point) => addPipeCoupling(T, point, 0.085, "y"));
    addPipeSupport(T, new T.Vector3(-0.8, 1.58, 0.72), 0.075, "x");
    addPipeSupport(T, new T.Vector3(1.4, 1.58, 0.72), 0.075, "x");
    addPipeSupport(T, new T.Vector3(-1.2, 0.55, -0.25), 0.09, "x");

    refrigerantCurve = new T.CurvePath();
    refrigerantCurve.add(dischargePipe.curve);
    refrigerantCurve.add(liquidPipe.curve);
    refrigerantCurve.add(suctionPipe.curve);
    refrigerantCurve.userData = { hotFraction: dischargePipe.curve.getLength() / refrigerantCurve.getLength() };

    state.refrigerantPipeMeshes = [];
    internalsGroup.traverse((object) => {
      if (object.userData && object.userData.isPhysicalPipe) state.refrigerantPipeMeshes.push(object);
    });
  }

  /* ---- Chilled-water piping: evaporator -> load -> evaporator (closed loop) ---- */
  function createWaterPipes(T) {
    const supplyMat = pipeMat(T, 0x277f99, 0x063a42, 0.16);
    const returnMat = pipeMat(T, 0x8c7040, 0x4a3400, 0.12);
    const cm = componentMeshMap;

    const port = (id, position, direction) => makePort(id, position, direction, 0.28);
    const evapIn = port("evaporator.waterInlet", cm.evaporator.anchorWaterIn, new T.Vector3(0, 0, 1));
    const evapOut = port("evaporator.waterOutlet", cm.evaporator.anchorWaterOut, new T.Vector3(0, 0, 1));
    const loadIn = port("load.supplyInlet", cm.load.anchorIn, new T.Vector3(0, 0, -1));
    const loadOut = port("load.returnOutlet", cm.load.anchorOut, new T.Vector3(0, 0, -1));
    const supply = routePortToPort(T, evapOut, loadIn, [new T.Vector3(-1.7, 0.98, 1.85), new T.Vector3(-1.7, 1.0, 2.55)], supplyMat, scene);
    const ret = routePortToPort(T, loadOut, evapIn, [new T.Vector3(-1.7, 0.5, 2.55), new T.Vector3(-1.7, 0.55, 1.85)], returnMat, scene);
    const routes = [supply, ret].filter(Boolean);
    routes.forEach((route) => {
      addPipeCoupling(T, route.startPort.position, route.startPort.diameter * 0.5, "z", scene);
      addPipeCoupling(T, route.endPort.position, route.endPort.diameter * 0.5, "z", scene);
    });

    addInlineValve(T, new T.Vector3(-1.7, 0.98, 1.85), new T.Vector3(0, 0, 1), 0.14, scene);
    addInlineValve(T, new T.Vector3(-1.7, 0.55, 1.85), new T.Vector3(0, 0, 1), 0.14, scene);
    addPipeSupport(T, new T.Vector3(-1.7, 0.98, 2.2), 0.14, "z", scene);
    addPipeSupport(T, new T.Vector3(-1.7, 0.55, 2.2), 0.14, "z", scene);

    state.waterRoutes = routes;
    state.waterPipeMeshes = routes.map((route) => route.mesh);
    waterLoopCurve = new T.CurvePath();
    routes.forEach((route) => waterLoopCurve.add(route.curve));
    waterLoopCurve.userData = { supplyFraction: supply ? supply.curve.getLength() / waterLoopCurve.getLength() : 0 };
  }

  /* ---- Flow particles (small spheres travelling along the loop curves) ---- */
  function createFlowParticles(T) {
    state.hotColor = new T.Color(0xef4a5f);
    state.coldColor = new T.Color(0x3ba6ef);
    state.hotFrac = refrigerantCurve.userData.hotFraction;
    state.supplyFrac = waterLoopCurve.userData.supplyFraction;

    const flowMaterial = (color) => new T.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.98,
      depthTest: true,
      depthWrite: false,
      blending: T.AdditiveBlending,
    });

    const refCount = 24;
    for (let i = 0; i < refCount; i++) {
      const mesh = new T.Mesh(new T.SphereGeometry(0.075, 10, 10), flowMaterial(state.coldColor));
      mesh.userData.t = i / refCount;
      mesh.renderOrder = 5;
      internalsGroup.add(mesh);
      refrigerantParticles.push(mesh);
    }

    const waterCount = 20;
    for (let i = 0; i < waterCount; i++) {
      const mesh = new T.Mesh(new T.SphereGeometry(0.065, 10, 10), flowMaterial(0x22e6ff));
      mesh.userData.t = i / waterCount;
      mesh.renderOrder = 5;
      scene.add(mesh);
      waterParticles.push(mesh);
    }
  }

  function animateRefrigerantFlow(dt) {
    const running = state.reading ? !!state.reading.compressor_status : true;
    const speedBase = state.reducedMotion ? 0.02 : 0.12;
    const speed = running ? speedBase : 0;
    refrigerantParticles.forEach((p) => {
      p.userData.t = (p.userData.t + dt * speed) % 1;
      p.position.copy(refrigerantCurve.getPointAt(p.userData.t));
      p.visible = state.showRefrigerant;
      p.material.color.copy(p.userData.t < state.hotFrac ? state.hotColor : state.coldColor);
    });
    if (state.fans) {
      const fanSpeed = running ? (state.reducedMotion ? 0.5 : 4.5) : 0;
      state.fans.forEach((hub) => { hub.rotation.x += dt * fanSpeed; });
    }
  }

  function animateWaterFlow(dt) {
    const flow = state.reading && state.reading.flow_rate != null ? state.reading.flow_rate : 0;
    const speedBase = state.reducedMotion ? 0.02 : 0.14;
    const flowNorm = Math.max(0, Math.min(2.5, flow / REF_FLOW));
    const speed = flow > 0 ? speedBase * Math.max(0.15, flowNorm) : 0;
    waterParticles.forEach((p) => {
      p.userData.t = (p.userData.t + dt * speed) % 1;
      p.position.copy(waterLoopCurve.getPointAt(p.userData.t));
      p.visible = state.showWater;
      p.material.color.set(p.userData.t < state.supplyFrac ? 0x22c1d6 : 0xf2b705);
    });
  }

  /* ---------------------------------------------------------
     LABELS (canvas sprites, always face camera)
  --------------------------------------------------------- */
  function createLabels(T) {
    const specs = [
      { id: "compressor", offset: new T.Vector3(0, 1.0, 0), color: "#38d4e0" },
      { id: "condenser", offset: new T.Vector3(0, 0.55, 0), color: "#38d4e0" },
      { id: "valve", offset: new T.Vector3(0, 0.5, 0), color: "#f2b705" },
      { id: "evaporator", offset: new T.Vector3(0, 0.75, 0), color: "#38d4e0" },
      { id: "load", offset: new T.Vector3(0, 1.0, 0), color: "#22c1d6" },
    ];
    specs.forEach((s) => {
      const group = componentMeshMap[s.id].group;
      const pos = (s.id === "compressor" && componentMeshMap[s.id].focus
        ? componentMeshMap[s.id].focus
        : group.position).clone().add(s.offset);
      const label = makeLabelSprite(T, COMPONENT_INFO[s.id].title, "", s.color);
      label.sprite.position.copy(pos);
      scene.add(label.sprite);
      labelSprites[s.id] = label;
    });
  }

  function makeLabelSprite(T, title, sub, color) {
    const canvas = document.createElement("canvas");
    canvas.width = 300; canvas.height = 76;
    const ctx = canvas.getContext("2d");
    drawLabel(ctx, canvas, title, sub, color);
    const tex = new T.CanvasTexture(canvas);
    const mat = new T.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    const sprite = new T.Sprite(mat);
    sprite.scale.set(1.9, 0.48, 1);
    sprite.renderOrder = 999;
    return { sprite, canvas, ctx, tex, title, color };
  }

  function drawLabel(ctx, canvas, title, sub, color) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    roundRect(ctx, 2, 2, canvas.width - 4, canvas.height - 4, 12);
    ctx.fillStyle = "rgba(6,11,20,0.88)";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = color || "#38d4e0";
    ctx.stroke();
    ctx.fillStyle = "#eaf3fb";
    ctx.font = "bold 24px Segoe UI, Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(title, canvas.width / 2, sub ? 28 : canvas.height / 2);
    if (sub) {
      ctx.font = "18px Consolas, monospace";
      ctx.fillStyle = color || "#38d4e0";
      ctx.fillText(sub, canvas.width / 2, 54);
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function createPortBasedRefrigerantPipes(T) {
    const hotMat = pipeMat(T, 0xb87333, 0x4a1017, 0.18);
    const coldMat = pipeMat(T, 0x8da2b3, 0x0d2a4a, 0.14);
    const cm = componentMeshMap;
    const routes = [];
    const port = (id, position, direction, diameter) => makePort(id, position, direction, diameter);
    const compressors = cm.compressor.units.map((unit, index) => ({
      discharge: port(`compressor${index + 1}.discharge`, unit.discharge, new T.Vector3(1, 0, 0), 0.15),
      suction: port(`compressor${index + 1}.suction`, unit.suction, new T.Vector3(-1, 0, 0), 0.15),
    }));
    const condenserIn = port("condenser.inlet", cm.condenser.anchorInlet, new T.Vector3(1, 0, 0), 0.18);
    const condenserOut = port("condenser.outlet", cm.condenser.anchorOutlet, new T.Vector3(-1, 0, 0), 0.15);
    const drierIn = port("filterDrier.inlet", cm.filterDrier.anchorIn, new T.Vector3(0, 1, 0), 0.12);
    const drierOut = port("filterDrier.outlet", cm.filterDrier.anchorOut, new T.Vector3(0, -1, 0), 0.12);
    const valveIn = port("expansionValve.inlet", cm.valve.anchorIn, new T.Vector3(0, -1, 0), 0.12);
    const valveOut = port("expansionValve.outlet", cm.valve.anchorOut, new T.Vector3(0, 1, 0), 0.12);
    const evapIn = port("evaporator.refrigerantInlet", cm.evaporator.anchorRefIn, new T.Vector3(-1, 0, 0), 0.15);
    const evapOut = port("evaporator.refrigerantOutlet", cm.evaporator.anchorRefOut, new T.Vector3(1, 0, 0), 0.15);
    const accumulatorIn = port("accumulator.inlet", cm.accumulator.anchorIn, new T.Vector3(0, -1, 0), 0.15);
    const accumulatorOut = port("accumulator.outlet", cm.accumulator.anchorOut, new T.Vector3(0, 1, 0), 0.15);
    const dischargeHeaderStart = new T.Vector3(-1.45, 1.58, 0.72);
    const dischargeHeaderEnd = new T.Vector3(2.8, 1.58, 0.72);
    compressors.forEach((compressor, index) => registerPipeRoute(routes, routePortToPort(T, compressor.discharge, port(`dischargeHeader.branch${index + 1}`, new T.Vector3(compressor.discharge.position.x * 0.45, 1.58, 0.72), new T.Vector3(0, 0, -1), 0.15), [new T.Vector3(compressor.discharge.position.x + 0.15, 1.42, 0.15)], hotMat)));
    registerPipeRoute(routes, routePortToPort(T, port("dischargeHeader.start", dischargeHeaderStart, new T.Vector3(-1, 0, 0), 0.2), port("dischargeHeader.end", dischargeHeaderEnd, new T.Vector3(1, 0, 0), 0.2), [], hotMat));
    const dischargePipe = routePortToPort(T, port("dischargeHeader.outlet", dischargeHeaderEnd, new T.Vector3(1, 0, 0), 0.2), condenserIn, [new T.Vector3(3.62, 1.58, -0.38)], hotMat);
    registerPipeRoute(routes, dischargePipe);
    if (dischargePipe) { dischargePipe.mesh.name = "physicalUpperDischargePipe"; state.upperDischargePipe = dischargePipe; }
    registerPipeRoute(routes, routePortToPort(T, condenserOut, drierIn, [new T.Vector3(-3.35, 1.95, -0.95), new T.Vector3(-3.35, 1.45, -0.2)], coldMat));
    registerPipeRoute(routes, routePortToPort(T, drierOut, valveIn, [new T.Vector3(-2.65, 1.0, 0.2)], coldMat));
    registerPipeRoute(routes, routePortToPort(T, valveOut, evapIn, [new T.Vector3(-2.45, 0.72, 0.7)], coldMat));
    const suctionHeaderStart = new T.Vector3(-3.25, 0.55, -0.25);
    const suctionHeaderEnd = new T.Vector3(0.45, 0.55, -0.25);
    registerPipeRoute(routes, routePortToPort(T, evapOut, accumulatorIn, [new T.Vector3(-0.6, 1.0, 0.7), new T.Vector3(-0.6, 0.42, 1.35)], coldMat));
    registerPipeRoute(routes, routePortToPort(T, accumulatorOut, port("suctionHeader.start", suctionHeaderStart, new T.Vector3(-1, 0, 0), 0.2), [new T.Vector3(0.65, 0.55, 1.35)], coldMat));
    compressors.forEach((compressor, index) => registerPipeRoute(routes, routePortToPort(T, port(`suctionHeader.branch${index + 1}`, new T.Vector3(compressor.suction.position.x * 0.8, 0.55, -0.25), new T.Vector3(0, 1, 0), 0.15), compressor.suction, [], coldMat)));
    registerPipeRoute(routes, routePortToPort(T, port("suctionHeader.start", suctionHeaderStart, new T.Vector3(-1, 0, 0), 0.2), port("suctionHeader.end", suctionHeaderEnd, new T.Vector3(1, 0, 0), 0.2), [], coldMat));
    state.refrigerantRoutes = routes;
    state.refrigerantPipeMeshes = routes.map((route) => route.mesh);
    routes.forEach((route) => addPipeCoupling(T, route.startPort.position, route.startPort.diameter * 0.5, "x"));
    const flowRoutes = [dischargePipe, routes.find((route) => route.startPort.portId === "condenser.outlet"), routes.find((route) => route.startPort.portId === "filterDrier.outlet"), routes.find((route) => route.startPort.portId === "expansionValve.outlet"), routes.find((route) => route.startPort.portId === "evaporator.refrigerantOutlet"), routes.find((route) => route.startPort.portId === "accumulator.outlet")].filter(Boolean);
    refrigerantCurve = new T.CurvePath();
    flowRoutes.forEach((route) => refrigerantCurve.add(route.curve));
    refrigerantCurve.userData = { hotFraction: dischargePipe ? dischargePipe.curve.getLength() / refrigerantCurve.getLength() : 0 };
  }

  function updateLabelValues() {
    if (!state.reading || !state.initialized) return;
    const r = state.reading;
    const subs = {
      compressor: (r.compressor_status ? "RUNNING" : "STOPPED") + "  " + fmt(r.power_kw, "kW"),
      condenser: "T3 " + fmt(r.T3, "°C"),
      valve: "T4 " + fmt(r.T4, "°C"),
      evaporator: "ΔT " + fmt(r.delta_t, "°C") + "  COP " + (r.cop != null ? Number(r.cop).toFixed(2) : "N/A"),
      load: "Flow " + fmt(r.flow_rate, "L/min"),
    };
    Object.entries(subs).forEach(([id, sub]) => {
      const label = labelSprites[id];
      if (!label) return;
      drawLabel(label.ctx, label.canvas, label.title, sub, label.color);
      label.tex.needsUpdate = true;
    });
  }

  function updateNodeAlarmHighlighting() {
    if (!state.initialized) return;
    const worst = (state.alarms || []).reduce((acc, alarm) => {
      if (alarm.severity === "CRITICAL") return "CRITICAL";
      if (alarm.severity === "WARNING" && acc !== "CRITICAL") return "WARNING";
      return acc;
    }, null);
    const color = worst === "CRITICAL" ? 0xef4a5f : worst === "WARNING" ? 0xf2b705 : null;
    ["compressor", "condenser", "evaporator"].forEach((id) => {
      const entry = componentMeshMap[id];
      if (!entry || selectedId === id) return;
      entry.meshes.forEach((mesh) => {
        if (!mesh.material) return;
        if (color !== null) {
          mesh.material.emissive.setHex(color);
          mesh.material.emissiveIntensity = 0.35;
        } else {
          mesh.material.emissiveIntensity = 0;
        }
      });
    });
  }

  function onCanvasClick(evt) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((evt.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((evt.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(clickableMeshes, false);
    if (hits.length === 0) return;
    selectComponent(hits[0].object.userData.componentId);
  }

  function selectComponent(id) {
    clearHighlight();
    selectedId = id;
    const entry = componentMeshMap[id];
    if (entry) {
      entry.meshes.forEach((m) => {
        if (m.material) { m.material.emissive.setHex(0x38d4e0); m.material.emissiveIntensity = 0.55; }
      });
    }
    showComponentInfo(id);
  }

  function clearHighlight() {
    if (!selectedId) return;
    const entry = componentMeshMap[selectedId];
    if (entry) entry.meshes.forEach((m) => { if (m.material) m.material.emissiveIntensity = 0; });
    selectedId = null;
  }

  function showComponentInfo(id) {
    const info = COMPONENT_INFO[id];
    if (!info || !infoPanel) return;
    infoTitle.textContent = info.title;
    infoBody.innerHTML = `<p>${info.desc}</p>` + buildMetricsHTML(id);
    infoPanel.classList.remove("hidden");
  }

  function refreshInfoPanel(id) {
    if (!infoPanel || infoPanel.classList.contains("hidden")) return;
    const info = COMPONENT_INFO[id];
    if (!info) return;
    infoBody.innerHTML = `<p>${info.desc}</p>` + buildMetricsHTML(id);
  }

  function hideInfoPanel() {
    if (infoPanel) infoPanel.classList.add("hidden");
    clearHighlight();
  }

  function buildMetricsHTML(id) {
    const r = state.reading;
    if (!r) return `<div class="info-row"><span class="k">Status</span><span class="v">No data yet</span></div>`;
    const rows = {
      compressor: [
        ["Status", r.compressor_status ? "RUNNING" : "STOPPED"],
        ["Current", fmt(r.compressor_current, "A")],
        ["Power", fmt(r.power_kw, "kW")],
        ["Suction (T1)", fmt(r.T1, "°C")],
        ["Discharge (T2)", fmt(r.T2, "°C")],
      ],
      condenser: [["Outlet (T3)", fmt(r.T3, "°C")], ["Discharge In (T2)", fmt(r.T2, "°C")]],
      valve: [["Inlet Temp (T3)", fmt(r.T3, "°C")], ["Outlet Temp (T4)", fmt(r.T4, "°C")]],
      evaporator: [
        ["Refrigerant Inlet (T4)", fmt(r.T4, "°C")],
        ["Water Inlet (T5)", fmt(r.T5, "°C")],
        ["Water Outlet (T6)", fmt(r.T6, "°C")],
        ["Flow", fmt(r.flow_rate, "L/min")],
        ["ΔT", fmt(r.delta_t, "°C")],
        ["Cooling Capacity", fmt(r.cooling_capacity, "kW")],
        ["COP", r.cop != null ? Number(r.cop).toFixed(2) : "N/A"],
      ],
      waterIn: [["Water Inlet (T5)", fmt(r.T5, "°C")], ["Flow", fmt(r.flow_rate, "L/min")]],
      waterOut: [["Water Outlet (T6)", fmt(r.T6, "°C")], ["ΔT", fmt(r.delta_t, "°C")]],
      load: [["Supply Temp (T6)", fmt(r.T6, "°C")], ["Return Temp (T5)", fmt(r.T5, "°C")], ["Flow", fmt(r.flow_rate, "L/min")]],
    };
    const list = rows[id] || [];
    return list.map(([k, v]) => `<div class="info-row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("");
  }

  /* ---------------------------------------------------------
     CAMERA VIEWS
  --------------------------------------------------------- */
  function viewReset() {
    if (!camera || !controls) return;
    camera.position.set(6.5, 5.2, 7.5);
    controls.target.set(-0.2, 1.2, 0.6);
    controls.update();
  }
  function viewFront() {
    if (!camera || !controls) return;
    camera.position.set(0.4, 1.8, 13);
    controls.target.set(0.4, 1.6, 0);
    controls.update();
  }
  function viewTop() {
    if (!camera || !controls) return;
    camera.position.set(0.4, 14, 0.61);
    controls.target.set(0.4, 0, 0.6);
    controls.update();
  }
  function viewSide() {
    if (!camera || !controls) return;
    camera.position.set(13, 2.6, 0.6);
    controls.target.set(0.4, 1.4, 0.6);
    controls.update();
  }
  function viewFit() {
    if (!camera || !controls || !modelGroup) return;
    const T = window.THREE;
    const box = new T.Box3().setFromObject(modelGroup);
    const size = box.getSize(new T.Vector3());
    const center = box.getCenter(new T.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const dist = maxDim * 1.6 + 2;
    camera.position.set(center.x + dist * 0.6, center.y + dist * 0.5, center.z + dist * 0.6);
    controls.target.copy(center);
    controls.update();
  }

  /* ---------------------------------------------------------
     CUTAWAY / SHOW-HIDE TOGGLES
  --------------------------------------------------------- */
  function enableCutawayMode(on, btn) {
    state.cutaway = on;
    if (casingGroup) {
      casingGroup.children.forEach((c) => {
        if (c.material) {
          const inspectionPanel = c.userData && c.userData.isExternalShell;
          c.material.opacity = on ? 0.08 : (inspectionPanel ? 0.34 : 0.9);
          c.material.depthWrite = !on && !inspectionPanel;
        }
      });
    }
    if (internalsGroup) {
      internalsGroup.traverse((obj) => {
        if (!obj.userData.isInternalShell || !obj.material) return;
        obj.material.transparent = true;
        obj.material.opacity = on ? 0.18 : 1;
        obj.material.depthWrite = !on;
      });
    }
    const b = btn || document.getElementById("btnCutaway");
    if (b) b.classList.toggle("active-mode", on);
  }

  function toggleShow(kind, btn) {
    if (kind === "water") {
      state.showWater = !state.showWater;
      btn.classList.toggle("toggle-on", state.showWater);
      btn.classList.toggle("toggle-off", !state.showWater);
    } else if (kind === "refrigerant") {
      state.showRefrigerant = !state.showRefrigerant;
      btn.classList.toggle("toggle-on", state.showRefrigerant);
      btn.classList.toggle("toggle-off", !state.showRefrigerant);
    } else if (kind === "labels") {
      state.showLabels = !state.showLabels;
      Object.values(labelSprites).forEach((l) => (l.sprite.visible = state.showLabels));
      btn.classList.toggle("toggle-on", state.showLabels);
      btn.classList.toggle("toggle-off", !state.showLabels);
    }
  }

  /* ---------------------------------------------------------
     AR VIEW (WebXR capability check only — never required)
  --------------------------------------------------------- */
  function handleARView() {
    if (navigator.xr && navigator.xr.isSessionSupported) {
      navigator.xr.isSessionSupported("immersive-ar")
        .then((supported) => {
          alert(supported
            ? "WebXR AR is supported on this device. This build offers the full interactive 3D digital twin (rotate/zoom/cutaway) as the AR-like experience."
            : "WebXR AR is not supported on this device/browser. Continuing with the interactive 3D digital twin view.");
        })
        .catch(() => alert("WebXR AR is not available. Continuing with the interactive 3D digital twin view."));
    } else {
      alert("WebXR AR is not available in this browser. Continuing with the interactive 3D digital twin view.");
    }
  }

  /* ---------------------------------------------------------
     FOLLOW FLOW / PRESENTATION SEQUENCES
  --------------------------------------------------------- */
  function followWaterFlow(btn) { toggleSequence("water", btn); }
  function followRefrigerantFlow(btn) { toggleSequence("refrigerant", btn); }

  function toggleSequence(mode, btn) {
    if (state.sequenceMode === mode) { stopSequenceMode(); return; }
    stopSequenceMode();
    state.sequenceMode = mode;
    ["btnFollowWater", "btnFollowRefrigerant", "btnPresentation"].forEach((id) => {
      const b = document.getElementById(id);
      if (b) b.classList.remove("active-mode");
    });
    if (btn) btn.classList.add("active-mode");
    runSequenceStep(mode, 0);
  }

  function stopSequenceMode() {
    if (state.sequenceTimer) { clearTimeout(state.sequenceTimer); state.sequenceTimer = null; }
    state.sequenceMode = null;
    ["btnFollowWater", "btnFollowRefrigerant", "btnPresentation"].forEach((id) => {
      const b = document.getElementById(id);
      if (b) b.classList.remove("active-mode");
    });
    if (seqBanner) seqBanner.classList.add("hidden");
    clearHighlight();
    hideInfoPanel();
  }

  function runSequenceStep(mode, idx) {
    const steps = FLOW_STEPS[mode];
    if (!steps || state.sequenceMode !== mode) return;
    const step = steps[idx % steps.length];

    clearHighlight();
    selectedId = step.id;
    const entry = componentMeshMap[step.id];
    if (entry) entry.meshes.forEach((m) => { if (m.material) { m.material.emissive.setHex(0x38d4e0); m.material.emissiveIntensity = 0.6; } });

    if (seqBanner) {
      seqBanner.classList.remove("hidden");
      seqStep.textContent = `STEP ${(idx % steps.length) + 1} / ${steps.length}`;
      seqText.textContent = step.text;
    }

    if (camera && controls && componentMeshMap[step.id] && componentMeshMap[step.id].group) {
      const entry = componentMeshMap[step.id];
      const target = (entry.focus || entry.group.position).clone();
      const offset = mode === "water" ? new window.THREE.Vector3(2.8, 1.6, 2.8) : new window.THREE.Vector3(2.4, 1.5, 2.4);
      camera.position.lerp(target.clone().add(offset), 0.45);
      controls.target.lerp(target, 0.45);
      controls.update();
    }

    state.sequenceTimer = setTimeout(() => runSequenceStep(mode, idx + 1), state.reducedMotion ? 5200 : 3600);
  }

  /* ---------------------------------------------------------
     RESIZE / RENDER LOOP
  --------------------------------------------------------- */
  function setupResize() {
    if (window.ResizeObserver) {
      resizeObserver = new ResizeObserver(() => onResize());
      resizeObserver.observe(canvasWrap);
    } else {
      window.addEventListener("resize", onResize);
    }
  }
  function onResize() {
    if (!renderer || !camera || !canvasWrap) return;
    const w = canvasWrap.clientWidth || 800;
    const h = canvasWrap.clientHeight || 560;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function startLoop() {
    if (rafId !== null || !renderer) return;
    const loop = () => {
      if (!state.active) { rafId = null; return; }
      rafId = requestAnimationFrame(loop);
      const dt = Math.min(clock.getDelta(), 0.1);
      animateRefrigerantFlow(dt);
      animateWaterFlow(dt);
      if (controls) controls.update();
      renderer.render(scene, camera);
    };
    rafId = requestAnimationFrame(loop);
  }
  function stopLoop() {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  }
})();
