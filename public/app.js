(function () {
  const loginScreen = document.getElementById('login-screen');
  const dashboardScreen = document.getElementById('dashboard-screen');
  const loginForm = document.getElementById('login-form');
  const passwordInput = document.getElementById('password-input');
  const loginError = document.getElementById('login-error');
  const logoutBtn = document.getElementById('logout-btn');
  const registerForm = document.getElementById('register-form');
  const registerMsg = document.getElementById('register-msg');
  const refreshUsersBtn = document.getElementById('refresh-users');
  const usersList = document.getElementById('users-list');

  // Session is now managed via httpOnly cookies - no localStorage needed
  // The cookie is automatically sent with each request

  async function apiFetch(path, options = {}) {
    // Include credentials to send cookies with requests
    const res = await fetch(path, { 
      ...options, 
      credentials: 'same-origin',
    });
    return res;
  }

  function showScreen(screen) {
    loginScreen.hidden = screen !== 'login';
    dashboardScreen.hidden = screen !== 'dashboard';
  }

  // Login
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.hidden = true;
    const pw = passwordInput.value.trim();
    if (!pw) return;

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
        credentials: 'same-origin',
      });
      if (res.ok) {
        // Session cookie is automatically set by the server
        passwordInput.value = '';
        showScreen('dashboard');
        loadUsers();
      } else {
        loginError.textContent = 'Invalid password';
        loginError.hidden = false;
      }
    } catch {
      loginError.textContent = 'Connection error';
      loginError.hidden = false;
    }
  });

  // Logout
  logoutBtn.addEventListener('click', async () => {
    try {
      await fetch('/api/logout', { 
        method: 'POST',
        credentials: 'same-origin',
      });
    } catch {
      // Ignore errors - still clear local state
    }
    passwordInput.value = '';
    showScreen('login');
  });

  // Register user
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    registerMsg.hidden = true;

    const userId = document.getElementById('reg-userId').value.trim();
    const telegramBotToken = document.getElementById('reg-botToken').value.trim();
    const telegramChatId = parseInt(document.getElementById('reg-chatId').value, 10);

    if (!userId || !telegramBotToken || isNaN(telegramChatId)) return;

    try {
      const res = await apiFetch('/api/register-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, telegramBotToken, telegramChatId }),
      });
      const data = await res.json();
      if (res.ok) {
        registerMsg.textContent = 'User registered successfully!';
        registerMsg.className = 'success';
        registerMsg.hidden = false;
        registerForm.reset();
        loadUsers();
      } else {
        registerMsg.textContent = data.error || 'Registration failed';
        registerMsg.className = 'error';
        registerMsg.hidden = false;
      }
    } catch {
      registerMsg.textContent = 'Connection error';
      registerMsg.className = 'error';
      registerMsg.hidden = false;
    }
  });

  // Load users
  async function loadUsers() {
    usersList.innerHTML = '<p class="muted">Loading...</p>';
    try {
      const res = await apiFetch('/api/users');
      if (!res.ok) {
        usersList.innerHTML = '<p class="error">Failed to load users</p>';
        return;
      }
      const users = await res.json();
      if (users.length === 0) {
        usersList.innerHTML = '<p class="muted">No users registered yet.</p>';
        return;
      }

      let html = '<table class="users-table"><thead><tr>';
      html += '<th>User ID</th><th>Chat ID</th><th>Gmail</th><th>Actions</th>';
      html += '</tr></thead><tbody>';

      for (const u of users) {
        const gmailCell = u.gmailConnected
          ? '<span class="badge badge-connected">' + escapeHtml(u.gmailEmail || 'Connected') + '</span>'
          : '<span class="badge badge-disconnected">Not Connected</span>';
        const gmailAction = u.gmailConnected
          ? '<button class="btn-disconnect" onclick="disconnectGmail(\'' + u.id + '\')">Disconnect</button>'
          : '<button class="btn-gmail" onclick="connectGmail(\'' + u.id + '\')">Connect Gmail</button>';
        const promptAction = u.gmailConnected
          ? ' <button class="btn-prompt" onclick="showPrompt(\'' + u.id + '\', this)">Copy Prompt</button>'
          : '';
        html += '<tr>';
        html += '<td>' + escapeHtml(u.id) + '</td>';
        html += '<td>' + u.telegramChatId + '</td>';
        html += '<td>' + gmailCell + '</td>';
        html += '<td>' + gmailAction + promptAction + '</td>';
        html += '</tr>';
      }

      html += '</tbody></table>';
      usersList.innerHTML = html;
    } catch {
      usersList.innerHTML = '<p class="error">Connection error</p>';
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Connect Gmail — navigates to OAuth endpoint (session cookie sent automatically)
  window.connectGmail = function (userId) {
    window.location.href = '/api/auth/gmail?userId=' + encodeURIComponent(userId);
  };

  // Disconnect Gmail
  window.disconnectGmail = async function (userId) {
    if (!confirm('Disconnect Gmail for user "' + userId + '"?')) return;
    try {
      const res = await apiFetch('/api/disconnect-gmail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      if (res.ok) {
        loadUsers();
      }
    } catch {
      // ignore
    }
  };

  // Copy prompt from backend
  window.showPrompt = async function (userId, btn) {
    try {
      const res = await apiFetch('/api/prompt/' + encodeURIComponent(userId));
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || 'Failed to fetch prompt');
        return;
      }
      const { prompt } = await res.json();
      await navigator.clipboard.writeText(prompt);
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 2000);
    } catch {
      alert('Connection error');
    }
  };

  // Refresh users
  refreshUsersBtn.addEventListener('click', loadUsers);

  // --- Calendar Sync ---
  const calSyncUserSelect = document.getElementById('cal-sync-user-select');
  const newSyncPairBtn = document.getElementById('new-sync-pair-btn');
  const syncPairsList = document.getElementById('sync-pairs-list');

  // Populate user dropdown when users load
  function populateCalSyncUserDropdown(users) {
    calSyncUserSelect.innerHTML = '<option value="">Select user...</option>';
    for (const u of users) {
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = u.id + (u.gmailEmail ? ' (' + u.gmailEmail + ')' : '');
      calSyncUserSelect.appendChild(opt);
    }
  }

  // Patch loadUsers to also populate the dropdown
  const origLoadUsers = loadUsers;
  loadUsers = async function () {
    await origLoadUsers();
    try {
      const res = await apiFetch('/api/users');
      if (res.ok) {
        const users = await res.json();
        populateCalSyncUserDropdown(users);
      }
    } catch { /* ignore */ }
  };

  calSyncUserSelect.addEventListener('change', () => {
    const userId = calSyncUserSelect.value;
    newSyncPairBtn.disabled = !userId;
    if (userId) {
      loadSyncPairs(userId);
    } else {
      syncPairsList.innerHTML = '<p class="muted">Select a user to view sync pairs.</p>';
    }
  });

  newSyncPairBtn.addEventListener('click', async () => {
    const userId = calSyncUserSelect.value;
    if (!userId) return;
    try {
      const res = await apiFetch('/api/calendar-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      if (res.ok) {
        loadSyncPairs(userId);
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to create sync pair');
      }
    } catch {
      alert('Connection error');
    }
  });

  async function loadSyncPairs(userId) {
    syncPairsList.innerHTML = '<p class="muted">Loading...</p>';
    try {
      const res = await apiFetch('/api/calendar-sync?userId=' + encodeURIComponent(userId));
      if (!res.ok) {
        syncPairsList.innerHTML = '<p class="error">Failed to load sync pairs</p>';
        return;
      }
      const pairs = await res.json();
      if (pairs.length === 0) {
        syncPairsList.innerHTML = '<p class="muted">No sync pairs yet. Click "+ New Sync Pair" to create one.</p>';
        return;
      }

      // Fetch detailed info for each pair
      let html = '';
      for (const pair of pairs) {
        const detailRes = await apiFetch('/api/calendar-sync/' + pair.id);
        const p = detailRes.ok ? await detailRes.json() : pair;
        html += renderSyncPairCard(p);
      }
      syncPairsList.innerHTML = html;

      // Load calendar dropdowns for connected pairs
      for (const pair of pairs) {
        const detailRes = await apiFetch('/api/calendar-sync/' + pair.id);
        if (!detailRes.ok) continue;
        const p = await detailRes.json();
        if (p.account1_connected) loadCalendarOptions(p.id, 1, p.account1_cal_id);
        if (p.account2_connected) loadCalendarOptions(p.id, 2, p.account2_cal_id);
      }
    } catch {
      syncPairsList.innerHTML = '<p class="error">Connection error</p>';
    }
  }

  function renderSyncPairCard(p) {
    const statusBadge = p.is_active
      ? '<span class="badge badge-active">Active</span>'
      : '<span class="badge badge-inactive">Inactive</span>';

    const acct1 = p.account1_connected
      ? '<div class="sync-account-box connected"><div class="account-label">Account 1</div><div class="account-email">' + escapeHtml(p.account1_email || 'Connected') + '</div></div>'
      : '<div class="sync-account-box"><div class="account-label">Account 1</div><button class="btn-gmail" onclick="connectCalAccount(\'' + p.id + '\', 1)">Connect Google</button></div>';

    const acct2 = p.account2_connected
      ? '<div class="sync-account-box connected"><div class="account-label">Account 2</div><div class="account-email">' + escapeHtml(p.account2_email || 'Connected') + '</div></div>'
      : '<div class="sync-account-box"><div class="account-label">Account 2</div><button class="btn-gmail" onclick="connectCalAccount(\'' + p.id + '\', 2)">Connect Google</button></div>';

    let calendarsHtml = '';
    if (p.account1_connected && p.account2_connected) {
      calendarsHtml = '<div class="sync-pair-calendars">' +
        '<select id="cal-select-' + p.id + '-1" onchange="saveCalendarSelection(\'' + p.id + '\')"><option value="">Loading calendars...</option></select>' +
        '<select id="cal-select-' + p.id + '-2" onchange="saveCalendarSelection(\'' + p.id + '\')"><option value="">Loading calendars...</option></select>' +
        '</div>';
    }

    let actionsHtml = '<div class="sync-pair-actions">';
    if (p.account1_connected && p.account2_connected && !p.is_active) {
      actionsHtml += '<button class="btn-activate" onclick="activateSyncPair(\'' + p.id + '\')">Activate Sync</button>';
    }
    if (p.is_active) {
      actionsHtml += '<button class="btn-pause" onclick="pauseSyncPair(\'' + p.id + '\')">Pause</button>';
      actionsHtml += '<button class="btn-activate" onclick="resumeSyncPair(\'' + p.id + '\')">Resume</button>';
    }
    actionsHtml += '<button class="btn-delete" onclick="deleteSyncPair(\'' + p.id + '\')">Delete</button>';
    actionsHtml += '</div>';

    return '<div class="sync-pair-card">' +
      '<h3><span>Sync Pair</span> ' + statusBadge + '</h3>' +
      '<div class="sync-pair-accounts">' + acct1 + acct2 + '</div>' +
      calendarsHtml +
      actionsHtml +
      '</div>';
  }

  async function loadCalendarOptions(pairId, accountNum, selectedCalId) {
    const select = document.getElementById('cal-select-' + pairId + '-' + accountNum);
    if (!select) return;
    try {
      const res = await apiFetch('/api/calendar-sync/' + pairId + '/calendars/' + accountNum);
      if (!res.ok) {
        select.innerHTML = '<option value="">Failed to load</option>';
        return;
      }
      const calendars = await res.json();
      let html = '<option value="">Select calendar...</option>';
      for (const cal of calendars) {
        const sel = cal.id === selectedCalId ? ' selected' : '';
        html += '<option value="' + escapeHtml(cal.id) + '"' + sel + '>' + escapeHtml(cal.summary || cal.id) + '</option>';
      }
      select.innerHTML = html;
    } catch {
      select.innerHTML = '<option value="">Error loading</option>';
    }
  }

  window.connectCalAccount = function (pairId, accountNum) {
    window.location.href = '/api/auth/calendar/' + pairId + '/account/' + accountNum;
  };

  window.saveCalendarSelection = async function (pairId) {
    const sel1 = document.getElementById('cal-select-' + pairId + '-1');
    const sel2 = document.getElementById('cal-select-' + pairId + '-2');
    if (!sel1 || !sel2) return;
    const calendarId1 = sel1.value;
    const calendarId2 = sel2.value;
    if (!calendarId1 || !calendarId2) return;

    try {
      await apiFetch('/api/calendar-sync/' + pairId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calendarId1, calendarId2 }),
      });
    } catch { /* ignore */ }
  };

  window.activateSyncPair = async function (pairId) {
    // Save calendar selections first
    await window.saveCalendarSelection(pairId);

    try {
      const res = await apiFetch('/api/calendar-sync/' + pairId + '/activate', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        loadSyncPairs(calSyncUserSelect.value);
      } else {
        alert(data.error || 'Failed to activate');
      }
    } catch {
      alert('Connection error');
    }
  };

  window.pauseSyncPair = async function (pairId) {
    try {
      const res = await apiFetch('/api/calendar-sync/' + pairId + '/pause', { method: 'POST' });
      if (res.ok) {
        loadSyncPairs(calSyncUserSelect.value);
      }
    } catch {
      alert('Connection error');
    }
  };

  window.resumeSyncPair = async function (pairId) {
    try {
      const res = await apiFetch('/api/calendar-sync/' + pairId + '/resume', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        loadSyncPairs(calSyncUserSelect.value);
      } else {
        alert(data.error || 'Failed to resume');
      }
    } catch {
      alert('Connection error');
    }
  };

  window.deleteSyncPair = async function (pairId) {
    if (!confirm('Delete this sync pair? All synced event mappings will be lost.')) return;
    try {
      const res = await apiFetch('/api/calendar-sync/' + pairId, { method: 'DELETE' });
      if (res.ok) {
        loadSyncPairs(calSyncUserSelect.value);
      }
    } catch {
      alert('Connection error');
    }
  };

  // Auto-login check on page load (session cookie sent automatically)
  (async function init() {
    try {
      const res = await apiFetch('/api/verify-key');
      if (res.ok) {
        showScreen('dashboard');
        loadUsers();
      } else {
        showScreen('login');
      }
    } catch {
      showScreen('login');
    }
  })();
})();
