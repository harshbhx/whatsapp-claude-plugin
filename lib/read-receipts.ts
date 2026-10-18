// WHATSAPP_READ_RECEIPTS: whether a message gets its blue ticks as soon as it
// is handed to the agent. Off unless set, because turning it on changes what
// every allowlisted sender sees: until now a message read only by the agent
// stayed on two grey ticks. The mark_read tool works either way. Split out of
// server.ts like the other env parsers, so it is testable on its own.

const ON = new Set(["1", "true", "on", "yes"]);

export function parseReadReceipts(raw: string | undefined): boolean {
  return ON.has((raw ?? "").trim().toLowerCase());
}
