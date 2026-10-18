import { describe, expect, test } from "bun:test";
import { resolveMessageKey } from "./message-key";

const GROUP = "120363000000000001@g.us";
const DM = "15550000002@s.whatsapp.net";
const DM_LID = "222222222222222@lid";
const SENDER = "15550000003@s.whatsapp.net";

// The server compares through its LID map; here the one DM has two spellings.
const sameChat = (a: string, b: string) => {
  const canon = (j: string) => (j === DM_LID ? DM : j);
  return canon(a) === canon(b);
};

function resolve(overrides: Partial<Parameters<typeof resolveMessageKey>[0]>) {
  return resolveMessageKey({
    chatId: GROUP,
    messageId: "MSG1",
    sentByServer: false,
    sameChat,
    ...overrides,
  });
}

describe("resolveMessageKey", () => {
  test("the stored key wins, exactly as WhatsApp delivered it", () => {
    const stored = {
      remoteJid: GROUP,
      id: "MSG1",
      fromMe: false,
      participant: "333@lid",
    };
    expect(
      resolve({
        stored,
        logged: { id: "MSG1", chat_id: GROUP, user_id: SENDER },
      }),
    ).toBe(stored);
  });

  test("from the log, someone else's group message carries its sender", () => {
    expect(
      resolve({
        logged: {
          id: "MSG1",
          chat_id: GROUP,
          user_id: SENDER,
          direction: "in",
        },
      }),
    ).toEqual({
      remoteJid: GROUP,
      id: "MSG1",
      fromMe: false,
      participant: SENDER,
    });
  });

  test("from the log, an outbound line is our own message, with no participant", () => {
    expect(
      resolve({
        logged: {
          id: "MSG1",
          chat_id: GROUP,
          user_id: "15550000001@s.whatsapp.net",
          direction: "out",
        },
      }),
    ).toEqual({ remoteJid: GROUP, id: "MSG1", fromMe: true });
  });

  test("a legacy log line with no direction is inbound", () => {
    expect(
      resolve({
        chatId: DM,
        logged: { id: "MSG1", chat_id: DM, user_id: DM },
      }),
    ).toEqual({ remoteJid: DM, id: "MSG1", fromMe: false });
  });

  test("an id only sent.jsonl knows is our own message in the given chat", () => {
    expect(resolve({ chatId: DM, sentByServer: true })).toEqual({
      remoteJid: DM,
      id: "MSG1",
      fromMe: true,
    });
  });

  test("an id nobody knows is null", () => {
    expect(resolve({})).toBeNull();
  });

  test("another spelling of the same DM is the same chat", () => {
    const stored = { remoteJid: DM_LID, id: "MSG1", fromMe: false };
    expect(resolve({ chatId: DM, stored })).toBe(stored);
  });

  test("a message from a different chat is refused, from every source", () => {
    expect(() =>
      resolve({ stored: { remoteJid: DM, id: "MSG1", fromMe: false } }),
    ).toThrow("not in chat");
    expect(() =>
      resolve({ logged: { id: "MSG1", chat_id: DM, user_id: DM } }),
    ).toThrow("not in chat");
  });
});
