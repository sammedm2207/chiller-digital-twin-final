/*
  esp32_chiller.ino
  ==================
  ESP32 firmware for the Chiller IoT Monitoring System.

  What this sketch does:
    1. Connects to your Wi-Fi network.
    2. Reads six temperature channels (T1-T6), flow rate, electrical
       power, compressor current, and compressor run status.
    3. Builds a JSON packet.
    4. POSTs the JSON to the Flask backend at /api/data.
    5. Repeats every SEND_INTERVAL_MS milliseconds.
    6. Prints connection/debug info to the Serial Monitor.

  IMPORTANT - READ BEFORE FLASHING:
    The read_T1() ... read_Power() functions below currently return
    EXAMPLE / PLACEHOLDER values. They are clearly marked. You MUST
    replace them with real sensor-reading code for your actual
    hardware (DS18B20, PT100/PT1000, thermocouple + amplifier, flow
    meter pulse counting, current/power transducer, etc.) before
    using this for real measurements.

  Required libraries (Arduino Library Manager):
    - ArduinoJson (by Benoit Blanchon)
    (WiFi.h and HTTPClient.h are bundled with the ESP32 board package)
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ------------------------------------------------------------------
// 1. WI-FI CREDENTIALS  -- CHANGE THESE
// ------------------------------------------------------------------
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// ------------------------------------------------------------------
// 2. BACKEND SERVER ADDRESS  -- CHANGE THIS
//    Replace YOUR_PC_IP with the IP address of the Windows PC
//    running the Flask backend (see README for how to find it).
//    Example: "http://192.168.1.50:5000/api/data"
// ------------------------------------------------------------------
const char* SERVER_URL = "http://YOUR_PC_IP:5000/api/data";

// ------------------------------------------------------------------
// 3. TIMING
// ------------------------------------------------------------------
const unsigned long SEND_INTERVAL_MS = 3000;   // send every 3 seconds
unsigned long lastSendTime = 0;

// ------------------------------------------------------------------
// SENSOR READ FUNCTIONS
// -----------------------------------------------------------------
// EACH FUNCTION BELOW IS A PLACEHOLDER.
// Replace the body with real code for your actual sensor hardware.
// Keep the function signature (name + return type) unchanged so the
// rest of the sketch keeps working.
// ------------------------------------------------------------------

float readT1() {
  // TODO: Replace with real Compressor Suction Temperature sensor
  // Example if using DS18B20:
  //   sensors.requestTemperatures();
  //   return sensors.getTempCByIndex(0);
  return 11.5 + random(-10, 10) / 10.0;   // <-- PLACEHOLDER EXAMPLE VALUE
}

float readT2() {
  // TODO: Replace with real Compressor Discharge Temperature sensor
  return 76.0 + random(-20, 20) / 10.0;   // <-- PLACEHOLDER EXAMPLE VALUE
}

float readT3() {
  // TODO: Replace with real Condenser Outlet Temperature sensor
  return 37.0 + random(-15, 15) / 10.0;   // <-- PLACEHOLDER EXAMPLE VALUE
}

float readT4() {
  // TODO: Replace with real Evaporator Inlet Temperature sensor
  return 3.5 + random(-10, 10) / 10.0;    // <-- PLACEHOLDER EXAMPLE VALUE
}

float readT5() {
  // TODO: Replace with real Water Inlet Temperature sensor
  return 15.5 + random(-8, 8) / 10.0;     // <-- PLACEHOLDER EXAMPLE VALUE
}

float readT6() {
  // TODO: Replace with real Water Outlet Temperature sensor
  return 10.5 + random(-8, 8) / 10.0;     // <-- PLACEHOLDER EXAMPLE VALUE
}

float readFlow() {
  // TODO: Replace with real flow sensor reading (e.g. pulse counting
  // from a turbine/paddlewheel flow meter, converted to L/min)
  return 120.0 + random(-100, 100) / 10.0;  // <-- PLACEHOLDER EXAMPLE VALUE
}

float readPower() {
  // TODO: Replace with real electrical power reading (e.g. from a
  // current/voltage transducer or a power-metering IC such as
  // ADE7758 / PZEM-004T). Value should be in kW.
  return 8.7 + random(-15, 15) / 10.0;      // <-- PLACEHOLDER EXAMPLE VALUE
}

float readCompressorCurrent() {
  // TODO: Replace with a real current sensor (e.g. SCT-013 CT clamp)
  return 18.0 + random(-20, 20) / 10.0;     // <-- PLACEHOLDER EXAMPLE VALUE
}

bool readCompressorStatus() {
  // TODO: Replace with a real digital input reading the compressor
  // contactor / run-status relay, e.g.:
  //   return digitalRead(COMPRESSOR_STATUS_PIN) == HIGH;
  return true;                              // <-- PLACEHOLDER EXAMPLE VALUE
}

// ------------------------------------------------------------------
// WI-FI CONNECTION
// ------------------------------------------------------------------
void connectWiFi() {
  Serial.print("Connecting to Wi-Fi: ");
  Serial.println(WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long startAttempt = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
    if (millis() - startAttempt > 20000) {
      Serial.println("\nWi-Fi connection timed out. Retrying...");
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
      startAttempt = millis();
    }
  }
  Serial.println("\nWi-Fi connected!");
  Serial.print("ESP32 IP address: ");
  Serial.println(WiFi.localIP());
}

// ------------------------------------------------------------------
// BUILD JSON AND SEND TO FLASK BACKEND
// ------------------------------------------------------------------
void sendReading() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi not connected. Skipping send and reconnecting...");
    connectWiFi();
    return;
  }

  StaticJsonDocument<256> doc;
  doc["T1"] = readT1();
  doc["T2"] = readT2();
  doc["T3"] = readT3();
  doc["T4"] = readT4();
  doc["T5"] = readT5();
  doc["T6"] = readT6();
  doc["flow_rate"] = readFlow();
  doc["power_kw"] = readPower();
  doc["compressor_current"] = readCompressorCurrent();
  doc["compressor_status"] = readCompressorStatus();

  String jsonPayload;
  serializeJson(doc, jsonPayload);

  HTTPClient http;
  http.begin(SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(4000);

  Serial.print("Sending: ");
  Serial.println(jsonPayload);

  int httpResponseCode = http.POST(jsonPayload);

  if (httpResponseCode > 0) {
    Serial.print("Server response code: ");
    Serial.println(httpResponseCode);
    String response = http.getString();
    Serial.print("Server response body: ");
    Serial.println(response);
  } else {
    Serial.print("HTTP POST failed. Error: ");
    Serial.println(http.errorToString(httpResponseCode));
  }

  http.end();
}

// ------------------------------------------------------------------
// ARDUINO SETUP / LOOP
// ------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n=== Chiller IoT Monitoring - ESP32 Node ===");

  randomSeed(analogRead(0));  // used only for the placeholder demo values above

  connectWiFi();

  // TODO: Initialize your real sensors here, e.g.:
  //   sensors.begin();          // DS18B20
  //   pinMode(FLOW_PIN, INPUT_PULLUP);
  //   attachInterrupt(...);     // flow pulse counting
}

void loop() {
  unsigned long now = millis();
  if (now - lastSendTime >= SEND_INTERVAL_MS) {
    lastSendTime = now;
    sendReading();
  }

  // Keep the loop responsive; add other non-blocking tasks here if needed.
  delay(10);
}
