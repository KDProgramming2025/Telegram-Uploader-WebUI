export function toast(msg, type = 'info', timeout = 4000) {
  const container = document.getElementById('toastContainer');
  if (!container) {
    console.log(msg);
    return;
  }
  const toastEl = document.createElement('div');
  toastEl.className = 'toast' + (type !== 'info' ? ' ' + type : '');
  toastEl.innerHTML = `<span class="msg"></span><button class="close" aria-label="Close">×</button>`;
  toastEl.querySelector('.msg').textContent = msg;
  const closeBtn = toastEl.querySelector('button.close');
  closeBtn.onclick = () => {
    toastEl.remove();
  };
  container.appendChild(toastEl);
  setTimeout(() => {
    toastEl.style.opacity = '0';
    toastEl.style.transform = 'translateY(6px)';
    setTimeout(() => toastEl.remove(), 300);
  }, timeout);
}

export function refreshIcons() {
  if (typeof window === 'undefined') return;
  if (window._iconRefreshScheduled) return;
  window._iconRefreshScheduled = true;
  requestAnimationFrame(() => {
    try {
      if (window.lucide) window.lucide.createIcons();
    } catch (_) {}
    window._iconRefreshScheduled = false;
  });
}
