/**
 * What this agent prints, per locale: the runner's words for it, the lines an
 * execution reads as, and the one message per outcome the person receives.
 * Every key exists in both entries (`npm run check`).
 */
import type { LocaleTable } from "@codespar/agent-core";
import type { KitStrings } from "@codespar/agent-runtime";

const pt = {
  mandateWord: "mandato",
  receiptWord: "registro",
  intro: 'Você é a pessoa que quer recarregar a própria conta. Diga algo ("quero colocar R$ 1 na minha conta"). Ctrl+D ou "sair" encerra.',
  prompt: "você> ",
  approveQuestion: "  [operador] Aprovar o pedido desta puxada ao banco? [s/N] ",
  uncertainDispatch: "  desfecho desconhecido no banco; rode `npm run resume` para reconciliar (nunca repita a puxada)",
  notAuthorized: "o mandato não autoriza",
  waitingForPayer: (round: number) => `  aguardando a aprovação no banco... (${round} consultas)`,

  pullOf: (account: string, alias: string) => `recarga de ${account} (${alias})`,
  pullLine: (amount: string) => `puxada: ${amount}`,
  authorizationLine: "autorização no banco",
  endToEndLine: "Pix end-to-end",

  toldSettled: (endToEndId: string) => `Pronto, o dinheiro caiu na sua conta. Comprovante do Pix (end-to-end): ${endToEndId}`,
  toldExpired: "O link do banco expirou antes da aprovação. Nada foi puxado. Quer que eu mande outro?",
  toldCancelled: "A autorização foi recusada no banco. Nada foi puxado.",
  toldFailed: (reason: string | undefined) => `Não consegui fazer a puxada (${reason ?? "falha no banco"}). Nada foi puxado.`,
  toldDenied: (reason: string | undefined) => `Não posso pedir essa puxada (${reason ?? "recusado"}).`,
  toldUndecided: (state: string) => `O pedido expirou sem decisão (${state}). Nada foi puxado.`,

  bankName: "Banco de Testes (sandbox do Iniciador)",
};

export const STRINGS: LocaleTable<typeof pt & KitStrings> = {
  "pt-BR": pt,
  en: {
    mandateWord: "mandate",
    receiptWord: "record",
    intro: 'You are the person topping up their own account. Say something ("I want to add R$1 to my account"). Ctrl+D or "exit" ends.',
    prompt: "you> ",
    approveQuestion: "  [operator] Approve asking the bank for this pull? [y/N] ",
    uncertainDispatch: "  outcome unknown at the bank; run `npm run resume` to reconcile (never repeat the pull)",
    notAuthorized: "the mandate does not authorize it",
    waitingForPayer: (round) => `  waiting for the approval at the bank... (${round} looks)`,

    pullOf: (account, alias) => `top-up of ${account} (${alias})`,
    pullLine: (amount) => `pull: ${amount}`,
    authorizationLine: "authorization at the bank",
    endToEndLine: "Pix end-to-end",

    toldSettled: (endToEndId) => `Done, the money is in your account. Pix receipt (end-to-end): ${endToEndId}`,
    toldExpired: "The bank's link expired before it was approved. Nothing was pulled. Shall I send another one?",
    toldCancelled: "The authorization was declined at the bank. Nothing was pulled.",
    toldFailed: (reason) => `I could not make the pull (${reason ?? "bank failure"}). Nothing was pulled.`,
    toldDenied: (reason) => `I cannot ask for that pull (${reason ?? "refused"}).`,
    toldUndecided: (state) => `The request expired without a decision (${state}). Nothing was pulled.`,

    bankName: "Banco de Testes (Iniciador sandbox)",
  },
};
