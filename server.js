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
const STALE_USER_PRUNE_DAYS = Number(process.env.STALE_USER_PRUNE_DAYS || 21);
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
const CLIENT_API_KEY = process.env.CLIENT_API_KEY || "";
const RATE_LIMIT_WINDOW_MS = Number(
  process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000,
);
const RATE_LIMIT_MAX_WRITES_PER_IP = Number(
  process.env.RATE_LIMIT_MAX_WRITES_PER_IP || 120,
);
const RATE_LIMIT_MAX_WRITES_PER_TOKEN = Number(
  process.env.RATE_LIMIT_MAX_WRITES_PER_TOKEN || 60,
);

// ─── CPCB Integration ────────────────────────────────────────────────────────
const CPCB_API_KEY = process.env.CPCB_API_KEY || "";
const CPCB_URL =
  "https://api.data.gov.in/resource/3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69";
const CPCB_CACHE_TTL_MS = Number(
  process.env.CPCB_CACHE_TTL_MS || 30 * 60 * 1000,
);
const CPCB_MAX_DISTANCE_KM = 50;
const CPCB_FRESHNESS_HOURS = 6;
const CPCB_RECORDS_PER_PAGE = 1000;
const CPCB_MAX_PAGES = 5;

// ─── EMA Configuration (Exponential Moving Average) ──────────────────────────
// EMA coefficient: 0.015 with 5-min checks gives an effective ~11-hour
// weighted window, providing stable 24-hr-like AQI behavior.
const EMA_ALPHA = 0.015;

// ─── Thresholds aligned with Indian Standards (CPCB / IMD) ──────────────────
const RISK_LIMITS = {
  // Overall AQI (NAQI / CPCB)
  AQI_LIGHT_WARNING: 100, // Satisfactory → Moderate
  AQI_WARNING: 200, // Moderate → Poor
  AQI_SEVERE: 300, // Poor → Very Poor
  AQI_DANGER: 400, // Very Poor → Severe

  // UV Index (IMD / WHO)
  UV_WARNING: 3,
  UV_SEVERE: 6,
  UV_DANGER: 8,

  // Temperature °C (IMD Heatwave)
  TEMP_WARNING: 36,
  TEMP_SEVERE: 40,
  TEMP_DANGER: 45,

  // Visibility km (IMD Fog Classification)
  VISIBILITY_WARNING: 3,
  VISIBILITY_SEVERE: 1,
  VISIBILITY_DANGER: 0.2,

  // Wind km/h (IMD Wind Severity)
  WIND_WARNING: 40,
  WIND_SEVERE: 60,
  WIND_DANGER: 80,

  // Precipitation mm/hr (IMD Rainfall Classification)
  PRECIP_WARNING: 2.5,
  PRECIP_SEVERE: 7.5,
  PRECIP_DANGER: 35.5,

  // Humidity % (IMD / WHO)
  HUMIDITY_WARNING: 75,
  HUMIDITY_SEVERE: 85,
  HUMIDITY_DANGER: 95,
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
const writeIpBuckets = new Map();
const writeTokenBuckets = new Map();

// CPCB station cache (shared across all users — refreshed every 30 min)
let cpcbStationsCache = null;
let cpcbCachedAt = 0;

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

const nowIso = () => {
  const now = new Date();
  // IST = UTC + 5:30 — manual offset avoids locale-dependent toLocaleString
  const istMs = now.getTime() + (5 * 60 + 30) * 60 * 1000;
  const ist = new Date(istMs);
  const pad = (n) => String(n).padStart(2, "0");
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}T${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}+05:30`;
};

async function getAllUsers() {
  const data = await redis.get(USERS_KEY);
  if (!data) return {};
  return typeof data === "string" ? JSON.parse(data) : data;
}

async function saveAllUsers(users) {
  await redis.set(USERS_KEY, JSON.stringify(users));
}

async function withUsersWriteLock(mutator) {
  usersWriteQueue = usersWriteQueue
    .catch(() => {})
    .then(async () => {
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

function isAuthorizedClientWriteRequest(req) {
  if (!CLIENT_API_KEY) return true;
  const headerKey = req.headers["x-client-key"];
  return typeof headerKey === "string" && headerKey === CLIENT_API_KEY;
}

function getRequestIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || "unknown";
}

function cleanupRateLimitBuckets(store, nowMs) {
  for (const [key, bucket] of store.entries()) {
    if (nowMs - bucket.windowStartMs >= RATE_LIMIT_WINDOW_MS) {
      store.delete(key);
    }
  }
}

function consumeRateLimit(store, key, limit, nowMs) {
  const existing = store.get(key);
  if (!existing || nowMs - existing.windowStartMs >= RATE_LIMIT_WINDOW_MS) {
    store.set(key, { windowStartMs: nowMs, count: 1 });
    return true;
  }
  if (existing.count >= limit) {
    return false;
  }
  existing.count += 1;
  return true;
}

function enforceWriteGuards(req, res, next) {
  if (!isAuthorizedClientWriteRequest(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const nowMs = Date.now();
  cleanupRateLimitBuckets(writeIpBuckets, nowMs);
  cleanupRateLimitBuckets(writeTokenBuckets, nowMs);

  const ipKey = getRequestIp(req);
  if (
    !consumeRateLimit(
      writeIpBuckets,
      ipKey,
      RATE_LIMIT_MAX_WRITES_PER_IP,
      nowMs,
    )
  ) {
    return res.status(429).json({ error: "Too many requests" });
  }

  const tokenKey = req.body?.fcmToken;
  if (
    typeof tokenKey === "string" &&
    !consumeRateLimit(
      writeTokenBuckets,
      tokenKey,
      RATE_LIMIT_MAX_WRITES_PER_TOKEN,
      nowMs,
    )
  ) {
    return res.status(429).json({ error: "Too many requests" });
  }

  return next();
}

// ─── NAQI Calculation (CPCB India — PM2.5 + PM10 only) ──────────────────────
// Gas pollutants (O3, CO, SO2, NO2) are excluded intentionally:
// WeatherAPI provides real-time instant values but CPCB standards require
// 8-hour / 24-hour rolling averages for gases. Using real-time gas spikes
// artificially inflates AQI vs official monitor readings.

function interpolate(c, cLow, cHigh, iLow, iHigh) {
  return Math.round(((iHigh - iLow) / (cHigh - cLow)) * (c - cLow) + iLow);
}

function calcPM25(pm25) {
  if (pm25 == null) return 0;
  if (pm25 <= 30) return interpolate(pm25, 0, 30, 0, 50);
  if (pm25 <= 60) return interpolate(pm25, 30.01, 60, 51, 100);
  if (pm25 <= 90) return interpolate(pm25, 60.01, 90, 101, 200);
  if (pm25 <= 120) return interpolate(pm25, 90.01, 120, 201, 300);
  if (pm25 <= 250) return interpolate(pm25, 120.01, 250, 301, 400);
  return interpolate(Math.min(pm25, 500), 250.01, 500, 401, 500);
}

function calcPM10(pm10) {
  if (pm10 == null) return 0;
  if (pm10 <= 50) return interpolate(pm10, 0, 50, 0, 50);
  if (pm10 <= 100) return interpolate(pm10, 50.01, 100, 51, 100);
  if (pm10 <= 250) return interpolate(pm10, 100.01, 250, 101, 200);
  if (pm10 <= 350) return interpolate(pm10, 250.01, 350, 201, 300);
  if (pm10 <= 430) return interpolate(pm10, 350.01, 430, 301, 400);
  return interpolate(Math.min(pm10, 600), 430.01, 600, 401, 500);
}

function calculateOverallAQI(aq) {
  if (!aq) return 0;
  // Prefer CPCB official AQI when available (injected by risk check)
  if (aq._cpcbAqi != null && aq._cpcbAqi > 0) return aq._cpcbAqi;

  // Use EMA values if available for a smoother background alert behavior
  const pm25 = aq._emaPM25 ?? aq.pm2_5;
  const pm10 = aq._emaPM10 ?? aq.pm10;

  return Math.max(calcPM25(pm25), calcPM10(pm10));
}

function getAQILabel(aqi) {
  if (aqi <= 50) return "GOOD";
  if (aqi <= 100) return "SATISFACTORY";
  if (aqi <= 200) return "MODERATE";
  if (aqi <= 300) return "POOR";
  if (aqi <= 400) return "VERY POOR";
  return "SEVERE";
}

// ─── Risk Evaluation (3-tier: warning / severe / danger) ────────────────────

function evaluateRisk(weatherData, isSensitive = false) {
  const alerts = [];
  const c = weatherData?.current;
  if (!c) return alerts;

  const aq = c.air_quality;
  const uv = c.is_day === 0 ? null : c.uv;
  const temp = c.temp_c;
  const visibility = c.vis_km;
  const wind = c.wind_kph;
  const humidity = c.humidity;
  const precip = c.precip_mm;

  // ─── Overall AQI (NAQI) ───────────────────────────────────────────────
  if (aq) {
    const aqi = calculateOverallAQI(aq);

    // Personalization: Lower thresholds for sensitive groups
    const warningThreshold = isSensitive ? 80 : RISK_LIMITS.AQI_WARNING;
    const lightWarningThreshold = isSensitive
      ? 51
      : RISK_LIMITS.AQI_LIGHT_WARNING;

    if (aqi >= RISK_LIMITS.AQI_DANGER) {
      alerts.push({
        type: "AQI_danger",
        severity: "danger",
        message: `☠️ Severe air quality — AQI ${aqi}. Serious health impact, stay indoors.`,
      });
    } else if (aqi >= RISK_LIMITS.AQI_SEVERE) {
      alerts.push({
        type: "AQI_severe",
        severity: "severe",
        message: `🚨 Very poor air — AQI ${aqi}. Respiratory illness risk, avoid outdoors.`,
      });
    } else if (aqi >= warningThreshold) {
      alerts.push({
        type: "AQI_warning",
        severity: "warning",
        message: isSensitive
          ? `⚠️ Sensitive Group Alert — AQI ${aqi}. High risk for respiratory conditions, stay indoors.`
          : `⚠️ Poor air quality — AQI ${aqi}. Health discomfort possible.`,
      });
    } else if (aqi >= lightWarningThreshold) {
      alerts.push({
        type: "AQI_light_warning",
        severity: "warning",
        message: isSensitive
          ? `💨 Moderate air — AQI ${aqi}. Sensitive groups should limit outdoor exertion.`
          : `💨 Moderate air — AQI ${aqi}. Sensitive groups should take caution.`,
      });
    }
  }

  // ─── UV Index (IMD / WHO) ─────────────────────────────────────────────
  if (uv != null) {
    if (uv >= RISK_LIMITS.UV_DANGER) {
      alerts.push({
        type: "UV_danger",
        severity: "danger",
        message: `☀️ Extreme UV index (${uv}). Avoid sun exposure, use SPF 50+.`,
      });
    } else if (uv >= RISK_LIMITS.UV_SEVERE) {
      alerts.push({
        type: "UV_severe",
        severity: "severe",
        message: `☀️ Very high UV index (${uv}). Limit midday sun, wear protective clothing.`,
      });
    } else if (uv >= RISK_LIMITS.UV_WARNING) {
      alerts.push({
        type: "UV_warning",
        severity: "warning",
        message: `🌤 Moderate UV index (${uv}). Apply sunscreen before going out.`,
      });
    }
  }

  // ─── Temperature (IMD Heatwave) ───────────────────────────────────────
  if (temp != null) {
    if (temp >= RISK_LIMITS.TEMP_DANGER) {
      alerts.push({
        type: "Temp_danger",
        severity: "danger",
        message: `🌡 Extreme heat — ${temp}°C. Life-threatening, stay indoors with cooling.`,
      });
    } else if (temp >= RISK_LIMITS.TEMP_SEVERE) {
      alerts.push({
        type: "Temp_severe",
        severity: "severe",
        message: `🌡 Severe heat — ${temp}°C. Risk of heatstroke, stay hydrated and indoors.`,
      });
    } else if (temp >= RISK_LIMITS.TEMP_WARNING) {
      alerts.push({
        type: "Temp_warning",
        severity: "warning",
        message: `🌡 High temperature — ${temp}°C. Stay hydrated and limit exertion.`,
      });
    }
  }

  // ─── Visibility (IMD Fog Classification) ──────────────────────────────
  if (visibility != null) {
    if (visibility <= RISK_LIMITS.VISIBILITY_DANGER) {
      alerts.push({
        type: "Visibility_danger",
        severity: "danger",
        message: `🌫 Dense fog — ${visibility} km visibility. Do not drive.`,
      });
    } else if (visibility <= RISK_LIMITS.VISIBILITY_SEVERE) {
      alerts.push({
        type: "Visibility_severe",
        severity: "severe",
        message: `🌫 Very poor visibility — ${visibility} km. Avoid driving if possible.`,
      });
    } else if (visibility <= RISK_LIMITS.VISIBILITY_WARNING) {
      alerts.push({
        type: "Visibility_warning",
        severity: "warning",
        message: `🌫 Reduced visibility — ${visibility} km. Drive with caution.`,
      });
    }
  }

  // ─── Wind Speed (IMD Wind Severity) ───────────────────────────────────
  if (wind != null) {
    if (wind >= RISK_LIMITS.WIND_DANGER) {
      alerts.push({
        type: "Wind_danger",
        severity: "danger",
        message: `💨 Cyclonic winds — ${wind} km/h. Stay indoors, avoid all outdoor activity.`,
      });
    } else if (wind >= RISK_LIMITS.WIND_SEVERE) {
      alerts.push({
        type: "Wind_severe",
        severity: "severe",
        message: `💨 Storm-level winds — ${wind} km/h. Avoid outdoor activity.`,
      });
    } else if (wind >= RISK_LIMITS.WIND_WARNING) {
      alerts.push({
        type: "Wind_warning",
        severity: "warning",
        message: `💨 Strong winds — ${wind} km/h. Secure loose objects outdoors.`,
      });
    }
  }

  // ─── Humidity (IMD / WHO) ─────────────────────────────────────────────
  if (humidity != null) {
    if (humidity >= RISK_LIMITS.HUMIDITY_DANGER) {
      alerts.push({
        type: "Humidity_danger",
        severity: "danger",
        message: `💧 Oppressive humidity — ${humidity}%. Heat index critical, stay hydrated indoors.`,
      });
    } else if (humidity >= RISK_LIMITS.HUMIDITY_SEVERE) {
      alerts.push({
        type: "Humidity_severe",
        severity: "severe",
        message: `💧 Very muggy — ${humidity}% humidity. Limit physical exertion outdoors.`,
      });
    } else if (humidity >= RISK_LIMITS.HUMIDITY_WARNING) {
      alerts.push({
        type: "Humidity_warning",
        severity: "warning",
        message: `💧 High humidity — ${humidity}%. May feel uncomfortable, stay hydrated.`,
      });
    }
  }

  // ─── Precipitation (IMD Rainfall Classification) ──────────────────────
  if (precip != null && precip > 0) {
    if (precip >= RISK_LIMITS.PRECIP_DANGER) {
      alerts.push({
        type: "Precip_danger",
        severity: "danger",
        message: `🌧 Heavy rain — ${precip} mm/hr. Flash flood risk, avoid low-lying areas.`,
      });
    } else if (precip >= RISK_LIMITS.PRECIP_SEVERE) {
      alerts.push({
        type: "Precip_severe",
        severity: "severe",
        message: `🌧 Moderate rain — ${precip} mm/hr. Waterlogging possible, drive carefully.`,
      });
    } else if (precip >= RISK_LIMITS.PRECIP_WARNING) {
      alerts.push({
        type: "Precip_warning",
        severity: "warning",
        message: `🌦 Light rain — ${precip} mm/hr. Carry an umbrella.`,
      });
    }
  }

  return alerts;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

async function sendPush(token, title, body, data = {}, color = undefined) {
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const payload = {
        to: token,
        title,
        body,
        data,
        sound: "default",
        channelId: "default",
      };
      if (color) payload.color = color;

      const res = await fetchWithTimeout(
        "https://exp.host/--/api/v2/push/send",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
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

// ─── CPCB Station Lookup ──────────────────────────────────────────────────────

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isCPCBTimestampFresh(lastUpdate) {
  if (!lastUpdate) return false;
  const parts = lastUpdate.match(
    /^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/,
  );
  if (!parts) return false;
  const [, dd, mm, yyyy, hh, min, ss] = parts;
  const isoStr = `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}+05:30`;
  const timestamp = Date.parse(isoStr);
  if (!Number.isFinite(timestamp)) return false;
  const ageMs = Date.now() - timestamp;
  return ageMs >= 0 && ageMs <= CPCB_FRESHNESS_HOURS * 60 * 60 * 1000;
}

let cpcbFetchPromise = null;

async function fetchAllCPCBStations() {
  // Return cached data if fresh
  if (cpcbStationsCache && Date.now() - cpcbCachedAt < CPCB_CACHE_TTL_MS) {
    return cpcbStationsCache;
  }

  // If another thread is already fetching, wait for it instead of duplicating
  if (cpcbFetchPromise) {
    return cpcbFetchPromise;
  }

  cpcbFetchPromise = (async () => {
    try {
      if (!CPCB_API_KEY) {
        console.warn("CPCB_API_KEY not set — skipping CPCB integration.");
        return [];
      }

      const allRecords = [];
      let offset = 0;
      for (let page = 0; page < CPCB_MAX_PAGES; page += 1) {
        try {
          const res = await fetchWithTimeout(
            `${CPCB_URL}?api-key=${CPCB_API_KEY}&format=json&limit=${CPCB_RECORDS_PER_PAGE}&offset=${offset}`,
            {},
            FETCH_TIMEOUT_MS,
          );
          if (!res.ok) break;
          const json = await res.json();
          const records = json.records || [];
          allRecords.push(...records);
          if (records.length < CPCB_RECORDS_PER_PAGE) break;
          offset += CPCB_RECORDS_PER_PAGE;
        } catch {
          break;
        }
      }

      // Group into stations
      const stationMap = {};
      for (const r of allRecords) {
        if (!r.station) continue;
        const lat = parseFloat(r.latitude ?? "");
        const lon = parseFloat(r.longitude ?? "");
        if (isNaN(lat) || isNaN(lon)) continue;
        if (!stationMap[r.station]) {
          stationMap[r.station] = {
            station: r.station,
            city: r.city ?? "",
            lat,
            lon,
            pollutants: {},
            lastUpdated: r.last_update,
          };
        }
        const pollutant = r.pollutant_id?.toUpperCase();
        const value = parseFloat(r.avg_value ?? "");
        if (isNaN(value)) continue;
        if (pollutant === "PM2.5" || pollutant === "PM25")
          stationMap[r.station].pollutants.pm25 = value;
        else if (pollutant === "PM10")
          stationMap[r.station].pollutants.pm10 = value;
      }

      const stations = Object.values(stationMap);
      cpcbStationsCache = stations;
      cpcbCachedAt = Date.now();
      console.log(`CPCB cache refreshed: ${stations.length} stations`);
      return stations;
    } finally {
      // Always release the lock, even if the fetch fails
      cpcbFetchPromise = null;
    }
  })();

  return cpcbFetchPromise;
}

/**
 * Look up nearest CPCB station for a given coordinate.
 * Returns { aqi, stationName, distanceKm } or null.
 */
async function getCPCBAQI(lat, lon) {
  try {
    const stations = await fetchAllCPCBStations();
    let nearest = null;
    let minDist = Infinity;
    for (const s of stations) {
      if (!s.pollutants.pm25 && !s.pollutants.pm10) continue;
      const dist = haversine(lat, lon, s.lat, s.lon);
      if (dist > CPCB_MAX_DISTANCE_KM) continue;
      if (dist < minDist) {
        minDist = dist;
        nearest = s;
      }
    }
    if (!nearest) return null;
    if (!isCPCBTimestampFresh(nearest.lastUpdated)) return null;
    const aqi = Math.max(
      nearest.pollutants.pm25 != null ? calcPM25(nearest.pollutants.pm25) : 0,
      nearest.pollutants.pm10 != null ? calcPM10(nearest.pollutants.pm10) : 0,
    );
    return aqi > 0
      ? {
          aqi,
          stationName: nearest.station,
          distanceKm: Math.round(minDist * 10) / 10,
        }
      : null;
  } catch {
    return null;
  }
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────

async function runRiskCheck() {
  const started = Date.now();
  runtimeStats.riskChecksRun += 1;
  console.log(`[${nowIso()}] Running risk check...`);

  // Read a snapshot — weather fetches happen outside the lock (they're slow)
  const users = await getAllUsers();
  const tokens = Object.keys(users);
  const totalUsers = tokens.length;

  if (tokens.length === 0) {
    console.log("No registered users.");
    runtimeStats.riskChecksLastCheckedUsers = 0;
    runtimeStats.riskChecksLastMs = Date.now() - started;
    return;
  }

  const targets = tokens.filter((token) => {
    const user = users[token];
    if (!user) return false;
    if (!isValidLat(user.latitude) || !isValidLon(user.longitude)) return false;
    return !isUserAppOpen(user);
  });
  const checkedUsers = targets.length;

  // Collect mutations to apply after all fetches complete
  const tokensToRemove = [];
  const userUpdates = new Map();

  await mapWithConcurrency(targets, WEATHER_CONCURRENCY, async (token) => {
    const user = users[token];
    if (!user) return;

    try {
      const [weather, cpcb] = await Promise.all([
        fetchWeather(user.latitude, user.longitude),
        getCPCBAQI(user.latitude, user.longitude),
      ]);

      // If CPCB has fresh official AQI, override WeatherAPI's instant PM values
      // so evaluateRisk uses the same AQI source as the client app.
      if (cpcb && weather?.current?.air_quality) {
        // Inject CPCB AQI-equivalent PM values into the weather data
        // so calculateOverallAQI inside evaluateRisk produces the CPCB value.
        weather.current.air_quality._cpcbAqi = cpcb.aqi;
      }

      // ── EMA Background Update ───────────────────────────────────────────
      // Smooth out instant weather readings into a 24-hr-like background average
      const aq = weather?.current?.air_quality;
      if (aq && aq.pm2_5 != null && aq.pm10 != null) {
        const oldEma25 = user.emaPM25 ?? aq.pm2_5;
        const oldEma10 = user.emaPM10 ?? aq.pm10;

        const nextEma25 = oldEma25 * (1 - EMA_ALPHA) + aq.pm2_5 * EMA_ALPHA;
        const nextEma10 = oldEma10 * (1 - EMA_ALPHA) + aq.pm10 * EMA_ALPHA;

        userUpdates.set(token, {
          ...(userUpdates.get(token) || {}),
          emaPM25: nextEma25,
          emaPM10: nextEma10,
        });

        // Pass EMA values into evaluateRisk via the weather object
        aq._emaPM25 = nextEma25;
        aq._emaPM10 = nextEma10;
      }

      // ── Evaluate Risk (using user's personalization profile if available) ──
      const alerts = evaluateRisk(weather, user.isSensitive === true);
      const severeAlerts = alerts.filter(severeOrDanger);
      const nextActiveTypes = severeAlerts.map((a) => a.type).sort();
      const previousActiveTypes = Array.isArray(user.activeAlertTypes)
        ? [...user.activeAlertTypes].sort()
        : [];

      const newlyTriggered = severeAlerts.filter(
        (alert) => !previousActiveTypes.includes(alert.type),
      );

      // FIX: Push ALL newly triggered alerts, not just the first one
      for (const alert of newlyTriggered) {
        const title =
          alert.severity === "danger"
            ? "🚨 Dangerous Condition"
            : "⚠️ Severe Condition";

        const alertColor = alert.severity === "danger" ? "#E879F9" : "#F87171";

        const pushed = await sendPush(
          token,
          title,
          alert.message,
          {
            type: alert.type,
            severity: alert.severity,
            message: alert.message,
            source: "server_alert",
          },
          alertColor,
        );

        if (pushed.deviceNotRegistered) {
          tokensToRemove.push(token);
          console.log(`Removed unregistered token ${maskToken(token)}`);
          return; // skip remaining alerts for this token
        }

        if (!pushed.ok) {
          console.warn(`Push failed for ${maskToken(token)}: ${pushed.reason}`);
        } else {
          console.log(`Pushed ${alert.type} to ${maskToken(token)}`);
        }
      }

      const hasTypeChange =
        JSON.stringify(previousActiveTypes) !== JSON.stringify(nextActiveTypes);
      if (hasTypeChange || user.lastRiskCheckAt == null) {
        userUpdates.set(token, {
          activeAlertTypes: nextActiveTypes,
          lastRiskCheckAt: nowIso(),
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Risk check failed for ${maskToken(token)}: ${msg}`);
    }
  });

  // Apply mutations atomically through the write lock
  if (tokensToRemove.length > 0 || userUpdates.size > 0) {
    await withUsersWriteLock(async (latestUsers) => {
      let changed = false;
      for (const token of tokensToRemove) {
        if (latestUsers[token]) {
          delete latestUsers[token];
          changed = true;
        }
      }
      for (const [token, update] of userUpdates) {
        if (latestUsers[token]) {
          latestUsers[token] = { ...latestUsers[token], ...update };
          changed = true;
        }
      }
      return changed;
    });
  }

  console.log(
    `Risk check complete: total=${totalUsers}, checked=${checkedUsers}, ms=${Date.now() - started}`,
  );
  runtimeStats.riskChecksLastCheckedUsers = checkedUsers;
  runtimeStats.riskChecksLastMs = Date.now() - started;
}

// FIX: sendDailySummary previously called getAllUsers / saveAllUsers directly,
// bypassing withUsersWriteLock. Concurrent /register or /update-location writes
// in Redis could be clobbered when saveAllUsers ran. Now weather fetches run
// outside the lock (they're slow), then token deletions are committed via the
// lock in a single batch at the end.
async function sendDailySummary() {
  const started = Date.now();
  runtimeStats.dailySummariesRun += 1;
  console.log(`[${nowIso()}] Sending daily summary...`);

  // Read a snapshot for iteration — weather fetches happen outside the lock
  const users = await getAllUsers();
  const tokens = Object.keys(users).filter((token) => {
    const u = users[token];
    return u && isValidLat(u.latitude) && isValidLon(u.longitude);
  });

  // Collect unregistered tokens; mutations are applied after all fetches finish
  const tokensToRemove = [];

  await mapWithConcurrency(tokens, WEATHER_CONCURRENCY, async (token) => {
    const user = users[token];
    if (!user) return;

    try {
      const [weather, cpcb] = await Promise.all([
        fetchWeather(user.latitude, user.longitude),
        getCPCBAQI(user.latitude, user.longitude),
      ]);

      const c = weather?.current;
      if (!c) return;

      // Inject CPCB override for the summary
      if (cpcb && c.air_quality) {
        c.air_quality._cpcbAqi = cpcb.aqi;
      }

      const aqi = calculateOverallAQI(c.air_quality);
      const aqiLabel = getAQILabel(aqi);

      const body = [
        aqi > 0 ? `🌫 AQI: ${aqi} (${aqiLabel})` : null,
        c.is_day !== 0 && c.uv != null ? `☀️ UV: ${c.uv}` : null,
        c.temp_c != null ? `🌡 Temp: ${c.temp_c}°C` : null,
        c.condition?.text ? `🌤 ${c.condition.text}` : null,
      ]
        .filter(Boolean)
        .join("  ·  ");

      const pushed = await sendPush(
        token,
        "🌿 Good Morning — Today's Air Report",
        body,
        {},
        "#34D399",
      );

      if (pushed.deviceNotRegistered) {
        tokensToRemove.push(token);
        console.log(`Removing unregistered token ${maskToken(token)}`);
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

  // Apply deletions atomically through the write lock
  if (tokensToRemove.length > 0) {
    await withUsersWriteLock(async (latestUsers) => {
      for (const token of tokensToRemove) {
        delete latestUsers[token];
      }
      return true;
    });
  }

  console.log(
    `Daily summary complete: users=${tokens.length}, ms=${Date.now() - started}`,
  );
  runtimeStats.dailySummariesLastMs = Date.now() - started;
}

// FIX: pruneStaleUsers previously read/mutated/saved outside withUsersWriteLock,
// creating the same write-race as sendDailySummary. Now runs fully inside the lock.
async function pruneStaleUsers() {
  runtimeStats.prunesRun += 1;
  let removed = 0;

  await withUsersWriteLock(async (users) => {
    const tokens = Object.keys(users);
    if (tokens.length === 0) return false;

    const cutoffMs = Date.now() - STALE_USER_PRUNE_DAYS * 24 * 60 * 60 * 1000;

    for (const token of tokens) {
      const user = users[token];
      const seenMs = Date.parse(user?.lastSeen || "");
      if (!Number.isFinite(seenMs) || seenMs < cutoffMs) {
        delete users[token];
        removed += 1;
      }
    }

    if (removed > 0) {
      console.log(`Pruned ${removed} stale users`);
    }

    return removed > 0;
  });

  runtimeStats.prunesLastRemoved = removed;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    now: nowIso(),
  });
});

app.post("/register", enforceWriteGuards, async (req, res) => {
  try {
    runtimeStats.registerRequests += 1;
    const {
      fcmToken,
      latitude,
      longitude,
      deviceId,
      previousToken,
      isSensitive,
    } = req.body || {};

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
      // ── Device de-duplication ─────────────────────────────────────────
      // If the client sends a deviceId, remove any OTHER token that
      // belongs to the same physical device. This prevents the same
      // device from occupying multiple slots when its push token rotates.
      if (typeof deviceId === "string" && deviceId.length > 0) {
        for (const existingToken of Object.keys(users)) {
          if (
            existingToken !== fcmToken &&
            users[existingToken]?.deviceId === deviceId
          ) {
            console.log(
              `Removing stale token ${maskToken(existingToken)} for device ${deviceId.slice(0, 12)}…`,
            );
            delete users[existingToken];
          }
        }
      }

      // If the client detected token rotation, clean up the old token
      if (
        typeof previousToken === "string" &&
        isValidExpoToken(previousToken) &&
        previousToken !== fcmToken &&
        users[previousToken]
      ) {
        console.log(
          `Removing rotated token ${maskToken(previousToken)} (replaced by ${maskToken(fcmToken)})`,
        );
        delete users[previousToken];
      }

      users[fcmToken] = {
        ...(users[fcmToken] || {}),
        fcmToken,
        deviceId:
          typeof deviceId === "string" ? deviceId : users[fcmToken]?.deviceId,
        latitude,
        longitude,
        appOpen: true,
        activeAlertTypes: Array.isArray(users[fcmToken]?.activeAlertTypes)
          ? users[fcmToken].activeAlertTypes
          : [],
        lastSeen: nowIso(),
        registeredAt: users[fcmToken]?.registeredAt || nowIso(),
        // Initialize EMA with app's values if provided
        emaPM25: req.body?.avgPM25 ?? users[fcmToken]?.emaPM25,
        emaPM10: req.body?.avgPM10 ?? users[fcmToken]?.emaPM10,
        isSensitive:
          typeof isSensitive === "boolean"
            ? isSensitive
            : users[fcmToken]?.isSensitive || false,
      };
      return true;
    });

    console.log(
      `Registered ${maskToken(fcmToken)} @ ${latitude.toFixed(3)}, ${longitude.toFixed(3)}`,
    );
    return res.json({ success: true });
  } catch (err) {
    console.error("Register error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/update-location", enforceWriteGuards, async (req, res) => {
  try {
    runtimeStats.updateLocationRequests += 1;
    const {
      fcmToken,
      latitude,
      longitude,
      appOpen,
      activeAlertTypes,
      deviceId,
      isSensitive,
    } = req.body || {};

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
      // ── Device de-duplication (same as /register) ────────────────────
      if (typeof deviceId === "string" && deviceId.length > 0) {
        for (const existingToken of Object.keys(users)) {
          if (
            existingToken !== fcmToken &&
            users[existingToken]?.deviceId === deviceId
          ) {
            delete users[existingToken];
          }
        }
      }

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

        if (
          recentlyUpdated &&
          sameAppState &&
          sameLocation &&
          JSON.stringify(existing.activeAlertTypes) ===
            JSON.stringify(activeAlertTypes)
        ) {
          skipped = true;
          runtimeStats.updateLocationSkipped += 1;
          return false;
        }
      }

      // ── Significant Move Detection (10km threshold) ─────────────────
      // If the user has moved > 0.1 degrees, we reset the EMA to avoid
      // old location data skewing the new area's alerts.
      const hasMovedSignificantly =
        typeof existing.latitude === "number" &&
        typeof existing.longitude === "number" &&
        (Math.abs(existing.latitude - latitude) > 0.1 ||
          Math.abs(existing.longitude - longitude) > 0.1);

      users[fcmToken] = {
        ...existing,
        fcmToken,
        deviceId: typeof deviceId === "string" ? deviceId : existing.deviceId,
        latitude,
        longitude,
        appOpen: nextAppOpen,
        activeAlertTypes: Array.isArray(activeAlertTypes)
          ? activeAlertTypes
          : existing.activeAlertTypes || [],
        lastSeen: nowIso(),
        isSensitive:
          typeof isSensitive === "boolean"
            ? isSensitive
            : existing.isSensitive || false,
        // Warm up / Sync EMA with app's local averages
        // RESET logic: If moved significantly, ignore old EMA and start fresh
        emaPM25: hasMovedSignificantly
          ? (req.body?.avgPM25 ?? null)
          : (req.body?.avgPM25 ?? existing.emaPM25),
        emaPM10: hasMovedSignificantly
          ? (req.body?.avgPM10 ?? null)
          : (req.body?.avgPM10 ?? existing.emaPM10),
      };
      runtimeStats.updateLocationApplied += 1;
      return true;
    });

    // Return the server's current background average back to the app
    const finalUsers = await getAllUsers();
    const finalUser = finalUsers[fcmToken] || {};

    return res.json({
      success: true,
      skipped,
      ema: {
        emaPM25: finalUser.emaPM25,
        emaPM10: finalUser.emaPM10,
      },
    });
  } catch (err) {
    console.error("Update-location error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/check", async (req, res) => {
  if (!isAuthorizedCronRequest(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    await runRiskCheck();
    return res.json({ success: true });
  } catch (err) {
    console.error("Risk check error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/daily-summary", async (req, res) => {
  if (!isAuthorizedCronRequest(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    await sendDailySummary();
    return res.json({ success: true });
  } catch (err) {
    console.error("Daily summary error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/users", async (req, res) => {
  if (!isAuthorizedCronRequest(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
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
  } catch (err) {
    console.error("Users list error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/stats", async (req, res) => {
  if (!isAuthorizedCronRequest(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
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
  } catch (err) {
    console.error("Stats error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Periodic rate-limit bucket cleanup ──────────────────────────────────────
// Prevents memory growth when no requests arrive for extended periods.
setInterval(
  () => {
    const nowMs = Date.now();
    cleanupRateLimitBuckets(writeIpBuckets, nowMs);
    cleanupRateLimitBuckets(writeTokenBuckets, nowMs);
  },
  5 * 60 * 1000,
);

// ─── Cron ─────────────────────────────────────────────────────────────────────

cron.schedule("*/5 * * * *", () => {
  runRiskCheck().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("risk cron failed:", msg);
  });
});

cron.schedule(
  "0 6 * * *",
  () => {
    // 06:00 IST — morning briefing
    sendDailySummary().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("daily summary cron failed:", msg);
    });
  },
  { timezone: "Asia/Kolkata" },
);

cron.schedule(
  "30 3 * * *",
  () => {
    // 03:30 IST — nightly prune
    pruneStaleUsers().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("prune cron failed:", msg);
    });
  },
  { timezone: "Asia/Kolkata" },
);

if (process.env.ENABLE_SELF_PING === "true") {
  cron.schedule("*/14 * * * *", () => {
    fetch(`${SERVER_URL}/health`).catch(() => {});
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log("Cron (IST): risk=every 5 min, summary=06:00, prune=03:30");

  if (!process.env.WEATHER_API_KEY) {
    console.warn(
      "⚠️  WARNING: WEATHER_API_KEY is not set. All weather fetches will fail.",
    );
  }
  if (!CLIENT_API_KEY) {
    console.warn(
      "⚠️  WARNING: CLIENT_API_KEY is not set. Write endpoints are UNPROTECTED.",
    );
  }
  if (!process.env.CRON_SECRET) {
    console.warn(
      "⚠️  WARNING: CRON_SECRET is not set. Cron/admin endpoints will always return 401.",
    );
  }
});
