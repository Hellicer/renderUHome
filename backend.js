(() => {
  const api = window.supabase?.createClient;
  const config = window.SUPABASE_CONFIG || {};
  const status = document.querySelector('#cloudStatus');
  const ownSelect = document.querySelector('#ownProjects');
  const authForm = document.querySelector('#authForm');
  const accountBar = document.querySelector('#accountBar');
  const projectControls = document.querySelector('#projectControls');
  const publish = document.querySelector('#publishProject');
  let client, user, owned = [], active = null, saveTimer, loading = false;

  function message(text, bad = false) {
    status.textContent = text;
    status.style.color = bad ? '#f0a39a' : '#aab6b2';
  }
  function fail(error) {
    console.error('Supabase:', error);
    message(error?.message || 'Помилка з’єднання', true);
  }
  function planData() {
    const app = window.apartmentApp;
    return { version: 1, rooms: app.roomData.map(({ name, pts, color }) => ({ name, pts, color })), walls: app.wallDefs };
  }
  function localSnapshot(rows) {
    const snapshot = { wallMarks: [], measurements: [], hiddenLabels: [], measureStart: null, measureEnd: null };
    for (const row of rows) {
      const p = row.payload || {};
      if (row.kind === 'measurement') snapshot.measurements.push(p);
      if (row.kind === 'wall_stroke') snapshot.wallMarks.push({ ...p, h: p.h || 2.45 });
      if (row.kind === 'hidden_label' && p.name) snapshot.hiddenLabels.push(p.name);
    }
    return snapshot;
  }
  function authUi() {
    const signedIn = Boolean(user);
    authForm.hidden = signedIn;
    accountBar.hidden = !signedIn;
    projectControls.hidden = !signedIn;
    document.querySelector('#accountEmail').textContent = user?.email || '';
  }
  async function loadProjects() {
    const { data, error } = await client.from('projects').select('id,owner_id,title,visibility,plan,updated_at').order('updated_at', { ascending: false });
    if (error) throw error;
    owned = data.filter(project => project.owner_id === user.id);
    if (!owned.length) {
      const { data: created, error: createError } = await client.from('projects').insert({ owner_id: user.id, title: 'Моя квартира', plan: planData() }).select().single();
      if (createError) throw createError;
      owned = [created];
      data.unshift(created);
    }
    ownSelect.replaceChildren(...owned.map(project => {
      const option = document.createElement('option'); option.value = project.id; option.textContent = project.title; return option;
    }));
    active = owned.find(project => project.id === ownSelect.value) || owned[0];
    ownSelect.value = active.id;
    publish.checked = active.visibility === 'public';
    await loadActive();
    await renderUsers(data);
    message('Синхронізовано');
  }
  async function loadActive() {
    if (!active) return;
    loading = true;
    try {
      const [{ data: annotations, error }, { data: overlays, error: overlayError }] = await Promise.all([
        client.from('annotations').select('id,author_id,kind,payload').eq('project_id', active.id),
        client.from('project_overlays').select('source_project_id,enabled').eq('target_project_id', active.id).eq('enabled', true),
      ]);
      if (error) throw error;
      if (overlayError) throw overlayError;
      const mine = annotations.filter(row => row.author_id === user.id);
      window.apartmentApp.loadRemoteState(localSnapshot(mine));
      window.apartmentApp.sharedLayers.splice(0, window.apartmentApp.sharedLayers.length);
      const foreign = annotations.filter(row => row.author_id !== user.id);
      if (foreign.length) window.apartmentApp.sharedLayers.push({ id: active.id, plan: active.plan, annotations: foreign });
      const sourceIds = overlays.map(row => row.source_project_id);
      if (sourceIds.length) {
        const [{ data: sources, error: sourceError }, { data: marks, error: marksError }] = await Promise.all([
          client.from('projects').select('id,title,plan,owner_id').in('id', sourceIds),
          client.from('annotations').select('id,project_id,author_id,kind,payload').in('project_id', sourceIds),
        ]);
        if (sourceError) throw sourceError;
        if (marksError) throw marksError;
        for (const source of sources) window.apartmentApp.sharedLayers.push({ ...source, annotations: marks.filter(mark => mark.project_id === source.id) });
      }
      window.apartmentApp.draw();
    } finally { loading = false; }
  }
  async function renderUsers(projects) {
    const publicProjects = projects.filter(project => project.owner_id !== user.id && project.visibility === 'public');
    const list = document.querySelector('#userProjects'); list.replaceChildren();
    if (!publicProjects.length) {
      const empty = document.createElement('div'); empty.className = 'hint'; empty.textContent = 'Поки немає публічних проєктів інших користувачів.'; list.append(empty); return;
    }
    const ids = [...new Set(publicProjects.map(project => project.owner_id))];
    const [{ data: profiles, error }, { data: selected, error: overlayError }] = await Promise.all([
      client.from('profiles').select('id,display_name').in('id', ids),
      client.from('project_overlays').select('source_project_id').eq('target_project_id', active.id).eq('enabled', true),
    ]);
    if (error) throw error;
    if (overlayError) throw overlayError;
    for (const id of ids) if (!profiles.some(profile => profile.id === id)) profiles.push({ id, display_name: 'Користувач' });
    const selectedIds = new Set(selected.map(row => row.source_project_id));
    for (const profile of profiles) {
      const projectsForUser = publicProjects.filter(project => project.owner_id === profile.id);
      const card = document.createElement('div'); card.className = 'user-card';
      const name = document.createElement('strong'); name.textContent = profile.display_name || 'Користувач'; card.append(name);
      for (const project of projectsForUser) {
        const row = document.createElement('label'); row.className = 'shared-project';
        const title = document.createElement('span'); title.textContent = project.title;
        const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = selectedIds.has(project.id); toggle.setAttribute('aria-label', `Накласти проєкт ${project.title}`);
        toggle.addEventListener('change', async () => {
          toggle.disabled = true;
          try {
            if (toggle.checked) {
              const { error: upsertError } = await client.from('project_overlays').upsert({ user_id: user.id, target_project_id: active.id, source_project_id: project.id, enabled: true });
              if (upsertError) throw upsertError;
            } else {
              const { error: deleteError } = await client.from('project_overlays').delete().eq('user_id', user.id).eq('target_project_id', active.id).eq('source_project_id', project.id);
              if (deleteError) throw deleteError;
            }
            await loadActive(); message('Накладання оновлено');
          } catch (error) { toggle.checked = !toggle.checked; fail(error); }
          finally { toggle.disabled = false; }
        });
        row.append(title, toggle); card.append(row);
      }
      list.append(card);
    }
  }
  async function saveNow() {
    if (!user || !active || loading) return;
    const rows = window.apartmentApp.getOwnAnnotations().map(row => ({ ...row, project_id: active.id, author_id: user.id }));
    const { error: deleteError } = await client.from('annotations').delete().eq('project_id', active.id).eq('author_id', user.id);
    if (deleteError) throw deleteError;
    if (rows.length) {
      const { error } = await client.from('annotations').insert(rows);
      if (error) throw error;
    }
    message('Збережено');
  }
  function scheduleSave() {
    if (!user || !active || loading) return;
    clearTimeout(saveTimer);
    message('Збереження…');
    saveTimer = setTimeout(() => saveNow().catch(fail), 650);
  }
  window.apartmentCloud = { scheduleSave };

  authForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!client) return message('Спершу налаштуйте Supabase.', true);
    const { error } = await client.auth.signInWithPassword({ email: document.querySelector('#authEmail').value, password: document.querySelector('#authPassword').value });
    if (error) fail(error); else message('Вхід успішний');
  });
  document.querySelector('#signUp').addEventListener('click', async () => {
    if (!client) return message('Спершу налаштуйте Supabase.', true);
    const email = document.querySelector('#authEmail').value, password = document.querySelector('#authPassword').value;
    const { error } = await client.auth.signUp({ email, password, options: { data: { display_name: email.split('@')[0] } } });
    if (error) fail(error); else message('Перевірте пошту для підтвердження акаунта.');
  });
  document.querySelector('#signOut').addEventListener('click', () => client.auth.signOut().catch(fail));
  ownSelect.addEventListener('change', async () => {
    clearTimeout(saveTimer);
    try { await saveNow(); } catch (error) { fail(error); }
    active = owned.find(project => project.id === ownSelect.value) || null;
    if (active) { publish.checked = active.visibility === 'public'; try { await loadActive(); const { data } = await client.from('projects').select('id,owner_id,title,visibility,plan,updated_at'); await renderUsers(data || []); } catch (error) { fail(error); } }
  });
  document.querySelector('#newProject').addEventListener('click', async () => {
    const title = prompt('Назва проєкту', `Квартира ${owned.length + 1}`);
    if (!title?.trim()) return;
    const { data, error } = await client.from('projects').insert({ owner_id: user.id, title: title.trim(), plan: planData() }).select().single();
    if (error) return fail(error);
    await loadProjects(); ownSelect.value = data.id; active = data; await loadActive();
  });
  publish.addEventListener('change', async () => {
    if (!active) return;
    const { error } = await client.from('projects').update({ visibility: publish.checked ? 'public' : 'private' }).eq('id', active.id);
    if (error) { publish.checked = !publish.checked; return fail(error); }
    active.visibility = publish.checked ? 'public' : 'private';
    message(publish.checked ? 'Проєкт опубліковано для перегляду' : 'Проєкт приватний');
    try { const { data } = await client.from('projects').select('id,owner_id,title,visibility,plan,updated_at'); await renderUsers(data || []); } catch (error) { fail(error); }
  });

  async function setUser(nextUser) {
    user = nextUser || null; authUi();
    window.apartmentApp.sharedLayers.length = 0;
    if (!user) { active = null; owned = []; window.apartmentApp.draw(); message('Увійдіть, щоб синхронізувати проєкти'); return; }
    try { await loadProjects(); } catch (error) { fail(error); }
  }
  if (!api) return message('Не завантажився модуль Supabase', true);
  if (!config.url || !config.key) return message('Додайте Supabase URL і publishable key у змінні середовища', true);
  client = api(config.url, config.key);
  client.auth.onAuthStateChange((_event, session) => { setTimeout(() => setUser(session?.user || null), 0); });
  client.auth.getSession().then(({ data, error }) => error ? fail(error) : setUser(data.session?.user || null));
})();
