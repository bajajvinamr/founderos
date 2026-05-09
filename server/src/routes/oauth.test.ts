import { describe, expect, it } from "vitest";
import { validateReturnUrl } from "./oauth.js";

/**
 * Unit tests for `validateReturnUrl` — closes CodeQL cluster P
 * (`js/server-side-unvalidated-url-redirection`, alerts #7-#10).
 *
 * Threat model: an attacker crafts `?returnUrl=https://evil.com`. After the
 * OAuth dance the server would call `res.redirect(302, returnUrl)`, the
 * browser would land on `evil.com`, and the OAuth `code` (still in the URL
 * at the hop boundary) would leak via the Referer header.
 *
 * Defense: the validator must accept ONLY same-origin paths starting with
 * a single `/`, and fall back to `/` on anything else (graceful, no throw).
 */
describe("validateReturnUrl", () => {
  describe("accepts same-origin paths", () => {
    it("accepts /", () => {
      expect(validateReturnUrl("/")).toBe("/");
    });

    it("accepts /dashboard", () => {
      expect(validateReturnUrl("/dashboard")).toBe("/dashboard");
    });

    it("accepts /integrations?foo=bar", () => {
      expect(validateReturnUrl("/integrations?foo=bar")).toBe("/integrations?foo=bar");
    });

    it("accepts deep paths /a/b/c", () => {
      expect(validateReturnUrl("/a/b/c")).toBe("/a/b/c");
    });

    it("trims whitespace around a valid path", () => {
      expect(validateReturnUrl("  /dashboard  ")).toBe("/dashboard");
    });
  });

  describe("rejects external origins", () => {
    it("rejects https://evil.com", () => {
      expect(validateReturnUrl("https://evil.com")).toBe("/");
    });

    it("rejects http://evil.com/path", () => {
      expect(validateReturnUrl("http://evil.com/path")).toBe("/");
    });

    it("rejects protocol-relative //evil.com", () => {
      expect(validateReturnUrl("//evil.com")).toBe("/");
    });

    it("rejects protocol-relative //evil.com/path", () => {
      expect(validateReturnUrl("//evil.com/path")).toBe("/");
    });
  });

  describe("rejects URL schemes", () => {
    it("rejects javascript:alert(1)", () => {
      expect(validateReturnUrl("javascript:alert(1)")).toBe("/");
    });

    it("rejects data:text/html,...", () => {
      expect(validateReturnUrl("data:text/html,<script>alert(1)</script>")).toBe("/");
    });

    it("rejects vbscript:msgbox(1)", () => {
      expect(validateReturnUrl("vbscript:msgbox(1)")).toBe("/");
    });

    it("rejects file:///etc/passwd", () => {
      expect(validateReturnUrl("file:///etc/passwd")).toBe("/");
    });
  });

  describe("rejects path-traversal / windows variants", () => {
    it("rejects \\\\evil.com\\path (Windows UNC-style)", () => {
      expect(validateReturnUrl("\\\\evil.com\\path")).toBe("/");
    });

    it("rejects /path with embedded backslash", () => {
      expect(validateReturnUrl("/path\\evil")).toBe("/");
    });
  });

  describe("rejects header-injection (CRLF)", () => {
    it("rejects /path\\r\\nLocation: evil.com", () => {
      expect(validateReturnUrl("/path\r\nLocation: evil.com")).toBe("/");
    });

    it("rejects /path with bare \\n", () => {
      expect(validateReturnUrl("/path\nfoo")).toBe("/");
    });

    it("rejects /path with bare \\r", () => {
      expect(validateReturnUrl("/path\rfoo")).toBe("/");
    });
  });

  describe("rejects missing / empty / non-string", () => {
    it("rejects undefined", () => {
      expect(validateReturnUrl(undefined)).toBe("/");
    });

    it("rejects empty string", () => {
      expect(validateReturnUrl("")).toBe("/");
    });

    it("rejects whitespace-only string", () => {
      expect(validateReturnUrl("   ")).toBe("/");
    });

    it("rejects non-string (cast through unknown)", () => {
      // Defense in depth — runtime callers pass `req.query.returnUrl` which
      // is `string | string[] | undefined` per Express types.
      expect(validateReturnUrl(123 as unknown as string)).toBe("/");
      expect(validateReturnUrl(null as unknown as string)).toBe("/");
    });
  });

  describe("rejects misc tricky inputs", () => {
    it("rejects bare hostname dashboard.com", () => {
      expect(validateReturnUrl("dashboard.com")).toBe("/");
    });

    it("rejects relative path foo/bar (no leading slash)", () => {
      expect(validateReturnUrl("foo/bar")).toBe("/");
    });

    it("rejects scheme with mixed case (HTTPS://evil.com)", () => {
      expect(validateReturnUrl("HTTPS://evil.com")).toBe("/");
    });
  });
});
