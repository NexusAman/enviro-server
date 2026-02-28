require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

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

// ─── In-memory token store ────────────────────────────────────────────────────
// { fcmToken → { fcmToken, latitude, longitude, lastAlertedTypes[] } }
const userStore = new Map();

// ─── Expo Push Notification Sender ───────────────────────────────────────────
// Uses Expo's push API — works directly with ExponentPushToken[xxx]
// No Firebase Admin needed.
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

    // Expo returns per-message status — check for errors
    if (result?.status === "error") {
      console.warn(`❌ Expo push error for ${expoToken.slice(0, 30)}:`, result.message);

      // Remove invalid tokens so they don't keep failing
      if (
        result.details?.error === "DeviceNotRegistered" ||
        result.details?.error === "InvalidCredentials"
      ) {
        console.log(`🗑 Removing invalid token: ${expoToken.slice(0, 30)}...`);
        userStore.delete(expoToken);
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
      // FIX: Skip push if app is open — app handles local notifications itself
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

      // Only send NEW alerts — skip types already sent
      const newAlerts = severeAndAbove.filter(
        (a) => !user.lastAlertedTypes.includes(a.type)
      );

      for (const alert of newAlerts) {
        await sendExpoPushNotification(expoToken, alert);
      }

      // Update stored alert types — remove cleared ones, keep active ones
      user.lastAlertedTypes = severeAndAbove.map((a) => a.type);

    } catch (err) {
      console.warn(`⚠️ Failed to check user ${expoToken.slice(0, 30)}:`, err.message);
    }
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// App calls this on launch with Expo push token + GPS
app.post("/register", (req, res) => {
  const { fcmToken, latitude, longitude } = req.body;

  if (!fcmToken || !latitude || !longitude) {
    return res.status(400).json({ error: "fcmToken, latitude, and longitude are required." });
  }

  // Validate it's actually an Expo push token
  if (!fcmToken.startsWith("ExponentPushToken[")) {
    return res.status(400).json({ error: "Invalid token format. Expected ExponentPushToken[...]." });
  }

  userStore.set(fcmToken, {
    fcmToken,
    latitude,
    longitude,
    appOpen: false,
    lastAlertedTypes: [],
  });

  console.log(`📱 Registered: ${fcmToken.slice(0, 35)}... at (${latitude}, ${longitude})`);
  res.json({ success: true, message: "Device registered for push alerts." });
});

// App calls this when GPS location changes
app.post("/update-location", (req, res) => {
  const { fcmToken, latitude, longitude, appOpen } = req.body;

  if (!fcmToken || !latitude || !longitude) {
    return res.status(400).json({ error: "fcmToken, latitude, and longitude are required." });
  }

  // Auto-register if not found — handles Render.com restarts wiping memory
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

    console.log(`🔄 Auto-registered on update: ${fcmToken.slice(0, 35)}...`);
    return res.json({ success: true, message: "Device auto-registered." });
  }

  const user = userStore.get(fcmToken);
  user.latitude = latitude;
  user.longitude = longitude;
  user.appOpen = appOpen ?? false;

  console.log(`📍 Location updated: ${fcmToken.slice(0, 35)}...`);
  res.json({ success: true });
});

// cron-job.org calls this every 5 minutes
// Secured with CRON_SECRET to prevent unauthorized triggers
app.get("/check", async (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  await checkAllUsers();
  res.json({ success: true, usersChecked: userStore.size });
});

// Render.com health check — keeps server alive
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    users: userStore.size,
    time: new Date().toISOString(),
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌿 Enviro Monitor server running on port ${PORT}`);
  console.log(`📡 Using Expo Push API — no Firebase required`);
  console.log(`⏱  Push checks triggered by cron-job.org every 5 minutes`);
});
