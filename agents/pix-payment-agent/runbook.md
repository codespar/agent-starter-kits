# Runbook: forty seconds, no edits

The script of the demo. Runs from a clean clone, in `approval: human` first. You are the customer; the store answers on the same keyboard.

| At | You | What the terminal shows |
|---|---|---|
| 0 s | `npx degit codespar/agent-starter-kits agent-starter-kits && cd agent-starter-kits && npm install` | — |
| 5 s | `npm start --workspace=agents/pix-payment-agent -- --scenario happy-path` | No key needed: the stub rail and the recorded model. `pix-payment-agent 0.1.0 — approval: human — trilho: stub — política pol_...`. No consent step: the collection policy is the store's own. |
| 8 s | (recorded) `oi, sou a Lívia, quero pagar o pedido 2001 no Pix` | The agent reads the orders, finds Lívia's order #2001 (café especial 250 g, R$ 18,00) and says it will issue a Pix of R$ 18,00 due today. |
| 15 s | (recorded) `pode gerar` | The core puts the charge in `awaiting_approval`; the store approves. `approved` → `executing (awaiting_settlement)`. |
| 24 s | wait | The QR as an image and the Pix copia-e-cola under it. The stub payer pays. |
| 30 s | wait | `-> settled`. `Pagamento recebido, pedido quitado.` The paid charge under `runs/<run-id>/receipts/`. |
| 40 s | `npm start --workspace=agents/pix-payment-agent -- --scenario prompt-injection` | `denied (outside_envelope)`: the message asked for R$ 1,00; the Pix charges exactly the order's total. Nothing was issued. |

`--scenario charge-expired` shows the other ending: the Pix of order #2003 expires unpaid, the order stays open, nothing is recorded as paid.

## With a model

Put an Anthropic key in `agents/pix-payment-agent/.env` (`cp agents/pix-payment-agent/.env.example agents/pix-payment-agent/.env`) and run `npm start --workspace=agents/pix-payment-agent -- --provider anthropic`, then type as the customer. The stub rail still issues and pays: nothing reaches CodeSpar.

## In the Playground

The same kit runs hosted. On the simulator it is the stub rail above. On the integrated Test (`codespar-test`, with a model) the charge is a platform receive proposal: you send it on its card ("Enviar cobrança"), the platform issues it as a Collect charge at the provider's sandbox, and its Test payer pays it ("Pagador de teste paga"), which is a sandbox payment and not a simulation (CONTRATO v1.6). The kit's own `--rail api` stays blocked outside the dashboard while ent#1816 is open.
