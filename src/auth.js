import { loadConfig, assertConfigured } from "./config.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

let cache = { token: null, expiresAt: 0 };

/**
 * Разменя refresh token за access token. Кешира го в паметта
 * до 60 сек. преди изтичане, за да не бием OAuth ендпойнта на всяка заявка.
 */
export async function getAccessToken({ force = false } = {}) {
  const cfg = assertConfigured(loadConfig());

  if (!force && cache.token && Date.now() < cache.expiresAt) {
    return cache.token;
  }

  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    let hint = "";
    if (text.includes("invalid_grant")) {
      hint =
        "\nПричина обикновено: refresh token е отменен, OAuth клиентът е в Testing режим " +
        "(токените живеят 7 дни), или паролата на акаунта е сменена. " +
        "Пусни `npm run oauth` отново.";
    }
    throw new Error(`OAuth refresh се провали (HTTP ${res.status}): ${text}${hint}`);
  }

  const json = JSON.parse(text);
  cache = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000,
  };
  return cache.token;
}

export function clearTokenCache() {
  cache = { token: null, expiresAt: 0 };
}
