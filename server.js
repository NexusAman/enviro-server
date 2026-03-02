require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// ─── Persistence ──────────────────────────────────────────────────────────────
// Render.com free tier wipes in-memory state on every restart/redeploy.
// We persist userStore to a JSON file so registered users survive restarts.
// NOTE: Render's disk IS wiped on redeploy (free tier), but survives crashes
// and idle-restarts. For true persistence across redeploys, use Upstash Redis.
const STORE_PATH = path.join(__dirname, "userStore.json");

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      // JSON doesn't preserve Map — it was saved as an array of [key, value] pairs
      return new Map(parsed);
    }
  } catch (err) {
    console.warn("⚠️ Could not load userStore from disk:", err.message);
  }
  return new Map();
}

function saveStore() {
  try {
    // Map → array of [key, value] pairs for JSON serialization
    fs.writeFileSync(STORE_PATH, JSON.stringify([...userStore.entries()]), "utf-8");
  } catch (err) {
    console.warn("⚠️ Could not persist userStore to disk:", err.message);
  }
}

// ─── Risk Thresholds (mirrors riskThresholds.ts exactly) ─────────────────────
const RISK_LIMITS = {
  PM25_WARNING: 12,
  PM25_SEVERE: 35,
  PM25_DANGER: 55,
  UV_WARNING: 3,
  UV_DANGER: 6,
  TEMP_WARNING: 35,
  TEMP_DANGER: 40,
  VISIBILITY_WARNING: 5,
  VISIBILITY_DANGER: 2,
  WIND_WARNING: 40,
  WIND_DANGER: 70,
};

// ─── Risk Engine ──────────────────────────────────────────────────────────────
function evaluateRisk(data) {
  const alerts = [];
  const pm25 = data?.current?.air_quality?.pm2_5;
  const uv = data?.current?.uv;
  const temp = data?.current?.temp_c;
  const visibility = data?.current?.vis_km;
  const wind = data?.current?.wind_kph;

  if (pm25 == null || uv == null || temp == null || visibility == null) return alerts;

  if (pm25 > RISK_LIMITS.PM25_DANGER) {
    alerts.push({ type: "AirQuality_danger", severity: "danger", message: `🫁 Hazardous air — PM2.5 at ${pm25.toFixed(1)} µg/m³. Stay indoors.` });
  } else if (pm25 > RISK_LIMITS.PM25_SEVERE) {
    alerts.push({ type: "AirQuality_severe", severity: "severe", message: `😷 Unhealthy air — PM2.5 at ${pm25.toFixed(1)} µg/m³. Wear a mask outdoors.` });
  }

  if (uv > RISK_LIMITS.UV_DANGER) {
    alerts.push({ type: "UV_danger", severity: "danger", message: `☀️ Extreme UV index (${uv}). Avoid direct sun, use SPF 50+.` });
  }

  if (temp > RISK_LIMITS.TEMP_DANGER) {
    alerts.push({ type: "Temp_danger", severity: "danger", message: `🌡 Extreme heat — ${temp}°C. Risk of heatstroke. Stay indoors.` });
  }

  if (visibility < RISK_LIMITS.VISIBILITY_DANGER) {
    alerts.push({ type: "Visibility_danger", severity: "danger", message: `🌫 Very poor visibility — ${visibility} km. Avoid driving.` });
  }

  if (wind != null && wind > RISK_LIMITS.WIND_DANGER) {
    alerts.push({ type: "Wind_danger", severity: "danger", message: `💨 Storm-level winds — ${wind} km/h. Stay indoors.` });
  }

  return alerts;
}

// ─── In-memory token store (loaded from disk on startup) ─────────────────────
// { fcmToken → { fcmToken, latitude, longitude, appOpen, lastAlertedTypes[] } }
const userStore = loadStore();
console.log(`📂 Loaded ${userStore.size} user(s) from disk`);

// ─── Expo Push Notification Sender ───────────────────────────────────────────
async function sendExpoPushNotification(expoToken, alert) {
  const title = alert.severity === "danger"
    ? "🚨 Dangerous Condition"
    : "⚠️ Severe Condition";

  try {
    const response = await axios.post(
      "https://exp.host/--/api/v2/push/send",
      {
        to: expoToken,
        title,
        body: alert.message,
        sound: "default",
        priority: "high",
        data: { type: alert.type, severity: alert.severity },
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Accept-Encoding": "gzip, deflate",
        },
      }
    );

    const result = response.data?.data;

    if (result?.status === "error") {
      console.warn(`❌ Expo push error for ${expoToken.slice(0, 30)}:`, result.message);

      if (
        result.details?.error === "DeviceNotRegistered" ||
        result.details?.error === "InvalidCredentials"
      ) {
        console.log(`🗑 Removing invalid token: ${expoToken.slice(0, 30)}...`);
        userStore.delete(expoToken);
        saveStore(); // persist removal
      }
    } else {
      console.log(`✅ Sent [${alert.type}] to ${expoToken.slice(0, 30)}...`);
    }
  } catch (err) {
    console.warn(`❌ Failed to send push to ${expoToken.slice(0, 30)}:`, err.message);
  }
}

// ─── Check all registered users ───────────────────────────────────────────────
async function checkAllUsers() {
  if (userStore.size === 0) {
    console.log("ℹ️ No registered users, skipping check.");
    return;
  }

  console.log(`\n🔍 Checking ${userStore.size} user(s) at ${new Date().toLocaleTimeString()}`);

  for (const [expoToken, user] of userStore.entries()) {
    try {
      if (user.appOpen) {
        console.log(`⏭ Skipping push for ${expoToken.slice(0, 30)}... (app is open)`);
        continue;
      }

      const response = await axios.get("https://api.weatherapi.com/v1/current.json", {
        params: {
          key: process.env.WEATHER_API_KEY,
          q: `${user.latitude},${user.longitude}`,
          aqi: "yes",
        },
      });

      const allAlerts = evaluateRisk(response.data);
      const severeAndAbove = allAlerts.filter(
        (a) => a.severity === "severe" || a.severity === "danger"
      );

      const newAlerts = severeAndAbove.filter(
        (a) => !user.lastAlertedTypes.includes(a.type)
      );

      for (const alert of newAlerts) {
        await sendExpoPushNotification(expoToken, alert);
      }

      user.lastAlertedTypes = severeAndAbove.map((a) => a.type);

    } catch (err) {
      console.warn(`⚠️ Failed to check user ${expoToken.slice(0, 30)}:`, err.message);
    }
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.post("/register", (req, res) => {
  const { fcmToken, latitude, longitude } = req.body;

  if (!fcmToken || !latitude || !longitude) {
    return res.status(400).json({ error: "fcmToken, latitude, and longitude are required." });
  }

  if (!fcmToken.startsWith("ExponentPushToken[")) {
    return res.status(400).json({ error: "Invalid token format. Expected ExponentPushToken[...]." });
  }

  const existing = userStore.get(fcmToken);

  userStore.set(fcmToken, {
    fcmToken,
    latitude,
    longitude,
    appOpen: false,
    // Preserve lastAlertedTypes if already registered — avoids re-sending
    // alerts the user already received before the server restarted.
    lastAlertedTypes: existing?.lastAlertedTypes ?? [],
  });

  saveStore(); // ← persist to disk immediately

  console.log(`📱 Registered: ${fcmToken.slice(0, 35)}... at (${latitude}, ${longitude})`);
  res.json({ success: true, message: "Device registered for push alerts." });
});

app.post("/update-location", (req, res) => {
  const { fcmToken, latitude, longitude, appOpen } = req.body;

  if (!fcmToken || !latitude || !longitude) {
    return res.status(400).json({ error: "fcmToken, latitude, and longitude are required." });
  }

  if (!userStore.has(fcmToken)) {
    if (!fcmToken.startsWith("ExponentPushToken[")) {
      return res.status(400).json({ error: "Invalid token format." });
    }

    userStore.set(fcmToken, {
      fcmToken,
      latitude,
      longitude,
      appOpen: appOpen ?? false,
      lastAlertedTypes: [],
    });

    saveStore(); // ← persist new auto-registration

    console.log(`🔄 Auto-registered on update: ${fcmToken.slice(0, 35)}...`);
    return res.json({ success: true, message: "Device auto-registered." });
  }

  const user = userStore.get(fcmToken);
  user.latitude = latitude;
  user.longitude = longitude;
  user.appOpen = appOpen ?? false;

  // NOTE: We intentionally do NOT saveStore() here on every location update
  // (could be every 2 minutes × N users = lots of disk writes).
  // The user record is in memory; /register and token removal do the saves.

  console.log(`📍 Location updated: ${fcmToken.slice(0, 35)}... appOpen=${user.appOpen}`);
  res.json({ success: true });
});

// cron-job.org calls this every 5 minutes
app.get("/check", async (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  await checkAllUsers();
  res.json({ success: true, usersChecked: userStore.size });
});

// Render.com health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    users: userStore.size,
    time: new Date().toISOString(),
  });
});

// ─── Debug endpoint — list all registered tokens (remove before production) ──
app.get("/users", (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized." });
  }
  const users = [...userStore.values()].map((u) => ({
    token: u.fcmToken.slice(0, 35) + "...",
    latitude: u.latitude,
    longitude: u.longitude,
    appOpen: u.appOpen,
    alertedTypes: u.lastAlertedTypes,
  }));
  res.json({ count: userStore.size, users });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌿 Enviro Monitor server running on port ${PORT}`);
  console.log(`📡 Using Expo Push API — no Firebase required`);
  console.log(`⏱  Push checks triggered by cron-job.org every 5 minutes`);
});
