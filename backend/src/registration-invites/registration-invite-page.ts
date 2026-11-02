/**
 * 网站「邀请码获取」页面（W12，2026-11-02）。
 *
 * ── 为什么是内联的一个字符串，而不是 `public/` 里的静态文件 ──────────────────
 *   ① 部署只有一条链路：页面与 API 由**同一个进程**提供（`GET /invite`），
 *      不需要新增 Caddy 规则、不需要 `nest-cli` 的 assets 拷贝（tsc 测试
 *      构建不会拷静态文件 ⇒ 那条路在测试里必红）；
 *   ② 页面与接口**同源**，不需要放宽 CORS（`cors.setup.ts` 的白名单只服务
 *      Flutter Web 开发）。
 *
 * ── 请求路径为什么是相对的（`public/...`，没有开头的 `/`）───────────────────
 *   同一份页面会从两个入口打开：
 *     · `https://www.littlewish.top:8443/invite`  → 相对解析为 `/public/...`
 *     · `http://82.157.153.22/k/invite`           → 相对解析为 `/k/public/...`
 *   写成绝对路径 `/public/...` 会让小程序那条入口绕过 `/k` 前缀，
 *   打到 hub 的静态站上（表现是 404，而不是「接口坏了」）。
 *
 * ── 文案为什么分「小程序」与「App」两段 ─────────────────────────────────────
 *   两端是**同一套账号**的两个入口，但注册步骤不同（小程序多一个微信登录
 *   选项、App 注册后要建孩子档案）。把它们写成一段「通用说明」，
 *   用户会照着另一端做，然后在错误的界面上找按钮。
 *
 * ★ 本字符串里**不能出现反引号与美元加大括号**：它是 TS 模板字面量。
 */
export const REGISTRATION_INVITE_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>邀请码获取 · 积分小管家</title>
<style>
  :root {
    --page-top: #f7fbf2;
    --page-bottom: #eef6e8;
    --ink: #2f3a2c;
    --ink-soft: #6c7768;
    --ink-hint: #98a293;
    --green: #5f9e63;
    --green-deep: #356b3c;
    --green-soft: #eaf4e5;
    --wechat: #3f9c54;
    --app: #4d7fbe;
    --danger: #b4543f;
    --card: #ffffff;
    --line: #e4ecdd;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    background: linear-gradient(180deg, var(--page-top) 0%, var(--page-bottom) 100%);
    color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
    padding: 28px 18px 56px;
  }
  .wrap { width: 100%; max-width: 680px; margin: 0 auto; }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
  .brand-mark {
    width: 38px; height: 38px; border-radius: 12px;
    background: linear-gradient(145deg, #9ccf8f, #5f9e63);
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 19px; box-shadow: 0 6px 16px rgba(95, 158, 99, .28);
  }
  .brand-name { font-size: 15px; font-weight: 700; letter-spacing: .3px; }
  .brand-sub { font-size: 11.5px; color: var(--ink-hint); margin-top: 2px; }

  .hero { padding: 4px 2px 18px; }
  .hero h1 { margin: 0; font-size: 25px; line-height: 1.32; letter-spacing: .2px; }
  .hero p { margin: 10px 0 0; font-size: 13.5px; line-height: 1.75; color: var(--ink-soft); }

  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 20px;
    padding: 22px 20px;
    box-shadow: 0 10px 30px rgba(64, 92, 54, .07);
  }
  .quota {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; margin-bottom: 16px;
    padding: 10px 14px; border-radius: 12px;
    background: var(--green-soft); color: var(--green-deep);
    font-size: 12.5px; line-height: 1.5;
  }
  .quota strong { font-size: 15px; }

  label { display: block; font-size: 12.5px; font-weight: 600; margin: 0 0 7px 2px; }
  .field { margin-bottom: 16px; }
  .field input {
    width: 100%; height: 48px; padding: 0 14px;
    border: 1px solid var(--line); border-radius: 13px;
    background: #fbfdf9; color: var(--ink);
    font-size: 15px; outline: none;
    transition: border-color .15s, box-shadow .15s, background .15s;
  }
  .field input:focus {
    border-color: #a9cfa0; background: #fff;
    box-shadow: 0 0 0 4px rgba(95, 158, 99, .12);
  }
  .field input::placeholder { color: #b3bcae; }
  .field small { display: block; margin: 7px 2px 0; font-size: 11.5px; color: var(--ink-hint); line-height: 1.6; }

  .primary {
    width: 100%; height: 50px; border: 0; border-radius: 14px;
    background: linear-gradient(135deg, #75b46e, #4f8f56);
    color: #fff; font-size: 15.5px; font-weight: 700; letter-spacing: .5px;
    cursor: pointer; box-shadow: 0 10px 22px rgba(79, 143, 86, .28);
    transition: transform .12s, opacity .15s;
  }
  .primary:active { transform: translateY(1px); }
  .primary[disabled] { opacity: .55; cursor: default; box-shadow: none; }

  .error {
    display: none; margin-top: 14px; padding: 11px 14px;
    border-radius: 12px; background: #fdf1ee; border: 1px solid #f3d3ca;
    color: var(--danger); font-size: 12.5px; line-height: 1.65;
  }
  .error.show { display: block; }

  .result { display: none; }
  .result.show { display: block; }
  .result-head { text-align: center; padding: 2px 0 14px; }
  .result-head .ok {
    width: 46px; height: 46px; margin: 0 auto 10px; border-radius: 50%;
    background: var(--green-soft); color: var(--green-deep);
    display: flex; align-items: center; justify-content: center; font-size: 23px;
  }
  .result-head h2 { margin: 0; font-size: 19px; }
  .result-head p { margin: 8px 0 0; font-size: 12.5px; color: var(--ink-soft); line-height: 1.65; }

  .code-box {
    margin: 6px 0 14px; padding: 20px 16px; border-radius: 16px;
    background: #f7fbf3; border: 1.5px dashed #bcd9b2; text-align: center;
  }
  .code-label { font-size: 11.5px; color: var(--ink-hint); letter-spacing: 2px; }
  .code-value {
    margin: 9px 0 12px; font-size: 31px; font-weight: 800;
    letter-spacing: 4px; color: var(--green-deep);
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    word-break: break-all;
  }
  .copy {
    height: 36px; padding: 0 18px; border-radius: 10px;
    border: 1px solid #bcd9b2; background: #fff; color: var(--green-deep);
    font-size: 12.5px; font-weight: 700; cursor: pointer;
  }
  .copy:active { background: var(--green-soft); }

  .meta { display: grid; gap: 8px; margin-bottom: 6px; }
  .meta-row {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 14px; font-size: 12.5px; color: var(--ink-soft);
    padding: 9px 12px; border-radius: 10px; background: #fafcf8;
  }
  .meta-row b { color: var(--ink); font-weight: 600; text-align: right; }

  .divider { height: 1px; background: var(--line); margin: 22px 0 20px; }

  .section-title { font-size: 15px; font-weight: 700; margin: 0 0 4px; }
  .section-sub { font-size: 12.5px; color: var(--ink-soft); line-height: 1.7; margin: 0 0 14px; }

  .env { border: 1px solid var(--line); border-radius: 16px; padding: 16px; margin-bottom: 12px; }
  .env-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .env-badge {
    width: 30px; height: 30px; border-radius: 9px; flex: 0 0 auto;
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 15px; font-weight: 700;
  }
  .env-badge.wechat { background: linear-gradient(145deg, #6cc47d, #3f9c54); }
  .env-badge.app { background: linear-gradient(145deg, #7aa8de, #4d7fbe); }
  .env-title { font-size: 14px; font-weight: 700; }
  .env-tag { font-size: 11px; color: var(--ink-hint); margin-top: 2px; }
  .env ol { margin: 0; padding-left: 20px; }
  .env li { font-size: 12.5px; line-height: 1.85; color: var(--ink-soft); }
  .env li b { color: var(--ink); }
  .env-note {
    margin: 11px 0 0; padding: 9px 11px; border-radius: 9px;
    background: #fafcf8; font-size: 11.5px; line-height: 1.7; color: var(--ink-soft);
  }

  .same-account {
    margin-top: 14px; padding: 14px 16px; border-radius: 14px;
    background: #fff8e9; border: 1px solid #f2e2c2;
    font-size: 12.5px; line-height: 1.8; color: #7a6436;
  }
  .same-account b { color: #6b5527; }

  .fineprint { margin: 18px 2px 0; font-size: 11.5px; line-height: 1.8; color: var(--ink-hint); }
  .reset { margin-top: 14px; text-align: center; }
  .reset button {
    border: 0; background: none; color: var(--ink-hint);
    font-size: 12px; text-decoration: underline; cursor: pointer;
  }
  @media (max-width: 380px) {
    .code-value { font-size: 26px; letter-spacing: 2px; }
    .hero h1 { font-size: 22px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand">
    <div class="brand-mark">★</div>
    <div>
      <div class="brand-name">积分小管家</div>
      <div class="brand-sub">习惯打卡 · 积分奖励</div>
    </div>
  </div>

  <div class="hero">
    <h1>获取一个邀请码</h1>
    <p>积分小管家目前是邀请制。填好手机号和邮箱，就能拿到一个只属于你的邀请码；
      拿它到小程序或 App 里注册即可。每天限量发放。</p>
  </div>

  <div class="card" id="form-card">
    <div class="quota">
      <span>今日剩余名额</span>
      <span><strong id="quota-remaining">—</strong> <span id="quota-total"></span></span>
    </div>

    <form id="kp-form" novalidate>
      <div class="field">
        <label for="phone">手机号</label>
        <input id="phone" name="phone" type="tel" inputmode="numeric" autocomplete="tel"
               maxlength="20" placeholder="例如 13800138000">
        <small>注册时可以直接用这个手机号登录。</small>
      </div>

      <div class="field">
        <label for="email">邮箱</label>
        <input id="email" name="email" type="email" inputmode="email" autocomplete="email"
               maxlength="254" placeholder="例如 dad@example.com">
        <small>邀请码会同时绑定手机号和邮箱；注册时填其中任意一个都能用。</small>
      </div>

      <button class="primary" id="submit" type="submit">获取邀请码</button>
      <div class="error" id="error" role="alert"></div>
    </form>
  </div>

  <div class="card result" id="result-card">
    <div class="result-head">
      <div class="ok">✓</div>
      <h2>邀请码已生成</h2>
      <p>请把它记下来（或复制），然后到小程序或 App 里完成注册。</p>
    </div>

    <div class="code-box">
      <div class="code-label">你的邀请码</div>
      <div class="code-value" id="code">ABCD-EFGH</div>
      <button class="copy" id="copy" type="button">复制邀请码</button>
    </div>

    <div class="meta">
      <div class="meta-row"><span>绑定的手机号</span><b id="meta-phone">—</b></div>
      <div class="meta-row"><span>绑定的邮箱</span><b id="meta-email">—</b></div>
      <div class="meta-row"><span>有效期</span><b id="meta-expires">—</b></div>
    </div>

    <div class="reset">
      <button id="again" type="button">信息填错了？重新申请一个</button>
    </div>

    <div class="divider"></div>

    <h3 class="section-title">接下来怎么注册</h3>
    <p class="section-sub">下面两条路任选一条即可。邀请码只能用一次，
      注册时请填写与上面一致的手机号或邮箱。</p>

    <div class="env">
      <div class="env-head">
        <div class="env-badge wechat">微</div>
        <div>
          <div class="env-title">在微信小程序里注册</div>
          <div class="env-tag">适合：手机上已经装了微信</div>
        </div>
      </div>
      <ol>
        <li>打开微信，搜索并进入「<b>积分小管家</b>」小程序。</li>
        <li>在登录页点「<b>第一次用？用邀请码注册</b>」。</li>
        <li>填邀请码、手机号或邮箱（<b>与这里填写的一致</b>）和自定密码，提交。</li>
      </ol>
      <p class="env-note">小程序也支持「微信一键登录」。但要进入<strong>同一个账号</strong>，
        请选「用手机号或邮箱登录」填这里的号 + 密码。<br>
        微信身份与手机号/邮箱是两个登录凭据：先用微信登录建过账号的话，
        需要在小程序「我的 → App 登录账号」里绑定同一个手机号/邮箱并设密码，之后才能两边通用。</p>
    </div>

    <div class="env">
      <div class="env-head">
        <div class="env-badge app">A</div>
        <div>
          <div class="env-title">在 App 里注册</div>
          <div class="env-tag">适合：安卓手机，或想用手机号/邮箱直接登录</div>
        </div>
      </div>
      <ol>
        <li>打开「<b>积分小管家</b>」App；没有安装包就向家里已经在用的成员要下载地址。</li>
        <li>在登录页点「<b>第一次用？用邀请码注册</b>」。</li>
        <li>填邀请码、手机号或邮箱（<b>与这里填写的一致</b>）和自定密码，提交。</li>
      </ol>
      <p class="env-note">注册成功后会直接进入 App，并按引导为孩子建立档案
        （昵称后面可以在「我的」里改）。</p>
    </div>

    <div class="same-account">
      <b>小程序和 App 是同一套账号，互不依赖。</b>
      在任意一边注册后，另一边在登录页选「用手机号或邮箱登录」，
      填<b>同一个手机号或邮箱 + 密码</b>就能进入；
      不需要「先在小程序登录过」才能在 App 登录，反过来也一样。
    </div>

    <p class="fineprint">
      邀请码只能使用一次，过期后再来这个页面申请即可。如果注册时提示「手机号/邮箱已被注册」，
      说明这个账号已经存在，直接返回登录页登录就行。<br>
      我们只用手机号和邮箱来核对你和这张邀请码，不会给它们发短信或邮件广告。
    </p>
  </div>

  <p class="fineprint" style="text-align:center">
    遇到问题？让家里已经在用的成员在小程序里生成一张新的邀请码。
  </p>
</div>
<script>
(function () {
  var formCard = document.getElementById('form-card');
  var resultCard = document.getElementById('result-card');
  var form = document.getElementById('kp-form');
  var phoneInput = document.getElementById('phone');
  var emailInput = document.getElementById('email');
  var submit = document.getElementById('submit');
  var errorBox = document.getElementById('error');
  var quotaRemaining = document.getElementById('quota-remaining');
  var quotaTotal = document.getElementById('quota-total');
  var codeEl = document.getElementById('code');
  var metaPhone = document.getElementById('meta-phone');
  var metaEmail = document.getElementById('meta-email');
  var metaExpires = document.getElementById('meta-expires');
  var copy = document.getElementById('copy');
  var again = document.getElementById('again');
  var busy = false;
  var quotaFull = false;

  function api(path, options) {
    return fetch(path, options).then(function (res) {
      return res.text().then(function (text) {
        var body = {};
        if (text) {
          try { body = JSON.parse(text); } catch (e) { body = {}; }
        }
        if (!res.ok) {
          var error = new Error(body.message || '请求没有完成，请稍后再试。');
          error.status = res.status;
          throw error;
        }
        return body;
      });
    });
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.className = 'error show';
  }

  function clearError() {
    errorBox.textContent = '';
    errorBox.className = 'error';
  }

  function setBusy(value) {
    busy = value;
    submit.disabled = value || quotaFull;
    submit.textContent = value ? '正在生成…' : '获取邀请码';
  }

  function renderQuota(data) {
    var remaining = typeof data.remainingToday === 'number' ? data.remainingToday : 0;
    quotaRemaining.textContent = String(remaining);
    quotaTotal.textContent = '/ 每天 ' + String(data.dailyLimit) + ' 个';
    quotaFull = remaining <= 0;
    if (quotaFull) {
      submit.disabled = true;
      showError('今天的邀请码已经发完了。明天零点（北京时间）重置，' +
        '或者请已经在用的家长在小程序里生成一张。');
    }
  }

  function loadQuota() {
    api('public/registration-invites/quota', {
      method: 'GET',
      headers: { accept: 'application/json' }
    }).then(renderQuota).catch(function () {
      quotaRemaining.textContent = '—';
      quotaTotal.textContent = '';
    });
  }

  function pad(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function formatExpiry(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '以注册页提示为准';
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  function renderResult(data) {
    codeEl.textContent = data.code || '';
    metaPhone.textContent = data.phoneMasked || '已填写';
    metaEmail.textContent = data.emailMasked || '已填写';
    metaExpires.textContent = formatExpiry(data.expiresAt);
    formCard.style.display = 'none';
    resultCard.className = 'card result show';
    window.scrollTo(0, 0);
  }

  function copyCode() {
    var text = codeEl.textContent || '';
    if (!text) return;

    function done() {
      copy.textContent = '已复制';
      setTimeout(function () { copy.textContent = '复制邀请码'; }, 1800);
    }

    function fallback() {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', 'readonly');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); done(); } catch (e) { /* 用户可手动选中复制 */ }
      document.body.removeChild(area);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
      return;
    }
    fallback();
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (busy || quotaFull) return;
    clearError();

    var phone = phoneInput.value.trim();
    var email = emailInput.value.trim();
    if (!phone) { showError('请填写手机号。'); phoneInput.focus(); return; }
    if (!email) { showError('请填写邮箱。'); emailInput.focus(); return; }

    setBusy(true);
    api('public/registration-invites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: phone, email: email })
    }).then(function (data) {
      renderResult(data);
    }).catch(function (error) {
      showError(error.message);
      if (error.status === 429) quotaFull = true;
    }).then(function () {
      setBusy(false);
    });
  });

  copy.addEventListener('click', copyCode);

  again.addEventListener('click', function () {
    resultCard.className = 'card result';
    formCard.style.display = 'block';
    clearError();
    loadQuota();
    window.scrollTo(0, 0);
  });

  loadQuota();
}());
</script>
</body>
</html>`
