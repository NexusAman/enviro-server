require("dotenv").config();
const express = require("express");
const admin = require("firebase-admin");
const axios = require("axios");
const cron = require("node-cron");

const app = express();
app.use(express.json());

// ─── Firebase Init ────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ─── Risk Thresholds (mirrors your riskThresholds.ts) ────────────────────────
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

// ─── Risk Engine (mirrors your riskEngine.ts) ─────────────────────────────────
function evaluateRisk(data) {
  const alerts = [];
  const pm25 = data?.current?.air_quality?.pm2_5;
  const uv = data?.current?.uv;
  const temp = data?.current?.temp_c;
  const visibility = data?.current?.vis_km;
  const wind = data?.current?.wind_kph;

  if (pm25 == null || uv == null || temp == null || visibility == null) return alerts;

  // Air Quality
  if (pm25 > RISK_LIMITS.PM25_DANGER) {
    alerts.push({ type: "AirQuality_danger", severity: "danger", message: `🫁 Hazardous air — PM2.5 at ${pm25.toFixed(1)} µg/m³. Stay indoors.` });
  } else if (pm25 > RISK_LIMITS.PM25_SEVERE) {
    alerts.push({ type: "AirQuality_severe", severity: "severe", message: `😷 Unhealthy air — PM2.5 at ${pm25.toFixed(1)} µg/m³. Wear a mask outdoors.` });
  }

  // UV
  if (uv > RISK_LIMITS.UV_DANGER) {
    alerts.push({ type: "UV_danger", severity: "danger", message: `☀️ Extreme UV index (${uv}). Avoid direct sun, use SPF 50+.` });
  }

  // Temperature
  if (temp > RISK_LIMITS.TEMP_DANGER) {
    alerts.push({ type: "Temp_danger", severity: "danger", message: `🌡 Extreme heat — ${temp}°C. Risk of heatstroke. Stay indoors.` });
  }

  // Visibility
  if (visibility < RISK_LIMITS.VISIBILITY_DANGER) {
    alerts.push({ type: "Visibility_danger", severity: "danger", message: `🌫 Very poor visibility — ${visibility} km. Avoid driving.` });
  }

  // Wind
  if (wind != null && wind > RISK_LIMITS.WIND_DANGER) {
    alerts.push({ type: "Wind_danger", severity: "danger", message: `💨 Storm-level winds — ${wind} km/h. Stay indoors.` });
  }

  return alerts;
}

// ─── In-memory token store ────────────────────────────────────────────────────
// Stores: { fcmToken, latitude, longitude, lastAlertedTypes: [] }
const userStore = new Map();

// ─── FCM Send ─────────────────────────────────────────────────────────────────
async function sendPushNotification(fcmToken, alert) {
  const title = alert.severity === "danger"
    ? "🚨 Dangerous Condition"
    : "⚠️ Severe Condition";

  try {
    await admin.messaging().send({
      token: fcmToken,
      notification: {
        title,
        body: alert.message,
      },
      android: {
        priority: "high",
        notification: {
          color: alert.severity === "danger" ? "#E879F9" : "#F87171",
          sound: "default",
        },
      },
      apns: {
        payload: {
          aps: {
            sound: "default",
            badge: 1,
          },
        },
      },
    });
    console.log(`✅ Sent [${alert.type}] to ${fcmToken.slice(0, 20)}...`);
  } catch (err) {
    console.warn(`❌ Failed to send to ${fcmToken.slice(0, 20)}:`, err.message);
    // Remove invalid tokens
    if (err.code === "messaging/invalid-registration-token" ||
        err.code === "messaging/registration-token-not-registered") {
      userStore.delete(fcmToken);
    }
  }
}

// ─── Check conditions for all registered users ────────────────────────────────
async function checkAllUsers() {
  if (userStore.size === 0) return;
  console.log(`\n🔍 Checking ${userStore.size} user(s) at ${new Date().toLocaleTimeString()}`);

  for (const [fcmToken, user] of userStore.entries()) {
    try {
      const response = await axios.get("https://api.weatherapi.com/v1/current.json", {
        params: {
          key: process.env.WEATHER_API_KEY,
          q: `${user.latitude},${user.longitude}`,
          aqi: "yes",
        },
      });

      const alerts = evaluateRisk(response.data);
      const severeAndAbove = alerts.filter(
        (a) => a.severity === "severe" || a.severity === "danger"
      );

      // Only send NEW alerts — deduplication mirrors your app logic
      const newAlerts = severeAndAbove.filter(
        (a) => !user.lastAlertedTypes.includes(a.type)
      );

      for (const alert of newAlerts) {
        await sendPushNotification(fcmToken, alert);
      }

      // Update alerted types — remove cleared, add new
      user.lastAlertedTypes = severeAndAbove.map((a) => a.type);

    } catch (err) {
      console.warn(`Failed to check user ${fcmToken.slice(0, 20)}:`, err.message);
    }
  }
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// App calls this on launch to register the device
app.post("/register", (req, res) => {
  const { fcmToken, latitude, longitude } = req.body;

  if (!fcmToken || !latitude || !longitude) {
    return res.status(400).json({ error: "fcmToken, latitude, longitude required" });
  }

  userStore.set(fcmToken, {
    fcmToken,
    latitude,
    longitude,
    lastAlertedTypes: [],
  });

  console.log(`📱 Registered device: ${fcmToken.slice(0, 20)}... at ${latitude}, ${longitude}`);
  res.json({ success: true, message: "Device registered for alerts" });
});

// App calls this when location changes
app.post("/update-location", (req, res) => {
  const { fcmToken, latitude, longitude } = req.body;

  if (!fcmToken || !userStore.has(fcmToken)) {
    return res.status(404).json({ error: "Device not registered" });
  }

  const user = userStore.get(fcmToken);
  user.latitude = latitude;
  user.longitude = longitude;

  console.log(`📍 Updated location for ${fcmToken.slice(0, 20)}...`);
  res.json({ success: true });
});

// cron-job.org pings this every 5 minutes to trigger checks
app.get("/check", async (req, res) => {
  // Simple secret to prevent unauthorized pings
  if (req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  await checkAllUsers();
  res.json({ success: true, users: userStore.size });
});

// Health check — Render.com pings this to keep server alive
app.get("/health", (req, res) => {
  res.json({ status: "ok", users: userStore.size, time: new Date().toISOString() });
});

// ─── Internal cron — also runs every 5 min inside the server itself ───────────
cron.schedule("*/5 * * * *", () => {
  checkAllUsers();
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌿 Enviro Monitor server running on port ${PORT}`);
  console.log(`📊 Checking users every 5 minutes`);
});
