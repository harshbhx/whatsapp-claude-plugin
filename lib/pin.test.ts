import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PIN_DURATION,
  PIN_DURATIONS,
  pinContent,
  pinSeconds,
} from "./pin";

const key = {
  remoteJid: "120363000000000000@g.us",
  fromMe: true,
  id: "ABC123",
};

describe("pinSeconds", () => {
  test("each WhatsApp pin length maps to its seconds", () => {
    expect(pinSeconds("24h")).toBe(86_400);
    expect(pinSeconds("7d")).toBe(604_800);
    expect(pinSeconds("30d")).toBe(2_592_000);
  });

  test("omitted means 7 days", () => {
    expect(DEFAULT_PIN_DURATION).toBe("7d");
    expect(pinSeconds()).toBe(604_800);
    expect(pinSeconds(undefined)).toBe(604_800);
    expect(pinSeconds(null)).toBe(604_800);
  });

  test("anything else is an error, not a silent 24h pin", () => {
    for (const bad of [
      "1w",
      "7D",
      " 7d",
      "",
      "86400",
      "constructor",
      86_400,
      true,
    ])
      expect(() => pinSeconds(bad)).toThrow(
        "duration must be one of 24h, 7d, 30d",
      );
  });

  test("only the three lengths exist", () => {
    expect(Object.keys(PIN_DURATIONS)).toEqual(["24h", "7d", "30d"]);
  });
});

describe("pinContent", () => {
  test("pins for everyone (type 1) with the duration in seconds", () => {
    expect(pinContent(key, { duration: "24h" })).toEqual({
      pin: key,
      type: 1,
      time: 86_400,
    });
  });

  test("defaults to a 7-day pin", () => {
    expect(pinContent(key)).toEqual({ pin: key, type: 1, time: 604_800 });
    expect(pinContent(key, { unpin: false })).toEqual({
      pin: key,
      type: 1,
      time: 604_800,
    });
  });

  test("unpin is type 2 and carries no time", () => {
    expect(pinContent(key, { unpin: true })).toEqual({ pin: key, type: 2 });
  });

  test("a duration passed with unpin is ignored, even a bad one", () => {
    expect(pinContent(key, { unpin: true, duration: "1w" })).toEqual({
      pin: key,
      type: 2,
    });
  });

  test("a bad duration fails before anything could be sent", () => {
    expect(() => pinContent(key, { duration: "1w" })).toThrow("duration");
  });

  test("the key is passed through untouched", () => {
    const groupKey = {
      remoteJid: "120363000000000000@g.us",
      fromMe: false,
      id: "XYZ",
      participant: "15550001111@s.whatsapp.net",
    };
    expect(pinContent(groupKey).pin).toBe(groupKey);
  });
});
