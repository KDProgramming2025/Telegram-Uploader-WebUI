const jobsById = {};
let renderScheduled = false;
// Toast utility
function toast(msg, type='info', timeout=4000){
  const c=document.getElementById('toastContainer');
  if(!c) return console.log(msg);
  const t=document.createElement('div');
  t.className='toast'+(type!=='info'?' '+type:'');
  t.innerHTML=`<span class="msg"></span><button class="close" aria-label="Close">×</button>`;
  t.querySelector('.msg').textContent=msg;
  const btn=t.querySelector('button.close');
  btn.onclick=()=>{t.remove();};
  c.appendChild(t);
  setTimeout(()=>{t.style.opacity='0';t.style.transform='translateY(6px)';setTimeout(()=>t.remove(),300);}, timeout);
}
function scheduleRenderJobs() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderJobs();
    renderScheduled = false;
  });
}

function renderJobs() {
  const list = document.getElementById('jobsList');
  list.innerHTML = '';
  Object.values(jobsById).forEach((job) => {
    const el = document.createElement('div');
    el.className = 'job panel';
  // entry animation class
  el.classList.add('enter');

    // Determine job type (server provided or heuristic)
    let jobType = job.type || 'upload';
    if (!job.type) {
      if (
        job.publicUrl ||
        (job.tmpPath && job.tmpPath.startsWith('/var/www/dl')) ||
        job.status === 'saved'
      ) {
        jobType = 'download';
      }
    }
    el.classList.add(jobType);

    // Build saved/public link content (avoid duplicate rendering)
    let savedLinkUrl = null;
    let savedContent = '';
    if (job.tmpPath && job.tmpPath.startsWith('/var/www/dl')) {
      const fileName = job.tmpPath.split('/').pop();
      savedLinkUrl = `${window.location.origin}/dl/${encodeURIComponent(fileName)}`;
      savedContent = `Saved: <a href="${savedLinkUrl}" target="_blank">${savedLinkUrl}</a>`;
    } else if (job.tmpPath) {
      savedContent = `Saved: ${job.tmpPath}`;
    }

    const publicUrl = job.publicUrl || null;
    const publicContent = publicUrl ? `Link: <a href="${publicUrl}" target="_blank">${publicUrl}</a>` : '';
    const badge =
      jobType === 'download'
        ? `<span class="badge download">Download</span>`
        : `<span class="badge upload">Upload</span>`;

    // Build header
    const header = document.createElement('div');
    header.className = 'job-header';
    const url = document.createElement('strong');
    url.className = 'url';
    url.title = job.fileUrl;
    url.textContent = job.fileUrl;
    header.appendChild(url);
    const badgeNode = document.createElement('span');
    badgeNode.innerHTML = badge;
    header.appendChild(badgeNode);

    // Status + progress
    const statusWrap = document.createElement('div');
    statusWrap.className = 'meta';
    statusWrap.innerHTML = `Status: <span class="status">${job.status}</span>`;
    const prog = document.createElement('progress');
    prog.value = job.percent || 0;
    prog.max = 100;
    prog.className = 'job-progress';

    el.appendChild(header);
    el.appendChild(statusWrap);
    el.appendChild(prog);
    // Append saved and public links, but avoid rendering public link if it's identical to saved link
    if (savedContent) {
      const sh = document.createElement('div');
      sh.className = 'meta';
      sh.innerHTML = savedContent;
      el.appendChild(sh);
    }
    if (publicContent && publicUrl !== savedLinkUrl) {
      const pl = document.createElement('div');
      pl.className = 'meta';
      pl.innerHTML = publicContent;
      el.appendChild(pl);
    }
    const actions = document.createElement('div');
    actions.className = 'job-actions';
  const delBtn = document.createElement('button');
  // use danger style for remove button so it visually matches .btn.danger
  delBtn.className = 'btn del danger';
    delBtn.setAttribute('data-id', job.id);
    delBtn.textContent = 'Remove';
    actions.appendChild(delBtn);
    el.appendChild(actions);
  list.appendChild(el);
  });

  // Wire delete buttons
  document.querySelectorAll('#jobsList .del').forEach((b) => {
    b.onclick = async (e) => {
      const id = e.target.getAttribute('data-id');
      await fetch(`/uploader/jobs/${id}`, { method: 'DELETE' });
      delete jobsById[id];
      // Animate removal
      const node = document.querySelector(`#jobsList .del[data-id="${id}"]`);
      if (node) {
        const parent = node.closest('.job');
        if (parent) {
          parent.classList.add('exit');
          setTimeout(() => renderJobs(), 300);
          return;
        }
      }
      renderJobs();
    };
  });
  refreshIcons();
}

async function refreshJobs() {
  const res = await fetch('/uploader/jobs');
  const list = await res.json();
  list.forEach((j) => {
    jobsById[j.id] = j;
    if (!jobsById[j.id].type) jobsById[j.id].type = j.type || 'upload';
  });
  scheduleRenderJobs();
}

async function refreshFree() {
  try {
    const res = await fetch('/uploader/system/free-space');
    const j = await res.json();
    document.getElementById('freeSpace').textContent = j.free || JSON.stringify(j);
  } catch (e) {
    document.getElementById('freeSpace').textContent = 'error';
  }
}

// Wire action buttons: upload vs download

document.getElementById('btnUpload').onclick = () => runAction(false);
document.getElementById('btnDownload').onclick = () => runAction(true);

// Cookies.txt uploader
const btnUploadCookies = document.getElementById('btnUploadCookies');
if (btnUploadCookies) {
  btnUploadCookies.onclick = async () => {
    const fileInput = document.getElementById('cookiesFile');
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
      toast('Please select a cookies.txt file.', 'error');
      return;
    }
    const file = fileInput.files[0];
    const formData = new FormData();
    formData.append('cookies', file);
    // include credentials if present in main form (for authorized environments)
    try {
      const form = document.getElementById('uploadForm');
      if (form) {
        if (form.username && form.username.value) formData.append('username', form.username.value);
        if (form.password && form.password.value) formData.append('password', form.password.value);
      }
    } catch(_) {}
    btnUploadCookies.disabled = true;
    btnUploadCookies.textContent = 'Uploading...';
    let success = false;
    try {
      let res = await fetch('/uploader/metube/cookies', { method: 'POST', body: formData });
      if (res.status === 404) {
        // fallback alias
        res = await fetch('/metube/cookies', { method: 'POST', body: formData });
      }
      if (res.ok) {
        toast('cookies.txt uploaded and MeTube reloaded!', 'success');
        success = true;
      } else {
        const msg = await res.text();
        toast('Upload failed: ' + msg, 'error');
      }
    } catch (e) {
      toast('Upload error: ' + e, 'error');
    }
    btnUploadCookies.disabled = false;
    btnUploadCookies.textContent = success ? 'Uploaded!' : 'Upload cookies.txt';
    setTimeout(()=>{ if(btnUploadCookies.textContent==='Uploaded!') btnUploadCookies.textContent='Upload cookies.txt'; }, 2000);
    fileInput.value = '';
  };
}

async function runAction(saveToDl) {
  const form = document.getElementById('uploadForm');
  const username = form.username.value;
  const password = form.password.value;
  const lines = (form.fileUrls.value || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const fileUrl of lines) {
    const res = await fetch('/uploader/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, fileUrl, saveToDl })
    });
    if (!res.ok) {
      const text = await res.text();
  toast('Error: '+ text, 'error');
      return;
    }
    const j = await res.json();
    jobsById[j.jobId] = {
      id: j.jobId,
      fileUrl,
      status: 'queued',
      percent: 0,
      type: j.type || 'upload'
    };
  scheduleRenderJobs();
    attachSse(j.jobId);
  }
  refreshJobs();
}

function attachSse(jobId) {
  const evt = new EventSource(`/uploader/events/${jobId}`);
  evt.onmessage = () => {};
  evt.addEventListener('status', (e) => {
    const d = JSON.parse(e.data);
    if (jobsById[jobId]) {
      jobsById[jobId].status = d.status;
  scheduleRenderJobs();
    }
  });
  evt.addEventListener('downloadProgress', (e) => {
    const d = JSON.parse(e.data);
    if (jobsById[jobId]) {
      jobsById[jobId].status = 'downloading';
      jobsById[jobId].percent = d.percent || 0;
  scheduleRenderJobs();
    }
  });
  evt.addEventListener('downloadComplete', (e) => {
    const d = JSON.parse(e.data);
    if (jobsById[jobId]) {
      jobsById[jobId].status = 'downloaded';
      jobsById[jobId].percent = 100;
  scheduleRenderJobs();
    }
  });
  evt.addEventListener('downloadSaved', (e) => {
    const d = JSON.parse(e.data);
    if (jobsById[jobId]) {
      jobsById[jobId].status = 'saved';
      jobsById[jobId].percent = 100;
      jobsById[jobId].tmpPath = d.path;
      jobsById[jobId].publicUrl = d.publicUrl;
      jobsById[jobId].type = 'download';
  scheduleRenderJobs();
    }
    refreshDlList();
  });
  evt.addEventListener('uploadStart', () => {
    if (jobsById[jobId]) {
      jobsById[jobId].status = 'uploading';
      jobsById[jobId].percent = 0;
      jobsById[jobId].type = 'upload';
  scheduleRenderJobs();
    }
  });
  evt.addEventListener('uploadProgress', (e) => {
    const d = JSON.parse(e.data);
    if (jobsById[jobId]) {
      jobsById[jobId].percent = d.percent || 0;
  scheduleRenderJobs();
    }
  });
  evt.addEventListener('uploadComplete', () => {
    if (jobsById[jobId]) {
      jobsById[jobId].status = 'done';
      jobsById[jobId].percent = 100;
  scheduleRenderJobs();
    }
    evt.close();
  });
  evt.addEventListener('error', (e) => {
    const d = JSON.parse(e.data || '{}');
    if (jobsById[jobId]) {
      jobsById[jobId].status = 'error';
      jobsById[jobId].message = d.message;
  scheduleRenderJobs();
    }
    evt.close();
  });
}

function refreshIcons() {
  // debounce icon refreshes to avoid heavy DOM operations on frequent updates
  if (typeof window === 'undefined') return;
  if (!window._iconRefreshScheduled) {
    window._iconRefreshScheduled = true;
    requestAnimationFrame(() => {
      try {
        if (window.lucide) window.lucide.createIcons();
      } catch (_) {}
      window._iconRefreshScheduled = false;
    });
  }
}

// Batch DL tree re-renders to a single frame
let _dlRenderScheduled = false;
function scheduleDlRender() {
  if (_dlRenderScheduled) return;
  _dlRenderScheduled = true;
  requestAnimationFrame(() => {
    _dlRenderScheduled = false;
    refreshDlList();
  });
}

// Recompute connector extension after layout-affecting assets (like fonts) load
async function adjustFirstChildConnectors() {
  try {
    const container = document.getElementById('dlList');
    if (!container) return;
    const rows = Array.from(container.querySelectorAll('.dl-item'));
    rows.forEach(row => {
      const conn = row.querySelector('.tree-connector.first');
      if (!conn) return;
      const depthCls = Array.from(row.classList).find(c=>c.startsWith('depth-'));
      if (!depthCls) return;
      const depth = Number(depthCls.replace('depth-',''));
      if (isNaN(depth) || depth < 1) return;
      // find parent row
      let parentRow = null;
      for (let p = row.previousElementSibling; p; p = p.previousElementSibling) {
        const pc = Array.from(p.classList).find(c=>c.startsWith('depth-'));
        if (!pc) continue;
        const pd = Number(pc.replace('depth-',''));
        if (pd === depth - 1) { parentRow = p; break; }
        if (pd < depth - 1) break;
      }
      if (!parentRow) return;
      const parentToggle = parentRow.querySelector('.toggle');
      const parentRect = parentToggle ? parentToggle.getBoundingClientRect() : parentRow.getBoundingClientRect();
      const childRect = row.getBoundingClientRect();
      const chevronBottomY = parentRect.top + parentRect.height;
      const extend = Math.max(0, Math.round(childRect.top - chevronBottomY));
      conn.style.setProperty('--extend', extend + 'px');
    });
  } catch(_) {}
}

// Init
refreshJobs();
refreshFree();
setInterval(refreshFree, 30_000);

// Download list state
let dlPage = 1; // retained for pager info but tree only
let dlPerPage = 20; // unused in tree mode
let dlQuery = '';
let dlTotal = 0;
let renameFocusPath = null; // path whose input should receive focus after render
// removed selectedDlPath (no selected state highlighting required)
let selectedDlPath = null; // deprecated
// Persisted expand/collapse state
let expandedPaths = new Set();
function loadExpandedPaths() {
  try {
    const raw = localStorage.getItem('uploader_expanded_paths');
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) expandedPaths = new Set(arr);
  } catch(_) {}
}
function saveExpandedPaths() {
  try { localStorage.setItem('uploader_expanded_paths', JSON.stringify(Array.from(expandedPaths))); } catch(_) {}
}
loadExpandedPaths();

async function fetchDlTree() {
  try {
    let res = await fetch('/uploader/dl/tree');
    if (!res.ok) {
      res = await fetch('/dl/tree');
    }
    if (!res.ok) return { root: [] };
    return await res.json();
  } catch (_) { return { root: [] }; }
}

function createTreeNode(node, depth=0, isLast=false, isFirst=false) {
  const row = document.createElement('div');
  row.className = 'dl-item depth-' + depth + (node.isDir ? ' dir' : ' file');
  row.dataset.path = node.path || '';
  row.classList.add('anim-enter');
  // set depth-based connector color (cycled hues) for creative style
  const hue = (depth * 52) % 360; // spread hues
  row.style.setProperty('--conn-color', `hsl(${hue} 70% 70% / 0.68)`);
  // selection highlight removed
  const main = document.createElement('div');
  main.className = 'dl-item-main';
  // prepare connector (vertical + elbow) for non-directory nodes beyond root
  let connectorEl = null;
  if (depth > 0 && !node.isDir) {
    connectorEl = document.createElement('span');
    connectorEl.className = 'tree-connector' + (isLast ? ' last' : '') + (isFirst ? ' first' : '');
  const dot = document.createElement('span');
  dot.className = 'conn-dot';
  connectorEl.appendChild(dot);
  }
  let nameEl;
  if (node._renaming) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rename-input';
    input.value = node.name || '';
    input.setAttribute('data-path', node.path);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitRename(node, input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelRename(node); }
    };
    input.onblur = () => { commitRename(node, input.value); };
    nameEl = input;
  } else if (node.isDir) {
    const wrap = document.createElement('span');
    wrap.className = 'name-wrap';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'name';
    nameSpan.textContent = node.name || '(root)';
    wrap.appendChild(nameSpan);
    nameEl = wrap;
  } else {
    const wrap = document.createElement('span');
    wrap.className = 'name-wrap';
    const a = document.createElement('a');
    a.href = '/dl/' + encodeURIComponent(node.path);
    a.target = '_blank';
    a.className = 'name';
    a.textContent = node.name || '(root)';
    wrap.appendChild(a);
    nameEl = wrap;
  }
  const meta = document.createElement('div');
  meta.className = 'dl-meta';
  if (node.isDir) meta.textContent = 'dir'; else meta.textContent = humanSize(node.size) + (node.mtime ? ' • ' + humanTime(node.mtime) : '');
  main.appendChild(nameEl);
  if (!node._renaming) main.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const renameBtn = document.createElement('button');
  renameBtn.className = 'icon-btn secondary';
  renameBtn.innerHTML = '<span data-lucide="edit-3"></span>';
  renameBtn.onclick = () => { startRename(node); };
  actions.appendChild(renameBtn);
  const del = document.createElement('button');
  del.className = 'icon-btn danger';
  del.innerHTML = '<span data-lucide="trash-2"></span>';
  del.onclick = () => { showDeletePath(node.path, !!node.isDir); };
  actions.appendChild(del);

  if (node.isDir) {
    const toggle = document.createElement('button');
    toggle.className = 'toggle';
    toggle.innerHTML = `<span data-lucide="${node._expanded ? 'chevron-down' : 'chevron-right'}"></span>`;
    toggle.setAttribute('aria-label', node._expanded ? 'Collapse' : 'Expand');
    if (node._expanded) toggle.classList.add('expanded');
    toggle.onclick = (e) => {
      e.stopPropagation();
      node._expanded = !node._expanded;
      const p = node.path;
      if (p) {
        if (node._expanded) expandedPaths.add(p); else expandedPaths.delete(p);
        saveExpandedPaths();
      }
      toggle.classList.toggle('expanded', node._expanded);
      scheduleDlRender();
    };
    row.insertBefore(toggle, row.firstChild);
  } 
  // append connector immediately after toggle so icon appears to the right of elbow
  if (connectorEl) row.appendChild(connectorEl);
  // icon cell
  const icon = document.createElement('span');
  icon.className = 'file-icon';
  // use lucide icons (folder / file)
  const iconSpan = document.createElement('span');
  let iconName = 'file';
  if (node.isDir) iconName = node._expanded ? 'folder-open' : 'folder';
  iconSpan.setAttribute('data-lucide', iconName);
  icon.appendChild(iconSpan);
  row.appendChild(icon);
  row.appendChild(main);
  row.appendChild(actions);

  // row click selects (Windows nav style). Ignore clicks on interactive children.
  // row click selection removed
  return row;
}

function flattenTree(nodes, acc=[]) {
  for (const n of nodes) {
    acc.push(n);
    if (n.isDir && n._expanded && Array.isArray(n.children)) flattenTree(n.children, acc);
  }
  return acc;
}

let dlTreeCache = null;
let dlTreeAutoExpandDone = false;
async function renderDlTree() {
  const container = document.getElementById('dlList');
  container.classList.add('tree-mode'); // keep for logic, styling redefined
  container.innerHTML = '';
  if (!dlTreeCache) {
    // skeleton
    for (let i=0;i<4;i++) { const s=document.createElement('div'); s.className='skeleton'; container.appendChild(s);} 
  dlTreeCache = await fetchDlTree();
  // clear skeletons after load attempt
  container.innerHTML = '';
  dlTreeAutoExpandDone = false; // reset auto-expand flag after fresh fetch
  // collapse all directories by default
  try {
    const roots = (dlTreeCache.root || []);
    const clear = (n) => { if (n && n.isDir) { delete n._expanded; } if (n && Array.isArray(n.children)) n.children.forEach(clear); };
    roots.forEach(clear);
  } catch(_){}
  // Re-apply persisted expansion state
  try {
    const apply = (n) => {
      if (!n) return;
      if (n.isDir && n.path && expandedPaths.has(n.path)) n._expanded = true;
      if (n.children) n.children.forEach(apply);
    };
    (dlTreeCache.root || []).forEach(apply);
  } catch(_) {}
  }
  const roots = dlTreeCache.root || [];
  // apply query filter by marking visibility
  const q = dlQuery.toLowerCase();
  function markVisible(node) {
    let match = !q || (node.name && node.name.toLowerCase().includes(q));
    if (node.isDir && Array.isArray(node.children)) {
      let childMatch = false;
      node.children.forEach(c => { if (markVisible(c)) childMatch = true; });
      match = match || childMatch;
    }
    node._visible = match;
    return match;
  }
  roots.forEach(r => markVisible(r));
  // compute total number of files (non-directories) matching current query, independent of expansion state
  dlTotal = 0;
  (function countFiles(list){
    if (!Array.isArray(list)) return;
    for (const n of list) {
      if (!n) continue;
      if (n._visible) {
        if (!n.isDir) dlTotal++;
        if (n.isDir && Array.isArray(n.children)) countFiles(n.children);
      }
    }
  })(roots);
  // auto-expand dirs with visible descendants
  function autoExpand(node, depth=0) {
    if (node.isDir && Array.isArray(node.children)) {
      const anyChildVisible = node.children.some(c => c._visible);
      if (anyChildVisible && depth < 6) node._expanded = true;
      node.children.forEach(c => autoExpand(c, depth+1));
    }
  }
  // autoExpand disabled: directories remain collapsed by default
  const flat = flattenTree(roots).filter(n => n._visible);
  if (flat.length === 0) { container.textContent = '(empty)'; return; }
  flat.forEach((n, idx) => {
    const depth = (n.path || '').split('/').filter(Boolean).length - 1;
    let isLast = false;
    let isFirst = false;
    // Determine if this node is the first FILE (non-directory) child under its parent, ignoring preceding directory siblings.
    if (!n.isDir) {
      // Walk backwards over siblings at same depth; if we find a file, not first; if we reach a shallower depth without finding a file, it's first.
      let j = idx - 1;
      let sawFileBefore = false;
      while (j >= 0) {
        const prev = flat[j];
        const prevDepth = (prev.path || '').split('/').filter(Boolean).length - 1;
        if (prevDepth < depth) break; // hit parent boundary
        if (prevDepth === depth && !prev.isDir) { sawFileBefore = true; break; }
        j--;
      }
      if (!sawFileBefore) isFirst = true;
    }
    if (idx === flat.length - 1) isLast = true; else {
      const next = flat[idx + 1];
      const nextDepth = (next.path || '').split('/').filter(Boolean).length - 1;
      if (nextDepth < depth) isLast = true;
    }
    container.appendChild(createTreeNode(n, depth, isLast, isFirst));
  });
  // dynamic extension for first file under a parent (to reach parent's chevron tip)
  try {
    const rows = Array.from(container.querySelectorAll('.dl-item'));
    rows.forEach(row => {
      const conn = row.querySelector('.tree-connector.first');
      if (!conn) return;
      const depthCls = Array.from(row.classList).find(c=>c.startsWith('depth-'));
      if (!depthCls) return;
      const depth = Number(depthCls.replace('depth-',''));
      if (isNaN(depth) || depth < 1) return;
      // Find parent row (closest previous with smaller depth)
      let parentRow = null;
      for (let p = row.previousElementSibling; p; p = p.previousElementSibling) {
        const pc = Array.from(p.classList).find(c=>c.startsWith('depth-'));
        if (!pc) continue;
        const pd = Number(pc.replace('depth-',''));
        if (pd === depth - 1) { parentRow = p; break; }
        if (pd < depth - 1) break;
      }
      if (!parentRow) return;
      const parentToggle = parentRow.querySelector('.toggle');
      // measure from current row's top to parent's mid-line (chevron vertical center)
      const parentRect = parentToggle ? parentToggle.getBoundingClientRect() : parentRow.getBoundingClientRect();
      const childRect = row.getBoundingClientRect();
  // target bottom edge of chevron (toggle) while horizontally centered; measure from bottom
  const chevronBottomY = parentRect.top + parentRect.height; 
  const extend = Math.max(0, Math.round(childRect.top - chevronBottomY));
      conn.style.setProperty('--extend', extend + 'px');
    });
  } catch(_) {}
  if (renameFocusPath) {
    requestAnimationFrame(() => {
      const inp = container.querySelector(`input.rename-input[data-path="${CSS.escape(renameFocusPath)}"]`);
      if (inp) { inp.focus(); inp.select(); }
      renameFocusPath = null;
    });
  }
  // ensure lucide icons re-render for dynamic nodes (expand/collapse/refresh)
  try { refreshIcons(); } catch(_) {}
}

// Show total items count
function renderPager() {
  try {
    const el = document.getElementById('dlTotal');
    if (el) el.textContent = `${dlTotal} items`;
  } catch(_) {}
}

// Public refresh helper (async because renderDlTree is async)
async function refreshDlList() {
  await renderDlTree();
  renderPager();
  // ensure connectors updated after any reflow
  requestAnimationFrame(() => adjustFirstChildConnectors());
}

let pendingDeleteIsDir = false;
function showDeletePath(relPath, isDir) {
  pendingDelete = relPath; // reuse
  pendingDeleteIsDir = !!isDir;
  const label = isDir ? 'directory' : 'file';
  document.getElementById('modalText').textContent = `Delete ${label} ${decodeURIComponent(relPath)}?${isDir ? ' (recursive)' : ''}`;
  const m = document.getElementById('modal');
  m.setAttribute('aria-hidden', 'false');
}

function startRename(node) {
  if (!node) return;
  node._renaming = true;
  renameFocusPath = node.path;
  scheduleDlRender();
}

function cancelRename(node) {
  if (!node) return;
  delete node._renaming;
  scheduleDlRender();
}

function commitRename(node, newName) {
  if (!node) return;
  const currentName = node.name;
  const relPath = node.path;
  const trimmed = (newName || '').trim();
  if (!trimmed || trimmed === currentName) { cancelRename(node); return; }
  const newPath = relPath.replace(/[^/]+$/, trimmed);
  // optimistic UI: update node then call API; if fails refresh
  delete node._renaming;
  node.name = trimmed;
  renamePath(relPath, newPath, !!node.isDir);
}

async function renamePath(oldPath, newPath, isDir) {
  const form = document.getElementById('uploadForm');
  const username = form.username.value;
  const password = form.password.value;
  try {
    const res = await fetch('/uploader/dl/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, oldPath, newPath })
    });
    if (res.status === 404) {
      // try alias
      const res2 = await fetch('/dl/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, oldPath, newPath })
      });
      if (res2.ok) {
        toast('Renamed successfully', 'success');
        dlTreeCache = null;
        scheduleDlRender();
        return;
      }
    }
    if (res.ok) {
      toast('Renamed successfully', 'success');
      dlTreeCache = null;
      scheduleDlRender();
    } else if (res.status === 401) {
      toast('Unauthorized: check username/password', 'error');
    } else if (res.status === 404) {
      toast('Item not found', 'error');
    } else if (res.status === 409) {
      toast('Name already exists', 'error');
    } else {
      toast('Rename failed', 'error');
    }
  } catch (e) {
    toast('Rename failed', 'error');
  }
}

function savePagerState() {
  try {
    localStorage.setItem('uploader_dl_page', String(dlPage));
    localStorage.setItem('uploader_dl_perPage', String(dlPerPage));
    localStorage.setItem('uploader_dl_query', dlQuery || '');
  } catch (_) {}
}

function loadPagerState() {
  try {
    const p = Number(localStorage.getItem('uploader_dl_page') || 0);
    const per = Number(localStorage.getItem('uploader_dl_perPage') || 0);
    const q = localStorage.getItem('uploader_dl_query') || '';
    if (per > 0) dlPerPage = per;
    if (p > 0) dlPage = p;
    if (q) dlQuery = q;
    const si = document.getElementById('dlSearch');
    if (si && dlQuery) si.value = dlQuery;
  } catch (_) {}
}

function humanSize(n) {
  if (n == null) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function humanTime(ms) {
  try {
    const offsetMs = 3.5 * 60 * 60 * 1000; // 3.5 hours (UTC+3:30)
    const dt = new Date(Number(ms) + offsetMs);
    const yyyy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    const hh = String(dt.getUTCHours()).padStart(2, '0');
    const min = String(dt.getUTCMinutes()).padStart(2, '0');
    const sec = String(dt.getUTCSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${sec} (UTC+3:30)`;
  } catch (_) {
    return '';
  }
}

// flat list removed

let pendingDelete = null;

function showModal(name) {
  pendingDelete = name;
  document.getElementById('modalText').textContent = `Delete ${decodeURIComponent(name)}?`;
  const m = document.getElementById('modal');
  m.setAttribute('aria-hidden', 'false');
  try {
    if (window.lucide) window.lucide.createIcons();
  } catch (_) {}
}

function hideModal() {
  pendingDelete = null;
  const m = document.getElementById('modal');
  m.setAttribute('aria-hidden', 'true');
}

document.getElementById('modalCancel').onclick = hideModal;
document.getElementById('modalConfirm').onclick = async () => {
  if (!pendingDelete) return hideModal();
  const form = document.getElementById('uploadForm');
  const username = form.username.value;
  const password = form.password.value;
  async function deleteRecursive(relPath){
    // Prefer POST (less likely filtered) then fallback to DELETE only if needed
    let res = await fetch('/uploader/dl/any-delete', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ username, password, path: relPath }) });
    if (!res.ok) {
      res = await fetch('/dl/any-delete', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ username, password, path: relPath }) });
    }
    if (!res.ok) {
      // final attempts with DELETE (may 404 under some proxies; ignore if already gone)
      res = await fetch('/uploader/dl/any', { method:'DELETE', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ username, password, path: relPath }) });
      if (!res.ok) res = await fetch('/dl/any', { method:'DELETE', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ username, password, path: relPath }) });
    }
    return res.ok;
  }
  async function deleteFile(name){
    let res = await fetch('/uploader/dl/' + encodeURIComponent(name), { method:'DELETE', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ username, password }) });
    if (!res.ok) {
      res = await fetch('/dl/' + encodeURIComponent(name), { method:'DELETE', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ username, password }) });
    }
    if (!res.ok) { // fallback to recursive
      return deleteRecursive(name);
    }
    return res.ok;
  }
  let ok;
  if (pendingDeleteIsDir || pendingDelete.includes('/')) ok = await deleteRecursive(pendingDelete); else ok = await deleteFile(pendingDelete);
  hideModal();
  if (ok) {
    toast('Deleted', 'success');
    dlTreeCache = null; // force fresh
    refreshDlList();
  } else {
    toast('Delete failed', 'error');
  }
};

// Expand / Collapse all controls
const expandAllBtn = document.getElementById('expandAll');
const collapseAllBtn = document.getElementById('collapseAll');
const refreshBtn = document.getElementById('refreshDl');
function setAllExpanded(val) {
  if (!dlTreeCache || !dlTreeCache.root) return;
  const walk = (n) => { if (n.isDir) { n._expanded = val; if (Array.isArray(n.children)) n.children.forEach(walk); } };
  dlTreeCache.root.forEach(walk);
  if (val) {
    // add all dir paths
    try {
      const collect = (n) => { if (n.isDir && n.path) expandedPaths.add(n.path); if (n.children) n.children.forEach(collect); };
      dlTreeCache.root.forEach(collect);
    } catch(_) {}
  } else {
    expandedPaths.clear();
  }
  saveExpandedPaths();
  scheduleDlRender();
}
if (expandAllBtn) expandAllBtn.onclick = () => setAllExpanded(true);
if (collapseAllBtn) collapseAllBtn.onclick = () => setAllExpanded(false);
if (refreshBtn) refreshBtn.onclick = () => { dlTreeCache = null; scheduleDlRender(); };

// toggle removed

// Initial load
loadPagerState();
refreshDlList();
// Apply Windows style tree classes
try {
  document.getElementById('dlList').classList.add('win-tree');
  document.querySelector('.files-tree-wrapper')?.classList.add('win-style');
} catch(_) {}

// Ensure connector adjustments after fonts fully loaded
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => {
    adjustFirstChildConnectors();
  });
}
window.addEventListener('resize', () => {
  // recalc after layout changes
  adjustFirstChildConnectors();
});

// Removed wheel proxy: allow normal page scrolling everywhere; tree now flows with page height.

// Accessibility: show focus outlines only when keyboard navigating
(() => {
  let usingKeyboard = false;
  function setKeyboard(v) {
    if (v !== usingKeyboard) {
      usingKeyboard = v;
      document.body.classList.toggle('keyboard-nav', v);
    }
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' || e.key === 'ArrowDown' || e.key === 'ArrowUp') setKeyboard(true);
  });
  window.addEventListener('mousedown', () => setKeyboard(false));
})();
