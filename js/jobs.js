import { toast, refreshIcons } from './utils.js';

export function initJobs(options = {}) {
  const { onDownloadsChanged = () => {} } = options;
  const jobsById = {};
  let renderScheduled = false;

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
    list.innerHTML = '';
    Object.values(jobsById).forEach((job) => {
      const el = document.createElement('div');
      el.className = 'job panel';
      el.classList.add('enter');

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

      if (savedContent) {
        const saved = document.createElement('div');
        saved.className = 'meta';
        saved.innerHTML = savedContent;
        el.appendChild(saved);
      }
      if (publicContent && publicUrl !== savedLinkUrl) {
        const pub = document.createElement('div');
        pub.className = 'meta';
        pub.innerHTML = publicContent;
        el.appendChild(pub);
      }

      const actions = document.createElement('div');
      actions.className = 'job-actions';
      const delBtn = document.createElement('button');
      delBtn.className = 'btn del danger';
      delBtn.setAttribute('data-id', job.id);
      delBtn.textContent = 'Remove';
      actions.appendChild(delBtn);
      el.appendChild(actions);

      list.appendChild(el);
    });

    document.querySelectorAll('#jobsList .del').forEach((btn) => {
      btn.onclick = async (event) => {
        const id = event.target.getAttribute('data-id');
        await fetch(`/uploader/jobs/${id}`, { method: 'DELETE' });
        delete jobsById[id];
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
    list.forEach((job) => {
      jobsById[job.id] = job;
      if (!jobsById[job.id].type) jobsById[job.id].type = job.type || 'upload';
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
      attachSse(job.jobId);
    }
    refreshJobs();
  }

  function attachSse(jobId) {
    const evt = new EventSource(`/uploader/events/${jobId}`);
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
    });
    evt.addEventListener('error', (event) => {
      const data = JSON.parse(event.data || '{}');
      if (jobsById[jobId]) {
        jobsById[jobId].status = 'error';
        jobsById[jobId].message = data.message;
        scheduleRenderJobs();
      }
      evt.close();
    });
  }

  const uploadBtn = document.getElementById('btnUpload');
  if (uploadBtn) uploadBtn.onclick = () => runAction(false);
  const downloadBtn = document.getElementById('btnDownload');
  if (downloadBtn) downloadBtn.onclick = () => runAction(true);

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

  return {
    refreshJobs,
    refreshFree
  };
}
