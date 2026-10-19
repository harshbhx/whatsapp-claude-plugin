// Delivery and read receipts for the messages this server's tools send, and
// the urgent-watch entries `reply` appends for an outside escalation script.
// server.ts connects to WhatsApp on import, so how a receipt event is read,
// merged and pruned, and what a watch entry looks like, are decided here,
// where that is testable on its own; server.ts only feeds events in and
// writes the two files.
//
// receipts.json (an object keyed by message id):
//   { "<id>": { chat_id, sent_at, delivered_at, read_at, read_by } }
// urgent-watch.json (an array, shared with the watcher that escalates):
//   [{ message_id, chat_id, preview, sent_at, escalate_after_min, escalated }]
// Every time is an ISO-8601 UTC string.

export interface ReceiptRecord {
  chat_id: string;
  sent_at: string;
  delivered_at: string | null;
  read_at: string | null;
  /** Whose read receipt arrived: the recipient in a DM, each member in a group. */
  read_by: string[];
}

export interface UrgentWatchEntry {
  message_id: string;
  chat_id: string;
  preview: string;
  sent_at: string;
  escalate_after_min: number;
  escalated: boolean;
}

/** A receipt worth recording. `at` is epoch ms; `by` the reader's jid. */
export interface ReceiptEvent {
  kind: "delivered" | "read";
  at: number;
  by?: string;
}

export type ReceiptState = "sent" | "delivered" | "read";

export const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// A ceiling on top of the 7 days, for an account that sends thousands a day:
// the file is rewritten whole on every save.
export const RECEIPT_STORE_MAX = 5000;
export const URGENT_MAX_MINUTES = 1440;
export const PREVIEW_CHARS = 120;

// proto.WebMessageInfo.Status, as Baileys puts it on a messages.update.
// ERROR (0), PENDING (1) and SERVER_ACK (2) say nothing sent_at does not.
const DELIVERY_ACK = 3;
const READ = 4;
const PLAYED = 5;

/** A receipt timestamp in seconds (number, numeric string or protobuf Long)
 *  as epoch ms, or `fallbackMs` when there is none. */
export function receiptTime(raw: unknown, fallbackMs: number): number {
  let seconds: number;
  if (
    raw !== null &&
    typeof raw === "object" &&
    typeof (raw as { toNumber?: unknown }).toNumber === "function"
  )
    seconds = (raw as { toNumber(): number }).toNumber();
  else if (typeof raw === "number" || typeof raw === "string")
    seconds = Number(raw);
  else return fallbackMs;
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallbackMs;
}

/** A DM receipt: the `status` Baileys sets on messages.update (with the
 *  receipt's own time in messageTimestamp). PLAYED is a voice note listened
 *  to, which is a read. `by` is whoever sent the receipt. */
export function statusEvent(
  status: unknown,
  timestamp: unknown,
  by: string | undefined,
  nowMs: number,
): ReceiptEvent | undefined {
  const at = receiptTime(timestamp, nowMs);
  if (status === DELIVERY_ACK) return { kind: "delivered", at };
  if (status === READ || status === PLAYED)
    return by ? { kind: "read", at, by } : { kind: "read", at };
  return undefined;
}

/** A group member's receipt from message-receipt.update. Baileys puts a
 *  read or a play on readTimestamp and a delivery on receiptTimestamp. */
export function userReceiptEvent(
  receipt: {
    userJid?: string | null;
    receiptTimestamp?: unknown;
    readTimestamp?: unknown;
    playedTimestamp?: unknown;
  },
  nowMs: number,
): ReceiptEvent | undefined {
  const by = receipt.userJid || undefined;
  const withBy = (e: ReceiptEvent): ReceiptEvent => (by ? { ...e, by } : e);
  const readRaw = receipt.readTimestamp ?? receipt.playedTimestamp;
  if (readRaw != null && receiptTime(readRaw, 0) > 0)
    return withBy({ kind: "read", at: receiptTime(readRaw, nowMs) });
  if (receipt.receiptTimestamp != null)
    return withBy({
      kind: "delivered",
      at: receiptTime(receipt.receiptTimestamp, nowMs),
    });
  return undefined;
}

/** A Cloud API webhook status. It carries no time of its own here, so the
 *  time it arrived stands in. "sent" and "failed" are not receipts. */
export function cloudStatusEvent(
  status: string,
  recipient: string,
  nowMs: number,
): ReceiptEvent | undefined {
  if (status === "delivered") return { kind: "delivered", at: nowMs };
  if (status === "read")
    return recipient
      ? { kind: "read", at: nowMs, by: recipient }
      : { kind: "read", at: nowMs };
  return undefined;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Merges one receipt into a record. Times only ever move earlier (the first
 *  delivery, the first read), never back to unset; a read implies delivery,
 *  so a read that arrives alone fills delivered_at too. A receipt stamped
 *  before sent_at (the phone's clock against this machine's) is clamped to
 *  it. Returns whether anything changed. */
export function applyReceipt(
  record: ReceiptRecord,
  event: ReceiptEvent,
): boolean {
  const sentMs = Date.parse(record.sent_at);
  const atMs = Number.isFinite(sentMs) ? Math.max(event.at, sentMs) : event.at;
  const at = iso(atMs);
  const isEarlier = (current: string | null) =>
    current === null || !(Date.parse(current) <= atMs);
  let changed = false;
  if (isEarlier(record.delivered_at)) {
    record.delivered_at = at;
    changed = true;
  }
  if (event.kind !== "read") return changed;
  if (isEarlier(record.read_at)) {
    record.read_at = at;
    changed = true;
  }
  if (event.by && !record.read_by.includes(event.by)) {
    record.read_by.push(event.by);
    changed = true;
  }
  return changed;
}

export function receiptState(record: ReceiptRecord): ReceiptState {
  if (record.read_at || record.read_by.length) return "read";
  if (record.delivered_at) return "delivered";
  return "sent";
}

const isTime = (v: unknown): v is string =>
  typeof v === "string" && Number.isFinite(Date.parse(v));

function asRecord(raw: unknown): ReceiptRecord | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.chat_id !== "string" || !r.chat_id || !isTime(r.sent_at))
    return undefined;
  const timeOrNull = (v: unknown) => (isTime(v) ? v : null);
  return {
    chat_id: r.chat_id,
    sent_at: r.sent_at,
    delivered_at: timeOrNull(r.delivered_at),
    read_at: timeOrNull(r.read_at),
    read_by: Array.isArray(r.read_by)
      ? [
          ...new Set(
            r.read_by.filter((j): j is string => typeof j === "string" && !!j),
          ),
        ]
      : [],
  };
}

/** Drops records sent at or before `cutoffMs`, then the oldest past `max`.
 *  Returns whether anything was dropped. */
export function pruneReceipts(
  store: Map<string, ReceiptRecord>,
  cutoffMs: number,
  max = RECEIPT_STORE_MAX,
): boolean {
  const before = store.size;
  for (const [id, r] of store)
    if (Date.parse(r.sent_at) <= cutoffMs) store.delete(id);
  if (store.size > max) {
    const byAge = [...store].sort(
      ([, a], [, b]) => Date.parse(a.sent_at) - Date.parse(b.sent_at),
    );
    for (const [id] of byAge.slice(0, store.size - max)) store.delete(id);
  }
  return store.size !== before;
}

/** Reads receipts.json. Never throws: a damaged file or entry costs the
 *  receipts it held, not the server. A Map, so a message id is never looked
 *  up on an object's prototype. */
export function parseReceiptStore(
  text: string,
  cutoffMs: number,
): Map<string, ReceiptRecord> {
  const store = new Map<string, ReceiptRecord>();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return store;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return store;
  for (const [id, value] of Object.entries(raw)) {
    const record = asRecord(value);
    if (id && record) store.set(id, record);
  }
  pruneReceipts(store, cutoffMs);
  return store;
}

export function serializeReceiptStore(
  store: Map<string, ReceiptRecord>,
): string {
  return JSON.stringify(Object.fromEntries(store)) + "\n";
}

/** Starts tracking a message a tool just sent. An id already tracked is left
 *  alone, so a receipt that raced ahead is not wiped. Returns whether the
 *  store changed. */
export function addReceipt(
  store: Map<string, ReceiptRecord>,
  id: string,
  chatId: string,
  sentAtMs: number,
  cutoffMs: number,
): boolean {
  if (!id || !chatId || store.has(id)) return false;
  store.set(id, {
    chat_id: chatId,
    sent_at: iso(sentAtMs),
    delivered_at: null,
    read_at: null,
    read_by: [],
  });
  pruneReceipts(store, cutoffMs);
  return true;
}

/** message_status's answer. `readers` are display names for read_by, in
 *  the same order. */
export function describeReceipt(
  id: string,
  record: ReceiptRecord,
  readers: string[],
): string {
  const lines = [
    `${receiptState(record)} (id: ${id})`,
    `sent: ${record.sent_at}`,
    `delivered: ${record.delivered_at ?? "not yet"}`,
    `read: ${record.read_at ?? "not yet"}`,
  ];
  if (readers.length) lines.push(`read by: ${readers.join(", ")}`);
  return lines.join("\n");
}

/** reply's urgent_minutes, checked before anything is sent: undefined when
 *  it was not passed, a whole number of minutes from 1 to 1440 otherwise.
 *  A numeric string is accepted, since some clients send numbers that way. */
export function urgentMinutes(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n =
    typeof raw === "string" && /^\s*\d+\s*$/.test(raw) ? Number(raw) : raw;
  if (
    typeof n !== "number" ||
    !Number.isInteger(n) ||
    n < 1 ||
    n > URGENT_MAX_MINUTES
  )
    throw new Error(
      `urgent_minutes must be a whole number of minutes from 1 to ${URGENT_MAX_MINUTES}`,
    );
  return n;
}

/** The entry an urgent reply adds to urgent-watch.json. The preview is cut
 *  by character, not UTF-16 unit, so an emoji is never split in half. */
export function watchEntry(opts: {
  messageId: string;
  chatId: string;
  text: string;
  sentAtMs: number;
  minutes: number;
}): UrgentWatchEntry {
  return {
    message_id: opts.messageId,
    chat_id: opts.chatId,
    preview: Array.from(opts.text).slice(0, PREVIEW_CHARS).join(""),
    sent_at: iso(opts.sentAtMs),
    escalate_after_min: opts.minutes,
    escalated: false,
  };
}

/** urgent-watch.json with `entry` appended. Everything already in the list is
 *  kept exactly as the watcher left it, and an entry for the same message id
 *  is not added twice. `discarded` is true when the old text was neither
 *  empty nor a JSON array, so the caller can keep a copy before replacing it. */
export function appendWatchEntry(
  text: string,
  entry: UrgentWatchEntry,
): { json: string; discarded: boolean } {
  let list: unknown[] = [];
  let discarded = false;
  if (text.trim()) {
    try {
      const raw: unknown = JSON.parse(text);
      if (Array.isArray(raw)) list = raw;
      else discarded = true;
    } catch {
      discarded = true;
    }
  }
  const present = list.some(
    (e) =>
      e !== null &&
      typeof e === "object" &&
      (e as { message_id?: unknown }).message_id === entry.message_id,
  );
  if (!present) list.push(entry);
  return { json: JSON.stringify(list, null, 1) + "\n", discarded };
}
