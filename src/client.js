import { getAccessToken, clearTokenCache } from "./auth.js";
import { loadConfig, normalizeCustomerId } from "./config.js";

function base() {
  const cfg = loadConfig();
  return `https://googleads.googleapis.com/${cfg.apiVersion}`;
}

async function headers({ loginCustomerId } = {}) {
  const cfg = loadConfig();
  const h = {
    Authorization: `Bearer ${await getAccessToken()}`,
    "developer-token": cfg.developerToken,
    "Content-Type": "application/json",
  };
  const login = normalizeCustomerId(loginCustomerId) || cfg.loginCustomerId;
  if (login) h["login-customer-id"] = login;
  return h;
}

/** Google Ads връща грешките дълбоко вложени — вадим ги в четим вид. */
export class GoogleAdsError extends Error {
  constructor(status, payload, context) {
    const details = extractErrors(payload);
    const summary = details.length
      ? details
          .map((e) => {
            const parts = [e.code ? `[${e.code}]` : null, e.message].filter(Boolean);
            if (e.trigger !== undefined) parts.push(`(trigger: ${JSON.stringify(e.trigger)})`);
            if (e.field) parts.push(`(поле: ${e.field})`);
            return parts.join(" ");
          })
          .join("\n")
      : typeof payload === "string"
        ? payload
        : JSON.stringify(payload);

    super(`Google Ads API HTTP ${status}${context ? ` при ${context}` : ""}:\n${summary}`);
    this.name = "GoogleAdsError";
    this.status = status;
    this.details = details;
    this.payload = payload;
  }
}

function extractErrors(payload) {
  const out = [];
  const err = payload?.error ?? payload?.[0]?.error;
  if (!err) return out;

  const detailBlocks = err.details ?? [];
  for (const block of detailBlocks) {
    for (const e of block.errors ?? []) {
      const codeObj = e.errorCode ?? {};
      const codeKey = Object.keys(codeObj)[0];
      out.push({
        code: codeKey ? `${codeKey}.${codeObj[codeKey]}` : undefined,
        message: e.message,
        trigger: e.trigger?.stringValue ?? e.trigger,
        field: e.location?.fieldPathElements
          ?.map((f) => (f.index !== undefined ? `${f.fieldName}[${f.index}]` : f.fieldName))
          .join("."),
      });
    }
  }
  if (!out.length && err.message) out.push({ code: err.status, message: err.message });
  return out;
}

async function request(url, { method = "POST", body, loginCustomerId, context, retry = true } = {}) {
  const res = await fetch(url, {
    method,
    headers: await headers({ loginCustomerId }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = text;
  }

  if (!res.ok) {
    // Изтекъл/отменен access token → един повторен опит с пресен токен.
    if (res.status === 401 && retry) {
      clearTokenCache();
      return request(url, { method, body, loginCustomerId, context, retry: false });
    }
    throw new GoogleAdsError(res.status, payload, context);
  }
  return payload;
}

function isPermissionDenied(err) {
  return (
    err instanceof GoogleAdsError &&
    (err.details ?? []).some((d) => d.code === "authorizationError.USER_PERMISSION_DENIED")
  );
}

/**
 * Някои акаунти са достъпни директно (не през конфигурираното MCC) — при
 * USER_PERMISSION_DENIED без изричен login опитваме втори път със самия акаунт
 * като login-customer-id.
 */
async function withLoginFallback(cid, explicitLogin, fn) {
  try {
    return await fn(explicitLogin);
  } catch (err) {
    if (explicitLogin || !isPermissionDenied(err)) throw err;
    return fn(cid);
  }
}

/**
 * GAQL заявка през searchStream — без пагинация, връща всичко наведнъж.
 * Отговорът е JSON масив от чънкове; сплескваме ги в един списък редове.
 */
export async function gaql(customerId, query, { loginCustomerId } = {}) {
  const cid = normalizeCustomerId(customerId);
  if (!cid) throw new Error(`Невалиден customerId: ${customerId}`);

  const payload = await withLoginFallback(cid, loginCustomerId, (login) =>
    request(`${base()}/customers/${cid}/googleAds:searchStream`, {
      body: { query },
      loginCustomerId: login,
      context: `GAQL върху ${cid}`,
    })
  );

  const chunks = Array.isArray(payload) ? payload : [payload];
  const rows = [];
  let fieldMask;
  for (const chunk of chunks) {
    if (chunk?.fieldMask) fieldMask = chunk.fieldMask;
    for (const r of chunk?.results ?? []) rows.push(r);
  }
  return { customerId: cid, rowCount: rows.length, fieldMask, rows };
}

/** Пуска N заявки паралелно. Провалите се връщат като { error }, не бомбят целия зов. */
export async function gaqlParallel(queries, { loginCustomerId } = {}) {
  const settled = await Promise.allSettled(
    queries.map((q) => gaql(q.customerId, q.query, { loginCustomerId }))
  );
  const out = {};
  settled.forEach((r, i) => {
    const name = queries[i].name || `query_${i + 1}`;
    out[name] =
      r.status === "fulfilled"
        ? r.value
        : { error: r.reason?.message ?? String(r.reason), customerId: queries[i].customerId };
  });
  return out;
}

/**
 * Универсален mutate. Едно извикване може да смеси операции върху различни ресурси
 * (кампании, ad groups, keywords, бюджети...) и те минават атомарно.
 */
export async function mutate(
  customerId,
  mutateOperations,
  { validateOnly = false, partialFailure = false, responseContentType = "MUTABLE_RESOURCE", loginCustomerId } = {}
) {
  const cid = normalizeCustomerId(customerId);
  if (!cid) throw new Error(`Невалиден customerId: ${customerId}`);

  return withLoginFallback(cid, loginCustomerId, (login) =>
    request(`${base()}/customers/${cid}/googleAds:mutate`, {
      body: { mutateOperations, validateOnly, partialFailure, responseContentType },
      loginCustomerId: login,
      context: `mutate върху ${cid}`,
    })
  );
}

/** Escape hatch: ресурси, които не са част от googleAds:mutate (напр. keywordPlans). */
export async function serviceMutate(customerId, service, body, { loginCustomerId } = {}) {
  const cid = normalizeCustomerId(customerId);
  return request(`${base()}/customers/${cid}/${service}:mutate`, {
    body,
    loginCustomerId,
    context: `${service}:mutate върху ${cid}`,
  });
}

/** Custom методи на ниво customer, напр. generateKeywordIdeas. */
export async function customerCall(customerId, method, body, { loginCustomerId } = {}) {
  const cid = normalizeCustomerId(customerId);
  if (!cid) throw new Error(`Невалиден customerId: ${customerId}`);
  return request(`${base()}/customers/${cid}:${method}`, {
    body,
    loginCustomerId,
    context: `${method} върху ${cid}`,
  });
}

/** Кои клиенти вижда OAuth потребителят (обикновено само MCC-тата). */
export async function listAccessibleCustomers() {
  const payload = await request(`${base()}/customers:listAccessibleCustomers`, {
    method: "GET",
    context: "listAccessibleCustomers",
  });
  return (payload.resourceNames ?? []).map((rn) => rn.split("/")[1]);
}

/** Метаданни за GAQL полета — помага при писане на заявки. */
export async function searchFields(query) {
  const payload = await request(`${base()}/googleAdsFields:search`, {
    body: { query },
    context: "googleAdsFields:search",
  });
  return payload.results ?? [];
}
