/**
 * Soft password gate for the public wedding site.
 * Not real security — anyone reading the source can find the hash and word.
 * Purpose: keep casual visitors / search engines / drive-by snoops out.
 *
 * Skipped on /admin* (admin.html has its own auth).
 * Persists in localStorage so a guest unlocks once per device.
 */
(function () {
  var PASSWORD_HASH = 'e204717624830b1979cc7018f508f31cf6a85006a05fedfc80198364e2a4276a';
  var STORAGE_KEY   = 'cl_gate_v1';
  var STORAGE_VAL   = '1';

  if (/\/admin(?:\.html)?$/i.test(location.pathname)) return;
  try {
    if (localStorage.getItem(STORAGE_KEY) === STORAGE_VAL) return;
  } catch (e) { /* private mode etc. */ }

  // Pre-paint hide — inject style into <head> as early as possible so the
  // real page never flashes before the gate appears.
  var preStyle = document.createElement('style');
  preStyle.id = 'cl-gate-prepaint';
  preStyle.textContent =
    'html.cl-gate-locked body > *:not(#cl-gate){visibility:hidden!important;}' +
    'html.cl-gate-locked{overflow:hidden;}';
  (document.head || document.documentElement).appendChild(preStyle);
  document.documentElement.classList.add('cl-gate-locked');

  var GATE_CSS =
    '#cl-gate{position:fixed;inset:0;z-index:99999;background:#f8f4ec;display:flex;' +
    'align-items:center;justify-content:center;padding:24px;visibility:visible!important;' +
    'font-family:"Cormorant Garamond",Georgia,serif;color:#0f1a33;}' +
    '#cl-gate .cl-gate-card{width:100%;max-width:420px;text-align:center;}' +
    '#cl-gate .cl-gate-eyebrow{font-family:"Bodoni Moda",serif;font-size:11px;letter-spacing:.55em;' +
    'text-transform:uppercase;color:#1e3a8a;margin-bottom:18px;}' +
    '#cl-gate .cl-gate-monogram{font-family:"Bodoni Moda","Didot",serif;font-variation-settings:"opsz" 96;' +
    'font-weight:400;font-size:88px;line-height:.9;color:#0f1a33;margin-bottom:14px;letter-spacing:-.02em;}' +
    '#cl-gate .cl-gate-monogram em{font-style:italic;font-size:.6em;vertical-align:.18em;color:#1e3a8a;margin:0 4px;}' +
    '#cl-gate .cl-gate-date{font-family:"Bodoni Moda",serif;font-size:10px;letter-spacing:.5em;' +
    'text-transform:uppercase;color:#5a6476;margin-bottom:36px;}' +
    '#cl-gate h2{font-family:"Bodoni Moda",serif;font-weight:400;font-size:28px;letter-spacing:-.005em;margin-bottom:8px;}' +
    '#cl-gate h2 em{font-style:italic;color:#1e3a8a;}' +
    '#cl-gate p.cl-gate-sub{font-style:italic;color:#5a6476;font-size:16px;margin-bottom:28px;line-height:1.55;}' +
    '#cl-gate form{display:flex;flex-direction:column;gap:18px;}' +
    '#cl-gate label{font-family:"Bodoni Moda",serif;font-size:10px;letter-spacing:.4em;text-transform:uppercase;' +
    'color:#1e3a8a;text-align:left;}' +
    '#cl-gate input{width:100%;background:transparent;border:none;border-bottom:1px solid rgba(30,58,138,.32);' +
    'padding:10px 0 12px;font-family:"Cormorant Garamond",serif;font-size:20px;color:#0f1a33;outline:none;' +
    'text-align:center;letter-spacing:.04em;}' +
    '#cl-gate input:focus{border-bottom-color:#1e3a8a;}' +
    '#cl-gate button{margin-top:6px;background:#1e3a8a;color:#f8f4ec;border:none;font-family:"Bodoni Moda",serif;' +
    'font-size:11px;letter-spacing:.4em;text-transform:uppercase;padding:16px 18px;cursor:pointer;' +
    'transition:background 200ms ease,letter-spacing 250ms ease;}' +
    '#cl-gate button:hover{background:#2d4db3;letter-spacing:.5em;}' +
    '#cl-gate .cl-gate-err{min-height:18px;font-size:14px;font-style:italic;color:#a13838;margin-top:4px;}' +
    '#cl-gate .cl-gate-hint{margin-top:32px;font-size:13px;font-style:italic;color:#5a6476;line-height:1.5;}' +
    '#cl-gate.cl-gate-shake{animation:cl-gate-shake 360ms ease;}' +
    '@keyframes cl-gate-shake{0%,100%{transform:translateX(0);}25%{transform:translateX(-8px);}' +
    '50%{transform:translateX(8px);}75%{transform:translateX(-4px);}}';

  function build() {
    var styleEl = document.createElement('style');
    styleEl.textContent = GATE_CSS;
    document.head.appendChild(styleEl);

    var gate = document.createElement('div');
    gate.id = 'cl-gate';
    gate.setAttribute('role', 'dialog');
    gate.setAttribute('aria-modal', 'true');
    gate.setAttribute('aria-labelledby', 'cl-gate-title');
    gate.innerHTML =
      '<div class="cl-gate-card">' +
        '<div class="cl-gate-eyebrow">Ten · Ten</div>' +
        '<div class="cl-gate-monogram">C<em>&amp;</em>L</div>' +
        '<div class="cl-gate-date">October 10 · 2026</div>' +
        '<h2 id="cl-gate-title">A small <em>secret</em> first.</h2>' +
        '<p class="cl-gate-sub">Enter the password we sent with your invitation to continue.</p>' +
        '<form autocomplete="off">' +
          '<label for="cl-gate-input">Password</label>' +
          '<input id="cl-gate-input" type="password" required autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">' +
          '<button type="submit">Enter</button>' +
          '<div class="cl-gate-err" id="cl-gate-err" aria-live="polite"></div>' +
        '</form>' +
        '<div class="cl-gate-hint">Hint: ' +
          'our four-legged ringbearer.' +
        '</div>' +
      '</div>';
    document.body.appendChild(gate);

    var input  = gate.querySelector('input');
    var errEl  = gate.querySelector('#cl-gate-err');
    var formEl = gate.querySelector('form');

    setTimeout(function () { try { input.focus(); } catch (e) {} }, 30);

    formEl.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var raw = (input.value || '').trim().toLowerCase();
      if (!raw) { input.focus(); return; }
      sha256(raw).then(function (hash) {
        if (hash === PASSWORD_HASH) {
          try { localStorage.setItem(STORAGE_KEY, STORAGE_VAL); } catch (e) {}
          unlock(gate);
        } else {
          errEl.textContent = 'That doesn\u2019t look right. Try again.';
          gate.classList.remove('cl-gate-shake');
          void gate.offsetWidth;
          gate.classList.add('cl-gate-shake');
          input.select();
        }
      }).catch(function () {
        errEl.textContent = 'Something went wrong. Refresh and try again.';
      });
    });
  }

  function unlock(gate) {
    document.documentElement.classList.remove('cl-gate-locked');
    gate.style.transition = 'opacity 320ms ease';
    gate.style.opacity = '0';
    setTimeout(function () { if (gate.parentNode) gate.parentNode.removeChild(gate); }, 340);
    var pre = document.getElementById('cl-gate-prepaint');
    if (pre && pre.parentNode) pre.parentNode.removeChild(pre);
  }

  function sha256(str) {
    if (window.crypto && crypto.subtle && crypto.subtle.digest) {
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
        .then(function (buf) {
          return Array.prototype.map.call(new Uint8Array(buf), function (b) {
            return ('0' + b.toString(16)).slice(-2);
          }).join('');
        });
    }
    return Promise.reject(new Error('subtle crypto unavailable'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
