// public/js/digits.js
// Renders: big number + arrow, digit frequency bars, Even/Odd, Rise/Fall.

'use strict';

(function () {
  let currentDigitSymbol = 'EURUSD';

  window.onDigitUpdate = function (data) {
    if (!data) return;

    if (data.symbol === currentDigitSymbol) {
      const cur = document.getElementById('digitCurrent');
      const prev = document.getElementById('digitPrevious');
      const arrow = document.getElementById('digitArrow');
      const price = document.getElementById('digitPrice');

      if (cur) cur.textContent = data.currentDigit ?? '—';
      if (prev) prev.textContent = data.previousDigit ?? '—';
      if (price) price.textContent = (data.price || 0).toFixed(5);

      if (arrow) {
        if (data.arrow === 'up') { arrow.textContent = '↑'; arrow.style.color = '#00b894'; }
        else if (data.arrow === 'down') { arrow.textContent = '↓'; arrow.style.color = '#e74c5e'; }
        else { arrow.textContent = '·'; arrow.style.color = '#94a3b8'; }
      }

      const bars = document.getElementById('digitFrequencyBars');
      if (bars && data.digitFreqPct) {
        const max = Math.max.apply(null, data.digitFreqPct.concat([1]));
        bars.innerHTML = data.digitFreqPct.map((pct, digit) => {
          const height = Math.round((pct / max) * 140);
          const color = digit % 2 === 0 ? '#00b894' : '#e74c5e';
          return `<div style="flex:1; display:flex; flex-direction:column; align-items:center;">
            <div style="background:${color}; width:100%; height:${height}px; border-radius:3px 3px 0 0;"></div>
            <div style="font-weight:700; margin-top:4px;">${digit}</div>
            <div class="text-muted" style="font-size:0.7em;">${pct.toFixed(1)}%</div>
          </div>`;
        }).join('');
      }

      const eo = document.getElementById('digitEvenOdd');
      if (eo) {
        const ePct = data.evenPct || 0;
        const oPct = data.oddPct || 0;
        const eColor = ePct > 50 ? 'text-success' : 'text-muted';
        const oColor = oPct > 50 ? 'text-success' : 'text-muted';
        eo.innerHTML = `
          <div class="d-flex justify-content-between">
            <span class="${eColor}">Even: <strong>${ePct.toFixed(1)}%</strong></span>
            <span class="${oColor}">Odd: <strong>${oPct.toFixed(1)}%</strong></span>
          </div>
          <div class="small text-muted mt-2">Streak: ${data.currentParity || '—'} (${data.evenStreak || data.oddStreak || 0})</div>`;
      }

      const rf = document.getElementById('digitRiseFall');
      if (rf) {
        const rPct = data.risePct || 0;
        const fPct = data.fallPct || 0;
        const rColor = rPct > 50 ? 'text-success' : 'text-muted';
        const fColor = fPct > 50 ? 'text-success' : 'text-muted';
        rf.innerHTML = `
          <div class="d-flex justify-content-between">
            <span class="${rColor}">Rise: <strong>${rPct.toFixed(1)}%</strong></span>
            <span class="${fColor}">Fall: <strong>${fPct.toFixed(1)}%</strong></span>
          </div>
          <div class="small text-muted mt-2">Flat: ${(data.flatPct || 0).toFixed(1)}%</div>`;
      }
    }

    const rfSym = document.getElementById('rfSymbolSelect')?.value;
    if (rfSym && data.symbol === rfSym) {
      const panel = document.getElementById('riseFallPanel');
      if (panel) panel.innerHTML = `
        <div class="row text-center">
          <div class="col-4"><div class="stat-value text-success">${(data.risePct||0).toFixed(1)}%</div><div class="small">Rise</div></div>
          <div class="col-4"><div class="stat-value text-danger">${(data.fallPct||0).toFixed(1)}%</div><div class="small">Fall</div></div>
          <div class="col-4"><div class="stat-value text-muted">${(data.flatPct||0).toFixed(1)}%</div><div class="small">Flat</div></div>
        </div>
        <div class="mt-3 small text-muted">Samples: ${data.sampleSize || 0}</div>`;
    }

    const eoSym = document.getElementById('eoSymbolSelect')?.value;
    if (eoSym && data.symbol === eoSym) {
      const panel = document.getElementById('evenOddPanel');
      if (panel) panel.innerHTML = `
        <div class="row text-center">
          <div class="col-6"><div class="stat-value text-success">${(data.evenPct||0).toFixed(1)}%</div><div class="small">Even</div></div>
          <div class="col-6"><div class="stat-value text-danger">${(data.oddPct||0).toFixed(1)}%</div><div class="small">Odd</div></div>
        </div>
        <div class="mt-3 small text-muted">Samples: ${data.sampleSize || 0}</div>`;
    }
  };

  document.addEventListener('DOMContentLoaded', function () {
    const sel = document.getElementById('digitSymbolSelect');
    if (sel) sel.addEventListener('change', e => {
      currentDigitSymbol = e.target.value;
      fetch(`/api/digit/${currentDigitSymbol}`)
        .then(r => r.json())
        .then(d => window.onDigitUpdate(d))
        .catch(() => {});
    });
    fetch(`/api/digit/${currentDigitSymbol}`)
      .then(r => r.json())
      .then(d => window.onDigitUpdate(d))
      .catch(() => {});
  });
})();
