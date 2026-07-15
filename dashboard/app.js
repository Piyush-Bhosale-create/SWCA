/* ════════════════════════════════════════════════
   SW.CA1 — Dashboard Application Logic
   Milestone 2: Navigation, Themes, UI Shell
════════════════════════════════════════════════ */

// ── Page meta ──
const PAGE_META = {
  inbox:    { title: 'Unified Inbox',      sub: 'All incoming emails and WhatsApp messages' },
  clients:  { title: 'Client Management',  sub: 'Track compliance status for all clients' },
  profile:  { title: 'Client Profile',     sub: 'Full activity and compliance detail' },
  settings: { title: 'Settings',           sub: 'Configure SW.CA1 preferences and integrations' },
};

// ── Current state ──
let currentTheme = localStorage.getItem('swca1_theme') || 'ocean';
let currentPage  = 'inbox';
let selectedRows = new Set();
let notifOpen    = false;

// ════════ NAVIGATION ════════
function navigate(pageId, navEl) {
  // Hide all pages
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

  // Show target page
  const target = document.getElementById('page-' + pageId);
  if (target) target.classList.add('active');

  // Update nav highlight
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (navEl) navEl.classList.add('active');
  else {
    const match = document.querySelector('[data-page="' + pageId + '"]');
    if (match) match.classList.add('active');
  }

  // Update topbar
  const meta = PAGE_META[pageId] || { title: pageId, sub: '' };
  document.getElementById('page-title').textContent    = meta.title;
  document.getElementById('page-subtitle').textContent = meta.sub;

  currentPage = pageId;
  closeNotifications();
}

// ════════ THEME ════════
function setTheme(theme, dotEl) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('swca1_theme', theme);

  // Update small dots in topbar
  document.querySelectorAll('.theme-dot').forEach(d => d.classList.remove('active'));
  const activeDot = document.querySelector('.theme-dot[data-theme="' + theme + '"]');
  if (activeDot) activeDot.classList.add('active');

  // Update large options in settings
  document.querySelectorAll('.theme-option').forEach(o => o.classList.remove('active-theme'));
  const activeOpt = document.getElementById('themeOpt-' + theme);
  if (activeOpt) activeOpt.classList.add('active-theme');
}

// ════════ NOTIFICATIONS ════════
function toggleNotifications() {
  notifOpen = !notifOpen;
  const dd = document.getElementById('notifDropdown');
  dd.classList.toggle('hidden', !notifOpen);
}
function closeNotifications() {
  notifOpen = false;
  document.getElementById('notifDropdown').classList.add('hidden');
}
function clearNotifications() {
  document.getElementById('notifList').innerHTML = `
    <div class="notif-empty">
      <svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-2.83-2h5.66A3 3 0 0110 18z"/></svg>
      <p>No notifications</p>
    </div>`;
  document.getElementById('notifCount').classList.add('hidden');
}

// Close notifications when clicking outside
document.addEventListener('click', function(e) {
  const wrapper = document.getElementById('notifWrapper');
  if (wrapper && !wrapper.contains(e.target)) closeNotifications();
});

// ════════ CLIENT TABS ════════
function switchTab(tab, btnEl) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
  // Data filtering will be wired in Milestone 7 — shell only for now
}

// ════════ ADD CLIENT MODAL ════════
function showAddClient() {
  document.getElementById('addClientModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('newClientName').focus(), 50);
}
function hideAddClient() {
  document.getElementById('addClientModal').classList.add('hidden');
  document.getElementById('newClientName').value = '';
}
function addClient() {
  const name = document.getElementById('newClientName').value.trim();
  if (!name) {
    document.getElementById('newClientName').focus();
    return;
  }
  // Real DB write wired in Milestone 7 — show a placeholder row for now
  addClientRow(name);
  hideAddClient();
}

function addClientRow(name) {
  const tbody = document.getElementById('clients-tbody');
  // Remove empty-row if present
  const emptyRow = tbody.querySelector('.empty-row');
  if (emptyRow) emptyRow.remove();

  const initials = name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="check-col"><input type="checkbox" onchange="rowCheck(this)" /></td>
    <td>
      <div style="display:flex;align-items:center;gap:9px;">
        <div style="width:28px;height:28px;background:var(--accent);color:#fff;font-size:11px;font-weight:600;border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">${initials}</div>
        <span style="font-weight:500;color:var(--text-primary);">${escHtml(name)}</span>
      </div>
    </td>
    <td><select class="status-select"><option>Pending</option><option>Filed</option><option>Under Review</option></select></td>
    <td><select class="status-select"><option>Pending</option><option>Filed</option><option>Under Review</option></select></td>
    <td><select class="status-select"><option>Pending</option><option>Filed</option><option>N/A</option></select></td>
    <td style="color:var(--text-muted);font-size:12px;">—</td>
    <td><input type="date" class="filter-date" style="padding:4px 8px;font-size:12px;" /></td>
    <td><input type="date" class="filter-date" style="padding:4px 8px;font-size:12px;" /></td>
    <td><input type="text" class="form-input" placeholder="Notes…" style="padding:4px 8px;font-size:12px;min-width:100px;" /></td>
    <td><button class="btn-ghost small">📎 0</button></td>
    <td>
      <div style="display:flex;gap:4px;">
        <button class="btn-ghost small" onclick="openProfile('${escHtml(name)}')">Profile</button>
        <button class="btn-ghost small">🔔</button>
      </div>
    </td>`;
  tbody.appendChild(tr);
  updateClientCount();
}

// ════════ SELECTION + MASS UPDATE ════════
function rowCheck(cb) {
  if (cb.checked) selectedRows.add(cb.closest('tr'));
  else selectedRows.delete(cb.closest('tr'));
  updateMassBar();
}

function toggleSelectAll(masterCb) {
  document.querySelectorAll('#clients-tbody input[type="checkbox"]').forEach(cb => {
    cb.checked = masterCb.checked;
    if (masterCb.checked) selectedRows.add(cb.closest('tr'));
    else selectedRows.delete(cb.closest('tr'));
  });
  updateMassBar();
}

function updateMassBar() {
  const bar = document.getElementById('massUpdateBar');
  const count = document.getElementById('selectedCount');
  if (selectedRows.size > 0) {
    bar.classList.remove('hidden');
    count.textContent = selectedRows.size + ' client' + (selectedRows.size > 1 ? 's' : '') + ' selected';
  } else {
    bar.classList.add('hidden');
  }
}

function clearSelection() {
  selectedRows.clear();
  document.querySelectorAll('#clients-tbody input[type="checkbox"]').forEach(cb => cb.checked = false);
  document.getElementById('selectAll').checked = false;
  updateMassBar();
}

function massUpdateSubtask()  { alert('Mass subtask update will be available in Milestone 9.'); }
function massUpdateStatus()   { alert('Mass status update will be available in Milestone 9.'); }

// ════════ CLIENT PROFILE ════════
function openProfile(name) {
  document.getElementById('profileName').textContent = name;
  document.getElementById('profileAvatar').textContent = name.split(' ').map(w=>w[0]).join('').substring(0,2).toUpperCase();
  navigate('profile', null);
}

// ════════ COUNT UPDATES ════════
function updateClientCount() {
  const rows = document.querySelectorAll('#clients-tbody tr:not(.empty-row)').length;
  document.getElementById('clients-count').textContent = rows + ' client' + (rows !== 1 ? 's' : '');
}

// ════════ AI STATUS CHECK ════════
async function checkAiStatus() {
  try {
    const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      const models = data.models || [];
      const statusRow = document.getElementById('ai-status-row');
      const dot = statusRow.querySelector('.status-dot');
      const txt = statusRow.querySelector('.status-text');
      dot.className = 'status-dot online';
      txt.textContent = models.length > 0 ? 'AI Ready (' + models[0].name + ')' : 'Ollama Online';
      // Update settings page too
      const aiModel = document.getElementById('aiModelDisplay');
      if (aiModel) aiModel.textContent = models.length > 0 ? models[0].name : 'Ollama connected — no model loaded';
    } else { setAiOffline(); }
  } catch (e) { setAiOffline(); }
}

function setAiOffline() {
  const statusRow = document.getElementById('ai-status-row');
  const dot = statusRow.querySelector('.status-dot');
  const txt = statusRow.querySelector('.status-text');
  dot.className = 'status-dot offline';
  txt.textContent = 'AI Offline';
  const aiModel = document.getElementById('aiModelDisplay');
  if (aiModel) aiModel.textContent = 'Ollama not running — start it first';
}

// ════════ HELPERS ════════
function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ════════ INIT ════════
document.addEventListener('DOMContentLoaded', function() {
  // Apply saved theme
  setTheme(currentTheme, null);

  // Start AI check
  checkAiStatus();
  setInterval(checkAiStatus, 30000);

  // Show correct starting page
  navigate('inbox', document.querySelector('[data-page="inbox"]'));

  // Update counts
  updateClientCount();
  document.getElementById('inbox-count').textContent = '0 messages';
});
