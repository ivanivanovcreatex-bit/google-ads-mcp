#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { readTools } from "./tools/read.js";
import { writeTools } from "./tools/write.js";
import { opsTools } from "./tools/ops.js";

const TOOLS = [...readTools, ...writeTools, ...opsTools];
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

const INSTRUCTIONS = `
Собствен MCP към Google Ads API. Един MCC покрива всичките си дъщерни акаунти — няма
лимит на "connected accounts".

Как да работиш с него:

1. Не знаеш customerId? → list_accounts. Връща цялото дърво под MCC-то.
2. Всякакъв въпрос за данни (одит, отчет, диагностика, "как върви акаунтът") → run_gaql
   или run_gaql_multi. Хвърляй широка мрежа с първата заявка; филтрирай в главата си после.
   Не знаеш как се казва поле → describe_fields, не гадай.
3. Бърз преглед на непознат акаунт → account_overview.
4. Промени → специализираните инструменти (set_status, set_campaign_budget, set_bid,
   add_keywords, add_negative_keywords, create_responsive_search_ad). За всичко останало →
   mutate със сурови операции.
5. Всяко писане минава през guardrails и се записва в локален change log със снимка на
   старите стойности. Сгрешена промяна → list_changes → undo_change.

Важни правила:
- Преди рискова промяна (бюджети, масово спиране, изтриване) покажи на потребителя какво
  ще стане и изчакай потвърждение. Инструментът mutate по подразбиране е validateOnly.
- REMOVE е необратим в Google Ads API. Предпочитай PAUSED пред REMOVED.
- Парите са в micros в самото API (1 000 000 = 1 единица валута), но специализираните
  инструменти приемат нормални суми.
`.trim();

const server = new Server(
  { name: "google-ads-mcp", version: "1.0.0" },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = BY_NAME.get(request.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text", text: `Непознат инструмент: ${request.params.name}` }],
    };
  }

  try {
    const result = await tool.handler(request.params.arguments ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: error?.message ?? String(error) }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
