import { describe, expect, it } from "vitest";
import { ShellBridgeNotificationClickMessage, ShellBridgeNotifyMessage } from "./shellBridge.js";

describe("ShellBridgeNotifyMessage", () => {
  it("accepts a well-formed notify envelope", () => {
    const envelope = {
      il_shell: 1,
      type: "notify",
      payload: { workspaceOrigin: "https://demo.example", channelId: "c1", title: "Ada", body: "hi" },
    };
    expect(ShellBridgeNotifyMessage.safeParse(envelope).success).toBe(true);
  });

  it("rejects a notification-click envelope shape", () => {
    const envelope = {
      il_shell: 1,
      type: "notification-click",
      payload: { workspaceOrigin: "https://demo.example", channelId: "c1" },
    };
    expect(ShellBridgeNotifyMessage.safeParse(envelope).success).toBe(false);
  });

  it("rejects an unversioned envelope", () => {
    const envelope = {
      type: "notify",
      payload: { workspaceOrigin: "https://demo.example", channelId: "c1", title: "Ada", body: "hi" },
    };
    expect(ShellBridgeNotifyMessage.safeParse(envelope).success).toBe(false);
  });

  it("rejects unrelated message-bus traffic", () => {
    expect(ShellBridgeNotifyMessage.safeParse({ source: "react-devtools-bridge" }).success).toBe(false);
    expect(ShellBridgeNotifyMessage.safeParse("hello").success).toBe(false);
    expect(ShellBridgeNotifyMessage.safeParse(null).success).toBe(false);
  });
});

describe("ShellBridgeNotificationClickMessage", () => {
  it("accepts a well-formed notification-click envelope", () => {
    const envelope = {
      il_shell: 1,
      type: "notification-click",
      payload: { workspaceOrigin: "https://demo.example", channelId: "c1" },
    };
    expect(ShellBridgeNotificationClickMessage.safeParse(envelope).success).toBe(true);
  });

  it("rejects a notify envelope shape", () => {
    const envelope = {
      il_shell: 1,
      type: "notify",
      payload: { workspaceOrigin: "https://demo.example", channelId: "c1", title: "Ada", body: "hi" },
    };
    expect(ShellBridgeNotificationClickMessage.safeParse(envelope).success).toBe(false);
  });
});
