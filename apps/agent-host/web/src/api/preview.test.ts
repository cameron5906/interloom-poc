import { afterEach, describe, expect, it, vi } from "vitest";
import { streamPreview } from "./preview.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamPreview terminal SSE handling", () => {
  it("surfaces an error frame and never reports a following done frame as success", async () => {
    const body = [
      'data: {"delta":"partial"}\n\n',
      'data: {"error":"inference failed"}\n\n',
      'data: {"done":true}\n\n',
    ].join("");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
        ),
    );
    const onDelta = vi.fn();
    const onDone = vi.fn();

    const error = await new Promise<Error>((resolve) => {
      streamPreview(
        "agent-1",
        { messages: [{ role: "user", content: "hello" }] },
        { onDelta, onDone, onError: resolve },
      );
    });

    expect(error.message).toBe("inference failed");
    expect(onDelta).toHaveBeenCalledWith("partial");
    expect(onDone).not.toHaveBeenCalled();
  });
});
