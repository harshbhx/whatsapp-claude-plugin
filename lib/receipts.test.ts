import { describe, expect, test } from "bun:test";
import { proto } from "@whiskeysockets/baileys";
import {
  addReceipt,
  appendWatchEntry,
  applyReceipt,
  cloudStatusEvent,
  describeReceipt,
  parseReceiptStore,
  pruneReceipts,
  receiptState,
  receiptTime,
  RECEIPT_TTL_MS,
  serializeReceiptStore,
  statusEvent,
  urgentMinutes,
  userReceiptEvent,
  watchEntry,
  type ReceiptRecord,
  type UrgentWatchEntry,
} from "./receipts";

const DM = "15550001111@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const ALICE = "15550002222@s.whatsapp.net";
const BOB = "15550003333@s.whatsapp.net";

const T0 = Date.parse("2026-10-18T10:00:00.000Z");
const sec = (ms: number) => Math.floor(ms / 1000);
const Status = proto.WebMessageInfo.Status;

function record(over: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    chat_id: DM,
    sent_at: new Date(T0).toISOString(),
    delivered_at: null,
    read_at: null,
    read_by: [],
    ...over,
  };
}

describe("receiptTime", () => {
  test("seconds become ms, from a number, a numeric string or a Long", () => {
    expect(receiptTime(sec(T0), 0)).toBe(T0);
    expect(receiptTime(String(sec(T0)), 0)).toBe(T0);
    expect(receiptTime({ toNumber: () => sec(T0) }, 0)).toBe(T0);
  });

  test("missing, zero or junk falls back", () => {
    for (const raw of [undefined, null, 0, -5, "x", {}, NaN])
      expect(receiptTime(raw, 42)).toBe(42);
  });
});

describe("statusEvent (DM, messages.update)", () => {
  test("DELIVERY_ACK is a delivery at the receipt's own time", () => {
    expect(statusEvent(Status.DELIVERY_ACK, sec(T0) + 5, DM, 0)).toEqual({
      kind: "delivered",
      at: T0 + 5000,
    });
  });

  test("READ and PLAYED are reads by whoever sent the receipt", () => {
    for (const s of [Status.READ, Status.PLAYED])
      expect(statusEvent(s, sec(T0) + 9, DM, 0)).toEqual({
        kind: "read",
        at: T0 + 9000,
        by: DM,
      });
  });

  test("no time on the update falls back to now", () => {
    expect(statusEvent(Status.READ, undefined, DM, T0)?.at).toBe(T0);
  });

  test("ERROR, PENDING, SERVER_ACK and non-status updates are not receipts", () => {
    for (const s of [
      Status.ERROR,
      Status.PENDING,
      Status.SERVER_ACK,
      undefined,
      null,
    ])
      expect(statusEvent(s, sec(T0), DM, T0)).toBeUndefined();
  });
});

describe("userReceiptEvent (group, message-receipt.update)", () => {
  test("receiptTimestamp alone is a delivery to that member", () => {
    expect(
      userReceiptEvent({ userJid: ALICE, receiptTimestamp: sec(T0) }, 0),
    ).toEqual({ kind: "delivered", at: T0, by: ALICE });
  });

  test("readTimestamp (or playedTimestamp) is a read by that member", () => {
    expect(
      userReceiptEvent({ userJid: BOB, readTimestamp: sec(T0) + 60 }, 0),
    ).toEqual({ kind: "read", at: T0 + 60000, by: BOB });
    expect(
      userReceiptEvent({ userJid: BOB, playedTimestamp: sec(T0) + 61 }, 0),
    ).toEqual({ kind: "read", at: T0 + 61000, by: BOB });
  });

  test("a receipt with no timestamp at all is ignored", () => {
    expect(userReceiptEvent({ userJid: ALICE }, T0)).toBeUndefined();
  });
});

describe("cloudStatusEvent", () => {
  test("delivered and read map across, read naming the recipient", () => {
    expect(cloudStatusEvent("delivered", DM, T0)).toEqual({
      kind: "delivered",
      at: T0,
    });
    expect(cloudStatusEvent("read", DM, T0)).toEqual({
      kind: "read",
      at: T0,
      by: DM,
    });
  });

  test("sent and failed are not receipts", () => {
    expect(cloudStatusEvent("sent", DM, T0)).toBeUndefined();
    expect(cloudStatusEvent("failed", DM, T0)).toBeUndefined();
  });
});

describe("applyReceipt (status merging)", () => {
  test("sent -> delivered -> read", () => {
    const r = record();
    expect(receiptState(r)).toBe("sent");
    expect(applyReceipt(r, { kind: "delivered", at: T0 + 1000 })).toBe(true);
    expect(receiptState(r)).toBe("delivered");
    expect(r.delivered_at).toBe("2026-10-18T10:00:01.000Z");
    expect(applyReceipt(r, { kind: "read", at: T0 + 5000, by: DM })).toBe(true);
    expect(receiptState(r)).toBe("read");
    expect(r).toEqual(
      record({
        delivered_at: "2026-10-18T10:00:01.000Z",
        read_at: "2026-10-18T10:00:05.000Z",
        read_by: [DM],
      }),
    );
  });

  test("a read that arrives alone fills delivered_at too", () => {
    const r = record();
    applyReceipt(r, { kind: "read", at: T0 + 7000, by: DM });
    expect(r.delivered_at).toBe("2026-10-18T10:00:07.000Z");
    expect(r.read_at).toBe("2026-10-18T10:00:07.000Z");
  });

  test("a delivery after the read never moves anything back", () => {
    const r = record();
    applyReceipt(r, { kind: "read", at: T0 + 7000, by: DM });
    expect(applyReceipt(r, { kind: "delivered", at: T0 + 9000 })).toBe(false);
    expect(receiptState(r)).toBe("read");
    expect(r.delivered_at).toBe("2026-10-18T10:00:07.000Z");
  });

  test("the earliest time wins, whatever order receipts arrive in", () => {
    const r = record();
    applyReceipt(r, { kind: "delivered", at: T0 + 9000 });
    applyReceipt(r, { kind: "delivered", at: T0 + 2000 });
    expect(r.delivered_at).toBe("2026-10-18T10:00:02.000Z");
  });

  test("a repeated read changes nothing; a second group reader is added once", () => {
    const r = record({ chat_id: GROUP });
    applyReceipt(r, { kind: "read", at: T0 + 3000, by: ALICE });
    expect(applyReceipt(r, { kind: "read", at: T0 + 3000, by: ALICE })).toBe(
      false,
    );
    expect(applyReceipt(r, { kind: "read", at: T0 + 8000, by: BOB })).toBe(
      true,
    );
    expect(r.read_by).toEqual([ALICE, BOB]);
    // read_at stays the first reader's.
    expect(r.read_at).toBe("2026-10-18T10:00:03.000Z");
  });

  test("a receipt stamped before sent_at (clock skew) is clamped to sent_at", () => {
    const r = record();
    applyReceipt(r, { kind: "delivered", at: T0 - 4000 });
    expect(r.delivered_at).toBe(r.sent_at);
  });
});

describe("receipt store: parse, prune, serialize", () => {
  test("round-trips what it wrote", () => {
    const store = new Map<string, ReceiptRecord>();
    addReceipt(store, "A", DM, T0, T0 - RECEIPT_TTL_MS);
    applyReceipt(store.get("A")!, { kind: "read", at: T0 + 1000, by: DM });
    const text = serializeReceiptStore(store);
    expect(JSON.parse(text)).toEqual({
      A: {
        chat_id: DM,
        sent_at: "2026-10-18T10:00:00.000Z",
        delivered_at: "2026-10-18T10:00:01.000Z",
        read_at: "2026-10-18T10:00:01.000Z",
        read_by: [DM],
      },
    });
    expect(parseReceiptStore(text, T0 - RECEIPT_TTL_MS)).toEqual(store);
  });

  test("entries older than 7 days are pruned on read", () => {
    const old = new Date(T0 - RECEIPT_TTL_MS - 1).toISOString();
    const text = JSON.stringify({
      OLD: record({ sent_at: old }),
      NEW: record(),
    });
    const store = parseReceiptStore(text, T0 - RECEIPT_TTL_MS);
    expect([...store.keys()]).toEqual(["NEW"]);
  });

  test("pruneReceipts drops past the cutoff and caps to the newest", () => {
    const store = new Map<string, ReceiptRecord>();
    for (let i = 0; i < 5; i++)
      store.set(
        `m${i}`,
        record({ sent_at: new Date(T0 + i * 1000).toISOString() }),
      );
    expect(pruneReceipts(store, T0, 3)).toBe(true);
    // m0 is at the cutoff (dropped), then the oldest past 3 go.
    expect([...store.keys()]).toEqual(["m2", "m3", "m4"]);
    expect(pruneReceipts(store, T0, 3)).toBe(false);
  });

  test("damaged files and entries cost only themselves", () => {
    for (const text of ["", "not json", "[]", "null", "42"])
      expect(parseReceiptStore(text, 0).size).toBe(0);
    const store = parseReceiptStore(
      JSON.stringify({
        good: record({ read_by: [DM, DM, 7] as unknown as string[] }),
        noChat: { ...record(), chat_id: "" },
        badSent: { ...record(), sent_at: "yesterday" },
        notObject: "x",
        badTimes: { ...record(), delivered_at: "soon", read_at: 5 },
      }),
      0,
    );
    expect([...store.keys()]).toEqual(["good", "badTimes"]);
    expect(store.get("good")!.read_by).toEqual([DM]);
    expect(store.get("badTimes")!.delivered_at).toBeNull();
    expect(store.get("badTimes")!.read_at).toBeNull();
  });

  test("addReceipt never resets an id it already tracks", () => {
    const store = new Map<string, ReceiptRecord>();
    expect(addReceipt(store, "A", DM, T0, 0)).toBe(true);
    applyReceipt(store.get("A")!, { kind: "delivered", at: T0 + 1 });
    expect(addReceipt(store, "A", DM, T0 + 50, 0)).toBe(false);
    expect(store.get("A")!.delivered_at).not.toBeNull();
    expect(addReceipt(store, "", DM, T0, 0)).toBe(false);
  });

  test("a message id named after a prototype member is just a key", () => {
    const store = parseReceiptStore(
      JSON.stringify({ constructor: record(), toString: record() }),
      0,
    );
    expect(store.size).toBe(2);
    expect(new Map<string, ReceiptRecord>().get("constructor")).toBeUndefined();
  });
});

describe("describeReceipt", () => {
  test("names the state, every time and who read it", () => {
    const r = record({
      delivered_at: "2026-10-18T10:00:01.000Z",
      read_at: "2026-10-18T10:00:05.000Z",
      read_by: [ALICE, BOB],
    });
    expect(describeReceipt("ID1", r, ["Alice", "Bob"])).toBe(
      [
        "read (id: ID1)",
        "sent: 2026-10-18T10:00:00.000Z",
        "delivered: 2026-10-18T10:00:01.000Z",
        "read: 2026-10-18T10:00:05.000Z",
        "read by: Alice, Bob",
      ].join("\n"),
    );
  });

  test("says not yet for what has not happened", () => {
    expect(describeReceipt("ID2", record(), [])).toBe(
      [
        "sent (id: ID2)",
        "sent: 2026-10-18T10:00:00.000Z",
        "delivered: not yet",
        "read: not yet",
      ].join("\n"),
    );
  });
});

describe("urgentMinutes", () => {
  test("absent means not urgent", () => {
    expect(urgentMinutes(undefined)).toBeUndefined();
    expect(urgentMinutes(null)).toBeUndefined();
  });

  test("1 to 1440 whole minutes, also as a numeric string", () => {
    expect(urgentMinutes(1)).toBe(1);
    expect(urgentMinutes(1440)).toBe(1440);
    expect(urgentMinutes(" 15 ")).toBe(15);
  });

  test("anything else throws before a send", () => {
    for (const bad of [0, 1441, -3, 2.5, NaN, "abc", "", true, {}, [5]])
      expect(() => urgentMinutes(bad)).toThrow(/1 to 1440/);
  });
});

describe("watch entries", () => {
  const entry = (over: Partial<Parameters<typeof watchEntry>[0]> = {}) =>
    watchEntry({
      messageId: "3EB0AA",
      chatId: DM,
      text: "Server down, please check",
      sentAtMs: T0,
      minutes: 15,
      ...over,
    });

  test("has exactly the shape the watcher reads", () => {
    expect(entry()).toEqual({
      message_id: "3EB0AA",
      chat_id: DM,
      preview: "Server down, please check",
      sent_at: "2026-10-18T10:00:00.000Z",
      escalate_after_min: 15,
      escalated: false,
    });
  });

  test("preview is the first 120 characters, never half an emoji", () => {
    expect(entry({ text: "x".repeat(300) }).preview).toHaveLength(120);
    const emoji = "😀".repeat(130);
    const preview = entry({ text: emoji }).preview;
    expect(Array.from(preview)).toHaveLength(120);
    expect(preview).toBe("😀".repeat(120));
  });

  test("appending keeps what the watcher wrote, untouched", () => {
    const escalated = {
      ...entry({ messageId: "OLD" }),
      escalated: true,
      escalated_at: "2026-10-18T09:00:00Z",
    };
    const { json, discarded } = appendWatchEntry(
      JSON.stringify([escalated]),
      entry(),
    );
    expect(discarded).toBe(false);
    expect(JSON.parse(json)).toEqual([escalated, entry()]);
  });

  test("a missing or empty file starts a new list", () => {
    for (const text of ["", "  \n"]) {
      const { json, discarded } = appendWatchEntry(text, entry());
      expect(discarded).toBe(false);
      expect(JSON.parse(json)).toEqual([entry()]);
    }
  });

  test("the same message is never watched twice", () => {
    const once = appendWatchEntry("", entry()).json;
    expect(JSON.parse(appendWatchEntry(once, entry()).json)).toHaveLength(1);
  });

  test("a damaged file is reported so it can be kept aside", () => {
    for (const text of ["{oops", '{"a":1}', "7"]) {
      const { json, discarded } = appendWatchEntry(text, entry());
      expect(discarded).toBe(true);
      expect(JSON.parse(json) as UrgentWatchEntry[]).toEqual([entry()]);
    }
  });
});
