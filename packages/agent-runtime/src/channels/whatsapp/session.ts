/**
 * WhatsApp's own rule, which is not ours and which the simulator obeys
 * anyway: outside the 24 hours that follow the person's last message, a
 * business may only send a TEMPLATE that Meta approved in advance. Inside
 * the window it may write freely.
 *
 * The simulator enforces it for the reason a simulator exists: something that
 * only fails against the real provider is something you discover in
 * production. A collections agent hits this constantly — the debtor answers
 * on Tuesday, the charge is paid on Friday, and "recebemos, acordo quitado"
 * falls outside the window.
 *
 * Template APPROVAL is a STUB and cannot be anything else from here: a
 * template is registered in a Meta Business account, reviewed by Meta, and
 * given a status we have no way to read without that account. What this holds
 * is the LOCAL registry — the names the agent declares it uses — so sending
 * one that was never declared is refused here instead of 400-ing at Meta.
 * Whether Meta approved it is the developer's to check, and the README says
 * so.
 */

export const SESSION_WINDOW_SECONDS = 24 * 60 * 60;

export interface SessionState {
  /** Unix seconds of the last message the PERSON sent, on the provider's clock. */
  lastInboundAt?: number | undefined;
}

export class SessionWindow {
  private lastInboundAt: number | undefined;

  constructor(
    private readonly templates: ReadonlySet<string>,
    initial?: SessionState,
  ) {
    this.lastInboundAt = initial?.lastInboundAt;
  }

  observeInbound(timestamp: number): void {
    if (this.lastInboundAt === undefined || timestamp > this.lastInboundAt) this.lastInboundAt = timestamp;
  }

  /** Seconds left before free-form messages stop being allowed; 0 when the window is shut or was never opened. */
  remainingSeconds(now: Date): number {
    if (this.lastInboundAt === undefined) return 0;
    return Math.max(0, this.lastInboundAt + SESSION_WINDOW_SECONDS - Math.floor(now.getTime() / 1000));
  }

  open(now: Date): boolean {
    return this.remainingSeconds(now) > 0;
  }

  knows(template: string): boolean {
    return this.templates.has(template);
  }
}
