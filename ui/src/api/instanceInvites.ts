import { api } from "./client";

export type InstanceInviteRole = "instance_admin" | "instance_member";

export interface InstanceInviteSummary {
  id: string;
  email: string;
  role: InstanceInviteRole;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

export interface CreateInviteRequest {
  email: string;
  role: InstanceInviteRole;
}

export interface CreateInviteResponse {
  id: string;
  email: string;
  role: InstanceInviteRole;
  expiresAt: string;
  signupUrl: string;
}

export interface InstanceMemberSummary {
  userId: string;
  role: string;
  name: string | null;
  email: string | null;
  roleCreatedAt: string;
}

export const instanceInvitesApi = {
  list: () => api.get<InstanceInviteSummary[]>("/instance/invites"),
  create: (body: CreateInviteRequest) =>
    api.post<CreateInviteResponse>("/instance/invites", body),
  revoke: (id: string) =>
    api.delete<void>(`/instance/invites/${encodeURIComponent(id)}`),
  listMembers: () => api.get<InstanceMemberSummary[]>("/instance/members"),
};
