/* eslint-disable no-undef */
/* 众说产品主页的少量交互：顶栏状态、移动端导航、滚动出现、大图查看、复制命令。 */
(() => {
  'use strict';

  /* ---------- 顶栏滚动状态 ---------- */
  const head = document.getElementById('site-head');
  const setHeadState = () => {
    if (!head) return;
    head.classList.toggle('is-scrolled', window.scrollY > 8);
  };
  setHeadState();
  window.addEventListener('scroll', setHeadState, { passive: true });

  /* ---------- 移动端导航 ---------- */
  const navToggle = document.getElementById('nav-toggle');
  const nav = document.getElementById('site-nav');
  const closeNav = () => {
    if (!head || !navToggle) return;
    head.classList.remove('is-open');
    navToggle.setAttribute('aria-expanded', 'false');
    navToggle.setAttribute('aria-label', '打开导航菜单');
  };
  navToggle?.addEventListener('click', () => {
    if (!head) return;
    const open = head.classList.toggle('is-open');
    navToggle.setAttribute('aria-expanded', String(open));
    navToggle.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
  });
  nav?.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeNav));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeNav();
  });

  /* ---------- 滚动出现（尊重减少动效偏好） ---------- */
  const revealItems = Array.from(document.querySelectorAll('.reveal'));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion || !('IntersectionObserver' in window)) {
    revealItems.forEach((item) => item.classList.add('is-in'));
  } else {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('is-in');
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );
    revealItems.forEach((item) => observer.observe(item));
  }

  /* ---------- 界面大图 ---------- */
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lb-img');
  const lightboxClose = document.getElementById('lb-close');

  document.querySelectorAll('.shot-open').forEach((trigger) => {
    trigger.addEventListener('click', () => {
      const src = trigger.getAttribute('data-full');
      if (!src || !lightbox || !lightboxImg) return;
      const source = trigger.querySelector('img');
      lightboxImg.src = src;
      lightboxImg.alt = source?.alt ? `${source.alt.replace(/。$/, '')}（大图）` : '众说界面大图';
      if (!lightbox.open) lightbox.showModal();
    });
  });
  lightboxClose?.addEventListener('click', () => lightbox?.close());
  lightbox?.addEventListener('click', (event) => {
    if (event.target === lightbox) lightbox.close();
  });

  /* ---------- 复制构建命令 ---------- */
  const copyButton = document.getElementById('copy-build');
  const buildCode = document.getElementById('build-code');
  let copyTimer = 0;
  copyButton?.addEventListener('click', async () => {
    if (!buildCode) return;
    const text = buildCode.textContent ?? '';
    let ok;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        ok = document.execCommand('copy');
        area.remove();
      } catch {
        ok = false;
      }
    }
    copyButton.textContent = ok ? '已复制' : '复制失败';
    window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      copyButton.textContent = '复制';
    }, 1600);
  });
})();
