/**
 * What this agent prints, per locale: the runner's words for it and the
 * consent the titular reads before signing. Every key exists in both entries
 * (`npm run check`). The answers are read the same whatever the locale: the
 * approval question and the consent question take s, sim, y and yes.
 *
 * What goes to the API is not here: the consent's display name and intent
 * note are part of the consent the API records, not lines on this terminal.
 */
import { formatBRL, type LocaleTable } from "@codespar/agent-core";
import type { KitStrings } from "@codespar/agent-runtime";

const pt = {
  mandateWord: "mandato",
  receiptWord: "recibo",
  intro: 'Diga o que pagar ("pague a escola de outubro"). Ctrl+D ou "sair" encerra.',
  prompt: "> ",
  approveQuestion: "  Aprovar este pagamento? [s/N] ",
  uncertainDispatch: "  desfecho desconhecido no trilho; rode `npm run resume` para reconciliar (nunca repita o pagamento)",
  notAuthorized: "o mandato não autoriza",

  consentHeader: "O mandato ainda não existe. Este é o consentimento que o titular assina (sandbox):",
  consentReplaces: (mandateId: string, state: string, file: string) => `Já existe um mandato em ${file}: ${mandateId}, ${state}. Este é o consentimento de um mandato novo, que passa a ser o do arquivo (sandbox):`,
  consentPreviousActive: "ativo na API",
  consentPreviousPaused: "pausado na API",
  consentPreviousRevoked: "revogado na API",
  consentPreviousExpired: "expirado",
  consentPreviousUnknown: "com estado que a API não respondeu",
  consentAgent: (agentId: string, purpose: string) => `  agente: ${agentId}    finalidade: ${purpose}`,
  consentCaps: (perTx: number, window: number, lifetime: number) => `  teto por pagamento: ${formatBRL(perTx, "pt-BR")}    teto do mês: ${formatBRL(window, "pt-BR")}    vitalício: ${formatBRL(lifetime, "pt-BR")}`,
  consentPayee: (name: string, alias: string) => `  favorecido: ${name} (${alias})`,
  consentValidity: (tokenExpiresAt: string) => `  validade: 1 ano    (o token do consentimento vale até ${tokenExpiresAt})`,
  consentValidityDays: (days: number, tokenExpiresAt: string) => `  validade: ${days} dias    (o token do consentimento vale até ${tokenExpiresAt})`,
  consentExecutor: (label: string, executor: string, choice: string, provider: string | null = null) =>
    choice === "codespar_simulator"
      ? `  executor: ${label} (${executor}): sem KYC, sem conta bancária, nenhum provedor chamado; o pagamento de teste não move dinheiro`
      : `  executor: ${label} (${executor}${provider ? `, provedor ${provider}, resolvido pela CodeSpar` : ""}): a conta de sandbox do provedor ligada a este consumidor; sem dinheiro real, mesmo quando o sandbox confirma o pagamento`,
  consentExecutorNotConfirmed: (choice: string, answered: string | null) =>
    `A API não confirmou o executor pedido (${choice}; respondeu ${answered ?? "nenhum"}). Nada foi assinado nem salvo. O executor explícito chega com a API da ent#1983; até lá, o pagamento de teste sob pix-consent é recusado.`,
  consentExecutorSignedOther: (mandateId: string, confirmed: string, signed: string | null) =>
    `A API assinou o mandato ${mandateId} com executor ${signed ?? "nenhum"}, não com ${confirmed}, que ela confirmou antes da pergunta. Ele não foi salvo em .codespar/mandate.json, e nenhum pagamento sai dele por este kit.`,
  consentSandboxNotReady: "O sandbox do provedor deste projeto não está pronto: nada foi assinado e nada foi trocado pelo simulador.",
  consentSandboxMissing: (gap: string) => `  falta: ${gap}`,
  consentSandboxNextStep: (step: string) => `  próximo passo: ${step}`,
  consentSandboxAlternative: (executor: string) =>
    `  alternativa: um consentimento com executor ${executor} paga no simulador da CodeSpar (sem KYC, sem conta bancária); é uma escolha sua, não um retorno automático: sem BILLS_CONSUMER_ID e BILLS_PROOF_RECEIVER_KEY, \`npm run consent -- --yes\` pede o simulador.`,
  consentExecutorSigned: (label: string) => `Executor do mandato: ${label}.`,
  consentExecutorGuidance: (code: string, message: string) => `Aviso da API (${code}): ${message}`,
  consentQuestion: "  Você é o titular e autoriza este mandato? [s/N] ",
  consentSigned: (mandateId: string, consumerId: string) => `Mandato assinado: ${mandateId} (consumidor ${consumerId}).`,
  consentFunded: (amount: number, account: string, depositId: string) => `Sandbox creditado: ${formatBRL(amount, "pt-BR")} em ${account} (deposit ${depositId}).`,
  consentNotFunded: (code: string) => `Sandbox não creditado (${code}); o gasto de teste sob pix-consent não depende disso.`,
  consentNotFundedIntegrated: "Nada creditado: na prova integrada, a conta Celcoin do consumidor já foi abastecida pelo operador, uma vez, dentro do teto da prova.",
  consentSaved: (mandateId: string) => `mandato ${mandateId} salvo em .codespar/mandate.json`,
};

export const STRINGS: LocaleTable<typeof pt & KitStrings> = {
  "pt-BR": pt,
  en: {
    mandateWord: "mandate",
    receiptWord: "receipt",
    intro: 'Say what to pay ("pay the school for October"). Ctrl+D or "exit" ends.',
    prompt: "> ",
    approveQuestion: "  Approve this payment? [y/N] ",
    uncertainDispatch: "  outcome unknown on the rail; run `npm run resume` to reconcile (never repeat the payment)",
    notAuthorized: "the mandate does not authorize it",

    consentHeader: "The mandate does not exist yet. This is the consent the account holder signs (sandbox):",
    consentReplaces: (mandateId, state, file) => `${file} already holds a mandate: ${mandateId}, ${state}. This is the consent for a new one, which becomes the one in the file (sandbox):`,
    consentPreviousActive: "active on the API",
    consentPreviousPaused: "paused on the API",
    consentPreviousRevoked: "revoked on the API",
    consentPreviousExpired: "expired",
    consentPreviousUnknown: "in a state the API did not answer",
    consentAgent: (agentId, purpose) => `  agent: ${agentId}    purpose: ${purpose}`,
    consentCaps: (perTx, window, lifetime) => `  cap per payment: ${formatBRL(perTx, "en")}    cap per month: ${formatBRL(window, "en")}    lifetime: ${formatBRL(lifetime, "en")}`,
    consentPayee: (name, alias) => `  payee: ${name} (${alias})`,
    consentValidity: (tokenExpiresAt) => `  valid for: 1 year    (the consent token is valid until ${tokenExpiresAt})`,
    consentValidityDays: (days, tokenExpiresAt) => `  valid for: ${days} days    (the consent token is valid until ${tokenExpiresAt})`,
    consentExecutor: (label, executor, choice, provider = null) =>
      choice === "codespar_simulator"
        ? `  executor: ${label} (${executor}): no KYC, no bank account, no provider called; the test payment moves no money`
        : `  executor: ${label} (${executor}${provider ? `, provider ${provider}, resolved by CodeSpar` : ""}): the provider's sandbox account bound to this consumer; no real money, even when the sandbox confirms the payment`,
    consentExecutorNotConfirmed: (choice, answered) =>
      `The API did not confirm the executor asked for (${choice}; it answered ${answered ?? "none"}). Nothing was signed or saved. The explicit executor comes with the API of ent#1983; until then, the test payment under pix-consent is refused.`,
    consentExecutorSignedOther: (mandateId, confirmed, signed) =>
      `The API signed mandate ${mandateId} with executor ${signed ?? "none"}, not ${confirmed}, which it confirmed before the question. It was not saved to .codespar/mandate.json, and this kit pays nothing from it.`,
    consentSandboxNotReady: "This project's provider sandbox is not ready: nothing was signed and nothing was switched to the simulator.",
    consentSandboxMissing: (gap) => `  missing: ${gap}`,
    consentSandboxNextStep: (step) => `  next step: ${step}`,
    consentSandboxAlternative: (executor) =>
      `  alternative: a consent with executor ${executor} pays on the CodeSpar simulator (no KYC, no bank account); it is your choice, not an automatic fallback: without BILLS_CONSUMER_ID and BILLS_PROOF_RECEIVER_KEY, \`npm run consent -- --yes\` asks for the simulator.`,
    consentExecutorSigned: (label) => `Mandate executor: ${label}.`,
    consentExecutorGuidance: (code, message) => `API notice (${code}): ${message}`,
    consentQuestion: "  Are you the account holder, and do you authorize this mandate? [y/N] ",
    consentSigned: (mandateId, consumerId) => `Mandate signed: ${mandateId} (consumer ${consumerId}).`,
    consentFunded: (amount, account, depositId) => `Sandbox credited: ${formatBRL(amount, "en")} to ${account} (deposit ${depositId}).`,
    consentNotFunded: (code) => `Sandbox not credited (${code}); the test spend under pix-consent does not depend on it.`,
    consentNotFundedIntegrated: "Nothing credited: in the integrated proof, the consumer's Celcoin account was funded once by the operator, within the proof's ceiling.",
    consentSaved: (mandateId) => `mandate ${mandateId} saved to .codespar/mandate.json`,
  },
};
