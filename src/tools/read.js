import { gaql, gaqlParallel, listAccessibleCustomers, searchFields, customerCall } from "../client.js";
import { assertReadable } from "../guardrails.js";
import { loadConfig } from "../config.js";

const CUSTOMER_ID = {
  type: "string",
  description: "Google Ads customer ID (с или без тирета), напр. 123-456-7890 или 1234567890.",
};

const ACCOUNT_TREE_QUERY = `
  SELECT customer_client.id,
         customer_client.descriptive_name,
         customer_client.currency_code,
         customer_client.time_zone,
         customer_client.manager,
         customer_client.test_account,
         customer_client.status,
         customer_client.level
  FROM customer_client
  WHERE customer_client.status != 'CLOSED'
`;

export const readTools = [
  {
    name: "list_accounts",
    description:
      "Изброява всички Google Ads акаунти, до които има достъп — включително цялото дърво под MCC-то. " +
      "Това е замяната на 'connected accounts': един MCC покрива всичките си дъщерни акаунти без допълнителна такса. " +
      "Започвай оттук, за да намериш customerId за останалите инструменти.",
    inputSchema: {
      type: "object",
      properties: {
        managerId: {
          type: "string",
          description:
            "MCC, чието дърво да се изброи. По подразбиране GOOGLE_ADS_LOGIN_CUSTOMER_ID от конфига.",
        },
        includeManagers: {
          type: "boolean",
          description: "Да включва ли самите MCC-та в списъка (по подразбиране true).",
        },
      },
    },
    handler: async ({ managerId, includeManagers = true }) => {
      const cfg = loadConfig();
      // Без managerId обхождаме И конфигурираното MCC, И всички директно достъпни
      // акаунти — така се виждат и акаунтите извън MCC-то.
      const roots = managerId
        ? [String(managerId).replace(/\D/g, "")]
        : [
            ...new Set([
              ...(cfg.loginCustomerId ? [cfg.loginCustomerId] : []),
              ...(await listAccessibleCustomers()),
            ]),
          ];

      const accounts = [];
      const errors = [];

      for (const root of roots) {
        try {
          const { rows } = await gaql(root, ACCOUNT_TREE_QUERY, { loginCustomerId: root });
          for (const r of rows) {
            const c = r.customerClient ?? {};
            if (!includeManagers && c.manager) continue;
            accounts.push({
              customerId: c.id,
              name: c.descriptiveName,
              currency: c.currencyCode,
              timeZone: c.timeZone,
              isManager: !!c.manager,
              isTest: !!c.testAccount,
              status: c.status,
              level: c.level,
              underManager: root,
            });
          }
        } catch (e) {
          errors.push({ root, error: e.message });
        }
      }

      const seen = new Set();
      const unique = accounts.filter((a) =>
        seen.has(a.customerId) ? false : (seen.add(a.customerId), true)
      );

      return {
        totalAccounts: unique.length,
        clientAccounts: unique.filter((a) => !a.isManager).length,
        managers: unique.filter((a) => a.isManager).length,
        accounts: unique,
        ...(errors.length ? { errors } : {}),
      };
    },
  },

  {
    name: "run_gaql",
    description:
      "Изпълнява произволна GAQL заявка срещу един акаунт. Това е основният read инструмент — " +
      "покрива всякакви отчети, одити и диагностика (campaign, ad_group, keyword_view, search_term_view, " +
      "asset_group, change_event, geographic_view и т.н.). Хвърляй широка мрежа с първата заявка; " +
      "филтрирането после е безплатно.",
    inputSchema: {
      type: "object",
      properties: {
        customerId: CUSTOMER_ID,
        query: { type: "string", description: "GAQL заявката." },
        loginCustomerId: {
          type: "string",
          description:
            "MCC за хедъра login-customer-id, ако е различен от конфигурирания. " +
            "За акаунт ИЗВЪН конфигурираното MCC подай самия customerId и тук.",
        },
      },
      required: ["customerId", "query"],
    },
    handler: async ({ customerId, query, loginCustomerId }) => {
      const cid = assertReadable(customerId);
      return gaql(cid, query, { loginCustomerId });
    },
  },

  {
    name: "run_gaql_multi",
    description:
      "Пуска до 20 GAQL заявки паралелно — може срещу различни акаунти. Използвай за одити " +
      "(разход + search terms + quality score + change events наведнъж) или за сравнение " +
      "между клиенти в едно извикване. Провалена заявка не проваля останалите.",
    inputSchema: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Име на резултата в отговора." },
              customerId: CUSTOMER_ID,
              query: { type: "string" },
            },
            required: ["customerId", "query"],
          },
        },
        loginCustomerId: { type: "string" },
      },
      required: ["queries"],
    },
    handler: async ({ queries, loginCustomerId }) => {
      queries.forEach((q) => assertReadable(q.customerId));
      return gaqlParallel(queries, { loginCustomerId });
    },
  },

  {
    name: "describe_fields",
    description:
      "Метаданни за GAQL полета — кои полета са selectable/filterable за даден ресурс и какви enum " +
      "стойности приемат. Използвай, когато не си сигурен как се казва поле, вместо да гадаеш.",
    inputSchema: {
      type: "object",
      properties: {
        resource: {
          type: "string",
          description: "Име на ресурс или префикс, напр. 'campaign' или 'search_term_view'.",
        },
        field: { type: "string", description: "Точно име на поле, напр. 'campaign.status'." },
      },
    },
    handler: async ({ resource, field }) => {
      const where = field
        ? `WHERE name = '${field}'`
        : resource
          ? `WHERE name LIKE '${resource}.%'`
          : "";
      // GoogleAdsFieldService заявките нямат FROM клауза (и не приемат LIMIT).
      const query =
        "SELECT name, category, data_type, selectable, filterable, sortable, is_repeated, enum_values " +
        where;
      const results = await searchFields(query.trim());
      return { count: results.length, fields: results };
    },
  },

  {
    name: "account_overview",
    description:
      "Готов одит на един акаунт с едно извикване: разход и резултати по кампании за последните 30 дни, " +
      "структура, конверсионни действия, разхищаващи search terms и скорошни промени. " +
      "Отправна точка за 'как се справя акаунтът'.",
    inputSchema: {
      type: "object",
      properties: {
        customerId: CUSTOMER_ID,
        days: { type: "number", description: "Период в дни (по подразбиране 30)." },
      },
      required: ["customerId"],
    },
    handler: async ({ customerId, days = 30 }) => {
      const cid = assertReadable(customerId);
      const d = Math.min(Math.max(1, Math.round(days)), 365);
      const start = new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
      const end = new Date().toISOString().slice(0, 10);
      const range = `segments.date BETWEEN '${start}' AND '${end}'`;

      return gaqlParallel([
        {
          name: "account_totals",
          customerId: cid,
          query: `SELECT customer.descriptive_name, customer.currency_code, metrics.cost_micros,
                         metrics.impressions, metrics.clicks, metrics.conversions,
                         metrics.conversions_value, metrics.average_cpc
                  FROM customer WHERE ${range}`,
        },
        {
          name: "campaigns",
          customerId: cid,
          query: `SELECT campaign.id, campaign.name, campaign.status,
                         campaign.advertising_channel_type, campaign.bidding_strategy_type,
                         campaign_budget.amount_micros, metrics.cost_micros, metrics.impressions,
                         metrics.clicks, metrics.conversions, metrics.conversions_value,
                         metrics.search_impression_share
                  FROM campaign WHERE ${range} AND campaign.status != 'REMOVED'
                  ORDER BY metrics.cost_micros DESC LIMIT 100`,
        },
        {
          name: "conversion_actions",
          customerId: cid,
          query: `SELECT conversion_action.id, conversion_action.name, conversion_action.status,
                         conversion_action.type, conversion_action.category,
                         conversion_action.primary_for_goal, conversion_action.attribution_model_settings.attribution_model
                  FROM conversion_action WHERE conversion_action.status != 'REMOVED' LIMIT 100`,
        },
        {
          name: "wasted_search_terms",
          customerId: cid,
          query: `SELECT search_term_view.search_term, campaign.name, ad_group.name,
                         metrics.cost_micros, metrics.clicks, metrics.conversions
                  FROM search_term_view WHERE ${range} AND metrics.clicks > 1 AND metrics.conversions = 0
                  ORDER BY metrics.cost_micros DESC LIMIT 50`,
        },
        {
          name: "recent_changes",
          customerId: cid,
          query: `SELECT change_event.change_date_time, change_event.change_resource_type,
                         change_event.resource_change_operation, change_event.changed_fields,
                         change_event.user_email, change_event.client_type
                  FROM change_event WHERE change_event.change_date_time DURING LAST_14_DAYS
                  ORDER BY change_event.change_date_time DESC LIMIT 100`,
        },
      ]);
    },
  },

  {
    name: "keyword_ideas",
    description:
      "Keyword research през Keyword Planner (generateKeywordIdeas): обеми на търсене, конкуренция " +
      "и top-of-page бидове. Подай seed думи (до 20) и/или URL на страница. " +
      "По подразбиране география BG и език български.",
    inputSchema: {
      type: "object",
      properties: {
        customerId: CUSTOMER_ID,
        keywords: {
          type: "array",
          maxItems: 20,
          items: { type: "string" },
          description: "Seed ключови думи (макс. 20).",
        },
        url: { type: "string", description: "URL за идеи от съдържанието на страницата." },
        country: {
          type: "string",
          description: "BG, US, UK, DE, RO, GR или директно geo target ID. По подразбиране BG.",
        },
        language: {
          type: "string",
          description: "bg, en, de, ro, el или директно language ID. По подразбиране bg.",
        },
        limit: { type: "number", description: "Макс. брой идеи (по подразбиране 100, таван 1000)." },
      },
      required: ["customerId"],
    },
    handler: async ({ customerId, keywords, url, country = "BG", language = "bg", limit = 100 }) => {
      const cid = assertReadable(customerId);
      if (!keywords?.length && !url) {
        throw new Error("Подай поне едно от: keywords или url.");
      }

      const GEO = { BG: "2100", US: "2840", UK: "2826", DE: "2276", RO: "2642", GR: "2300" };
      const LANG = { bg: "1020", en: "1000", de: "1001", ro: "1032", el: "1022" };
      const geoId = GEO[country.toUpperCase()] ?? String(country).replace(/\D/g, "");
      const langId = LANG[language.toLowerCase()] ?? String(language).replace(/\D/g, "");
      if (!geoId) throw new Error(`Непозната държава "${country}". Ползвай код от списъка или geo target ID.`);
      if (!langId) throw new Error(`Непознат език "${language}". Ползвай код от списъка или language ID.`);

      const seed =
        keywords?.length && url
          ? { keywordAndUrlSeed: { keywords, url } }
          : keywords?.length
            ? { keywordSeed: { keywords } }
            : { urlSeed: { url } };

      const res = await customerCall(cid, "generateKeywordIdeas", {
        language: `languageConstants/${langId}`,
        geoTargetConstants: [`geoTargetConstants/${geoId}`],
        includeAdultKeywords: false,
        pageSize: Math.min(Math.max(1, limit), 1000),
        ...seed,
      });

      const ideas = (res.results ?? [])
        .map((r) => {
          const m = r.keywordIdeaMetrics ?? {};
          return {
            keyword: r.text,
            avgMonthlySearches: Number(m.avgMonthlySearches ?? 0),
            competition: m.competition,
            lowTopOfPageBid: m.lowTopOfPageBidMicros ? Number(m.lowTopOfPageBidMicros) / 1e6 : null,
            highTopOfPageBid: m.highTopOfPageBidMicros ? Number(m.highTopOfPageBidMicros) / 1e6 : null,
          };
        })
        .sort((a, b) => b.avgMonthlySearches - a.avgMonthlySearches);

      return { customerId: cid, country, language, count: ideas.length, ideas };
    },
  },

  {
    name: "change_history",
    description:
      "История на промените в акаунта от самия Google (change_event) — кой какво е пипал, " +
      "през кой интерфейс и кои полета е сменил. Покрива и промени, направени извън този MCP " +
      "(ръчно в UI, от Google's auto-apply, от друг инструмент). Максимум 30 дни назад.",
    inputSchema: {
      type: "object",
      properties: {
        customerId: CUSTOMER_ID,
        days: { type: "number", description: "Дни назад, макс. 29 (по подразбиране 14)." },
        limit: { type: "number", description: "Брой записи (по подразбиране 200)." },
      },
      required: ["customerId"],
    },
    handler: async ({ customerId, days = 14, limit = 200 }) => {
      const cid = assertReadable(customerId);
      // change_event позволява прозорец само до 30 дни; 29 + утрешната граница = точно в лимита.
      const d = Math.min(Math.max(1, days), 29);
      const since = new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
      const until = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

      return gaql(
        cid,
        `SELECT change_event.change_date_time, change_event.change_resource_type,
                change_event.change_resource_name, change_event.resource_change_operation,
                change_event.changed_fields, change_event.user_email, change_event.client_type,
                change_event.campaign, change_event.ad_group
         FROM change_event
         WHERE change_event.change_date_time >= '${since}'
           AND change_event.change_date_time <= '${until}'
         ORDER BY change_event.change_date_time DESC
         LIMIT ${Math.min(limit, 10000)}`
      );
    },
  },
];
