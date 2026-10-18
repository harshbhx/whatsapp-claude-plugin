import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { aesEncryptGCM, hmacSign, proto } from "@whiskeysockets/baileys";
import {
  addPoll,
  candidatePairs,
  decryptVote,
  optionHash,
  parsePollStore,
  pickedOptions,
  pollSpec,
  pollTally,
  recordVote,
  serializePollStore,
  voteText,
  type PollRecord,
} from "./polls";

const ME = "15550000001@s.whatsapp.net";
const ME_LID = "111111111111111@lid";
const VOTER = "15550000002@s.whatsapp.net";
const VOTER_LID = "222222222222222@lid";

// What a voter's phone does: seal the picked options' hashes with a key
// derived from the poll's secret and the creator/voter jids as it sees them.
function sealVote(
  picked: string[],
  ctx: { pollId: string; creator: string; voter: string; secret: Buffer },
): proto.Message.IPollEncValue {
  const sign = Buffer.concat([
    Buffer.from(ctx.pollId),
    Buffer.from(ctx.creator),
    Buffer.from(ctx.voter),
    Buffer.from("Poll Vote"),
    new Uint8Array([1]),
  ]);
  const key = hmacSign(sign, hmacSign(ctx.secret, new Uint8Array(32)));
  const iv = randomBytes(12);
  const plain = proto.Message.PollVoteMessage.encode({
    selectedOptions: picked.map(optionHash),
  }).finish();
  return {
    encPayload: aesEncryptGCM(
      plain,
      key,
      iv,
      Buffer.from(`${ctx.pollId}\u0000${ctx.voter}`),
    ),
    encIv: iv,
  };
}

function poll(overrides: Partial<PollRecord> = {}): PollRecord {
  return {
    id: "3EB0POLL",
    chat_id: "120363000000000001@g.us",
    question: "Ship it?",
    options: ["Yes", "No", "Later"],
    multiple: false,
    secret: randomBytes(32).toString("base64"),
    ts: 1_000_000,
    votes: {},
    ...overrides,
  };
}

describe("pollSpec", () => {
  test("single choice by default, multiple when asked", () => {
    expect(pollSpec("Lunch?", ["Pizza", "Sushi"], undefined)).toEqual({
      name: "Lunch?",
      values: ["Pizza", "Sushi"],
      selectableCount: 1,
    });
    expect(pollSpec("Lunch?", ["Pizza", "Sushi"], true).selectableCount).toBe(
      0,
    );
    expect(pollSpec("Lunch?", ["Pizza", "Sushi"], false).selectableCount).toBe(
      1,
    );
  });

  test("trims the question and every option", () => {
    expect(pollSpec("  Lunch? ", [" Pizza", "Sushi  "], false)).toMatchObject({
      name: "Lunch?",
      values: ["Pizza", "Sushi"],
    });
  });

  test("needs 2 to 12 options", () => {
    expect(() => pollSpec("Q", ["only"], false)).toThrow("2 to 12 options");
    const thirteen = Array.from({ length: 13 }, (_, i) => `o${i}`);
    expect(() => pollSpec("Q", thirteen, false)).toThrow("got 13");
    expect(pollSpec("Q", thirteen.slice(0, 12), false).values).toHaveLength(12);
  });

  test("refuses duplicate options, which a vote could not tell apart", () => {
    expect(() => pollSpec("Q", ["Yes", " Yes "], false)).toThrow("unique");
  });

  test("refuses a missing question, blank or non-string options", () => {
    expect(() => pollSpec("  ", ["a", "b"], false)).toThrow("question");
    expect(() => pollSpec(undefined, ["a", "b"], false)).toThrow("question");
    expect(() => pollSpec("Q", ["a", "  "], false)).toThrow("some text");
    expect(() => pollSpec("Q", ["a", 2], false)).toThrow("some text");
    expect(() => pollSpec("Q", "a,b", false)).toThrow("array");
  });

  test("enforces WhatsApp's length limits", () => {
    expect(() => pollSpec("x".repeat(256), ["a", "b"], false)).toThrow("255");
    expect(() => pollSpec("Q", ["a", "x".repeat(101)], false)).toThrow("100");
  });

  test("multiple must be a boolean when given", () => {
    expect(() => pollSpec("Q", ["a", "b"], "yes")).toThrow("true or false");
  });
});

describe("poll store", () => {
  test("round-trips through serialize and parse", () => {
    const p = poll({ votes: { [VOTER]: ["Yes"] } });
    const store = new Map([[p.id, p]]);
    const back = parsePollStore(serializePollStore(store), 0);
    expect(back.get(p.id)).toEqual(p);
  });

  test("drops polls at or before the cutoff, keeps newer ones", () => {
    const old = poll({ id: "OLD", ts: 1000 });
    const fresh = poll({ id: "FRESH", ts: 1001 });
    const text = serializePollStore(
      new Map([
        [old.id, old],
        [fresh.id, fresh],
      ]),
    );
    expect([...parsePollStore(text, 1000).keys()]).toEqual(["FRESH"]);
  });

  test("a damaged file or a malformed entry is skipped, not thrown", () => {
    expect(parsePollStore("not json", 0).size).toBe(0);
    expect(parsePollStore('{"id":"x"}', 0).size).toBe(0);
    const good = poll();
    const text = JSON.stringify([
      { ...good, id: "" },
      { ...good, id: "NOSECRET", secret: "" },
      { ...good, id: "BADVOTES", votes: { [VOTER]: "Yes" } },
      good,
    ]);
    expect([...parsePollStore(text, 0).keys()]).toEqual([good.id]);
  });

  test("a poll id is never looked up on a prototype", () => {
    const store = parsePollStore(serializePollStore(new Map()), 0);
    expect(store.get("constructor")).toBeUndefined();
    expect(store.get("__proto__")).toBeUndefined();
  });

  test("addPoll keeps the newest polls when over the cap, and none past the cutoff", () => {
    const store = new Map<string, PollRecord>();
    for (let i = 1; i <= 5; i++)
      addPoll(store, poll({ id: `P${i}`, ts: i * 10 }), 0, 3);
    expect([...store.keys()].sort()).toEqual(["P3", "P4", "P5"]);
    addPoll(store, poll({ id: "P6", ts: 60 }), 40);
    expect([...store.keys()].sort()).toEqual(["P5", "P6"]);
  });
});

describe("pickedOptions and recordVote", () => {
  test("maps hashes back to option names, in the poll's order", () => {
    const p = poll();
    expect(pickedOptions(p, [optionHash("Later"), optionHash("Yes")])).toEqual([
      "Yes",
      "Later",
    ]);
  });

  test("a hash matching no option is left out", () => {
    expect(pickedOptions(poll(), [optionHash("Maybe")])).toEqual([]);
  });

  test("a new pick replaces the old one, an empty pick withdraws it", () => {
    const p = poll();
    recordVote(p, VOTER, ["Yes"]);
    recordVote(p, VOTER, ["No"]);
    expect(p.votes).toEqual({ [VOTER]: ["No"] });
    recordVote(p, VOTER, []);
    expect(p.votes).toEqual({});
  });
});

describe("decryptVote", () => {
  const pollId = "3EB0POLL";
  const secret = randomBytes(32);

  test("opens a vote sealed with the phone-number jids", () => {
    const vote = sealVote(["No"], {
      pollId,
      creator: ME,
      voter: VOTER,
      secret,
    });
    const out = decryptVote(
      vote,
      pollId,
      secret,
      candidatePairs([ME], [VOTER]),
    );
    expect(out?.voter).toBe(VOTER);
    expect(pickedOptions(poll(), out!.selected)).toEqual(["No"]);
  });

  test("finds the LID pairing when the voter's phone sealed it that way", () => {
    const vote = sealVote(["Yes", "Later"], {
      pollId,
      creator: ME_LID,
      voter: VOTER_LID,
      secret,
    });
    const out = decryptVote(
      vote,
      pollId,
      secret,
      candidatePairs([ME, ME_LID], [VOTER, VOTER_LID]),
    );
    expect(out?.voter).toBe(VOTER_LID);
    expect(pickedOptions(poll(), out!.selected)).toEqual(["Yes", "Later"]);
  });

  test("a withdrawn vote decrypts to no options", () => {
    const vote = sealVote([], { pollId, creator: ME, voter: VOTER, secret });
    const out = decryptVote(
      vote,
      pollId,
      secret,
      candidatePairs([ME], [VOTER]),
    );
    expect(out?.selected).toEqual([]);
  });

  test("the wrong secret, poll id or jids open nothing", () => {
    const vote = sealVote(["Yes"], {
      pollId,
      creator: ME,
      voter: VOTER,
      secret,
    });
    const pairs = candidatePairs([ME], [VOTER]);
    expect(decryptVote(vote, pollId, randomBytes(32), pairs)).toBeNull();
    expect(decryptVote(vote, "OTHERPOLL", secret, pairs)).toBeNull();
    expect(
      decryptVote(vote, pollId, secret, candidatePairs([ME], [VOTER_LID])),
    ).toBeNull();
  });

  test("a vote without ciphertext is null, not a crash", () => {
    expect(decryptVote(undefined, pollId, secret, [])).toBeNull();
    expect(decryptVote({}, pollId, secret, [])).toBeNull();
  });
});

describe("candidatePairs", () => {
  test("every creator with every voter, blanks and repeats dropped", () => {
    expect(
      candidatePairs([ME, undefined, ME, ""], [VOTER, null, VOTER_LID]),
    ).toEqual([
      { creator: ME, voter: VOTER },
      { creator: ME, voter: VOTER_LID },
    ]);
  });
});

describe("pollTally and voteText", () => {
  test("counts each voter's current pick per option", () => {
    const p = poll({ multiple: true });
    recordVote(p, VOTER, ["Yes", "Later"]);
    recordVote(p, ME, ["Yes"]);
    expect(pollTally(p)).toEqual([
      { name: "Yes", count: 2 },
      { name: "No", count: 0 },
      { name: "Later", count: 1 },
    ]);
  });

  test("a vote reads as who picked what, on which question, with the tally", () => {
    expect(
      voteText(
        "Akash",
        "Ship it?",
        ["Yes"],
        [
          { name: "Yes", count: 1 },
          { name: "No", count: 0 },
        ],
      ),
    ).toBe(
      '[Poll vote] Akash voted: "Yes" on "Ship it?"\nTally: Yes: 1, No: 0',
    );
  });

  test("several picks are listed, a withdrawal says so", () => {
    expect(voteText("Akash", "Q", ["A", "B"], [])).toBe(
      '[Poll vote] Akash voted: "A", "B" on "Q"',
    );
    expect(voteText("Akash", "Q", [], [])).toBe(
      '[Poll vote] Akash withdrew their vote on "Q"',
    );
  });
});
