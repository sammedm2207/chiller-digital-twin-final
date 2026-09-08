# Chiller IoT Monitoring System

Real-time chiller monitoring dashboard for a mechanical engineering project.
ESP32 sensors -> Flask backend -> SQLite -> live web dashboard (SSE, no page refresh).

## 1. Installation (Windows)

```
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

## 2. Run

```
python app.py
```

Then open your browser to:

```
http://localhost:5000
```

The SQLite database (`chiller.db`) is created automatically on first run —
no manual setup needed.

## 3. Demo Mode (for presentations without a real chiller)

Demo mode is **ON by default** so the dashboard has data immediately. It
generates smoothly-changing, realistic values and clearly labels itself
**● DEMO MODE** in the sidebar and **SIMULATED** on calculated cards.

- It turns itself **OFF automatically** the instant a real ESP32 packet
  arrives at `/api/data`.
- You can also force it on/off from the **Settings** page in the dashboard
  (checkbox: "Force Demo Mode"), or by calling:
  `POST /api/config/demo_mode  {"enabled": true}`

## 4. Connecting the real ESP32

1. Find your PC's local IP address:
   - Open Command Prompt and run `ipconfig`
   - Look for "IPv4 Address" under your active Wi-Fi adapter (e.g. `192.168.1.50`)
2. Open `esp32/esp32_chiller.ino` in the Arduino IDE.
3. Install the **ArduinoJson** library via Library Manager.
4. Edit these three lines near the top of the file:
   ```cpp
   const char* WIFI_SSID     = "YOUR_WIFI_SSID";
   const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
   const char* SERVER_URL    = "http://YOUR_PC_IP:5000/api/data";
   ```
5. Make sure the ESP32 and the PC are on the **same Wi-Fi network**.
6. Flash the sketch and open the Serial Monitor (115200 baud) to confirm
   it connects to Wi-Fi and successfully POSTs data (HTTP 200 response).
7. As soon as the backend receives a real packet, the dashboard switches
   from DEMO MODE to LIVE MODE automatically, and the ESP32 status chip
   turns green ("CONNECTED").

The `.ino` file's `readT1()` ... `readPower()` functions currently return
**placeholder example values** — they are clearly marked with `TODO` and
`PLACEHOLDER EXAMPLE VALUE` comments. Replace each with real code for your
actual sensors (DS18B20, PT100/PT1000, thermocouple, flow meter, current/
power transducer, etc.) before treating the readings as real data.

## 5. Changing sensor names / machine info / thresholds

Everything is centralized in **`config.py`**:

- `MACHINE_INFO` — manufacturer, model, refrigerant, etc.
- `SENSOR_LABELS` / `SENSOR_SHORT_LABELS` — rename T1–T6 channels
- `ALARM_THRESHOLDS` — every alarm trip point in one place
- `WATER_DENSITY_KG_M3`, `WATER_CP_KJ_KGK` — COP calculation constants
- `ESP32_TIMEOUT_SECONDS` — how long before ESP32 shows DISCONNECTED
- `DEMO_RANGES` — the value ranges used by the demo-mode simulator

Edit the file and restart `python app.py` for changes to take effect.

## 6. How COP is calculated (real thermodynamics, never faked)

```
Water ΔT (K)         = Water Inlet (T5) − Water Outlet (T6)
Mass flow (kg/s)      = Water density (kg/m³) × Flow rate (L/min → m³/s)
Cooling Capacity (kW) = Mass flow × Cp (kJ/kg·K) × ΔT
COP                   = Cooling Capacity (kW) / Electrical Power (kW)
```

If **flow rate** is unavailable: Cooling Capacity = **N/A**, COP = **N/A**.
If **electrical power** is unavailable: COP = **N/A**.
The dashboard never invents a COP value — it always shows N/A instead.

## 7. Downloading historical Excel reports

Go to the **Reports** page and click **DOWNLOAD TODAY / 24 HOURS / 7 DAYS /
30 DAYS**, or pick a custom start/end date-time and click **DOWNLOAD
CUSTOM**. Each file (`Chiller_Historical_Data_YYYY-MM-DD.xlsx`) contains:

- **Historical Data** sheet — every reading in the selected range, with a
  bold frozen header row, column widths, and an Excel auto-filter/table.
- **Summary** sheet — average/max/min COP, average/max cooling capacity,
  average power, max T2, average ΔT, alarm count, and machine info.

## 8. Troubleshooting ESP32 connection

| Symptom | Fix |
|---|---|
| ESP32 chip stays red (DISCONNECTED) | Confirm ESP32 and PC are on the same Wi-Fi network/subnet. |
| Serial Monitor shows Wi-Fi connecting forever | Double check `WIFI_SSID` / `WIFI_PASSWORD`. |
| HTTP POST fails / error in Serial Monitor | Confirm `SERVER_URL` uses the PC's current IP and port `5000`; make sure `python app.py` is running; check Windows Firewall isn't blocking inbound port 5000. |
| PC's IP address changed | Re-run `ipconfig`, update `SERVER_URL` in the `.ino` file, and reflash. |
| Dashboard shows DEMO MODE even with ESP32 running | Confirm the ESP32 is actually posting (watch Serial Monitor for HTTP 200); demo mode only turns off after a successful real packet is received. |

## 9. API Reference

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/data` | ESP32 posts a sensor reading (JSON) |
| GET | `/api/latest` | Latest reading + connection status |
| GET | `/api/history?range=1min\|5min\|15min\|1hour\|24hour\|7day\|30day\|all` | Historical rows |
| GET | `/api/alarms` | Currently active alarms |
| GET | `/api/config` | Machine info, sensor labels, thresholds, constants |
| POST | `/api/config/demo_mode` | Force demo mode on/off |
| GET | `/api/stream` | Server-Sent Events real-time feed |
| GET | `/api/export/excel?range=today\|24hour\|7day\|30day\|custom` | Download Excel report |

## Project structure

```
chiller_dashboard/
├── app.py                  Flask backend, routes, SSE, alarm engine, demo mode
├── config.py                All configurable values (machine, sensors, thresholds)
├── excel_export.py          openpyxl report builder
├── requirements.txt
├── chiller.db                created automatically on first run
├── templates/
│   └── index.html
├── static/
│   ├── style.css
│   └── app.js
└── esp32/
    └── esp32_chiller.ino
```
