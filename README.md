# google-ads-mcp

Собствен MCP сървър към Google Ads API. Дава ти Google Ads директно в терминала през
Claude Code: питаш на човешки език, а сървърът превежда въпроса в GAQL заявка или в mutate
операция срещу реалния акаунт.

Заменя платените wrapper-и, които таксуват на „connected account". Тук цената е нула -
Google Ads API е безплатен, а **един MCC покрива всичките си дъщерни акаунти**.

Node, нула зависимости освен MCP SDK-то. Използва вградения `fetch` и REST-а на Google Ads
API, без protobuf библиотеката.

> **Инсталация: виж [SETUP.md](SETUP.md).** Там е целият процес от нула - Node, developer
> token, Google Cloud, OAuth, вързване към Claude Code и проверка, че работи.

---

## Инструменти (18)

### Четене

| Инструмент | За какво |
|---|---|
| `list_accounts` | Цялото дърво под MCC-то. Оттук вадиш `customerId`. |
| `run_gaql` | Произволна GAQL заявка. Основният read инструмент. |
| `run_gaql_multi` | До 20 заявки паралелно, може срещу различни акаунти. |
| `describe_fields` | Метаданни за GAQL полета - вместо да гадаеш имена. |
| `account_overview` | Готов одит на акаунт с едно извикване. |
| `change_history` | Историята от Google, включително ръчните промени в UI-я. |

### Писане

| Инструмент | За какво |
|---|---|
| `mutate` | Сурови операции, всякакъв ресурс. По подразбиране `validateOnly`. |
| `set_status` | Bulk pause/enable/remove на кампании, ad groups, реклами, думи. |
| `set_campaign_budget` | Дневен бюджет, с проверка за споделен бюджет. |
| `set_bid` | CPC бидове, bulk. |
| `add_keywords` | Позитивни думи в ad group. |
| `add_negative_keywords` | Негативни думи на ниво кампания или ad group. |
| `create_responsive_search_ad` | RSA, по подразбиране PAUSED. |

### Контрол

| Инструмент | За какво |
|---|---|
| `list_changes` | Локалният change log, с ID за връщане назад. |
| `undo_change` | Връща промяна назад от снимката ѝ. |
| `get_guardrails` / `set_guardrails` | Предпазните правила. |
| `check_connection` | Диагностика. |

---

## Безопасност

Всяко писане минава през `src/apply.js`: **guardrails → снимка на старите стойности →
mutate → запис в change log**.

**Guardrails** (`~/.google-ads-mcp/guardrails.json`):

```json
{
  "readOnlyAccounts": [],
  "blockedAccounts": [],
  "writeAllowlist": [],
  "maxBudgetIncreasePct": 50,
  "maxDailyBudget": null,
  "requireConfirmForRemove": true,
  "maxOperationsPerCall": 500
}
```

`writeAllowlist` е най-силният предпазител: ако не е празен, писане е позволено **само** в
изброените акаунти. Сложи един тестов акаунт, докато свикнеш, и всички останали са защитени.

**Undo** (`~/.google-ads-mcp/changes.jsonl`) - преди всеки update се снима старата стойност
на полетата от `updateMask`, за да може `undo_change` да я върне.

Две честни ограничения:

- **REMOVE е необратим.** Google Ads API няма un-remove. Затова `set_status` с `REMOVED`
  иска `confirm: true`, а по подразбиране се препоръчва `PAUSED`.
- **Полета, които не са четими през GAQL**, не могат да се снимат. Тогава промяната се
  записва в лога, но `list_changes` я маркира `undoable: false`.

---

## Поддръжка

**Версия на API-то.** По подразбиране `v24`. Google мина на месечен цикъл през 2026.
Всяка версия живее около година. Смяната е един ред в `~/.google-ads.env`:

```
GOOGLE_ADS_API_VERSION=v25
```

**Тест след промени:**

```bash
npm test        # MCP handshake, схеми, guardrails - не пипа мрежата
npm run doctor  # реална връзка към Google
```

## Файлове

```
google-ads-mcp/
  SETUP.md              инсталация от нула
  src/index.js          MCP сървър, регистрация на инструментите
  src/config.js         зареждане на ~/.google-ads.env
  src/auth.js           OAuth refresh + кеш на access token
  src/client.js         REST слой (searchStream, mutate, грешки)
  src/apply.js          guardrails → снимка → mutate → лог
  src/guardrails.js     предпазни правила
  src/changelog.js      change log и undo
  src/tools/            read.js · write.js · ops.js
  bin/oauth.js          еднократен OAuth flow
  bin/doctor.js         диагностика от терминала
  test/smoke.mjs        offline тест

~/.google-ads.env       креденшъли (chmod 600)
~/.google-ads-mcp/      guardrails.json · changes.jsonl
```
