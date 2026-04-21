-- Migration: 0058_permission_level
-- Adds permission_level column to agents table. Controls approval flow (default 'approve' for immediate execution).

ALTER TABLE "agents" ADD COLUMN "permission_level" text NOT NULL DEFAULT 'approve';
