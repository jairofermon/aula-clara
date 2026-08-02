-- O worker normaliza os blocos para FLAC mono/16 kHz antes da transcrição.
update storage.buckets
set allowed_mime_types = array[
  'audio/flac',
  'audio/m4a',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-flac',
  'audio/x-m4a',
  'audio/x-wav',
  'audio/webm',
  'video/mp4',
  'video/webm'
]
where id = 'class-audio';
