// "typing…" and "recording audio…" in a chat while the agent works on it.
//
// WhatsApp clears a chat-state (composing / recording) by itself about 10
// seconds after the last one it received, so a single update at pickup shows
// "typing…" for a moment and then nothing while the agent spends minutes on
// the answer. TypingIndicator re-sends the state on an interval until the
// agent replies to that chat, or until a cap runs out so a message the agent
// never answers does not leave "typing…" up forever. Timers and the send are
// injected, so the rules are testable without server.ts's connect-on-import
// side effects.

export type PresenceState = "composing" | "recording" | "paused";

// Under WhatsApp's ~10s expiry, so the state never lapses between refreshes.
export const TYPING_REFRESH_MS = 8_000;
export const DEFAULT_TYPING_MAX_MINUTES = 10;
export const MAX_TYPING_MAX_MINUTES = 60;

/** WHATSAPP_TYPING_MAX_MINUTES: how long "typing…" may stay up for one chat.
 *  Unset or not a number -> the 10-minute default; 0 (or less) -> 0, which
 *  turns the kept-up indicator off; above 60 -> 60. `note` says what was done
 *  with a value that was not used as given, for diag.log. */
export function parseTypingMaxMinutes(raw: string | undefined): {
  ms: number;
  note?: string;
} {
  const fallback = DEFAULT_TYPING_MAX_MINUTES * 60_000;
  if (raw === undefined || raw.trim() === "") return { ms: fallback };
  const minutes = Number(raw.trim());
  if (!Number.isFinite(minutes))
    return {
      ms: fallback,
      note: `WHATSAPP_TYPING_MAX_MINUTES=${JSON.stringify(raw)} is not a number; using ${DEFAULT_TYPING_MAX_MINUTES}`,
    };
  if (minutes <= 0) return { ms: 0 };
  if (minutes > MAX_TYPING_MAX_MINUTES)
    return {
      ms: MAX_TYPING_MAX_MINUTES * 60_000,
      note: `WHATSAPP_TYPING_MAX_MINUTES=${raw.trim()} is above ${MAX_TYPING_MAX_MINUTES}; using ${MAX_TYPING_MAX_MINUTES}`,
    };
  return { ms: Math.round(minutes * 60_000) };
}

export interface PresenceDeps {
  /** Fire-and-forget: a failed presence update must never fail anything. */
  send(chat: string, state: PresenceState): void;
  now(): number;
  /** Runs fn every ms; returns the function that stops it. */
  every(fn: () => void, ms: number): () => void;
  /** Two spellings of one chat (a DM's @lid and phone forms) map to one key,
   *  so the reply that ends "typing…" finds the loop the inbound started. */
  keyOf?(chat: string): string;
}

type Active = {
  jid: string;
  state: "composing" | "recording";
  since: number;
  cancel: () => void;
};

export class TypingIndicator {
  private readonly active = new Map<string, Active>();
  private readonly keyOf: (chat: string) => string;

  constructor(
    private readonly deps: PresenceDeps,
    private readonly opts: { refreshMs: number; maxMs: number },
  ) {
    this.keyOf = deps.keyOf ?? ((chat) => chat);
  }

  /** An inbound message from this chat was handed to the agent. */
  start(chat: string): void {
    this.set(chat, "composing");
  }

  /** Shows `state` in the chat and keeps it up until stop() or the cap. A
   *  repeat call switches the state and restarts the cap. With the cap at 0
   *  the state is sent once and WhatsApp clears it by itself. */
  set(chat: string, state: PresenceState): void {
    if (state === "paused") return this.stop(chat, true);
    this.deps.send(chat, state);
    if (this.opts.maxMs <= 0) return;
    const key = this.keyOf(chat);
    const now = this.deps.now();
    const existing = this.active.get(key);
    if (existing) {
      existing.jid = chat;
      existing.state = state;
      existing.since = now;
      return;
    }
    const cancel = this.deps.every(() => this.tick(key), this.opts.refreshMs);
    this.active.set(key, { jid: chat, state, since: now, cancel });
  }

  /** The agent answered this chat (or gave up): clear the indicator. Sends
   *  "paused" only when one was up, unless `force` (a manual request). */
  stop(chat: string, force = false): void {
    const key = this.keyOf(chat);
    const entry = this.active.get(key);
    if (entry) {
      entry.cancel();
      this.active.delete(key);
      this.deps.send(entry.jid, "paused");
    } else if (force) {
      this.deps.send(chat, "paused");
    }
  }

  isActive(chat: string): boolean {
    return this.active.has(this.keyOf(chat));
  }

  private tick(key: string): void {
    const entry = this.active.get(key);
    if (!entry) return;
    if (this.deps.now() - entry.since >= this.opts.maxMs) {
      this.stop(entry.jid);
      return;
    }
    this.deps.send(entry.jid, entry.state);
  }
}
