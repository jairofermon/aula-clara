-- Alinha o bucket ao teto por arquivo do Supabase Free. O upload TUS divide a
-- transferencia, mas o objeto final continua limitado a 50 MiB.
update storage.buckets
set file_size_limit = 52428800
where id = 'class-audio';
