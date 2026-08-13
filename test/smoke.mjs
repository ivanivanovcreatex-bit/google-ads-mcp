import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

// спрямо самия файл, за да върви на всяка машина, а не само на тази, на която е писан
const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  env: { ...process.env, GOOGLE_ADS_ENV_FILE: "/nonexistent-on-purpose.env" },
});

const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`✓ handshake ok — ${tools.length} инструмента\n`);
for (const t of tools) {
  const req = t.inputSchema?.required ?? [];
  console.log(`  ${t.name.padEnd(28)} required: ${req.join(", ") || "—"}`);
}

// Всеки инструмент трябва да има валиден object schema.
const bad = tools.filter((t) => t.inputSchema?.type !== "object" || !t.description);
console.log(`\n${bad.length ? "✗ невалидни схеми: " + bad.map((t) => t.name).join(", ") : "✓ всички схеми са валидни"}`);

// Без креденшъли: грешката трябва да е ясна, не stack trace.
const res = await client.callTool({ name: "check_connection", arguments: {} });
const text = res.content[0].text;
console.log(`\n✓ check_connection без конфиг → ${res.isError ? "isError" : "ok"}`);
console.log(text.split("\n").slice(0, 6).map((l) => "    " + l).join("\n"));

// Guardrail: REMOVE без confirm трябва да се блокира ПРЕДИ да стигне до мрежата.
const guard = await client.callTool({
  name: "mutate",
  arguments: {
    customerId: "123-456-7890",
    mutateOperations: [{ campaignOperation: { remove: "customers/1234567890/campaigns/1" } }],
    validateOnly: false,
  },
});
console.log(`\n✓ REMOVE без confirm → ${guard.isError ? "блокирано" : "ПРОПУСНАТО (бъг!)"}`);
console.log(`    ${guard.content[0].text.split("\n")[0]}`);

await client.close();
