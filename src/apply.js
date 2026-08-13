import { mutate } from "./client.js";
import { assertWritable } from "./guardrails.js";
import { snapshotBefore, recordChange } from "./changelog.js";

function resourceFromOpKey(opKey) {
  return opKey
    .replace(/Operation$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function describeOp(op) {
  const opKey = Object.keys(op)[0];
  const inner = op[opKey] ?? {};
  const resource = resourceFromOpKey(opKey);

  if (inner.update) {
    return {
      resource,
      action: "update",
      resourceName: inner.update.resourceName,
      updateMask: inner.updateMask,
    };
  }
  if (inner.remove) {
    return { resource, action: "remove", resourceName: inner.remove };
  }
  return { resource, action: "create" };
}

/**
 * Единствената точка, през която минава всяко писане:
 * guardrails → снимка на старите стойности → mutate → запис в change log.
 *
 * Това е местният еквивалент на "change history & one-call undo".
 */
export async function applyMutate(
  customerId,
  operations,
  { validateOnly = false, partialFailure = false, confirm = false, label, loginCustomerId } = {}
) {
  const cid = assertWritable(customerId, operations, { confirm });

  // Dry run — нищо не се записва нито в Google, нито в лога.
  if (validateOnly) {
    const response = await mutate(cid, operations, { validateOnly: true, partialFailure, loginCustomerId });
    return {
      dryRun: true,
      valid: true,
      message: "Валидацията мина. Операциите са коректни, но НЕ са приложени. Пусни пак с validateOnly: false.",
      operations,
      response,
    };
  }

  const described = operations.map(describeOp);

  // Снимаме старите стойности само за update-и (create няма какво да върне, remove е необратим).
  const items = [];
  for (const d of described) {
    if (d.action === "update" && d.resourceName && d.updateMask) {
      const paths = String(d.updateMask).split(",").map((s) => s.trim());
      items.push({
        ...d,
        before: await snapshotBefore(cid, d.resourceName, paths, { loginCustomerId }),
      });
    } else {
      items.push({ ...d });
    }
  }

  const response = await mutate(cid, operations, { validateOnly: false, partialFailure, loginCustomerId });

  // Отговорът е позиционен: response[i] отговаря на operations[i]. При partialFailure
  // провалените операции връщат празен запис — затова индексираме директно, без компактиране.
  const responses = response?.mutateOperationResponses ?? [];
  items.forEach((item, i) => {
    if (item.action !== "create") return;
    const r = responses[i];
    const rn = r ? Object.values(r)[0]?.resourceName : undefined;
    if (rn) item.createdResourceName = rn;
  });
  const created = items
    .filter((i) => i.action === "create" && i.createdResourceName)
    .map((i) => i.createdResourceName);

  const record = recordChange({
    customerId: cid,
    label: label ?? "mutate",
    items,
    operationCount: operations.length,
  });

  return {
    dryRun: false,
    changeId: record.id,
    applied: operations.length,
    resourceNames: created,
    undoHint: `За връщане назад: undo_change с changeId "${record.id}"`,
    response,
  };
}

export const MICROS = 1_000_000;

export function toMicros(amount) {
  return Math.round(Number(amount) * MICROS);
}

export function fromMicros(micros) {
  return Number(micros ?? 0) / MICROS;
}
