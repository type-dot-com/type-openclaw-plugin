import { describe, expect, test } from "bun:test";
import { TypeConnection } from "./connection.js";

describe("TypeConnection", () => {
  test("debounces reconnect requests until the gate is cleared", () => {
    const connection = new TypeConnection({
      token: "token",
      wsUrl: "ws://example.test",
      onMessage: () => {},
    });

    let reconnectCalls = 0;
    connection.reconnect = () => {
      reconnectCalls += 1;
    };

    expect(connection.requestReconnectOnce("first timeout")).toBe(true);
    expect(connection.requestReconnectOnce("second timeout")).toBe(false);
    expect(reconnectCalls).toBe(1);

    connection.disconnect();

    expect(connection.requestReconnectOnce("after disconnect")).toBe(true);
    expect(reconnectCalls).toBe(2);
  });
});
