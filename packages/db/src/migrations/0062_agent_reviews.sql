CREATE TABLE agent_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  month_of date NOT NULL,
  shifts_run integer NOT NULL DEFAULT 0,
  issues_closed integer NOT NULL DEFAULT 0,
  cost_cents integer NOT NULL DEFAULT 0,
  blocked_incidents integer NOT NULL DEFAULT 0,
  summary_markdown text NOT NULL,
  recommendation text NOT NULL,
  rationale text NOT NULL,
  source text NOT NULL DEFAULT 'auto',
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, month_of)
);

CREATE INDEX idx_agent_reviews_company_month ON agent_reviews (company_id, month_of DESC);
CREATE INDEX idx_agent_reviews_agent_month ON agent_reviews (agent_id, month_of DESC);
