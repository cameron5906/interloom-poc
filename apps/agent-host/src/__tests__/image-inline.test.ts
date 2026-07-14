/**
 * Tests for host-side image inlining (CONTRACTS §3): `image_url` values are
 * resolved daemon-side before the llama-server payload is built. `data:` URLs
 * pass through untouched; `http(s)` URLs are fetched (10s timeout, 8 MB cap,
 * `image/*` content-type required) and inlined as data URLs; ANY failure
 * degrades the message to its plain `content` string, never the request.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import http from "http";
import type { AddressInfo } from "net";

vi.mock("../config.js", () => ({
  PORT: 7420,
  DATA_DIR: "./test-data",
  MODELS_DIR: "./test-models",
  NETWORK_URL: "http://localhost:9999",
  INFERENCE_URL: "http://localhost:8080",
  FETCHER_URL: "http://localhost:7423",
}));

function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

describe("inlineImageUrl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("passes data: URLs through untouched", async () => {
    const { inlineImageUrl } = await import("../tunnel/client.js");
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    expect(await inlineImageUrl(dataUrl)).toBe(dataUrl);
  });

  it("inlines a successful http(s) fetch as a data URL", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic bytes
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(png);
    });

    const { inlineImageUrl } = await import("../tunnel/client.js");
    const result = await inlineImageUrl(`${url}/image.png`);
    await close();

    expect(result).toBe(`data:image/png;base64,${png.toString("base64")}`);
  });

  it("degrades (returns null) when content-length exceeds the 8 MB cap", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(9 * 1024 * 1024),
      });
      res.end(Buffer.from([1, 2, 3])); // body irrelevant — header alone should short-circuit
    });

    const { inlineImageUrl } = await import("../tunnel/client.js");
    const result = await inlineImageUrl(`${url}/big.png`);
    await close();

    expect(result).toBeNull();
  });

  it("degrades (returns null) when the actual body exceeds the 8 MB cap (no content-length backstop)", async () => {
    const oversized = Buffer.alloc(9 * 1024 * 1024, 7);
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" }); // no content-length -> chunked
      res.end(oversized);
    });

    const { inlineImageUrl } = await import("../tunnel/client.js");
    const result = await inlineImageUrl(`${url}/big-chunked.png`);
    await close();

    expect(result).toBeNull();
  });

  it("degrades (returns null) when the content-type is not image/*", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>not an image</html>");
    });

    const { inlineImageUrl } = await import("../tunnel/client.js");
    const result = await inlineImageUrl(`${url}/not-an-image`);
    await close();

    expect(result).toBeNull();
  });

  it("degrades (returns null) on timeout", async () => {
    // Force the 10s AbortSignal.timeout() used internally to behave as an
    // already-aborted signal so the test doesn't have to wait 10 real
    // seconds — this exercises the exact timeout code path deterministically.
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      void ms;
      const ac = new AbortController();
      ac.abort();
      return ac.signal;
    });

    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([1, 2, 3]));
    });

    const { inlineImageUrl } = await import("../tunnel/client.js");
    const result = await inlineImageUrl(`${url}/slow.png`);
    await close();

    expect(result).toBeNull();
    void realTimeout;
  });

  it("degrades (returns null) on network error (connection refused)", async () => {
    const { inlineImageUrl } = await import("../tunnel/client.js");
    // Nothing listens on this port.
    const result = await inlineImageUrl("http://127.0.0.1:1/unreachable.png");
    expect(result).toBeNull();
  });
});

describe("resolveWireContent (per-message degrade)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns plain content when not vision-capable, even with contentParts present", async () => {
    const { resolveWireContent } = await import("../tunnel/client.js");
    const result = await resolveWireContent(
      {
        role: "user",
        content: "[image attached]",
        contentParts: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
      },
      false,
    );
    expect(result).toBe("[image attached]");
  });

  it("resolves contentParts (with data URL passthrough) when vision-capable", async () => {
    const { resolveWireContent } = await import("../tunnel/client.js");
    const dataUrl = "data:image/png;base64,AAAA";
    const result = await resolveWireContent(
      {
        role: "user",
        content: "[image attached]",
        contentParts: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
      true,
    );
    expect(result).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: dataUrl } },
    ]);
  });

  it("degrades the WHOLE message to its content string when any image_url fails to inline", async () => {
    const { resolveWireContent } = await import("../tunnel/client.js");
    const result = await resolveWireContent(
      {
        role: "user",
        content: "[image attached]",
        contentParts: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "http://127.0.0.1:1/unreachable.png" } },
        ],
      },
      true,
    );
    expect(result).toBe("[image attached]");
  });
});
