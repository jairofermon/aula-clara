-- Administradores podem organizar uma aula própria dentro de qualquer
-- disciplina visível. A propriedade da aula continua sendo de quem a incluiu;
-- membros continuam limitados por RLS às próprias disciplinas e aulas.
alter table public.classes
  drop constraint if exists subject_same_owner;
