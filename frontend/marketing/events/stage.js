/* Queen Captivated Events: 3D photo stage.
   Put data-qc-stage on any block (add data-fixed to make it the whole-page background).
   To change the photos, edit the SLIDES list below (t:'cover' = full-bleed photo, t:'card' = floating 3D photo card). */
(function () {
  var SLIDES = [
    { u: '/events/img/festival.jpg', t: 'cover' },
    { u: '/events/img/shawl.jpg', t: 'card' }
  ], EVERY = 7000;

  var css =
    '.qc3d{position:absolute;inset:0;overflow:hidden;perspective:1400px;z-index:0;pointer-events:none;background:#120a10}' +
    '[data-fixed]>.qc3d{position:fixed;z-index:-1}' +
    '.qc3d .qc-sl{position:absolute;inset:0;opacity:0;transform:translateZ(-380px) rotateY(24deg) scale(1.12);transition:opacity 1.6s ease,transform 2s cubic-bezier(.2,.7,.2,1);transform-style:preserve-3d}' +
    '.qc3d .qc-sl.qc-on{opacity:1;transform:none}.qc3d .qc-sl.qc-out{transform:translateZ(-380px) rotateY(-24deg) scale(1.12)}' +
    '.qc3d .qc-par{position:absolute;inset:-5%;transform:translate3d(calc(var(--px,0)*-18px),calc(var(--py,0)*-12px),0)}' +
    '.qc3d .qc-bg{position:absolute;inset:0;background-size:cover;background-position:center;animation:qckb 16s ease-in-out infinite alternate}' +
    '.qc3d .qc-blur{filter:blur(22px) brightness(.6) saturate(1.25)}' +
    '.qc3d .qc-par::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(18,10,16,.66),rgba(18,10,16,.5) 42%,rgba(18,10,16,.9))}' +
    '[data-fixed] .qc3d .qc-par::after{background:rgba(18,10,16,.74)}' +
    '[data-qc-stage] .ev-brand,[data-qc-stage] h2,[data-qc-stage] .ev-tag{text-shadow:0 2px 16px rgba(0,0,0,.85),0 0 3px rgba(0,0,0,.6)}[data-qc-stage] .ev-ghost{background:rgba(18,10,16,.65)}[data-qc-stage] .ev-cats a{background:rgba(18,10,16,.55)}' +
    '@keyframes qckb{from{transform:scale(1.04)}to{transform:scale(1.16) translate3d(-1.5%,-1%,0)}}' +
    '.qc3d .qc-cw{position:absolute;right:3vw;top:50%;width:min(19vw,260px);aspect-ratio:335/597;margin-top:calc(min(19vw,260px)*-.891);animation:qcfl 6s ease-in-out infinite alternate;transform-style:preserve-3d}' +
    '[data-fixed] .qc3d .qc-cw{opacity:.5}' +
    '.qc3d .qc-card{position:absolute;inset:0;border-radius:14px;background-size:cover;background-position:center;box-shadow:0 40px 80px -20px #000,0 0 0 1px rgba(255,255,255,.2),0 0 70px rgba(217,183,126,.3);transform:rotateY(calc(-16deg + var(--px,0)*12deg)) rotateX(calc(4deg + var(--py,0)*-8deg));transition:transform .25s linear}' +
    '.qc3d .qc-card::after{content:"";position:absolute;inset:0;border-radius:14px;background:linear-gradient(115deg,transparent 30%,rgba(255,255,255,.24) 48%,transparent 62%);background-size:250% 100%;animation:qcsh 5s ease-in-out infinite}' +
    '@keyframes qcfl{from{transform:translate3d(0,-10px,70px)}to{transform:translate3d(0,12px,0)}}@keyframes qcsh{from{background-position:120% 0}to{background-position:-60% 0}}' +
    '@media(max-width:900px){.qc3d .qc-cw{right:auto;left:50%;width:min(44vw,200px);margin-left:calc(min(44vw,200px)/-2);margin-top:calc(min(44vw,200px)*-.891)}}' +
    '@media(prefers-reduced-motion:reduce){.qc3d .qc-bg,.qc3d .qc-cw,.qc3d .qc-card::after{animation:none}.qc3d .qc-sl{transition:opacity 1s;transform:none!important}}';

  function build(host) {
    var w = document.createElement('div');
    w.className = 'qc3d';
    w.setAttribute('aria-hidden', 'true');
    w.innerHTML = SLIDES.map(function (s) {
      var card = s.t === 'card';
      return '<div class="qc-sl"><div class="qc-par"><div class="qc-bg' + (card ? ' qc-blur' : '') + '" style="background-image:url(' + s.u + ')"></div></div>' +
        (card ? '<div class="qc-cw"><div class="qc-card" style="background-image:url(' + s.u + ')"></div></div>' : '') + '</div>';
    }).join('');
    host.insertBefore(w, host.firstChild);

    var el = [].slice.call(w.children), i = -1;
    function next() {
      var o = el[i];
      if (o) { o.classList.remove('qc-on'); o.classList.add('qc-out'); }
      i = (i + 1) % el.length;
      var n = el[i];
      n.classList.remove('qc-out'); void n.offsetWidth; n.classList.add('qc-on');
      setTimeout(function () { if (o && o !== n) o.classList.remove('qc-out'); }, 2200);
    }
    next();
    if (el.length > 1) setInterval(function () { if (!document.hidden) next(); }, EVERY);

    var fixed = host.hasAttribute('data-fixed'), raf = 0;
    (fixed ? window : host).addEventListener('pointermove', function (e) {
      if (raf) return;
      raf = requestAnimationFrame(function () {
        raf = 0;
        var r = fixed ? { left: 0, top: 0, width: innerWidth, height: innerHeight } : host.getBoundingClientRect();
        w.style.setProperty('--px', ((e.clientX - r.left) / r.width - .5) * 2);
        w.style.setProperty('--py', ((e.clientY - r.top) / r.height - .5) * 2);
      });
    });
  }

  function init() {
    if (!document.getElementById('qc3d-css')) {
      var st = document.createElement('style'); st.id = 'qc3d-css'; st.textContent = css; document.head.appendChild(st);
    }
    [].slice.call(document.querySelectorAll('[data-qc-stage]')).forEach(function (h) {
      if (!h.querySelector(':scope>.qc3d')) build(h);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
