#!/usr/bin/env node
/**
 * Еднократен OAuth flow: изкарва refresh token за Google Ads API
 * и го записва в ~/.google-ads.env.
 *
 *   node bin/oauth.js
 *
 * Изисква OAuth клиент от тип "Desktop app" в Google Cloud Console.
 */
import http from "node:http";
import fs from "node:fs";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { exec } from "node:child_process";
import { ENV_FILE, loadConfig } from "../src/config.js";

const PORT = Number(process.env.OAUTH_PORT || 8787);
const REDIRECT = `http://localhost:${PORT}`;
const SCOPE = "https://www.googleapis.com/auth/adwords";

async function ask(rl, question, fallback) {
  if (fallback) return fallback;
  const answer = (await rl.question(question)).trim();
  if (!answer) {
    console.error("Стойността е задължителна.");
    process.exit(1);
  }
  return answer;
}

/** Записва ключ във .env файла, като запазва останалите редове. */
function upsertEnv(file, updates) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : [];
  for (const [key, value] of Object.entries(updates)) {
    const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
    if (idx >= 0) lines[idx] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(file, lines.join("\n").replace(/\n{3,}/g, "\n\n"), { mode: 0o600 });
}

function waitForCode(state) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const gotState = url.searchParams.get("state");

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<html><body style="font-family:system-ui;padding:3rem;text-align:center">
         <h2>${code ? "Готово ✓" : "Проблем ✗"}</h2>
         <p>${code ? "Можеш да затвориш този таб и да се върнеш в терминала." : error ?? "Няма код в отговора."}</p>
         </body></html>`
      );

      server.close();
      if (error) return reject(new Error(`OAuth отказан: ${error}`));
      if (gotState !== state) return reject(new Error("State несъвпадение — прекратявам."));
      if (!code) return reject(new Error("Няма authorization code в redirect-а."));
      resolve(code);
    });
    server.on("error", reject);
    server.listen(PORT);
  });
}

const cfg = loadConfig();
const rl = readline.createInterface({ input: stdin, output: stdout });

console.log(`\nOAuth setup за Google Ads API\nКонфиг файл: ${ENV_FILE}\n`);

const clientId = await ask(rl, "OAuth Client ID: ", cfg.clientId);
const clientSecret = await ask(rl, "OAuth Client Secret: ", cfg.clientSecret);
rl.close();

if (cfg.clientId) console.log(`Client ID: ${clientId} (от конфига)`);

const state = Math.random().toString(36).slice(2);
// Кой Google акаунт да е предварително избран на consent екрана.
const loginHint = process.env.GOOGLE_ADS_OAUTH_LOGIN_HINT;

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent", // задължително, иначе Google не връща refresh_token втори път
    state,
    ...(loginHint ? { login_hint: loginHint } : {}),
  });

console.log(`\nОтварям браузъра. Ако не се отвори, копирай този линк:\n\n${authUrl}\n`);
console.log(
  loginHint
    ? `⚠️  Логни се задължително като ${loginHint} — refresh token-ът се връзва за акаунта, с който дадеш съгласие.`
    : "⚠️  Внимавай с кой Google акаунт се логваш — refresh token-ът се връзва точно за него."
);
console.log(`Чакам на ${REDIRECT} ...\n`);

// macOS: open · Windows: start · Linux: xdg-open. Ако нито едно не сработи,
// линкът вече е отпечатан по-горе и се копира на ръка.
const opener =
  process.platform === "darwin"
    ? `open "${authUrl}"`
    : process.platform === "win32"
      ? `start "" "${authUrl}"`
      : `xdg-open "${authUrl}"`;
exec(opener, () => {});

let code;
try {
  code = await waitForCode(state);
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
}

const res = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT,
    grant_type: "authorization_code",
  }),
});

const json = await res.json();
if (!res.ok || !json.refresh_token) {
  console.error(`\n✗ Размяната на кода се провали:\n${JSON.stringify(json, null, 2)}`);
  if (res.ok && !json.refresh_token) {
    console.error(
      "\nGoogle върна access token, но не и refresh token. Това става, ако вече си давал " +
        "съгласие за този клиент. Махни достъпа от https://myaccount.google.com/permissions и пробвай пак."
    );
  }
  process.exit(1);
}

upsertEnv(ENV_FILE, {
  GOOGLE_ADS_CLIENT_ID: clientId,
  GOOGLE_ADS_CLIENT_SECRET: clientSecret,
  GOOGLE_ADS_REFRESH_TOKEN: json.refresh_token,
});

console.log(`\n✓ Refresh token е записан в ${ENV_FILE}`);
console.log(
  "\nОстава да попълниш в същия файл:\n" +
    "  GOOGLE_ADS_DEVELOPER_TOKEN   — от MCC → Tools → Setup → API Center\n" +
    "  GOOGLE_ADS_LOGIN_CUSTOMER_ID — ID-то на MCC-то (само цифри)\n" +
    "\nПосле пусни: node bin/doctor.js"
);
