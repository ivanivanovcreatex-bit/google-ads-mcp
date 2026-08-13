import { mutate } from "../client.js";
import { readChanges, markUndone, buildUndoOperations } from "../changelog.js";
import { loadGuardrails, saveGuardrails } from "../guardrails.js";
import { loadConfig, ENV_FILE, STATE_DIR } from "../config.js";
import { getAccessToken } from "../auth.js";
import { listAccessibleCustomers } from "../client.js";

export const opsTools = [
  {
    name: "list_changes",
    description:
      "Локалният change log — всяка промяна, направена през този MCP, с ID за връщане назад. " +
      "Различава се от change_history: там е историята от Google (включително ръчни промени), " +
      "тук са само промените оттук, но със снимка на старите стойности.",
    inputSchema: {
      type: "object",
      properties: {
        customerId: { type: "string", description: "Филтър по акаунт." },
        limit: { type: "number", description: "Брой записи (по подразбиране 30)." },
      },
    },
    handler: async ({ customerId, limit = 30 }) => {
      const changes = readChanges({ customerId, limit });
      return {
        count: changes.length,
        logFile: `${STATE_DIR}/changes.jsonl`,
        changes: changes.map((c) => ({
          changeId: c.id,
          ts: c.ts,
          customerId: c.customerId,
          label: c.label,
          operations: c.operationCount,
          undone: c.undone,
          undoable: (c.items ?? []).some(
            (i) => (i.action === "update" && i.before?.ok) || (i.action === "create" && i.createdResourceName)
          ),
        })),
      };
    },
  },

  {
    name: "undo_change",
    description:
      "Връща назад промяна от локалния change log по нейния changeId. " +
      "Update-ите се възстановяват от записаната снимка, създадените обекти се премахват. " +
      "REMOVE операциите НЕ могат да се върнат — Google Ads API не поддържа un-remove.",
    inputSchema: {
      type: "object",
      properties: {
        changeId: { type: "string", description: "ID от list_changes." },
        dryRun: {
          type: "boolean",
          description: "Показва какво би направил undo-то, без да го прилага.",
        },
      },
      required: ["changeId"],
    },
    handler: async ({ changeId, dryRun = false }) => {
      const record = readChanges({ limit: 10000 }).find((c) => c.id === changeId);
      if (!record) throw new Error(`Няма промяна с ID "${changeId}". Виж list_changes.`);
      if (record.undone) return { changeId, message: "Тази промяна вече е върната назад.", skipped: true };

      const { ops, blocked } = buildUndoOperations(record);
      if (!ops.length) {
        return {
          changeId,
          undone: false,
          message: "Няма нищо, което може да се върне автоматично.",
          blocked,
        };
      }

      if (dryRun) {
        return { changeId, dryRun: true, wouldApply: ops, blocked };
      }

      const response = await mutate(record.customerId, ops, { validateOnly: false });
      markUndone(changeId);
      return {
        changeId,
        undone: true,
        reverted: ops.length,
        ...(blocked.length ? { blocked } : {}),
        response,
      };
    },
  },

  {
    name: "get_guardrails",
    description:
      "Показва активните предпазни правила: read-only акаунти, лимит на увеличение на бюджет, " +
      "изискване за потвърждение при изтриване и т.н.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({ file: `${STATE_DIR}/guardrails.json`, guardrails: loadGuardrails() }),
  },

  {
    name: "set_guardrails",
    description:
      "Променя предпазните правила. Подавай само полетата, които искаш да смениш. " +
      "Пример: маркирай клиентски акаунт като read-only, докато трае одитът.",
    inputSchema: {
      type: "object",
      properties: {
        readOnlyAccounts: { type: "array", items: { type: "string" } },
        blockedAccounts: { type: "array", items: { type: "string" } },
        writeAllowlist: {
          type: "array",
          items: { type: "string" },
          description: "Ако не е празен, писане е позволено САМО в тези акаунти.",
        },
        maxBudgetIncreasePct: { type: ["number", "null"], description: "null = без лимит." },
        maxDailyBudget: { type: ["number", "null"] },
        requireConfirmForRemove: { type: "boolean" },
        maxOperationsPerCall: { type: "number" },
      },
    },
    handler: async (args) => {
      const patch = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
      return { updated: Object.keys(patch), guardrails: saveGuardrails(patch) };
    },
  },

  {
    name: "check_connection",
    description:
      "Диагностика: конфигуриран ли е MCP-то, работи ли OAuth токенът и кои акаунти вижда. " +
      "Пусни това първо, ако нещо не работи.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const cfg = loadConfig({ reload: true });
      const status = {
        envFile: ENV_FILE,
        apiVersion: cfg.apiVersion,
        loginCustomerId: cfg.loginCustomerId ?? "(не е зададен)",
        developerToken: cfg.developerToken ? "✓ зададен" : "✗ липсва",
        clientId: cfg.clientId ? "✓ зададен" : "✗ липсва",
        clientSecret: cfg.clientSecret ? "✓ зададен" : "✗ липсва",
        refreshToken: cfg.refreshToken ? "✓ зададен" : "✗ липсва",
      };

      try {
        await getAccessToken({ force: true });
        status.oauth = "✓ access token се взима успешно";
      } catch (e) {
        return { status, oauth: `✗ ${e.message}`, ok: false };
      }

      try {
        const ids = await listAccessibleCustomers();
        status.accessibleCustomers = ids;
        status.ok = true;
        status.next =
          "Пусни list_accounts, за да видиш цялото дърво под MCC-то (включително дъщерните акаунти).";
      } catch (e) {
        status.ok = false;
        status.apiError = e.message;
      }
      return status;
    },
  },
];
