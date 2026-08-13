#!/usr/bin/env node
/** Проверка от терминала, че всичко е вързано както трябва. */
import { opsTools } from "../src/tools/ops.js";
import { readTools } from "../src/tools/read.js";

const check = opsTools.find((t) => t.name === "check_connection");
const listAccounts = readTools.find((t) => t.name === "list_accounts");

console.log("\n── Конфигурация ──────────────────────────────\n");
let status;
try {
  status = await check.handler({});
} catch (e) {
  console.error(`✗ ${e.message}\n`);
  process.exit(1);
}

for (const [k, v] of Object.entries(status)) {
  if (k === "accessibleCustomers") continue;
  console.log(`  ${k.padEnd(20)} ${typeof v === "object" ? JSON.stringify(v) : v}`);
}

if (!status.ok) {
  console.error(`\n✗ ${status.apiError ?? status.oauth ?? "Нещо не е наред."}\n`);
  process.exit(1);
}

console.log("\n── Достъпни акаунти ──────────────────────────\n");
try {
  const result = await listAccounts.handler({});
  console.log(
    `  ${result.totalAccounts} общо · ${result.clientAccounts} клиентски · ${result.managers} MCC\n`
  );
  for (const a of result.accounts) {
    const tag = a.isManager ? "[MCC]" : "     ";
    console.log(
      `  ${tag} ${String(a.customerId).padEnd(12)} ${String(a.name ?? "").slice(0, 38).padEnd(40)} ${a.currency ?? ""} ${a.status ?? ""}`
    );
  }
  if (result.errors) {
    console.log("\n  Грешки:");
    for (const e of result.errors) console.log(`   - ${e.root}: ${e.error}`);
  }
  console.log(
    `\n✓ Готово. ${result.clientAccounts} клиентски акаунта, без такса за акаунт.\n`
  );
} catch (e) {
  console.error(`\n✗ Изброяването се провали:\n${e.message}\n`);
  process.exit(1);
}
