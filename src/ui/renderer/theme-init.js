/* global localStorage, document */
// Restore before styles or React render the first frame.
try {
  const theme = localStorage.getItem('zs.hifi.theme') === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
} catch { /* storage unavailable: retain light default */ }

