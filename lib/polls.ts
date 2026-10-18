// Polls: what send_poll sends, how the server remembers it, and how a vote on
// it is read back.
//
// A vote arrives encrypted (a pollUpdateMessage): only someone holding the
// poll's 32-byte messageSecret can tell which option was picked. Baileys rc14
// no longer decrypts votes itself (the pollUpdateMessage branch of its
// processMessage is commented out), so the server keeps the secret of every
// poll it sends and decrypts votes here. A poll it never sent (one typed on
// the phone, or sent before this existed) has no secret on record, and its
// votes cannot be read. server.ts connects to WhatsApp on import, so these
// rules live here, where they are testable on their own.

import { createHash } from "node:crypto";
import {
  decryptPollVote,
  getAggregateVotesInPollMessage,
  type proto,
} from "@whiskeysockets/baileys";

// WhatsApp's own limits in the app's poll composer.
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 12;
export const POLL_QUESTION_MAX = 255;
export const POLL_OPTION_MAX = 100;

// How long a sent poll's secret is kept, and how many polls at most. A vote
// can come days after the poll; past this it is ignored like any unknown poll.
export const POLL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const POLL_STORE_MAX = 200;

/** What Baileys' `{ poll: ... }` content takes, minus the secret. */
export interface PollSpec {
  name: string;
  values: string[];
  /** 1 = single choice; 0 = any number of options (WhatsApp's "multiple"). */
  selectableCount: number;
}

/** Validates send_poll's arguments into a PollSpec, or throws a message the
 *  agent can act on. Options are trimmed and must be unique: a vote names
 *  its option only by a SHA-256 of the option text, so two identical options
 *  could never be told apart. */
export function pollSpec(
  question: unknown,
  options: unknown,
  multiple: unknown,
): PollSpec {
  if (typeof question !== "string" || !question.trim())
    throw new Error("question is required");
  const name = question.trim();
  if (name.length > POLL_QUESTION_MAX)
    throw new Error(`question is longer than ${POLL_QUESTION_MAX} characters`);
  if (!Array.isArray(options))
    throw new Error(
      `options must be an array of ${POLL_MIN_OPTIONS} to ${POLL_MAX_OPTIONS} strings`,
    );
  if (options.length < POLL_MIN_OPTIONS || options.length > POLL_MAX_OPTIONS)
    throw new Error(
      `a poll needs ${POLL_MIN_OPTIONS} to ${POLL_MAX_OPTIONS} options, got ${options.length}`,
    );
  const values = options.map((o) => (typeof o === "string" ? o.trim() : ""));
  if (values.some((v) => !v)) throw new Error("every option needs some text");
  if (values.some((v) => v.length > POLL_OPTION_MAX))
    throw new Error(`an option is longer than ${POLL_OPTION_MAX} characters`);
  if (new Set(values).size !== values.length)
    throw new Error("options must be unique");
  if (multiple !== undefined && typeof multiple !== "boolean")
    throw new Error("multiple must be true or false");
  return { name, values, selectableCount: multiple ? 0 : 1 };
}

/** One poll this server sent, as kept in polls.json. */
export interface PollRecord {
  /** The poll creation message's id: what a vote points back to. */
  id: string;
  chat_id: string;
  question: string;
  options: string[];
  multiple: boolean;
  /** messageSecret, base64. The key every vote on this poll is sealed with. */
  secret: string;
  /** Sent at, epoch ms. */
  ts: number;
  /** Voter (phone jid where known) -> the options they currently have picked. */
  votes: Record<string, string[]>;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

function isPollRecord(v: unknown): v is PollRecord {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return false;
  if (typeof r.chat_id !== "string" || !r.chat_id) return false;
  if (typeof r.question !== "string") return false;
  if (!isStringArray(r.options)) return false;
  if (typeof r.multiple !== "boolean") return false;
  if (typeof r.secret !== "string" || !r.secret) return false;
  if (typeof r.ts !== "number" || !Number.isFinite(r.ts)) return false;
  if (!r.votes || typeof r.votes !== "object" || Array.isArray(r.votes))
    return false;
  return Object.values(r.votes).every(isStringArray);
}

/** Reads polls.json. Anything malformed or older than `cutoffMs` is dropped,
 *  never thrown: a damaged file costs the votes on old polls, not the server.
 *  A Map, so a poll id from a vote (sender-controlled) is never looked up on
 *  an object's prototype. */
export function parsePollStore(
  text: string,
  cutoffMs: number,
): Map<string, PollRecord> {
  const store = new Map<string, PollRecord>();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return store;
  }
  if (!Array.isArray(raw)) return store;
  for (const entry of raw) {
    if (!isPollRecord(entry) || entry.ts <= cutoffMs) continue;
    store.set(entry.id, {
      ...entry,
      votes: Object.assign(Object.create(null), entry.votes),
    });
  }
  return store;
}

export function serializePollStore(store: Map<string, PollRecord>): string {
  return JSON.stringify([...store.values()]) + "\n";
}

/** Adds a poll and drops the oldest ones past `max`, and any past `cutoffMs`. */
export function addPoll(
  store: Map<string, PollRecord>,
  poll: PollRecord,
  cutoffMs: number,
  max = POLL_STORE_MAX,
): void {
  store.set(poll.id, poll);
  for (const [id, p] of store) if (p.ts <= cutoffMs) store.delete(id);
  const byAge = [...store.values()].sort((a, b) => a.ts - b.ts);
  for (const p of byAge.slice(0, Math.max(0, byAge.length - max)))
    store.delete(p.id);
}

/** How a vote names an option: SHA-256 of the option text. */
export function optionHash(option: string): Buffer {
  return createHash("sha256").update(Buffer.from(option)).digest();
}

/** The options a decrypted vote picked, in the poll's own order. A hash that
 *  matches no option (a poll edited elsewhere) is left out. */
export function pickedOptions(
  poll: Pick<PollRecord, "options">,
  selected: Uint8Array[],
): string[] {
  const hashes = new Set(selected.map((h) => Buffer.from(h).toString("hex")));
  return poll.options.filter((o) => hashes.has(optionHash(o).toString("hex")));
}

/** A voter's new pick replaces their old one; an empty pick withdraws it. */
export function recordVote(
  poll: PollRecord,
  voter: string,
  picked: string[],
): void {
  if (picked.length) poll.votes[voter] = picked;
  else delete poll.votes[voter];
}

/** Every pairing of creator and voter jid worth trying, without blanks or
 *  repeats. The vote is sealed with the creator's and voter's jids as THEIR
 *  client saw them, and with LID addressing that can be the phone-number
 *  form or the @lid form of either side; nothing in the vote says which. */
export function candidatePairs(
  creators: Array<string | null | undefined>,
  voters: Array<string | null | undefined>,
): Array<{ creator: string; voter: string }> {
  const uniq = (list: Array<string | null | undefined>) => [
    ...new Set(list.filter((j): j is string => !!j)),
  ];
  return uniq(creators).flatMap((creator) =>
    uniq(voters).map((voter) => ({ creator, voter })),
  );
}

/** Decrypts a vote with the first creator/voter pairing that opens it. AES-GCM
 *  authenticates, so a wrong pairing throws rather than yielding garbage.
 *  null = no pairing opened it (or the vote carries no ciphertext). */
export function decryptVote(
  vote: proto.Message.IPollEncValue | null | undefined,
  pollId: string,
  secret: Uint8Array,
  pairs: Array<{ creator: string; voter: string }>,
): { selected: Uint8Array[]; voter: string } | null {
  if (!vote?.encPayload?.length || !vote.encIv?.length) return null;
  for (const { creator, voter } of pairs) {
    try {
      const decoded = decryptPollVote(vote, {
        pollCreatorJid: creator,
        pollMsgId: pollId,
        pollEncKey: secret,
        voterJid: voter,
      });
      return { selected: decoded.selectedOptions ?? [], voter };
    } catch {
      // wrong pairing: try the next one
    }
  }
  return null;
}

/** Current count per option, through Baileys' own aggregation. */
export function pollTally(
  poll: Pick<PollRecord, "question" | "options" | "votes" | "chat_id">,
): Array<{ name: string; count: number }> {
  const pollUpdates = Object.entries(poll.votes).map(([voter, picked]) => ({
    pollUpdateMessageKey: {
      remoteJid: poll.chat_id,
      participant: voter,
      fromMe: false,
    },
    vote: { selectedOptions: picked.map(optionHash) },
  }));
  return getAggregateVotesInPollMessage({
    message: {
      pollCreationMessage: {
        name: poll.question,
        options: poll.options.map((optionName) => ({ optionName })),
      },
    },
    pollUpdates,
  }).map(({ name, voters }) => ({ name, count: voters.length }));
}

/** The text the agent receives for one vote change. */
export function voteText(
  voter: string,
  question: string,
  picked: string[],
  tally: Array<{ name: string; count: number }>,
): string {
  const quoted = (s: string) => `"${s}"`;
  const head = picked.length
    ? `[Poll vote] ${voter} voted: ${picked.map(quoted).join(", ")} on ${quoted(question)}`
    : `[Poll vote] ${voter} withdrew their vote on ${quoted(question)}`;
  const counts = tally.map((t) => `${t.name}: ${t.count}`).join(", ");
  return counts ? `${head}\nTally: ${counts}` : head;
}
