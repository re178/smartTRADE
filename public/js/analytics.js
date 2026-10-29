// public/js/analytics.js
// Fetches and renders the full Analytics & Rankings data.
// Shows Global Stats, Bot Rankings (by PnL), Daily Breakdown, and Monthly Breakdown.

'use strict';

(function () {
  // Helper to format currency
  function formatCur(val) {
    const n = Number(val) || 0;
    return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2);
  }

  // Helper to get color class based on value
  function getPnlClass(val) {
    const n = Number(val) || 0;
    return n > 0 ? 'text-success fw-bold' : n < 0 ? 'text-danger fw-bold' : 'text-muted';
  }

  function getWinRateClass(val) {
    const n = Number(val) || 0;
    return n >= 55 ? 'text-success fw-bold' : n <= 45 ? 'text-danger' : 'text-muted';
  }

  async function loadAnalytics() {
    try {
      const res = await fetch('/api/bots/analytics');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // 1. Update Global Summary
      const sum = data.summary || { totalTrades: 0, wins: 0, losses: 0, winRate: 0, totalPnL: 0 };
      
      const elTrades = document.getElementById('anaTotalTrades');
      if (elTrades) elTrades.textContent = sum.totalTrades;

      const elWinRate = document.getElementById('anaWinRate');
      if (elWinRate) {
        elWinRate.textContent = `${sum.winRate}%`;
        elWinRate.className = `stat-value ${getWinRateClass(sum.winRate)}`;
      }

      const elPnL = document.getElementById('anaTotalPnL');
      if (elPnL) {
        elPnL.textContent = formatCur(sum.totalPnL);
        elPnL.className = `stat-value ${getPnlClass(sum.totalPnL)}`;
      }

      // 2. Render Bot Rankings Table
      const botBody = document.getElementById('anaBotRankingsBody');
      if (botBody) {
        if (!data.bots || data.bots.length === 0) {
          botBody.innerHTML = '<tr><td colspan="6" class="text-muted p-3">No closed trades yet.</td></tr>';
        } else {
          botBody.innerHTML = data.bots.map(b => `
            <tr>
              <td><strong>${b.botId}</strong></td>
              <td>${b.trades}</td>
              <td class="text-success">${b.wins}</td>
              <td class="text-danger">${b.losses}</td>
              <td class="${getWinRateClass(b.winRate)}">${b.winRate}%</td>
              <td class="${getPnlClass(b.pnl)}">${formatCur(b.pnl)}</td>
            </tr>
          `).join('');
        }
      }

      // 3. Render Daily Breakdown Table
      const dailyBody = document.getElementById('anaDailyBody');
      if (dailyBody) {
        if (!data.daily || data.daily.length === 0) {
          dailyBody.innerHTML = '<tr><td colspan="5" class="text-muted p-3">No recent daily data.</td></tr>';
        } else {
          dailyBody.innerHTML = data.daily.map(d => `
            <tr>
              <td><strong>${d.date}</strong></td>
              <td>${d.trades}</td>
              <td class="text-success">${d.wins}</td>
              <td class="text-danger">${d.losses}</td>
              <td class="${getPnlClass(d.pnl)}">${formatCur(d.pnl)}</td>
            </tr>
          `).join('');
        }
      }

      // 4. Render Monthly Breakdown Table
      const monthlyBody = document.getElementById('anaMonthlyBody');
      if (monthlyBody) {
        if (!data.monthly || data.monthly.length === 0) {
          monthlyBody.innerHTML = '<tr><td colspan="5" class="text-muted p-3">No recent monthly data.</td></tr>';
        } else {
          monthlyBody.innerHTML = data.monthly.map(m => `
            <tr>
              <td><strong>${m.month}</strong></td>
              <td>${m.trades}</td>
              <td class="text-success">${m.wins}</td>
              <td class="text-danger">${m.losses}</td>
              <td class="${getPnlClass(m.pnl)}">${formatCur(m.pnl)}</td>
            </tr>
          `).join('');
        }
      }
    } catch (err) {
      console.error('[Analytics] Failed to load:', err.message);
      const errorHtml = `<tr><td colspan="6" class="text-danger p-3">Error loading analytics: ${err.message}</td></tr>`;
      if (document.getElementById('anaBotRankingsBody')) document.getElementById('anaBotRankingsBody').innerHTML = errorHtml;
      if (document.getElementById('anaDailyBody')) document.getElementById('anaDailyBody').innerHTML = errorHtml;
      if (document.getElementById('anaMonthlyBody')) document.getElementById('anaMonthlyBody').innerHTML = errorHtml;
    }
  }

  // Expose to global scope so index.html navigation can call it
  window.loadAnalytics = loadAnalytics;

  // Wire up the refresh button
  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('refreshAnalyticsBtn')?.addEventListener('click', loadAnalytics);
    
    // Auto-load if the user is already on the Analytics tab
    const analyticsSection = document.getElementById('section-analytics');
    if (analyticsSection && analyticsSection.style.display !== 'none') {
      loadAnalytics();
    }
  });

})();
