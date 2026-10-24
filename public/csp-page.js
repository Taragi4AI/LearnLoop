// This separate page deliberately reads the live CSP object from the lecture
// window that opened it. It never serializes data into URL parameters, browser
// storage, or a backend. A direct visit has no package by design.
const host = document.querySelector('#cspPackage');

function unavailable(message) {
  host.textContent = '';
  const panel = document.createElement('section');
  panel.className = 'csp-panel';
  const text = document.createElement('p');
  text.className = 'muted';
  text.textContent = message;
  panel.append(text);
  host.append(panel);
}

function openerCsp() {
  try { return window.opener?.__learnloop?.csp || null; } catch { return null; }
}

const bridge = openerCsp();
if (!bridge) {
  unavailable('Open this page from an active LearnLoop lecture using the Comprehensive Study Package button.');
} else {
  // A reload is an explicit session reset for generated CSP content.
  const navigation = performance.getEntriesByType('navigation')[0];
  if (navigation?.type === 'reload') bridge.clear();
  bridge.mount(host);
  window.addEventListener('beforeunload', () => bridge.unmount(host));
}
