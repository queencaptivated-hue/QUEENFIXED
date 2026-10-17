/* QUEEN CAPTIVATED — "Memory Lane" behaviour. Plain script, no dependencies.
   Works as <script src="/nostalgia.js" defer> and as an ES-module side-effect import. */
(function () {
  if (typeof document === 'undefined' || window.__qcNostalgia) return;
  window.__qcNostalgia = true;

  var KEY = 'qc_vintage';
  var root = document.documentElement;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function read(store, k) { try { return window[store].getItem(k); } catch (e) { return null; } }
  function write(store, k, v) { try { window[store].setItem(k, v); } catch (e) { /* storage blocked */ } }

  // Which site are we on? (drives the palette in nostalgia.css)
  var p = location.pathname;
  root.classList.add(/\/homestay/.test(p) ? 'qc-site-homestay' : /\/car-rental/.test(p) ? 'qc-site-car' : 'qc-site-marketing');

  var saved = read('localStorage', KEY);
  var on = saved === null ? true : saved === '1';
  root.classList.toggle('qc-vintage', on);

  // Typewriter font (progressive enhancement; falls back to Courier New)
  var font = document.createElement('link');
  font.rel = 'stylesheet';
  font.href = 'https://fonts.googleapis.com/css2?family=Special+Elite&display=swap';
  document.head.appendChild(font);

  function build() {
    var film = document.createElement('div'); film.className = 'qc-film'; film.setAttribute('aria-hidden', 'true');
    var vig = document.createElement('div'); vig.className = 'qc-vignette'; vig.setAttribute('aria-hidden', 'true');
    document.body.appendChild(film); document.body.appendChild(vig);

    // Skip link for keyboard users
    var main = document.querySelector('main, #main, #root, #app') || document.body;
    if (!main.id) main.id = 'qc-main';
    var skip = document.createElement('a');
    skip.className = 'qc-skip'; skip.href = '#' + main.id; skip.textContent = 'Skip to content';
    document.body.insertBefore(skip, document.body.firstChild);

    // Memory Lane switch
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'qc-toggle';
    btn.innerHTML = '<i class="dot"></i><span class="txt">Memory Lane</span>';
    function sync() {
      btn.setAttribute('aria-pressed', String(on));
      btn.setAttribute('aria-label', 'Vintage film look: ' + (on ? 'on' : 'off') + '. Press to switch.');
      btn.title = on ? 'Switch off the vintage film look' : 'Switch on the vintage film look';
    }
    btn.addEventListener('click', function () {
      on = !on; root.classList.toggle('qc-vintage', on); write('localStorage', KEY, on ? '1' : '0'); sync();
    });
    sync();
    document.body.appendChild(btn);

    // Projector warm-up: once per browser session, skippable, never for reduced-motion
    if (on && !reduce && !read('sessionStorage', 'qc_intro')) {
      write('sessionStorage', 'qc_intro', '1');
      var intro = document.createElement('div');
      intro.className = 'qc-intro'; intro.setAttribute('role', 'presentation');
      intro.innerHTML = '<div class="reel" id="qc-count">3</div><div class="title">Queen Captivated</div><div class="hint">tap to skip</div>';
      document.body.appendChild(intro);
      var n = 3, c = intro.querySelector('#qc-count');
      var tick = setInterval(function () { n--; if (n > 0) c.textContent = n; else done(); }, 380);
      function done() { clearInterval(tick); intro.classList.add('qc-out'); setTimeout(function () { intro.remove(); }, 800); }
      intro.addEventListener('click', done);
      document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { done(); document.removeEventListener('keydown', esc); } });
    }

    // "Develop" photos as they scroll into view (static pages only)
    if (!reduce && 'IntersectionObserver' in window && root.classList.contains('qc-site-marketing')) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { en.target.classList.remove('qc-develop'); io.unobserve(en.target); }
        });
      }, { threshold: 0.15 });
      document.querySelectorAll('section img, .about-grid img').forEach(function (img) {
        if (!img.closest('.hero')) { img.classList.add('qc-develop'); io.observe(img); }
      });
    }

    // Rubber stamp on the marketing hero
    var heroText = document.querySelector('.hero-slide.active .hero-text, .hero-text');
    if (heroText && root.classList.contains('qc-site-marketing')) {
      var st = document.createElement('span'); st.className = 'qc-stamp'; st.textContent = 'Ukhrul · Manipur';
      st.style.marginBottom = '14px';
      heroText.insertBefore(st, heroText.firstChild);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
