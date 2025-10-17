import { toast, refreshIcons } from './utils.js';

export function initJobs(options = {}) {
  const { onDownloadsChanged = () => {} } = options;
  const jobsById = {};
  const sseAttached = new Set();
  let renderScheduled = false;
  // Track current DOM mapping and job ids to avoid full redraws
  const domById = new Map();
  let lastSortedIds = [];
  let lastSortedKey = '';

  function sortKey(job) {
    const nameFromTmp = (job.tmpPath && job.tmpPath.split('/').pop()) || '';
    const urlPath = (job.fileUrl || '').split('?')[0];
    const nameFromUrl = (urlPath && urlPath.split('/').pop()) || '';
    const key = nameFromTmp || nameFromUrl || job.fileUrl || '';
    return String(key).toLowerCase();
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
    if (!list) return;
    // Compute stable alphabetical order
    const ids = Object.keys(jobsById);
    const sortedIds = ids.sort((a, b) => sortKey(jobsById[a]).localeCompare(sortKey(jobsById[b]), undefined, { sensitivity: 'base' }));
    // Toggle Remove All visibility based on count
    const btnRemoveAll = document.getElementById('btnRemoveAll');
    if (btnRemoveAll) btnRemoveAll.style.display = sortedIds.length > 0 ? '' : 'none';

    const sortedKey = sortedIds.join('|');
    const setChanged = sortedIds.length !== lastSortedIds.length || sortedIds.some((id) => !domById.has(id));

    if (setChanged) {
      // Add/remove happened: rebuild once in correct alphabetical order
      list.innerHTML = '';
      domById.clear();
      sortedIds.forEach((id) => {
        const job = jobsById[id];
        const el = createJobNode(job);
        domById.set(id, el);
        list.appendChild(el);
      });
      lastSortedIds = sortedIds.slice();
      lastSortedKey = sortedKey;
      refreshIcons();
      return;
    }

    // If only the order changed, reorder nodes without recreating
    if (sortedKey !== lastSortedKey) {
      sortedIds.forEach((id) => {
        const node = domById.get(id);
        if (node && node.parentElement === list) list.appendChild(node);
      });
      lastSortedIds = sortedIds.slice();
      lastSortedKey = sortedKey;
    }

    // Update existing nodes in place
    sortedIds.forEach((id) => {
      const job = jobsById[id];
      const el = domById.get(id);
      if (!el) return;
      updateJobNode(el, job);
    });
    // No icon refresh needed if not adding new icons
  }

  async function refreshJobs() {
    const res = await fetch('/uploader/jobs');
    const list = await res.json();
    list.forEach((job) => {
      jobsById[job.id] = job;
      if (!jobsById[job.id].type) jobsById[job.id].type = job.type || 'upload';
      // Attach SSE only for truly active jobs after refresh
      const st = (jobsById[job.id].status || '').toLowerCase();
      const active = st === 'downloading' || st === 'uploading';
      if (active && !sseAttached.has(job.id)) attachSse(job.id);
    });
    scheduleRenderJobs();
  }

  async function refreshFree() {
    try {
      const res = await fetch('/uploader/system/free-space');
      const data = await res.json();
      const el = document.getElementById('freeSpace');
      if (el) el.textContent = data.free || JSON.stringify(data);
    } catch (error) {
      const el = document.getElementById('freeSpace');
      if (el) el.textContent = 'error';
    }
  }

  async function runAction(saveToDl) {
    const form = document.getElementById('uploadForm');
    if (!form) return;
    const username = form.username.value;
    const password = form.password.value;
    const fileName = (form.fileName && form.fileName.value || '').trim();
    const lines = (form.fileUrls.value || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const total = lines.length;

    for (let idx = 0; idx < lines.length; idx++) {
      const fileUrl = lines[idx];
      const numberedName = fileName
        ? (total > 1 ? `${fileName} (${idx + 1})` : fileName)
        : undefined;
      const res = await fetch('/uploader/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, fileUrl, saveToDl, fileName: numberedName })
      });
      if (!res.ok) {
        const text = await res.text();
        toast('Error: ' + text, 'error');
        return;
      }
      const job = await res.json();
      jobsById[job.jobId] = {
        id: job.jobId,
        fileUrl,
        status: 'queued',
        percent: 0,
        type: job.type || 'upload'
      };
      scheduleRenderJobs();
    }
    refreshJobs();
  }

  function createJobNode(job) {
    const el = document.createElement('div');
    el.className = 'job panel';
    el.dataset.jobId = job.id;
    el.classList.add('enter');

    const header = document.createElement('div');
    header.className = 'job-header';
    const url = document.createElement('strong');
    url.className = 'url';
    url.title = job.fileUrl;
    url.textContent = job.fileUrl;
    header.appendChild(url);
    const badgeNode = document.createElement('span');
    badgeNode.className = 'badge';
    header.appendChild(badgeNode);

    const statusWrap = document.createElement('div');
    statusWrap.className = 'meta';
    const statusSpan = document.createElement('span');
    statusSpan.className = 'status';
    statusWrap.innerHTML = 'Status: ';
    statusWrap.appendChild(statusSpan);

    const progWrap = document.createElement('div');
    progWrap.className = 'job-progress-wrap';
    const prog = document.createElement('progress');
    prog.max = 100;
    prog.className = 'job-progress';
    const pct = document.createElement('span');
    pct.className = 'job-percent';
    progWrap.appendChild(prog);
    progWrap.appendChild(pct);

    const savedMeta = document.createElement('div');
    savedMeta.className = 'meta saved-meta';
    savedMeta.style.display = 'none';
    const publicMeta = document.createElement('div');
    publicMeta.className = 'meta public-meta';
    publicMeta.style.display = 'none';

    const actions = document.createElement('div');
    actions.className = 'job-actions';
    const delBtn = document.createElement('button');
    delBtn.className = 'btn del danger';
    delBtn.setAttribute('data-id', job.id);
    delBtn.textContent = 'Remove';
    delBtn.onclick = async (event) => {
      const id = event.target.getAttribute('data-id');
      await fetch(`/uploader/jobs/${id}`, { method: 'DELETE' });
      delete jobsById[id];
      const node = domById.get(id);
      if (node) {
        node.classList.add('exit');
        setTimeout(() => renderJobs(), 300);
      } else {
        renderJobs();
      }
    };
    actions.appendChild(delBtn);

    el.appendChild(header);
    el.appendChild(statusWrap);
    el.appendChild(progWrap);
    el.appendChild(savedMeta);
    el.appendChild(publicMeta);
    el.appendChild(actions);

    updateJobNode(el, job);
    return el;
  }

  function updateJobNode(el, job) {
    // type and classes
    let jobType = job.type || 'upload';
    if (!job.type) {
      if (job.publicUrl || (job.tmpPath && job.tmpPath.startsWith('/var/www/dl')) || job.status === 'saved') {
        jobType = 'download';
      }
    }
    el.classList.toggle('upload', jobType === 'upload');
    el.classList.toggle('download', jobType === 'download');

    const badgeNode = el.querySelector('.badge');
    if (badgeNode) {
      badgeNode.className = `badge ${jobType}`;
      badgeNode.textContent = jobType === 'download' ? 'Download' : 'Upload';
    }

    const statusSpan = el.querySelector('.status');
    if (statusSpan) statusSpan.textContent = job.status;

    const prog = el.querySelector('.job-progress');
    const pct = el.querySelector('.job-percent');
    const pctVal = Number.isFinite(job.percent) ? Math.max(0, Math.min(100, Math.round(job.percent))) : 0;
    if (prog) prog.value = pctVal;
    if (pct) pct.textContent = `${pctVal}%`;

    // saved/public meta
    const savedMeta = el.querySelector('.saved-meta');
    const publicMeta = el.querySelector('.public-meta');
    let savedLinkUrl = null;
    let savedContent = '';
    if (jobType === 'download' && job.tmpPath && job.tmpPath.startsWith('/var/www/dl')) {
      const fileName = job.tmpPath.split('/').pop();
      savedLinkUrl = `${window.location.origin}/dl/${encodeURIComponent(fileName)}`;
      savedContent = `Saved: <a href="${savedLinkUrl}" target="_blank">${savedLinkUrl}</a>`;
    } else if (jobType === 'download' && job.tmpPath) {
      savedContent = `Saved: ${job.tmpPath}`;
    }
    if (savedMeta) {
      if (savedContent) {
        savedMeta.innerHTML = savedContent;
        savedMeta.style.display = '';
      } else {
        savedMeta.style.display = 'none';
        savedMeta.innerHTML = '';
      }
    }
    const publicUrl = jobType === 'download' ? (job.publicUrl || null) : null;
    const publicContent = publicUrl ? `Link: <a href="${publicUrl}" target="_blank">${publicUrl}</a>` : '';
    if (publicMeta) {
      if (publicContent && publicUrl !== savedLinkUrl) {
        publicMeta.innerHTML = publicContent;
        publicMeta.style.display = '';
      } else {
        publicMeta.style.display = 'none';
        publicMeta.innerHTML = '';
      }
    }
  }

  function attachSse(jobId) {
    if (sseAttached.has(jobId)) return;
    const evt = new EventSource(`/uploader/events/${jobId}`);
    sseAttached.add(jobId);
    evt.onmessage = () => {};
    evt.addEventListener('status', (event) => {
      const data = JSON.parse(event.data);
      if (jobsById[jobId]) {
        jobsById[jobId].status = data.status;
        scheduleRenderJobs();
      }
    });
    evt.addEventListener('downloadProgress', (event) => {
      const data = JSON.parse(event.data);
      if (jobsById[jobId]) {
        jobsById[jobId].status = 'downloading';
        jobsById[jobId].percent = data.percent || 0;
        scheduleRenderJobs();
      }
    });
    evt.addEventListener('downloadComplete', (event) => {
      const data = JSON.parse(event.data);
      if (jobsById[jobId]) {
        jobsById[jobId].status = 'downloaded';
        jobsById[jobId].percent = 100;
        scheduleRenderJobs();
      }
    });
    evt.addEventListener('downloadSaved', (event) => {
      const data = JSON.parse(event.data);
      if (jobsById[jobId]) {
        jobsById[jobId].status = 'saved';
        jobsById[jobId].percent = 100;
        jobsById[jobId].tmpPath = data.path;
        jobsById[jobId].publicUrl = data.publicUrl;
        jobsById[jobId].type = 'download';
        scheduleRenderJobs();
      }
      onDownloadsChanged();
    });
    evt.addEventListener('uploadStart', () => {
      if (jobsById[jobId]) {
        jobsById[jobId].status = 'uploading';
        jobsById[jobId].percent = 0;
        jobsById[jobId].type = 'upload';
        scheduleRenderJobs();
      }
    });
    evt.addEventListener('uploadProgress', (event) => {
      const data = JSON.parse(event.data);
      if (jobsById[jobId]) {
        jobsById[jobId].percent = data.percent || 0;
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
      sseAttached.delete(jobId);
    });
    evt.addEventListener('error', (event) => {
      const data = JSON.parse(event.data || '{}');
      if (jobsById[jobId]) {
        jobsById[jobId].status = 'error';
        jobsById[jobId].message = data.message;
        scheduleRenderJobs();
      }
      evt.close();
      sseAttached.delete(jobId);
    });
  }

  const uploadBtn = document.getElementById('btnUpload');
  if (uploadBtn) uploadBtn.onclick = () => runAction(false);
  const downloadBtn = document.getElementById('btnDownload');
  if (downloadBtn) downloadBtn.onclick = () => runAction(true);

  const btnRemoveAll = document.getElementById('btnRemoveAll');
  if (btnRemoveAll) {
    // Hide initially until we know there are jobs
    btnRemoveAll.style.display = 'none';
    btnRemoveAll.onclick = async () => {
    // Remove all jobs from server and UI; server will cancel active if needed
    const ids = Object.values(jobsById).map((j) => j.id);
    for (const id of ids) {
      try { await fetch(`/uploader/jobs/${id}`, { method: 'DELETE' }); } catch (_) {}
      delete jobsById[id];
    }
    scheduleRenderJobs();
  };
  }

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
      try {
        const form = document.getElementById('uploadForm');
        if (form) {
          if (form.username && form.username.value) formData.append('username', form.username.value);
          if (form.password && form.password.value) formData.append('password', form.password.value);
        }
      } catch (_) {}
      btnUploadCookies.disabled = true;
      btnUploadCookies.textContent = 'Uploading...';
      let success = false;
      try {
        let res = await fetch('/uploader/metube/cookies', { method: 'POST', body: formData });
        if (res.status === 404) {
          res = await fetch('/metube/cookies', { method: 'POST', body: formData });
        }
        if (res.ok) {
          toast('cookies.txt uploaded and MeTube reloaded!', 'success');
          success = true;
        } else {
          const msg = await res.text();
          toast('Upload failed: ' + msg, 'error');
        }
      } catch (error) {
        toast('Upload error: ' + error, 'error');
      }
      btnUploadCookies.disabled = false;
      btnUploadCookies.textContent = success ? 'Uploaded!' : 'Upload cookies.txt';
      setTimeout(() => {
        if (btnUploadCookies.textContent === 'Uploaded!') btnUploadCookies.textContent = 'Upload cookies.txt';
      }, 2000);
      fileInput.value = '';
    };
  }

  refreshJobs();
  refreshFree();
  setInterval(refreshFree, 30_000);
  // Poll to detect queued -> active transitions without opening SSE for every queued job
  setInterval(refreshJobs, 5000);

  // Expose a lightweight global helper so other modules (e.g., dl-tree) can add jobs and attach SSE streams
  try {
    window.uploaderAddJobs = (arr) => {
      if (!Array.isArray(arr)) return;
      arr.forEach((j) => {
        const id = j && (j.jobId || j.id);
        const fileUrl = (j && (j.fileUrl || j.path)) || '';
        if (!id) return;
        if (!jobsById[id]) {
          jobsById[id] = { id, fileUrl, status: 'queued', percent: 0, type: 'upload' };
        }
        // Do not open SSE here; polling will attach when active
      });
      scheduleRenderJobs();
    };
  } catch (_) {}

  return {
    refreshJobs,
    refreshFree
  };
}
