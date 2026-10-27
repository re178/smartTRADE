// public/js/tradingview.js
// Defensive chart loader. Handles v4 AND v5 API, missing data, fetch errors.

'use strict';

(function () {
  console.log('[TV] tradingview.js loading...');

  let chart = null;
  let candleSeries = null;
  let currentSymbol = 'EURUSD';
  let currentTF = 'M5';
  let _candles = [];
  let _chartApi = null;   // 'v4' | 'v5' | null

  const TF_SECONDS = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400 };

  function setStatus(html, color) {
    const el = document.getElementById('tvChartStatus');
    if (!el) return;
    if (!html) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.style.color = color || '#6b7a8f';
    el.innerHTML = html;
  }

  function chartLibAvailable() {
    if (!window.LightweightCharts) return { ok: false, reason: 'window.LightweightCharts undefined' };
    if (typeof window.LightweightCharts.createChart !== 'function') {
      return { ok: false, reason: 'LightweightCharts.createChart missing' };
    }
    return { ok: true };
  }

  function detectVersion() {
    try {
      if (window.LightweightCharts && typeof window.LightweightCharts.version === 'function') {
        return window.LightweightCharts.version();
      }
    } catch (_) {}
    return 'unknown';
  }

  function initChart() {
    const container = document.getElementById('tradingChart');
    if (!container) {
      setStatus('❌ <b>Error:</b> #tradingChart container not found in DOM', '#e74c5e');
      return false;
    }

    const lib = chartLibAvailable();
    if (!lib.ok) {
      setStatus(
        `❌ <b>Chart library not loaded.</b><br>${lib.reason}<br>` +
        `<small>Check the script tag for lightweight-charts in index.html</small>`,
        '#e74c5e'
      );
      return false;
    }

    const version = detectVersion();
    console.log('[TV] Chart library version:', version);

    try {
      chart = window.LightweightCharts.createChart(container, {
        width: container.clientWidth || 800,
        height: 500,
        layout: { background: { color: '#0b1a2e' }, textColor: '#c8d6e5' },
        grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
        timeScale: { timeVisible: true, secondsVisible: false },
      });
    } catch (err) {
      setStatus('❌ <b>createChart failed:</b> ' + err.message, '#e74c5e');
      return false;
    }

    const candleOpts = {
      upColor: '#00b894', downColor: '#e74c5e',
      borderUpColor: '#00b894', borderDownColor: '#e74c5e',
      wickUpColor: '#00b894', wickDownColor: '#e74c5e',
    };

    // ---- Try v4 API first (addCandlestickSeries is a method on chart) ----
    if (typeof chart.addCandlestickSeries === 'function') {
      try {
        candleSeries = chart.addCandlestickSeries(candleOpts);
        _chartApi = 'v4';
        console.log('[TV] ✓ Using v4 API (chart.addCandlestickSeries)');
      } catch (err) {
        console.warn('[TV] v4 addCandlestickSeries threw:', err.message);
      }
    }

    // ---- Fall back to v5 API (addSeries(SeriesCtor, opts)) ----
    if (!candleSeries && typeof chart.addSeries === 'function') {
      // v5 exposes series constructors on the LightweightCharts object
      const CandleCtor =
        window.LightweightCharts.CandlestickSeries ||
        window.LightweightCharts.CandlestickSeriesOptions ||
        null;

      if (CandleCtor) {
        try {
          candleSeries = chart.addSeries(CandleCtor, candleOpts);
          _chartApi = 'v5';
          console.log('[TV] ✓ Using v5 API (chart.addSeries(CandlestickSeries))');
        } catch (err) {
          console.warn('[TV] v5 addSeries(CandlestickSeries) threw:', err.message);
        }
      }

      // Some builds expose the constructor under a different name
      if (!candleSeries) {
        const alt =
          window.LightweightCharts.candlestickSeries ||
          window.LightweightCharts.SeriesCandlestick ||
          null;
        if (alt) {
          try {
            candleSeries = chart.addSeries(alt, candleOpts);
            _chartApi = 'v5-alt';
            console.log('[TV] ✓ Using v5-alt API');
          } catch (err) {
            console.warn('[TV] v5-alt threw:', err.message);
          }
        }
      }
    }

    if (!candleSeries) {
      setStatus(
        `❌ <b>Unsupported chart API.</b> Version: ${version}<br>` +
        `Chart has: addCandlestickSeries=${typeof chart.addCandlestickSeries}, ` +
        `addSeries=${typeof chart.addSeries}<br>` +
        `Library has: CandlestickSeries=${!!window.LightweightCharts.CandlestickSeries}<br>` +
        `<small>Try a fresh hard refresh (Ctrl+Shift+R) or check CDN response.</small>`,
        '#e74c5e'
      );
      return false;
    }

    window.addEventListener('resize', () => {
      if (chart && container) chart.applyOptions({ width: container.clientWidth || 800 });
    });

    console.log('[TV] Chart initialized ✓ (API:', _chartApi, ')');
    return true;
  }

  function extractCandle(c) {
    // Handles every shape the backend might send
    let open, high, low, close, time;

    if (c.mid && typeof c.mid === 'object') {
      open = Number(c.mid.o);
      high = Number(c.mid.h);
      low = Number(c.mid.l);
      close = Number(c.mid.c);
    } else {
      open = Number(c.open);
      high = Number(c.high);
      low = Number(c.low);
      close = Number(c.close);
    }

    if (typeof c.time === 'number') time = c.time;
    else if (typeof c.epoch === 'number') time = c.epoch;
    else if (typeof c.t === 'number') time = c.t;
    else return null;

    time = Math.floor(time > 1e12 ? time / 1000 : time);
    if (!time) return null;

    if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return null;
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) return null;

    return { time, open, high, low, close };
  }

  async function loadCandles() {
    console.log(`[TV] loadCandles() — ${currentSymbol} ${currentTF}`);

    if (!candleSeries) {
      setStatus('❌ Chart not initialized. Click <b>Reload</b> after checking Debug panel.', '#e74c5e');
      return;
    }

    setStatus('⏳ Loading candles...', '#f39c12');

    const url = `/api/candles?pair=${encodeURIComponent(currentSymbol)}&count=200&granularity=${currentTF}`;
    let res, text, data;
    try {
      res = await fetch(url);
      text = await res.text();
    } catch (err) {
      setStatus('❌ <b>Network error:</b> ' + err.message, '#e74c5e');
      return;
    }

    console.log('[TV] Response:', res.status, res.statusText, 'length:', text.length);

    if (!res.ok) {
      setStatus(
        `❌ <b>/api/candles returned HTTP ${res.status}.</b><br>` +
        `<small>${text.slice(0, 200).replace(/</g, '&lt;')}</small>`,
        '#e74c5e'
      );
      return;
    }

    try { data = JSON.parse(text); }
    catch (err) {
      setStatus(`❌ <b>Invalid JSON:</b><br><small>${text.slice(0, 200)}</small>`, '#e74c5e');
      return;
    }

    if (!Array.isArray(data)) {
      setStatus(
        `❌ <b>Expected array, got ${typeof data}.</b><br>` +
        `<small>${JSON.stringify(data).slice(0, 200)}</small>`,
        '#e74c5e'
      );
      return;
    }

    if (data.length === 0) {
      setStatus(
        '⚠️ <b>No candles returned.</b><br>' +
        '<small>Broker has no history yet for this pair/timeframe. This resolves after the first candle closes.</small>',
        '#f39c12'
      );
      return;
    }

    _candles = [];
    for (const c of data) {
      const mapped = extractCandle(c);
      if (mapped) _candles.push(mapped);
    }

    if (_candles.length === 0) {
      setStatus(
        '❌ <b>All candles failed validation.</b><br>' +
        '<small>First raw: ' + JSON.stringify(data[0]).slice(0, 300) + '</small>',
        '#e74c5e'
      );
      return;
    }

    _candles.sort((a, b) => a.time - b.time);
    console.log('[TV] Mapped ' + _candles.length + ' candles');

    try {
      candleSeries.setData(_candles);
      chart.timeScale().fitContent();
      setStatus('');
      renderCandleTable();
      console.log('[TV] ✓ Chart rendered');
    } catch (err) {
      setStatus('❌ <b>setData failed:</b> ' + err.message, '#e74c5e');
      console.error('[TV] setData threw:', err);
    }
  }

  function renderCandleTable() {
    const tbody = document.getElementById('tvCandleTable');
    if (!tbody) return;
    const recent = _candles.slice(-50).reverse();
    if (recent.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-muted">No candles</td></tr>';
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
        try { candleSeries.update(_candles[_candles.length - 1]); } catch (_) {}
      } else {
        last.high = Math.max(last.high, mid);
        last.low = Math.min(last.low, mid);
        last.close = mid;
        try { candleSeries.update(last); } catch (_) {}
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

  function wireControls() {
    document.getElementById('tvSymbolSelect')?.addEventListener('change', e => {
      currentSymbol = e.target.value;
      const el = document.getElementById('tvSymbol');
      if (el) el.textContent = currentSymbol;
      loadCandles();
    });
    document.getElementById('tvTimeframeSelect')?.addEventListener('change', e => {
      currentTF = e.target.value;
      loadCandles();
    });
    document.getElementById('tvReloadChart')?.addEventListener('click', () => {
      console.log('[TV] Manual reload');
      if (!chart) initChart();
      loadCandles();
    });
    document.getElementById('tvExportCSV')?.addEventListener('click', () => {
      if (_candles.length === 0) { alert('No candles to export.'); return; }
      let csv = 'Time,Open,High,Low,Close\n';
      for (const c of _candles) {
        csv += `${new Date(c.time * 1000).toISOString()},${c.open},${c.high},${c.low},${c.close}\n`;
      }
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${currentSymbol}_${currentTF}_candles.csv`;
      a.click(); URL.revokeObjectURL(a.href);
    });
  }

  function boot() {
    console.log('[TV] Booting...');
    const ok = initChart();
    wireControls();
    if (ok) loadCandles();
    setInterval(() => { if (_candles.length > 0) loadCandles(); }, 60000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
