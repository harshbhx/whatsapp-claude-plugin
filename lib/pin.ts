// What the pin_message tool sends. server.ts connects to WhatsApp on import,
// so the duration -> seconds rule and the shape of the pin content live here,
// where they are testable on their own; the handler only resolves the key.

import type { WAMessageKey } from "@whiskeysockets/baileys";

// WhatsApp offers exactly these three pin lengths; Baileys types `time` as
// the same three numbers, and any other value is not a pin WhatsApp shows.
export const PIN_DURATIONS = {
  "24h": 86_400,
  "7d": 604_800,
  "30d": 2_592_000,
} as const;

export type PinDuration = keyof typeof PIN_DURATIONS;
export type PinSeconds = (typeof PIN_DURATIONS)[PinDuration];

export const DEFAULT_PIN_DURATION: PinDuration = "7d";

// proto.PinInChat.Type: PIN_FOR_ALL = 1, UNPIN_FOR_ALL = 2.
const PIN_FOR_ALL = 1;
const UNPIN_FOR_ALL = 2;

export type PinContent =
  | { pin: WAMessageKey; type: typeof PIN_FOR_ALL; time: PinSeconds }
  | { pin: WAMessageKey; type: typeof UNPIN_FOR_ALL };

// Omitted means the default. Anything else that is not one of the three is
// an error rather than a silent fallback: Baileys turns a missing `time`
// into 24h, so a typo like "1w" would otherwise pin for a day without a word.
export function pinSeconds(duration?: unknown): PinSeconds {
  if (duration === undefined || duration === null)
    return PIN_DURATIONS[DEFAULT_PIN_DURATION];
  if (typeof duration === "string" && Object.hasOwn(PIN_DURATIONS, duration))
    return PIN_DURATIONS[duration as PinDuration];
  throw new Error(
    `duration must be one of ${Object.keys(PIN_DURATIONS).join(", ")} (got ${JSON.stringify(duration)})`,
  );
}

// Unpinning carries no time (Baileys sends 0 for it), so a duration passed
// alongside unpin is ignored rather than validated.
export function pinContent(
  key: WAMessageKey,
  opts: { duration?: unknown; unpin?: boolean } = {},
): PinContent {
  if (opts.unpin) return { pin: key, type: UNPIN_FOR_ALL };
  return { pin: key, type: PIN_FOR_ALL, time: pinSeconds(opts.duration) };
}
