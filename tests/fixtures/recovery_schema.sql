-- Schema-only fixture derived from production PostgreSQL catalogs. No user data.
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create schema storage; create schema vault; create schema net;
create table auth.users(id uuid primary key);
create table vault.decrypted_secrets(name text,decrypted_secret text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select jsonb_build_object('sub',auth.uid(),'role',coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'authenticated')) $$;
create function public.uuid_generate_v4() returns uuid language sql volatile as $$ select gen_random_uuid() $$;
create function public.app_is_admin() returns boolean language sql stable as $$ select coalesce(current_setting('test.admin',true),'false')='true' $$;
create function public.app_is_approved() returns boolean language sql stable as $$ select true $$;
create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as $$ select 1::bigint $$;
create table storage.buckets(id text primary key,name text not null,public boolean default false,file_size_limit bigint);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text not null,name text not null,metadata jsonb default '{}',created_at timestamptz default now(),updated_at timestamptz default now(),unique(bucket_id,name));
create table public.ai_coach_insights (
id uuid not null default gen_random_uuid(),
user_id uuid not null,
trade_date date not null,
insight_type text not null default 'session_review'::text,
status text not null default 'ready'::text,
severity text not null default 'info'::text,
title text not null,
summary text not null,
evidence jsonb not null default '[]'::jsonb,
recommendations jsonb not null default '[]'::jsonb,
trading_dna_patch jsonb not null default '{}'::jsonb,
context_snapshot jsonb not null default '{}'::jsonb,
model_name text,
prompt_version text not null default 'proactive-coach-v1'::text,
created_at timestamp with time zone not null default now(),
updated_at timestamp with time zone not null default now()
);
create table public.ai_evaluation_cases (
id uuid not null default gen_random_uuid(),
example_id uuid,
user_id uuid not null,
expected_pattern_key text not null,
expected_features jsonb not null default '{}'::jsonb,
trade_date date,
dataset_split text not null default 'test'::text,
reviewer_note text,
active boolean not null default true,
created_by uuid,
created_at timestamp with time zone not null default now(),
updated_at timestamp with time zone not null default now()
);
create table public.ai_evaluation_results (
id uuid not null default gen_random_uuid(),
case_id uuid not null,
run_id uuid,
prompt_version text not null,
model_name text not null,
predicted_pattern_key text,
confidence numeric,
exact_match boolean not null default false,
evidence_complete boolean not null default false,
result jsonb not null default '{}'::jsonb,
error_message text,
created_at timestamp with time zone not null default now()
);
create table public.ai_feedback (
id uuid not null default gen_random_uuid(),
user_id uuid not null,
insight_id uuid,
rating smallint not null,
correction text,
context jsonb not null default '{}'::jsonb,
training_status text not null default 'pending'::text,
reviewed_by uuid,
reviewed_at timestamp with time zone,
created_at timestamp with time zone not null default now()
);
create table public.ai_learning_examples (
id uuid not null default gen_random_uuid(),
user_id uuid not null,
journal_day_id uuid,
trade_date date not null,
trade_key text not null,
content_hash text not null,
source_version integer not null default 1,
source_snapshot jsonb not null default '{}'::jsonb,
outcome jsonb not null default '{}'::jsonb,
screenshot_path text,
screenshot_mime_type text,
ai_pattern_key text,
ai_label text,
ai_confidence numeric,
ai_explanation text,
visual_evidence text,
journal_evidence text,
alternative_pattern_key text,
review_status text not null default 'pending'::text,
reviewed_pattern_key text,
review_note text,
reviewed_by uuid,
reviewed_at timestamp with time zone,
embedding text,
model_name text not null default 'gemini-2.5-flash'::text,
prompt_version text not null default 'entry-mistake-v1'::text,
run_id uuid,
is_current boolean not null default true,
error_message text,
created_at timestamp with time zone not null default now(),
updated_at timestamp with time zone not null default now(),
outcome_group text,
chart_summary text,
evidence jsonb not null default '{}'::jsonb,
decision_source text not null default 'model'::text,
actual_model_name text
);
create table public.ai_learning_jobs (
id uuid not null default gen_random_uuid(),
prompt_version text not null,
status text not null default 'running'::text,
include_saved_examples boolean not null default true,
processed_count integer not null default 0,
failed_count integer not null default 0,
batch_count integer not null default 0,
last_run_id uuid,
last_error text,
created_by uuid,
started_at timestamp with time zone not null default now(),
heartbeat_at timestamp with time zone not null default now(),
completed_at timestamp with time zone,
updated_at timestamp with time zone not null default now(),
consecutive_failures integer not null default 0,
remaining_count integer
);
create table public.ai_learning_runs (
id uuid not null default gen_random_uuid(),
trigger_type text not null,
status text not null default 'running'::text,
model_name text not null default 'gemini-2.5-flash'::text,
prompt_version text not null default 'entry-mistake-v1'::text,
scanned_count integer not null default 0,
created_count integer not null default 0,
processed_count integer not null default 0,
skipped_count integer not null default 0,
failed_count integer not null default 0,
estimated_cost_usd numeric not null default 0,
error_summary jsonb not null default '[]'::jsonb,
started_at timestamp with time zone not null default now(),
finished_at timestamp with time zone,
created_by uuid
);
create table public.ai_learning_versions (
id bigint not null generated by default as identity,
prompt_version text not null,
memory_version integer not null default 0,
model_name text not null default 'gemini-2.5-flash'::text,
metrics jsonb not null default '{}'::jsonb,
active boolean not null default true,
created_at timestamp with time zone not null default now()
);
create table public.ai_paper_signals (
id uuid not null default gen_random_uuid(),
user_id uuid not null,
learning_example_id uuid,
observed_at timestamp with time zone not null default now(),
ticker text not null,
action text not null,
pattern_key text not null,
confidence numeric(5,4) not null,
decision jsonb not null default '{}'::jsonb,
source_cutoff_at timestamp with time zone not null,
entry_price numeric,
stop_price numeric,
target_price numeric,
resolved_at timestamp with time zone,
outcome_r numeric,
outcome_source text,
created_at timestamp with time zone not null default now()
);
create table public.ai_request_logs (
id uuid not null default gen_random_uuid(),
user_id uuid,
request_type text not null default 'gemini'::text,
model text,
status text not null default 'pending'::text,
used boolean not null default false,
request_payload jsonb,
response_preview text,
error_message text,
created_at timestamp with time zone not null default now(),
used_at timestamp with time zone
);
create table public.ai_user_patterns (
id uuid not null default gen_random_uuid(),
user_id uuid not null,
dimension text not null,
pattern_key text not null,
sample_size integer not null,
outcome_sample_size integer not null,
wins integer not null,
losses integer not null,
win_rate double precision,
baseline_win_rate double precision,
lift double precision,
average_pnl double precision,
reliability text not null,
statistics jsonb not null default '{}'::jsonb,
active boolean not null default true,
calculated_at timestamp with time zone not null default now()
);
create table public.ai_worker_wake_tokens (
token uuid not null default gen_random_uuid(),
expires_at timestamp with time zone not null default (now() + '00:10:00'::interval),
created_at timestamp with time zone not null default now()
);
create table public.bots (
id bigint not null generated by default as identity,
name text not null default 'Service bot'::text,
bot_type text not null default 'service'::text,
api_key text,
user_id uuid,
extra_data jsonb not null default '{}'::jsonb,
enabled boolean not null default true,
last_used_at timestamp with time zone,
created_at timestamp with time zone not null default now(),
updated_at timestamp with time zone not null default now(),
api_key_hash text
);
create table public.daily_reviews (
id uuid not null default gen_random_uuid(),
user_id uuid not null,
trade_date date not null,
status text not null default 'ready'::text,
debrief text not null,
strengths jsonb not null default '[]'::jsonb,
mistakes jsonb not null default '[]'::jsonb,
next_session_rules jsonb not null default '[]'::jsonb,
evidence jsonb not null default '{}'::jsonb,
model_name text not null default ''::text,
created_at timestamp with time zone not null default now(),
updated_at timestamp with time zone not null default now()
);
create table public.google_sheet_sync_configs (
id bigint not null generated by default as identity,
user_id uuid not null,
spreadsheet_id text not null,
sheet_title text default ''::text,
selected_file_name text default ''::text,
data_start_row integer,
config jsonb not null default '{}'::jsonb,
enabled boolean not null default false,
last_sync_at timestamp with time zone,
last_sync_status text,
last_sync_error text,
created_at timestamp with time zone not null default now(),
updated_at timestamp with time zone not null default now()
);
create table public.journal_backups (
id bigint not null generated by default as identity,
backup_id text not null,
user_id uuid not null,
reason text default 'backup'::text,
nick text,
backup_created_at timestamp with time zone default now(),
backup_data jsonb not null,
raw_bytes integer default 0,
stored_bytes integer default 0,
days integer default 0,
encoding text default ''::text,
created_at timestamp with time zone default now()
);
create table public.journal_days (
id uuid not null default uuid_generate_v4(),
user_id uuid not null,
trade_date date not null,
pnl numeric,
gross_pnl numeric,
commissions numeric,
locates numeric,
kf numeric,
notes text,
mentor_comment text,
ai_advice text,
daily_metrics jsonb,
sync_version bigint not null default 1,
created_at timestamp with time zone not null default now(),
updated_at timestamp with time zone not null default now()
);
create table public.journal_months (
id bigint not null generated by default as identity,
user_doc_name text not null,
nick text,
month_key text not null,
data jsonb default '{}'::jsonb,
created_at timestamp with time zone default now(),
updated_at timestamp with time zone default now()
);
create table public.market_best_exit_cache (
symbol text not null,
trade_date date not null,
entry_minute smallint not null,
low_price numeric not null,
low_at timestamp with time zone not null,
provider text not null default 'polygon'::text,
updated_at timestamp with time zone not null default now()
);
create table public.market_intraday_cache_status (
symbol text not null,
trade_date date not null,
from_minute smallint not null default 540,
to_minute smallint not null default 720,
bar_count smallint not null default 0,
cache_version smallint not null default 1,
provider text not null default 'polygon'::text,
fetched_at timestamp with time zone not null default now()
);
create table public.market_low_jobs (
symbol text not null,
trade_date date not null,
status text not null default 'pending'::text,
attempts smallint not null default 0,
next_attempt_at timestamp with time zone not null default now(),
attempted_at timestamp with time zone,
last_error text not null default ''::text,
created_at timestamp with time zone not null default now(),
updated_at timestamp with time zone not null default now()
);
create table public.market_time_price_cache (
symbol text not null,
trade_date date not null,
target_minute smallint not null,
close_price numeric not null,
price_at timestamp with time zone not null,
provider text not null default 'polygon'::text,
updated_at timestamp with time zone not null default now(),
high_price numeric,
high_at timestamp with time zone,
open_price numeric,
low_price numeric,
volume numeric,
vwap numeric,
transactions bigint
);
create table public.polygon_worker_wake_tokens (
token uuid not null default gen_random_uuid(),
expires_at timestamp with time zone not null default (now() + '00:05:00'::interval),
created_at timestamp with time zone not null default now()
);
create table public.profiles (
id uuid not null,
nick text not null,
first_name text,
last_name text,
team_id uuid,
role text default 'trader'::text,
settings jsonb,
email text,
team text,
mentor_enabled boolean default false,
gemini_api_key text,
private_notes jsonb default '{}'::jsonb,
created_at timestamp with time zone default now(),
updated_at timestamp with time zone default now()
);
create table public.screenshots (
id uuid not null default uuid_generate_v4(),
journal_id uuid,
storage_path text not null,
category text,
tags text[],
user_id uuid,
created_at timestamp with time zone not null default now(),
source text not null default 'upload'::text,
source_file_id text,
original_name text,
mime_type text,
source_created_at timestamp with time zone,
source_modified_at timestamp with time zone,
updated_at timestamp with time zone not null default now(),
ticker text,
trade_key text,
screenshot_role text not null default 'unknown'::text,
captured_at timestamp with time zone,
pixel_width integer,
pixel_height integer,
byte_size bigint,
quality_status text not null default 'unchecked'::text,
quality_details jsonb not null default '{}'::jsonb
);
create table public.stop_mistakes (
id uuid not null default gen_random_uuid(),
user_id uuid not null,
title text not null,
description text not null default ''::text,
sort_order integer not null default 0,
archived boolean not null default false,
created_at timestamp with time zone not null default now(),
updated_at timestamp with time zone not null default now()
);
create table public.stop_review_mistakes (
review_id uuid not null,
mistake_id uuid not null,
created_at timestamp with time zone not null default now()
);
create table public.stop_reviews (
id uuid not null default gen_random_uuid(),
user_id uuid not null,
trade_date date not null,
symbol text not null,
trade_refs jsonb not null default '[]'::jsonb,
screenshot_paths jsonb not null default '[]'::jsonb,
initial_status text,
final_status text,
active boolean not null default true,
created_at timestamp with time zone not null default now(),
updated_at timestamp with time zone not null default now()
);
create table public.teams (
id uuid not null default uuid_generate_v4(),
name text not null,
created_at timestamp with time zone default now()
);
create table public.trade_embeddings (
id uuid not null default gen_random_uuid(),
journal_day_id uuid not null,
user_id uuid not null,
trade_key text not null,
trade_text text not null,
content_hash text not null,
embedding text not null,
embedding_model text not null default 'Supabase/gte-small'::text,
embedded_at timestamp with time zone not null default now(),
created_at timestamp with time zone not null default now(),
updated_at timestamp with time zone not null default now()
);
create table public.trade_multimodal_inputs (
id uuid not null default gen_random_uuid(),
user_id uuid not null,
journal_day_id uuid,
trade_embedding_id uuid,
trade_key text,
audio_transcript text not null default ''::text,
chart_image_url text not null default ''::text,
vision_analysis text not null default ''::text,
ai_confidence_score integer,
created_at timestamp with time zone not null default now(),
updated_at timestamp with time zone not null default now()
);
alter table public.ai_coach_insights add constraint ai_coach_insights_pkey PRIMARY KEY (id);
alter table public.ai_coach_insights add constraint ai_coach_insights_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text, 'dismissed'::text])));
alter table public.ai_coach_insights add constraint ai_coach_insights_insight_type_check CHECK ((insight_type = ANY (ARRAY['session_review'::text, 'risk_warning'::text, 'weekly_pattern'::text])));
alter table public.ai_coach_insights add constraint ai_coach_insights_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'attention'::text, 'risk'::text])));
alter table public.ai_coach_insights add constraint ai_coach_insights_user_id_trade_date_insight_type_prompt_ve_key UNIQUE (user_id, trade_date, insight_type, prompt_version);
alter table public.ai_evaluation_cases add constraint ai_evaluation_cases_dataset_split_check CHECK ((dataset_split = ANY (ARRAY['train'::text, 'validation'::text, 'test'::text])));
alter table public.ai_evaluation_cases add constraint ai_evaluation_cases_pkey PRIMARY KEY (id);
alter table public.ai_evaluation_results add constraint ai_evaluation_results_pkey PRIMARY KEY (id);
alter table public.ai_feedback add constraint ai_feedback_training_status_check CHECK ((training_status = ANY (ARRAY['pending'::text, 'reviewed'::text, 'accepted'::text, 'rejected'::text, 'exported'::text])));
alter table public.ai_feedback add constraint ai_feedback_user_id_insight_id_key UNIQUE (user_id, insight_id);
alter table public.ai_feedback add constraint ai_feedback_rating_check CHECK ((rating = ANY (ARRAY['-1'::integer, 1])));
alter table public.ai_feedback add constraint ai_feedback_pkey PRIMARY KEY (id);
alter table public.ai_feedback add constraint ai_feedback_correction_check CHECK ((char_length(correction) <= 2000));
alter table public.ai_learning_examples add constraint ai_learning_examples_outcome_group_check CHECK (((outcome_group IS NULL) OR (outcome_group = ANY (ARRAY['loss'::text, 'profit'::text, 'neutral'::text]))));
alter table public.ai_learning_examples add constraint ai_learning_examples_content_hash_key UNIQUE (content_hash);
alter table public.ai_learning_examples add constraint ai_learning_examples_review_status_check CHECK ((review_status = ANY (ARRAY['pending'::text, 'approved'::text, 'corrected'::text, 'rejected'::text])));
alter table public.ai_learning_examples add constraint ai_learning_examples_pkey PRIMARY KEY (id);
alter table public.ai_learning_jobs add constraint ai_learning_jobs_pkey PRIMARY KEY (id);
alter table public.ai_learning_jobs add constraint ai_learning_jobs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'stopped'::text])));
alter table public.ai_learning_runs add constraint ai_learning_runs_pkey PRIMARY KEY (id);
alter table public.ai_learning_runs add constraint ai_learning_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'partial'::text, 'failed'::text])));
alter table public.ai_learning_runs add constraint ai_learning_runs_trigger_type_check CHECK ((trigger_type = ANY (ARRAY['manual'::text, 'cron'::text, 'job'::text, 'evaluation'::text])));
alter table public.ai_learning_versions add constraint ai_learning_versions_pkey PRIMARY KEY (id);
alter table public.ai_paper_signals add constraint ai_paper_signal_no_future_source CHECK ((source_cutoff_at <= observed_at));
alter table public.ai_paper_signals add constraint ai_paper_signal_prices_complete CHECK (((action = 'SKIP'::text) OR ((entry_price IS NOT NULL) AND (stop_price IS NOT NULL) AND (target_price IS NOT NULL))));
alter table public.ai_paper_signals add constraint ai_paper_signals_action_check CHECK ((action = ANY (ARRAY['LONG'::text, 'SHORT'::text, 'SKIP'::text])));
alter table public.ai_paper_signals add constraint ai_paper_signals_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)));
alter table public.ai_paper_signals add constraint ai_paper_signals_pkey PRIMARY KEY (id);
alter table public.ai_request_logs add constraint ai_request_logs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text])));
alter table public.ai_request_logs add constraint ai_request_logs_pkey PRIMARY KEY (id);
alter table public.ai_user_patterns add constraint ai_user_patterns_pkey PRIMARY KEY (id);
alter table public.ai_user_patterns add constraint ai_user_patterns_reliability_check CHECK ((reliability = ANY (ARRAY['exploratory'::text, 'moderate'::text, 'strong'::text])));
alter table public.ai_user_patterns add constraint ai_user_patterns_user_id_dimension_pattern_key_key UNIQUE (user_id, dimension, pattern_key);
alter table public.ai_worker_wake_tokens add constraint ai_worker_wake_tokens_pkey PRIMARY KEY (token);
alter table public.bots add constraint bots_api_key_key UNIQUE (api_key);
alter table public.bots add constraint bots_pkey PRIMARY KEY (id);
alter table public.daily_reviews add constraint daily_reviews_pkey PRIMARY KEY (id);
alter table public.daily_reviews add constraint daily_reviews_debrief_check CHECK (((char_length(debrief) >= 20) AND (char_length(debrief) <= 16000)));
alter table public.daily_reviews add constraint daily_reviews_user_id_trade_date_key UNIQUE (user_id, trade_date);
alter table public.daily_reviews add constraint daily_reviews_status_check CHECK ((status = ANY (ARRAY['ready'::text, 'partial'::text, 'failed'::text])));
alter table public.google_sheet_sync_configs add constraint google_sheet_sync_configs_pkey PRIMARY KEY (id);
alter table public.google_sheet_sync_configs add constraint google_sheet_sync_configs_user_id_spreadsheet_id_sheet_titl_key UNIQUE (user_id, spreadsheet_id, sheet_title);
alter table public.journal_backups add constraint journal_backups_pkey PRIMARY KEY (id);
alter table public.journal_backups add constraint journal_backups_user_id_backup_id_key UNIQUE (user_id, backup_id);
alter table public.journal_days add constraint journal_days_user_id_trade_date_key UNIQUE (user_id, trade_date);
alter table public.journal_days add constraint journal_days_pkey PRIMARY KEY (id);
alter table public.journal_months add constraint journal_months_user_doc_name_month_key_key UNIQUE (user_doc_name, month_key);
alter table public.journal_months add constraint journal_months_pkey PRIMARY KEY (id);
alter table public.market_best_exit_cache add constraint market_best_exit_cache_low_price_check CHECK ((low_price > (0)::numeric));
alter table public.market_best_exit_cache add constraint market_best_exit_cache_entry_minute_check CHECK (((entry_minute >= 570) AND (entry_minute < 720)));
alter table public.market_best_exit_cache add constraint market_best_exit_cache_pkey PRIMARY KEY (symbol, trade_date, entry_minute);
alter table public.market_best_exit_cache add constraint market_best_exit_cache_symbol_check CHECK ((symbol ~ '^[A-Z]{1,10}$'::text));
alter table public.market_intraday_cache_status add constraint market_intraday_cache_status_pkey PRIMARY KEY (symbol, trade_date);
alter table public.market_intraday_cache_status add constraint market_intraday_cache_status_symbol_check CHECK ((symbol ~ '^[A-Z]{1,10}$'::text));
alter table public.market_low_jobs add constraint market_low_jobs_symbol_check CHECK ((symbol ~ '^[A-Z]{1,10}$'::text));
alter table public.market_low_jobs add constraint market_low_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'ready'::text, 'failed'::text])));
alter table public.market_low_jobs add constraint market_low_jobs_pkey PRIMARY KEY (symbol, trade_date);
alter table public.market_time_price_cache add constraint market_time_price_cache_pkey PRIMARY KEY (symbol, trade_date, target_minute);
alter table public.market_time_price_cache add constraint market_time_price_cache_target_minute_check CHECK (((target_minute >= 240) AND (target_minute <= 1200)));
alter table public.market_time_price_cache add constraint market_time_price_cache_close_price_check CHECK ((close_price > (0)::numeric));
alter table public.market_time_price_cache add constraint market_time_price_cache_symbol_check CHECK ((symbol ~ '^[A-Z]{1,10}$'::text));
alter table public.polygon_worker_wake_tokens add constraint polygon_worker_wake_tokens_pkey PRIMARY KEY (token);
alter table public.profiles add constraint profiles_pkey PRIMARY KEY (id);
alter table public.profiles add constraint profiles_nick_key UNIQUE (nick);
alter table public.screenshots add constraint screenshots_role_check CHECK ((screenshot_role = ANY (ARRAY['pre_entry'::text, 'entry'::text, 'exit'::text, 'post_exit'::text, 'earliest_unknown'::text, 'latest_unknown'::text, 'unknown'::text])));
alter table public.screenshots add constraint screenshots_pkey PRIMARY KEY (id);
alter table public.stop_mistakes add constraint stop_mistakes_pkey PRIMARY KEY (id);
alter table public.stop_mistakes add constraint stop_mistakes_title_check CHECK ((length(btrim(title)) > 0));
alter table public.stop_review_mistakes add constraint stop_review_mistakes_pkey PRIMARY KEY (review_id, mistake_id);
alter table public.stop_reviews add constraint stop_reviews_pkey PRIMARY KEY (id);
alter table public.stop_reviews add constraint stop_reviews_symbol_check CHECK ((length(btrim(symbol)) > 0));
alter table public.stop_reviews add constraint stop_reviews_user_id_trade_date_symbol_key UNIQUE (user_id, trade_date, symbol);
alter table public.stop_reviews add constraint stop_reviews_final_status_check CHECK ((final_status = ANY (ARRAY['normal'::text, 'bad'::text])));
alter table public.stop_reviews add constraint stop_reviews_initial_status_check CHECK ((initial_status = ANY (ARRAY['normal'::text, 'bad'::text, 'uncertain'::text])));
alter table public.teams add constraint teams_name_key UNIQUE (name);
alter table public.teams add constraint teams_pkey PRIMARY KEY (id);
alter table public.trade_embeddings add constraint trade_embeddings_journal_day_id_trade_key_key UNIQUE (journal_day_id, trade_key);
alter table public.trade_embeddings add constraint trade_embeddings_content_hash_check CHECK ((content_hash ~ '^[a-f0-9]{64}$'::text));
alter table public.trade_embeddings add constraint trade_embeddings_trade_text_check CHECK (((char_length(trade_text) >= 20) AND (char_length(trade_text) <= 8000)));
alter table public.trade_embeddings add constraint trade_embeddings_trade_key_check CHECK ((trade_key ~ '^[a-f0-9]{64}$'::text));
alter table public.trade_embeddings add constraint trade_embeddings_pkey PRIMARY KEY (id);
alter table public.trade_multimodal_inputs add constraint trade_multimodal_inputs_ai_confidence_score_check CHECK (((ai_confidence_score >= 0) AND (ai_confidence_score <= 100)));
alter table public.trade_multimodal_inputs add constraint trade_multimodal_inputs_pkey PRIMARY KEY (id);
alter table public.trade_multimodal_inputs add constraint trade_multimodal_inputs_vision_analysis_check CHECK ((char_length(vision_analysis) <= 8000));
alter table public.trade_multimodal_inputs add constraint trade_multimodal_inputs_chart_image_url_check CHECK ((char_length(chart_image_url) <= 1200));
alter table public.trade_multimodal_inputs add constraint trade_multimodal_inputs_audio_transcript_check CHECK ((char_length(audio_transcript) <= 8000));
alter table public.ai_coach_insights add constraint ai_coach_insights_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.ai_evaluation_cases add constraint ai_evaluation_cases_example_id_fkey FOREIGN KEY (example_id) REFERENCES ai_learning_examples(id) ON DELETE SET NULL;
alter table public.ai_evaluation_cases add constraint ai_evaluation_cases_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.ai_evaluation_cases add constraint ai_evaluation_cases_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.ai_evaluation_results add constraint ai_evaluation_results_case_id_fkey FOREIGN KEY (case_id) REFERENCES ai_evaluation_cases(id) ON DELETE CASCADE;
alter table public.ai_evaluation_results add constraint ai_evaluation_results_run_id_fkey FOREIGN KEY (run_id) REFERENCES ai_learning_runs(id) ON DELETE SET NULL;
alter table public.ai_feedback add constraint ai_feedback_insight_id_fkey FOREIGN KEY (insight_id) REFERENCES ai_coach_insights(id) ON DELETE CASCADE;
alter table public.ai_feedback add constraint ai_feedback_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES profiles(id);
alter table public.ai_feedback add constraint ai_feedback_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.ai_learning_examples add constraint ai_learning_examples_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.ai_learning_examples add constraint ai_learning_examples_journal_day_id_fkey FOREIGN KEY (journal_day_id) REFERENCES journal_days(id) ON DELETE CASCADE;
alter table public.ai_learning_examples add constraint ai_learning_examples_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.ai_learning_examples add constraint ai_learning_examples_run_id_fkey FOREIGN KEY (run_id) REFERENCES ai_learning_runs(id) ON DELETE SET NULL;
alter table public.ai_learning_jobs add constraint ai_learning_jobs_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.ai_learning_jobs add constraint ai_learning_jobs_last_run_id_fkey FOREIGN KEY (last_run_id) REFERENCES ai_learning_runs(id) ON DELETE SET NULL;
alter table public.ai_learning_runs add constraint ai_learning_runs_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.ai_paper_signals add constraint ai_paper_signals_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.ai_paper_signals add constraint ai_paper_signals_learning_example_id_fkey FOREIGN KEY (learning_example_id) REFERENCES ai_learning_examples(id) ON DELETE SET NULL;
alter table public.ai_request_logs add constraint ai_request_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.ai_user_patterns add constraint ai_user_patterns_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.bots add constraint bots_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.daily_reviews add constraint daily_reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.google_sheet_sync_configs add constraint google_sheet_sync_configs_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.journal_backups add constraint journal_backups_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.journal_days add constraint journal_days_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.profiles add constraint profiles_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id);
alter table public.profiles add constraint profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.screenshots add constraint screenshots_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.screenshots add constraint screenshots_journal_id_fkey FOREIGN KEY (journal_id) REFERENCES journal_days(id) ON DELETE CASCADE;
alter table public.stop_mistakes add constraint stop_mistakes_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.stop_review_mistakes add constraint stop_review_mistakes_review_id_fkey FOREIGN KEY (review_id) REFERENCES stop_reviews(id) ON DELETE CASCADE;
alter table public.stop_review_mistakes add constraint stop_review_mistakes_mistake_id_fkey FOREIGN KEY (mistake_id) REFERENCES stop_mistakes(id) ON DELETE RESTRICT;
alter table public.stop_reviews add constraint stop_reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.trade_embeddings add constraint trade_embeddings_journal_day_id_fkey FOREIGN KEY (journal_day_id) REFERENCES journal_days(id) ON DELETE CASCADE;
alter table public.trade_embeddings add constraint trade_embeddings_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.trade_multimodal_inputs add constraint trade_multimodal_inputs_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.trade_multimodal_inputs add constraint trade_multimodal_inputs_trade_embedding_id_fkey FOREIGN KEY (trade_embedding_id) REFERENCES trade_embeddings(id) ON DELETE SET NULL;
alter table public.trade_multimodal_inputs add constraint trade_multimodal_inputs_journal_day_id_fkey FOREIGN KEY (journal_day_id) REFERENCES journal_days(id) ON DELETE CASCADE;
create unique index screenshots_user_storage_path_key on public.screenshots(user_id,storage_path);
create unique index screenshots_user_source_file_key on public.screenshots(user_id,source,source_file_id) where source_file_id is not null;
grant usage on schema auth,storage,public to authenticated,anon,service_role;
grant select,insert,update,delete on all tables in schema public,storage to authenticated,service_role;
create function public.sync_journal_days_batch(jsonb) returns jsonb language sql as $$ select '{}'::jsonb $$;
create function public.touch_journal_day_sync_version() returns trigger language plpgsql as $$ begin new.updated_at:=now(); if tg_op='UPDATE' then new.sync_version:=greatest(old.sync_version+1,new.sync_version); end if; return new; end $$;
create trigger trg_journal_days_sync_version before insert or update on public.journal_days for each row execute function public.touch_journal_day_sync_version();
