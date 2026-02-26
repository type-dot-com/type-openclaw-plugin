import { describe, expect, test } from "bun:test";
import {
  isLikelyTypeTargetId,
  normalizeTypeTarget,
} from "./targetNormalization.js";

describe("Type target normalization", () => {
  test("normalizes channel/provider prefixes", () => {
    expect(normalizeTypeTarget("type:ch_123")).toBe("ch_123");
    expect(normalizeTypeTarget("channel:agsess_abc")).toBe("agsess_abc");
    expect(normalizeTypeTarget("group:ch_777")).toBe("ch_777");
  });

  test("detects direct Type ids", () => {
    expect(isLikelyTypeTargetId("ch_123")).toBe(true);
    expect(isLikelyTypeTargetId("agsess_abc")).toBe(true);
    expect(isLikelyTypeTargetId("type:agsess_abc")).toBe(true);
    expect(isLikelyTypeTargetId("channel:foo")).toBe(true);
  });

  test("does not force directory bypass for plain names", () => {
    expect(isLikelyTypeTargetId("general")).toBe(false);
    expect(isLikelyTypeTargetId("#general")).toBe(false);
  });
});
