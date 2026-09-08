"""
config.py
=========
Central configuration file for the Chiller IoT Monitoring System.

Edit the values in this file to match your real machine, your sensor
wiring, and your site preferences. Nothing else in the codebase needs
to change when you edit this file.
"""

# ------------------------------------------------------------------
# INSTITUTION / BRANDING
# ------------------------------------------------------------------
INSTITUTION_NAME = "WALCHAND INSTITUTE OF TECHNOLOGY"
PROJECT_TITLE = "CHILLER IoT MONITORING SYSTEM"
PROJECT_SUBTITLE = "Industrial IoT - Chiller Performance Monitoring"

# ------------------------------------------------------------------
# MACHINE INFORMATION (shown in the "Machine Information" panel)
# ------------------------------------------------------------------
MACHINE_INFO = {
    "manufacturer": "Blue Star",
    "model": "XAC2YS-038MAR3",
    "cooling_capacity": "37.1 TR",
    "refrigerant": "R410A",
    "power_supply": "400V | 3 Phase | 50Hz",
    "rated_current": "91 A",
    "machine_id": "CHILLER-01",
}

# ------------------------------------------------------------------
# SENSOR / CHANNEL LABELS
# Change these to relabel a channel without touching any other code.
# ------------------------------------------------------------------
SENSOR_LABELS = {
    "T1": "Compressor Suction Temperature",
    "T2": "Compressor Discharge Temperature",
    "T3": "Condenser Outlet Temperature",
    "T4": "Evaporator Inlet Temperature",
    "T5": "Water Inlet Temperature",
    "T6": "Water Outlet Temperature",
}

# Short labels used on the compact temperature cards
SENSOR_SHORT_LABELS = {
    "T1": "Comp. Suction",
    "T2": "Comp. Discharge",
    "T3": "Condenser Outlet",
    "T4": "Evaporator Inlet",
    "T5": "Water Inlet",
    "T6": "Water Outlet",
}

# ------------------------------------------------------------------
# THERMODYNAMIC / COP CALCULATION CONSTANTS
# ------------------------------------------------------------------
WATER_DENSITY_KG_M3 = 1000.0        # kg / m^3
WATER_CP_KJ_KGK = 4.186             # kJ / (kg . K)

# flow_rate is expected in Litres / minute from the ESP32.
# Conversion: L/min -> m3/s  =>  (L/min) * (1/1000) * (1/60)
FLOW_LPM_TO_M3S = 1.0 / (1000.0 * 60.0)

# Water inlet / outlet sensor keys used for delta-T and COP
WATER_INLET_SENSOR = "T5"
WATER_OUTLET_SENSOR = "T6"

# ------------------------------------------------------------------
# CONNECTION / TIMEOUT SETTINGS
# ------------------------------------------------------------------
# If no ESP32 packet is received within this many seconds, the
# dashboard will mark the ESP32 as DISCONNECTED.
ESP32_TIMEOUT_SECONDS = 10

# How often (seconds) the demo-mode data generator pushes a new
# simulated reading when DEMO_MODE is enabled.
DEMO_MODE_INTERVAL_SECONDS = 2

# Demo mode is automatically enabled at startup if no real ESP32
# data has been received. It automatically turns off the moment a
# real packet arrives, and can also be forced on/off via /api/config.
DEMO_MODE_DEFAULT = True

# ------------------------------------------------------------------
# ALARM THRESHOLDS
# Put every threshold here so nothing is scattered in app.py.
# ------------------------------------------------------------------
ALARM_THRESHOLDS = {
    "T2_WARNING": 75.0,     # deg C - Compressor discharge warning
    "T2_CRITICAL": 85.0,    # deg C - Compressor discharge critical
    "T3_WARNING": 45.0,     # deg C - Condenser outlet warning
    "T3_CRITICAL": 55.0,    # deg C - Condenser outlet critical
    "LOW_FLOW_WARNING": 60.0,   # L/min - below this = warning
    "LOW_FLOW_CRITICAL": 30.0,  # L/min - below this = critical
    "LOW_COP_WARNING": 2.5,     # below this COP = warning
    "HIGH_POWER_WARNING": 12.0,  # kW
    "HIGH_POWER_CRITICAL": 15.0,  # kW
}

# ------------------------------------------------------------------
# DEMO MODE SIMULATION RANGES
# ------------------------------------------------------------------
DEMO_RANGES = {
    "T1": (8.0, 15.0),
    "T2": (65.0, 85.0),
    "T3": (30.0, 40.0),
    "T4": (2.0, 6.0),
    "T5": (14.0, 18.0),
    "T6": (9.0, 13.0),
    "flow_rate": (100.0, 140.0),
    "power_kw": (6.0, 11.0),
    "compressor_current": (14.0, 22.0),
}

# ------------------------------------------------------------------
# DATABASE
# ------------------------------------------------------------------
DATABASE_FILE = "chiller.db"

# ------------------------------------------------------------------
# FLASK / SERVER
# ------------------------------------------------------------------
HOST = "0.0.0.0"
PORT = 5000
DEBUG = False

# Maximum number of historical rows kept in memory for the live
# in-browser graphs before older points are dropped (per series).
MAX_LIVE_GRAPH_POINTS = 720   # e.g. 720 points at 5s interval = 1 hour
