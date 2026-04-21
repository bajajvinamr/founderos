/**
 * Slack API client — native fetch, no SDK dependency.
 *
 * Implements minimal surface for FounderOS integration:
 *   - listChannels() — fetch bot-accessible channels
 *   - postMessage() — send message to a channel
 *
 * All requests carry a 10-second timeout enforced via AbortController.
 */

export class SlackAuthError extends Error {
  constructor(message = "Slack authentication failed: invalid or expired bot token") {
    super(message);
    this.name = "SlackAuthError";
  }
}

export interface SlackConfig {
  botToken: string; // xoxb- token from Slack app's Bot OAuth install
}

export interface SlackChannel {
  id: string;
  name: string;
  isMember: boolean;
  isPrivate: boolean;
}

export interface SlackPostMessageResult {
  ok: true;
  ts: string;
}

export interface SlackErrorResult {
  ok: false;
  error: string;
}

export type SlackPostMessageResponse = SlackPostMessageResult | SlackErrorResult;

export interface SlackClient {
  listChannels(): Promise<SlackChannel[]>;
  postMessage(
    channelId: string,
    text: string,
    blocks?: unknown[],
  ): Promise<SlackPostMessageResponse>;
}

const REQUEST_TIMEOUT_MS = 10_000;
const BASE_URL = "https://slack.com/api";

export function createSlackClient(config: SlackConfig): SlackClient {
  const authHeaders = { Authorization: `Bearer ${config.botToken}` };

  async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Slack request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw new Error(
        `Slack network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401) {
      throw new SlackAuthError();
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Slack API error ${res.status}: ${body}`);
    }

    return res.json() as Promise<T>;
  }

  async function listChannels(): Promise<SlackChannel[]> {
    interface SlackListChannelsResponse {
      ok: boolean;
      channels: Array<{
        id: string;
        name: string;
        is_member: boolean;
        is_private: boolean;
      }>;
      error?: string;
    }

    const params = new URLSearchParams({
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
    });

    const data = await apiFetch<SlackListChannelsResponse>(
      `/conversations.list?${params.toString()}`,
    );

    if (!data.ok) {
      throw new Error(`Slack listChannels failed: ${data.error ?? "unknown error"}`);
    }

    return data.channels.map((ch) => ({
      id: ch.id,
      name: ch.name,
      isMember: ch.is_member,
      isPrivate: ch.is_private,
    }));
  }

  async function postMessage(
    channelId: string,
    text: string,
    blocks?: unknown[],
  ): Promise<SlackPostMessageResponse> {
    interface SlackPostMessageRawResponse {
      ok: boolean;
      ts?: string;
      error?: string;
    }

    const body: Record<string, unknown> = {
      channel: channelId,
      text,
    };

    if (blocks) {
      body.blocks = blocks;
    }

    const data = await apiFetch<SlackPostMessageRawResponse>(
      "/chat.postMessage",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );

    if (!data.ok) {
      return { ok: false, error: data.error ?? "unknown error" };
    }

    return { ok: true, ts: data.ts ?? "" };
  }

  return { listChannels, postMessage };
}
