// public/js/cashier.js – Frontend-only Deriv cashier redirect
// Opens the official Deriv cashier for Options accounts.
// No backend, no API tokens, no Payment Agent registration required.
//
// URLs verified against Deriv's own payment-partner documentation:
//   Deposit:  https://app.deriv.com/cashier/deposit
//   Withdraw: https://app.deriv.com/cashier/withdraw
//
// The user MUST already be logged into Deriv in the same browser.
// If not, Deriv will ask them to log in and then return them to the cashier.

(function () {
  'use strict';

  const CASHIER_URLS = {
    deposit:  'https://app.deriv.com/cashier/deposit',
    withdraw: 'https://app.deriv.com/cashier/withdraw',
  };

  function openCashier(action) {
    const url = CASHIER_URLS[action];
    if (!url) {
      console.warn('[Cashier] Unknown action:', action);
      return;
    }
    // Open in a new tab so the trading dashboard is not lost.
    // noopener/noreferrer prevent the new tab from accessing window.opener.
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    if (!win) {
      // Popup blocked — fall back to same-tab navigation.
      window.location.href = url;
    }
  }

  // Wire the buttons once the DOM is ready.
  document.addEventListener('DOMContentLoaded', function () {
    const depositBtn  = document.getElementById('cashierDepositBtn');
    const withdrawBtn = document.getElementById('cashierWithdrawBtn');

    if (depositBtn) {
      depositBtn.addEventListener('click', function (e) {
        e.preventDefault();
        openCashier('deposit');
      });
    }

    if (withdrawBtn) {
      withdrawBtn.addEventListener('click', function (e) {
        e.preventDefault();
        openCashier('withdraw');
      });
    }
  });

  // Expose for manual invocation / debugging.
  window.RTSCashier = { open: openCashier, urls: CASHIER_URLS };
})();
