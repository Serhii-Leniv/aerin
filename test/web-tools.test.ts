import { describe, expect, test } from "bun:test";
import { assertPublicHttpUrl, htmlToText, parseDuckDuckGo, webFetchTool, webSearchTool } from "../src/tools/web-tools.js";

describe("htmlToText", () => {
  test("strips tags, scripts, and entities", () => {
    const html = `<html><head><style>p{color:red}</style><script>alert(1)</script></head>
      <body><h1>Title</h1><p>Hello &amp; welcome</p><ul><li>one</li><li>two</li></ul></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("Title");
    expect(text).toContain("Hello & welcome");
    expect(text).toContain("one");
    expect(text).not.toContain("alert(1)");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("<p>");
  });
});

describe("parseDuckDuckGo", () => {
  test("extracts titles, unwrapped urls, and snippets", () => {
    const html = `
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=abc">Example <b>Docs</b></a>
      <a class="result__snippet" href="#">The official <b>docs</b> site.</a>
      <a rel="nofollow" class="result__a" href="https://plain.example.org/">Plain Result</a>
      <a class="result__snippet" href="#">Second snippet.</a>`;
    const hits = parseDuckDuckGo(html, 8);
    expect(hits).toHaveLength(2);
    expect(hits[0]?.url).toBe("https://example.com/docs");
    expect(hits[0]?.title).toBe("Example Docs");
    expect(hits[0]?.snippet).toBe("The official docs site.");
    expect(hits[1]?.url).toBe("https://plain.example.org/");
  });

  test("respects the limit", () => {
    const one = `<a class="result__a" href="https://a.example/">A</a>`;
    expect(parseDuckDuckGo(one.repeat(10), 3)).toHaveLength(3);
  });
});

describe("web tools", () => {
  test("are read-tier with the expected names", () => {
    expect(webFetchTool.permission).toBe("read");
    expect(webSearchTool.permission).toBe("read");
    expect(webFetchTool.name).toBe("webfetch");
    expect(webSearchTool.name).toBe("websearch");
  });

  test("SSRF guard blocks internal targets, allows the public web", () => {
    for (const bad of [
      "http://localhost:8080/admin",
      "http://127.0.0.1/x",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/",
      "http://172.16.1.1/",
      "http://192.168.1.1/router",
      "http://[::1]/",
      "http://internal.corp.internal/",
      "file:///etc/passwd",
    ]) {
      expect(() => assertPublicHttpUrl(bad)).toThrow();
    }
    expect(assertPublicHttpUrl("https://example.com/docs").hostname).toBe("example.com");
    expect(assertPublicHttpUrl("http://8.8.8.8/").hostname).toBe("8.8.8.8");
  });

  test("webfetch rejects non-http urls", async () => {
    await expect(
      webFetchTool.execute({ url: "file:///etc/passwd" }, { cwd: process.cwd(), allowOutsideCwd: false }),
    ).rejects.toThrow(/http/i);
  });
});
