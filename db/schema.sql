CREATE TABLE app.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL DEFAULT '',
  pronoun text NOT NULL DEFAULT 'they',
  status text NOT NULL DEFAULT 'active',
  is_demo boolean NOT NULL DEFAULT false,
  recovery_code_hash text NOT NULL DEFAULT '',
  recovery_shown_at timestamptz,
  reg_channel text NOT NULL DEFAULT 'web',
  reg_ip_hash text NOT NULL DEFAULT '',
  close_requested_at timestamptz,
  closed_at timestamptz,
  last_active_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL
);
CREATE INDEX users_reg_ip_created_idx ON app.users (reg_ip_hash, created_at);
CREATE INDEX users_status_created_idx ON app.users (status, created_at);

CREATE TABLE app.auth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.users (id),
  token_hash text NOT NULL UNIQUE,
  client text NOT NULL DEFAULT 'web',
  label text NOT NULL DEFAULT '',
  issued_ip_hash text NOT NULL DEFAULT '',
  revoked_at timestamptz,
  last_seen_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_created_idx ON app.auth_tokens (user_id, created_at);
CREATE INDEX auth_tokens_expires_idx ON app.auth_tokens (expires_at);

CREATE TABLE app.user_settings (
  user_id uuid PRIMARY KEY REFERENCES app.users (id),
  notify_types jsonb NOT NULL,
  quiet_start text NOT NULL DEFAULT '23:00',
  quiet_end text NOT NULL DEFAULT '08:00',
  daily_type_limit integer NOT NULL DEFAULT 3,
  checkin_remind_time text NOT NULL DEFAULT '21:30',
  allow_reply_from_stranger boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.users (id),
  wish_id uuid,
  purpose text NOT NULL,
  object_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending',
  mime_type text NOT NULL DEFAULT '',
  size_bytes bigint NOT NULL DEFAULT 0,
  width integer NOT NULL DEFAULT 0,
  height integer NOT NULL DEFAULT 0,
  sha256 text NOT NULL DEFAULT '',
  is_public boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  expires_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL
);
CREATE INDEX files_user_created_idx ON app.files (user_id, created_at);
CREATE INDEX files_sha_created_idx ON app.files (sha256, created_at);
CREATE INDEX files_status_created_idx ON app.files (status, created_at);
CREATE INDEX files_wish_idx ON app.files (wish_id);

CREATE TABLE app.wish_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  relation_code text NOT NULL,
  wish_type text NOT NULL DEFAULT '',
  content text NOT NULL,
  tone text NOT NULL DEFAULT '',
  batch integer NOT NULL DEFAULT 1,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wish_templates_relation_idx ON app.wish_templates (relation_code, is_active);

CREATE TABLE app.task_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wish_type text NOT NULL,
  relation_group text NOT NULL,
  task_type text NOT NULL,
  title text NOT NULL,
  proof_hint text NOT NULL DEFAULT '',
  self_focus text NOT NULL DEFAULT '',
  weekend_only boolean NOT NULL DEFAULT false,
  min_budget_band text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_templates_lookup_idx ON app.task_templates (wish_type, relation_group, task_type, is_active);

CREATE TABLE app.rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
  name text NOT NULL,
  price_min_cents integer NOT NULL DEFAULT 0,
  price_max_cents integer NOT NULL DEFAULT 0,
  wish_types jsonb NOT NULL,
  relation_groups jsonb NOT NULL,
  search_keyword text NOT NULL DEFAULT '',
  add_on_hint text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL
);
CREATE INDEX rewards_category_idx ON app.rewards (category, is_active);

CREATE TABLE app.wishes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.users (id),
  status text NOT NULL DEFAULT 'draft',
  outcome text NOT NULL DEFAULT '',
  relation_code text NOT NULL DEFAULT '',
  target_name text NOT NULL DEFAULT '',
  pronoun text NOT NULL DEFAULT 'they',
  wish_text text NOT NULL DEFAULT '',
  wish_type text NOT NULL DEFAULT '',
  wish_template_id uuid REFERENCES app.wish_templates (id),
  shown_template_ids jsonb NOT NULL,
  days integer NOT NULL DEFAULT 7,
  start_date text NOT NULL DEFAULT '',
  end_date text NOT NULL DEFAULT '',
  weekly_budget_cents integer NOT NULL DEFAULT 0,
  sign_method text NOT NULL DEFAULT '',
  signature_file_id uuid REFERENCES app.files (id),
  signed_at timestamptz,
  renew_count integer NOT NULL DEFAULT 0,
  extend_mode text NOT NULL DEFAULT '',
  is_public boolean NOT NULL DEFAULT false,
  replies_enabled boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  demo_session_id uuid,
  settled_at timestamptz,
  archived_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL
);
CREATE INDEX wishes_user_status_created_idx ON app.wishes (user_id, status, created_at);
CREATE INDEX wishes_user_start_idx ON app.wishes (user_id, start_date);
CREATE INDEX wishes_status_end_idx ON app.wishes (status, end_date);
CREATE INDEX wishes_type_status_idx ON app.wishes (wish_type, status);
CREATE INDEX wishes_demo_created_idx ON app.wishes (is_demo, created_at);

CREATE TABLE app.wish_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wish_id uuid NOT NULL UNIQUE REFERENCES app.wishes (id),
  user_id uuid NOT NULL REFERENCES app.users (id),
  q1_worry_enc text NOT NULL DEFAULT '',
  q1_gift_category text NOT NULL DEFAULT '',
  q2_alone_enc text NOT NULL DEFAULT '',
  q2_alone_level text NOT NULL DEFAULT '',
  q3_home_enc text NOT NULL DEFAULT '',
  q3_last_home text NOT NULL DEFAULT '',
  q3_travel_band text NOT NULL DEFAULT '',
  q3_cost_band text NOT NULL DEFAULT '',
  q4_disposable_enc text NOT NULL DEFAULT '',
  q4_disposable_band text NOT NULL DEFAULT '',
  q5_gift_enc text NOT NULL DEFAULT '',
  q5_reward_id uuid REFERENCES app.rewards (id),
  skipped jsonb NOT NULL,
  key_version text NOT NULL DEFAULT 'v1',
  health_consent boolean NOT NULL DEFAULT false,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL
);
CREATE INDEX wish_answers_user_idx ON app.wish_answers (user_id);

CREATE TABLE app.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wish_id uuid NOT NULL REFERENCES app.wishes (id),
  user_id uuid NOT NULL REFERENCES app.users (id),
  day_index integer NOT NULL,
  task_date text NOT NULL,
  week_start text NOT NULL DEFAULT '',
  task_type text NOT NULL,
  seq integer NOT NULL DEFAULT 1,
  title text NOT NULL,
  proof_hint text NOT NULL DEFAULT '',
  self_focus text NOT NULL DEFAULT '',
  template_id uuid REFERENCES app.task_templates (id),
  status text NOT NULL DEFAULT 'pending',
  done_at timestamptz,
  missed_at timestamptz,
  made_up_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL,
  UNIQUE (wish_id, template_id)
);
CREATE INDEX tasks_wish_date_idx ON app.tasks (wish_id, task_date);
CREATE INDEX tasks_wish_day_idx ON app.tasks (wish_id, day_index);
CREATE INDEX tasks_user_status_idx ON app.tasks (user_id, status);
CREATE INDEX tasks_status_date_idx ON app.tasks (status, task_date);

CREATE TABLE app.checkins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES app.tasks (id),
  wish_id uuid NOT NULL REFERENCES app.wishes (id),
  user_id uuid NOT NULL REFERENCES app.users (id),
  proof_file_id uuid REFERENCES app.files (id),
  proof_sha256 text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  is_makeup boolean NOT NULL DEFAULT false,
  is_duplicate_image boolean NOT NULL DEFAULT false,
  duplicate_of uuid REFERENCES app.checkins (id),
  channel text NOT NULL DEFAULT 'online',
  client_ts timestamptz,
  server_ts timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checkins_task_idx ON app.checkins (task_id);
CREATE INDEX checkins_user_server_idx ON app.checkins (user_id, server_ts);
CREATE INDEX checkins_wish_server_idx ON app.checkins (wish_id, server_ts);
CREATE INDEX checkins_proof_idx ON app.checkins (proof_file_id);

CREATE TABLE app.makeup_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wish_id uuid NOT NULL REFERENCES app.wishes (id),
  user_id uuid NOT NULL REFERENCES app.users (id),
  week_start text NOT NULL,
  week_index integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'available',
  task_id uuid REFERENCES app.tasks (id),
  used_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wish_id, week_start)
);
CREATE INDEX makeup_wish_status_idx ON app.makeup_tickets (wish_id, status);

CREATE TABLE app.ledger_weeks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wish_id uuid NOT NULL REFERENCES app.wishes (id),
  user_id uuid NOT NULL REFERENCES app.users (id),
  week_start text NOT NULL,
  week_index integer NOT NULL DEFAULT 1,
  budget_cents integer NOT NULL DEFAULT 0,
  spent_cents integer NOT NULL DEFAULT 0,
  saved_cents integer NOT NULL DEFAULT 0,
  earned_cents integer NOT NULL DEFAULT 0,
  counted boolean NOT NULL DEFAULT false,
  over_budget boolean NOT NULL DEFAULT false,
  proof_file_id uuid REFERENCES app.files (id),
  computed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL,
  UNIQUE (wish_id, week_start)
);
CREATE INDEX ledger_weeks_user_idx ON app.ledger_weeks (user_id, week_start);

CREATE TABLE app.ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wish_id uuid NOT NULL REFERENCES app.wishes (id),
  user_id uuid NOT NULL REFERENCES app.users (id),
  week_start text NOT NULL,
  entry_kind text NOT NULL,
  amount_cents integer NOT NULL DEFAULT 0,
  note text NOT NULL DEFAULT '',
  proof_file_id uuid REFERENCES app.files (id),
  task_id uuid REFERENCES app.tasks (id),
  source text NOT NULL DEFAULT 'manual',
  server_ts timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_wish_week_idx ON app.ledger_entries (wish_id, week_start);
CREATE INDEX ledger_entries_user_server_idx ON app.ledger_entries (user_id, server_ts);
CREATE INDEX ledger_entries_task_idx ON app.ledger_entries (task_id);

CREATE TABLE app.settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wish_id uuid NOT NULL REFERENCES app.wishes (id),
  user_id uuid NOT NULL REFERENCES app.users (id),
  version integer NOT NULL DEFAULT 1,
  outcome text NOT NULL DEFAULT '',
  sealed boolean NOT NULL DEFAULT false,
  must_total integer NOT NULL DEFAULT 0,
  must_done integer NOT NULL DEFAULT 0,
  money_total integer NOT NULL DEFAULT 0,
  money_done integer NOT NULL DEFAULT 0,
  budget_cents integer NOT NULL DEFAULT 0,
  spent_cents integer NOT NULL DEFAULT 0,
  saved_cents integer NOT NULL DEFAULT 0,
  earned_cents integer NOT NULL DEFAULT 0,
  total_cents integer NOT NULL DEFAULT 0,
  reward_id uuid REFERENCES app.rewards (id),
  reward_price_min_cents integer NOT NULL DEFAULT 0,
  reward_price_max_cents integer NOT NULL DEFAULT 0,
  gap_cents integer NOT NULL DEFAULT 0,
  gap_band text NOT NULL DEFAULT '',
  progress_ratio_bps integer NOT NULL DEFAULT 0,
  self_summary jsonb NOT NULL,
  letter_text text NOT NULL DEFAULT '',
  letter_updated_at timestamptz,
  card_file_id uuid REFERENCES app.files (id),
  letter_file_id uuid REFERENCES app.files (id),
  sealed_at timestamptz,
  revealed_at timestamptz,
  computed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wish_id, version)
);
CREATE INDEX settlements_user_created_idx ON app.settlements (user_id, created_at);
CREATE INDEX settlements_reward_idx ON app.settlements (reward_id);

CREATE TABLE app.share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wish_id uuid NOT NULL REFERENCES app.wishes (id),
  user_id uuid NOT NULL REFERENCES app.users (id),
  token text NOT NULL UNIQUE,
  visibility text NOT NULL DEFAULT 'link_only',
  include_flags jsonb NOT NULL,
  share_file_id uuid REFERENCES app.files (id),
  status text NOT NULL DEFAULT 'active',
  visits integer NOT NULL DEFAULT 0,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL,
  UNIQUE (wish_id)
);
CREATE INDEX share_user_created_idx ON app.share_links (user_id, created_at);

CREATE TABLE app.pool_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wish_id uuid NOT NULL REFERENCES app.wishes (id),
  author_id uuid NOT NULL REFERENCES app.users (id),
  category text NOT NULL,
  relation_code text NOT NULL DEFAULT '',
  excerpt text NOT NULL,
  display_label text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'published',
  is_anonymous boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  report_count integer NOT NULL DEFAULT 0,
  reply_count integer NOT NULL DEFAULT 0,
  fork_count integer NOT NULL DEFAULT 0,
  forked_from_id uuid REFERENCES app.pool_posts (id),
  published_at timestamptz NOT NULL,
  hidden_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL,
  UNIQUE (wish_id)
);
CREATE INDEX pool_status_published_idx ON app.pool_posts (status, published_at);
CREATE INDEX pool_category_published_idx ON app.pool_posts (category, published_at);
CREATE INDEX pool_status_reply_idx ON app.pool_posts (status, reply_count);
CREATE INDEX pool_author_created_idx ON app.pool_posts (author_id, created_at);

CREATE TABLE app.replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES app.pool_posts (id),
  wish_id uuid NOT NULL REFERENCES app.wishes (id),
  author_id uuid NOT NULL REFERENCES app.users (id),
  content text NOT NULL,
  status text NOT NULL DEFAULT 'published',
  is_demo boolean NOT NULL DEFAULT false,
  report_count integer NOT NULL DEFAULT 0,
  read_at timestamptz,
  hidden_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL
);
CREATE INDEX replies_post_created_idx ON app.replies (post_id, created_at);
CREATE INDEX replies_author_created_idx ON app.replies (author_id, created_at);
CREATE INDEX replies_status_created_idx ON app.replies (status, created_at);
CREATE INDEX replies_wish_created_idx ON app.replies (wish_id, created_at);

CREATE TABLE app.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  reporter_id uuid NOT NULL REFERENCES app.users (id),
  reason_code text NOT NULL,
  detail text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  action_taken text NOT NULL DEFAULT '',
  acted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_type, target_id, reporter_id)
);
CREATE INDEX reports_target_idx ON app.reports (target_type, target_id, created_at);
CREATE INDEX reports_reporter_idx ON app.reports (reporter_id, created_at);

CREATE TABLE app.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.users (id),
  type text NOT NULL,
  title text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  payload jsonb NOT NULL,
  channel text NOT NULL DEFAULT 'in_app',
  dedupe_key text,
  status text NOT NULL DEFAULT 'unread',
  delivered_at timestamptz,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX notifications_user_status_idx ON app.notifications (user_id, status, created_at);
CREATE INDEX notifications_user_type_idx ON app.notifications (user_id, type, created_at);

CREATE TABLE app.demo_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario text NOT NULL DEFAULT 'mom_knee',
  step integer NOT NULL DEFAULT 1,
  token_hash text NOT NULL UNIQUE,
  user_id uuid REFERENCES app.users (id),
  state jsonb NOT NULL,
  ip_hash text NOT NULL DEFAULT '',
  is_completed boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL
);
CREATE INDEX demo_ip_created_idx ON app.demo_sessions (ip_hash, created_at);
CREATE INDEX demo_expires_idx ON app.demo_sessions (expires_at);

CREATE TABLE app.ai_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.users (id),
  wish_id uuid REFERENCES app.wishes (id),
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  input_hash text NOT NULL DEFAULT '',
  redacted_input jsonb NOT NULL,
  output jsonb,
  validation_ok boolean NOT NULL DEFAULT false,
  fallback_used boolean NOT NULL DEFAULT false,
  error_code text NOT NULL DEFAULT '',
  duration_ms integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_jobs_user_created_idx ON app.ai_jobs (user_id, created_at);
CREATE INDEX ai_jobs_status_created_idx ON app.ai_jobs (status, created_at);

CREATE TABLE app.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES app.users (id),
  wish_id uuid REFERENCES app.wishes (id),
  name text NOT NULL,
  props jsonb NOT NULL,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_name_created_idx ON app.events (name, created_at);
CREATE INDEX events_user_created_idx ON app.events (user_id, created_at);
CREATE INDEX events_demo_created_idx ON app.events (is_demo, created_at);

CREATE TABLE app.idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal text NOT NULL,
  user_id uuid REFERENCES app.users (id),
  operation text NOT NULL,
  key text NOT NULL,
  fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'in_progress',
  resource_type text NOT NULL DEFAULT '',
  resource_id text NOT NULL DEFAULT '',
  result jsonb,
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (principal, operation, key)
);
CREATE INDEX idempotency_expires_idx ON app.idempotency_keys (expires_at);
CREATE INDEX idempotency_user_idx ON app.idempotency_keys (user_id, created_at);
