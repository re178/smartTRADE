// public/js/chart-tools.js
// Canvas overlay for drawing on the Lightweight Charts canvas.
// Tools: Horizontal Line, Vertical Line, Box.
// Drawings persist per-symbol-per-timeframe in localStorage.

'use strict';

(function () {
  const STORAGE_PREFIX = 'rts_drawings_';

  class ChartTools {
    constructor() {
      this.canvas = null;
      this.ctx = null;
      this.chart = null;
      this.series = null;
      this.container = null;
      this.getSymbol = null;
      this.getTimeframe = null;
      this.tool = null;
      this.drawings = [];
      this._dragStart = null;
      this._resizeObserver = null;
      this._boundRedraw = this.redraw.bind(this);
      this._boundMouseDown = this.onMouseDown.bind(this);
      this._boundMouseMove = this.onMouseMove.bind(this);
      this._boundMouseUp = this.onMouseUp.bind(this);
    }

    attach(opts) {
      this.chart = opts.chart;
      this.series = opts.series;
      this.container = opts.container;
      this.getSymbol = opts.getSymbol || (() => 'EURUSD');
      this.getTimeframe = opts.getTimeframe || (() => 'M5');

      if (this.canvas) {
        try { this.canvas.remove(); } catch (_) {}
      }

      const rect = this.container.getBoundingClientRect();
      this.canvas = document.createElement('canvas');
      this.canvas.width = rect.width;
      this.canvas.height = rect.height;
      this.canvas.style.cssText = 'position:absolute; top:0; left:0; pointer-events:auto; z-index:5;';
      this.container.style.position = 'relative';
      this.container.appendChild(this.canvas);
      this.ctx = this.canvas.getContext('2d');

      this.canvas.addEventListener('mousedown', this._boundMouseDown);
      this.canvas.addEventListener('mousemove', this._boundMouseMove);
      this.canvas.addEventListener('mouseup', this._boundMouseUp);
      this.canvas.addEventListener('mouseleave', this._boundMouseUp);

      try {
        this.chart.timeScale().subscribeVisibleTimeRangeChange(this._boundRedraw);
      } catch (_) {}
      try {
        this.chart.subscribeCrosshairMove(() => this._boundRedraw());
      } catch (_) {}

      try {
        this._resizeObserver = new ResizeObserver(() => this._resize());
        this._resizeObserver.observe(this.container);
      } catch (_) {}

      this.load();
      this.redraw();
    }

    _storageKey() {
      return STORAGE_PREFIX + this.getSymbol() + '_' + this.getTimeframe();
    }

    load() {
      try {
        const raw = localStorage.getItem(this._storageKey());
        this.drawings = raw ? JSON.parse(raw) : [];
      } catch (_) { this.drawings = []; }
    }

    save() {
      try { localStorage.setItem(this._storageKey(), JSON.stringify(this.drawings)); } catch (_) {}
    }

    reloadForNewSymbol() {
      this.load();
      this.redraw();
    }

    setTool(toolName) {
      this.tool = toolName;
      if (this.canvas) {
        this.canvas.style.cursor = toolName ? 'crosshair' : 'default';
      }
    }

    clear() {
      if (this.drawings.length === 0) return;
      if (!confirm('Clear all drawings for this chart?')) return;
      this.drawings = [];
      this.save();
      this.redraw();
    }

    undo() {
      if (this.drawings.length === 0) return;
      this.drawings.pop();
      this.save();
      this.redraw();
    }

    _pixelToPrice(y) {
      try {
        const p = this.series.coordinateToPrice(y);
        return Number.isFinite(p) ? p : null;
      } catch (_) { return null; }
    }
    
    _pixelToTime(x) {
      try { return this.chart.timeScale().coordinateToTime(x); } catch (_) { return null; }
    }
    
    _priceToPixel(price) {
      try { return this.series.priceToCoordinate(price); } catch (_) { return null; }
    }
    
    _timeToPixel(time) {
      try { return this.chart.timeScale().timeToCoordinate(time); } catch (_) { return null; }
    }

    onMouseDown(ev) {
      if (!this.tool) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const price = this._pixelToPrice(y);
      const time = this._pixelToTime(x);

      if (this.tool === 'hline') {
        if (price != null) {
          this.drawings.push({ type: 'hline', price, color: '#f39c12' });
          this.save();
          this.redraw();
        }
        this.setTool(null);
        this._updateToolButtons();
        return;
      }
      
      if (this.tool === 'vline') {
        if (time != null) {
          this.drawings.push({ type: 'vline', time, color: '#3498db' });
          this.save();
          this.redraw();
        }
        this.setTool(null);
        this._updateToolButtons();
        return;
      }
      
      if (this.tool === 'box') {
        if (price != null && time != null) {
          this._dragStart = { time, price };
        }
        return;
      }
    }

    onMouseMove(ev) {
      if (this.tool !== 'box' || !this._dragStart) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const price = this._pixelToPrice(y);
      const time = this._pixelToTime(x);
      if (price == null || time == null) return;

      this.redraw();
      const x1 = this._timeToPixel(this._dragStart.time);
      const x2 = this._timeToPixel(time);
      const y1 = this._priceToPixel(this._dragStart.price);
      const y2 = this._priceToPixel(price);
      
      if (x1 == null || x2 == null || y1 == null || y2 == null) return;
      this._drawBoxPixels(x1, y1, x2, y2, 'rgba(0, 184, 148, 0.15)', '#00b894', 2, true);
    }

    onMouseUp(ev) {
      if (this.tool !== 'box' || !this._dragStart) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const price = this._pixelToPrice(y);
      const time = this._pixelToTime(x);
      
      if (price != null && time != null) {
        this.drawings.push({
          type: 'box',
          t1: this._dragStart.time, p1: this._dragStart.price,
          t2: time, p2: price,
          color: '#00b894',
        });
        this.save();
      }
      this._dragStart = null;
      this.redraw();
      this.setTool(null);
      this._updateToolButtons();
    }

    _drawBoxPixels(x1, y1, x2, y2, fillColor, strokeColor, lineWidth, dashed) {
      const left = Math.min(x1, x2);
      const right = Math.max(x1, x2);
      const top = Math.min(y1, y2);
      const bottom = Math.max(y1, y2);
      
      this.ctx.save();
      this.ctx.fillStyle = fillColor;
      this.ctx.fillRect(left, top, right - left, bottom - top);
      
      this.ctx.strokeStyle = strokeColor;
      this.ctx.lineWidth = lineWidth;
      if (dashed) this.ctx.setLineDash([4, 4]);
      
      this.ctx.strokeRect(left, top, right - left, bottom - top);
      this.ctx.restore();
    }

    redraw() {
      if (!this.ctx) return;
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

      const W = this.canvas.width;
      const H = this.canvas.height;

      for (const d of this.drawings) {
        if (d.type === 'hline') {
          const y = this._priceToPixel(d.price);
          if (y == null) continue;
          this.ctx.save();
          this.ctx.strokeStyle = d.color || '#f39c12';
          this.ctx.lineWidth = 1.5;
          this.ctx.setLineDash([6, 4]);
          this.ctx.beginPath();
          this.ctx.moveTo(0, y);
          this.ctx.lineTo(W, y);
          this.ctx.stroke();
          this.ctx.setLineDash([]);
          this.ctx.fillStyle = d.color || '#f39c12';
          this.ctx.font = '11px monospace';
          this.ctx.fillText(d.price.toFixed(5), W - 70, y - 4);
          this.ctx.restore();
        } else if (d.type === 'vline') {
          const x = this._timeToPixel(d.time);
          if (x == null) continue;
          this.ctx.save();
          this.ctx.strokeStyle = d.color || '#3498db';
          this.ctx.lineWidth = 1.5;
          this.ctx.setLineDash([6, 4]);
          this.ctx.beginPath();
          this.ctx.moveTo(x, 0);
          this.ctx.lineTo(x, H);
          this.ctx.stroke();
          this.ctx.restore();
        } else if (d.type === 'box') {
          const x1 = this._timeToPixel(d.t1);
          const x2 = this._timeToPixel(d.t2);
          const y1 = this._priceToPixel(d.p1);
          const y2 = this._priceToPixel(d.p2);
          if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
          this._drawBoxPixels(x1, y1, x2, y2, 'rgba(0, 184, 148, 0.12)', d.color || '#00b894', 2, false);
        }
      }
    }

    _resize() {
      if (!this.canvas || !this.container) return;
      const rect = this.container.getBoundingClientRect();
      this.canvas.width = rect.width;
      this.canvas.height = rect.height;
      this.redraw();
    }

    _updateToolButtons() {
      ['hline', 'vline', 'box'].forEach(tool => {
        const btn = document.getElementById('tool_' + tool);
        if (btn) {
          btn.classList.toggle('active', this.tool === tool);
          btn.style.background = this.tool === tool ? '#1a73e8' : '';
          btn.style.color = this.tool === tool ? '#fff' : '';
        }
      });
    }
  }

  window.ChartTools = new ChartTools();
})();
