/**
 * How a payee key is masked wherever it is written for somebody else to read:
 * the proof bundle on the way in (#116), `inspect` on the way out. One
 * function masks a key; one redactor masks the keys inside free text.
 */

/** `escola@exemplo.com.br` -> `es***@exemplo.com.br`; `+5511999998888` -> `+55***8888`; a UUID keeps its first and last 4; a key of 4 characters or fewer keeps none. */
export function maskPayee(payee: string): string {
  if (payee === "*") return payee;
  const at = payee.indexOf("@");
  if (at > 0) return `${payee.slice(0, Math.min(2, at))}***${payee.slice(at)}`;
  if (payee.length <= 4) return "***";
  if (payee.length <= 8) return `${payee.slice(0, 2)}***`;
  return `${payee.slice(0, 4)}***${payee.slice(-4)}`;
}

/**
 * A key shorter than this, and not an e-mail, is never searched for inside
 * free text: `12300` is also a piece of `R$ 123000`, and replacing it there
 * would rewrite an amount and still say nothing about the key. It is masked
 * in its `payee` fields like any other.
 */
export const MIN_PROSE_KEY_LENGTH = 10;

/**
 * The shapes of a Pix key, found in free text whether or not the key was ever
 * handed over as a payee: a bundle reopened in another process (`approve`,
 * `execute`, `poll-whatsapp`) has not seen the mandate, and an allowlist of
 * `*` names no key at all. An e-mail, a `+` phone, a CPF or CNPJ written with
 * or without its punctuation, and an EVP (a UUID). None of them matches a
 * masked key, so a value already masked passes through unchanged, and none
 * matches inside a longer word or id (`exe_<uuid>`, `sha256:<hex>`).
 */
const KEY_SHAPES: readonly RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  /(?<![\w+])\+\d{10,15}(?!\d)/g,
  /(?<![\w.\/-])\d{3}\.\d{3}\.\d{3}-\d{2}(?![\w-])/g,
  /(?<![\w.\/-])\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}(?![\w-])/g,
  /(?<![\w.\/:-])(?:\d{14}|\d{11})(?![\w.\/-])/g,
  /(?<![\w-])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![\w-])/g,
];

/**
 * A key also turns up inside free text: an escalation detail names the payee
 * it escalated on, a refusal names the one it refused. Every key in
 * `rawPayees` long enough to search for is replaced by its mask wherever it
 * appears, longest first, or a key that is a prefix of another masks it
 * twice; then every Pix-shaped key left is masked by its shape. Idempotent: a
 * masked value comes back as it went in.
 */
export function redactorFor(rawPayees: Iterable<string>): (value: string | null) => string | null {
  const pairs = [...new Set([...rawPayees].filter((p) => p !== "*" && (p.length >= MIN_PROSE_KEY_LENGTH || p.indexOf("@") > 0)))]
    .sort((a, b) => b.length - a.length)
    .map((raw) => [raw, maskPayee(raw)] as const)
    .filter(([raw, masked]) => raw !== masked);
  return (value) => {
    if (value === null) return null;
    let out = value;
    for (const [raw, masked] of pairs) out = out.split(raw).join(masked);
    for (const shape of KEY_SHAPES) out = out.replace(shape, maskPayee);
    return out;
  };
}
