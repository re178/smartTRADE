// public/js/tradingview.js
// Chart loader with v4/v5 support + drawing tools integration.

'use strict';

(function () {
  console.log('[TV] tradingview.js loading...');

  let chart = null;
  let candleSeries = null;
  let currentSymbol = 'EURUSD';
  let currentTF = 'M5';
  let _candles = [];
  let _chartApi = null;

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
      setStatus('Error: #tradingChart container not found in DOM', '#e74c5e');
      return false;
    }

    const lib = chartLibAvailable();
    if (!lib.ok) {
      setStatus('Chart library not loaded. ' + lib.reason, '#e74c5e');
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
      setStatus('createChart failed: ' + err.message, '#e74c5e');
      return false;
    }

    const candleOpts = {
      upColor: '#00b894', downColor: '#e74c5e',
      borderUpColor: '#00b894', borderDownColor: '#e74c5e',
      wickUpColor: '#00b894', wickDownColor: '#e74c5e',
    };

    if (typeof chart.addCandlestickSeries === 'function') {
      try {
        candleSeries = chart.addCandlestickSeries(candleOpts);
        _chartApi = 'v4';
        console.log('[TV] Using v4 API (chart.addCandlestickSeries)');
      } catch (err) {
        console.warn('[TV] v4 addCandlestickSeries threw:', err.message);
      }
    }

    if (!candleSeries && typeof chart.addSeries === 'function') {
      const CandleCtor =
        window.LightweightCharts.CandlestickSeries ||
        window.LightweightCharts.CandlestickSeriesOptions ||
        null;
      if (CandleCtor) {
        try {
          candleSeries = chart.addSeries(CandleCtor, candleOpts);
          _chartApi = 'v5';
          console.log('[TV] Using v5 API (chart.addSeries(CandlestickSeries))');
        } catch (err) {
          console.warn('[TV] v5 addSeries threw:', err.message);
        }
      }
    }

    if (!candleSeries) {
      setStatus('Unsupported chart API. Version: ' + version, '#e74c5e');
      return false;
    }

    window.addEventListener('resize', () => {
      if (chart && container) chart.applyOptions({ width: container.clientWidth || 800 });
    });

    // Attach drawing tools
    try {
      if (window.ChartTools && typeof window.ChartTools.attach === 'function') {
        window.ChartTools.attach({
          chart,
          series: candleSeries,
          container,
          getSymbol: () => currentSymbol,
          getTimeframe: () => currentTF,
        });
        console.log('[TV] Chart tools attached');
      }
    } catch (err) {
      console.warn('[TV] Chart tools attach failed:', err.message);
    }

    console.log('[TV] Chart initialized (API:', _chartApi, ')');
    return true;
  }

  function extractCandle(c) {
    let open, high, low, close, time;
    if (c.mid && typeof c.mid === 'object') {
      open = Number(c.mid.o); high = Number(c.mid.h); low = Number(c.mid.l); close = Number(c.mid.c);
    } else {
      open = Number(c.open); high = Number(c.high); low = Number(c.low); close = Number(c.close);
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
      setStatus('Chart not initialized. Click Reload after checking Debug panel.', '#e74c5e');
      return;
    }
    setStatus('Loading candles...', '#f39c12');

    const url = `/api/candles?pair=${encodeURIComponent(currentSymbol)}&count=200&granularity=${currentTF}`;
    let res, text, data;
    try {
      res = await fetch(url);
      text = await res.text();
    } catch (err) {
      setStatus('Network error: ' + err.message, '#e74c5e');
      return;
    }

    if (!res.ok) {
      setStatus(`/api/candles returned HTTP ${res.status}.`, '#e74c5e');
      return;
    }

    try { data = JSON.parse(text); }
    catch (err) {
      setStatus('Invalid JSON from /api/candles', '#e74c5e');
      return;
    }

    if (!Array.isArray(data)) {
      setStatus(`Expected array, got ${typeof data}.`, '#e74c5e');
      return;
    }

    if (data.length === 0) {
      setStatus('No candles returned. Broker has no history yet.', '#f39c12');
      return;
    }

    _candles = [];
    for (const c of data) {
      const mapped = extractCandle(c);
      if (mapped) _candles.push(mapped);
    }

    if (_candles.length === 0) {
      setStatus('All candles failed validation.', '#e74c5e');
      return;
    }

    _candles.sort((a, b) => a.time - b.time);
    console.log('[TV] Mapped ' + _candles.length + ' candles');

    try {
      candleSeries.setData(_candles);
      chart.timeScale().fitContent();
      setStatus('');
      renderCandleTable();
      console.log('[TV] Chart rendered');
    } catch (err) {
      setStatus('setData failed: ' + err.message, '#e74c5e');
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
    if (!data) return;
    const sym = String(data.symbol || '').replace(/^frx/i, '').replace(/[_/]/g, '').toUpperCase();
    if (sym !== currentSymbol) return;

    const bid = Number(data.bid) || 0;
    const ask = Number(data.ask) || 0;
    let mid = Number(data.mid);
    if (!Number.isFinite(mid) || mid <= 0) {
      mid = (bid > 0 && ask > 0) ? (bid + ask) / 2 : (bid || ask || 0);
    }

    const tvPrice = document.getElementById('tvPrice');
    if (tvPrice && mid > 0) tvPrice.textContent = mid.toFixed(5);

    if (!candleSeries || _candles.length === 0 || mid <= 0) return;

    const last = _candles[_candles.length - 1];
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
      if (window.ChartTools && window.ChartTools.reloadForNewSymbol) {
        window.ChartTools.reloadForNewSymbol();
      }
      loadCandles();
    });
    document.getElementById('tvTimeframeSelect')?.addEventListener('change', e => {
      currentTF = e.target.value;
      if (window.ChartTools && window.ChartTools.reloadForNewSymbol) {
        window.ChartTools.reloadForNewSymbol();
      }
      loadCandles();
    });
    document.getElementById('tvReloadChart')?.addEventListener('click', () => {
      if (!chart) initChart();
      loadCandles();
    });
    document.getElementById('tvExportCSV')?.addEventListener('click', () => {
      if (_candles.length === 0) { alert('No candles to export.'); return; }
      let csv = 'Time,Open,High,Low,Close\n';
      for (const c of _candles) csv += `${new Date(c.time * 1000).toISOString()},${c.open},${c.high},${c.low},${c.close}\n`;
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${currentSymbol}_${currentTF}_candles.csv`;
      a.click(); URL.revokeObjectURL(a.href);
    });

    ['hline', 'vline', 'box'].forEach(tool => {
      document.getElementById('tool_' + tool)?.addEventListener('click', () => {
        if (!window.ChartTools) return;
        const current = window.ChartTools.tool;
        window.ChartTools.setTool(current === tool ? null : tool);
        window.ChartTools._updateToolButtons();
      });
    });
    document.getElementById('tool_undo')?.addEventListener('click', () => {
      if (window.ChartTools) window.ChartTools.undo();
    });
    document.getElementById('tool_clear')?.addEventListener('click', () => {
      if (window.ChartTools) window.ChartTools.clear();
    });

    document.getElementById('tvFullscreen')?.addEventListener('click', () => {
      const body = document.getElementById('tvChartBody');
      if (!body) return;
      if (!document.fullscreenElement) {
        body.requestFullscreen().then(() => {
          setTimeout(() => {
            if (chart) chart.applyOptions({ width: body.clientWidth, height: window.innerHeight - 80 });
            if (window.ChartTools && window.ChartTools._resize) window.ChartTools._resize();
          }, 100);
        }).catch(err => alert('Fullscreen failed: ' + err.message));
      } else {
        document.exitFullscreen().then(() => {
          setTimeout(() => {
            if (chart) chart.applyOptions({ width: body.clientWidth, height: 500 });
            if (window.ChartTools && window.ChartTools._resize) window.ChartTools._resize();
          }, 100);
        });
      }
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
