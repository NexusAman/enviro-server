require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const { Redis } = require("@upstash/redis");

const app = express();
app.use(express.json());

// ─── Upstash Redis ────────────────────────────────────────────────────────────
// Persists across ALL server restarts, crashes, and redeploys.
// Free tier: 10,000 req/day — more than enough.
// Setup: upstash.com → create DB → copy UPSTASH_REDIS_REST_URL + TOKEN to Render env vars.
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ─── Redis helpers ────────────────────────────────────────────────────────────
// Each user stored as JSON at key "user:<token>"
// All tokens tracked in a Redis Set at key "userTokens"

async function getUser(fcmToken) {
  const raw = await redis.get(`user:${fcmToken}`);
  return raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
}

async function setUser(fcmToken, userData) {
  await redis.set(`user:${fcmToken}`, JSON.stringify(userData));
  await redis.sadd("userTokens", fcmToken);
}

async function deleteUser(fcmToken) {
  await redis.del(`user:${fcmToken}`);
  await redis.srem("userTokens", fcmToken);
}

async function getAllUsers() {
  const tokens = await redis.smembers("userTokens");
  if (!tokens || tokens.length === 0) return [];

  const users = await Promise.all(tokens.map((t) => getUser(t)));
  // Filter out any nulls (stale tokens in set with no matching data)
  return users.filter(Boolean);
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

  if (pm25 == null || uv == null || temp == null || visibility == null)
    return alerts;

  if (pm25 > RISK_LIMITS.PM25_DANGER) {
    alerts.push({
      type: "AirQuality_danger",
      severity: "danger",
      message: `🫁 Hazardous air — PM2.5 at ${pm25.toFixed(1)} µg/m³. Stay indoors.`,
    });
  } else if (pm25 > RISK_LIMITS.PM25_SEVERE) {
    alerts.push({
      type: "AirQuality_severe",
      severity: "severe",
      message: `😷 Unhealthy air — PM2.5 at ${pm25.toFixed(1)} µg/m³. Wear a mask outdoors.`,
    });
  }

  if (uv > RISK_LIMITS.UV_DANGER) {
    alerts.push({
      type: "UV_danger",
      severity: "danger",
      message: `☀️ Extreme UV index (${uv}). Avoid direct sun, use SPF 50+.`,
    });
  }

  if (temp > RISK_LIMITS.TEMP_DANGER) {
    alerts.push({
      type: "Temp_danger",
      severity: "danger",
      message: `🌡 Extreme heat — ${temp}°C. Risk of heatstroke. Stay indoors.`,
    });
  }

  if (visibility < RISK_LIMITS.VISIBILITY_DANGER) {
    alerts.push({
      type: "Visibility_danger",
      severity: "danger",
      message: `🌫 Very poor visibility — ${visibility} km. Avoid driving.`,
    });
  }

  if (wind != null && wind > RISK_LIMITS.WIND_DANGER) {
    alerts.push({
      type: "Wind_danger",
      severity: "danger",
      message: `💨 Storm-level winds — ${wind} km/h. Stay indoors.`,
    });
  }

  return alerts;
}

// ─── Expo Push Sender ─────────────────────────────────────────────────────────
async function sendExpoPush(expoToken, title, body, data = {}) {
  try {
    const response = await axios.post(
      "https://exp.host/--/api/v2/push/send",
      {
        to: expoToken,
        title,
        body,
        sound: "default",
        priority: "high",
        data,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
        },
      },
    );

    const result = response.data?.data;

    if (result?.status === "error") {
      console.warn(
        `❌ Expo push error for ${expoToken.slice(0, 30)}:`,
        result.message,
      );
      if (
        result.details?.error === "DeviceNotRegistered" ||
        result.details?.error === "InvalidCredentials"
      ) {
        console.log(`🗑 Removing invalid token: ${expoToken.slice(0, 30)}...`);
        await deleteUser(expoToken);
      }
    } else {
      console.log(`✅ Push sent to ${expoToken.slice(0, 30)}...`);
    }
  } catch (err) {
    console.warn(
      `❌ Failed to push to ${expoToken.slice(0, 30)}:`,
      err.message,
    );
  }
}

// ─── Fetch weather for a user ─────────────────────────────────────────────────
async function fetchWeather(latitude, longitude) {
  const response = await axios.get(
    "https://api.weatherapi.com/v1/current.json",
    {
      params: {
        key: process.env.WEATHER_API_KEY,
        q: `${latitude},${longitude}`,
        aqi: "yes",
      },
    },
  );
  return response.data;
}

// ─── Risk alert check for all users (every 5 min) ────────────────────────────
async function checkAllUsers() {
  const users = await getAllUsers();

  if (users.length === 0) {
    console.log("ℹ️ No registered users, skipping check.");
    return;
  }

  console.log(
    `\n🔍 Checking ${users.length} user(s) at ${new Date().toLocaleTimeString()}`,
  );

  for (const user of users) {
    try {
      // Skip push if app is open — app handles in-app notifications itself
      if (user.appOpen) {
        console.log(
          `⏭ Skipping ${user.fcmToken.slice(0, 30)}... (app is open)`,
        );
        continue;
      }

      const weatherData = await fetchWeather(user.latitude, user.longitude);
      const allAlerts = evaluateRisk(weatherData);
      const severeAndAbove = allAlerts.filter(
        (a) => a.severity === "severe" || a.severity === "danger",
      );

      // Only send alerts the user hasn't already received
      const newAlerts = severeAndAbove.filter(
        (a) => !user.lastAlertedTypes.includes(a.type),
      );

      for (const alert of newAlerts) {
        const title =
          alert.severity === "danger"
            ? "🚨 Dangerous Condition"
            : "⚠️ Severe Condition";
        await sendExpoPush(user.fcmToken, title, alert.message, {
          type: alert.type,
          severity: alert.severity,
        });
      }

      // Update alerted types — clear resolved, keep active
      user.lastAlertedTypes = severeAndAbove.map((a) => a.type);
      await setUser(user.fcmToken, user);
    } catch (err) {
      console.warn(
        `⚠️ Failed to check ${user.fcmToken.slice(0, 30)}:`,
        err.message,
      );
    }
  }
}

// ─── Daily summary push (every morning at 6:00 AM UTC = 11:30 AM IST) ────────
// Sends a single morning briefing with current AQI, UV, and temp.
// Not an alert — just a friendly daily awareness nudge.
async function sendDailySummary() {
  const users = await getAllUsers();

  if (users.length === 0) return;

  console.log(
    `\n📋 Sending daily summary to ${users.length} user(s)...`,
  );

  for (const user of users) {
    try {
      const weatherData = await fetchWeather(user.latitude, user.longitude);

      const pm25 = weatherData?.current?.air_quality?.pm2_5;
      const uv = weatherData?.current?.uv;
      const temp = weatherData?.current?.temp_c;
      const condition = weatherData?.current?.condition?.text ?? "—";

      // Calculate AQI from PM2.5
      let aqi = 0;
      if (pm25 != null) {
        if (pm25 <= 12) aqi = Math.round((50 / 12) * pm25);
        else if (pm25 <= 35.4)
          aqi = Math.round(((100 - 51) / (35.4 - 12.1)) * (pm25 - 12.1) + 51);
        else if (pm25 <= 55.4)
          aqi = Math.round(
            ((150 - 101) / (55.4 - 35.5)) * (pm25 - 35.5) + 101,
          );
        else aqi = Math.round(((200 - 151) / (150.4 - 55.5)) * (pm25 - 55.5) + 151);
      }

      const aqiLabel =
        aqi <= 50
          ? "Good"
          : aqi <= 100
            ? "Moderate"
            : aqi <= 150
              ? "Unhealthy (Sensitive)"
              : "Unhealthy";

      const body =
        `${condition} · AQI ${aqi} (${aqiLabel}) · UV ${uv} · ${temp}°C\n` +
        (aqi > 100
          ? "😷 Consider wearing a mask today."
          : uv > 5
            ? "🧴 Apply sunscreen before going out."
            : "✅ Conditions look okay for outdoor activity.");

      await sendExpoPush(
        user.fcmToken,
        "🌿 Good Morning — Daily Enviro Briefing",
        body,
        { type: "daily_summary" },
      );
    } catch (err) {
      console.warn(
        `⚠️ Daily summary failed for ${user.fcmToken.slice(0, 30)}:`,
        err.message,
      );
    }
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.post("/register", async (req, res) => {
  const { fcmToken, latitude, longitude } = req.body;

  if (!fcmToken || !latitude || !longitude) {
    return res
      .status(400)
      .json({ error: "fcmToken, latitude, and longitude are required." });
  }

  if (!fcmToken.startsWith("ExponentPushToken[")) {
    return res
      .status(400)
      .json({ error: "Invalid token format. Expected ExponentPushToken[...]." });
  }

  // Preserve lastAlertedTypes if already registered — avoids re-sending
  // alerts the user already received before the server restarted.
  const existing = await getUser(fcmToken);

  await setUser(fcmToken, {
    fcmToken,
    latitude,
    longitude,
    appOpen: false,
    lastAlertedTypes: existing?.lastAlertedTypes ?? [],
  });

  console.log(
    `📱 Registered: ${fcmToken.slice(0, 35)}... at (${latitude}, ${longitude})`,
  );
  res.json({ success: true, message: "Device registered for push alerts." });
});

app.post("/update-location", async (req, res) => {
  const { fcmToken, latitude, longitude, appOpen } = req.body;

  if (!fcmToken || !latitude || !longitude) {
    return res
      .status(400)
      .json({ error: "fcmToken, latitude, and longitude are required." });
  }

  const existing = await getUser(fcmToken);

  if (!existing) {
    if (!fcmToken.startsWith("ExponentPushToken[")) {
      return res.status(400).json({ error: "Invalid token format." });
    }

    await setUser(fcmToken, {
      fcmToken,
      latitude,
      longitude,
      appOpen: appOpen ?? false,
      lastAlertedTypes: [],
    });

    console.log(`🔄 Auto-registered on update: ${fcmToken.slice(0, 35)}...`);
    return res.json({ success: true, message: "Device auto-registered." });
  }

  // Only update fields that changed — preserve lastAlertedTypes
  existing.latitude = latitude;
  existing.longitude = longitude;
  existing.appOpen = appOpen ?? false;

  // NOTE: We only write to Redis on appOpen state changes to save Redis ops.
  // Location-only updates are kept in memory for the duration of the session.
  await setUser(fcmToken, existing);

  console.log(
    `📍 Updated: ${fcmToken.slice(0, 35)}... appOpen=${existing.appOpen}`,
  );
  res.json({ success: true });
});

// Manual trigger (kept for debugging — cron now runs internally)
app.get("/check", async (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  await checkAllUsers();
  const users = await getAllUsers();
  res.json({ success: true, usersChecked: users.length });
});

// Render.com health check
app.get("/health", async (req, res) => {
  const users = await getAllUsers();
  res.json({
    status: "ok",
    users: users.length,
    time: new Date().toISOString(),
  });
});

// Debug — see all registered users
app.get("/users", async (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized." });
  }
  const users = await getAllUsers();
  res.json({
    count: users.length,
    users: users.map((u) => ({
      token: u.fcmToken.slice(0, 35) + "...",
      latitude: u.latitude,
      longitude: u.longitude,
      appOpen: u.appOpen,
      alertedTypes: u.lastAlertedTypes,
    })),
  });
});

// ─── Internal Cron Jobs ───────────────────────────────────────────────────────
// Replaces cron-job.org — runs entirely inside this process.
// No external dependency, no secret in public URL.

// Risk check: every 5 minutes
cron.schedule("*/5 * * * *", () => {
  console.log("⏱ [cron] Running risk check...");
  checkAllUsers().catch((err) =>
    console.error("❌ [cron] checkAllUsers failed:", err.message),
  );
});

// Daily summary: every day at 6:00 AM UTC (11:30 AM IST)
cron.schedule("0 6 * * *", () => {
  console.log("📋 [cron] Sending daily summary...");
  sendDailySummary().catch((err) =>
    console.error("❌ [cron] sendDailySummary failed:", err.message),
  );
});

console.log("⏱ Internal cron jobs scheduled (no cron-job.org needed)");

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌿 Enviro Monitor server running on port ${PORT}`);
  console.log(`📡 Push via Expo — no Firebase required`);
  console.log(`💾 Persistence via Upstash Redis`);
});
