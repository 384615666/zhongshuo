/* eslint-disable no-undef */
/* 众说产品主页的少量交互：顶栏状态、移动端导航、滚动出现、大图查看、复制命令、最新版本校准。 */
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

  /* ---------- 最新版本：以 GitHub 最新 Release 为准 ---------- */
  /* 页面里的版本号与下载按钮先按最近一次发布的静态值渲染；访问时再用 GitHub
     Releases API 校准，发新版后无需重新部署页面即可自动指向最新安装包。 */
  const RELEASE_API = 'https://api.github.com/repos/384615666/zhongshuo/releases/latest';
  const RELEASE_CACHE_KEY = 'zhongshuo.latestRelease.v1';
  const RELEASE_CACHE_TTL = 10 * 60 * 1000;
  const INSTALLER_ASSET = /^Zhongshuo-Setup-(.+)-x64\.exe$/i;

  const applyLatestRelease = (release) => {
    if (!release || typeof release.tag_name !== 'string') return;
    const version = release.tag_name.replace(/^v/i, '').trim();
    if (!version) return;

    const assets = Array.isArray(release.assets) ? release.assets : [];
    const installer = assets.find(
      (asset) =>
        asset &&
        typeof asset.name === 'string' &&
        INSTALLER_ASSET.test(asset.name) &&
        typeof asset.browser_download_url === 'string',
    );

    document.querySelectorAll('[data-release-version]').forEach((node) => {
      node.textContent = version;
    });
    if (installer) {
      document.querySelectorAll('[data-release-download]').forEach((link) => {
        link.setAttribute('href', installer.browser_download_url);
      });
    }
    if (typeof release.html_url === 'string' && release.html_url) {
      document.querySelectorAll('[data-release-page]').forEach((link) => {
        link.setAttribute('href', release.html_url);
      });
    }
  };

  const readCachedRelease = () => {
    try {
      const raw = window.sessionStorage.getItem(RELEASE_CACHE_KEY);
      if (!raw) return null;
      const cached = JSON.parse(raw);
      if (!cached || typeof cached.at !== 'number' || Date.now() - cached.at > RELEASE_CACHE_TTL) {
        return null;
      }
      return cached.release ?? null;
    } catch {
      return null;
    }
  };

  const rememberRelease = (release) => {
    try {
      window.sessionStorage.setItem(RELEASE_CACHE_KEY, JSON.stringify({ at: Date.now(), release }));
    } catch {
      /* 隐私模式或存储已满时忽略；下次访问重新请求即可。 */
    }
  };

  const loadLatestRelease = async () => {
    if (typeof window.fetch !== 'function') return;
    const cached = readCachedRelease();
    if (cached) {
      applyLatestRelease(cached);
      return;
    }
    try {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller
        ? window.setTimeout(() => controller.abort(), 8000)
        : 0;
      const response = await window.fetch(RELEASE_API, {
        headers: { Accept: 'application/vnd.github+json' },
        cache: 'no-store',
        signal: controller ? controller.signal : undefined,
      });
      if (timer) window.clearTimeout(timer);
      if (!response.ok) return;
      const release = await response.json();
      applyLatestRelease(release);
      rememberRelease(release);
    } catch {
      /* 离线、接口限流或网络受阻时保留页面上的静态回退版本。 */
    }
  };

  loadLatestRelease();
})();
