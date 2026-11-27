/**
 * What this agent prints, per locale: the runner's words for it, the lines an execution reads as, the one message per
 * outcome the customer receives, and the refusal details the order policy writes. Every key exists in both entries (`npm
 * run check`). The reason CODES next to the details (`outside_envelope`) are machine words, the same in every locale.
 */
import type { LocaleTable } from "@codespar/agent-core";
import type { KitStrings } from "@codespar/agent-runtime";

const pt = {
  mandateWord: "política",
  receiptWord: "registro",
  intro: 'Você é a cliente. Diga algo ("oi, quero pagar o pedido 2001 no Pix"). Ctrl+D ou "sair" encerra.',
  prompt: "cliente> ",
  approveQuestion: "  [loja] Aprovar a emissão desta cobrança Pix? [s/N] ",
  uncertainDispatch: "  desfecho desconhecido no trilho; rode `npm run resume` para reconciliar (nunca repita a emissão)",
  notAuthorized: "a política não autoriza",
  waitingForPayer: (round: number) => `  aguardando o pagamento... (${round} consultas)`,

  orderOf: (customer: string, alias: string) => `pedido de ${customer} (${alias})`,
  amountLine: (amount: string, due: string) => `Pix de ${amount}, vence ${due}`,
  chargeWord: "cobrança",

  toldSettled: (chargeIds: string) => `Pagamento recebido, pedido quitado. Obrigado! (${chargeIds})`,
  toldExpired: "O Pix venceu sem pagamento. Se quiser, gero um novo para o mesmo pedido.",
  toldCancelled: "A cobrança foi cancelada. Nada foi pago.",
  toldAmbiguous: "A cobrança deste pedido já foi emitida e estamos conferindo a situação dela. Não pague de novo; te aviso assim que estiver conferida.",
  toldFailed: (reason: string | undefined) => `Não consegui gerar o Pix (${reason ?? "falha no trilho"}). Nada foi cobrado.`,
  toldDenied: (reason: string | undefined) => `Não posso gerar esse Pix (${reason ?? "recusado"}).`,
  toldUndecided: (state: string) => `A proposta expirou sem decisão (${state}).`,

  statusPaid: "pago",
  statusIssued: "Pix emitido, aguardando pagamento",
  statusUnreconciled: "cobrança emitida, em conferência: não emitir outra",
  statusOpen: "em aberto",

  gateOneOrder: (count: number) => `${count} itens; um Pix cobre um pedido inteiro, num pagamento só`,
  gateNoOrder: "nenhum pedido em aberto para este cliente",
  gateAmount: (amount: number, total: number, order: string) => `valor ${amount} diferente do total ${total} do pedido ${order}; o Pix cobra exatamente o total do pedido`,
};

export const STRINGS: LocaleTable<typeof pt & KitStrings> = {
  "pt-BR": pt,
  en: {
    mandateWord: "policy",
    receiptWord: "record",
    intro: 'You are the customer. Say something ("hi, I want to pay order 2001 by Pix"). Ctrl+D or "exit" ends.',
    prompt: "customer> ",
    approveQuestion: "  [store] Approve issuing this Pix charge? [y/N] ",
    uncertainDispatch: "  outcome unknown on the rail; run `npm run resume` to reconcile (never repeat the issuance)",
    notAuthorized: "the policy does not authorize it",
    waitingForPayer: (round) => `  waiting for the payment... (${round} looks)`,

    orderOf: (customer, alias) => `order of ${customer} (${alias})`,
    amountLine: (amount, due) => `Pix of ${amount}, due ${due}`,
    chargeWord: "charge",

    toldSettled: (chargeIds) => `Payment received, the order is settled. Thank you! (${chargeIds})`,
    toldExpired: "The Pix expired unpaid. If you like, I can issue a new one for the same order.",
    toldCancelled: "The charge was cancelled. Nothing was paid.",
    toldAmbiguous: "The charge for this order was already issued and we are checking where it stands. Do not pay again; I will let you know as soon as it is checked.",
    toldFailed: (reason) => `I could not issue the Pix (${reason ?? "rail failure"}). Nothing was charged.`,
    toldDenied: (reason) => `I cannot issue that Pix (${reason ?? "refused"}).`,
    toldUndecided: (state) => `The proposal expired without a decision (${state}).`,

    statusPaid: "paid",
    statusIssued: "Pix issued, awaiting payment",
    statusUnreconciled: "charge issued, under review: do not issue another",
    statusOpen: "open",

    gateOneOrder: (count) => `${count} items; one Pix covers one whole order, in one payment`,
    gateNoOrder: "no open order for this customer",
    gateAmount: (amount, total, order) => `amount ${amount} differs from the total ${total} of order ${order}; the Pix charges exactly the order's total`,
  },
};
