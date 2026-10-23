import './style.css';
import { G2Device } from './device';
import type { Gesture } from './contracts';
import { VoiceCapture } from './speech';
import { RemoteAPI } from './direct/api';
import { DeviceOAuth } from './direct/device-oauth';
import { appCredentialStore } from './direct/credential-store';
import { Tracker } from './direct/tracker';
import { APIError, terminal } from './direct/types';
import { paginate } from './text';

async function main() {
  const configResponse = await fetch('/g2-config.json', { cache: 'no-store' });
  if (!configResponse.ok) throw Error('CONFIG_REQUIRED');
  const config = await configResponse.json();
  if (config.mode !== 'live' || config.authMode !== 'device' || !/^[A-Za-z0-9_]{5,32}$/.test(config.approvalBotUsername)) throw Error('LIVE_DEVICE_CONFIG_REQUIRED');
  document.querySelector('#app')!.innerHTML = `<main>
    <header><div><p class="eyebrow">EVEN G2 / S010</p><h1><img src="/even.ico" alt="" width="24" height="24">이븐</h1></div><span id="connectionState" role="status">연결 확인 중</span></header>
    <section class="connections" aria-label="연결 상태">
      <div><span id="deviceState">안경 연결 중</span><button id="connect" disabled>연결 중</button></div>
      <div><span id="authState">서버 연결 복원 중</span><button id="login" disabled>처음 연결하기</button></div>
      <div id="devicePrompt" hidden><p>최초 한 번, Telegram에서 연결 승인 버튼을 눌러 주세요. 이후 자동으로 연결을 복원합니다.</p><a id="verificationUri" target="_blank" rel="noopener noreferrer">Telegram에서 연결 승인</a><p id="userCode"></p><p>코드 입력이나 복사는 필요하지 않습니다.</p><button id="cancelLogin">연결 취소</button></div>
    </section>
    <section class="voice" aria-label="음성 입력">
      <h2>무엇을 도와드릴까요?</h2><button id="record" class="primary record" disabled>말하기</button>
      <p id="voiceStatus" role="status">안경과 서버 연결을 확인하고 있습니다.</p>
      <p class="hint">버튼이나 안경을 누른 채 말한 뒤 손을 떼세요. 버튼을 짧게 누르면 시작하고, 다시 누르면 끝납니다.</p>
    </section>
    <section class="compose" aria-label="보낼 내용"><label for="draft">보낼 내용</label>
      <textarea id="draft" rows="4" maxlength="16000" placeholder="말하거나 직접 입력하세요."></textarea>
      <div class="actions"><button id="discard">지우기</button><button id="send" class="primary" disabled>S010에 보내기</button></div>
      <p id="sendStatus" class="hint" role="status"></p>
    </section>
    <section class="answer" aria-label="응답"><div class="answerHeading"><h2>응답</h2><span id="workState" role="status">대기 중</span></div>
      <pre id="answer">답변이 오면 안경에도 표시됩니다.</pre><div class="actions"><button id="prev" disabled>이전</button><span id="page">1 / 1</span><button id="next" disabled>다음</button></div>
      <button id="cancelRequest" hidden>진행 중인 요청 중지</button>
    </section>
    <p id="notice" role="alert"></p>
    <details><summary>연결 관리</summary><p>연결 대상: S010 · Codex</p><button id="retry">연결 다시 확인</button><button id="logout">서버 연결 해제</button><p id="diagnostics"></p></details>
  </main>`;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
  const button = (id: string, disabled: boolean, text?: string) => {
    const element = $<HTMLButtonElement>(id); element.disabled = disabled; if (text) element.textContent = text;
  };
  const notice = (text: string) => { $('notice').textContent = text; };
  let loggedIn = false, restoring = true, pairing = false, audioReady = false, transcribing = false, speechNotice = '';
  let device: G2Device | undefined, tracker: Tracker | undefined;
  let page = 0, pages = [''], recording = false, starting = false, stoppedWhileStarting = false, discardWhileStarting = false;
  let epoch = 0, micTimer: ReturnType<typeof setTimeout> | undefined, transcription: AbortController | undefined;
  const capture = new VoiceCapture();
  let displayPending = '', displaying = false, displayed = '', wasConnected = false, draftDirty = false;
  async function display(text: string) {
    displayPending = text;
    if (displaying || device?.state !== 'connected') return;
    displaying = true;
    try { while (displayPending !== displayed) { const next = displayPending; await device.display(next); displayed = next; } }
    catch { notice('안경 화면 전송에 실패했습니다. 연결을 다시 확인하세요.'); }
    finally { displaying = false; }
  }
  function render() {
    const connected = device?.state === 'connected';
    if (connected && !wasConnected) displayed = '';
    wasConnected = connected;
    const connecting = device?.state === 'connecting';
    $('deviceState').textContent = connected ? '안경 연결됨' : connecting ? '안경 연결 중' : '안경 연결 필요';
    button('connect', connected || connecting, connected ? '연결됨' : connecting ? '연결 중' : '다시 연결');
    $('authState').textContent = restoring ? '서버 연결 복원 중' : loggedIn ? '서버 연결됨 · 자동 갱신' : pairing ? '최초 연결 승인 대기' : '최초 연결 필요';
    $('login').hidden = loggedIn;
    button('login', restoring || pairing, pairing ? '승인 대기 중' : '처음 연결하기');
    $('connectionState').textContent = connected && loggedIn && audioReady && tracker?.selected ? '사용 준비됨' : loggedIn && tracker?.selected ? '텍스트 사용 가능' : loggedIn ? 'S010 연결 필요' : restoring ? '서버 연결 확인 중' : '서버 연결 필요';
    const ready = connected && loggedIn && audioReady && Boolean(tracker?.selected);
    button('record', !recording && (!ready || transcribing), recording ? '말하기 끝내기' : starting ? '마이크 여는 중' : transcribing ? '음성 인식 중' : '말하기');
    $('record').classList.toggle('recording', recording);
    $('voiceStatus').textContent = recording ? '듣고 있습니다. 끝나면 손을 떼거나 버튼을 누르세요.' : transcribing ? '말씀하신 내용을 문자로 바꾸고 있습니다.'
      : starting ? '안경 마이크를 켜고 있습니다.' : restoring ? '서버 연결을 복원하고 있습니다.'
      : !loggedIn ? '처음 연결하기에서 서버 연결을 승인해 주세요. 안경 연결과 서버 연결은 별개입니다.'
      : !connected ? '안경을 다시 연결하세요. 직접 작성한 내용은 보낼 수 있습니다.'
      : !tracker?.selected ? 'S010 연결을 확인할 수 없습니다. 연결 다시 확인을 눌러 주세요.'
      : !audioReady ? speechNotice || '서버 음성 인식이 준비되지 않았습니다. 직접 작성한 내용은 보낼 수 있습니다.' : '안경 마이크를 사용할 수 있습니다.';
    const w = tracker?.work, running = Boolean(w?.requestId && (!w.status || !terminal(w.status)));
    const sendReason = restoring ? '서버 연결 복원 중입니다.' : !loggedIn ? '처음 연결하기에서 서버 연결을 승인해 주세요.'
      : !tracker?.selected ? 'S010 연결을 확인할 수 없습니다. 연결 다시 확인을 눌러 주세요.'
      : tracker.busy ? '전송 중입니다.' : running ? '이 앱에서 보낸 요청을 처리 중입니다.'
      : recording || starting ? '녹음을 끝낸 뒤 보낼 수 있습니다.' : transcribing ? '음성 인식 후 내용을 확인해 주세요.'
      : !$<HTMLTextAreaElement>('draft').value.trim() ? '보낼 내용을 입력하세요.' : '';
    button('send', Boolean(sendReason)); $('sendStatus').textContent = sendReason;
    const states = { accepted: '접수됨', running: '작업 중', completed: '답변 도착', failed: '처리 실패', canceled: '중지됨', cancel_requested: '중지 요청 중', interrupted: '연결 중단' };
    $('workState').textContent = w?.status ? states[w.status] : tracker?.busy ? '전송 중' : '대기 중';
    const text = w?.result?.text ?? w?.progress.at(-1) ?? '답변이 오면 안경에도 표시됩니다.';
    pages = paginate(text); page = Math.min(page, pages.length - 1);
    $('answer').textContent = pages[page]; $('page').textContent = `${page + 1} / ${pages.length}`;
    button('prev', page === 0); button('next', page >= pages.length - 1);
    $('cancelRequest').hidden = !running || !w?.requestId;
    $('diagnostics').textContent = w?.requestId ? `요청: ${w.requestId}` : '';
    if (w?.notice) notice(w.notice);
    const screen = recording ? '듣고 있습니다…\n손을 떼면 음성 인식을 시작합니다.' : transcribing ? '음성 인식 중…'
      : draftDirty && $<HTMLTextAreaElement>('draft').value && !running ? `보낼 내용\n${paginate($<HTMLTextAreaElement>('draft').value)[0]}\n휴대폰에서 보내기를 눌러 주세요.`
      : running ? `S010 · ${w?.status ? states[w.status] : '전송 중'}\n${pages[page]}` : ready ? pages[page] : $('voiceStatus').textContent ?? '연결을 확인해 주세요.';
    if (connected) void display(screen);
  }
  const auth = new DeviceOAuth(config.clientId, fetch, () => {
    loggedIn = false; epoch++; transcription?.abort(); void stop(true).catch(error); tracker?.pause(); render();
  }, Date.now, appCredentialStore,
    () => { loggedIn = true; tracker?.resume(); render(); });
  const api = new RemoteAPI(auth);
  tracker = new Tracker(api, localStorage, render); tracker.pause();
  device = new G2Device(() => {
    if (recording && device?.state !== 'connected') { void stop(true).catch(error); notice('안경 연결이 끊겨 녹음을 중단했습니다.'); }
    render();
  });
  let syncing: Promise<void> | undefined;
  async function sync(checkSpeech = true) {
    if (syncing) return syncing;
    const work = (async () => {
      const targets = await api.targets();
      const allowed = targets.filter(t => t.type === 'session' && t.provider === 'codex' && t.label === 'S010');
      if (allowed.length !== 1 || targets.length !== 1) throw Error('S010_REQUIRED');
      if (tracker!.selected?.targetId === allowed[0].targetId) tracker!.selected = allowed[0]; else tracker!.select(allowed[0]);
      render();
      if (checkSpeech) {
        try { audioReady = await api.capabilities(); speechNotice = ''; }
        catch (e) {
          audioReady = false;
          speechNotice = '서버 음성 인식 연결에 실패했습니다. 직접 작성한 내용은 보낼 수 있습니다.';
          if (e instanceof APIError && e.status === 401) throw e;
        }
      }
      render();
    })();
    syncing = work;
    try { await work; } finally { if (syncing === work) syncing = undefined; }
  }
  function error(error: unknown) {
    const name = error instanceof Error ? error.message : '';
    notice(name === 'NO_AUDIO' || name === 'NO_SPEECH' ? '음성을 듣지 못했습니다. 다시 말씀해 주세요.'
      : name === 'S010_REQUIRED' ? '허용된 S010 연결을 확인할 수 없습니다. 다른 세션에는 보내지 않습니다.'
      : error instanceof APIError && error.status === 401 ? '서버 승인이 만료되거나 해제됐습니다. 연결을 확인해 주세요.'
      : error instanceof APIError && error.status === 429 ? '요청이 많습니다. 잠시 후 다시 시도해 주세요.'
      : name === 'BRIDGE_TIMEOUT' || name === 'NOT_CONNECTED' ? 'Even 앱에서 G2 안경 연결 상태를 확인한 뒤 다시 연결하세요.'
      : name === 'MIC_DENIED' ? '안경 마이크를 켜지 못했습니다. Even 앱의 마이크 권한을 확인하세요.'
      : name === 'TARGET_UNAVAILABLE' ? 'S010이 작업 중이거나 실행할 수 없는 상태입니다. 입력은 보존됐습니다. 작업이 끝나면 보내기를 다시 눌러 주세요.'
      : name === 'STARTUP_FAILED' ? '안경 화면을 준비하지 못했습니다. 안경을 다시 연결하세요. 직접 입력은 사용할 수 있습니다.'
      : name === 'SERVER_CONNECTION_REQUIRED' ? '처음 연결하기에서 서버 연결을 승인해 주세요. 안경 연결과 서버 연결은 별개입니다.'
      : name === 'SPEECH_UNAVAILABLE' ? speechNotice || '서버 음성 인식이 준비되지 않았습니다. 직접 작성한 내용은 보낼 수 있습니다.'
      : '요청을 완료하지 못했습니다. 입력은 보존돼 있습니다. 연결을 다시 확인하세요.');
  }
  function on(id: string, action: () => unknown | Promise<unknown>) {
    $(id).addEventListener('click', () => { void Promise.resolve().then(action).catch(error); });
  }
  async function start() {
    if (recording || starting || transcribing) return;
    if (!loggedIn) throw Error('SERVER_CONNECTION_REQUIRED');
    if (!tracker?.selected) throw Error('S010_REQUIRED');
    if (!audioReady) throw Error('SPEECH_UNAVAILABLE');
    if (device?.state !== 'connected') throw Error('NOT_CONNECTED');
    starting = true; stoppedWhileStarting = false; discardWhileStarting = false; capture.clear(); epoch++; notice(''); render();
    const generation = epoch;
    try {
      await device.start(chunk => { try { capture.add(chunk); } catch { void stop().catch(error); } });
      if (generation !== epoch) { await device.stop(); capture.clear(); return; }
      recording = true;
      if (stoppedWhileStarting) { await stop(discardWhileStarting); return; }
      micTimer = setTimeout(() => { void stop().catch(error); }, 60000);
    } finally { starting = false; render(); }
  }
  async function stop(discard = false) {
    if (starting && !recording) { stoppedWhileStarting = true; discardWhileStarting ||= discard; if (discard) epoch++; return; }
    if (!recording) return;
    recording = false; clearTimeout(micTimer);
    const generation = epoch;
    try {
      await device!.stop();
      if (discard) { capture.clear(); return; }
      const pcm = capture.finish();
      transcribing = true; transcription = new AbortController(); render();
      const text = await api.transcribe(tracker!.selected!.targetId, pcm, transcription.signal);
      if (generation === epoch) { $<HTMLTextAreaElement>('draft').value = text; draftDirty = true; notice('내용을 확인하고 보내기를 누르세요.'); }
    } finally { capture.clear(); transcribing = false; transcription = undefined; render(); }
  }
  function gesture(g: Gesture) {
    if (g === 'record-start') void start().catch(error);
    if (g === 'record-stop') void stop().catch(error);
    if (g === 'tap') void (recording ? stop() : start()).catch(error);
    if (g === 'cancel') { epoch++; transcription?.abort(); void stop(true).catch(error); }
    if (g === 'next') { page = Math.min(page + 1, pages.length - 1); render(); }
    if (g === 'previous') { page = Math.max(0, page - 1); render(); }
  }
  on('connect', () => device!.connect(gesture));
  const recordButton = $<HTMLButtonElement>('record');
  let heldPointer: number | undefined, pressedAt = 0;
  recordButton.addEventListener('pointerdown', event => {
    if (event.button !== 0 || heldPointer !== undefined || recordButton.disabled) return;
    heldPointer = event.pointerId; pressedAt = performance.now(); recordButton.setPointerCapture(event.pointerId);
    void (recording ? stop() : start()).catch(error);
  });
  recordButton.addEventListener('pointerup', event => {
    if (heldPointer !== event.pointerId) return;
    heldPointer = undefined;
    if (performance.now() - pressedAt >= 300) void stop().catch(error);
  });
  const cancelHold = () => {
    if (heldPointer === undefined) return;
    heldPointer = undefined; void stop(true).catch(error);
  };
  recordButton.addEventListener('pointercancel', cancelHold);
  recordButton.addEventListener('lostpointercapture', cancelHold);
  recordButton.addEventListener('click', event => {
    if (event.detail === 0) void (recording ? stop() : start()).catch(error);
  });
  on('send', async () => {
    notice(''); await sync(false);
    try { await tracker!.send($<HTMLTextAreaElement>('draft').value); draftDirty = false; render(); }
    catch (e) { if (tracker!.work?.notice) notice(tracker!.work.notice); else error(e); }
  });
  on('discard', async () => { epoch++; transcription?.abort(); await stop(true); $<HTMLTextAreaElement>('draft').value = ''; draftDirty = false; notice(''); render(); });
  on('prev', () => { page = Math.max(0, page - 1); render(); });
  on('next', () => { page = Math.min(pages.length - 1, page + 1); render(); });
  on('cancelRequest', () => tracker!.cancel());
  on('retry', async () => {
    await device!.connect(gesture);
    if (loggedIn) { await auth.getToken(); await sync(); }
    else if (await auth.restore()) { loggedIn = true; tracker!.resume(); await sync(); }
  });
  on('login', async () => {
    if (pairing || loggedIn) return;
    pairing = true; render();
    try {
      await auth.login(prompt => {
        $('devicePrompt').hidden = !prompt;
        $('userCode').textContent = prompt?.userCode ?? '';
        const link = $<HTMLAnchorElement>('verificationUri'); link.removeAttribute('href');
        if (prompt) link.href = `https://t.me/${config.approvalBotUsername}?start=g2_${encodeURIComponent(prompt.userCode)}`;
      });
      loggedIn = true; tracker!.resume(); await sync();
    } finally { pairing = false; render(); }
  });
  on('cancelLogin', () => auth.cancelLogin());
  on('logout', async () => { epoch++; transcription?.abort(); await stop(true); await auth.logout(); audioReady = false; render(); });
  $('draft').addEventListener('input', () => { draftDirty = true; render(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && (recording || starting)) { epoch++; void stop(true).catch(error); }
    if (!document.hidden && loggedIn) { void auth.getToken().then(() => sync()).catch(error); tracker!.resume(); }
  });
  window.addEventListener('pagehide', () => { epoch++; transcription?.abort(); auth.cancelLogin(); tracker!.pause(); void device!.exit().catch(() => {}); });
  render();
  void device.connect(gesture).catch(error);
  try { loggedIn = await auth.restore(); if (loggedIn) { tracker.resume(); await sync(); } }
  catch (e) { error(e); }
  finally { restoring = false; render(); }
}
void main().catch(() => {
  document.querySelector('#app')!.textContent = '연결 설정을 불러오지 못했습니다. 앱을 다시 열어 주세요.';
});
