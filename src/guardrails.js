import fs from "node:fs";
import path from "node:path";
import { ensureStateDir, normalizeCustomerId } from "./config.js";

const FILE = () => path.join(ensureStateDir(), "guardrails.json");

const DEFAULTS = {
  /** Акаунти, върху които изобщо не се пише (само четене). */
  readOnlyAccounts: [],
  /** Акаунти, които са напълно недостъпни. */
  blockedAccounts: [],
  /** Ако е зададен — САМО тези акаунти са позволени за писане. */
  writeAllowlist: [],
  /** Максимално увеличение на дневен бюджет за едно извикване, в %. null = без лимит. */
  maxBudgetIncreasePct: 50,
  /** Абсолютен таван на дневен бюджет (в валутата на акаунта). null = без лимит. */
  maxDailyBudget: null,
  /** REMOVE операции изискват confirm: true. */
  requireConfirmForRemove: true,
  /** Максимален брой операции в едно извикване. */
  maxOperationsPerCall: 500,
};

export function loadGuardrails() {
  const file = FILE();
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2), { mode: 0o600 });
    return { ...DEFAULTS };
  }
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveGuardrails(patch) {
  const merged = { ...loadGuardrails(), ...patch };
  fs.writeFileSync(FILE(), JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}

export class GuardrailError extends Error {
  constructor(message) {
    super(`Guardrail блокира промяната: ${message}`);
    this.name = "GuardrailError";
  }
}

function has(list, cid) {
  return (list ?? []).map((x) => normalizeCustomerId(x)).includes(cid);
}

/** Проверки, които важат за всяко четене. */
export function assertReadable(customerId) {
  const cid = normalizeCustomerId(customerId);
  const g = loadGuardrails();
  if (has(g.blockedAccounts, cid)) {
    throw new GuardrailError(`акаунт ${cid} е в blockedAccounts`);
  }
  return cid;
}

/** Проверки, които важат за всяко писане. */
export function assertWritable(customerId, operations = [], { confirm = false } = {}) {
  const cid = assertReadable(customerId);
  const g = loadGuardrails();

  if (has(g.readOnlyAccounts, cid)) {
    throw new GuardrailError(`акаунт ${cid} е маркиран read-only`);
  }
  if ((g.writeAllowlist ?? []).length && !has(g.writeAllowlist, cid)) {
    throw new GuardrailError(
      `акаунт ${cid} не е в writeAllowlist (позволени: ${g.writeAllowlist.join(", ")})`
    );
  }
  if (operations.length > g.maxOperationsPerCall) {
    throw new GuardrailError(
      `${operations.length} операции надхвърлят лимита maxOperationsPerCall=${g.maxOperationsPerCall}`
    );
  }
  if (g.requireConfirmForRemove && !confirm) {
    const removes = operations.filter((op) => {
      const inner = op[Object.keys(op)[0]];
      return inner && "remove" in inner;
    });
    if (removes.length) {
      throw new GuardrailError(
        `${removes.length} REMOVE операции изискват confirm: true (REMOVE е необратим в Google Ads API)`
      );
    }
  }
  return cid;
}

/** Отделна проверка за бюджети — има нужда от текущата стойност. */
export function assertBudgetChange({ currentAmount, newAmount, currencyCode }) {
  const g = loadGuardrails();

  if (g.maxDailyBudget != null && newAmount > g.maxDailyBudget) {
    throw new GuardrailError(
      `нов бюджет ${newAmount} ${currencyCode ?? ""} надхвърля maxDailyBudget=${g.maxDailyBudget}`
    );
  }
  if (g.maxBudgetIncreasePct != null && currentAmount > 0) {
    const pct = ((newAmount - currentAmount) / currentAmount) * 100;
    if (pct > g.maxBudgetIncreasePct) {
      throw new GuardrailError(
        `увеличение от ${currentAmount} на ${newAmount} е +${pct.toFixed(1)}%, ` +
          `лимитът е maxBudgetIncreasePct=${g.maxBudgetIncreasePct}%. ` +
          `Вдигни лимита през set_guardrails или направи промяната на стъпки.`
      );
    }
  }
}
