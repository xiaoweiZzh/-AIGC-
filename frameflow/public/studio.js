const byId = (id) => document.getElementById(id);
const icon = (id) => `<svg aria-hidden="true"><use href="#i-${id}"/></svg>`;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const categories = ['全部', '角色', '场景', '道具', '风格'];
const retiredIds = new Set(['neon', 'portrait', 'forest', 'road']);
const example = '雨夜街道，镜头缓慢推向身穿黑色风衣的主角。霓虹倒映在湿润的路面上，近处雨滴清晰，远处人影在灯光中虚化。';
const labels = { queued: '排队中', submitting: '提交中', running: '生成中', archiving: '保存中', done: '已完成', failed: '失败', cancelled: '已取消' };
const activeStates = ['submitting', 'running', 'archiving'];
const queueFilters = { all: '全部', queued: '排队中', active: '处理中', done: '已完成', failed: '失败' };
const draftKey = 'frameflow.storyboard.v1';
const createShot = (values = {}) => ({ prompt: '', refs: [], ratio: '16:9', duration: 5, ...values, id: crypto.randomUUID() });
function initialDraft() {
  const shots = [createShot()];
  return { shots, selected: shots[0].id };
}
function loadShots() {
  try {
    const saved = JSON.parse(localStorage.getItem(draftKey));
    if (Array.isArray(saved?.shots) && saved.shots.length && saved.shots.some((shot) => shot.id === saved.selected)) {
      for (const shot of saved.shots) {
        for (let index = shot.refs.length - 1; index >= 0; index--) {
          if (retiredIds.has(shot.refs[index])) removeReference(shot, index);
        }
        delete shot.first;
        delete shot.useFirst;
      }
      return saved;
    }
  } catch {}
  return initialDraft();
}
const state = { ...initialDraft(), assets: [], folders: [], jobs: [], view: 'studio', ready: false, loaded: false, unavailable: false, local: false, concurrency: 3, maxReferenceCount: 10, maxReferenceBytes: 12 * 1024 * 1024, assetFilter: '全部', libraryFilter: '全部', jobFilter: 'all', folder: 'all', libraryFolder: 'all', sideSelection: new Set(), librarySelection: new Set(), files: [], busy: false, uploading: false };
const prompt = byId('prompt');
const assetPanel = byId('assetPanel');
const toast = byId('toast');
let toastTimer;
let stateFlight;
let generationStamp = 0;
let draftTimer;
let draftSending = false;
let pendingDraft;

function say(message, error = false) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, error ? 6500 : 3200);
}

async function api(path, options) {
  if (options && state.account && !state.local) {
    const headers = new Headers(options.headers);
    headers.set('X-FrameFlow-Account', state.account);
    options = { ...options, headers };
  }
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) throw Object.assign(new Error(payload?.error || '工作台暂时无法连接，请稍后重试。'), { status: response.redirected ? 401 : response.status });
  return payload;
}

const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const imageUrl = (asset) => `/api/assets/${asset.id}`;
const currentShot = () => state.shots.find((shot) => shot.id === state.selected);
const currentRefs = () => currentShot().refs;
function saveDraft() {
  if (!state.loaded) return;
  const draft = JSON.stringify({ shots: state.shots, selected: state.selected });
  if (state.local) {
    try { localStorage.setItem(draftKey, draft); } catch {}
  } else {
    pendingDraft = draft;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(flushDraft, 400);
  }
}

async function flushDraft() {
  if (draftSending || !pendingDraft) return;
  const body = pendingDraft;
  pendingDraft = null;
  draftSending = true;
  let retry = false;
  try {
    await api('/api/draft', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive: new Blob([body]).size < 60_000 });
  } catch (error) {
    retry = !error.status || error.status >= 500;
    if (retry) pendingDraft ??= body;
    say('分镜草稿未同步：' + error.message, true);
  } finally {
    draftSending = false;
    if (pendingDraft) {
      clearTimeout(draftTimer);
      draftTimer = setTimeout(flushDraft, retry ? 5000 : 0);
    }
  }
}
const busyJobs = () => state.jobs.filter((job) => activeStates.includes(job.status)).length;
const queuedJobs = () => state.jobs.filter((job) => job.status === 'queued').length;
const doneJobs = () => state.jobs.filter((job) => job.status === 'done').length;

function updateConnection() {
  byId('topDot').classList.toggle('ready', state.ready);
  byId('configState').textContent = state.unavailable ? '工作台离线' : !state.loaded ? '正在检查' : state.ready ? '万相已配置' : '配置万相';
  byId('configMessage').textContent = state.unavailable ? '工作台暂时无法连接。请稍后刷新再试。' : state.local ? '本地版在 .env 中配置百炼参数。' : !state.canConfigure ? '在线密钥存储尚未启用。' : state.ready ? '已加密保存你的接入配置，不会回显 Key。填写新 Key 可替换；是否可用以百炼任务为准。' : '请填写你自己百炼账号的 API Key。生成扣你的百炼额度，不会使用其他人的 Key。';
  byId('configForm').hidden = !state.canConfigure;
  byId('configAccount').hidden = !state.email;
  byId('accountEmail').textContent = state.email ?? '';
  byId('signOut').hidden = !state.canSignOut;
  byId('removeConfig').hidden = !state.integration;
  byId('configLimit').textContent = `${state.concurrency} 条任务`;
  byId('configQueue').textContent = state.local ? '只要本地服务保持运行，关闭浏览器也会继续处理队列。' : '在线版请保持工作台页面打开，才能自动处理下一批任务并保存结果。';
}

function openConfig() {
  byId('configForm').reset();
  byId('providerWorkspace').value = state.integration?.workspace ?? '';
  byId('providerRegion').value = state.integration?.region ?? 'cn-beijing';
  byId('configError').hidden = true;
  if (!byId('configDialog').open) byId('configDialog').showModal();
}

async function updateIntegration(method) {
  const errorLabel = byId('configError');
  const buttons = [byId('saveConfig'), byId('removeConfig')];
  errorLabel.hidden = true;
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const options = { method };
    if (method === 'PUT') {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify({ key: byId('providerKey').value, workspace: byId('providerWorkspace').value, region: byId('providerRegion').value });
      byId('providerKey').value = '';
    }
    await api('/api/integration', options);
    await reloadAfterChange();
    openConfig();
    say(method === 'PUT' ? '已保存你的万相配置' : '已移除你的万相配置');
  } catch (error) {
    errorLabel.textContent = error.message;
    errorLabel.hidden = false;
  } finally { buttons.forEach((button) => { button.disabled = false; }); }
}

async function refreshState(notify = false) {
  if (stateFlight) return stateFlight;
  const stamp = generationStamp;
  stateFlight = (async () => {
    try {
      const result = await api(state.loaded ? '/api/state' : '/api/state?draft=1');
      if (stamp !== generationStamp) return;
      const firstLoad = !state.loaded;
      if (!firstLoad && state.account !== result.account) { location.reload(); return; }
      const changedAssets = JSON.stringify(state.assets) !== JSON.stringify(result.assets);
      const changedFolders = JSON.stringify(state.folders) !== JSON.stringify(result.folders);
      const changedJobs = JSON.stringify(state.jobs) !== JSON.stringify(result.jobs);
      Object.assign(state, result, { loaded: true, unavailable: false });
      updateConnection();
      if (firstLoad) {
        Object.assign(state, state.local ? loadShots() : result.draft ?? initialDraft());
        selectShot(state.selected, false);
        byId('studioView').inert = false;
        if (byId('configDialog').open) openConfig();
      }
      if (changedAssets || changedFolders || firstLoad) {
        if (pruneMissingRefs()) { prompt.value = currentShot().prompt; renderShots(); renderPrompt(); saveDraft(); }
        renderAssets(); renderRefs();
      }
      if (changedJobs || notify) renderJobs();
      if (notify) say('已刷新工作台状态');
    } catch (error) {
      if (error.status === 401 && state.canSignOut) { location.assign('/login'); return; }
      state.unavailable = true;
      updateConnection();
      if (notify) say(error.message, true);
    } finally { stateFlight = null; }
  })();
  return stateFlight;
}

async function reloadAfterChange() {
  generationStamp++;
  if (stateFlight) await stateFlight;
  return refreshState();
}

function closeDrawers() {
  assetPanel.classList.remove('open');
  byId('overlay').hidden = true;
}

function showView(view, scroll = true) {
  if (!['studio', 'assets', 'queue'].includes(view)) return;
  state.view = view;
  closeDrawers();
  for (const key of ['studio', 'assets', 'queue']) byId(`${key}View`).hidden = key !== view;
  document.querySelectorAll('.nav[data-view]').forEach((nav) => {
    const selected = nav.dataset.view === view;
    nav.classList.toggle('active', selected);
    if (selected) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current');
  });
  byId('crumb').textContent = { studio: '分镜工作台', assets: '素材资产库', queue: '生成队列' }[view];
  if (scroll) window.scrollTo(0, 0);
}

function openAssets() {
  if (matchMedia('(max-width: 1020px)').matches) {
    assetPanel.classList.add('open');
    byId('overlay').hidden = false;
  }
  byId('assetSearch').focus({ preventScroll: true });
}

function filterButtons(items, selected, type) {
  const values = Array.isArray(items) ? items.map((item) => [item, item]) : Object.entries(items);
  return values.map(([value, label]) => `<button data-filter-type="${type}" data-filter="${value}" class="${selected === value ? 'selected' : ''}" aria-pressed="${selected === value}">${label}</button>`).join('');
}

function assetCard(asset, manage = false) {
  const selected = (manage ? state.librarySelection : state.sideSelection).has(asset.id);
  const attached = currentRefs().includes(asset.id);
  const size = `${Math.max(1, Math.round(asset.size / 1024))} KB · ${escape(asset.mime.split('/').at(-1).toUpperCase())}`;
  return `<article class="asset-card${selected ? ' selected' : ''}"><button class="asset-button" type="button" data-asset="${asset.id}" data-list="${manage ? 'library' : 'side'}" aria-pressed="${selected}" aria-label="${escape(asset.name)}" title="${escape(asset.name)}"><div class="asset-picture"><img src="${imageUrl(asset)}" alt="" loading="lazy"><span class="asset-tag">${asset.category}</span><span class="asset-mark">${selected ? '✓' : attached ? '已引用' : '+'}</span></div><div class="asset-name">${escape(asset.name)}</div><div class="asset-note">${size}</div></button>${manage ? `<div class="asset-row"><span>${escape(folderName(asset.folder))}</span><button class="icon-button" data-remove="${asset.id}" aria-label="移除素材 ${escape(asset.name)}">${icon('trash')}</button></div>` : ''}</article>`;
}

function matchingAssets(category, search, folder) {
  const term = search.trim().toLowerCase();
  return state.assets.filter((asset) => (folder === 'all' || (asset.folder ?? '') === folder) && (category === '全部' || asset.category === category) && `${asset.name} ${asset.category}`.toLowerCase().includes(term));
}

const folderName = (id) => id === 'all' ? '全部素材' : (state.folders.find((folder) => folder.id === id)?.name ?? '未归档');

function fillFolders(select, value, all = false) {
  select.replaceChildren(...(all ? [new Option('全部素材', 'all')] : []), new Option('未归档', ''), ...state.folders.map((folder) => new Option(folder.name, folder.id)));
  select.value = value;
}

function renderBulk() {
  for (const list of ['side', 'library']) {
    const selected = list === 'side' ? state.sideSelection : state.librarySelection;
    const count = selected.size;
    byId(`${list}Bulk`).innerHTML = `<span>${count ? `已选 ${count} 张` : '可多选图片'}</span>${count ? `<button class="text-action" data-clear-selection="${list}">清空</button>` : ''}${list === 'library' ? `<button class="outline" id="startMove" ${count ? '' : 'disabled'}>移动到文件夹</button>` : ''}<button class="primary" data-add-selection="${list}" ${count ? '' : 'disabled'}>添加到参考图</button>`;
  }
}

function addSelection(list) {
  const selection = list === 'side' ? state.sideSelection : state.librarySelection;
  try {
    const added = addReferences(selection);
    selection.clear();
    renderRefs(); renderAssets(); saveDraft();
    say(added ? `已添加 ${added} 张参考图` : '所选素材已在参考图中');
  } catch (error) { say(error.message, true); }
}

function empty(headline, detail = '', symbol = '') {
  return `<div class="empty">${symbol ? icon(symbol) : ''}<strong>${headline}</strong>${detail}</div>`;
}

function renderAssets() {
  const side = matchingAssets(state.assetFilter, byId('assetSearch').value, state.folder);
  const library = matchingAssets(state.libraryFilter, byId('librarySearch').value, state.libraryFolder);
  fillFolders(byId('sideFolder'), state.folder, true);
  fillFolders(byId('libraryFolder'), state.libraryFolder, true);
  byId('assetFilters').innerHTML = filterButtons(categories, state.assetFilter, 'asset');
  byId('libraryFilters').innerHTML = filterButtons(categories, state.libraryFilter, 'library');
  byId('assetGrid').innerHTML = side.map((asset) => assetCard(asset)).join('') || '<div class="media-empty grid-empty">没有图片，上传素材后即可多选。</div>';
  byId('assetTotal').textContent = `${side.length} 项`;
  byId('libraryGrid').innerHTML = library.length ? library.map((asset) => assetCard(asset, true)).join('') : empty('没有匹配素材', '换个搜索词，或上传新图片。', 'image');
  byId('libraryTitle').textContent = folderName(state.libraryFolder);
  byId('libraryCount').textContent = `${library.length} 张素材`;
  renderBulk();
}

function renderRefs() {
  const assets = new Map(state.assets.map((asset) => [asset.id, asset]));
  const refs = currentRefs();
  byId('refCount').textContent = `图 ${refs.length} / ${state.maxReferenceCount}`;
  byId('refs').innerHTML = refs.map((id, index) => {
    const asset = assets.get(id);
    return asset ? `<div class="ref-chip" title="${escape(asset.name)}"><img src="${imageUrl(asset)}" alt="${escape(asset.name)}"><button class="ref-remove" data-detach="${asset.id}" aria-label="移除参考图 ${index + 1}">${icon('close')}</button><button class="ref-insert" data-insert="${index + 1}" title="插入图${index + 1}到提示词">图${index + 1}</button></div>` : '';
  }).join('') || '<div class="media-empty">勾选上方图片，再点「添加到参考图」</div>';
}

function renderPrompt() {
  const shot = currentShot();
  byId('promptCount').textContent = `${shot.prompt.length} / 2000`;
  byId('generate').querySelector('span').textContent = state.busy ? '正在入队…' : '生成当前镜头';
}

function renderShots() {
  byId('shotCount').textContent = `(${state.shots.length} 个镜头)`;
  byId('shotList').innerHTML = state.shots.map((shot, index) => {
    const active = shot.id === state.selected;
    const title = `镜头 ${index + 1}`;
    return `<article class="shot-card${active ? ' active' : ''}"><button class="shot-select" data-shot="${shot.id}" aria-pressed="${active}" aria-label="${title}"><strong>${title}</strong><p>${escape(shot.prompt.trim() || '点击编辑镜头提示词')}</p></button><div class="shot-card-tools"><span class="shot-length">${shot.duration}s</span><button data-copy-shot="${shot.id}" aria-label="复制${title}" title="复制完整分镜">${icon('copy')}</button><button data-delete-shot="${shot.id}" aria-label="删除${title}">${icon('trash')}</button><button data-add-after="${shot.id}" aria-label="在${title}后添加">${icon('plus')}</button></div></article>`;
  }).join('');
}

function selectShot(id, persist = true) {
  state.selected = id;
  state.sideSelection.clear();
  closeMention();
  const shot = currentShot();
  prompt.value = shot.prompt;
  byId('duration').value = shot.duration;
  byId('durationValue').textContent = `${shot.duration} 秒`;
  byId('ratio').value = shot.ratio;
  byId('editingShot').textContent = `镜头 ${state.shots.indexOf(shot) + 1}`;
  renderShots(); renderPrompt(); renderRefs(); renderAssets();
  if (persist) saveDraft();
}

function addShots(shots, index = state.shots.length) {
  if (state.shots.length + shots.length > 20) return false;
  state.shots.splice(index, 0, ...shots);
  selectShot(shots[0].id);
  byId('shotList').querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return true;
}

function removeShot(id) {
  const index = state.shots.findIndex((shot) => shot.id === id);
  if (index < 0 || !confirm(`删除镜头 ${index + 1} 的草稿？不影响已入队任务。`)) return;
  state.shots.splice(index, 1);
  if (!state.shots.length) state.shots.push(createShot());
  selectShot(state.selected === id ? state.shots[Math.min(index, state.shots.length - 1)].id : state.selected);
}

function trackDraft() {
  currentShot().prompt = prompt.value;
  const excerpt = byId('shotList').querySelector('.active .shot-select p');
  if (excerpt) excerpt.textContent = prompt.value.trim() || '点击编辑镜头提示词';
  renderPrompt(); saveDraft();
}

function addReferences(ids, shot = currentShot()) {
  const known = new Map(state.assets.map((asset) => [asset.id, asset]));
  const fresh = [...ids].filter((id) => known.has(id) && !shot.refs.includes(id));
  const refs = [...shot.refs, ...fresh];
  if (refs.length > state.maxReferenceCount) throw new Error(`每条分镜最多 ${state.maxReferenceCount} 张参考图，还可添加 ${state.maxReferenceCount - shot.refs.length} 张。`);
  if (refs.reduce((sum, id) => sum + (known.get(id)?.size ?? 0), 0) > state.maxReferenceBytes) throw new Error(`参考图合计不能超过 ${state.maxReferenceBytes / (1024 * 1024)} MB，请压缩图片或减少选择。`);
  shot.refs.push(...fresh);
  return fresh.length;
}

function removeReference(shot, removed) {
  shot.refs.splice(removed, 1);
  shot.prompt = shot.prompt.replace(/(@?图)(\d+)/g, (match, prefix, number) => Number(number) === removed + 1 ? '参考图' : Number(number) > removed + 1 ? `${prefix}${Number(number) - 1}` : match);
}

function pruneMissingRefs() {
  const known = new Set(state.assets.map((asset) => asset.id));
  let changed = false;
  for (const shot of state.shots) {
    for (let index = shot.refs.length - 1; index >= 0; index--) {
      if (!known.has(shot.refs[index])) { removeReference(shot, index); changed = true; }
    }
  }
  for (const selected of [state.sideSelection, state.librarySelection]) {
    for (const id of selected) if (!known.has(id)) selected.delete(id);
  }
  return changed;
}

function insertRef(number, replace = false) {
  const end = prompt.selectionStart;
  const start = replace && prompt.value[end - 1] === '@' ? end - 1 : end;
  const token = `@图${number} `;
  if (prompt.value.length - (end - start) + token.length > prompt.maxLength) return say('提示词不能超过 2000 字。', true);
  prompt.setRangeText(token, start, end, 'end');
  closeMention();
  trackDraft();
  prompt.focus();
}

function closeMention() { byId('mentionPicker').hidden = true; }

function renderMentions() {
  const assets = matchingAssets('全部', byId('mentionSearch').value, state.folder);
  byId('mentionResults').innerHTML = assets.map((asset) => `<button data-mention="${asset.id}"><img src="${imageUrl(asset)}" alt="">${escape(asset.name)}</button>`).join('') || '<div class="mention-empty">没有匹配素材</div>';
}

function renderJobs() {
  const running = busyJobs();
  const queued = queuedJobs();
  const completed = doneJobs();
  byId('navCount').textContent = running + queued;
  byId('queueMetrics').innerHTML = [['等待中', queued], ['处理中', running], ['已完成', completed]].map(([name, total]) => `<div class="metric">${name}<b>${total}</b></div>`).join('');
  byId('queueInfo').textContent = `最多 ${state.concurrency} 条并发 · 最近 ${state.jobs.length} 条任务`;
  byId('queueFilters').innerHTML = filterButtons(queueFilters, state.jobFilter, 'job');
  const filtered = state.jobs.filter((job) => state.jobFilter === 'all' || (state.jobFilter === 'active' ? activeStates.includes(job.status) : job.status === state.jobFilter));
  byId('jobList').innerHTML = filtered.length ? filtered.map(jobRow).join('') : empty('没有符合条件的任务', '在创作工作台输入提示词，再加入生成队列。', 'film');
}

function jobRow(job) {
  const coverAsset = job.first ?? job.refs[0];
  const cover = coverAsset ? `<img src="/api/assets/${coverAsset.id}" alt="">` : icon('film');
  const status = `<span class="pill ${job.status}">${labels[job.status] ?? '未知'}</span>`;
  let actions = '';
  if (job.status === 'done') actions = `<button class="outline" data-preview="${job.id}">${icon('play')} 预览</button><a class="outline" href="${job.video}?download">${icon('down')} 下载</a>`;
  if (job.status === 'queued') actions = `<button class="outline" data-job-op="cancel" data-job="${job.id}">取消</button>`;
  if (job.status === 'failed') actions = `<button class="outline" data-job-op="retry" data-job="${job.id}">${icon('retry')} 重试</button>`;
  return `<article class="job"><div class="job-cover">${cover}</div><div class="job-middle"><strong class="job-title">${escape(job.title)} ${status}</strong><p title="${escape(job.prompt)}">${escape(job.prompt)}</p><p>${escape(job.ratio)} · ${job.duration} 秒 · 480P</p>${job.error ? `<p class="job-error">${escape(job.error)}</p>` : ''}</div><div class="job-actions">${actions}</div></article>`;
}

async function uploadOne(file, category, folder) {
  const data = new FormData();
  data.set('file', file);
  data.set('category', category);
  data.set('name', file.name.replace(/\.[^.]+$/, '').slice(0, 80));
  if (folder) data.set('folder', folder);
  return api('/api/assets', { method: 'POST', body: data });
}

function showUpload(files = []) {
  if (state.uploading) return;
  state.files = Array.from(files).slice(0, 20);
  byId('files').value = '';
  byId('attachUpload').checked = state.view === 'studio';
  const folder = state.view === 'assets' ? state.libraryFolder : state.folder;
  fillFolders(byId('uploadFolder'), folder === 'all' ? '' : folder);
  byId('uploadError').hidden = true;
  labelFiles();
  byId('uploadDialog').showModal();
}

function labelFiles() {
  byId('pickedLabel').textContent = state.files.length ? `已选 ${state.files.length} 张图片` : '选择本地图片';
}

async function finishUpload(event) {
  event.preventDefault();
  if (state.uploading) return;
  const errorMessage = byId('uploadError');
  if (!state.files.length) { errorMessage.textContent = '请先选择图片。'; errorMessage.hidden = false; return; }
  state.uploading = true;
  errorMessage.hidden = true;
  byId('uploadSubmit').disabled = true;
  const shot = currentShot();
  const attach = byId('attachUpload').checked;
  const category = byId('category').value;
  const folder = byId('uploadFolder').value;
  const uploaded = [];
  const remaining = [];
  const errors = [];
  try {
    for (const file of state.files) {
      try {
        const asset = await uploadOne(file, category, folder);
        state.assets.unshift(asset);
        uploaded.push(asset.id);
      } catch (error) { remaining.push(file); errors.push(`${file.name}：${error.message}`); }
    }
    if (uploaded.length) {
      try {
        if (attach) addReferences(uploaded, shot);
        say(`已上传 ${uploaded.length} 张素材${attach ? '，并添加到参考图' : ''}`);
      } catch (error) { say(`已存入素材库，未添加到镜头：${error.message}`, true); }
    }
    state.files = remaining;
    if (errors.length) { errorMessage.textContent = errors.slice(0, 3).join('；'); errorMessage.hidden = false; labelFiles(); }
    else byId('uploadDialog').close();
    renderPrompt(); renderRefs(); renderAssets(); saveDraft(); await reloadAfterChange();
  } finally {
    state.uploading = false;
    byId('uploadSubmit').disabled = false;
  }
}

async function enqueue(all = false) {
  if (state.busy) return;
  if (state.unavailable) return say('工作台暂时无法连接，请稍后重试。', true);
  if (!state.ready) { openConfig(); return; }
  const rows = (all ? state.shots : [currentShot()]).filter((shot) => shot.prompt.trim()).map((shot) => ({ ...shot, index: state.shots.indexOf(shot) }));
  if (!rows.length) return say('请先填写镜头提示词。', true);
  if (all && !confirm(`将 ${rows.length} 个已填写提示词的镜头加入队列？会消耗百炼额度。`)) return;
  state.busy = true;
  byId('generate').disabled = true;
  byId('generateAll').disabled = true;
  renderPrompt();
  try {
    const jobs = rows.map((row) => ({ prompt: row.prompt.trim(), refs: row.refs, ratio: row.ratio, duration: row.duration, title: `镜头 ${row.index + 1} · ${row.prompt.trim().slice(0, 23)}` }));
    const result = await post('/api/jobs', { jobs });
    await reloadAfterChange();
    renderAssets();
    say(`已加入 ${result.count} 条分镜，队列会自动推进。`);
    showView('queue');
  } catch (error) { say(error.message, true); }
  finally { state.busy = false; byId('generate').disabled = false; byId('generateAll').disabled = false; renderPrompt(); }
}

async function deleteAsset(id) {
  const asset = state.assets.find((item) => item.id === id);
  if (!asset || !confirm(`从素材库移除「${asset.name}」？历史任务仍可访问该参考图。`)) return;
  try {
    await api(`/api/assets/${id}`, { method: 'DELETE' });
    await reloadAfterChange();
    renderAssets(); renderRefs(); say('已从素材库移除');
  } catch (error) { say(error.message, true); }
}

async function jobAction(operation, id) {
  const job = state.jobs.find((item) => item.id === id);
  if (operation === 'retry' && /确认是否已受理|重试前请先检查/.test(job?.error ?? '') && !confirm('上一次提交可能已在百炼受理。确认已核对百炼任务，并希望重新提交吗？')) return;
  try { await post(`/api/jobs/${id}/${operation}`, {}); await reloadAfterChange(); say(operation === 'cancel' ? '已取消排队任务' : '任务已重新入队'); }
  catch (error) { say(error.message, true); }
}

async function submitFolderForm(event, move = false) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  if (button.disabled) return;
  button.disabled = true;
  const errorLabel = byId(move ? 'moveError' : 'folderError');
  errorLabel.hidden = true;
  try {
    if (move) {
      const folder = byId('moveFolder').value;
      const result = await post('/api/assets/move', { ids: [...state.librarySelection], folder: folder || null });
      state.librarySelection.clear();
      state.libraryFolder = folder;
      byId('librarySearch').value = '';
      state.libraryFilter = '全部';
      say(`已移动 ${result.count} 张素材`);
    } else {
      const folder = await post('/api/folders', { name: byId('folderName').value });
      if (state.view === 'assets') {
        state.libraryFolder = folder.id;
        state.librarySelection.clear();
        state.libraryFilter = '全部';
        byId('librarySearch').value = '';
      } else {
        state.folder = folder.id;
        state.sideSelection.clear();
        state.assetFilter = '全部';
        byId('assetSearch').value = '';
      }
      say('已创建素材文件夹');
    }
    form.closest('dialog').close();
    await reloadAfterChange();
    renderAssets();
  } catch (error) { errorLabel.textContent = error.message; errorLabel.hidden = false; }
  finally { button.disabled = false; }
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const data = button.dataset;
  if (data.view) showView(data.view);
  if ('upload' in data) showUpload();
  if ('newFolder' in data) {
    byId('folderForm').reset();
    byId('folderError').hidden = true;
    byId('folderDialog').showModal();
  }
  if ('config' in data) openConfig();
  if (data.close) byId(data.close).close();
  if (data.filterType === 'asset') { state.assetFilter = data.filter; renderAssets(); }
  if (data.filterType === 'library') { state.libraryFilter = data.filter; renderAssets(); }
  if (data.filterType === 'job') { state.jobFilter = data.filter; renderJobs(); }
  if (data.asset) {
    const selection = data.list === 'side' ? state.sideSelection : state.librarySelection;
    if (selection.has(data.asset)) selection.delete(data.asset);
    else selection.add(data.asset);
    button.closest('.asset-card').classList.toggle('selected', selection.has(data.asset));
    button.setAttribute('aria-pressed', String(selection.has(data.asset)));
    button.querySelector('.asset-mark').textContent = selection.has(data.asset) ? '✓' : currentRefs().includes(data.asset) ? '已引用' : '+';
    renderBulk();
  }
  if (data.clearSelection) {
    (data.clearSelection === 'side' ? state.sideSelection : state.librarySelection).clear();
    renderAssets();
  }
  if (data.addSelection) addSelection(data.addSelection);
  if (button.id === 'startMove') {
    if (state.librarySelection.size > 50) return say('每次最多移动 50 张素材。', true);
    fillFolders(byId('moveFolder'), '');
    byId('moveError').hidden = true;
    byId('moveDialog').showModal();
  }
  if (data.detach) {
    const shot = currentShot();
    const index = shot.refs.indexOf(data.detach);
    if (index !== -1) {
      removeReference(shot, index);
      prompt.value = shot.prompt;
      trackDraft();
      renderRefs(); renderAssets();
    }
  }
  if (data.shot) { selectShot(data.shot); byId('shotList').querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true }); }
  if (data.deleteShot) removeShot(data.deleteShot);
  if (data.addAfter && !addShots([createShot()], state.shots.findIndex((shot) => shot.id === data.addAfter) + 1)) say('每个剧本最多 20 个镜头。', true);
  if (data.copyShot) {
    const index = state.shots.findIndex((shot) => shot.id === data.copyShot);
    if (index !== -1) {
      const shot = state.shots[index];
      if (addShots([createShot(structuredClone(shot))], index + 1)) say(`已复制镜头 ${index + 1}`);
      else say('每个剧本最多 20 个镜头。', true);
    }
  }
  if (data.mention) {
    const refs = currentRefs();
    try { addReferences([data.mention]); }
    catch (error) { return say(error.message, true); }
    insertRef(refs.indexOf(data.mention) + 1, true);
    renderRefs(); renderAssets(); saveDraft();
  }
  if (data.insert) insertRef(data.insert);
  if (data.remove) void deleteAsset(data.remove);
  if (data.jobOp) void jobAction(data.jobOp, data.job);
  if (data.preview) {
    const job = state.jobs.find((item) => item.id === data.preview);
    if (!job?.video) return;
    byId('previewTitle').textContent = job.title;
    byId('previewVideo').src = job.video;
    byId('previewDownload').href = `${job.video}?download`;
    byId('previewDialog').showModal();
  }
  if (button.id === 'chooseAssets') openAssets();
});

byId('generate').addEventListener('click', () => void enqueue());
byId('generateAll').addEventListener('click', () => void enqueue(true));
byId('addShot').addEventListener('click', () => { if (addShots([createShot()])) prompt.focus({ preventScroll: true }); else say('每个剧本最多 20 个镜头。', true); });
byId('importShots').addEventListener('click', () => { byId('importError').hidden = true; byId('importDialog').showModal(); });
byId('importForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const entries = byId('importText').value.split('\n').map((line) => line.trim()).filter(Boolean);
  const error = byId('importError');
  if (!entries.length || entries.some((entry) => entry.length > 2000) || !addShots(entries.map((prompt) => createShot({ prompt })))) {
    error.textContent = '请输入每行不超过 2000 字的分镜，剧本总计不能超过 20 个镜头。'; error.hidden = false; return;
  }
  byId('importText').value = '';
  byId('importDialog').close();
});
byId('duration').addEventListener('input', () => {
  const value = Number(byId('duration').value);
  currentShot().duration = value;
  byId('durationValue').textContent = `${value} 秒`;
  const badge = byId('shotList').querySelector('.active .shot-length');
  if (badge) badge.textContent = `${value}s`;
  saveDraft();
});
byId('ratio').addEventListener('change', () => { currentShot().ratio = byId('ratio').value; saveDraft(); });
byId('sideFolder').addEventListener('change', (event) => {
  state.folder = event.target.value;
  state.sideSelection.clear();
  closeMention();
  renderAssets();
});
byId('libraryFolder').addEventListener('change', (event) => {
  state.libraryFolder = event.target.value;
  state.librarySelection.clear();
  renderAssets();
});
byId('folderForm').addEventListener('submit', (event) => void submitFolderForm(event));
byId('moveForm').addEventListener('submit', (event) => void submitFolderForm(event, true));
byId('refresh').addEventListener('click', () => void refreshState(true));
byId('checkConfig').addEventListener('click', () => void refreshState(true));
byId('configForm').addEventListener('submit', (event) => { event.preventDefault(); void updateIntegration('PUT'); });
byId('removeConfig').addEventListener('click', () => { if (confirm('移除你自己的万相 Key？之后需要重新配置才能生成。')) void updateIntegration('DELETE'); });
byId('configDialog').addEventListener('close', () => { byId('providerKey').value = ''; });
byId('assetSearch').addEventListener('input', renderAssets);
byId('librarySearch').addEventListener('input', renderAssets);
byId('overlay').addEventListener('click', closeDrawers);
byId('closeAssets').addEventListener('click', closeDrawers);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { closeDrawers(); closeMention(); } });
document.addEventListener('pointerdown', (event) => { if (!event.target.closest('.prompt-panel')) closeMention(); });
byId('previewDialog').addEventListener('close', () => { const video = byId('previewVideo'); video.pause(); video.removeAttribute('src'); video.load(); });
byId('files').addEventListener('change', (event) => { state.files = Array.from(event.target.files).slice(0, 20); labelFiles(); });
byId('uploadForm').addEventListener('submit', finishUpload);
byId('example').addEventListener('click', () => {
  const shot = currentShot();
  if (prompt.value.trim() && !confirm('用示例替换当前提示词？参考图保持不变。')) return;
  shot.prompt = example;
  selectShot(shot.id); prompt.focus();
});
byId('mentionSearch').addEventListener('input', renderMentions);
prompt.addEventListener('input', () => {
  trackDraft();
  if (prompt.value[prompt.selectionStart - 1] === '@') {
    byId('mentionSearch').value = '';
    renderMentions();
    byId('mentionPicker').hidden = false;
  } else closeMention();
});
prompt.addEventListener('paste', (event) => {
  if (event.clipboardData?.files.length) { event.preventDefault(); showUpload(event.clipboardData.files); }
});
for (const target of [byId('dropzone'), byId('refs')]) {
  target.addEventListener('dragover', (event) => { event.preventDefault(); target.classList.add('dragging'); });
  target.addEventListener('dragleave', () => target.classList.remove('dragging'));
  target.addEventListener('drop', (event) => { event.preventDefault(); target.classList.remove('dragging'); if (event.dataTransfer.files.length) showUpload(event.dataTransfer.files); });
}
selectShot(state.selected); showView('studio', false); renderJobs(); updateConnection();
void refreshState();
setInterval(() => void refreshState(), 5000);
document.addEventListener('visibilitychange', () => { if (document.hidden) void flushDraft(); else void refreshState(); });
