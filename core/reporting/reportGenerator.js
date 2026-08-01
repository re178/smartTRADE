// core/reporting/reportGenerator.js
// Professional PDF report generator with colors, borders, pagination.

const PDFDocument = require('pdfkit');

/**
 * Generate a professional PDF report.
 * @param {Object} data - Report data.
 * @param {Date} data.fromDate - Start date.
 * @param {Date} data.toDate - End date.
 * @param {Array} data.trades - Array of trade objects (mapped).
 * @param {Object} data.metrics - Performance metrics.
 * @param {Object} data.account - Account info.
 * @param {string} data.verificationCode - Unique verification code.
 * @param {string} data.systemName - System name.
 * @returns {Promise<Buffer>} PDF buffer.
 */
function generateReport(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        margin: 50,
        size: 'A4',
        bufferPages: true,
        autoFirstPage: true,
      });
      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });
      doc.on('error', reject);

      // ---- Colors ----
      const primaryColor = '#0d6efd';
      const primaryLight = '#e7f1ff';
      const secondaryLight = '#f8f9fa';
      const borderColor = '#dee2e6';
      const textColor = '#212529';
      const mutedColor = '#6c757d';

      // ---- Header ----
      doc.fontSize(24).font('Helvetica-Bold').fillColor(primaryColor)
        .text(data.systemName || 'RTS/CTOS Trading Report', { align: 'center' });
      doc.moveDown(0.3);
      doc.fontSize(12).font('Helvetica').fillColor(mutedColor)
        .text(`Report Period: ${data.fromDate.toLocaleDateString()} - ${data.toDate.toLocaleDateString()}`, { align: 'center' });
      doc.text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
      doc.text(`Verification Code: ${data.verificationCode || 'N/A'}`, { align: 'center' });
      doc.moveDown(0.5);
      doc.strokeColor(borderColor).lineWidth(1).moveTo(50, doc.y).lineTo(550, doc.y).stroke();
      doc.moveDown(0.5);

      // ---- Account Summary ----
      doc.fontSize(14).font('Helvetica-Bold').fillColor(textColor).text('Account Summary');
      doc.fontSize(10).font('Helvetica').fillColor(textColor);
      const account = data.account || {};
      const balance = account.balance || 0;
      const equity = account.equity || 0;
      const freeMargin = account.free_margin || 0;
      const currency = account.currency || 'USD';
      doc.text(`Balance: ${balance.toFixed(2)} ${currency}`, { continued: true })
        .text(`  Equity: ${equity.toFixed(2)} ${currency}`, { continued: true })
        .text(`  Free Margin: ${freeMargin.toFixed(2)} ${currency}`);
      doc.text(`Account: ${account.accountName || 'N/A'} (${account.server || 'N/A'})`);
      doc.moveDown(0.5);

      // ---- Performance Metrics Table ----
      doc.fontSize(14).font('Helvetica-Bold').fillColor(textColor).text('Performance Metrics');
      const metrics = data.metrics || {};
      const metricRows = [
        ['Total Trades', metrics.totalTrades || 0],
        ['Win Rate', ((metrics.winRate || 0) * 100).toFixed(1) + '%'],
        ['Profit Factor', (metrics.profitFactor || 0).toFixed(2)],
        ['Expectancy', (metrics.expectancy || 0).toFixed(2)],
        ['Sharpe Ratio', (metrics.sharpe || 0).toFixed(2)],
        ['Max Drawdown', ((metrics.maxDrawdown || 0) * 100).toFixed(1) + '%'],
        ['Profit per Trade', (metrics.profitPerTrade || 0).toFixed(2)],
      ];

      const tableTop = doc.y + 5;
      const col1 = 50;
      const col2 = 200;
      const rowHeight = 18;
      const tableWidth = 150;

      doc.fontSize(9).font('Helvetica');
      // Header
      doc.fillColor(primaryLight).rect(col1, tableTop, tableWidth, rowHeight).fill();
      doc.fillColor(textColor).text('Metric', col1 + 5, tableTop + 4, { width: tableWidth - 10 });
      doc.fillColor(primaryLight).rect(col2, tableTop, tableWidth, rowHeight).fill();
      doc.fillColor(textColor).text('Value', col2 + 5, tableTop + 4, { width: tableWidth - 10 });

      let yPos = tableTop + rowHeight;
      let rowIndex = 0;
      for (const [label, value] of metricRows) {
        const bgColor = rowIndex % 2 === 0 ? secondaryLight : '#ffffff';
        doc.fillColor(bgColor).rect(col1, yPos, tableWidth, rowHeight).fill();
        doc.fillColor(textColor).text(label, col1 + 5, yPos + 4, { width: tableWidth - 10 });
        doc.fillColor(bgColor).rect(col2, yPos, tableWidth, rowHeight).fill();
        doc.fillColor(textColor).text(String(value), col2 + 5, yPos + 4, { width: tableWidth - 10 });
        // Grid lines
        doc.strokeColor(borderColor).lineWidth(0.5)
          .rect(col1, yPos, tableWidth, rowHeight).stroke()
          .rect(col2, yPos, tableWidth, rowHeight).stroke();
        yPos += rowHeight;
        rowIndex++;
      }
      // outer border
      doc.strokeColor(borderColor).lineWidth(1)
        .rect(col1, tableTop, 2 * tableWidth, yPos - tableTop).stroke();
      doc.moveDown(0.5);

      // ---- Trade History ----
      if (data.trades && data.trades.length > 0) {
        doc.fontSize(14).font('Helvetica-Bold').fillColor(textColor).text('Trade History');
        doc.fontSize(8).font('Helvetica');

        const colWidths = [60, 40, 50, 50, 40, 50, 80];
        const headers = ['Pair', 'Side', 'Entry', 'Exit', 'Lot', 'P/L', 'Date'];
        const tableTop2 = doc.y + 5;
        const totalWidth = colWidths.reduce((a, b) => a + b, 0);
        const startX = 50;

        // Draw header
        let x = startX;
        doc.fillColor(primaryColor).rect(startX, tableTop2, totalWidth, 15).fill();
        doc.fillColor('#ffffff');
        headers.forEach((h, i) => {
          doc.text(h, x, tableTop2 + 3, { width: colWidths[i], align: 'center' });
          x += colWidths[i];
        });

        let yPos2 = tableTop2 + 15;
        const maxRowsPerPage = 35;
        const displayTrades = data.trades.slice(0, 1000); // safety limit

        for (let i = 0; i < displayTrades.length; i++) {
          const t = displayTrades[i];
          const pnl = t.pnl || 0;
          const row = [
            t.pair || 'N/A',
            (t.side || 'N/A').toUpperCase(),
            t.entryPrice !== null ? t.entryPrice.toFixed(5) : 'N/A',
            t.exitPrice !== null ? t.exitPrice.toFixed(5) : 'N/A',
            (t.lotSize || 0).toFixed(2),
            (pnl > 0 ? '+' : '') + pnl.toFixed(2),
            t.date ? new Date(t.date).toLocaleDateString() : 'N/A',
          ];

          // Alternate row colors
          const bgColor = i % 2 === 0 ? secondaryLight : '#ffffff';
          doc.fillColor(bgColor).rect(startX, yPos2, totalWidth, 12).fill();
          doc.fillColor(textColor);
          x = startX;
          row.forEach((item, idx) => {
            const align = (idx === 0 || idx === headers.length-1) ? 'left' : 'center';
            doc.text(item, x, yPos2 + 1, { width: colWidths[idx], align: align });
            x += colWidths[idx];
          });

          // Horizontal line
          doc.strokeColor(borderColor).lineWidth(0.3)
            .moveTo(startX, yPos2 + 12).lineTo(startX + totalWidth, yPos2 + 12).stroke();

          yPos2 += 12;

          // Pagination
          if (yPos2 > doc.page.height - 60 && i < displayTrades.length - 1) {
            // draw bottom border
            doc.strokeColor(borderColor).lineWidth(0.5)
              .rect(startX, tableTop2, totalWidth, yPos2 - tableTop2).stroke();
            doc.addPage();
            // redraw header on new page
            yPos2 = 50;
            doc.fillColor(primaryColor).rect(startX, yPos2, totalWidth, 15).fill();
            doc.fillColor('#ffffff');
            x = startX;
            headers.forEach((h, idx) => {
              doc.text(h, x, yPos2 + 3, { width: colWidths[idx], align: 'center' });
              x += colWidths[idx];
            });
            yPos2 += 15;
          }
        }

        // Final table border
        doc.strokeColor(borderColor).lineWidth(0.5)
          .rect(startX, tableTop2, totalWidth, yPos2 - tableTop2).stroke();

        if (data.trades.length > 1000) {
          doc.fontSize(8).text(`... and ${data.trades.length - 1000} more trades`, startX, yPos2 + 5);
        }
        doc.moveDown(0.5);
      } else {
        doc.fontSize(10).font('Helvetica').fillColor(mutedColor)
          .text('No trades in this period.', 50, doc.y + 10);
      }

      // ---- Footer ----
      doc.fontSize(8).font('Helvetica').fillColor(mutedColor)
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
