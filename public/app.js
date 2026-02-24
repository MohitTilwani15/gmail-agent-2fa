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
