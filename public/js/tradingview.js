// public/js/tradingview.js
// Live candlestick chart + candle table with CSV export.
// Uses Lightweight Charts (loaded via CDN in index.html).

'use strict';

(function () {
  let chart = null, candleSeries = null;
  let currentSymbol = 'EURUSD', currentTF = 'M5';
  let _candles = [];

  const TF_SECONDS = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400 };

  function initChart() {
    const container = document.getElementById('tradingChart');
    if (!container) return;
    if (!window.LightweightCharts) {
      console.warn('[TV] LightweightCharts not loaded');
      return;
    }
    const { createChart } = window.LightweightCharts;
    chart = createChart(container, {
      width: container.clientWidth,
      height: 500,
      layout: { background: { color: '#0b1a2e' }, textColor: '#c8d6e5' },
      grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    candleSeries = chart.addCandlestickSeries({
      upColor: '#00b894', downColor: '#e74c5e',
      borderUpColor: '#00b894', borderDownColor: '#e74c5e',
      wickUpColor: '#00b894', wickDownColor: '#e74c5e',
    });
    window.addEventListener('resize', () => {
      if (chart) chart.applyOptions({ width: container.clientWidth });
    });
  }

  async function loadCandles() {
    try {
      const res = await fetch(`/api/candles?pair=${currentSymbol}&count=200&granularity=${currentTF}`);
      const data = await res.json();
      if (!Array.isArray(data)) return;
      _candles = data.map(c => ({
        time: Math.floor((c.time || c.epoch * 1000) / 1000),
        open: c.mid?.o ?? c.open,
        high: c.mid?.h ?? c.high,
        low: c.mid?.l ?? c.low,
        close: c.mid?.c ?? c.close,
      })).filter(c => c.time && Number.isFinite(c.open));
      if (candleSeries && _candles.length > 0) candleSeries.setData(_candles);
      renderCandleTable();
    } catch (err) {
      console.warn('[TV] loadCandles failed:', err.message);
    }
  }

  function renderCandleTable() {
    const tbody = document.getElementById('tvCandleTable');
    if (!tbody) return;
    const recent = _candles.slice(-50).reverse();
    if (recent.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-muted">No candles yet</td></tr>';
      return;
    }
    tbody.innerHTML = recent.map(c => {
      const body = Math.abs(c.close - c.open);
      const bull = c.close > c.open;
      return `<tr>
        <td>${new Date(c.time * 1000).toLocaleTimeString()}</td>
        <td>${c.open.toFixed(5)}</td>
        <td>${c.high.toFixed(5)}</td>
        <td>${c.low.toFixed(5)}</td>
        <td class="${bull ? 'text-success' : 'text-danger'}">${c.close.toFixed(5)}</td>
        <td>—</td>
        <td>${body.toFixed(5)}</td>
        <td>—</td>
      </tr>`;
    }).join('');
  }

  window.onPriceTick = function (data) {
    if (!data || !candleSeries) return;
    const sym = String(data.symbol || '').replace(/^frx/i, '').replace(/[_/]/g, '').toUpperCase();
    if (sym !== currentSymbol) return;

    const tvPrice = document.getElementById('tvPrice');
    if (tvPrice) tvPrice.textContent = (Number(data.mid) || 0).toFixed(5);

    if (_candles.length > 0) {
      const last = _candles[_candles.length - 1];
      const mid = Number(data.mid) || last.close;
      const tfSec = TF_SECONDS[currentTF] || 300;
      const bucket = Math.floor(Date.now() / 1000 / tfSec) * tfSec;
      if (bucket > last.time) {
        _candles.push({ time: bucket, open: mid, high: mid, low: mid, close: mid });
        candleSeries.update(_candles[_candles.length - 1]);
      } else {
        last.high = Math.max(last.high, mid);
        last.low = Math.min(last.low, mid);
        last.close = mid;
        candleSeries.update(last);
      }
      renderCandleTable();
    }
  };

  window.onPredictionUpdate_tv = function (p) {
    if (!p) return;
    const elBias = document.getElementById('tvPatternBias');
    const elMom = document.getElementById('tvMomentum');
    const elVol = document.getElementById('tvVolatility');
    if (elBias && p.pattern) elBias.textContent = `${p.pattern.bias || '—'} (${p.pattern.confidence || 0}%)`;
    if (elMom && p.momentum) elMom.textContent = `${p.momentum.direction || '—'} (${((p.momentum.roc || 0) * 100).toFixed(2)}%)`;
    if (elVol && p.volatility) elVol.textContent = `${p.volatility.regime || '—'} (${(p.volatility.ratio || 1).toFixed(2)}x)`;
  };

  document.addEventListener('DOMContentLoaded', function () {
    initChart();
    loadCandles();

    const symSel = document.getElementById('tvSymbolSelect');
    if (symSel) symSel.addEventListener('change', e => {
      currentSymbol = e.target.value;
      const el = document.getElementById('tvSymbol');
      if (el) el.textContent = currentSymbol;
      loadCandles();
    });
    const tfSel = document.getElementById('tvTimeframeSelect');
    if (tfSel) tfSel.addEventListener('change', e => {
      currentTF = e.target.value;
      loadCandles();
    });
    const exp = document.getElementById('tvExportCSV');
    if (exp) exp.addEventListener('click', () => {
      let csv = 'Time,Open,High,Low,Close\n';
      for (const c of _candles) {
        csv += `${new Date(c.time * 1000).toISOString()},${c.open},${c.high},${c.low},${c.close}\n`;
      }
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${currentSymbol}_${currentTF}_candles.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    });

    setInterval(loadCandles, 60000);
  });
})();
