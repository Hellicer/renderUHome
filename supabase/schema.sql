-- Supabase schema for shared apartment projects and per-user annotations.
-- Run once in the Supabase SQL Editor.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Користувач',
  created_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Мій проєкт',
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  plan jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.annotations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('measurement', 'wall_stroke', 'hidden_label')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.project_overlays (
  user_id uuid not null references auth.users(id) on delete cascade,
  target_project_id uuid not null references public.projects(id) on delete cascade,
  source_project_id uuid not null references public.projects(id) on delete cascade,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (user_id, target_project_id, source_project_id),
  check (target_project_id <> source_project_id)
);

create index if not exists projects_owner_updated_idx on public.projects(owner_id, updated_at desc);
create index if not exists projects_public_updated_idx on public.projects(updated_at desc) where visibility = 'public';
create index if not exists annotations_project_created_idx on public.annotations(project_id, created_at);
create index if not exists overlays_user_target_idx on public.project_overlays(user_id, target_project_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at before update on public.projects
for each row execute function public.set_updated_at();
drop trigger if exists annotations_set_updated_at on public.annotations;
create trigger annotations_set_updated_at before update on public.annotations
for each row execute function public.set_updated_at();

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), 'Користувач')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile after insert on auth.users
for each row execute function public.create_profile_for_new_user();

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.annotations enable row level security;
alter table public.project_overlays enable row level security;

grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.projects to authenticated;
grant select, insert, update, delete on public.annotations to authenticated;
grant select, insert, update, delete on public.project_overlays to authenticated;

-- Profiles can be listed by signed-in users; users may edit only their own profile.
drop policy if exists profiles_read_authenticated on public.profiles;
create policy profiles_read_authenticated on public.profiles
for select to authenticated using (true);
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
for update to authenticated using (id = (select auth.uid()))
with check (id = (select auth.uid()));

-- Public projects are browseable, but only their owner can change a project.
drop policy if exists projects_read_public_or_owned on public.projects;
create policy projects_read_public_or_owned on public.projects
for select to authenticated using (visibility = 'public' or owner_id = (select auth.uid()));
drop policy if exists projects_insert_self on public.projects;
create policy projects_insert_self on public.projects
for insert to authenticated with check (owner_id = (select auth.uid()));
drop policy if exists projects_update_self on public.projects;
create policy projects_update_self on public.projects
for update to authenticated using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));
drop policy if exists projects_delete_self on public.projects;
create policy projects_delete_self on public.projects
for delete to authenticated using (owner_id = (select auth.uid()));

-- Annotations are visible with a public project, to that project's owner, or to their author.
-- Each user can modify only the annotations they authored.
drop policy if exists annotations_read_project on public.annotations;
create policy annotations_read_project on public.annotations
for select to authenticated using (
  author_id = (select auth.uid()) or exists (
    select 1 from public.projects p
    where p.id = project_id and (p.visibility = 'public' or p.owner_id = (select auth.uid()))
  )
);
drop policy if exists annotations_insert_self on public.annotations;
create policy annotations_insert_self on public.annotations
for insert to authenticated with check (
  author_id = (select auth.uid()) and exists (
    select 1 from public.projects p
    where p.id = project_id and (p.visibility = 'public' or p.owner_id = (select auth.uid()))
  )
);
drop policy if exists annotations_update_self on public.annotations;
create policy annotations_update_self on public.annotations
for update to authenticated using (author_id = (select auth.uid()))
with check (author_id = (select auth.uid()));
drop policy if exists annotations_delete_self on public.annotations;
create policy annotations_delete_self on public.annotations
for delete to authenticated using (author_id = (select auth.uid()));

-- Overlay choices belong to the owner of the target project. Source projects must be public
-- unless the same user owns both projects. Overlay rows never grant edit rights to the source.
drop policy if exists overlays_read_self on public.project_overlays;
create policy overlays_read_self on public.project_overlays
for select to authenticated using (
  user_id = (select auth.uid()) and exists (
    select 1 from public.projects target
    where target.id = target_project_id and target.owner_id = (select auth.uid())
  )
);
drop policy if exists overlays_insert_self on public.project_overlays;
create policy overlays_insert_self on public.project_overlays
for insert to authenticated with check (
  user_id = (select auth.uid()) and exists (
    select 1 from public.projects target
    where target.id = target_project_id and target.owner_id = (select auth.uid())
  ) and exists (
    select 1 from public.projects source
    where source.id = source_project_id
      and (source.visibility = 'public' or source.owner_id = (select auth.uid()))
  )
);
drop policy if exists overlays_update_self on public.project_overlays;
create policy overlays_update_self on public.project_overlays
for update to authenticated using (
  user_id = (select auth.uid()) and exists (
    select 1 from public.projects target
    where target.id = target_project_id and target.owner_id = (select auth.uid())
  )
) with check (
  user_id = (select auth.uid()) and exists (
    select 1 from public.projects target
    where target.id = target_project_id and target.owner_id = (select auth.uid())
  ) and exists (
    select 1 from public.projects source
    where source.id = source_project_id
      and (source.visibility = 'public' or source.owner_id = (select auth.uid()))
  )
);
drop policy if exists overlays_delete_self on public.project_overlays;
create policy overlays_delete_self on public.project_overlays
for delete to authenticated using (
  user_id = (select auth.uid()) and exists (
    select 1 from public.projects target
    where target.id = target_project_id and target.owner_id = (select auth.uid())
  )
);
