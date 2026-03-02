import { Redis } from "@upstash/redis";
import express from "express";
import cron from "node-cron";

const app = express();
app.use(express.json({ limit: "32kb" }));

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const USERS_KEY = "users";
const PORT = Number(process.env.PORT || 3000);
const SERVER_URL =
  process.env.SERVER_URL || "https://enviro-server.onrender.com";

const APP_OPEN_TTL_MS = Number(process.env.APP_OPEN_TTL_MS || 5 * 60 * 1000);
const STALE_USER_PRUNE_DAYS = Number(process.env.STALE_USER_PRUNE_DAYS || 14);
const WEATHER_CONCURRENCY = Number(process.env.WEATHER_CONCURRENCY || 3);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 12000);
const WEATHER_CACHE_TTL_MS = Number(
  process.env.WEATHER_CACHE_TTL_MS || 90 * 1000,
);
const WEATHER_CACHE_COORD_PRECISION = Number(
  process.env.WEATHER_CACHE_COORD_PRECISION || 3,
);
const WEATHER_CACHE_MAX_ENTRIES = Number(
  process.env.WEATHER_CACHE_MAX_ENTRIES || 2000,
);
const LOCATION_UPDATE_MIN_INTERVAL_MS = Number(
  process.env.LOCATION_UPDATE_MIN_INTERVAL_MS || 45 * 1000,
);
const LOCATION_JITTER_THRESHOLD = Number(
  process.env.LOCATION_JITTER_THRESHOLD || 0.0001,
);

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

let usersWriteQueue = Promise.resolve();

const runtimeStats = {
  updateLocationRequests: 0,
  updateLocationSkipped: 0,
  updateLocationApplied: 0,
  registerRequests: 0,
  riskChecksRun: 0,
  riskChecksLastMs: 0,
  riskChecksLastCheckedUsers: 0,
  dailySummariesRun: 0,
  dailySummariesLastMs: 0,
  prunesRun: 0,
  prunesLastRemoved: 0,
  weatherCacheHits: 0,
  weatherCacheMisses: 0,
};

const weatherCache = new Map();

const maskToken = (token) => {
  if (!token || token.length < 10) return "[invalid-token]";
  return `${token.slice(0, 8)}...${token.slice(-6)}`;
};

const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);
const isValidLat = (lat) => isFiniteNumber(lat) && lat >= -90 && lat <= 90;
const isValidLon = (lon) => isFiniteNumber(lon) && lon >= -180 && lon <= 180;
const isValidExpoToken = (token) =>
  typeof token === "string" && /^ExponentPushToken\[[^\]]+\]$/.test(token);

const isNearlySameLocation = (prevLat, prevLon, nextLat, nextLon) => {
  return (
    Math.abs(prevLat - nextLat) < LOCATION_JITTER_THRESHOLD &&
    Math.abs(prevLon - nextLon) < LOCATION_JITTER_THRESHOLD
  );
};

const getWeatherCacheKey = (lat, lon) => {
  return `${lat.toFixed(WEATHER_CACHE_COORD_PRECISION)},${lon.toFixed(WEATHER_CACHE_COORD_PRECISION)}`;
};

const pruneWeatherCache = () => {
  const now = Date.now();
  for (const [key, value] of weatherCache.entries()) {
    if (now - value.cachedAt > WEATHER_CACHE_TTL_MS) {
      weatherCache.delete(key);
    }
  }

  if (weatherCache.size <= WEATHER_CACHE_MAX_ENTRIES) return;

  const entries = Array.from(weatherCache.entries()).sort(
    (a, b) => a[1].cachedAt - b[1].cachedAt,
  );
  const removeCount = weatherCache.size - WEATHER_CACHE_MAX_ENTRIES;
  for (let i = 0; i < removeCount; i += 1) {
    weatherCache.delete(entries[i][0]);
  }
};

const nowIso = () => new Date().toISOString();

async function getAllUsers() {
  const data = await redis.get(USERS_KEY);
  if (!data) return {};
  return typeof data === "string" ? JSON.parse(data) : data;
}

async function saveAllUsers(users) {
  await redis.set(USERS_KEY, JSON.stringify(users));
}

async function withUsersWriteLock(mutator) {
  usersWriteQueue = usersWriteQueue.then(async () => {
    const users = await getAllUsers();
    const changed = await mutator(users);
    if (changed) {
      await saveAllUsers(users);
    }
  });
  return usersWriteQueue;
}

function getCronSecret(req) {
  const headerSecret = req.headers["x-cron-secret"];
  const querySecret = req.query?.secret;
  return typeof headerSecret === "string"
    ? headerSecret
    : typeof querySecret === "string"
      ? querySecret
      : null;
}

function isAuthorizedCronRequest(req) {
  const configured = process.env.CRON_SECRET;
  if (!configured) return false;
  return getCronSecret(req) === configured;
}

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
    } else if (pm25 > RISK_LIMITS.PM25_WARNING) {
      alerts.push({
        type: "AirQuality_warning",
        severity: "warning",
        message: `⚠️ Air quality declining — PM2.5 at ${pm25.toFixed(1)} µg/m³.`,
      });
    }
  }

  if (uv != null) {
    if (uv > RISK_LIMITS.UV_DANGER) {
      alerts.push({
        type: "UV_danger",
        severity: "danger",
        message: `☀️ Extreme UV index (${uv}). Avoid direct sun, use SPF 50+.`,
      });
    } else if (uv > RISK_LIMITS.UV_WARNING) {
      alerts.push({
        type: "UV_warning",
        severity: "warning",
        message: `🌤 Moderate UV index (${uv}). Apply sunscreen before going out.`,
      });
    }
  }

  if (temp != null) {
    if (temp > RISK_LIMITS.TEMP_DANGER) {
      alerts.push({
        type: "Temp_danger",
        severity: "danger",
        message: `🌡 Extreme heat — ${temp}°C. Risk of heatstroke. Stay indoors.`,
      });
    } else if (temp > RISK_LIMITS.TEMP_WARNING) {
      alerts.push({
        type: "Temp_warning",
        severity: "warning",
        message: `🌡 High temperature — ${temp}°C. Stay hydrated.`,
      });
    }
  }

  if (visibility != null) {
    if (visibility < RISK_LIMITS.VISIBILITY_DANGER) {
      alerts.push({
        type: "Visibility_danger",
        severity: "danger",
        message: `🌫 Very poor visibility — ${visibility} km. Avoid driving.`,
      });
    } else if (visibility < RISK_LIMITS.VISIBILITY_WARNING) {
      alerts.push({
        type: "Visibility_warning",
        severity: "warning",
        message: `🌫 Reduced visibility — ${visibility} km. Drive with caution.`,
      });
    }
  }

  if (wind != null) {
    if (wind > RISK_LIMITS.WIND_DANGER) {
      alerts.push({
        type: "Wind_danger",
        severity: "danger",
        message: `💨 Storm-level winds — ${wind} km/h. Avoid outdoor activity.`,
      });
    } else if (wind > RISK_LIMITS.WIND_WARNING) {
      alerts.push({
        type: "Wind_warning",
        severity: "warning",
        message: `💨 Strong winds — ${wind} km/h. Secure loose objects.`,
      });
    }
  }

  return alerts;
}

function calculateAQI(pm25) {
  if (pm25 <= 12) return Math.round((50 / 12) * pm25);
  if (pm25 <= 35.4) {
    return Math.round(((100 - 51) / (35.4 - 12.1)) * (pm25 - 12.1) + 51);
  }
  if (pm25 <= 55.4) {
    return Math.round(((150 - 101) / (55.4 - 35.5)) * (pm25 - 35.5) + 101);
  }
  if (pm25 <= 150.4) {
    return Math.round(((200 - 151) / (150.4 - 55.5)) * (pm25 - 55.5) + 151);
  }
  if (pm25 <= 250.4) {
    return Math.round(((300 - 201) / (250.4 - 150.5)) * (pm25 - 150.5) + 201);
  }
  return Math.round(((500 - 301) / (500.4 - 250.5)) * (pm25 - 250.5) + 301);
}

function isUserAppOpen(user) {
  if (!user?.appOpen) return false;
  const lastSeenMs = Date.parse(user.lastSeen || "");
  if (!Number.isFinite(lastSeenMs)) return false;
  return Date.now() - lastSeenMs <= APP_OPEN_TTL_MS;
}

function severeOrDanger(alert) {
  return alert.severity === "severe" || alert.severity === "danger";
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = FETCH_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWeather(lat, lon) {
  const key = process.env.WEATHER_API_KEY;
  if (!key) throw new Error("Missing WEATHER_API_KEY env var");

  const cacheKey = getWeatherCacheKey(lat, lon);
  const cached = weatherCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt <= WEATHER_CACHE_TTL_MS) {
    runtimeStats.weatherCacheHits += 1;
    return cached.data;
  }

  runtimeStats.weatherCacheMisses += 1;

  const url = `https://api.weatherapi.com/v1/current.json?key=${key}&q=${lat},${lon}&aqi=yes`;
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const res = await fetchWithTimeout(url, {}, FETCH_TIMEOUT_MS);
      if (!res.ok) {
        if (res.status >= 500 && attempt < 2) {
          await new Promise((r) => setTimeout(r, 500 * attempt));
          continue;
        }
        throw new Error(`WeatherAPI error: ${res.status}`);
      }
      const data = await res.json();
      weatherCache.set(cacheKey, { data, cachedAt: Date.now() });
      pruneWeatherCache();
      return data;
    } catch (err) {
      lastError = err;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
    }
  }

  throw lastError || new Error("Weather fetch failed");
}

async function sendPush(token, title, body, data = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const res = await fetchWithTimeout(
        "https://exp.host/--/api/v2/push/send",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: token,
            title,
            body,
            data,
            sound: "default",
          }),
        },
        FETCH_TIMEOUT_MS,
      );

      const json = await res.json();
      if (json?.data?.status === "error") {
        const errorType = json.data?.details?.error;
        if (errorType === "DeviceNotRegistered") {
          return {
            ok: false,
            deviceNotRegistered: true,
            reason: json.data?.message || errorType,
          };
        }

        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 500 * attempt));
          continue;
        }

        return {
          ok: false,
          deviceNotRegistered: false,
          reason: json.data?.message || "push_error",
        };
      }

      return { ok: true, deviceNotRegistered: false };
    } catch (err) {
      lastError = err;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
    }
  }

  return {
    ok: false,
    deviceNotRegistered: false,
    reason: lastError instanceof Error ? lastError.message : "sendPush failed",
  };
}

async function mapWithConcurrency(items, limit, worker) {
  const max = Math.max(1, limit);
  const active = [];
  let index = 0;

  async function runOne() {
    if (index >= items.length) return;
    const current = index;
    index += 1;
    await worker(items[current], current);
    await runOne();
  }

  for (let i = 0; i < Math.min(max, items.length); i += 1) {
    active.push(runOne());
  }

  await Promise.all(active);
}

async function runRiskCheck() {
  const started = Date.now();
  runtimeStats.riskChecksRun += 1;
  console.log(`[${nowIso()}] Running risk check...`);

  const users = await getAllUsers();
  const tokens = Object.keys(users);

  if (tokens.length === 0) {
    console.log("No registered users.");
    return;
  }

  let changed = false;
  const targets = tokens.filter((token) => {
    const user = users[token];
    if (!user) return false;
    if (!isValidLat(user.latitude) || !isValidLon(user.longitude)) return false;
    return !isUserAppOpen(user);
  });

  await mapWithConcurrency(targets, WEATHER_CONCURRENCY, async (token) => {
    const user = users[token];
    if (!user) return;

    try {
      const weather = await fetchWeather(user.latitude, user.longitude);
      const alerts = evaluateRisk(weather);
      const severeAlerts = alerts.filter(severeOrDanger);
      const nextActiveTypes = severeAlerts.map((a) => a.type).sort();
      const previousActiveTypes = Array.isArray(user.activeAlertTypes)
        ? [...user.activeAlertTypes].sort()
        : [];

      const newlyTriggered = severeAlerts.filter(
        (alert) => !previousActiveTypes.includes(alert.type),
      );

      if (newlyTriggered.length > 0) {
        const topAlert = newlyTriggered[0];
        const title =
          topAlert.severity === "danger"
            ? "🚨 Dangerous Condition"
            : "⚠️ Severe Condition";

        const pushed = await sendPush(token, title, topAlert.message, {
          type: topAlert.type,
          severity: topAlert.severity,
        });

        if (pushed.deviceNotRegistered) {
          delete users[token];
          changed = true;
          console.log(`Removed unregistered token ${maskToken(token)}`);
          return;
        }

        if (!pushed.ok) {
          console.warn(`Push failed for ${maskToken(token)}: ${pushed.reason}`);
        } else {
          console.log(`Pushed ${topAlert.type} to ${maskToken(token)}`);
        }
      }

      const hasTypeChange =
        JSON.stringify(previousActiveTypes) !== JSON.stringify(nextActiveTypes);
      if (hasTypeChange || user.lastRiskCheckAt == null) {
        users[token] = {
          ...user,
          activeAlertTypes: nextActiveTypes,
          lastRiskCheckAt: nowIso(),
        };
        changed = true;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Risk check failed for ${maskToken(token)}: ${msg}`);
    }
  });

  if (changed) {
    await saveAllUsers(users);
  }

  console.log(
    `Risk check complete: total=${tokens.length}, checked=${targets.length}, ms=${Date.now() - started}`,
  );
  runtimeStats.riskChecksLastCheckedUsers = targets.length;
  runtimeStats.riskChecksLastMs = Date.now() - started;
}

async function sendDailySummary() {
  const started = Date.now();
  runtimeStats.dailySummariesRun += 1;
  console.log(`[${nowIso()}] Sending daily summary...`);

  const users = await getAllUsers();
  const tokens = Object.keys(users).filter((token) => {
    const u = users[token];
    return u && isValidLat(u.latitude) && isValidLon(u.longitude);
  });

  let changed = false;
  await mapWithConcurrency(tokens, WEATHER_CONCURRENCY, async (token) => {
    const user = users[token];
    if (!user) return;

    try {
      const weather = await fetchWeather(user.latitude, user.longitude);
      const c = weather?.current;
      if (!c) return;

      const pm25 = c.air_quality?.pm2_5;
      const aqiRaw = pm25 != null ? calculateAQI(pm25) : null;

      const body = [
        aqiRaw != null ? `🌫 AQI: ${aqiRaw}` : null,
        c.uv != null ? `☀️ UV: ${c.uv}` : null,
        c.temp_c != null ? `🌡 Temp: ${c.temp_c}°C` : null,
        c.condition?.text ? `🌤 ${c.condition.text}` : null,
      ]
        .filter(Boolean)
        .join("  ·  ");

      const pushed = await sendPush(
        token,
        "🌿 Good Morning — Today's Air Report",
        body,
      );
      if (pushed.deviceNotRegistered) {
        delete users[token];
        changed = true;
        console.log(`Removed unregistered token ${maskToken(token)}`);
        return;
      }
      if (!pushed.ok) {
        console.warn(
          `Daily summary push failed for ${maskToken(token)}: ${pushed.reason}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Daily summary failed for ${maskToken(token)}: ${msg}`);
    }
  });

  if (changed) {
    await saveAllUsers(users);
  }

  console.log(
    `Daily summary complete: users=${tokens.length}, ms=${Date.now() - started}`,
  );
  runtimeStats.dailySummariesLastMs = Date.now() - started;
}

async function pruneStaleUsers() {
  runtimeStats.prunesRun += 1;
  const users = await getAllUsers();
  const tokens = Object.keys(users);
  if (tokens.length === 0) return;

  const cutoffMs = Date.now() - STALE_USER_PRUNE_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const token of tokens) {
    const user = users[token];
    const seenMs = Date.parse(user?.lastSeen || "");
    if (!Number.isFinite(seenMs) || seenMs < cutoffMs) {
      delete users[token];
      removed += 1;
    }
  }

  if (removed > 0) {
    await saveAllUsers(users);
    console.log(`Pruned ${removed} stale users`);
  }

  runtimeStats.prunesLastRemoved = removed;
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    now: nowIso(),
  });
});

app.post("/register", async (req, res) => {
  runtimeStats.registerRequests += 1;
  const { fcmToken, latitude, longitude } = req.body || {};

  if (
    !isValidExpoToken(fcmToken) ||
    !isValidLat(latitude) ||
    !isValidLon(longitude)
  ) {
    return res.status(400).json({
      error: "Valid fcmToken (ExpoPushToken), latitude, longitude required",
    });
  }

  await withUsersWriteLock(async (users) => {
    users[fcmToken] = {
      ...(users[fcmToken] || {}),
      fcmToken,
      latitude,
      longitude,
      appOpen: true,
      activeAlertTypes: Array.isArray(users[fcmToken]?.activeAlertTypes)
        ? users[fcmToken].activeAlertTypes
        : [],
      lastSeen: nowIso(),
      registeredAt: users[fcmToken]?.registeredAt || nowIso(),
    };
    return true;
  });

  console.log(
    `Registered ${maskToken(fcmToken)} @ ${latitude.toFixed(3)}, ${longitude.toFixed(3)}`,
  );
  return res.json({ success: true });
});

app.post("/update-location", async (req, res) => {
  runtimeStats.updateLocationRequests += 1;
  const { fcmToken, latitude, longitude, appOpen } = req.body || {};

  if (
    !isValidExpoToken(fcmToken) ||
    !isValidLat(latitude) ||
    !isValidLon(longitude)
  ) {
    return res.status(400).json({
      error: "Valid fcmToken (ExpoPushToken), latitude, longitude required",
    });
  }

  let skipped = false;

  await withUsersWriteLock(async (users) => {
    const existing = users[fcmToken] || {};
    const nextAppOpen = typeof appOpen === "boolean" ? appOpen : false;

    if (
      typeof existing.latitude === "number" &&
      typeof existing.longitude === "number" &&
      typeof existing.appOpen === "boolean" &&
      typeof existing.lastSeen === "string"
    ) {
      const lastSeenMs = Date.parse(existing.lastSeen);
      const recentlyUpdated =
        Number.isFinite(lastSeenMs) &&
        Date.now() - lastSeenMs < LOCATION_UPDATE_MIN_INTERVAL_MS;
      const sameAppState = existing.appOpen === nextAppOpen;
      const sameLocation = isNearlySameLocation(
        existing.latitude,
        existing.longitude,
        latitude,
        longitude,
      );

      if (recentlyUpdated && sameAppState && sameLocation) {
        skipped = true;
        runtimeStats.updateLocationSkipped += 1;
        return false;
      }
    }

    users[fcmToken] = {
      ...existing,
      fcmToken,
      latitude,
      longitude,
      appOpen: nextAppOpen,
      activeAlertTypes: Array.isArray(existing.activeAlertTypes)
        ? existing.activeAlertTypes
        : [],
      lastSeen: nowIso(),
    };
    runtimeStats.updateLocationApplied += 1;
    return true;
  });

  return res.json({ success: true, skipped });
});

app.get("/check", async (req, res) => {
  if (!isAuthorizedCronRequest(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  await runRiskCheck();
  return res.json({ success: true });
});

app.get("/users", async (req, res) => {
  if (!isAuthorizedCronRequest(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const users = await getAllUsers();
  const list = Object.values(users).map((u) => ({
    token: maskToken(u.fcmToken),
    latitude: u.latitude,
    longitude: u.longitude,
    appOpen: isUserAppOpen(u),
    lastSeen: u.lastSeen,
    activeAlertTypes: Array.isArray(u.activeAlertTypes)
      ? u.activeAlertTypes
      : [],
  }));

  return res.json({ count: list.length, users: list });
});

app.get("/stats", async (req, res) => {
  if (!isAuthorizedCronRequest(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const users = await getAllUsers();
  const all = Object.values(users);
  const activeUsers = all.filter((u) => isUserAppOpen(u)).length;

  return res.json({
    now: nowIso(),
    users: {
      total: all.length,
      active: activeUsers,
      inactive: all.length - activeUsers,
    },
    updates: {
      requests: runtimeStats.updateLocationRequests,
      applied: runtimeStats.updateLocationApplied,
      skipped: runtimeStats.updateLocationSkipped,
    },
    jobs: {
      riskChecksRun: runtimeStats.riskChecksRun,
      riskChecksLastMs: runtimeStats.riskChecksLastMs,
      riskChecksLastCheckedUsers: runtimeStats.riskChecksLastCheckedUsers,
      dailySummariesRun: runtimeStats.dailySummariesRun,
      dailySummariesLastMs: runtimeStats.dailySummariesLastMs,
      prunesRun: runtimeStats.prunesRun,
      prunesLastRemoved: runtimeStats.prunesLastRemoved,
    },
    cache: {
      weatherEntries: weatherCache.size,
      ttlMs: WEATHER_CACHE_TTL_MS,
      coordPrecision: WEATHER_CACHE_COORD_PRECISION,
      hits: runtimeStats.weatherCacheHits,
      misses: runtimeStats.weatherCacheMisses,
    },
    registers: {
      requests: runtimeStats.registerRequests,
    },
    uptimeSec: Math.round(process.uptime()),
  });
});

cron.schedule("*/5 * * * *", () => {
  runRiskCheck().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("risk cron failed:", msg);
  });
});

cron.schedule("0 6 * * *", () => {
  sendDailySummary().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("daily summary cron failed:", msg);
  });
});

cron.schedule("30 2 * * *", () => {
  pruneStaleUsers().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("prune cron failed:", msg);
  });
});

if (process.env.ENABLE_SELF_PING === "true") {
  cron.schedule("*/14 * * * *", () => {
    fetch(`${SERVER_URL}/health`).catch(() => {});
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log("Cron: risk=every 5 min, summary=06:00 UTC, prune=02:30 UTC");
});
