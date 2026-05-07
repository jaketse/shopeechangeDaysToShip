import { createApp } from 'vue';
import App from './App.vue';

function showFatal(err) {
  const msg = String(err?.stack || err?.message || err || 'Unknown renderer error');
  const el = document.createElement('pre');
  el.style.whiteSpace = 'pre-wrap';
  el.style.padding = '16px';
  el.style.color = '#991b1b';
  el.style.background = '#fef2f2';
  el.style.border = '1px solid #fecaca';
  el.textContent = `Renderer startup error:\n${msg}`;
  document.body.innerHTML = '';
  document.body.appendChild(el);
}

window.addEventListener('error', (e) => {
  showFatal(e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  showFatal(e.reason);
});

try {
  createApp(App).mount('#app');
} catch (e) {
  showFatal(e);
}

