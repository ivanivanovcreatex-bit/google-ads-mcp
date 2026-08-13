import fs from "node:fs";
import path from "node:path";
import { ensureStateDir } from "./config.js";
import { gaql } from "./client.js";

const LOG_FILE = () => path.join(ensureStateDir(), "changes.jsonl");

/** Множествено число от resource_name → GAQL ресурс. */
const RESOURCE_BY_SEGMENT = {
  campaigns: "campaign",
  campaignBudgets: "campaign_budget",
  campaignCriteria: "campaign_criterion",
  campaignBidModifiers: "campaign_bid_modifier",
  campaignSharedSets: "campaign_shared_set",
  adGroups: "ad_group",
  adGroupAds: "ad_group_ad",
  adGroupCriteria: "ad_group_criterion",
  adGroupBidModifiers: "ad_group_bid_modifier",
  assetGroups: "asset_group",
  assetGroupAssets: "asset_group_asset",
  assets: "asset",
  biddingStrategies: "bidding_strategy",
  conversionActions: "conversion_action",
  customerNegativeCriteria: "customer_negative_criterion",
  sharedSets: "shared_set",
  sharedCriteria: "shared_criterion",
  userLists: "user_list",
};

/** campaign → campaignOperation ; ad_group_criterion → adGroupCriterionOperation */
export function operationKey(resource) {
  const camel = resource.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  return `${camel}Operation`;
}

export function resourceFromName(resourceName) {
  // customers/1234567890/campaigns/555
  const parts = String(resourceName).split("/");
  const segment = parts[2];
  return RESOURCE_BY_SEGMENT[segment] ?? null;
}

function camelToSnake(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** REST редовете са camelCase, а updateMask е snake_case — пътят се камелизира преди четене. */
function pathToCamel(p) {
  return p
    .split(".")
    .map((s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase()))
    .join(".");
}

function setPath(obj, dottedPath, value) {
  const keys = dottedPath.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    cur[keys[i]] ??= {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

function getPath(obj, dottedPath) {
  return dottedPath.split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

/**
 * Снима текущите стойности на полетата от updateMask ПРЕДИ промяната,
 * за да може undo да ги върне. Best-effort: ако полето не е selectable
 * в GAQL, записваме null и маркираме промяната като необратима.
 */
export async function snapshotBefore(customerId, resourceName, updateMaskPaths, { loginCustomerId } = {}) {
  const resource = resourceFromName(resourceName);
  if (!resource) return { ok: false, reason: `непознат ресурс в ${resourceName}`, values: null };

  const paths = updateMaskPaths.filter(Boolean);
  if (!paths.length) return { ok: false, reason: "празен updateMask", values: null };

  const attempts = [
    paths.map((p) => `${resource}.${camelToSnake(p)}`), // пълният път
    [...new Set(paths.map((p) => `${resource}.${camelToSnake(p.split(".")[0])}`))], // само първият сегмент
  ];

  for (const fields of attempts) {
    try {
      const q = `SELECT ${fields.join(", ")} FROM ${resource} WHERE ${resource}.resource_name = '${resourceName}'`;
      const { rows } = await gaql(customerId, q, { loginCustomerId });
      if (!rows.length) return { ok: false, reason: "ресурсът не е намерен", values: null };

      const row = rows[0][resource.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] ?? rows[0];
      const values = {};
      for (const p of paths) {
        const camelPath = pathToCamel(p);
        const v = getPath(row, camelPath);
        if (v !== undefined) setPath(values, camelPath, v);
      }
      if (Object.keys(values).length) return { ok: true, values };
    } catch {
      // пробваме следващия вариант
    }
  }
  return { ok: false, reason: "полетата не са четими през GAQL", values: null };
}

let counter = 0;

export function recordChange(entry) {
  const id = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${String(
    ++counter
  ).padStart(3, "0")}-${Math.floor(Math.random() * 1e4)}`;

  const record = { id, ts: new Date().toISOString(), undone: false, ...entry };
  fs.appendFileSync(LOG_FILE(), JSON.stringify(record) + "\n", { mode: 0o600 });
  return record;
}

export function readChanges({ limit = 30, customerId } = {}) {
  const file = LOG_FILE();
  if (!fs.existsSync(file)) return [];
  const all = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const filtered = customerId
    ? all.filter((c) => c.customerId === String(customerId).replace(/\D/g, ""))
    : all;
  return filtered.slice(-limit).reverse();
}

export function markUndone(id) {
  const file = LOG_FILE();
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const updated = lines.map((l) => {
    try {
      const rec = JSON.parse(l);
      if (rec.id === id) rec.undone = true;
      return JSON.stringify(rec);
    } catch {
      return l;
    }
  });
  fs.writeFileSync(file, updated.join("\n") + "\n", { mode: 0o600 });
}

/** Строи обратните операции за един запис от лога. */
export function buildUndoOperations(record) {
  const ops = [];
  const blocked = [];

  for (const item of record.items ?? []) {
    const opKey = operationKey(item.resource);

    if (item.action === "update") {
      if (!item.before?.ok) {
        blocked.push(`${item.resourceName}: няма снимка преди промяната (${item.before?.reason ?? "n/a"})`);
        continue;
      }
      ops.push({
        [opKey]: {
          update: { resourceName: item.resourceName, ...item.before.values },
          updateMask: item.updateMask,
        },
      });
    } else if (item.action === "create") {
      if (!item.createdResourceName) {
        blocked.push(`създаден обект без resourceName — не мога да го изтрия`);
        continue;
      }
      ops.push({ [opKey]: { remove: item.createdResourceName } });
    } else if (item.action === "remove") {
      blocked.push(`${item.resourceName}: REMOVE е необратим в Google Ads API`);
    }
  }
  return { ops, blocked };
}
