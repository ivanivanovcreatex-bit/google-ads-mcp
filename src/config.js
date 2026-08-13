import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME = os.homedir();

/** Креденшъли. Пътят може да се смени с GOOGLE_ADS_ENV_FILE. */
export const ENV_FILE =
  process.env.GOOGLE_ADS_ENV_FILE || path.join(HOME, ".google-ads.env");

/** Локален state: change log + guardrails */
export const STATE_DIR =
  process.env.GOOGLE_ADS_STATE_DIR || path.join(HOME, ".google-ads-mcp");

/**
 * Версия на API-то. v25 излезе 22.07.2026; v24 е доказана и живее още ~година.
 * Смяната е един ред в ~/.google-ads.env: GOOGLE_ADS_API_VERSION=v25
 */
export const DEFAULT_API_VERSION = "v24";

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (val) out[key] = val;
  }
  return out;
}

/** Само цифри — API-то не приема 123-456-7890 */
export function normalizeCustomerId(id) {
  if (id === undefined || id === null) return undefined;
  const digits = String(id).replace(/\D/g, "");
  return digits || undefined;
}

let cached = null;

export function loadConfig({ reload = false } = {}) {
  if (cached && !reload) return cached;

  // process.env има приоритет пред файла
  const fromFile = parseEnvFile(ENV_FILE);
  const get = (k) => process.env[k] || fromFile[k];

  const cfg = {
    developerToken: get("GOOGLE_ADS_DEVELOPER_TOKEN"),
    clientId: get("GOOGLE_ADS_CLIENT_ID"),
    clientSecret: get("GOOGLE_ADS_CLIENT_SECRET"),
    refreshToken: get("GOOGLE_ADS_REFRESH_TOKEN"),
    loginCustomerId: normalizeCustomerId(get("GOOGLE_ADS_LOGIN_CUSTOMER_ID")),
    apiVersion: get("GOOGLE_ADS_API_VERSION") || DEFAULT_API_VERSION,
    envFile: ENV_FILE,
  };

  cached = cfg;
  return cfg;
}

export function assertConfigured(cfg = loadConfig()) {
  const missing = [
    ["GOOGLE_ADS_DEVELOPER_TOKEN", cfg.developerToken],
    ["GOOGLE_ADS_CLIENT_ID", cfg.clientId],
    ["GOOGLE_ADS_CLIENT_SECRET", cfg.clientSecret],
    ["GOOGLE_ADS_REFRESH_TOKEN", cfg.refreshToken],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length) {
    throw new Error(
      `Google Ads API не е конфигуриран. Липсват: ${missing.join(", ")}.\n` +
        `Попълни ги в ${ENV_FILE} (виж .env.example).\n` +
        `За refresh token пусни: node ${path.join(
          path.dirname(new URL(import.meta.url).pathname),
          "..",
          "bin",
          "oauth.js"
        )}`
    );
  }
  return cfg;
}

export function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  return STATE_DIR;
}
