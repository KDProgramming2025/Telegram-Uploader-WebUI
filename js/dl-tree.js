import { toast, refreshIcons } from './utils.js';

export function initDownloadTree() {
  let dlPage = 1;
  let dlPerPage = 20;
  let dlQuery = '';
  let dlTotal = 0;
  let renameFocusPath = null;
  let selectedDlPath = null;
  let expandedPaths = new Set();
  let dlTreeCache = null;
  let dlTreeAutoExpandDone = false;
  let _dlRenderScheduled = false;
  let pendingDelete = null;
  let pendingDeleteIsDir = false;

  function loadExpandedPaths() {
    try {
      const raw = localStorage.getItem('uploader_expanded_paths');
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) expandedPaths = new Set(arr);
    } catch (_) {}
  }

  function saveExpandedPaths() {
    try {
      localStorage.setItem('uploader_expanded_paths', JSON.stringify(Array.from(expandedPaths)));
    } catch (_) {}
  }

  function scheduleDlRender() {
    if (_dlRenderScheduled) return;
    _dlRenderScheduled = true;
    requestAnimationFrame(() => {
      _dlRenderScheduled = false;
      refreshDlList();
    });
  }

  async function fetchDlTree() {
    try {
      let res = await fetch('/uploader/dl/tree');
      if (!res.ok) {
        res = await fetch('/dl/tree');
      }
      if (!res.ok) return { root: [] };
      return await res.json();
    } catch (_) {
      return { root: [] };
    }
  }

  function createTreeNode(node, depth = 0, isLast = false, isFirst = false) {
    const row = document.createElement('div');
    row.className = 'dl-item depth-' + depth + (node.isDir ? ' dir' : ' file');
    row.dataset.path = node.path || '';
    row.classList.add('anim-enter');
    const hue = (depth * 52) % 360;
    row.style.setProperty('--conn-color', `hsl(${hue} 70% 70% / 0.68)`);

    const main = document.createElement('div');
    main.className = 'dl-item-main';

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
      input.onkeydown = (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commitRename(node, input.value);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancelRename(node);
        }
      };
      input.onblur = () => {
        commitRename(node, input.value);
      };
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
      const link = document.createElement('a');
      link.href = '/dl/' + encodeURIComponent(node.path);
      link.target = '_blank';
      link.className = 'name';
      link.textContent = node.name || '(root)';
      wrap.appendChild(link);
      nameEl = wrap;
    }

    const meta = document.createElement('div');
    meta.className = 'dl-meta';
    if (node.isDir) {
      meta.textContent = 'dir';
    } else {
      meta.textContent = humanSize(node.size) + (node.mtime ? ' • ' + humanTime(node.mtime) : '');
    }
    main.appendChild(nameEl);
    if (!node._renaming) main.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const renameBtn = document.createElement('button');
    renameBtn.className = 'icon-btn secondary';
    renameBtn.innerHTML = '<span data-lucide="edit-3"></span>';
    renameBtn.onclick = () => {
      startRename(node);
    };
    actions.appendChild(renameBtn);
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'icon-btn danger';
    deleteBtn.innerHTML = '<span data-lucide="trash-2"></span>';
    deleteBtn.onclick = () => {
      showDeletePath(node.path, !!node.isDir);
    };
    actions.appendChild(deleteBtn);

    if (node.isDir) {
      const toggle = document.createElement('button');
      toggle.className = 'toggle';
      toggle.innerHTML = `<span data-lucide="${node._expanded ? 'chevron-down' : 'chevron-right'}"></span>`;
      toggle.setAttribute('aria-label', node._expanded ? 'Collapse' : 'Expand');
      if (node._expanded) toggle.classList.add('expanded');
      toggle.onclick = (event) => {
        event.stopPropagation();
        node._expanded = !node._expanded;
        const path = node.path;
        if (path) {
          if (node._expanded) expandedPaths.add(path);
          else expandedPaths.delete(path);
          saveExpandedPaths();
        }
        toggle.classList.toggle('expanded', node._expanded);
        scheduleDlRender();
      };
      row.insertBefore(toggle, row.firstChild);
    }

    if (connectorEl) row.appendChild(connectorEl);

    const icon = document.createElement('span');
    icon.className = 'file-icon';
    const iconSpan = document.createElement('span');
    let iconName = 'file';
    if (node.isDir) iconName = node._expanded ? 'folder-open' : 'folder';
    iconSpan.setAttribute('data-lucide', iconName);
    icon.appendChild(iconSpan);
    row.appendChild(icon);
    row.appendChild(main);
    row.appendChild(actions);

    return row;
  }

  function flattenTree(nodes, acc = []) {
    for (const node of nodes) {
      acc.push(node);
      if (node.isDir && node._expanded && Array.isArray(node.children)) {
        flattenTree(node.children, acc);
      }
    }
    return acc;
  }

  async function renderDlTree() {
    const container = document.getElementById('dlList');
    if (!container) return;
    container.classList.add('tree-mode');
    container.innerHTML = '';
    if (!dlTreeCache) {
      for (let i = 0; i < 4; i++) {
        const skeleton = document.createElement('div');
        skeleton.className = 'skeleton';
        container.appendChild(skeleton);
      }
      dlTreeCache = await fetchDlTree();
      container.innerHTML = '';
      dlTreeAutoExpandDone = false;
      try {
        const roots = dlTreeCache.root || [];
        const clear = (node) => {
          if (!node) return;
          if (node.isDir) delete node._expanded;
          if (Array.isArray(node.children)) node.children.forEach(clear);
        };
        roots.forEach(clear);
      } catch (_) {}
      try {
        const apply = (node) => {
          if (!node) return;
          if (node.isDir && node.path && expandedPaths.has(node.path)) node._expanded = true;
          if (node.children) node.children.forEach(apply);
        };
        (dlTreeCache.root || []).forEach(apply);
      } catch (_) {}
    }

    const roots = dlTreeCache.root || [];
    const query = dlQuery.toLowerCase();

    function markVisible(node) {
      let match = !query || (node.name && node.name.toLowerCase().includes(query));
      if (node.isDir && Array.isArray(node.children)) {
        let childMatch = false;
        node.children.forEach((child) => {
          if (markVisible(child)) childMatch = true;
        });
        match = match || childMatch;
      }
      node._visible = match;
      return match;
    }

    roots.forEach((root) => markVisible(root));

    dlTotal = 0;
    (function countFiles(list) {
      if (!Array.isArray(list)) return;
      for (const node of list) {
        if (!node) continue;
        if (node._visible) {
          if (!node.isDir) dlTotal++;
          if (node.isDir && Array.isArray(node.children)) countFiles(node.children);
        }
      }
    })(roots);

    const flat = flattenTree(roots).filter((node) => node._visible);
    if (flat.length === 0) {
      container.textContent = '(empty)';
      return;
    }

    flat.forEach((node, index) => {
      const depth = (node.path || '').split('/').filter(Boolean).length - 1;
      let isLast = false;
      let isFirst = false;
      if (!node.isDir) {
        let j = index - 1;
        let sawFileBefore = false;
        while (j >= 0) {
          const prev = flat[j];
          const prevDepth = (prev.path || '').split('/').filter(Boolean).length - 1;
          if (prevDepth < depth) break;
          if (prevDepth === depth && !prev.isDir) {
            sawFileBefore = true;
            break;
          }
          j--;
        }
        if (!sawFileBefore) isFirst = true;
      }
      if (index === flat.length - 1) {
        isLast = true;
      } else {
        const next = flat[index + 1];
        const nextDepth = (next.path || '').split('/').filter(Boolean).length - 1;
        if (nextDepth < depth) isLast = true;
      }
      container.appendChild(createTreeNode(node, depth, isLast, isFirst));
    });

    try {
      const rows = Array.from(container.querySelectorAll('.dl-item'));
      rows.forEach((row) => {
        const connector = row.querySelector('.tree-connector.first');
        if (!connector) return;
        const depthCls = Array.from(row.classList).find((cls) => cls.startsWith('depth-'));
        if (!depthCls) return;
        const depth = Number(depthCls.replace('depth-', ''));
        if (Number.isNaN(depth) || depth < 1) return;
        let parentRow = null;
        for (let p = row.previousElementSibling; p; p = p.previousElementSibling) {
          const prevCls = Array.from(p.classList).find((cls) => cls.startsWith('depth-'));
          if (!prevCls) continue;
          const prevDepth = Number(prevCls.replace('depth-', ''));
          if (prevDepth === depth - 1) {
            parentRow = p;
            break;
          }
          if (prevDepth < depth - 1) break;
        }
        if (!parentRow) return;
        const parentToggle = parentRow.querySelector('.toggle');
        const parentRect = parentToggle ? parentToggle.getBoundingClientRect() : parentRow.getBoundingClientRect();
        const childRect = row.getBoundingClientRect();
        const chevronBottomY = parentRect.top + parentRect.height;
        const extend = Math.max(0, Math.round(childRect.top - chevronBottomY));
        connector.style.setProperty('--extend', extend + 'px');
      });
    } catch (_) {}

    if (renameFocusPath) {
      requestAnimationFrame(() => {
        const input = container.querySelector(`input.rename-input[data-path="${CSS.escape(renameFocusPath)}"]`);
        if (input) {
          input.focus();
          input.select();
        }
        renameFocusPath = null;
      });
    }

    try {
      refreshIcons();
    } catch (_) {}
  }

  function renderPager() {
    try {
      const el = document.getElementById('dlTotal');
      if (el) el.textContent = `${dlTotal} items`;
    } catch (_) {}
  }

  async function refreshDlList() {
    await renderDlTree();
    renderPager();
    requestAnimationFrame(() => adjustFirstChildConnectors());
  }

  function showDeletePath(relPath, isDir) {
    pendingDelete = relPath;
    pendingDeleteIsDir = !!isDir;
    const label = isDir ? 'directory' : 'file';
    const modalText = document.getElementById('modalText');
    if (modalText) {
      modalText.textContent = `Delete ${label} ${decodeURIComponent(relPath)}?${isDir ? ' (recursive)' : ''}`;
    }
    const modal = document.getElementById('modal');
    if (modal) modal.setAttribute('aria-hidden', 'false');
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
    if (!trimmed || trimmed === currentName) {
      cancelRename(node);
      return;
    }
    const newPath = relPath.replace(/[^/]+$/, trimmed);
    delete node._renaming;
    node.name = trimmed;
    renamePath(relPath, newPath, !!node.isDir);
  }

  async function renamePath(oldPath, newPath) {
    const form = document.getElementById('uploadForm');
    if (!form) return;
    const username = form.username.value;
    const password = form.password.value;
    try {
      const res = await fetch('/uploader/dl/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, oldPath, newPath })
      });
      if (res.status === 404) {
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
    } catch (_) {
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
      const searchInput = document.getElementById('dlSearch');
      if (searchInput && dlQuery) searchInput.value = dlQuery;
    } catch (_) {}
  }

  function humanSize(n) {
    if (n == null) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let value = n;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
  }

  function humanTime(ms) {
    try {
      const offsetMs = 3.5 * 60 * 60 * 1000;
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

  function hideModal() {
    pendingDelete = null;
    const modal = document.getElementById('modal');
    if (modal) modal.setAttribute('aria-hidden', 'true');
  }

  async function handleDeleteConfirm() {
    if (!pendingDelete) {
      hideModal();
      return;
    }
    const form = document.getElementById('uploadForm');
    if (!form) {
      hideModal();
      return;
    }
    const username = form.username.value;
    const password = form.password.value;

    async function deleteRecursive(relPath) {
      let res = await fetch('/uploader/dl/any-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, path: relPath })
      });
      if (!res.ok) {
        res = await fetch('/dl/any-delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password, path: relPath })
        });
      }
      if (!res.ok) {
        res = await fetch('/uploader/dl/any', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password, path: relPath })
        });
        if (!res.ok) {
          res = await fetch('/dl/any', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, path: relPath })
          });
        }
      }
      return res.ok;
    }

    async function deleteFile(name) {
      let res = await fetch('/uploader/dl/' + encodeURIComponent(name), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      if (!res.ok) {
        res = await fetch('/dl/' + encodeURIComponent(name), {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
      }
      if (!res.ok) {
        return deleteRecursive(name);
      }
      return res.ok;
    }

    const ok = pendingDeleteIsDir || pendingDelete.includes('/')
      ? await deleteRecursive(pendingDelete)
      : await deleteFile(pendingDelete);

    hideModal();
    if (ok) {
      toast('Deleted', 'success');
      dlTreeCache = null;
      refreshDlList();
    } else {
      toast('Delete failed', 'error');
    }
  }

  function setAllExpanded(val) {
    if (!dlTreeCache || !dlTreeCache.root) return;
    const walk = (node) => {
      if (node.isDir) {
        node._expanded = val;
        if (Array.isArray(node.children)) node.children.forEach(walk);
      }
    };
    dlTreeCache.root.forEach(walk);
    if (val) {
      try {
        const collect = (node) => {
          if (node.isDir && node.path) expandedPaths.add(node.path);
          if (node.children) node.children.forEach(collect);
        };
        dlTreeCache.root.forEach(collect);
      } catch (_) {}
    } else {
      expandedPaths.clear();
    }
    saveExpandedPaths();
    scheduleDlRender();
  }

  document.getElementById('modalCancel')?.addEventListener('click', hideModal);
  document.getElementById('modalConfirm')?.addEventListener('click', handleDeleteConfirm);

  const expandAllBtn = document.getElementById('expandAll');
  const collapseAllBtn = document.getElementById('collapseAll');
  const refreshBtn = document.getElementById('refreshDl');
  if (expandAllBtn) expandAllBtn.onclick = () => setAllExpanded(true);
  if (collapseAllBtn) collapseAllBtn.onclick = () => setAllExpanded(false);
  if (refreshBtn) refreshBtn.onclick = () => {
    dlTreeCache = null;
    scheduleDlRender();
  };

  loadExpandedPaths();
  loadPagerState();
  refreshDlList();

  try {
    document.getElementById('dlList')?.classList.add('win-tree');
    document.querySelector('.files-tree-wrapper')?.classList.add('win-style');
  } catch (_) {}

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      adjustFirstChildConnectors();
    });
  }
  window.addEventListener('resize', () => {
    adjustFirstChildConnectors();
  });

  (function monitorKeyboardNavigation() {
    let usingKeyboard = false;
    function setKeyboard(val) {
      if (val !== usingKeyboard) {
        usingKeyboard = val;
        document.body.classList.toggle('keyboard-nav', val);
      }
    }
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Tab' || event.key === 'ArrowDown' || event.key === 'ArrowUp') setKeyboard(true);
    });
    window.addEventListener('mousedown', () => setKeyboard(false));
  })();

  function adjustFirstChildConnectors() {
    try {
      const container = document.getElementById('dlList');
      if (!container) return;
      const rows = Array.from(container.querySelectorAll('.dl-item'));
      rows.forEach((row) => {
        const conn = row.querySelector('.tree-connector.first');
        if (!conn) return;
        const depthCls = Array.from(row.classList).find((cls) => cls.startsWith('depth-'));
        if (!depthCls) return;
        const depth = Number(depthCls.replace('depth-', ''));
        if (Number.isNaN(depth) || depth < 1) return;
        let parentRow = null;
        for (let p = row.previousElementSibling; p; p = p.previousElementSibling) {
          const pc = Array.from(p.classList).find((cls) => cls.startsWith('depth-'));
          if (!pc) continue;
          const pd = Number(pc.replace('depth-', ''));
          if (pd === depth - 1) {
            parentRow = p;
            break;
          }
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
    } catch (_) {}
  }

  return {
    refreshDlList,
    scheduleDlRender
  };
}
