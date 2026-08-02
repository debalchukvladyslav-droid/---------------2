create or replace function public.guard_ai_market_replay_entries()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  features jsonb := coalesce(new.source_snapshot->'aiFeatures', '{}'::jsonb);
  replay jsonb := features->'marketReplay';
  guarded_sequence jsonb := '[]'::jsonb;
  replay_step jsonb;
  confidence numeric;
  visible_count integer := jsonb_array_length(coalesce(features->'evidence'->'visible', '[]'::jsonb));
  missing_text text := coalesce(features->'evidence'->'missing', '[]'::jsonb)::text;
  setup_score numeric;
  context_score numeric;
  entry_score numeric;
  should_guard boolean;
begin
  if new.prompt_version not like 'market-replay-v5.%'
     or replay is null
     or jsonb_typeof(replay->'sequence') <> 'array' then
    return new;
  end if;

  setup_score := nullif(features->'processScores'->>'setupValidity', '')::numeric;
  context_score := nullif(features->'processScores'->>'contextFit', '')::numeric;
  entry_score := nullif(features->'processScores'->>'entryQuality', '')::numeric;

  for replay_step in select value from jsonb_array_elements(replay->'sequence') loop
    confidence := coalesce(nullif(replay_step->>'confidence', '')::numeric, 0);
    should_guard := replay_step->>'decision' = 'ENTER' and (
      confidence < 0.70
      or visible_count < 2
      or coalesce(setup_score, 0) < 65
      or coalesce(context_score, 0) < 65
      or coalesce(entry_score, 0) < 65
      or missing_text ~* '(trigger|confirmation|entry marker|execution|direction)'
    );

    if should_guard then
      replay_step := replay_step
        || jsonb_build_object(
          'decision', 'WAIT',
          'reason', 'Guarded WAIT: entry evidence is not ready. ' || coalesce(replay_step->>'reason', ''),
          'guardReasons', jsonb_build_array('database_entry_evidence_guard')
        );
    end if;
    guarded_sequence := guarded_sequence || jsonb_build_array(replay_step);
  end loop;

  replay := jsonb_set(replay, '{sequence}', guarded_sequence, true);
  replay := jsonb_set(
    replay,
    '{finalDecision}',
    to_jsonb(coalesce(guarded_sequence->-1->>'decision', 'WAIT')),
    true
  );
  features := jsonb_set(features, '{marketReplay}', replay, true);
  new.source_snapshot := jsonb_set(new.source_snapshot, '{aiFeatures}', features, true);
  return new;
end;
$$;

drop trigger if exists guard_ai_market_replay_entries on public.ai_learning_examples;
create trigger guard_ai_market_replay_entries
before insert or update of source_snapshot, prompt_version
on public.ai_learning_examples
for each row execute function public.guard_ai_market_replay_entries();

update public.ai_learning_examples
set source_snapshot = source_snapshot
where prompt_version like 'market-replay-v5.%'
  and source_snapshot->'aiFeatures'->'marketReplay' is not null;
