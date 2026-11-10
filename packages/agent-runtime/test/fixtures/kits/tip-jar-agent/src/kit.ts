/**
 * A compatible kit no host names: the shared defaults, one read tool and one
 * payment tool. The conformance suite and the hosted channel run it exactly as
 * they run the kits under `agents/`.
 */
import { defaultKit, defineAgent } from "@codespar/agent-runtime";
import type { ToolHandler } from "@codespar/agent-core";

const listJars: ToolHandler = async (_input, ctx) => ({ jars: ctx.engine.mandate.beneficiaries.map((b) => ({ alias: b.alias, name: b.name })) });

const pay: ToolHandler = async (input, ctx) => {
  const payee = String(input["payee"] ?? "");
  const amount = Number(input["amount_minor"]);
  const draft = await ctx.engine.draft({ items: [{ payee, amount, description: "tip" }] });
  if (!draft.ok) {
    ctx.onNotRun?.({ ref: payee, why: "refused", detail: draft.reason });
    return { status: "refused", reason: draft.reason };
  }
  const execution = await ctx.onExecution(draft.execution);
  return { status: execution.state, execution_id: execution.id, ...(execution.reason ? { reason: execution.reason } : {}) };
};

export const agent = defineAgent(import.meta.url, { ...defaultKit, handlers: () => ({ list_jars: listJars, codespar_pay: pay }) });
