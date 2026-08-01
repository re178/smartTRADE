// core/reporting/reportGenerator.js
// Generates professional PDF trading reports using pdfkit.

const PDFDocument = require('pdfkit');
const { createReadStream } = require('fs');
const crypto = require('crypto');

/**
 * Generate a PDF report.
 * @param {Object} data - Report data.
 * @param {Date} data.fromDate - Start date.
 * @param {Date} data.toDate - End date.
 * @param {Array} data.trades - Array of trade objects.
 * @param {Object} data.metrics - Performance metrics (winRate, profitFactor, etc.).
 * @param {Object} data.account - Account info.
 * @param {string} data.verificationCode - Unique code for report verification.
 * @param {string} data.systemName - System name.
 * @returns {Promise<Buffer>} PDF buffer.
 */
function generateReport(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });
      doc.on('error', reject);

      // ---- Header ----
      doc.fontSize(20).font('Helvetica-Bold')
        .text(data.systemName || 'RTS/CTOS Trading Report', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(12).font('Helvetica')
        .text(`Report Period: ${data.fromDate.toLocaleDateString()} - ${data.toDate.toLocaleDateString()}`, { align: 'center' });
      doc.text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
      doc.text(`Verification Code: ${data.verificationCode || 'N/A'}`, { align: 'center' });
      doc.moveDown();

      // ---- Account Summary ----
      doc.fontSize(14).font('Helvetica-Bold').text('Account Summary');
      doc.fontSize(10).font('Helvetica');
      doc.text(`Balance: ${data.account.balance || 0} ${data.account.currency || 'USD'}`);
      doc.text(`Equity: ${data.account.equity || 0} ${data.account.currency || 'USD'}`);
      doc.text(`Margin Free: ${data.account.free_margin || 0} ${data.account.currency || 'USD'}`);
      doc.text(`Account: ${data.account.accountName || 'N/A'} (${data.account.server || 'N/A'})`);
      doc.moveDown();

      // ---- Performance Metrics ----
      doc.fontSize(14).font('Helvetica-Bold').text('Performance Metrics');
      doc.fontSize(10).font('Helvetica');
      const metrics = data.metrics || {};
      const rows = [
        ['Total Trades', metrics.totalTrades || 0],
        ['Win Rate', ((metrics.winRate || 0) * 100).toFixed(1) + '%'],
        ['Profit Factor', (metrics.profitFactor || 0).toFixed(2)],
        ['Expectancy', (metrics.expectancy || 0).toFixed(2)],
        ['Sharpe Ratio', (metrics.sharpe || 0).toFixed(2)],
        ['Max Drawdown', ((metrics.maxDrawdown || 0) * 100).toFixed(1) + '%'],
        ['Profit per Trade', (metrics.profitPerTrade || 0).toFixed(2)],
      ];
      let y = doc.y;
      doc.text('Metric', 50, y, { width: 150 });
      doc.text('Value', 200, y, { width: 150 });
      y += 15;
      for (const [label, value] of rows) {
        doc.text(label, 50, y, { width: 150 });
        doc.text(String(value), 200, y, { width: 150 });
        y += 15;
      }
      doc.moveDown();

      // ---- Trades Table (if included) ----
      if (data.trades && data.trades.length > 0) {
        doc.fontSize(14).font('Helvetica-Bold').text('Trade History');
        doc.fontSize(9).font('Helvetica');
        const tableTop = doc.y + 10;
        const colWidths = [80, 50, 60, 60, 60, 60, 80];
        const headers = ['Pair', 'Side', 'Entry', 'Exit', 'Lot', 'P/L', 'Date'];

        // Draw table header
        let x = 50;
        doc.font('Helvetica-Bold');
        headers.forEach((h, i) => {
          doc.text(h, x, tableTop, { width: colWidths[i], align: 'left' });
          x += colWidths[i];
        });
        doc.font('Helvetica');
        let yPos = tableTop + 15;
        const maxRows = 30; // limit to avoid page overflow
        const displayTrades = data.trades.slice(0, maxRows);
        for (const t of displayTrades) {
          const row = [
            t.pair || 'N/A',
            t.side || 'N/A',
            t.entryPrice ? t.entryPrice.toFixed(5) : 'N/A',
            t.exitPrice ? t.exitPrice.toFixed(5) : 'N/A',
            (t.lotSize || 0).toFixed(2),
            ((t.pnl || 0) > 0 ? '+' : '') + (t.pnl || 0).toFixed(2),
            t.date ? new Date(t.date).toLocaleDateString() : 'N/A',
          ];
          x = 50;
          row.forEach((item, i) => {
            doc.text(item, x, yPos, { width: colWidths[i], align: 'left' });
            x += colWidths[i];
          });
          yPos += 15;
          if (yPos > doc.page.height - 50) {
            doc.addPage();
            yPos = 50;
          }
        }
        if (data.trades.length > maxRows) {
          doc.text(`... and ${data.trades.length - maxRows} more trades`, 50, yPos);
        }
        doc.moveDown();
      } else {
        doc.fontSize(10).font('Helvetica').text('No trades in this period.', 50, doc.y + 10);
      }

      // ---- Footer ----
      doc.fontSize(8).font('Helvetica')
        .text(`This report is automatically generated by RTS/CTOS v2.0. Verification code: ${data.verificationCode || 'N/A'}`, {
          align: 'center',
          baseline: 'bottom',
        });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateReport };
