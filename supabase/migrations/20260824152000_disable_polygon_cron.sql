SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'polygon-durable-worker';
