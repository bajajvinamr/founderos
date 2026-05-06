import { z } from "zod";
import { APPROVAL_TYPES } from "../constants.js";

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().uuid().optional().nullable(),
  payload: z.record(z.unknown()),
  issueIds: z.array(z.string().uuid()).optional(),
  /** S6.2 — link this approval to a workflow_run so the UI can show
   *  "see full plan." Optional; non-workflow approvals (hire/budget/
   *  plugin) leave this null. */
  workflowRunId: z.string().uuid().optional().nullable(),
});

export type CreateApproval = z.infer<typeof createApprovalSchema>;

export const resolveApprovalSchema = z.object({
  decisionNote: z.string().optional().nullable(),
  decidedByUserId: z.string().optional().default("board"),
  /** S6.2 — when true on an approve action with a linked workflow_run,
   *  also bumps the parent workflow.autonomyLevel to 4 ("Approve and
   *  skip future similar approvals"). Goes through the existing
   *  guardAutonomousUpgrade path so the instance master switch still
   *  gates the change. */
  promoteWorkflowToAutonomous: z.boolean().optional().default(false),
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: z.string().optional().nullable(),
  decidedByUserId: z.string().optional().default("board"),
});

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z.object({
  payload: z.record(z.unknown()).optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: z.string().min(1),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;
