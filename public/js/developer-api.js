// public/js/developer-api.js – Developer Portal logic (independent of app.js)

document.addEventListener('DOMContentLoaded', function() {
  const tableBody = document.querySelector('#appsTable tbody');
  if (!tableBody) return; // not on developer page
  fetchApps();
});

// ------- Fetch and display all API keys -------
async function fetchApps() {
  const tbody = document.querySelector('#appsTable tbody');
  try {
    const res = await fetch('/api/dashboard/developer-keys');
    if (!res.ok) throw new Error('Failed to fetch keys');
    const data = await res.json();

    tbody.innerHTML = '';
    if (data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-muted">No API keys created yet.</td></tr>`;
      return;
    }

    data.forEach(app => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${escapeHtml(app.applicationName)}</td>
        <td><code>${escapeHtml(app.apiKey)}</code></td>
        <td><span class="badge bg-${app.status === 'active' ? 'success' : 'secondary'}">${app.status}</span></td>
        <td>${app.permissions && app.permissions.length ? app.permissions.join(', ') : 'none'}</td>
        <td>${new Date(app.createdAt).toLocaleDateString()}</td>
        <td>${app.lastUsed ? new Date(app.lastUsed).toLocaleString() : 'never'}</td>
        <td>
          <button class="btn btn-sm btn-outline-secondary" onclick="copyToClipboard('${app.apiKey}')">
            <i class="fas fa-copy"></i> Copy Key
          </button>
          ${app.status === 'active'
            ? `<button class="btn btn-sm btn-warning" onclick="disableKey('${app._id}')">Disable</button>`
            : `<button class="btn btn-sm btn-success" onclick="enableKey('${app._id}')">Enable</button>`
          }
          <button class="btn btn-sm btn-danger" onclick="deleteKey('${app._id}')">Delete</button>
          <button class="btn btn-sm btn-info" onclick="regenerateSecret('${app._id}')">Regen Secret</button>
        </td>
      `;
      tbody.appendChild(row);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-danger">Error loading keys: ${err.message}</td></tr>`;
  }
}

// ------- Copy to clipboard -------
function copyToClipboard(elementOrText) {
  const text = typeof elementOrText === 'string' ? elementOrText : document.getElementById(elementOrText).value;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => alert('Copied!')).catch(() => alert('Copy failed.'));
  } else {
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    alert('Copied!');
  }
}

// ------- Generate new credentials -------
async function generateCredentials() {
  const permissions = [];
  document.querySelectorAll('.form-check-input:checked').forEach(cb => permissions.push(cb.value));

  const payload = {
    applicationName: document.getElementById('appName').value.trim(),
    description: document.getElementById('appDescription').value.trim(),
    permissions
  };

  if (!payload.applicationName) {
    alert('Please enter an application name.');
    return;
  }

  try {
    const res = await fetch('/api/dashboard/developer-keys/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.apiKey) {
      document.getElementById('newApiKey').value = data.apiKey;
      document.getElementById('newApiSecret').value = data.apiSecret;
      document.getElementById('generatedPanel').style.display = 'block';
      fetchApps();
      document.getElementById('appName').value = '';
      document.getElementById('appDescription').value = '';
      document.querySelectorAll('.form-check-input:checked').forEach(cb => cb.checked = false);
    } else {
      alert('Error: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Network error: ' + err.message);
  }
}

// ------- Disable key -------
async function disableKey(id) {
  if (!confirm('Disable this API key?')) return;
  try {
    await fetch(`/api/dashboard/developer-keys/${id}/disable`, { method: 'PUT' });
    fetchApps();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ------- Enable key -------
async function enableKey(id) {
  try {
    await fetch(`/api/dashboard/developer-keys/${id}/enable`, { method: 'PUT' });
    fetchApps();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ------- Delete key -------
async function deleteKey(id) {
  if (!confirm('Delete this key permanently?')) return;
  try {
    await fetch(`/api/dashboard/developer-keys/${id}`, { method: 'DELETE' });
    fetchApps();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ------- Regenerate secret -------
async function regenerateSecret(id) {
  if (!confirm('Regenerate secret? The old secret will stop working immediately.')) return;
  try {
    const res = await fetch(`/api/dashboard/developer-keys/${id}/regenerate-secret`, { method: 'PUT' });
    const data = await res.json();
    if (data.apiSecret) {
      document.getElementById('newApiSecret').value = data.apiSecret;
      document.getElementById('newApiKey').value = data.apiKey || ''; // backend now returns apiKey too
      document.getElementById('generatedPanel').style.display = 'block';
      alert('New secret generated. Copy it now.');
      fetchApps();
    } else {
      alert('Error: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Network error: ' + err.message);
  }
}

// ------- Helper: escape HTML -------
function escapeHtml(unsafe) {
  if (!unsafe) return '';
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
