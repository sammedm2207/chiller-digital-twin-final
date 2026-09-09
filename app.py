"""
app.py
======
Flask backend for the Chiller IoT Monitoring System.

Data flow:
    ESP32 -> POST /api/data -> validate -> calculate -> save to SQLite
           -> push to SSE subscribers -> browser updates live.

Run with:
    python app.py
"""

import json
import math
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from io import BytesIO
from queue import Queue, Empty

from flask import Flask, request, jsonify, Response, render_template, send_file

import config

app = Flask(__name__)

# ------------------------------------------------------------------
# GLOBAL, THREAD-SAFE STATE
# ------------------------------------------------------------------
STATE_LOCK = threading.Lock()

STATE = {
    "last_reading": None,       # most recent processed reading (dict)
    "last_esp32_time": None,    # datetime of last REAL esp32 packet
    "demo_mode": config.DEMO_MODE_DEFAULT,
    "server_start_time": datetime.now(timezone.utc),
    "active_alarms": [],        # list of current alarm dicts
}

# Each connected browser tab gets its own Queue. When a new reading is
# processed we push it into every queue so /api/stream can yield it.
SSE_SUBSCRIBERS = []
SSE_LOCK = threading.Lock()


# ------------------------------------------------------------------
# DATABASE
# ------------------------------------------------------------------
def get_db():
    conn = sqlite3.connect(config.DATABASE_FILE, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Create the database/table automatically if they do not exist."""
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS readings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            T1 REAL, T2 REAL, T3 REAL, T4 REAL, T5 REAL, T6 REAL,
            flow_rate REAL,
            power_kw REAL,
            compressor_current REAL,
            compressor_status INTEGER,
            cooling_capacity REAL,
            delta_t REAL,
            cop REAL,
            source TEXT
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_readings_timestamp ON readings(timestamp)"
    )
    conn.commit()
    conn.close()


def insert_reading(reading, source="LIVE"):
    """Persist a processed reading into SQLite. Never overwrites history."""
    conn = get_db()
    conn.execute(
        """
        INSERT INTO readings
        (timestamp, T1, T2, T3, T4, T5, T6, flow_rate, power_kw,
         compressor_current, compressor_status, cooling_capacity,
         delta_t, cop, source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            reading["timestamp"],
            reading["T1"], reading["T2"], reading["T3"],
            reading["T4"], reading["T5"], reading["T6"],
            reading["flow_rate"], reading["power_kw"],
            reading["compressor_current"],
            1 if reading["compressor_status"] else 0,
            reading["cooling_capacity"], reading["delta_t"], reading["cop"],
            source,
        ),
    )
    conn.commit()
    conn.close()


# ------------------------------------------------------------------
# VALIDATION HELPERS
# ------------------------------------------------------------------
def safe_float(value):
    """Return a float if value is a valid finite number, else None."""
    if value is None:
        return None
    try:
        f = float(value)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except (TypeError, ValueError):
        return None


def parse_incoming_payload(payload):
    """
    Validate & normalize the incoming ESP32 JSON.
    Missing / malformed fields become None so the rest of the app can
    safely display "N/A" without ever crashing.
    """
    fields = [
        "T1", "T2", "T3", "T4", "T5", "T6",
        "flow_rate", "power_kw", "compressor_current",
    ]
    clean = {}
    for f in fields:
        clean[f] = safe_float(payload.get(f))

    comp_status = payload.get("compressor_status", None)
    if isinstance(comp_status, bool):
        clean["compressor_status"] = comp_status
    elif isinstance(comp_status, (int, float)):
        clean["compressor_status"] = bool(comp_status)
    elif isinstance(comp_status, str):
        clean["compressor_status"] = comp_status.strip().lower() in (
            "true", "1", "on", "running", "yes",
        )
    else:
        clean["compressor_status"] = False

    return clean


# ------------------------------------------------------------------
# CALCULATIONS  (real thermodynamics, never faked)
# ------------------------------------------------------------------
def calculate_performance(clean):
    """
    Compute delta_t, cooling_capacity (kW) and COP from a cleaned
    reading dict. Any missing dependency correctly yields None
    (displayed as N/A by the frontend) rather than an invented value.
    """
    t_in = clean.get(config.WATER_INLET_SENSOR)
    t_out = clean.get(config.WATER_OUTLET_SENSOR)
    flow = clean.get("flow_rate")
    power = clean.get("power_kw")

    delta_t = None
    if t_in is not None and t_out is not None:
        delta_t = round(t_in - t_out, 3)

    cooling_capacity = None
    if flow is not None and delta_t is not None:
        # m_dot (kg/s) = density (kg/m3) * volumetric flow (m3/s)
        vol_flow_m3s = flow * config.FLOW_LPM_TO_M3S
        m_dot = config.WATER_DENSITY_KG_M3 * vol_flow_m3s  # kg/s
        # Q (kW) = m_dot (kg/s) * Cp (kJ/kg.K) * delta_t (K)
        cooling_capacity = round(m_dot * config.WATER_CP_KJ_KGK * delta_t, 3)

    cop = None
    if cooling_capacity is not None and power is not None and power > 0:
        cop = round(cooling_capacity / power, 3)

    return delta_t, cooling_capacity, cop


# ------------------------------------------------------------------
# ALARM ENGINE
# ------------------------------------------------------------------
def evaluate_alarms(clean, cop):
    """Return a list of alarm dicts based on config.ALARM_THRESHOLDS."""
    th = config.ALARM_THRESHOLDS
    alarms = []
    now_utc = datetime.now(timezone.utc)
    now_str = now_utc.strftime("%H:%M:%S")
    timestamp = now_utc.isoformat(timespec="seconds").replace("+00:00", "Z")

    t2 = clean.get("T2")
    if t2 is not None:
        if t2 > th["T2_CRITICAL"]:
            alarms.append(_alarm("CRITICAL", "High Compressor Discharge Temperature", f"{t2:.1f} °C", now_str, timestamp))
        elif t2 > th["T2_WARNING"]:
            alarms.append(_alarm("WARNING", "High Compressor Discharge Temperature", f"{t2:.1f} °C", now_str, timestamp))

    t3 = clean.get("T3")
    if t3 is not None:
        if t3 > th["T3_CRITICAL"]:
            alarms.append(_alarm("CRITICAL", "High Condenser Outlet Temperature", f"{t3:.1f} °C", now_str, timestamp))
        elif t3 > th["T3_WARNING"]:
            alarms.append(_alarm("WARNING", "High Condenser Outlet Temperature", f"{t3:.1f} °C", now_str, timestamp))

    flow = clean.get("flow_rate")
    if flow is not None:
        if flow < th["LOW_FLOW_CRITICAL"]:
            alarms.append(_alarm("CRITICAL", "Low Chilled Water Flow", f"{flow:.1f} L/min", now_str, timestamp))
        elif flow < th["LOW_FLOW_WARNING"]:
            alarms.append(_alarm("WARNING", "Low Chilled Water Flow", f"{flow:.1f} L/min", now_str, timestamp))

    if cop is not None and cop < th["LOW_COP_WARNING"]:
        alarms.append(_alarm("WARNING", "Low Coefficient of Performance", f"{cop:.2f}", now_str, timestamp))

    power = clean.get("power_kw")
    if power is not None:
        if power > th["HIGH_POWER_CRITICAL"]:
            alarms.append(_alarm("CRITICAL", "High Electrical Power Draw", f"{power:.2f} kW", now_str, timestamp))
        elif power > th["HIGH_POWER_WARNING"]:
            alarms.append(_alarm("WARNING", "High Electrical Power Draw", f"{power:.2f} kW", now_str, timestamp))

    return alarms


def _alarm(severity, message, value, time_str, timestamp):
    return {"severity": severity, "message": message, "value": value, "time": time_str, "timestamp": timestamp}


def compute_machine_status(clean, esp32_connected, alarms):
    if not esp32_connected and not STATE["demo_mode"]:
        return "OFFLINE"
    if any(a["severity"] == "CRITICAL" for a in alarms):
        return "FAULT"
    if any(a["severity"] == "WARNING" for a in alarms):
        return "WARNING"
    if clean.get("compressor_status"):
        return "RUNNING"
    return "STOPPED"


# ------------------------------------------------------------------
# CORE PROCESSING PIPELINE (shared by real ESP32 data & demo mode)
# ------------------------------------------------------------------
def process_reading(clean, source):
    delta_t, cooling_capacity, cop = calculate_performance(clean)
    alarms = evaluate_alarms(clean, cop)

    esp32_connected = is_esp32_connected()
    machine_status = compute_machine_status(clean, esp32_connected, alarms)

    reading = {
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "T1": clean.get("T1"), "T2": clean.get("T2"), "T3": clean.get("T3"),
        "T4": clean.get("T4"), "T5": clean.get("T5"), "T6": clean.get("T6"),
        "flow_rate": clean.get("flow_rate"),
        "power_kw": clean.get("power_kw"),
        "compressor_current": clean.get("compressor_current"),
        "compressor_status": clean.get("compressor_status"),
        "cooling_capacity": cooling_capacity,
        "delta_t": delta_t,
        "cop": cop,
        "source": source,
        "machine_status": machine_status,
        "mode": "LIVE",
    }

    insert_reading(reading, source=source)

    with STATE_LOCK:
        STATE["last_reading"] = reading
        STATE["active_alarms"] = alarms
        if source == "LIVE":
            STATE["last_esp32_time"] = datetime.now(timezone.utc)
            STATE["demo_mode"] = False

    broadcast_sse({"type": "reading", "data": reading, "alarms": alarms})
    return reading, alarms


def is_esp32_connected():
    last = STATE.get("last_esp32_time")
    if last is None:
        return False
    return (datetime.now(timezone.utc) - last).total_seconds() <= config.ESP32_TIMEOUT_SECONDS


# ------------------------------------------------------------------
# SERVER-SENT EVENTS
# ------------------------------------------------------------------
def broadcast_sse(payload):
    data = json.dumps(payload)
    with SSE_LOCK:
        dead = []
        for q in SSE_SUBSCRIBERS:
            try:
                q.put_nowait(data)
            except Exception:
                dead.append(q)
        for q in dead:
            SSE_SUBSCRIBERS.remove(q)


@app.route("/api/stream")
def api_stream():
    q = Queue()
    with SSE_LOCK:
        SSE_SUBSCRIBERS.append(q)

    def gen():
        try:
            # Send an immediate snapshot so the UI has data right away
            with STATE_LOCK:
                snapshot = STATE["last_reading"]
                snapshot_alarms = list(STATE["active_alarms"])
            if snapshot:
                yield f"data: {json.dumps({'type': 'reading', 'data': snapshot, 'alarms': snapshot_alarms})}\n\n"
            while True:
                try:
                    data = q.get(timeout=15)
                    yield f"data: {data}\n\n"
                except Empty:
                    # heartbeat / keep-alive comment so proxies don't close it
                    yield ": heartbeat\n\n"
        except GeneratorExit:
            with SSE_LOCK:
                if q in SSE_SUBSCRIBERS:
                    SSE_SUBSCRIBERS.remove(q)

    return Response(gen(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    })


# ------------------------------------------------------------------
# ROUTES
# ------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/data", methods=["POST"])
def api_data():
    """Endpoint the ESP32 posts sensor JSON to."""
    try:
        payload = request.get_json(force=True, silent=True)
        if payload is None or not isinstance(payload, dict):
            return jsonify({"status": "error", "message": "Invalid or missing JSON body"}), 400

        clean = parse_incoming_payload(payload)
        reading, alarms = process_reading(clean, source="LIVE")
        return jsonify({"status": "ok", "received": reading}), 200
    except Exception as e:
        # Never crash the server because of one bad packet
        return jsonify({"status": "error", "message": str(e)}), 400


@app.route("/api/latest")
def api_latest():
    with STATE_LOCK:
        reading = STATE["last_reading"]
        alarms = STATE["active_alarms"]
        demo_mode = STATE["demo_mode"]

    esp32_connected = is_esp32_connected()
    last_esp32 = STATE.get("last_esp32_time")

    return jsonify({
        "reading": reading,
        "alarms": alarms,
        "demo_mode": demo_mode,
        "backend_status": "ONLINE",
        "esp32_status": "CONNECTED" if esp32_connected else "DISCONNECTED",
        "last_esp32_time": last_esp32.isoformat(timespec="seconds").replace("+00:00", "Z") if last_esp32 else None,
        "server_time": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    })


@app.route("/api/history")
def api_history():
    """
    Query params:
      range = 1min | 5min | 15min | 1hour | 24hour | 7day | 30day | all
      limit = optional max rows (default 2000)
    """
    range_key = request.args.get("range", "1hour")
    limit = request.args.get("limit", default=2000, type=int)
    source = request.args.get("source")

    ranges = {
        "1min": timedelta(minutes=1),
        "5min": timedelta(minutes=5),
        "15min": timedelta(minutes=15),
        "1hour": timedelta(hours=1),
        "24hour": timedelta(hours=24),
        "7day": timedelta(days=7),
        "30day": timedelta(days=30),
    }

    conn = get_db()
    source_clause = " AND source = ?" if source in ("LIVE", "DEMO") else ""
    if range_key == "all":
        cur = conn.execute(
            f"SELECT * FROM readings WHERE 1=1{source_clause} ORDER BY id DESC LIMIT ?",
            ((source, limit) if source_clause else (limit,)),
        )
    else:
        delta = ranges.get(range_key, timedelta(hours=1))
        since = (datetime.now(timezone.utc) - delta).isoformat(timespec="seconds").replace("+00:00", "Z")
        cur = conn.execute(
            f"SELECT * FROM readings WHERE timestamp >= ?{source_clause} ORDER BY id DESC LIMIT ?",
            ((since, source, limit) if source_clause else (since, limit)),
        )
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    rows.reverse()  # chronological order for charts
    return jsonify({"range": range_key, "count": len(rows), "rows": rows})


@app.route("/api/alarms")
def api_alarms():
    with STATE_LOCK:
        alarms = STATE["active_alarms"]
    return jsonify({"alarms": alarms, "count": len(alarms)})


@app.route("/api/config")
def api_config():
    return jsonify({
        "machine_info": config.MACHINE_INFO,
        "sensor_labels": config.SENSOR_LABELS,
        "sensor_short_labels": config.SENSOR_SHORT_LABELS,
        "thresholds": config.ALARM_THRESHOLDS,
        "esp32_timeout": config.ESP32_TIMEOUT_SECONDS,
        "water_density": config.WATER_DENSITY_KG_M3,
        "water_cp": config.WATER_CP_KJ_KGK,
        "demo_mode": STATE["demo_mode"],
        "institution": config.INSTITUTION_NAME,
        "project_title": config.PROJECT_TITLE,
        "project_subtitle": config.PROJECT_SUBTITLE,
        "max_live_points": config.MAX_LIVE_GRAPH_POINTS,
    })


@app.route("/api/config/demo_mode", methods=["POST"])
def api_set_demo_mode():
    """Keep the legacy endpoint compatible while disabling fake readings."""
    with STATE_LOCK:
        STATE["demo_mode"] = False
    return jsonify({"status": "ok", "demo_mode": False})


@app.route("/api/export/excel")
def api_export_excel():
    """
    Query params:
      range = today | 24hour | 7day | 30day | custom
      start, end = ISO date strings, required if range=custom
    """
    from excel_export import build_excel_report

    range_key = request.args.get("range", "today")
    start_param = request.args.get("start")
    end_param = request.args.get("end")

    now = datetime.now(timezone.utc)
    if range_key == "today":
        since = now.replace(hour=0, minute=0, second=0, microsecond=0)
        until = now
    elif range_key == "24hour":
        since = now - timedelta(hours=24)
        until = now
    elif range_key == "7day":
        since = now - timedelta(days=7)
        until = now
    elif range_key == "30day":
        since = now - timedelta(days=30)
        until = now
    elif range_key == "custom" and start_param and end_param:
        try:
            since = datetime.fromisoformat(start_param)
            until = datetime.fromisoformat(end_param)
        except ValueError:
            return jsonify({"status": "error", "message": "Invalid custom date range"}), 400
    else:
        return jsonify({"status": "error", "message": "Invalid range"}), 400

    conn = get_db()
    cur = conn.execute(
        "SELECT * FROM readings WHERE timestamp >= ? AND timestamp <= ? ORDER BY id ASC",
        (since.isoformat(timespec="seconds"), until.isoformat(timespec="seconds")),
    )
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()

    wb_bytes = build_excel_report(rows, config)
    filename = f"Chiller_Historical_Data_{now.strftime('%Y-%m-%d')}.xlsx"

    return send_file(
        BytesIO(wb_bytes),
        as_attachment=True,
        download_name=filename,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


init_db()

if __name__ == "__main__":
    app.run(host=config.HOST, port=config.PORT, debug=config.DEBUG, threaded=True)
