/**
 * Tests for host-side image inlining (CONTRACTS §3): `image_url` values are
 * resolved daemon-side before the llama-server payload is built. `data:` URLs
 * pass through untouched; `http(s)` URLs are fetched (10s timeout, 8 MB cap,
 * `image/*` content-type required) and inlined as data URLs; ANY failure
 * degrades the message to its plain `content` string, never the request.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import http from "http";
import type { AddressInfo } from "net";

const ASSET_SHA = "a".repeat(64);
const PNG_PATH = `/api/assets/av/${ASSET_SHA}.png`;

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
  beforeEach(() => {
    // Explicit test-only policy switch: production never infers this exception
    // from NODE_ENV.
    vi.stubEnv("ALLOW_LOOPBACK_INSTANCE_ORIGINS", "true");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("passes data: URLs through untouched", async () => {
    const { inlineImageUrl } = await import("../tunnel/client.js");
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    expect(await inlineImageUrl(dataUrl, "https://instance.example")).toBe(dataUrl);
  });

  it("inlines a successful http(s) fetch as a data URL", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic bytes
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(png);
    });

    const { inlineImageUrl } = await import("../tunnel/client.js");
    const result = await inlineImageUrl(`${url}${PNG_PATH}`, url);
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
    const result = await inlineImageUrl(`${url}${PNG_PATH}`, url);
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
    const result = await inlineImageUrl(`${url}${PNG_PATH}`, url);
    await close();

    expect(result).toBeNull();
  });

  it("degrades (returns null) when the content-type is not image/*", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>not an image</html>");
    });

    const { inlineImageUrl } = await import("../tunnel/client.js");
    const result = await inlineImageUrl(`${url}${PNG_PATH}`, url);
    await close();

    expect(result).toBeNull();
  });

  it("degrades (returns null) on timeout", async () => {
    const { url, close } = await startServer((_req, res) => {
      // Accept the connection but never send headers. The test-only timeout
      // argument exercises the same request destruction path without waiting
      // ten real seconds.
      void res;
    });

    const { inlineImageUrl } = await import("../tunnel/client.js");
    const result = await inlineImageUrl(`${url}${PNG_PATH}`, url, 25);
    await close();

    expect(result).toBeNull();
  });

  it("degrades (returns null) on network error (connection refused)", async () => {
    const { inlineImageUrl } = await import("../tunnel/client.js");
    // Nothing listens on this port.
    const result = await inlineImageUrl(`http://127.0.0.1:1${PNG_PATH}`, "http://127.0.0.1:1");
    expect(result).toBeNull();
  });

  it("rejects a same-origin URL outside the approved content-addressed asset path", async () => {
    let requested = false;
    const { url, close } = await startServer((_req, res) => {
      requested = true;
      res.end();
    });

    const { inlineImageUrl } = await import("../tunnel/client.js");
    expect(await inlineImageUrl(`${url}/admin/export.png`, url)).toBeNull();
    expect(requested).toBe(false);
    await close();
  });

  it("rejects bytes whose magic does not match an allowed image content-type", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end("<script>alert(1)</script>");
    });

    const { inlineImageUrl } = await import("../tunnel/client.js");
    expect(await inlineImageUrl(`${url}${PNG_PATH}`, url)).toBeNull();
    await close();
  });

  it("rejects a forged inline image data URL", async () => {
    const { inlineImageUrl } = await import("../tunnel/client.js");
    const forged = `data:image/png;base64,${Buffer.from("not an image").toString("base64")}`;
    expect(await inlineImageUrl(forged, "https://instance.example")).toBeNull();
  });
});

describe("resolveWireContent (per-message degrade)", () => {
  beforeEach(() => {
    vi.stubEnv("ALLOW_LOOPBACK_INSTANCE_ORIGINS", "true");
  });

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
      "https://instance.example",
    );
    expect(result).toBe("[image attached]");
  });

  it("resolves contentParts (with data URL passthrough) when vision-capable", async () => {
    const { resolveWireContent } = await import("../tunnel/client.js");
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
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
      "https://instance.example",
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
          { type: "image_url", image_url: { url: `http://127.0.0.1:1${PNG_PATH}` } },
        ],
      },
      true,
      "http://127.0.0.1:1",
    );
    expect(result).toBe("[image attached]");
  });
});
