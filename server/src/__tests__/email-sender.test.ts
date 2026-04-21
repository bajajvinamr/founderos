import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmailSender } from "../services/email-sender.js";

// ---------------------------------------------------------------------------
// Global fetch mock
// ---------------------------------------------------------------------------
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

afterEach(() => {
  vi.clearAllMocks();
});

describe("createEmailSender — no-op mode (no API key)", () => {
  it("returns enabled=false when apiKey is undefined", () => {
    const sender = createEmailSender({ apiKey: undefined });
    expect(sender.enabled).toBe(false);
  });

  it("returns enabled=false when apiKey is empty string", () => {
    const sender = createEmailSender({ apiKey: "" });
    expect(sender.enabled).toBe(false);
  });

  it("send() returns { ok: false, error: 'disabled' } and never calls fetch", async () => {
    const sender = createEmailSender({ apiKey: undefined });
    const result = await sender.send({
      to: "user@example.com",
      subject: "Test",
      text: "Hello",
    });
    expect(result).toEqual({ ok: false, error: "disabled" });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("createEmailSender — real mode (API key present)", () => {
  const API_KEY = "re_test_key_123";
  const FROM = "hello@founderos.ai";

  beforeEach(() => {
    // Default: 200 OK with an id
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "resend-msg-001" }),
    });
  });

  it("returns enabled=true when apiKey is set", () => {
    const sender = createEmailSender({ apiKey: API_KEY, fromAddress: FROM });
    expect(sender.enabled).toBe(true);
  });

  it("calls POST https://api.resend.com/emails with correct headers and body", async () => {
    const sender = createEmailSender({ apiKey: API_KEY, fromAddress: FROM });
    await sender.send({
      to: "user@example.com",
      subject: "Welcome",
      text: "Hello there",
      html: "<p>Hello there</p>",
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${API_KEY}`);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.from).toBe(FROM);
    expect(body.to).toEqual(["user@example.com"]);
    expect(body.subject).toBe("Welcome");
    expect(body.text).toBe("Hello there");
    expect(body.html).toBe("<p>Hello there</p>");
  });

  it("returns { ok: true, id } on 200 response", async () => {
    const sender = createEmailSender({ apiKey: API_KEY, fromAddress: FROM });
    const result = await sender.send({
      to: "user@example.com",
      subject: "Welcome",
      text: "Hello",
    });
    expect(result).toEqual({ ok: true, id: "resend-msg-001" });
  });

  it("returns { ok: false, error } on 4xx response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: async () => "Unprocessable Entity",
    });

    const sender = createEmailSender({ apiKey: API_KEY, fromAddress: FROM });
    const result = await sender.send({
      to: "bad@example.com",
      subject: "Test",
      text: "Hi",
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/422/);
  });

  it("returns { ok: false, error } and does not throw on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const sender = createEmailSender({ apiKey: API_KEY, fromAddress: FROM });
    const result = await sender.send({
      to: "user@example.com",
      subject: "Test",
      text: "Hi",
    });
    expect(result).toMatchObject({ ok: false, error: "ECONNREFUSED" });
  });

  it("omits html field when not provided", async () => {
    const sender = createEmailSender({ apiKey: API_KEY, fromAddress: FROM });
    await sender.send({
      to: "user@example.com",
      subject: "No HTML",
      text: "Plain only",
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("html");
  });

  it("defaults fromAddress to onboarding@resend.dev when not specified", async () => {
    const sender = createEmailSender({ apiKey: API_KEY });
    await sender.send({ to: "x@example.com", subject: "S", text: "T" });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.from).toBe("onboarding@resend.dev");
  });
});
