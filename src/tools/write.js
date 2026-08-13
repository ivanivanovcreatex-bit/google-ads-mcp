import { gaql } from "../client.js";
import { applyMutate, toMicros, fromMicros } from "../apply.js";
import { assertBudgetChange, GuardrailError } from "../guardrails.js";
import { operationKey } from "../changelog.js";

const CUSTOMER_ID = {
  type: "string",
  description: "Google Ads customer ID (с или без тирета).",
};
const DRY_RUN = {
  type: "boolean",
  description: "Само валидация през API-то, без реална промяна. По подразбиране false.",
};

const MATCH_TYPES = ["EXACT", "PHRASE", "BROAD"];

function adGroupRn(cid, adGroupId) {
  return `customers/${String(cid).replace(/\D/g, "")}/adGroups/${String(adGroupId).replace(/\D/g, "")}`;
}
function campaignRn(cid, campaignId) {
  return `customers/${String(cid).replace(/\D/g, "")}/campaigns/${String(campaignId).replace(/\D/g, "")}`;
}

export const writeTools = [
  {
    name: "mutate",
    description:
      "Универсален запис — приема суровите mutate операции на Google Ads API и може да смеси " +
      "различни ресурси в едно атомарно извикване (кампании, ad groups, keywords, бюджети, асети...). " +
      "Използвай го за всичко, което специализираните инструменти не покриват. " +
      "ВАЖНО: по подразбиране работи в режим validateOnly (само проверка). Подай validateOnly: false, " +
      "за да приложиш промяната наистина.",
    inputSchema: {
      type: "object",
      properties: {
        customerId: CUSTOMER_ID,
        mutateOperations: {
          type: "array",
          description:
            "Масив от операции, всяка с ключ <resource>Operation, напр. " +
            '[{"campaignOperation":{"update":{"resourceName":"customers/123/campaigns/456","status":"PAUSED"},"updateMask":"status"}}]',
          items: { type: "object" },
        },
        validateOnly: {
          type: "boolean",
          description: "true (по подразбиране) = само проверка. false = прилага промяната.",
        },
        partialFailure: {
          type: "boolean",
          description: "Ако е true, валидните операции минават дори при грешка в останалите.",
        },
        confirm: {
          type: "boolean",
          description: "Задължително true, ако има REMOVE операции.",
        },
        label: { type: "string", description: "Кратко описание за change log-а." },
      },
      required: ["customerId", "mutateOperations"],
    },
    handler: async ({ customerId, mutateOperations, validateOnly = true, partialFailure, confirm, label }) =>
      applyMutate(customerId, mutateOperations, {
        validateOnly,
        partialFailure,
        confirm,
        label: label ?? "raw mutate",
      }),
  },

  {
    name: "set_status",
    description:
      "Пуска, спира или премахва кампании, ad groups, реклами, ключови думи или asset groups. " +
      "Приема много resource names наведнъж — bulk pause/enable е едно извикване. " +
      "REMOVED е необратим и изисква confirm: true.",
    inputSchema: {
      type: "object",
      properties: {
        customerId: CUSTOMER_ID,
        resourceType: {
          type: "string",
          enum: ["campaign", "ad_group", "ad_group_ad", "ad_group_criterion", "campaign_criterion", "asset_group"],
        },
        resourceNames: {
          type: "array",
          items: { type: "string" },
          description:
            "Пълни resource names, напр. customers/123/campaigns/456 или customers/123/adGroupCriteria/456~789. " +
            "Вземи ги с run_gaql (SELECT ... .resource_name).",
        },
        status: { type: "string", enum: ["ENABLED", "PAUSED", "REMOVED"] },
        confirm: { type: "boolean", description: "Задължително true при status REMOVED." },
        dryRun: DRY_RUN,
      },
      required: ["customerId", "resourceType", "resourceNames", "status"],
    },
    handler: async ({ customerId, resourceType, resourceNames, status, confirm, dryRun = false }) => {
      const opKey = operationKey(resourceType);
      const operations = resourceNames.map((rn) =>
        status === "REMOVED"
          ? { [opKey]: { remove: rn } }
          : { [opKey]: { update: { resourceName: rn, status }, updateMask: "status" } }
      );
      return applyMutate(customerId, operations, {
        validateOnly: dryRun,
        confirm,
        label: `set_status ${resourceType} → ${status} (${resourceNames.length} бр.)`,
      });
    },
  },

  {
    name: "set_campaign_budget",
    description:
      "Сменя дневния бюджет на кампания. Първо чете текущата стойност, прилага guardrail-а за " +
      "максимално процентно увеличение и предупреждава, ако бюджетът е споделен между кампании.",
    inputSchema: {
      type: "object",
      properties: {
        customerId: CUSTOMER_ID,
        campaignId: { type: "string", description: "ID на кампанията." },
        amount: {
          type: "number",
          description: "Нов дневен бюджет във валутата на акаунта (напр. 50 = 50 лв./ден).",
        },
        confirm: {
          type: "boolean",
          description: "Задължително true, ако бюджетът е споделен между няколко кампании.",
        },
        dryRun: DRY_RUN,
      },
      required: ["customerId", "campaignId", "amount"],
    },
    handler: async ({ customerId, campaignId, amount, confirm = false, dryRun = false }) => {
      const { rows } = await gaql(
        customerId,
        `SELECT campaign.name, campaign_budget.resource_name, campaign_budget.amount_micros,
                campaign_budget.explicitly_shared, campaign_budget.name, customer.currency_code
         FROM campaign WHERE campaign.id = ${String(campaignId).replace(/\D/g, "")}`
      );
      if (!rows.length) throw new Error(`Кампания ${campaignId} не е намерена в акаунт ${customerId}.`);

      const budget = rows[0].campaignBudget ?? {};
      const currency = rows[0].customer?.currencyCode;
      const current = fromMicros(budget.amountMicros);

      if (budget.explicitlyShared && !confirm) {
        throw new GuardrailError(
          `бюджетът "${budget.name}" е споделен и промяната ще засегне всички кампании, които го ползват. ` +
            `Пусни пак с confirm: true.`
        );
      }
      assertBudgetChange({ currentAmount: current, newAmount: amount, currencyCode: currency });

      const result = await applyMutate(
        customerId,
        [
          {
            campaignBudgetOperation: {
              update: { resourceName: budget.resourceName, amountMicros: String(toMicros(amount)) },
              updateMask: "amount_micros",
            },
          },
        ],
        {
          validateOnly: dryRun,
          label: `бюджет "${rows[0].campaign?.name}": ${current} → ${amount} ${currency ?? ""}`,
        }
      );
      return { campaign: rows[0].campaign?.name, currency, previousAmount: current, newAmount: amount, ...result };
    },
  },

  {
    name: "set_bid",
    description:
      "Обновява CPC бидове — на ниво ключова дума (ad_group_criterion) или ad group. " +
      "Приема много обекти наведнъж за bulk промени.",
    inputSchema: {
      type: "object",
      properties: {
        customerId: CUSTOMER_ID,
        level: { type: "string", enum: ["ad_group_criterion", "ad_group"] },
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              resourceName: { type: "string" },
              cpcBid: { type: "number", description: "Нов бид във валутата на акаунта." },
            },
            required: ["resourceName", "cpcBid"],
          },
        },
        dryRun: DRY_RUN,
      },
      required: ["customerId", "level", "updates"],
    },
    handler: async ({ customerId, level, updates, dryRun = false }) => {
      const opKey = operationKey(level);
      const operations = updates.map((u) => ({
        [opKey]: {
          update: { resourceName: u.resourceName, cpcBidMicros: String(toMicros(u.cpcBid)) },
          updateMask: "cpc_bid_micros",
        },
      }));
      return applyMutate(customerId, operations, {
        validateOnly: dryRun,
        label: `set_bid ${level} (${updates.length} бр.)`,
      });
    },
  },

  {
    name: "add_keywords",
    description: "Добавя позитивни ключови думи към ad group, по избор с индивидуален бид.",
    inputSchema: {
      type: "object",
      properties: {
        customerId: CUSTOMER_ID,
        adGroupId: { type: "string" },
        keywords: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              matchType: { type: "string", enum: MATCH_TYPES },
              cpcBid: { type: "number" },
            },
            required: ["text", "matchType"],
          },
        },
        status: { type: "string", enum: ["ENABLED", "PAUSED"], description: "По подразбиране ENABLED." },
        dryRun: DRY_RUN,
      },
      required: ["customerId", "adGroupId", "keywords"],
    },
    handler: async ({ customerId, adGroupId, keywords, status = "ENABLED", dryRun = false }) => {
      const adGroup = adGroupRn(customerId, adGroupId);
      const operations = keywords.map((k) => ({
        adGroupCriterionOperation: {
          create: {
            adGroup,
            status,
            keyword: { text: k.text, matchType: k.matchType },
            ...(k.cpcBid ? { cpcBidMicros: String(toMicros(k.cpcBid)) } : {}),
          },
        },
      }));
      return applyMutate(customerId, operations, {
        validateOnly: dryRun,
        label: `add_keywords → ad group ${adGroupId} (${keywords.length} бр.)`,
      });
    },
  },

  {
    name: "add_negative_keywords",
    description:
      "Добавя негативни ключови думи на ниво кампания или ad group. " +
      "Основният инструмент срещу разхищаващи search terms.",
    inputSchema: {
      type: "object",
      properties: {
        customerId: CUSTOMER_ID,
        level: { type: "string", enum: ["campaign", "ad_group"] },
        parentId: { type: "string", description: "ID на кампанията или ad group-а." },
        keywords: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              matchType: { type: "string", enum: MATCH_TYPES },
            },
            required: ["text", "matchType"],
          },
        },
        dryRun: DRY_RUN,
      },
      required: ["customerId", "level", "parentId", "keywords"],
    },
    handler: async ({ customerId, level, parentId, keywords, dryRun = false }) => {
      const operations = keywords.map((k) =>
        level === "campaign"
          ? {
              campaignCriterionOperation: {
                create: {
                  campaign: campaignRn(customerId, parentId),
                  negative: true,
                  keyword: { text: k.text, matchType: k.matchType },
                },
              },
            }
          : {
              adGroupCriterionOperation: {
                create: {
                  adGroup: adGroupRn(customerId, parentId),
                  negative: true,
                  keyword: { text: k.text, matchType: k.matchType },
                },
              },
            }
      );
      return applyMutate(customerId, operations, {
        validateOnly: dryRun,
        label: `негативни думи → ${level} ${parentId} (${keywords.length} бр.)`,
      });
    },
  },

  {
    name: "create_responsive_search_ad",
    description:
      "Създава Responsive Search Ad в ad group. Google иска 3–15 заглавия (макс. 30 знака) " +
      "и 2–4 описания (макс. 90 знака). По подразбиране рекламата се създава PAUSED.",
    inputSchema: {
      type: "object",
      properties: {
        customerId: CUSTOMER_ID,
        adGroupId: { type: "string" },
        finalUrl: { type: "string" },
        headlines: { type: "array", minItems: 3, maxItems: 15, items: { type: "string" } },
        descriptions: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" } },
        path1: { type: "string", description: "Display path сегмент 1 (макс. 15 знака)." },
        path2: { type: "string", description: "Display path сегмент 2 (макс. 15 знака)." },
        status: { type: "string", enum: ["ENABLED", "PAUSED"], description: "По подразбиране PAUSED." },
        dryRun: DRY_RUN,
      },
      required: ["customerId", "adGroupId", "finalUrl", "headlines", "descriptions"],
    },
    handler: async ({
      customerId,
      adGroupId,
      finalUrl,
      headlines,
      descriptions,
      path1,
      path2,
      status = "PAUSED",
      dryRun = false,
    }) => {
      const tooLong = [
        ...headlines.filter((h) => h.length > 30).map((h) => `заглавие "${h}" (${h.length} знака, макс. 30)`),
        ...descriptions.filter((d) => d.length > 90).map((d) => `описание "${d}" (${d.length} знака, макс. 90)`),
      ];
      if (tooLong.length) throw new Error(`Твърде дълъг текст:\n- ${tooLong.join("\n- ")}`);

      return applyMutate(
        customerId,
        [
          {
            adGroupAdOperation: {
              create: {
                adGroup: adGroupRn(customerId, adGroupId),
                status,
                ad: {
                  finalUrls: [finalUrl],
                  responsiveSearchAd: {
                    headlines: headlines.map((text) => ({ text })),
                    descriptions: descriptions.map((text) => ({ text })),
                    ...(path1 ? { path1 } : {}),
                    ...(path2 ? { path2 } : {}),
                  },
                },
              },
            },
          },
        ],
        { validateOnly: dryRun, label: `нова RSA в ad group ${adGroupId}` }
      );
    },
  },
];
