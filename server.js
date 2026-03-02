import { Redis } from "@upstash/redis";
import cron from "node-cron";
import express from "express";

const app = express();
app.use(express.json());

// ─── Upstash Redis ────────────────────────────────────────────────────────────

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// All users stored in a single Redis key as a JSON object.
// { [fcmToken]: { fcmToken, latitude, longitude, appOpen, lastSeen } }
// This keeps Upstash usage at ~2 commands per cron cycle instead of 50+,
// which stays well within the free 10K/day limit even at 50 users.

const USERS_KEY = "users";

async function getAllUsers() {
  const data = await redis.get(USERS_KEY);
  if (!data) return {};
  return typeof data === "string" ? JSON.parse(data) : data;
}

async function saveAllUsers(users) {
  await redis.set(USERS_KEY, JSON.stringify(users));
}

async function getUser(token) {
  const users = await getAllUsers();
  return users[token] || null;
}

async function setUser(token, userData) {
  const users = await getAllUsers();
  users[token] = userData;
  await saveAllUsers(users);
}

async function deleteUser(token) {
  const users = await getAllUsers();
  delete users[token];
  await saveAllUsers(users);
}

// ─── Risk Thresholds (mirrors src/utils/riskThresholds.ts) ───────────────────

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

function evaluateRisk(weatherData) {
  const alerts = [];
  const c = weatherData?.current;
  if (!c) return alerts;

  const pm25 = c.air_quality?.pm2_5;
  const uv = c.uv;
  const temp = c.temp_c;
  const visibility = c.vis_km;
  const wind = c.wind_kph;

  if (pm25 != null) {
    if (pm25 > RISK_LIMITS.PM25_DANGER)
      alerts.push({ type: "AirQuality_danger", severity: "danger", message: `🫁 Hazardous air — PM2.5 at ${pm25.toFixed(1)} µg/m³. Stay indoors.` });
    else if (pm25 > RISK_LIMITS.PM25_SEVERE)
      alerts.push({ type: "AirQuality_severe", severity: "severe", message: `😷 Unhealthy air — PM2.5 at ${pm25.toFixed(1)} µg/m³. Wear a mask outdoors.` });
    else if (pm25 > RISK_LIMITS.PM25_WARNING)
      alerts.push({ type: "AirQuality_warning", severity: "warning", message: `⚠️ Air quality declining — PM2.5 at ${pm25.toFixed(1)} µg/m³.` });
  }

  if (uv != null) {
    if (uv > RISK_LIMITS.UV_DANGER)
      alerts.push({ type: "UV_danger", severity: "danger", message: `☀️ Extreme UV index (${uv}). Avoid direct sun, use SPF 50+.` });
    else if (uv > RISK_LIMITS.UV_WARNING)
      alerts.push({ type: "UV_warning", severity: "warning", message: `🌤 Moderate UV index (${uv}). Apply sunscreen before going out.` });
  }

  if (temp != null) {
    if (temp > RISK_LIMITS.TEMP_DANGER)
      alerts.push({ type: "Temp_danger", severity: "danger", message: `🌡 Extreme heat — ${temp}°C. Risk of heatstroke. Stay indoors.` });
    else if (temp > RISK_LIMITS.TEMP_WARNING)
      alerts.push({ type: "Temp_warning", severity: "warning", message: `🌡 High temperature — ${temp}°C. Stay hydrated.` });
  }

  if (visibility != null) {
    if (visibility < RISK_LIMITS.VISIBILITY_DANGER)
      alerts.push({ type: "Visibility_danger", severity: "danger", message: `🌫 Very poor visibility — ${visibility} km. Avoid driving.` });
    else if (visibility < RISK_LIMITS.VISIBILITY_WARNING)
      alerts.push({ type: "Visibility_warning", severity: "warning", message: `🌫 Reduced visibility — ${visibility} km. Drive with caution.` });
  }

  if (wind != null) {
    if (wind > RISK_LIMITS.WIND_DANGER)
      alerts.push({ type: "Wind_danger", severity: "danger", message: `💨 Storm-level winds — ${wind} km/h. Avoid outdoor activity.` });
    else if (wind > RISK_LIMITS.WIND_WARNING)
      alerts.push({ type: "Wind_warning", severity: "warning", message: `💨 Strong winds — ${wind} km/h. Secure loose objects.` });
  }

  return alerts;
}

// ─── Expo Push ────────────────────────────────────────────────────────────────

async function sendPush(token, title, body, data = {}) {
  try {
    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: token, title, body, data, sound: "default" }),
    });
    const json = await res.json();
    if (json?.data?.status === "error") {
      console.warn(`Push error for ${token.slice(-8)}:`, json.data.message);
      // Invalid token — remove from store so it doesn't waste cron cycles
      if (json.data.details?.error === "DeviceNotRegistered") {
        await deleteUser(token);
        console.log(`Removed unregistered token ${token.slice(-8)}`);
      }
    }
  } catch (err) {
    console.warn("sendPush failed:", err.message);
  }
}

// ─── Weather Fetch ────────────────────────────────────────────────────────────

async function fetchWeather(lat, lon) {
  const key = process.env.WEATHER_API_KEY;
  if (!key) throw new Error("Missing WEATHER_API_KEY env var");
  const url = `https://api.weatherapi.com/v1/current.json?key=${key}&q=${lat},${lon}&aqi=yes`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`WeatherAPI error: ${res.status}`);
  return res.json();
}

// ─── Risk Check (runs every 5 min) ───────────────────────────────────────────

async function runRiskCheck() {
  console.log(`[${new Date().toISOString()}] Running risk check…`);
  const users = await getAllUsers();
  const tokens = Object.keys(users);

  if (tokens.length === 0) {
    console.log("No registered users.");
    return;
  }

  for (const token of tokens) {
    const user = users[token];
    try {
      const weather = await fetchWeather(user.latitude, user.longitude);
      const alerts = evaluateRisk(weather);
      const severeAlerts = alerts.filter(
        (a) => a.severity === "severe" || a.severity === "danger"
      );

      // Only push if app is closed AND there are severe/danger alerts
      if (!user.appOpen && severeAlerts.length > 0) {
        const topAlert = severeAlerts[0];
        const title =
          topAlert.severity === "danger"
            ? "🚨 Dangerous Condition"
            : "⚠️ Severe Condition";

        await sendPush(token, title, topAlert.message);
        console.log(`Pushed alert to ${token.slice(-8)}: ${topAlert.message}`);
      }
    } catch (err) {
      console.warn(`Risk check failed for ${token.slice(-8)}:`, err.message);
    }
  }
}

// ─── Daily Summary (runs at 6am UTC = 11:30am IST) ───────────────────────────

async function sendDailySummary() {
  console.log(`[${new Date().toISOString()}] Sending daily summary…`);
  const users = await getAllUsers();
  const tokens = Object.keys(users);

  for (const token of tokens) {
    const user = users[token];
    try {
      const weather = await fetchWeather(user.latitude, user.longitude);
      const c = weather?.current;
      if (!c) continue;

      const pm25 = c.air_quality?.pm2_5;
      const aqiRaw = pm25
        ? pm25 <= 12
          ? Math.round((50 / 12) * pm25)
          : pm25 <= 35.4
          ? Math.round(((100 - 51) / (35.4 - 12.1)) * (pm25 - 12.1) + 51)
          : Math.round(((150 - 101) / (55.4 - 35.5)) * (pm25 - 35.5) + 101)
        : null;

      const body = [
        aqiRaw != null ? `🌫 AQI: ${aqiRaw}` : null,
        c.uv != null ? `☀️ UV: ${c.uv}` : null,
        c.temp_c != null ? `🌡 Temp: ${c.temp_c}°C` : null,
        c.condition?.text ? `🌤 ${c.condition.text}` : null,
      ]
        .filter(Boolean)
        .join("  ·  ");

      await sendPush(token, "🌿 Good Morning — Today's Air Report", body);
    } catch (err) {
      console.warn(`Daily summary failed for ${token.slice(-8)}:`, err.message);
    }
  }
}

// ─── Cron Jobs ────────────────────────────────────────────────────────────────

// Risk check every 5 minutes
cron.schedule("*/5 * * * *", runRiskCheck);

// Daily summary at 6am UTC (11:30am IST)
cron.schedule("0 6 * * *", sendDailySummary);

// Self-ping every 14 min — keeps Render free tier awake (prevents 50s cold start)
cron.schedule("*/14 * * * *", () => {
  fetch("https://enviro-server.onrender.com/health").catch(() => {});
});

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check — used by self-ping cron
app.get("/health", (req, res) => res.json({ ok: true }));

// Register a new device
app.post("/register", async (req, res) => {
  const { fcmToken, latitude, longitude } = req.body;
  if (!fcmToken || latitude == null || longitude == null) {
    return res.status(400).json({ error: "fcmToken, latitude, longitude required" });
  }

  await setUser(fcmToken, {
    fcmToken,
    latitude,
    longitude,
    appOpen: true,
    lastSeen: new Date().toISOString(),
  });

  console.log(`Registered: ${fcmToken.slice(-8)} @ ${latitude.toFixed(3)}, ${longitude.toFixed(3)}`);
  res.json({ success: true });
});

// Update location + appOpen state
app.post("/update-location", async (req, res) => {
  const { fcmToken, latitude, longitude, appOpen } = req.body;
  if (!fcmToken || latitude == null || longitude == null) {
    return res.status(400).json({ error: "fcmToken, latitude, longitude required" });
  }

  const existing = await getUser(fcmToken);
  await setUser(fcmToken, {
    ...(existing || {}),
    fcmToken,
    latitude,
    longitude,
    appOpen: appOpen ?? false,
    lastSeen: new Date().toISOString(),
  });

  res.json({ success: true });
});

// Manual risk check trigger (protected)
app.get("/check", async (req, res) => {
  if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  await runRiskCheck();
  res.json({ success: true });
});

// Debug — list all users (protected)
app.get("/users", async (req, res) => {
  if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const users = await getAllUsers();
  res.json({ count: Object.keys(users).length, users });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Registered cron: risk check every 5 min, daily summary at 6am UTC, self-ping every 14 min`);
});
