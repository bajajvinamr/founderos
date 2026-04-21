import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createSlackClient,
  SlackAuthError,
  type SlackChannel,
} from "../services/slack-client.js";

describe("slack-client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  describe("listChannels", () => {
    it("fetches channels with correct URL and auth header", async () => {
      const mockChannels: SlackChannel[] = [
        { id: "C123", name: "general", isMember: true, isPrivate: false },
        { id: "C456", name: "founderos", isMember: true, isPrivate: false },
      ];

      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            channels: [
              {
                id: "C123",
                name: "general",
                is_member: true,
                is_private: false,
              },
              {
                id: "C456",
                name: "founderos",
                is_member: true,
                is_private: false,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      const client = createSlackClient({ botToken: "xoxb-test-token" });
      const channels = await client.listChannels();

      expect(channels).toEqual(mockChannels);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("https://slack.com/api/conversations.list"),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer xoxb-test-token",
            "Content-Type": "application/json",
          }),
        }),
      );
    });

    it("parses response with snake_case to camelCase conversion", async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            channels: [
              {
                id: "C999",
                name: "private-channel",
                is_member: false,
                is_private: true,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      const client = createSlackClient({ botToken: "xoxb-test" });
      const channels = await client.listChannels();

      expect(channels[0]).toEqual({
        id: "C999",
        name: "private-channel",
        isMember: false,
        isPrivate: true,
      });
    });

    it("throws SlackAuthError on 401 response", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
          status: 401,
        }),
      );

      const client = createSlackClient({ botToken: "xoxb-invalid" });
      await expect(client.listChannels()).rejects.toThrow(SlackAuthError);
    });

    it("throws error on network failure", async () => {
      fetchMock.mockRejectedValue(new Error("Network error"));

      const client = createSlackClient({ botToken: "xoxb-test" });
      await expect(client.listChannels()).rejects.toThrow("Slack network error");
    });
  });

  describe("postMessage", () => {
    it("posts message with correct body and headers", async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, ts: "1234567890.001234" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      const client = createSlackClient({ botToken: "xoxb-test-token" });
      const result = await client.postMessage("C123", "Hello channel");

      expect(result).toEqual({ ok: true, ts: "1234567890.001234" });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://slack.com/api/chat.postMessage",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer xoxb-test-token",
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({
            channel: "C123",
            text: "Hello channel",
          }),
        }),
      );
    });

    it("includes blocks in request when provided", async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, ts: "1234567890.001234" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      const blocks = [
        {
          type: "section",
          text: { type: "mrkdwn", text: "*Bold text*" },
        },
      ];

      const client = createSlackClient({ botToken: "xoxb-test-token" });
      const result = await client.postMessage("C123", "Hello", blocks);

      expect(result).toEqual({ ok: true, ts: "1234567890.001234" });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://slack.com/api/chat.postMessage",
        expect.objectContaining({
          body: JSON.stringify({
            channel: "C123",
            text: "Hello",
            blocks,
          }),
        }),
      );
    });

    it("returns error response when Slack API returns error", async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error: "channel_not_found",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      const client = createSlackClient({ botToken: "xoxb-test-token" });
      const result = await client.postMessage("C-invalid", "Hello");

      expect(result).toEqual({ ok: false, error: "channel_not_found" });
    });

    it("throws SlackAuthError on invalid_auth error", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
          status: 401,
        }),
      );

      const client = createSlackClient({ botToken: "xoxb-invalid" });
      await expect(client.postMessage("C123", "Hello")).rejects.toThrow(
        SlackAuthError,
      );
    });
  });
});
