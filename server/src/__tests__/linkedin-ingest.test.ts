import { describe, it, expect, vi, beforeEach } from "vitest";
import { linkedinIngestService } from "../services/integrations/linkedin-ingest.js";
import { ingestEvent } from "../services/event-ingest-stub.js";
import * as composioClient from "../services/composio-client.js";

vi.mock("../services/event-ingest-stub.js");
vi.mock("../services/composio-client.js");

describe("linkedinIngestService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should ingest event and return event id", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockReturnValueOnce({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    composioConnectionId: "conn-123",
                    userId: "user-1",
                    appName: "linkedin",
                    status: "active",
                  },
                ]),
              }),
            }),
        }),
      }),
    };

    const mockIngestEvent = vi.mocked(ingestEvent);
    mockIngestEvent.mockResolvedValue({ eventId: "event-1", deduplicated: false });

    const mockExecuteTool = vi.mocked(composioClient.executeTool);
    mockExecuteTool
      .mockResolvedValueOnce({
        ok: true,
        output: {
          posts: [
            {
              id: "post-1",
              text: "Test post",
              createdAt: new Date().toISOString(),
              likeCount: 5,
              commentCount: 2,
              shareCount: 1,
              impressionCount: 100,
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        output: {
          likeCount: 5,
          commentCount: 2,
          shareCount: 1,
          impressionCount: 100,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        output: {
          followerCount: 1000,
        },
      });

    const result = await linkedinIngestService({
      companyId: "company-1",
      db: mockDb as any,
    });

    expect(result.postsProcessed).toBe(1);
    expect(result.followersProcessed).toBe(1);
    expect(result.syncedAt).toBeInstanceOf(Date);
    expect(result.nextSyncAt).toBeInstanceOf(Date);

    // Verify ingestEvent was called with correct payload
    expect(mockIngestEvent).toHaveBeenCalledTimes(2);
    const firstCall = mockIngestEvent.mock.calls[0][0];
    expect(firstCall.source).toBe("linkedin");
    expect(firstCall.eventName).toBe("post.metrics_snapshot");
    expect(firstCall.sourceEventId).toMatch(/^post-1:/);
  });

  it("should handle multiple posts with dedup contract", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockReturnValueOnce({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    composioConnectionId: "conn-123",
                    userId: "user-1",
                    appName: "linkedin",
                    status: "active",
                  },
                ]),
              }),
            }),
        }),
      }),
    };

    const mockIngestEvent = vi.mocked(ingestEvent);
    mockIngestEvent.mockResolvedValue({ eventId: "stub-unique-id", deduplicated: false });

    const mockExecuteTool = vi.mocked(composioClient.executeTool);
    mockExecuteTool
      .mockResolvedValueOnce({
        ok: true,
        output: {
          posts: [
            {
              id: "post-1",
              text: "Post A",
              createdAt: new Date().toISOString(),
              likeCount: 10,
            },
            {
              id: "post-2",
              text: "Post B",
              createdAt: new Date().toISOString(),
              likeCount: 5,
            },
          ],
        },
      })
      // metrics for post-1
      .mockResolvedValueOnce({
        ok: true,
        output: { likeCount: 10, commentCount: 2, shareCount: 0, impressionCount: 200 },
      })
      // metrics for post-2
      .mockResolvedValueOnce({
        ok: true,
        output: { likeCount: 5, commentCount: 1, shareCount: 0, impressionCount: 100 },
      })
      // followers
      .mockResolvedValueOnce({
        ok: true,
        output: { followerCount: 1500 },
      });

    const result = await linkedinIngestService({
      companyId: "company-1",
      db: mockDb as any,
    });

    expect(result.postsProcessed).toBe(2);
    expect(result.followersProcessed).toBe(1);
    expect(mockIngestEvent).toHaveBeenCalledTimes(3); // 2 posts + 1 follower event
  });

  it("should handle follower snapshot events", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockReturnValueOnce({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    composioConnectionId: "conn-123",
                    userId: "user-1",
                    appName: "linkedin",
                    status: "active",
                  },
                ]),
              }),
            }),
        }),
      }),
    };

    const mockIngestEvent = vi.mocked(ingestEvent);
    mockIngestEvent.mockResolvedValue({ eventId: "follower-event", deduplicated: false });

    const mockExecuteTool = vi.mocked(composioClient.executeTool);
    mockExecuteTool
      .mockResolvedValueOnce({
        ok: true,
        output: {
          posts: [],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        output: {
          followerCount: 2500,
        },
      });

    const result = await linkedinIngestService({
      companyId: "company-1",
      db: mockDb as any,
    });

    expect(result.followersProcessed).toBe(1);
    expect(mockIngestEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "linkedin",
        entityType: "profile",
        eventName: "profile.followers_snapshot",
        payload: { followerCount: 2500 },
      }),
    );
  });

  it("should prevent cross-org leaks via sourceEventId structure", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockReturnValueOnce({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    composioConnectionId: "conn-123",
                    userId: "user-1",
                    appName: "linkedin",
                    status: "active",
                  },
                ]),
              }),
            }),
        }),
      }),
    };

    const mockIngestEvent = vi.mocked(ingestEvent);
    mockIngestEvent.mockResolvedValue({ eventId: "event-org-a", deduplicated: false });

    const mockExecuteTool = vi.mocked(composioClient.executeTool);
    mockExecuteTool
      .mockResolvedValueOnce({
        ok: true,
        output: {
          posts: [
            {
              id: "shared-post-id",
              text: "Public post",
              createdAt: new Date().toISOString(),
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        output: {
          likeCount: 0,
          commentCount: 0,
          shareCount: 0,
          impressionCount: 50,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        output: {
          followerCount: 500,
        },
      });

    const result = await linkedinIngestService({
      companyId: "org-a-company",
      db: mockDb as any,
    });

    expect(result.postsProcessed).toBe(1);

    // Verify that sourceEventId is scoped by post + date, not shared globally
    const ingestedEvents = mockIngestEvent.mock.calls;
    const postEvent = ingestedEvents.find(
      (call) => call[0].eventName === "post.metrics_snapshot",
    );
    expect(postEvent).toBeDefined();
    expect(postEvent![0].sourceEventId).toMatch(/^shared-post-id:/);
    expect(postEvent![0].companyId).toBe("org-a-company");
  });
});
