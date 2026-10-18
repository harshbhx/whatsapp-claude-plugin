// Which message a tool means. mark_read and pin_message get the message_id
// the agent was shown and have to turn it back into a full WAMessageKey: in a
// group, a read receipt or a pin without the sender's `participant` names
// nobody's message. Three sources, best first: the in-memory key store (the
// key exactly as WhatsApp delivered it, but FIFO-capped and empty after a
// restart), the message log (days of history: chat, sender and direction),
// and sent.jsonl (this server's own sends from the last 24h, ids only).
// server.ts connects to WhatsApp on import, so the rule lives here.

import type { WAMessageKey } from "@whiskeysockets/baileys";

/** The fields of a messages.jsonl line that locate a message. */
export interface LoggedMessage {
  id: string;
  chat_id: string;
  user_id: string;
  direction?: "in" | "out";
}

/** The full key for `messageId` in `chatId`, or null when no source knows the
 *  id. Throws when a source places the id in a different chat: a tool must
 *  never act on a message outside the chat it was allowed to act in.
 *  `sameChat` compares two spellings of a chat (a DM's @lid and phone forms). */
export function resolveMessageKey(input: {
  chatId: string;
  messageId: string;
  stored?: WAMessageKey;
  logged?: LoggedMessage;
  sentByServer: boolean;
  sameChat: (a: string, b: string) => boolean;
}): WAMessageKey | null {
  const { chatId, messageId, stored, logged, sentByServer, sameChat } = input;
  const elsewhere = () =>
    new Error(`message ${messageId} is not in chat ${chatId}`);
  if (stored?.remoteJid) {
    if (!sameChat(stored.remoteJid, chatId)) throw elsewhere();
    return stored;
  }
  if (logged) {
    if (!sameChat(logged.chat_id, chatId)) throw elsewhere();
    const fromMe = logged.direction === "out";
    return {
      remoteJid: logged.chat_id,
      id: messageId,
      fromMe,
      // A group message from someone else is named by its sender too.
      ...(logged.chat_id.endsWith("@g.us") && !fromMe && logged.user_id
        ? { participant: logged.user_id }
        : {}),
    };
  }
  if (sentByServer) return { remoteJid: chatId, id: messageId, fromMe: true };
  return null;
}
